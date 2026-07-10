# Streaming reduction and UI projection  `stage-13.2`

This stage is the “live display pipeline” for the app’s main work loop. It takes a stream of low-level events and half-finished text, turns them into stable pieces, and keeps the terminal UI readable while new output is still arriving.

First, the stream parsers clean assistant text as it comes in. They strip hidden citation tags, pull out proposed plan blocks, and leave the visible text behind. Markdown streaming then decides what is safe to “commit” now versus what must wait, especially for tables, which can change shape until more lines arrive. The markdown renderer, syntax highlighter, diff renderer, and table fallback renderer turn that text into terminal-friendly lines.

Next, the streaming controllers and commit-tick logic manage the flow: they queue finished lines, keep a mutable live tail, and choose whether to drip output smoothly or catch up quickly. History-cell modules define every transcript row type, from messages and plans to approvals, searches, hooks, patches, and command output.

Finally, ChatWidget state and lifecycle code assemble these cells into the visible transcript, footer status, and live indicators, while resize reflow and consolidation rebuild the transcript cleanly when the window changes or streaming finishes.

## Files in this stage

### Streaming parse and markdown pipeline
These files define how incremental assistant output is parsed, buffered, rendered as markdown, and safely held back until stable enough to expose.

### `utils/stream-parser/src/citation.rs`

`domain_logic` · `stream parsing of assistant text and one-shot citation stripping utilities`

This file specializes the generic `InlineHiddenTagParser` for one literal tag pair: `<oai-mem-citation>` and `</oai-mem-citation>`. The private `CitationTag` enum has a single variant, used only to satisfy the generic parser’s typed tag interface. `CitationStreamParser` wraps `InlineHiddenTagParser<CitationTag>` and converts its richer extracted records into plain `String` citation bodies.

Construction is straightforward: `new` creates an inner parser configured with one `InlineTagSpec` whose `open` and `close` delimiters are the citation constants. `Default` simply forwards to `new`. As a `StreamTextParser`, `push_str` and `finish` both delegate to the inner parser and then map each extracted `ExtractedInlineTag<CitationTag>` into `tag.content`, discarding the tag identity because there is only one supported tag type. The visible text returned by the inner parser is preserved unchanged, meaning citation tags disappear from visible output while their bodies are collected separately.

The top-level helper `strip_citations` is the non-streaming convenience API. It creates a fresh parser, feeds the entire input once, flushes it, concatenates visible text from both phases, extends the extracted citation vector with any tail citations, and returns `(visible_text, citations)`. Because it uses the streaming parser internally, it inherits important semantics: matching is literal, nested citation tags are not supported, and an unterminated citation at EOF is auto-closed and emitted as extracted content rather than left in visible text.

#### Function details

##### `CitationStreamParser::new`  (lines 28–36)

```
fn new() -> Self
```

**Purpose**: Builds a citation parser configured to hide exactly one inline tag type: `<oai-mem-citation>...</oai-mem-citation>`.

**Data flow**: Takes no arguments, constructs an `InlineHiddenTagParser` with a single `InlineTagSpec { tag: CitationTag::Citation, open: CITATION_OPEN, close: CITATION_CLOSE }`, stores it in `inner`, and returns the new `CitationStreamParser`.

**Call relations**: This constructor is used by the one-shot `strip_citations` helper, by tests, and by higher-level parsers such as `AssistantTextStreamParser` that need citation extraction as a first parsing stage.

*Call graph*: calls 1 internal fn (new); called by 11 (strip_citations, citation_parser_auto_closes_unterminated_tag_on_finish, citation_parser_buffers_partial_open_tag_prefix, citation_parser_preserves_partial_open_tag_at_eof_if_not_a_full_tag, citation_parser_streams_across_chunk_boundaries, utf8_stream_parser_errors_on_incomplete_code_point_at_eof, utf8_stream_parser_handles_split_code_points_across_chunks, utf8_stream_parser_into_inner_errors_when_partial_code_point_is_buffered, utf8_stream_parser_into_inner_lossy_drops_buffered_partial_code_point, utf8_stream_parser_rolls_back_entire_chunk_when_invalid_byte_follows_valid_prefix (+1 more)); 1 external calls (vec!).


##### `CitationStreamParser::default`  (lines 40–42)

```
fn default() -> Self
```

**Purpose**: Provides the default citation parser configuration by forwarding to `new`.

**Data flow**: Takes no arguments and returns `Self::new()`.

**Call relations**: This supports generic code and tests that rely on `Default` rather than naming the constructor directly.

*Call graph*: 1 external calls (new).


##### `CitationStreamParser::push_str`  (lines 48–54)

```
fn push_str(&mut self, chunk: &str) -> StreamTextChunk<Self::Extracted>
```

**Purpose**: Consumes one text chunk, removes any complete citation tags from visible output, and emits their bodies as extracted strings.

**Data flow**: Takes `&mut self` and `chunk: &str`, calls `self.inner.push_str(chunk)`, then transforms the returned `StreamTextChunk<ExtractedInlineTag<CitationTag>>` into `StreamTextChunk<String>` by keeping `visible_text` and mapping each extracted tag to its `content` field.

**Call relations**: This method is called by streaming consumers such as `AssistantTextStreamParser::push_str` and by tests that feed chunked input through the parser.

*Call graph*: calls 1 internal fn (push_str); called by 1 (push_str).


##### `CitationStreamParser::finish`  (lines 56–62)

```
fn finish(&mut self) -> StreamTextChunk<Self::Extracted>
```

**Purpose**: Flushes any buffered partial citation markup at end-of-stream, including auto-closing an unterminated citation body if necessary.

**Data flow**: Calls `self.inner.finish()`, preserves the returned `visible_text`, maps extracted inline-tag records to their `content` strings, and returns the resulting `StreamTextChunk<String>`.

**Call relations**: This is the end-of-stream counterpart to `push_str`, used by `AssistantTextStreamParser::finish`, `strip_citations`, and tests.

*Call graph*: calls 1 internal fn (finish); called by 1 (finish).


##### `strip_citations`  (lines 69–76)

```
fn strip_citations(text: &str) -> (String, Vec<String>)
```

**Purpose**: Strips citation tags from a complete string and returns both the visible text and all extracted citation bodies.

**Data flow**: Accepts `text: &str`, creates a fresh `CitationStreamParser`, feeds the full text through `push_str`, calls `finish`, appends the tail visible text to the first chunk’s `visible_text`, extends the first chunk’s `extracted` vector with tail citations, and returns `(String, Vec<String>)`.

**Call relations**: This helper is used by tests and any non-streaming caller that wants citation stripping without manually managing parser state.

*Call graph*: calls 1 internal fn (new); called by 3 (citation_parser_does_not_support_nested_tags, strip_citations_auto_closes_unterminated_citation_at_eof, strip_citations_collects_all_citations).


##### `tests::collect_chunks`  (lines 86–100)

```
fn collect_chunks(parser: &mut P, chunks: &[&str]) -> StreamTextChunk<P::Extracted>
```

**Purpose**: Aggregates the outputs of a generic `StreamTextParser` across multiple chunks plus a final flush into one combined `StreamTextChunk` for assertions.

**Data flow**: Takes a mutable parser and a slice of chunk strings, initializes `all` with `StreamTextChunk::default()`, repeatedly calls `parser.push_str(chunk)` and appends each chunk’s visible text and extracted items into `all`, then calls `parser.finish()` and appends its outputs before returning `all`.

**Call relations**: This helper is used by the citation parser tests to express expected whole-stream behavior while still exercising chunked parsing.

*Call graph*: calls 1 internal fn (default); 2 external calls (finish, push_str).


##### `tests::citation_parser_streams_across_chunk_boundaries`  (lines 103–116)

```
fn citation_parser_streams_across_chunk_boundaries()
```

**Purpose**: Verifies that citation open and close tags split across chunk boundaries are recognized correctly and removed from visible output.

**Data flow**: Creates a `CitationStreamParser`, feeds three chunks through `collect_chunks`, and asserts that the combined visible text omits the citation markup while the extracted vector contains the citation body.

**Call relations**: This test exercises the parser’s buffering behavior for partial delimiters across multiple `push_str` calls.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, collect_chunks).


##### `tests::citation_parser_buffers_partial_open_tag_prefix`  (lines 119–132)

```
fn citation_parser_buffers_partial_open_tag_prefix()
```

**Purpose**: Checks that a partial citation opener at the end of one chunk is withheld from visible output until the next chunk determines whether it completes a real tag.

**Data flow**: Creates a parser, calls `push_str` with a chunk ending in `<oai-mem-`, asserts that only the preceding visible text is emitted, then feeds the remainder of the tag and body in a second chunk, calls `finish`, and asserts on the resulting visible text, extracted citation, and empty tail.

**Call relations**: This test targets the parser’s pending-buffer logic inherited from `InlineHiddenTagParser`.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, assert_eq!).


##### `tests::citation_parser_auto_closes_unterminated_tag_on_finish`  (lines 135–141)

```
fn citation_parser_auto_closes_unterminated_tag_on_finish()
```

**Purpose**: Verifies that an open citation tag without a closing delimiter at EOF is treated as a completed citation rather than leaked into visible text.

**Data flow**: Creates a parser, feeds a single chunk containing an unterminated citation through `collect_chunks`, and asserts that visible text excludes the citation body while extracted output contains it.

**Call relations**: This test covers the `finish` semantics for incomplete citation tags.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, collect_chunks).


##### `tests::citation_parser_preserves_partial_open_tag_at_eof_if_not_a_full_tag`  (lines 144–150)

```
fn citation_parser_preserves_partial_open_tag_at_eof_if_not_a_full_tag()
```

**Purpose**: Checks that text ending with only a prefix of the citation opener is preserved literally at EOF when no full tag was actually formed.

**Data flow**: Creates a parser, feeds a chunk ending in `<oai-mem-` through `collect_chunks`, and asserts that the combined visible text still contains that suffix and that no citations were extracted.

**Call relations**: This test distinguishes incomplete opener prefixes from true unterminated tags.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, collect_chunks).


##### `tests::strip_citations_collects_all_citations`  (lines 153–160)

```
fn strip_citations_collects_all_citations()
```

**Purpose**: Verifies the one-shot helper on a string containing multiple complete citation tags.

**Data flow**: Calls `strip_citations` on a full input string with two citations and asserts that the returned visible text concatenates the surrounding text while the citation vector contains both bodies in order.

**Call relations**: This test validates the convenience wrapper rather than the incremental parser API directly.

*Call graph*: calls 1 internal fn (strip_citations); 1 external calls (assert_eq!).


##### `tests::strip_citations_auto_closes_unterminated_citation_at_eof`  (lines 163–168)

```
fn strip_citations_auto_closes_unterminated_citation_at_eof()
```

**Purpose**: Checks that the one-shot helper inherits the streaming parser’s EOF auto-close behavior for an unterminated citation.

**Data flow**: Calls `strip_citations` on text ending inside a citation and asserts that the visible text excludes the citation body while the returned citations vector contains it.

**Call relations**: This test confirms that `strip_citations` preserves `CitationStreamParser` semantics.

*Call graph*: calls 1 internal fn (strip_citations); 1 external calls (assert_eq!).


##### `tests::citation_parser_does_not_support_nested_tags`  (lines 171–178)

```
fn citation_parser_does_not_support_nested_tags()
```

**Purpose**: Documents the parser’s literal, non-nested matching behavior when citation tags appear inside citation content.

**Data flow**: Calls `strip_citations` on text containing a citation opener nested inside another citation and asserts that extraction stops at the first closing tag, leaving the outer closing tag in visible text and returning the inner opener as literal content.

**Call relations**: This test captures an important design limitation inherited from `InlineHiddenTagParser`.

*Call graph*: calls 1 internal fn (strip_citations); 1 external calls (assert_eq!).


### `utils/stream-parser/src/proposed_plan.rs`

`domain_logic` · `stream parsing of plan-mode assistant output and one-shot plan extraction utilities`

This file specializes a lower-level line-oriented parser for the assistant’s `<proposed_plan>` markup. `ProposedPlanSegment` is the public extracted representation: `Normal(String)` for ordinary visible text, `ProposedPlanStart`, `ProposedPlanDelta(String)` for text inside the block, and `ProposedPlanEnd`. `ProposedPlanParser` itself is a thin wrapper around `TaggedLineParser<PlanTag>`, configured with one `TagSpec` for the `<proposed_plan>` open and close tags.

As a `StreamTextParser`, `push_str` and `finish` both delegate to the underlying tagged-line parser and then normalize its output through `map_segments`. That mapping function is where the public semantics are defined: each `TaggedLineSegment` is converted into the corresponding `ProposedPlanSegment`, and only `Normal(text)` contributes to `visible_text`. This means plan blocks disappear from visible output but remain fully represented in the extracted segment stream, preserving ordering relative to surrounding normal text.

The helper `strip_proposed_plan_blocks` is the simplest non-streaming API: it runs the parser over a complete string and concatenates only visible text from the streaming and final flush phases. `extract_proposed_plan_text` instead walks the extracted segment stream, tracks whether any plan block was seen, clears accumulated text on each `ProposedPlanStart`, appends every `ProposedPlanDelta`, ignores `Normal` and `ProposedPlanEnd`, and returns `Some(plan_text)` only if at least one plan block occurred. Because the parser auto-closes unterminated blocks at EOF, both helpers inherit that forgiving end-of-stream behavior.

#### Function details

##### `ProposedPlanParser::new`  (lines 34–42)

```
fn new() -> Self
```

**Purpose**: Constructs a proposed-plan parser configured for the single `<proposed_plan>...</proposed_plan>` tag pair.

**Data flow**: Takes no arguments, creates a `TaggedLineParser` with one `TagSpec { open: OPEN_TAG, close: CLOSE_TAG, tag: PlanTag::ProposedPlan }`, stores it in `parser`, and returns the new `ProposedPlanParser`.

**Call relations**: This constructor is used by the one-shot helpers and by higher-level parsers such as `AssistantTextStreamParser` when plan mode is enabled.

*Call graph*: calls 1 internal fn (new); called by 5 (extract_proposed_plan_text, strip_proposed_plan_blocks, closes_unterminated_plan_block_on_finish, preserves_non_tag_lines, streams_proposed_plan_segments_and_visible_text); 1 external calls (vec!).


##### `ProposedPlanParser::default`  (lines 46–48)

```
fn default() -> Self
```

**Purpose**: Provides the default proposed-plan parser configuration by forwarding to `new`.

**Data flow**: Takes no arguments and returns `Self::new()`.

**Call relations**: This supports generic initialization patterns and mirrors the constructor behavior.

*Call graph*: 1 external calls (new).


##### `ProposedPlanParser::push_str`  (lines 54–56)

```
fn push_str(&mut self, chunk: &str) -> StreamTextChunk<Self::Extracted>
```

**Purpose**: Consumes one text chunk, parses any proposed-plan markup in it, and returns visible text plus ordered plan segments for that chunk.

**Data flow**: Takes `&mut self` and `chunk: &str`, calls `self.parser.parse(chunk)` to obtain `Vec<TaggedLineSegment<PlanTag>>`, passes that vector to `map_segments`, and returns the resulting `StreamTextChunk<ProposedPlanSegment>`.

**Call relations**: This method is called by `AssistantTextStreamParser::parse_visible_text` in plan mode and by tests that exercise chunked plan parsing.

*Call graph*: calls 2 internal fn (map_segments, parse); called by 1 (parse_visible_text).


##### `ProposedPlanParser::finish`  (lines 58–60)

```
fn finish(&mut self) -> StreamTextChunk<Self::Extracted>
```

**Purpose**: Flushes any buffered proposed-plan parsing state at EOF and returns the final visible text and plan segments.

**Data flow**: Calls `self.parser.finish()` to obtain any remaining tagged-line segments, maps them through `map_segments`, and returns the resulting `StreamTextChunk<ProposedPlanSegment>`.

**Call relations**: This is the end-of-stream counterpart to `push_str`, used by `AssistantTextStreamParser::finish`, the one-shot helpers, and tests.

*Call graph*: calls 2 internal fn (map_segments, finish); called by 1 (finish).


##### `map_segments`  (lines 63–84)

```
fn map_segments(segments: Vec<TaggedLineSegment<PlanTag>>) -> StreamTextChunk<ProposedPlanSegment>
```

**Purpose**: Converts internal tagged-line parser segments into the public `ProposedPlanSegment` representation and derives visible text from normal segments only.

**Data flow**: Consumes `segments: Vec<TaggedLineSegment<PlanTag>>`, initializes a default `StreamTextChunk<ProposedPlanSegment>`, maps each segment variant to `Normal`, `ProposedPlanStart`, `ProposedPlanDelta`, or `ProposedPlanEnd`, appends the text of `Normal` segments to `out.visible_text`, pushes every mapped segment into `out.extracted`, and returns `out`.

**Call relations**: This helper is called by both `ProposedPlanParser::push_str` and `ProposedPlanParser::finish` so the public mapping logic is centralized in one place.

*Call graph*: calls 1 internal fn (default); called by 2 (finish, push_str); 2 external calls (Normal, ProposedPlanDelta).


##### `strip_proposed_plan_blocks`  (lines 86–91)

```
fn strip_proposed_plan_blocks(text: &str) -> String
```

**Purpose**: Removes proposed-plan blocks from a complete string and returns only the visible non-plan text.

**Data flow**: Accepts `text: &str`, creates a fresh `ProposedPlanParser`, initializes `out` from `parser.push_str(text).visible_text`, appends `parser.finish().visible_text`, and returns the combined string.

**Call relations**: This helper is the simplest non-streaming consumer of `ProposedPlanParser`, used when callers only care about visible text.

*Call graph*: calls 1 internal fn (new).


##### `extract_proposed_plan_text`  (lines 93–115)

```
fn extract_proposed_plan_text(text: &str) -> Option<String>
```

**Purpose**: Extracts the textual contents of the last seen proposed-plan block from a complete string, if any block exists.

**Data flow**: Accepts `text: &str`, creates a `ProposedPlanParser`, initializes `plan_text` as empty and `saw_plan_block` as `false`, iterates over the concatenated extracted segments from `push_str(text)` and `finish()`, clears `plan_text` and marks `saw_plan_block = true` on `ProposedPlanStart`, appends delta strings on `ProposedPlanDelta`, ignores `ProposedPlanEnd` and `Normal`, and returns `saw_plan_block.then_some(plan_text)`.

**Call relations**: This helper is a higher-level reduction over the parser’s extracted segment stream, used when callers want just the plan body rather than the full ordered segment sequence.

*Call graph*: calls 1 internal fn (new); 1 external calls (new).


##### `tests::collect_chunks`  (lines 127–141)

```
fn collect_chunks(parser: &mut P, chunks: &[&str]) -> StreamTextChunk<P::Extracted>
```

**Purpose**: Aggregates chunked parser output and final flush output into one combined `StreamTextChunk` for assertions.

**Data flow**: Takes a mutable generic parser and chunk slice, initializes a default aggregate chunk, appends visible text and extracted items from each `push_str` result, then appends the `finish` result and returns the aggregate.

**Call relations**: This helper is shared by the proposed-plan parser tests to validate whole-stream behavior while still exercising incremental parsing.

*Call graph*: calls 1 internal fn (default); 2 external calls (finish, push_str).


##### `tests::streams_proposed_plan_segments_and_visible_text`  (lines 144–166)

```
fn streams_proposed_plan_segments_and_visible_text()
```

**Purpose**: Verifies that a proposed-plan block split across chunk boundaries is removed from visible text and emitted as an ordered sequence of plan segments.

**Data flow**: Creates a `ProposedPlanParser`, feeds three chunks through `collect_chunks`, and asserts that visible text contains only the intro/outro text while extracted output contains `Normal`, `ProposedPlanStart`, `ProposedPlanDelta`, `ProposedPlanEnd`, and trailing `Normal` in order.

**Call relations**: This test exercises the normal streaming path through `ProposedPlanParser::new`, `push_str`, `finish`, and `map_segments`.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, collect_chunks).


##### `tests::preserves_non_tag_lines`  (lines 169–180)

```
fn preserves_non_tag_lines()
```

**Purpose**: Checks that text merely containing the tag string in a non-tag context is preserved as ordinary visible text.

**Data flow**: Creates a parser, feeds a line with leading spaces before `<proposed_plan>` through `collect_chunks`, and asserts that the entire line appears in visible text and as a single `Normal` extracted segment.

**Call relations**: This test documents the line-oriented matching semantics inherited from `TaggedLineParser`.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, collect_chunks).


##### `tests::closes_unterminated_plan_block_on_finish`  (lines 183–196)

```
fn closes_unterminated_plan_block_on_finish()
```

**Purpose**: Verifies that an open proposed-plan block at EOF is auto-closed and still emitted as start/delta/end segments.

**Data flow**: Creates a parser, feeds an unterminated plan block through `collect_chunks`, and asserts that visible text is empty while extracted output contains `ProposedPlanStart`, one `ProposedPlanDelta`, and `ProposedPlanEnd`.

**Call relations**: This test covers the parser’s forgiving EOF behavior as surfaced through `finish`.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, collect_chunks).


##### `tests::strips_proposed_plan_blocks_from_text`  (lines 199–202)

```
fn strips_proposed_plan_blocks_from_text()
```

**Purpose**: Validates the one-shot visible-text helper on a complete string containing a plan block.

**Data flow**: Calls `strip_proposed_plan_blocks` on a sample string and asserts that the returned text concatenates only the content before and after the plan block.

**Call relations**: This test targets the convenience wrapper rather than the incremental parser API.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::extracts_proposed_plan_text`  (lines 205–211)

```
fn extracts_proposed_plan_text()
```

**Purpose**: Validates the one-shot helper that returns the textual contents of a proposed-plan block.

**Data flow**: Calls `extract_proposed_plan_text` on a sample string and asserts that it returns `Some` containing the plan body text.

**Call relations**: This test covers the reduction logic implemented in `extract_proposed_plan_text`.

*Call graph*: 1 external calls (assert_eq!).


### `utils/stream-parser/src/assistant_text.rs`

`domain_logic` · `stream parsing of assistant responses and final flush at end-of-stream`

This file defines the top-level parser used for assistant text streams. `AssistantTextChunk` is the composite output unit: `visible_text` contains user-visible text after markup removal, `citations` contains extracted `<oai-mem-citation>` bodies, and `plan_segments` contains ordered `ProposedPlanSegment` values when plan mode is enabled. `AssistantTextStreamParser` owns two subordinate parsers, `CitationStreamParser` and `ProposedPlanParser`, plus a `plan_mode` flag that decides whether plan markup should be interpreted at all.

The parser runs in a fixed pipeline. `push_str` first feeds the incoming chunk into the citation parser, which strips citation tags and returns visible text plus extracted citation strings. That citation-cleaned visible text is then passed into `parse_visible_text`. In normal mode, this helper simply wraps the text into an `AssistantTextChunk` with empty side channels. In plan mode, it forwards the text into `ProposedPlanParser`, which removes `<proposed_plan>` blocks from visible output and emits ordered plan segments.

`finish` flushes both subordinate parsers in the same order. It first drains any buffered citation parser state, then parses the resulting visible text through the plan parser. If plan mode is enabled, it additionally calls `self.plan.finish()` and merges any trailing visible text and extracted plan segments into the output. Citations from the citation parser’s final chunk are assigned last. This ordering matters: citations are always stripped before plan parsing, so plan deltas never contain citation tags, only their surrounding text.

#### Function details

##### `AssistantTextChunk::is_empty`  (lines 15–17)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether a parsed assistant-text chunk carries no visible text, no citations, and no plan segments.

**Data flow**: Reads `self.visible_text`, `self.citations`, and `self.plan_segments`, tests each for emptiness, and returns `true` only if all three are empty.

**Call relations**: This is a convenience predicate used by tests and callers after `push_str` or `finish` to detect whether a parser flush produced any meaningful output.


##### `AssistantTextStreamParser::new`  (lines 31–36)

```
fn new(plan_mode: bool) -> Self
```

**Purpose**: Constructs a parser configured either to ignore proposed-plan markup or to parse it into structured segments.

**Data flow**: Consumes `plan_mode: bool`, starts from `Self::default()` to initialize the citation and plan subparsers, overwrites the `plan_mode` field, and returns the configured parser.

**Call relations**: This constructor is used by tests and application code before streaming begins; the chosen `plan_mode` controls whether later calls route visible text through `ProposedPlanParser`.

*Call graph*: called by 2 (parses_citations_across_seed_and_delta_boundaries, parses_plan_segments_after_citation_stripping); 1 external calls (default).


##### `AssistantTextStreamParser::push_str`  (lines 38–43)

```
fn push_str(&mut self, chunk: &str) -> AssistantTextChunk
```

**Purpose**: Consumes one incoming text chunk, strips citations, optionally parses proposed-plan markup, and returns the incremental visible/extracted output for that chunk.

**Data flow**: Takes `&mut self` and `chunk: &str`, passes the chunk to `self.citations.push_str`, receives a citation parser chunk containing `visible_text` and extracted citation strings, feeds that visible text into `self.parse_visible_text`, then writes the citation list into the returned `AssistantTextChunk` before returning it.

**Call relations**: This is the main streaming entrypoint called repeatedly by higher-level response consumers. It delegates first to `CitationStreamParser::push_str` and then to `AssistantTextStreamParser::parse_visible_text` so citation stripping always precedes plan parsing.

*Call graph*: calls 2 internal fn (parse_visible_text, push_str).


##### `AssistantTextStreamParser::finish`  (lines 45–57)

```
fn finish(&mut self) -> AssistantTextChunk
```

**Purpose**: Flushes any buffered partial markup from the citation and plan subparsers and returns the final assistant-text chunk.

**Data flow**: Calls `self.citations.finish()` to obtain any remaining citation-cleaned visible text and extracted citations, passes that visible text through `self.parse_visible_text`, and if `self.plan_mode` is true also calls `self.plan.finish()` to obtain trailing plan output. Non-empty trailing plan visible text is appended to `out.visible_text`, trailing plan segments are appended to `out.plan_segments`, and citation strings from the citation flush are assigned to `out.citations` before returning.

**Call relations**: This method is called once at end-of-stream after zero or more `push_str` calls. It delegates to both subordinate parsers’ `finish` methods and preserves the same citation-first, plan-second processing order as the streaming path.

*Call graph*: calls 3 internal fn (parse_visible_text, finish, finish).


##### `AssistantTextStreamParser::parse_visible_text`  (lines 59–72)

```
fn parse_visible_text(&mut self, visible_text: String) -> AssistantTextChunk
```

**Purpose**: Transforms citation-cleaned visible text into the final assistant chunk shape, either by passing it through unchanged or by extracting proposed-plan segments.

**Data flow**: Consumes `visible_text: String` plus mutable access to `self`. If `plan_mode` is false, it returns an `AssistantTextChunk` containing that text and default-empty citations/plan segments. If `plan_mode` is true, it calls `self.plan.push_str(&visible_text)`, then builds an `AssistantTextChunk` whose `visible_text` and `plan_segments` come from the returned `StreamTextChunk<ProposedPlanSegment>` and whose citations remain default-empty.

**Call relations**: This helper is called internally by both `AssistantTextStreamParser::push_str` and `AssistantTextStreamParser::finish` to centralize the plan-mode branch.

*Call graph*: calls 1 internal fn (push_str); called by 2 (finish, push_str); 1 external calls (default).


##### `tests::parses_citations_across_seed_and_delta_boundaries`  (lines 82–95)

```
fn parses_citations_across_seed_and_delta_boundaries()
```

**Purpose**: Verifies that citation tags split across streaming chunk boundaries are removed from visible text and emitted as extracted citation strings.

**Data flow**: Creates a parser with `plan_mode = false`, feeds two chunks that split a citation tag and body across boundaries, calls `finish`, and asserts on the visible text and citation vectors returned from each stage.

**Call relations**: This test exercises the citation-only path through `AssistantTextStreamParser::new`, `push_str`, and `finish`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::parses_plan_segments_after_citation_stripping`  (lines 98–129)

```
fn parses_plan_segments_after_citation_stripping()
```

**Purpose**: Checks that in plan mode the parser strips citations before plan parsing, emits ordered plan segments, and leaves only non-plan text visible.

**Data flow**: Creates a parser with `plan_mode = true`, feeds chunks that split a `<proposed_plan>` block and include an embedded citation, then asserts on visible text, extracted citations, plan segments, and final emptiness after `finish`.

**Call relations**: This test covers the full combined pipeline: citation stripping, plan parsing, chunk-boundary buffering, and final flush behavior.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, assert_eq!).


### `tui/src/streaming/table_holdback.rs`

`domain_logic` · `stream request handling`

This module provides the table-specific state machine used by source-backed streaming controllers. Its public surface is the `TableHoldbackScanner`, which consumes append-only committed source chunks and reports a `TableHoldbackState`: `None`, `PendingHeader { header_start }`, or `Confirmed { table_start }`. The scanner stores byte offsets into the logical raw source stream, not rendered rows, so callers can map the mutable tail back to source boundaries.

Internally, the scanner keeps `source_offset`, a `FenceTracker`, one-line lookbehind in `previous_line`, and optional offsets for a pending header and a confirmed table start. The key rule is conservative confirmation: a table is recognized only when a header-like line is immediately followed by a delimiter line, and only when both lines are outside non-markdown fenced code (`FenceKind::Outside` or `FenceKind::Markdown`). Quoted tables are supported by stripping blockquote prefixes before structural checks. Partial rows are intentionally excluded because `push_source_chunk` is meant to receive only source already safe to commit, typically newline-terminated lines.

`push_source_chunk` splits incoming text with `split_inclusive('\n')`, feeds each line into `push_line`, and emits a trace event with byte count, line count, resulting state, and elapsed microseconds. The test-only helpers provide a stateless whole-buffer scan used to validate that the incremental scanner reaches the same decisions.

#### Function details

##### `TableHoldbackScanner::new`  (lines 60–68)

```
fn new() -> Self
```

**Purpose**: Creates a fresh incremental scanner with zero source offset, a new fence tracker, and no remembered header or confirmed table state. It represents the start of a new append-only source stream.

**Data flow**: It constructs and returns `TableHoldbackScanner { source_offset: 0, fence_tracker: FenceTracker::new(), previous_line: None, pending_header_start: None, confirmed_table_start: None }`. No external state is touched.

**Call relations**: Controllers and tests call this when beginning a new stream or fixture. It delegates fenced-code context initialization to `FenceTracker::new` because table detection depends on fence classification from the first line onward.

*Call graph*: calls 1 internal fn (new); called by 3 (new, incremental_holdback_detects_header_delimiter_across_chunk_boundary, incremental_holdback_matches_stateless_scan_per_chunk).


##### `TableHoldbackScanner::reset`  (lines 70–72)

```
fn reset(&mut self)
```

**Purpose**: Restores the scanner to its initial empty-stream state. It is equivalent to discarding the old scanner and constructing a new one.

**Data flow**: Given `&mut self`, it assigns `*self = Self::new()` and returns `()`, replacing all accumulated offsets and remembered line state.

**Call relations**: Reset paths use this when a stream lifecycle ends and the same scanner allocation is reused. It delegates the exact initial-state construction to `new` to keep reset semantics identical to first creation.

*Call graph*: called by 1 (reset); 1 external calls (new).


##### `TableHoldbackScanner::state`  (lines 81–89)

```
fn state(&self) -> TableHoldbackState
```

**Purpose**: Reports the current holdback decision derived from the scanner's accumulated source prefix. Confirmed tables take precedence over pending headers.

**Data flow**: It reads `confirmed_table_start` and `pending_header_start` and returns `TableHoldbackState::Confirmed`, `PendingHeader`, or `None` accordingly, without mutating scanner state.

**Call relations**: Policy code queries this when deciding how much of the rendered tail must remain mutable. It is a pure projection of scanner state after one or more `push_source_chunk` updates.

*Call graph*: called by 1 (active_tail_budget_lines).


##### `TableHoldbackScanner::push_source_chunk`  (lines 98–116)

```
fn push_source_chunk(&mut self, source_chunk: &str)
```

**Purpose**: Advances the scanner over a newly committed source chunk by processing each included line in order. It also records lightweight tracing metrics for incremental scan cost and resulting state.

**Data flow**: It takes `source_chunk: &str`; if empty, it returns immediately. Otherwise it captures a start `Instant`, iterates over `source_chunk.split_inclusive('\n')`, increments a line counter, calls `self.push_line(source_line)` for each piece, then emits a `tracing::trace!` event containing byte length, line count, current `state()`, and elapsed microseconds.

**Call relations**: Streaming controller paths call this whenever newline-safe source becomes committed or when finalizing remaining source. It delegates per-line state transitions to `push_line`, keeping chunk-level concerns limited to iteration and instrumentation.

*Call graph*: calls 1 internal fn (push_line); called by 2 (finalize_remaining, push_delta); 2 external calls (now, trace!).


##### `TableHoldbackScanner::push_line`  (lines 119–159)

```
fn push_line(&mut self, source_line: &str)
```

**Purpose**: Processes one committed source line through the table-detection state machine, updating pending-header and confirmed-table offsets while respecting fenced-code context. It is the core incremental algorithm.

**Data flow**: It receives `source_line: &str`, strips a trailing newline for structural checks, snapshots the current `source_offset` and current `fence_tracker.kind()`, derives optional candidate text via `table_candidate_text` unless inside `FenceKind::Other`, computes `is_header` and `is_delimiter`, then conditionally confirms a table when the previous line was a header in a compatible fence context and the current line is a delimiter. If no table is confirmed yet, it updates `pending_header_start` based on whether the current non-blank line looks like a header outside non-markdown fences. Finally it stores a new `PreviousLineState`, advances the fence tracker with the raw line text, and increments `source_offset` by the full original line length using saturating addition.

**Call relations**: Only `push_source_chunk` invokes this, once per committed line. It depends on `table_candidate_text` for quote-stripped structural parsing and on `FenceTracker` to suppress false positives inside non-markdown code fences.

*Call graph*: calls 3 internal fn (table_candidate_text, advance, kind); called by 1 (push_source_chunk).


##### `table_candidate_text`  (lines 167–170)

```
fn table_candidate_text(line: &str) -> Option<&str>
```

**Purpose**: Normalizes a line for table detection by removing blockquote prefixes and trimming whitespace, then returns that text only if it has pipe-table segment structure. It filters out lines that cannot participate in a table at all.

**Data flow**: It takes `line: &str`, computes `strip_blockquote_prefix(line).trim()`, runs `parse_table_segments` on the stripped text, and returns `Some(stripped)` when parsing succeeds or `None` otherwise.

**Call relations**: Both the incremental scanner and the test-only whole-buffer scanner use this helper before applying header/delimiter predicates. It centralizes the quoted-table rule so both paths classify candidate lines the same way.

*Call graph*: calls 2 internal fn (parse_table_segments, strip_blockquote_prefix); called by 2 (push_line, table_holdback_state).


##### `parse_lines_with_fence_state`  (lines 182–201)

```
fn parse_lines_with_fence_state(source: &str) -> Vec<ParsedLine<'_>>
```

**Purpose**: Builds a test-only representation of source lines annotated with the fence context and byte offset that applied before each line advanced the tracker. This mirrors the incremental scanner's fence semantics for whole-buffer validation.

**Data flow**: It takes `source: &str`, initializes a `FenceTracker`, iterates over `source.split('\n')`, pushes `ParsedLine { text, fence_context: tracker.kind(), source_start }` for each raw line, advances the tracker with that line, increments `source_start` by line length plus one newline byte using saturating arithmetic, and returns the collected `Vec<ParsedLine>`.

**Call relations**: The stateless test scanner calls this first so later pairwise analysis can reason about header/delimiter adjacency with the same fence context the incremental path uses.

*Call graph*: calls 1 internal fn (new); called by 1 (table_holdback_state); 1 external calls (new).


##### `table_holdback_state`  (lines 206–242)

```
fn table_holdback_state(source: &str) -> TableHoldbackState
```

**Purpose**: Performs a test-only whole-buffer scan for table holdback state, returning the same `TableHoldbackState` shape as the incremental scanner. It confirms tables from adjacent header/delimiter pairs and otherwise reports a trailing pending header when appropriate.

**Data flow**: It takes `source: &str`, parses annotated lines with `parse_lines_with_fence_state`, scans adjacent windows of two lines to find the first pair outside `FenceKind::Other` whose quote-stripped texts satisfy `is_table_header_line` and `is_table_delimiter_line`, returning `Confirmed { table_start }` from the header offset when found. If no confirmed table exists, it searches backward for the last non-blank line and returns `PendingHeader { header_start }` when that line is outside `Other` fences and still looks like a header; otherwise it returns `None`.

**Call relations**: This helper exists for tests that compare incremental chunk-by-chunk scanning against a canonical whole-buffer result. It delegates line annotation and candidate extraction to shared helpers so the comparison validates statefulness rather than duplicate parsing logic.

*Call graph*: calls 4 internal fn (parse_lines_with_fence_state, table_candidate_text, is_table_delimiter_line, is_table_header_line).


### `tui/src/markdown_render/table_key_value.rs`

`domain_logic` · `table rendering fallback`

This submodule is used only from `markdown_render.rs` when aligned table rendering becomes unreadable. Its first decision point, `should_render_records`, scans body rows against already-computed `column_widths` and `TableColumnMetrics`. It counts rows affected either by fragmented values—especially compact or token-heavy columns whose tokens exceed the assigned width—or by `expansive_cells_are_starved`, which detects multiple tall wrapped non-compact cells or catastrophically narrow narrative cells. The threshold is adaptive: one affected row is enough for a single-row table, otherwise at least two rows or one third of rows.

`render_records` then chooses between two visual layouts. If the available width can fit a left-aligned label column plus a minimally useful value width, it uses `render_aligned_field`, which prints each header label once and aligns wrapped value lines underneath a fixed indent. Otherwise it uses `render_stacked_field`, which wraps the label itself if needed and prints the value below it with a smaller fixed indent. Between records it inserts a separator line made from `TABLE_BODY_SEPARATOR_CHAR`, sized either from the available width or the widest emitted line so far.

Both layouts rely on a local `wrap_cell` helper that mirrors the main table-cell wrapper: each logical cell line is wrapped independently with `word_wrap_line`, converted to static lines, and hyperlink ranges are remapped. `push_prefixed_value_line` is the key metadata-preserving primitive, shifting hyperlink column ranges by the width of the inserted label/indent prefix before pushing the final `HyperlinkLine`.

#### Function details

##### `should_render_records`  (lines 31–71)

```
fn should_render_records(
    rows: &[Vec<TableCell>],
    column_widths: &[usize],
    metrics: &[TableColumnMetrics],
) -> bool
```

**Purpose**: Decides whether a table should abandon aligned grid rendering and switch to vertical key/value records based on systemic readability loss.

**Data flow**: It takes body rows, assigned column widths, and per-column metrics. For each row it checks whether any compact column has a token wider than its column, whether any token-heavy column is both narrower than the scannable threshold and contains fragmented tokens, or whether `expansive_cells_are_starved` reports severe wrapping. It counts affected rows, computes an adaptive threshold, and returns true when enough rows are degraded.

**Call relations**: Called by `Writer::render_table_lines` after width allocation succeeds but before committing to grid rendering.

*Call graph*: called by 1 (render_table_lines).


##### `expansive_cells_are_starved`  (lines 73–96)

```
fn expansive_cells_are_starved(
    row: &[TableCell],
    column_widths: &[usize],
    metrics: &[TableColumnMetrics],
) -> bool
```

**Purpose**: Detects rows whose non-compact cells have collapsed into excessively tall narrow strips.

**Data flow**: It filters the row to non-compact columns, wraps each cell at its assigned width, records `(kind, width, wrapped_height)`, and returns true when at least two expansive cells are cramped to four or more lines or when any narrative cell is narrower than the narrative threshold and wraps to seven or more lines.

**Call relations**: Used only by `should_render_records` as one of the degradation heuristics.

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

**Purpose**: Renders table rows as a sequence of labeled fields, either aligned or stacked, with separators between records.

**Data flow**: It takes headers, rows, metrics, optional available width, label style, and separator style. It computes the widest header label width, chooses a minimum useful value width based on whether any column is non-compact, decides whether aligned fields fit, then for each row renders each `(header, value)` pair with either `render_aligned_field` or `render_stacked_field`. Between rows it inserts a separator line sized from the available width or `widest_line_width`.

**Call relations**: Called by `Writer::render_table_lines` whenever record fallback is selected.

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

**Purpose**: Renders one header/value pair in a single-column-aligned layout where wrapped value lines line up under the first value line.

**Data flow**: It takes the output buffer, header cell, value cell, fixed label width, optional available width, and label style. It computes the indent and value width, wraps the value cell, emits the first line with leading padding, styled label text, and gap spacing, emits continuation lines with only the computed indent, and delegates final line assembly to `push_prefixed_value_line`.

**Call relations**: Used by `render_records` when the available width can support a readable aligned label/value layout.

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

**Purpose**: Renders one header/value pair in a stacked layout where the label appears above the value when horizontal alignment would be too cramped.

**Data flow**: It computes a label wrap width from the available width, wraps the plain-text label with `word_wrap_line`, emits each wrapped label line with one leading space and label styling, computes a value width using the stacked indent, wraps the value cell, and emits each wrapped value line prefixed by `STACKED_VALUE_INDENT` spaces via `push_prefixed_value_line`.

**Call relations**: Used by `render_records` when aligned fields would leave too little room for values.

*Call graph*: calls 7 internal fn (plain_text, push_prefixed_value_line, wrap_cell, push_owned_lines, new, new, word_wrap_line); called by 1 (render_records); 4 external calls (from, styled, new, vec!).


##### `push_prefixed_value_line`  (lines 214–232)

```
fn push_prefixed_value_line(
    out: &mut Vec<HyperlinkLine>,
    mut prefix: Vec<Span<'static>>,
    mut value_line: HyperlinkLine,
)
```

**Purpose**: Prepends a span prefix to a wrapped value line and shifts all hyperlink ranges so they still point at the correct columns.

**Data flow**: It takes the output buffer, a mutable prefix span vector, and a mutable `HyperlinkLine`. It computes the prefix display width, appends the value line’s spans after the prefix, creates a new output line, offsets each hyperlink range by the prefix width, and pushes the result into `out`.

**Call relations**: Shared by both aligned and stacked field renderers to preserve hyperlink metadata after indentation and labels are inserted.

*Call graph*: calls 1 internal fn (new); called by 2 (render_aligned_field, render_stacked_field); 1 external calls (from).


##### `wrap_cell`  (lines 234–255)

```
fn wrap_cell(cell: &TableCell, width: usize) -> Vec<HyperlinkLine>
```

**Purpose**: Wraps a `TableCell` for record rendering while preserving logical hard breaks and hyperlink annotations.

**Data flow**: It takes a cell and width. Empty cells become one blank line. Otherwise each logical source line is wrapped with `word_wrap_line`, converted to static lines, remapped with `remap_wrapped_line`, and accumulated; if wrapping yields nothing, a blank line is inserted.

**Call relations**: Used by `render_aligned_field`, `render_stacked_field`, and `expansive_cells_are_starved`.

*Call graph*: calls 4 internal fn (new, remap_wrapped_line, new, word_wrap_line); called by 2 (render_aligned_field, render_stacked_field); 3 external calls (default, new, vec!).


##### `cell_width`  (lines 257–269)

```
fn cell_width(cell: &TableCell) -> usize
```

**Purpose**: Measures the widest visible logical line in a table cell.

**Data flow**: It sums span widths for each logical line in the cell, takes the maximum, and returns 0 for empty cells.

**Call relations**: Used by field renderers when no explicit available width is provided.


##### `widest_line_width`  (lines 271–283)

```
fn widest_line_width(lines: &[HyperlinkLine]) -> usize
```

**Purpose**: Finds the widest already-rendered output line so record separators can match the current content width when no explicit width budget exists.

**Data flow**: It iterates over rendered `HyperlinkLine`s, sums span widths for each line, and returns the maximum or 0.

**Call relations**: Used by `render_records` to size inter-record separator lines in unconstrained-width mode.

*Call graph*: 1 external calls (iter).


### `tui/src/render/highlight.rs`

`domain_logic` · `startup and cross-cutting`

This module is the central syntax-highlighting engine for the TUI. It wraps syntect and two_face behind a process-global configuration model built from four `OnceLock` singletons: immutable syntax definitions (`SYNTAX_SET`), a runtime-swappable `RwLock<Theme>` (`THEME`), a persisted optional theme override (`THEME_OVERRIDE`), and an optional custom-theme root (`CODEX_HOME`). Startup code calls `set_theme_override` once with the final resolved config; after that, runtime preview flows can swap only the active theme via `set_syntax_theme` without changing the persisted override.

Theme resolution supports both bundled two_face themes and custom `.tmTheme` files under `{codex_home}/themes`. `validate_theme_name`, `resolve_theme_by_name`, `configured_theme_name`, and `list_available_themes` collectively implement user-facing theme selection, warning generation, and picker population. Invalid custom files are intentionally excluded from picker listings but still produce startup warnings when explicitly configured.

Highlighting itself is guarded by hard limits of 512 KB and 10,000 lines. `highlight_to_line_spans_with_theme` rejects oversized inputs early, resolves a syntax via `find_syntax` (including patched aliases like `csharp`, `golang`, and `python3`), then uses `HighlightLines` over `LinesWithEndings` so multiline input preserves exact line structure. Trailing `\n` and `\r` are stripped from each highlighted fragment because line breaks are reconstructed at the outer layer; empty highlighted lines are represented by a single empty `Span`.

Style conversion is intentionally conservative. `convert_syntect_color` understands bat/syntect's ANSI-family alpha-channel encoding, mapping low ANSI indices to ratatui named colors and treating alpha=1 as terminal-default/no explicit color. `convert_style` applies only foreground and bold, deliberately suppressing background, italic, and underline to avoid terminal rendering artifacts. Additional helpers expose theme-derived diff background RGBs and foreground styles for arbitrary TextMate scopes.

#### Function details

##### `syntax_set`  (lines 59–61)

```
fn syntax_set() -> &'static SyntaxSet
```

**Purpose**: Lazily initializes and returns the process-global syntect `SyntaxSet` built from two_face's extended grammar bundle.

**Data flow**: It reads the `SYNTAX_SET` `OnceLock`, initializing it with `two_face::syntax::extra_newlines` on first use, and returns a shared `&'static SyntaxSet`. No mutable state is exposed after initialization.

**Call relations**: This singleton accessor is used by `find_syntax` and `highlight_to_line_spans_with_theme` so all highlighting paths share one immutable grammar database.

*Call graph*: called by 2 (find_syntax, highlight_to_line_spans_with_theme).


##### `set_theme_override`  (lines 81–101)

```
fn set_theme_override(
    name: Option<String>,
    codex_home: Option<PathBuf>,
) -> Option<String>
```

**Purpose**: Persists the configured theme override and codex-home path on first call, validates the requested theme, and updates the runtime theme immediately when the theme lock already exists.

**Data flow**: It takes an optional theme name and optional `PathBuf` for `codex_home`, computes a warning via `validate_theme_name`, attempts to store both values in `THEME_OVERRIDE` and `CODEX_HOME`, conditionally updates the live theme with `set_syntax_theme(resolve_theme_with_override(...))` if `THEME` has already been initialized, logs a debug breadcrumb if either `OnceLock` was already set, and returns `Option<String>` warning text.

**Call relations**: This startup-facing function is called by `run_ratatui_app`. It delegates validation to `validate_theme_name`, theme construction to `resolve_theme_with_override`, and runtime swapping to `set_syntax_theme`.

*Call graph*: calls 3 internal fn (resolve_theme_with_override, set_syntax_theme, validate_theme_name); called by 1 (run_ratatui_app); 1 external calls (debug!).


##### `validate_theme_name`  (lines 105–133)

```
fn validate_theme_name(name: Option<&str>, codex_home: Option<&Path>) -> Option<String>
```

**Purpose**: Checks whether a configured theme name resolves to either a bundled theme or a valid custom `.tmTheme` file and returns a user-facing warning when it does not.

**Data flow**: It takes an optional theme name and optional `codex_home` path. If no name is provided it returns `None`. Otherwise it computes a display path using `custom_theme_path`, accepts bundled names recognized by `parse_theme_name`, accepts custom themes only when the expected file exists and `load_custom_theme` succeeds, and otherwise returns a formatted warning string describing either a missing theme or an invalid custom file.

**Call relations**: This function is used by `set_theme_override` before persisting config and is also covered directly by tests. It delegates bundled-name recognition to `parse_theme_name` and custom-file loading/path construction to `load_custom_theme` and `custom_theme_path`.

*Call graph*: calls 3 internal fn (custom_theme_path, load_custom_theme, parse_theme_name); called by 3 (set_theme_override, validate_theme_name_warns_for_missing_custom, validate_theme_name_warns_when_custom_file_is_invalid); 1 external calls (format!).


##### `parse_theme_name`  (lines 136–172)

```
fn parse_theme_name(name: &str) -> Option<EmbeddedThemeName>
```

**Purpose**: Maps the application's kebab-case theme identifiers to concrete `EmbeddedThemeName` variants from two_face.

**Data flow**: It takes a `&str`, matches it against the full supported built-in theme list, and returns `Option<EmbeddedThemeName>`. Unknown names return `None`.

**Call relations**: This pure mapping function underpins bundled-theme recognition in `validate_theme_name`, `resolve_theme_with_override`, `resolve_theme_by_name`, and `configured_theme_name`.

*Call graph*: called by 4 (configured_theme_name, resolve_theme_by_name, resolve_theme_with_override, validate_theme_name).


##### `custom_theme_path`  (lines 175–177)

```
fn custom_theme_path(name: &str, codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the canonical filesystem path for a custom `.tmTheme` file under the user's themes directory.

**Data flow**: It takes a theme name and `codex_home`, joins `themes` and `<name>.tmTheme`, and returns the resulting `PathBuf`.

**Call relations**: This helper is used by both `validate_theme_name` and `load_custom_theme` so custom-theme lookup follows one path convention.

*Call graph*: called by 2 (load_custom_theme, validate_theme_name); 2 external calls (join, format!).


##### `load_custom_theme`  (lines 180–182)

```
fn load_custom_theme(name: &str, codex_home: &Path) -> Option<Theme>
```

**Purpose**: Attempts to parse a custom `.tmTheme` file from disk into a syntect `Theme`.

**Data flow**: It takes a theme name and `codex_home`, computes the file path with `custom_theme_path`, calls `ThemeSet::get_theme`, and returns `Option<Theme>` based on parse success. It does not cache results.

**Call relations**: This loader is used by theme validation and resolution paths (`validate_theme_name`, `resolve_theme_with_override`, `resolve_theme_by_name`, `configured_theme_name`) whenever a bundled theme name does not match.

*Call graph*: calls 1 internal fn (custom_theme_path); called by 5 (configured_theme_name, resolve_theme_by_name, resolve_theme_with_override, load_custom_theme_from_tmtheme_file, validate_theme_name); 1 external calls (get_theme).


##### `adaptive_default_theme_selection`  (lines 184–191)

```
fn adaptive_default_theme_selection() -> (EmbeddedThemeName, &'static str)
```

**Purpose**: Chooses the default bundled syntax theme based on whether the terminal background appears light or dark.

**Data flow**: It queries `crate::terminal_palette::default_bg()`, checks lightness with `crate::color::is_light`, and returns a pair of `(EmbeddedThemeName, &'static str)` selecting either Catppuccin Latte for light backgrounds or Catppuccin Mocha otherwise.

**Call relations**: This helper feeds both `adaptive_default_embedded_theme_name` and `adaptive_default_theme_name`, centralizing the adaptive default decision.

*Call graph*: calls 2 internal fn (is_light, default_bg); called by 2 (adaptive_default_embedded_theme_name, adaptive_default_theme_name).


##### `adaptive_default_embedded_theme_name`  (lines 193–195)

```
fn adaptive_default_embedded_theme_name() -> EmbeddedThemeName
```

**Purpose**: Returns only the `EmbeddedThemeName` portion of the adaptive default theme selection.

**Data flow**: It calls `adaptive_default_theme_selection()` and returns the first tuple element. No state is mutated.

**Call relations**: This helper is used by `resolve_theme_with_override` when no valid override is available.

*Call graph*: calls 1 internal fn (adaptive_default_theme_selection); called by 1 (resolve_theme_with_override).


##### `adaptive_default_theme_name`  (lines 199–201)

```
fn adaptive_default_theme_name() -> &'static str
```

**Purpose**: Returns the kebab-case string name of the adaptive default syntax theme.

**Data flow**: It calls `adaptive_default_theme_selection()` and returns the second tuple element. It performs no mutation.

**Call relations**: This function is used when restoring runtime theme from config and when reporting the configured theme name if no valid override persists.

*Call graph*: calls 1 internal fn (adaptive_default_theme_selection); called by 2 (restore_runtime_theme_from_config, configured_theme_name).


##### `resolve_theme_with_override`  (lines 205–224)

```
fn resolve_theme_with_override(name: Option<&str>, codex_home: Option<&Path>) -> Theme
```

**Purpose**: Builds the effective `Theme` from an optional configured name and optional custom-theme root, falling back to the adaptive default when necessary.

**Data flow**: It loads the embedded theme set via `two_face::theme::extra()`, checks whether `name` maps to a bundled theme with `parse_theme_name`, otherwise tries `load_custom_theme` if `codex_home` is present, logs a debug message for unrecognized names, and finally clones the adaptive default embedded theme if no override resolves. It returns a concrete `Theme`.

**Call relations**: This is the core theme-resolution routine used by both `set_theme_override` and `build_default_theme`, separating persisted-config interpretation from runtime lock management.

*Call graph*: calls 3 internal fn (adaptive_default_embedded_theme_name, load_custom_theme, parse_theme_name); called by 2 (build_default_theme, set_theme_override); 2 external calls (debug!, extra).


##### `build_default_theme`  (lines 228–234)

```
fn build_default_theme() -> Theme
```

**Purpose**: Constructs the initial runtime theme from the persisted `OnceLock` override and codex-home values.

**Data flow**: It reads `THEME_OVERRIDE` and `CODEX_HOME`, converts their stored owned values into borrowed options, passes them to `resolve_theme_with_override`, and returns the resulting `Theme`.

**Call relations**: This helper is used only by `theme_lock` during first initialization of the runtime theme `RwLock`.

*Call graph*: calls 1 internal fn (resolve_theme_with_override).


##### `theme_lock`  (lines 236–238)

```
fn theme_lock() -> &'static RwLock<Theme>
```

**Purpose**: Lazily initializes and returns the process-global `RwLock<Theme>` that holds the currently active syntax theme.

**Data flow**: It reads the `THEME` `OnceLock`, initializing it with `RwLock::new(build_default_theme())` on first access, and returns a shared reference to the lock.

**Call relations**: This singleton accessor is used by `set_syntax_theme`, `current_syntax_theme`, and `highlight_to_line_spans` so all runtime highlighting reads and writes go through one lock.

*Call graph*: called by 3 (current_syntax_theme, highlight_to_line_spans, set_syntax_theme).


##### `set_syntax_theme`  (lines 241–247)

```
fn set_syntax_theme(theme: Theme)
```

**Purpose**: Replaces the active runtime syntax theme, tolerating poisoned locks by recovering the inner value.

**Data flow**: It takes an owned `Theme`, acquires a write guard from `theme_lock()`, falling back to `poisoned.into_inner()` if needed, assigns the new theme into the guard, and returns no value.

**Call relations**: This runtime swap function is used by startup restoration, live preview event handling, and `set_theme_override` when the theme lock already exists.

*Call graph*: calls 1 internal fn (theme_lock); called by 3 (restore_runtime_theme_from_config, handle_event, set_theme_override).


##### `current_syntax_theme`  (lines 250–255)

```
fn current_syntax_theme() -> Theme
```

**Purpose**: Returns a clone of the currently active runtime syntax theme.

**Data flow**: It acquires a read guard from `theme_lock()`, recovering from poisoning if necessary, clones the contained `Theme`, and returns it.

**Call relations**: This snapshot accessor is used by `diff_scope_background_rgbs`, `foreground_style_for_scopes`, and theme-picker code that needs the current live theme.

*Call graph*: calls 1 internal fn (theme_lock); called by 3 (diff_scope_background_rgbs, foreground_style_for_scopes, build_theme_picker_params).


##### `diff_scope_background_rgbs`  (lines 278–281)

```
fn diff_scope_background_rgbs() -> DiffScopeBackgroundRgbs
```

**Purpose**: Extracts inserted/deleted diff background RGBs from the currently active syntax theme.

**Data flow**: It clones the current theme with `current_syntax_theme()`, passes it to `diff_scope_background_rgbs_for_theme`, and returns the resulting `DiffScopeBackgroundRgbs` struct.

**Call relations**: This public helper is used by diff rendering code to derive theme-aware insert/delete backgrounds from the active runtime theme.

*Call graph*: calls 2 internal fn (current_syntax_theme, diff_scope_background_rgbs_for_theme); called by 1 (resolve_diff_backgrounds).


##### `diff_scope_background_rgbs_for_theme`  (lines 285–292)

```
fn diff_scope_background_rgbs_for_theme(theme: &Theme) -> DiffScopeBackgroundRgbs
```

**Purpose**: Looks up inserted and deleted background colors in a specific theme, preferring `markup.*` scopes and falling back to `diff.*` scopes.

**Data flow**: It takes a `&Theme`, constructs a `Highlighter`, queries `scope_background_rgb` for `markup.inserted` then `diff.inserted`, and similarly for deleted scopes, then returns `DiffScopeBackgroundRgbs { inserted, deleted }`.

**Call relations**: This pure helper is used by `diff_scope_background_rgbs` and directly by tests so extraction logic can be validated without mutating global theme state.

*Call graph*: calls 1 internal fn (scope_background_rgb); called by 5 (diff_scope_background_rgbs, bundled_theme_can_provide_diff_scope_backgrounds, custom_tmtheme_diff_scope_backgrounds_are_resolved, diff_scope_backgrounds_prefer_markup_scope_then_diff_fallback, diff_scope_backgrounds_return_none_when_no_background_scope_matches); 1 external calls (new).


##### `scope_background_rgb`  (lines 295–299)

```
fn scope_background_rgb(highlighter: &Highlighter<'_>, scope_name: &str) -> Option<(u8, u8, u8)>
```

**Purpose**: Extracts the background RGB triple for a single TextMate scope from a syntect `Highlighter`.

**Data flow**: It takes a `Highlighter` and scope name string, parses the scope with `Scope::new`, asks `style_mod_for_stack(&[scope])` for the style modifier, reads its optional background, and returns `Some((r, g, b))` or `None` if parsing or lookup fails.

**Call relations**: This helper is used only by `diff_scope_background_rgbs_for_theme` to probe candidate inserted/deleted scopes.

*Call graph*: called by 1 (diff_scope_background_rgbs_for_theme); 2 external calls (style_mod_for_stack, new).


##### `foreground_style_for_scopes`  (lines 303–306)

```
fn foreground_style_for_scopes(scope_names: &[&str]) -> Option<Style>
```

**Purpose**: Returns the first matching foreground-only ratatui `Style` for a list of TextMate scopes using the active runtime theme.

**Data flow**: It clones the current theme with `current_syntax_theme()`, passes it and the scope list to `foreground_style_for_scopes_with_theme`, and returns `Option<Style>`.

**Call relations**: This helper is used by several renderers that want theme-consistent colors for semantic labels or numeric values without invoking full syntax highlighting.

*Call graph*: calls 2 internal fn (current_syntax_theme, foreground_style_for_scopes_with_theme); called by 4 (label_style, numeric_style, theme_activity_style, render_table_lines).


##### `foreground_style_for_scopes_with_theme`  (lines 308–315)

```
fn foreground_style_for_scopes_with_theme(theme: &Theme, scope_names: &[&str]) -> Option<Style>
```

**Purpose**: Searches a specific theme for the first supplied scope that defines a foreground color and converts it into a ratatui style.

**Data flow**: It takes a `&Theme` and slice of scope names, constructs a `Highlighter`, iterates the names in order, parses each scope, reads the optional foreground from `style_mod_for_stack`, converts that syntect color with `convert_syntect_color`, and wraps it in `Style::default().fg(...)`. It returns the first successful `Style` or `None`.

**Call relations**: This pure helper backs `foreground_style_for_scopes` and is directly tested with synthetic themes.

*Call graph*: called by 3 (foreground_style_for_scopes, foreground_style_for_scopes_reads_matching_theme_scope, foreground_style_for_scopes_uses_first_scope_with_foreground); 1 external calls (new).


##### `configured_theme_name`  (lines 322–335)

```
fn configured_theme_name() -> String
```

**Purpose**: Reports the persisted configured theme name when it still resolves, otherwise falls back to the adaptive default theme name.

**Data flow**: It reads `THEME_OVERRIDE` and `CODEX_HOME` from their `OnceLock`s. If an explicit override exists and either `parse_theme_name` recognizes it or `load_custom_theme` succeeds for the stored home, it returns that name; otherwise it returns `adaptive_default_theme_name().to_string()`.

**Call relations**: This function is used by theme-picker code to reflect persisted configuration rather than transient runtime preview swaps.

*Call graph*: calls 3 internal fn (adaptive_default_theme_name, load_custom_theme, parse_theme_name); called by 2 (build_theme_picker_params, unavailable_configured_theme_falls_back_to_configured_or_default_selection).


##### `resolve_theme_by_name`  (lines 339–352)

```
fn resolve_theme_by_name(name: &str, codex_home: Option<&Path>) -> Option<Theme>
```

**Purpose**: Resolves an arbitrary theme name to a concrete `Theme`, checking bundled themes first and custom `.tmTheme` files second.

**Data flow**: It takes a theme name and optional `codex_home`, loads the embedded theme set, tries `parse_theme_name` and clones the matching bundled theme if found, otherwise tries `load_custom_theme` when a home path is available, and returns `Option<Theme>`.

**Call relations**: This resolver is used by runtime theme restoration, live preview event handling, and tests that need to load specific bundled or custom themes.

*Call graph*: calls 2 internal fn (load_custom_theme, parse_theme_name); called by 6 (restore_runtime_theme_from_config, handle_event, ansi_family_themes_use_terminal_palette_colors_not_rgb, bundled_theme_can_provide_diff_scope_backgrounds, custom_tmtheme_diff_scope_backgrounds_are_resolved, unique_foreground_colors_for_theme); 1 external calls (extra).


##### `list_available_themes`  (lines 366–402)

```
fn list_available_themes(codex_home: Option<&Path>) -> Vec<ThemeEntry>
```

**Purpose**: Builds the theme-picker inventory by combining all bundled theme names with valid custom `.tmTheme` files discovered on disk.

**Data flow**: It starts from `BUILTIN_THEME_NAMES`, mapping each into `ThemeEntry { name, is_custom: false }`. If `codex_home` is present, it scans `{home}/themes`, filters files with `.tmTheme` extension, derives the stem as the theme name, validates each file by attempting `ThemeSet::get_theme`, skips duplicates against existing entries, marks valid disk themes as `is_custom: true`, then sorts the combined list case-insensitively with a stable tie-break on original name and returns `Vec<ThemeEntry>`.

**Call relations**: This function is used by theme-picker construction and directly by tests. It intentionally excludes invalid custom files rather than surfacing them as selectable entries.

*Call graph*: called by 3 (list_available_themes_excludes_invalid_custom_files, list_available_themes_returns_stable_sorted_order, build_theme_picker_params); 2 external calls (get_theme, read_dir).


##### `ansi_palette_color`  (lines 452–465)

```
fn ansi_palette_color(index: u8) -> RtColor
```

**Purpose**: Maps ANSI palette indices to ratatui colors, preferring named variants for the low 0-7 range and `Indexed(n)` for higher values.

**Data flow**: It takes an ANSI palette index byte and returns a `RtColor`, mapping 0-6 to named colors, 7 to `Gray`, and all other values to `RtColor::Indexed(n)`.

**Call relations**: This helper is used only by `convert_syntect_color` when decoding syntect colors that use bat's ANSI alpha-marker encoding.

*Call graph*: called by 1 (convert_syntect_color); 1 external calls (Indexed).


##### `convert_syntect_color`  (lines 481–492)

```
fn convert_syntect_color(color: SyntectColor) -> Option<RtColor>
```

**Purpose**: Decodes a syntect color into an optional ratatui foreground color, honoring bat/syntect's alpha-channel conventions for ANSI palette and terminal-default semantics.

**Data flow**: It takes a `SyntectColor` and matches on `color.a`: `0x00` maps `color.r` through `ansi_palette_color`, `0x01` returns `None` to mean terminal default, `0xFF` returns `RtColor::Rgb(r, g, b)`, and any other alpha also falls back to `Rgb`. It returns `Option<RtColor>`.

**Call relations**: This conversion helper is used by `convert_style` and indirectly affects all highlighted output and scope-derived foreground styles.

*Call graph*: calls 1 internal fn (ansi_palette_color); called by 1 (convert_style); 1 external calls (Rgb).


##### `convert_style`  (lines 498–517)

```
fn convert_style(syn_style: SyntectStyle) -> Style
```

**Purpose**: Converts a syntect `Style` into a ratatui `Style`, applying only supported foreground and modifier semantics.

**Data flow**: It starts from `Style::default()`, optionally sets the foreground using `convert_syntect_color(syn_style.foreground)`, intentionally ignores background, adds `Modifier::BOLD` when the syntect font style contains bold, and intentionally suppresses italic and underline. It returns the resulting `Style`.

**Call relations**: This function is used by `highlight_to_line_spans_with_theme` for every highlighted span and is directly tested to enforce the module's terminal-friendly style policy.

*Call graph*: calls 1 internal fn (convert_syntect_color); called by 7 (highlight_to_line_spans_with_theme, convert_style_suppresses_underline, style_conversion_correctness, style_conversion_unexpected_alpha_falls_back_to_rgb, style_conversion_uses_ansi_named_color_when_alpha_is_zero_low_index, style_conversion_uses_indexed_color_when_alpha_is_zero_high_index, style_conversion_uses_terminal_default_when_alpha_is_one); 1 external calls (default).


##### `find_syntax`  (lines 525–561)

```
fn find_syntax(lang: &str) -> Option<&'static SyntaxReference>
```

**Purpose**: Resolves a language identifier, alias, syntax name, or file extension to a syntect `SyntaxReference`.

**Data flow**: It reads the global syntax set via `syntax_set()`, lowercases the input for alias normalization, patches a small set of unsupported aliases (`csharp`→`c#`, `cppm`/`cxxm`/`ixx`→`cpp`, `golang`→`go`, `python3`→`python`, `shell`→`bash`), then tries lookup by token, exact syntax name, case-insensitive syntax name scan, and finally raw input as file extension. It returns `Option<&'static SyntaxReference>`.

**Call relations**: This lookup helper is used by `highlight_to_line_spans_with_theme` before any highlighting work begins.

*Call graph*: calls 1 internal fn (syntax_set); called by 1 (highlight_to_line_spans_with_theme).


##### `exceeds_highlight_limits`  (lines 577–579)

```
fn exceeds_highlight_limits(total_bytes: usize, total_lines: usize) -> bool
```

**Purpose**: Checks whether aggregate content size exceeds the module's safe highlighting thresholds.

**Data flow**: It takes total byte and line counts and returns `true` when bytes exceed `MAX_HIGHLIGHT_BYTES` or lines exceed `MAX_HIGHLIGHT_LINES`; otherwise `false`.

**Call relations**: This lightweight guard is used by diff rendering code before attempting repeated highlighting work.

*Call graph*: called by 1 (render_change).


##### `highlight_to_line_spans_with_theme`  (lines 588–629)

```
fn highlight_to_line_spans_with_theme(
    code: &str,
    lang: &str,
    theme: &Theme,
) -> Option<Vec<Vec<Span<'static>>>>
```

**Purpose**: Runs syntect highlighting for a specific language and theme, returning one owned span vector per source line or `None` when highlighting should be skipped.

**Data flow**: It takes source `code`, language identifier `lang`, and a `&Theme`. It returns `None` for empty input, oversized input, or unknown syntax. Otherwise it resolves the syntax with `find_syntax`, creates `HighlightLines`, iterates `LinesWithEndings::from(code)`, highlights each line against the global syntax set, trims trailing `\n` and `\r` from each highlighted fragment, skips empty fragments, converts styles with `convert_style`, wraps text in owned `Span::styled`, inserts a single empty `Span::raw(String::new())` for lines that would otherwise be empty, accumulates `Vec<Vec<Span<'static>>>`, and returns `Some(lines)`.

**Call relations**: This is the core highlighting engine. It is called by `highlight_to_line_spans` in production and directly by tests that want explicit-theme behavior without touching global state.

*Call graph*: calls 3 internal fn (convert_style, find_syntax, syntax_set); called by 3 (highlight_to_line_spans, ansi_family_themes_use_terminal_palette_colors_not_rgb, unique_foreground_colors_for_theme); 6 external calls (new, from, raw, styled, new, new).


##### `highlight_to_line_spans`  (lines 634–640)

```
fn highlight_to_line_spans(code: &str, lang: &str) -> Option<Vec<Vec<Span<'static>>>>
```

**Purpose**: Runs the core highlighter using the current runtime theme from the global theme lock.

**Data flow**: It acquires a read guard from `theme_lock()`, recovering from poisoning if necessary, then passes the code, language, and borrowed theme to `highlight_to_line_spans_with_theme`. It returns the same `Option<Vec<Vec<Span<'static>>>>` result.

**Call relations**: This wrapper is the shared production path used by both `highlight_code_to_lines` and `highlight_code_to_styled_spans`.

*Call graph*: calls 2 internal fn (highlight_to_line_spans_with_theme, theme_lock); called by 2 (highlight_code_to_lines, highlight_code_to_styled_spans).


##### `highlight_code_to_lines`  (lines 652–666)

```
fn highlight_code_to_lines(code: &str, lang: &str) -> Vec<Line<'static>>
```

**Purpose**: Highlights code into ratatui `Line`s, falling back to plain unstyled lines when syntax lookup fails or guardrails reject the input.

**Data flow**: It takes source code and language, calls `highlight_to_line_spans`, and if highlighting succeeds converts each inner span vector into `Line::from`. Otherwise it falls back to `code.lines().map(Line::from)` to preserve plain text without a phantom trailing line, inserting one empty `Line` when the input is empty. It returns `Vec<Line<'static>>`.

**Call relations**: This is the main public rendering API used by markdown code blocks, exec-cell bash rendering, and tests. It delegates actual highlighting to `highlight_to_line_spans` and owns the plain-text fallback behavior.

*Call graph*: calls 1 internal fn (highlight_to_line_spans); called by 9 (end_codeblock, highlight_bash_to_lines, fallback_trailing_newline_no_phantom_line, highlight_crlf_strips_carriage_return, highlight_empty_string, highlight_markdown_preserves_content, highlight_multiline_python, highlight_rust_has_keyword_style, highlight_unknown_lang_falls_back); 2 external calls (from, new).


##### `highlight_bash_to_lines`  (lines 669–671)

```
fn highlight_bash_to_lines(script: &str) -> Vec<Line<'static>>
```

**Purpose**: Convenience wrapper that highlights a script as Bash.

**Data flow**: It takes a script string, calls `highlight_code_to_lines(script, "bash")`, and returns the resulting lines.

**Call relations**: This helper is used by command/transcript rendering paths that specifically want shell syntax highlighting without repeating the language string.

*Call graph*: calls 1 internal fn (highlight_code_to_lines); called by 4 (build_header, command_display_lines, transcript_lines, highlight_bash_preserves_content).


##### `highlight_code_to_styled_spans`  (lines 682–687)

```
fn highlight_code_to_styled_spans(
    code: &str,
    lang: &str,
) -> Option<Vec<Vec<Span<'static>>>>
```

**Purpose**: Highlights code into per-line span vectors for callers that need direct span-level integration rather than complete `Line` values.

**Data flow**: It takes source code and language, forwards them to `highlight_to_line_spans`, and returns the resulting `Option<Vec<Vec<Span<'static>>>>` unchanged.

**Call relations**: This API is used by diff and preview renderers that need to merge syntax-highlighted spans into larger line-construction pipelines.

*Call graph*: calls 1 internal fn (highlight_to_line_spans); called by 8 (ui_snapshot_syntax_highlighted_insert_wraps, ui_snapshot_syntax_highlighted_insert_wraps_text, update_diff_preserves_multiline_highlight_state_within_hunk, highlight_code_to_styled_spans_returns_some_for_known, highlight_large_input_falls_back, highlight_many_lines_falls_back, highlight_many_lines_no_trailing_newline_falls_back, render_preview).


##### `tests::write_minimal_tmtheme`  (lines 701–717)

```
fn write_minimal_tmtheme(path: &Path)
```

**Purpose**: Writes a minimal valid `.tmTheme` plist file for custom-theme tests.

**Data flow**: It takes a filesystem path and writes a hard-coded XML plist containing basic foreground/background settings. It returns no value and mutates the filesystem.

**Call relations**: This fixture helper is used by tests that need a parseable custom theme on disk.

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

**Purpose**: Writes a custom `.tmTheme` fixture containing explicit inserted/deleted scope background colors.

**Data flow**: It takes a path plus inserted/deleted scope names and color strings, formats an XML plist embedding those values, and writes it to disk. It returns no value.

**Call relations**: This helper is used by tests that validate diff-scope background extraction from custom themes.

*Call graph*: 2 external calls (format!, write).


##### `tests::reconstructed`  (lines 757–768)

```
fn reconstructed(lines: &[Line<'static>]) -> String
```

**Purpose**: Reassembles plain text from highlighted `Line`s by concatenating span contents with newline separators.

**Data flow**: It takes a slice of `Line<'static>`, iterates each line's spans, concatenates their `content`, joins lines with `\n`, and returns the resulting `String`.

**Call relations**: This helper is used by many highlighting tests to verify that styling never changes the underlying text content.

*Call graph*: 1 external calls (iter).


##### `tests::unique_foreground_colors_for_theme`  (lines 770–787)

```
fn unique_foreground_colors_for_theme(theme_name: &str) -> Vec<String>
```

**Purpose**: Collects the distinct foreground color debug strings produced when highlighting a sample Rust snippet with a named theme.

**Data flow**: It resolves a theme with `resolve_theme_by_name`, highlights a fixed Rust sample via `highlight_to_line_spans_with_theme`, extracts non-`None` foreground colors from all spans, formats them with `Debug`, sorts and deduplicates the list, and returns `Vec<String>`.

**Call relations**: This helper supports ANSI-family palette snapshot tests by exercising explicit-theme highlighting without touching global runtime theme state.

*Call graph*: calls 2 internal fn (highlight_to_line_spans_with_theme, resolve_theme_by_name).


##### `tests::theme_item`  (lines 789–797)

```
fn theme_item(scope: &str, background: Option<(u8, u8, u8)>) -> ThemeItem
```

**Purpose**: Builds a synthetic `ThemeItem` with an optional background color for a given scope selector.

**Data flow**: It parses the scope selector string into `ScopeSelectors`, constructs a `StyleModifier` with the optional background converted into `SyntectColor { a: 255 }`, and returns the assembled `ThemeItem`.

**Call relations**: This helper is used by tests that construct ad hoc themes for diff background extraction.

*Call graph*: 2 external calls (from_str, default).


##### `tests::theme_item_with_foreground`  (lines 799–812)

```
fn theme_item_with_foreground(scope: &str, foreground: (u8, u8, u8)) -> ThemeItem
```

**Purpose**: Builds a synthetic `ThemeItem` with a foreground color for a given scope selector.

**Data flow**: It parses the scope selector string, constructs a `StyleModifier` whose `foreground` is a fully opaque `SyntectColor`, and returns the resulting `ThemeItem`.

**Call relations**: This helper is used by tests for `foreground_style_for_scopes_with_theme`.

*Call graph*: 2 external calls (from_str, default).


##### `tests::assert_rgb`  (lines 814–819)

```
fn assert_rgb(color: Option<RtColor>, expected: (u8, u8, u8))
```

**Purpose**: Asserts that an optional ratatui color is a specific `Rgb(r, g, b)` value.

**Data flow**: It takes `Option<RtColor>` and an expected RGB triple, pattern-matches for `Some(RtColor::Rgb(...))`, panics with a descriptive message otherwise, and asserts equality of the channel tuple.

**Call relations**: This helper is used by scope-style tests to keep RGB assertions concise.

*Call graph*: 2 external calls (assert_eq!, panic!).


##### `tests::highlight_rust_has_keyword_style`  (lines 822–835)

```
fn highlight_rust_has_keyword_style()
```

**Purpose**: Verifies that Rust highlighting preserves text and assigns some non-default style to the `fn` keyword.

**Data flow**: It highlights `"fn main() {}"`, reconstructs the text to assert exact preservation, finds the span containing `fn`, and asserts that its style has either a foreground color or a modifier. It only inspects returned lines.

**Call relations**: This test exercises the normal highlighting path through `highlight_code_to_lines` and confirms that syntax styling is actually applied.

*Call graph*: calls 1 internal fn (highlight_code_to_lines); 2 external calls (assert!, assert_eq!).


##### `tests::highlight_unknown_lang_falls_back`  (lines 838–852)

```
fn highlight_unknown_lang_falls_back()
```

**Purpose**: Checks that unknown languages bypass highlighting and return plain unstyled text.

**Data flow**: It calls `highlight_code_to_lines` with an unrecognized language, reconstructs the text to verify preservation, and asserts that every span has `Style::default()`. It performs no side effects.

**Call relations**: This test validates the fallback branch in `highlight_code_to_lines` when `find_syntax` fails.

*Call graph*: calls 1 internal fn (highlight_code_to_lines); 1 external calls (assert_eq!).


##### `tests::fallback_trailing_newline_no_phantom_line`  (lines 855–867)

```
fn fallback_trailing_newline_no_phantom_line()
```

**Purpose**: Ensures the plain-text fallback path does not create an extra empty line when input ends with a newline.

**Data flow**: It highlights `"hello world\n"` with an unknown language, asserts that only one line is returned, and checks reconstructed content. It reads only the fallback output.

**Call relations**: This test specifically covers the `code.lines()` fallback choice in `highlight_code_to_lines`.

*Call graph*: calls 1 internal fn (highlight_code_to_lines); 1 external calls (assert_eq!).


##### `tests::highlight_empty_string`  (lines 870–874)

```
fn highlight_empty_string()
```

**Purpose**: Verifies that empty input still yields a single empty line rather than zero lines.

**Data flow**: It calls `highlight_code_to_lines("", "rust")`, then asserts line count 1 and reconstructed empty content.

**Call relations**: This test covers the interaction between `highlight_to_line_spans_with_theme` returning `None` for empty input and the fallback branch in `highlight_code_to_lines`.

*Call graph*: calls 1 internal fn (highlight_code_to_lines); 1 external calls (assert_eq!).


##### `tests::highlight_bash_preserves_content`  (lines 877–881)

```
fn highlight_bash_preserves_content()
```

**Purpose**: Checks that the Bash convenience wrapper preserves script text exactly.

**Data flow**: It calls `highlight_bash_to_lines` on a shell command string and asserts that reconstructing the lines yields the original script.

**Call relations**: This test exercises the `highlight_bash_to_lines` wrapper over `highlight_code_to_lines`.

*Call graph*: calls 1 internal fn (highlight_bash_to_lines); 1 external calls (assert_eq!).


##### `tests::highlight_crlf_strips_carriage_return`  (lines 884–898)

```
fn highlight_crlf_strips_carriage_return()
```

**Purpose**: Ensures highlighted span text does not retain `\r` characters from CRLF input.

**Data flow**: It highlights a Rust snippet with Windows-style line endings and asserts that no span content contains `\r`. It only inspects returned lines.

**Call relations**: This test validates the `trim_end_matches(['\n', '\r'])` cleanup inside `highlight_to_line_spans_with_theme`.

*Call graph*: calls 1 internal fn (highlight_code_to_lines); 1 external calls (assert!).


##### `tests::style_conversion_correctness`  (lines 902–926)

```
fn style_conversion_correctness()
```

**Purpose**: Checks that style conversion keeps foreground and bold while intentionally dropping background and italic.

**Data flow**: It constructs a synthetic `SyntectStyle`, converts it with `convert_style`, and asserts expected foreground RGB, absent background, present bold, and absent italic/underline modifiers.

**Call relations**: This test directly enforces the style-policy decisions encoded in `convert_style`.

*Call graph*: calls 1 internal fn (convert_style); 2 external calls (assert!, assert_eq!).


##### `tests::convert_style_suppresses_underline`  (lines 929–955)

```
fn convert_style_suppresses_underline()
```

**Purpose**: Verifies that underline from theme styles is intentionally suppressed during conversion.

**Data flow**: It builds a `SyntectStyle` with `FontStyle::UNDERLINE`, converts it, and asserts that the resulting ratatui style does not contain `Modifier::UNDERLINED`.

**Call relations**: This test protects the terminal-UX decision implemented in `convert_style`.

*Call graph*: calls 1 internal fn (convert_style); 1 external calls (assert!).


##### `tests::style_conversion_uses_ansi_named_color_when_alpha_is_zero_low_index`  (lines 958–976)

```
fn style_conversion_uses_ansi_named_color_when_alpha_is_zero_low_index()
```

**Purpose**: Checks that ANSI-family colors with alpha 0 and a low palette index map to ratatui named colors rather than RGB.

**Data flow**: It constructs a `SyntectStyle` whose foreground encodes ANSI index 2 in the red channel with alpha 0, converts it, and asserts `Some(RtColor::Green)`.

**Call relations**: This test exercises the ANSI alpha-marker branch in `convert_syntect_color` and the low-index mapping in `ansi_palette_color`.

*Call graph*: calls 1 internal fn (convert_style); 2 external calls (empty, assert_eq!).


##### `tests::style_conversion_uses_indexed_color_when_alpha_is_zero_high_index`  (lines 979–997)

```
fn style_conversion_uses_indexed_color_when_alpha_is_zero_high_index()
```

**Purpose**: Checks that ANSI-family colors with alpha 0 and a high palette index map to `RtColor::Indexed`.

**Data flow**: It constructs a `SyntectStyle` encoding palette index `0x9a`, converts it, and asserts that the foreground matches `Some(RtColor::Indexed(0x9a))`.

**Call relations**: This test covers the high-index fallback branch in `ansi_palette_color` as reached through `convert_style`.

*Call graph*: calls 1 internal fn (convert_style); 2 external calls (empty, assert!).


##### `tests::style_conversion_uses_terminal_default_when_alpha_is_one`  (lines 1000–1018)

```
fn style_conversion_uses_terminal_default_when_alpha_is_one()
```

**Purpose**: Verifies that alpha value 1 is interpreted as 'use terminal default' and therefore yields no explicit foreground color.

**Data flow**: It constructs a `SyntectStyle` with foreground alpha 1, converts it, and asserts `rt.fg == None`.

**Call relations**: This test validates the terminal-default branch in `convert_syntect_color`.

*Call graph*: calls 1 internal fn (convert_style); 2 external calls (empty, assert_eq!).


##### `tests::style_conversion_unexpected_alpha_falls_back_to_rgb`  (lines 1021–1039)

```
fn style_conversion_unexpected_alpha_falls_back_to_rgb()
```

**Purpose**: Checks that nonstandard alpha values are treated as ordinary RGB colors rather than ANSI markers.

**Data flow**: It constructs a `SyntectStyle` with alpha `0x80`, converts it, and asserts that the foreground is an RGB color.

**Call relations**: This test covers the catch-all branch in `convert_syntect_color`.

*Call graph*: calls 1 internal fn (convert_style); 2 external calls (empty, assert!).


##### `tests::ansi_palette_color_maps_ansi_white_to_gray`  (lines 1042–1044)

```
fn ansi_palette_color_maps_ansi_white_to_gray()
```

**Purpose**: Verifies the special mapping from ANSI palette index 7 to ratatui's `Gray` variant.

**Data flow**: It calls `ansi_palette_color(0x07)` and asserts equality with `RtColor::Gray`.

**Call relations**: This test directly covers the low-level ANSI palette mapping helper.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::ansi_family_themes_use_terminal_palette_colors_not_rgb`  (lines 1047–1074)

```
fn ansi_family_themes_use_terminal_palette_colors_not_rgb()
```

**Purpose**: Ensures the bundled ANSI-family themes produce palette/default colors rather than true RGB foregrounds when highlighting code.

**Data flow**: For each of `ansi`, `base16`, and `base16-256`, it resolves the theme, highlights a Rust sample with `highlight_to_line_spans_with_theme`, scans all span foregrounds, panics if any are `Rgb`, and asserts that at least one non-default foreground exists.

**Call relations**: This test validates the compatibility contract between bundled ANSI-family themes and `convert_syntect_color`.

*Call graph*: calls 2 internal fn (highlight_to_line_spans_with_theme, resolve_theme_by_name); 2 external calls (assert!, panic!).


##### `tests::ansi_family_foreground_palette_snapshot`  (lines 1077–1087)

```
fn ansi_family_foreground_palette_snapshot()
```

**Purpose**: Captures a snapshot of the distinct foreground colors produced by ANSI-family themes for a representative Rust snippet.

**Data flow**: It builds a string by calling `unique_foreground_colors_for_theme` for each ANSI-family theme, formatting the results, and snapshot-testing the final text.

**Call relations**: This test provides regression coverage for palette decoding behavior across bundled ANSI-family themes.

*Call graph*: 4 external calls (new, assert_snapshot!, format!, unique_foreground_colors_for_theme).


##### `tests::highlight_multiline_python`  (lines 1090–1095)

```
fn highlight_multiline_python()
```

**Purpose**: Checks that multiline Python code highlights successfully and preserves both content and line count.

**Data flow**: It highlights a three-line Python snippet, reconstructs the text to assert exact preservation, and asserts that three lines are returned.

**Call relations**: This test exercises normal multiline highlighting through `highlight_code_to_lines`.

*Call graph*: calls 1 internal fn (highlight_code_to_lines); 1 external calls (assert_eq!).


##### `tests::highlight_code_to_styled_spans_returns_none_for_unknown`  (lines 1098–1100)

```
fn highlight_code_to_styled_spans_returns_none_for_unknown()
```

**Purpose**: Verifies that the span-level API returns `None` rather than plain spans when the language is unknown.

**Data flow**: It calls `highlight_code_to_styled_spans("x", "xyzlang")` and asserts that the result is `None`.

**Call relations**: This test covers the direct `Option`-returning API rather than the line-level fallback wrapper.

*Call graph*: 1 external calls (assert!).


##### `tests::highlight_code_to_styled_spans_returns_some_for_known`  (lines 1103–1108)

```
fn highlight_code_to_styled_spans_returns_some_for_known()
```

**Purpose**: Checks that the span-level API returns highlighted spans for a recognized language.

**Data flow**: It calls `highlight_code_to_styled_spans("let x = 1;", "rust")`, asserts `Some`, unwraps the spans, and asserts the result is non-empty.

**Call relations**: This test exercises the successful path through `highlight_to_line_spans` via the span-level public API.

*Call graph*: calls 1 internal fn (highlight_code_to_styled_spans); 1 external calls (assert!).


##### `tests::highlight_markdown_preserves_content`  (lines 1111–1119)

```
fn highlight_markdown_preserves_content()
```

**Purpose**: Ensures markdown syntax highlighting preserves fenced-code text exactly.

**Data flow**: It highlights a markdown string containing nested fences, reconstructs the output with `reconstructed`, and asserts exact equality with the original input.

**Call relations**: This test guards against content corruption in a language whose syntax can contain fence-like delimiters.

*Call graph*: calls 1 internal fn (highlight_code_to_lines); 2 external calls (assert_eq!, reconstructed).


##### `tests::highlight_large_input_falls_back`  (lines 1122–1128)

```
fn highlight_large_input_falls_back()
```

**Purpose**: Verifies that inputs exceeding the byte-size guardrail are rejected by the span-level API.

**Data flow**: It creates a string one byte larger than `MAX_HIGHLIGHT_BYTES`, calls `highlight_code_to_styled_spans`, and asserts that the result is `None`.

**Call relations**: This test covers the oversized-input early return in `highlight_to_line_spans_with_theme`.

*Call graph*: calls 1 internal fn (highlight_code_to_styled_spans); 1 external calls (assert!).


##### `tests::highlight_many_lines_falls_back`  (lines 1131–1136)

```
fn highlight_many_lines_falls_back()
```

**Purpose**: Verifies that inputs exceeding the line-count guardrail are rejected by the span-level API.

**Data flow**: It creates a string with `MAX_HIGHLIGHT_LINES + 1` newline-terminated lines, calls `highlight_code_to_styled_spans`, and asserts `None`.

**Call relations**: This test covers the line-count guard in `highlight_to_line_spans_with_theme`.

*Call graph*: calls 1 internal fn (highlight_code_to_styled_spans); 1 external calls (assert!).


##### `tests::highlight_many_lines_no_trailing_newline_falls_back`  (lines 1139–1151)

```
fn highlight_many_lines_no_trailing_newline_falls_back()
```

**Purpose**: Ensures the line-count guard counts actual lines rather than newline bytes, even when the final line lacks a trailing newline.

**Data flow**: It constructs a snippet with `MAX_HIGHLIGHT_LINES + 1` logical lines but only `MAX_HIGHLIGHT_LINES` newline characters, asserts the line count, calls `highlight_code_to_styled_spans`, and asserts `None`.

**Call relations**: This test protects the explicit `code.lines().count()` guard used in `highlight_to_line_spans_with_theme`.

*Call graph*: calls 1 internal fn (highlight_code_to_styled_spans); 2 external calls (assert!, assert_eq!).


##### `tests::find_syntax_resolves_languages_and_aliases`  (lines 1154–1217)

```
fn find_syntax_resolves_languages_and_aliases()
```

**Purpose**: Checks that direct language names, common extensions, and patched aliases all resolve to a syntax.

**Data flow**: It iterates several arrays of language identifiers and extensions, calling `find_syntax` for each and asserting `Some`. It performs no side effects.

**Call relations**: This test directly validates the alias patching and multi-strategy lookup logic in `find_syntax`.

*Call graph*: 1 external calls (assert!).


##### `tests::diff_scope_backgrounds_prefer_markup_scope_then_diff_fallback`  (lines 1220–1237)

```
fn diff_scope_backgrounds_prefer_markup_scope_then_diff_fallback()
```

**Purpose**: Verifies that diff background extraction prefers `markup.*` scopes and falls back to `diff.*` only when needed.

**Data flow**: It constructs a synthetic `Theme` with `markup.inserted` and `diff.deleted` backgrounds, calls `diff_scope_background_rgbs_for_theme`, and asserts the expected inserted/deleted RGB tuple selection.

**Call relations**: This test directly exercises the scope-preference ordering in `diff_scope_background_rgbs_for_theme`.

*Call graph*: calls 1 internal fn (diff_scope_background_rgbs_for_theme); 4 external calls (default, default, assert_eq!, vec!).


##### `tests::diff_scope_backgrounds_return_none_when_no_background_scope_matches`  (lines 1240–1254)

```
fn diff_scope_backgrounds_return_none_when_no_background_scope_matches()
```

**Purpose**: Checks that diff background extraction returns `None` fields when no relevant scopes define backgrounds.

**Data flow**: It builds a synthetic theme with an unrelated scope background, calls `diff_scope_background_rgbs_for_theme`, and asserts both fields are `None`.

**Call relations**: This test covers the no-match path in the diff background extractor.

*Call graph*: calls 1 internal fn (diff_scope_background_rgbs_for_theme); 4 external calls (default, default, assert_eq!, vec!).


##### `tests::foreground_style_for_scopes_reads_matching_theme_scope`  (lines 1257–1268)

```
fn foreground_style_for_scopes_reads_matching_theme_scope()
```

**Purpose**: Verifies that a matching scope's foreground color is converted into a ratatui style.

**Data flow**: It constructs a synthetic theme with a `keyword` foreground, calls `foreground_style_for_scopes_with_theme(&theme, &["keyword"])`, unwraps the result, and asserts the RGB foreground with `assert_rgb`.

**Call relations**: This test directly exercises the explicit-theme scope-style lookup helper.

*Call graph*: calls 1 internal fn (foreground_style_for_scopes_with_theme); 4 external calls (default, default, assert_rgb, vec!).


##### `tests::foreground_style_for_scopes_uses_first_scope_with_foreground`  (lines 1271–1282)

```
fn foreground_style_for_scopes_uses_first_scope_with_foreground()
```

**Purpose**: Checks that scope-style lookup returns the first supplied scope that actually defines a foreground.

**Data flow**: It builds a theme where only `string` has a foreground, calls `foreground_style_for_scopes_with_theme(&theme, &["keyword", "string"])`, unwraps the result, and asserts the expected RGB color.

**Call relations**: This test validates the ordered search behavior in `foreground_style_for_scopes_with_theme`.

*Call graph*: calls 1 internal fn (foreground_style_for_scopes_with_theme); 4 external calls (default, default, assert_rgb, vec!).


##### `tests::bundled_theme_can_provide_diff_scope_backgrounds`  (lines 1285–1293)

```
fn bundled_theme_can_provide_diff_scope_backgrounds()
```

**Purpose**: Ensures at least one bundled theme exposes inserted/deleted diff backgrounds through the extractor.

**Data flow**: It resolves the `github` theme, calls `diff_scope_background_rgbs_for_theme`, and asserts that both inserted and deleted colors are present.

**Call relations**: This test confirms that the extractor works against real bundled themes, not just synthetic fixtures.

*Call graph*: calls 2 internal fn (diff_scope_background_rgbs_for_theme, resolve_theme_by_name); 1 external calls (assert!).


##### `tests::custom_tmtheme_diff_scope_backgrounds_are_resolved`  (lines 1296–1318)

```
fn custom_tmtheme_diff_scope_backgrounds_are_resolved()
```

**Purpose**: Verifies that diff background extraction works for custom `.tmTheme` files loaded from disk.

**Data flow**: It creates a temp themes directory, writes a custom `.tmTheme` with inserted/deleted backgrounds, resolves it with `resolve_theme_by_name`, extracts colors with `diff_scope_background_rgbs_for_theme`, and asserts the expected RGB tuples.

**Call relations**: This test covers the full custom-theme path from disk loading through diff-scope extraction.

*Call graph*: calls 2 internal fn (diff_scope_background_rgbs_for_theme, resolve_theme_by_name); 4 external calls (assert_eq!, create_dir, tempdir, write_tmtheme_with_diff_backgrounds).


##### `tests::parse_theme_name_covers_all_variants`  (lines 1321–1378)

```
fn parse_theme_name_covers_all_variants()
```

**Purpose**: Checks that known kebab-case built-in theme names map to the expected `EmbeddedThemeName` variants.

**Data flow**: It iterates a table of expected mappings, calls `parse_theme_name` for each kebab-case name, and asserts equality with the expected variant.

**Call relations**: This test directly validates the hard-coded bundled-theme mapping table.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_theme_name_returns_none_for_unknown`  (lines 1381–1384)

```
fn parse_theme_name_returns_none_for_unknown()
```

**Purpose**: Verifies that unknown or empty theme names are not treated as bundled themes.

**Data flow**: It calls `parse_theme_name` with invalid inputs and asserts `None`.

**Call relations**: This test covers the default branch of the bundled-theme parser.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::load_custom_theme_from_tmtheme_file`  (lines 1387–1394)

```
fn load_custom_theme_from_tmtheme_file()
```

**Purpose**: Checks that a valid custom `.tmTheme` file can be loaded from the expected themes directory.

**Data flow**: It creates a temp themes directory, writes a minimal valid theme file, calls `load_custom_theme`, and asserts that the result is `Some`.

**Call relations**: This test directly exercises the custom-theme loader and path convention.

*Call graph*: calls 1 internal fn (load_custom_theme); 4 external calls (assert!, create_dir, tempdir, write_minimal_tmtheme).


##### `tests::load_custom_theme_returns_none_for_missing`  (lines 1397–1400)

```
fn load_custom_theme_returns_none_for_missing()
```

**Purpose**: Verifies that missing custom theme files simply return `None`.

**Data flow**: It creates a temp directory without a matching theme file, calls `load_custom_theme`, and asserts `None`.

**Call relations**: This test covers the absent-file path in the custom-theme loader.

*Call graph*: 2 external calls (assert!, tempdir).


##### `tests::validate_theme_name_none_for_bundled`  (lines 1403–1407)

```
fn validate_theme_name_none_for_bundled()
```

**Purpose**: Ensures bundled theme names never produce startup warnings.

**Data flow**: It calls `validate_theme_name` with bundled names under different `codex_home` conditions and asserts `None` each time.

**Call relations**: This test validates the bundled-theme fast path in `validate_theme_name`.

*Call graph*: 1 external calls (assert!).


##### `tests::validate_theme_name_none_when_no_override`  (lines 1410–1412)

```
fn validate_theme_name_none_when_no_override()
```

**Purpose**: Checks that the absence of a configured theme override produces no warning.

**Data flow**: It calls `validate_theme_name(None, None)` and asserts `None`.

**Call relations**: This test covers the early-return branch in `validate_theme_name`.

*Call graph*: 1 external calls (assert!).


##### `tests::validate_theme_name_warns_for_missing_custom`  (lines 1415–1424)

```
fn validate_theme_name_warns_for_missing_custom()
```

**Purpose**: Verifies that an unknown theme name produces a warning mentioning the missing custom-theme path.

**Data flow**: It creates a temp directory, calls `validate_theme_name(Some("my-fancy"), Some(dir.path()))`, asserts `Some`, unwraps the message, and checks that it mentions the theme name.

**Call relations**: This test exercises the missing-theme warning branch in `validate_theme_name`.

*Call graph*: calls 1 internal fn (validate_theme_name); 2 external calls (assert!, tempdir).


##### `tests::validate_theme_name_none_when_custom_file_is_valid`  (lines 1427–1436)

```
fn validate_theme_name_none_when_custom_file_is_valid()
```

**Purpose**: Checks that a valid custom `.tmTheme` file suppresses warnings for its configured name.

**Data flow**: It creates a temp themes directory, writes a valid custom theme file, calls `validate_theme_name`, and asserts `None`.

**Call relations**: This test covers the successful custom-theme branch in `validate_theme_name`.

*Call graph*: 4 external calls (assert!, create_dir, tempdir, write_minimal_tmtheme).


##### `tests::validate_theme_name_warns_when_custom_file_is_invalid`  (lines 1439–1455)

```
fn validate_theme_name_warns_when_custom_file_is_invalid()
```

**Purpose**: Verifies that an existing but unparsable custom `.tmTheme` file produces an explicit invalid-format warning.

**Data flow**: It creates a temp themes directory, writes a placeholder invalid file, calls `validate_theme_name`, and asserts that the returned warning exists and contains `could not be loaded`.

**Call relations**: This test exercises the invalid-custom-file warning branch in `validate_theme_name`.

*Call graph*: calls 1 internal fn (validate_theme_name); 4 external calls (assert!, create_dir, write, tempdir).


##### `tests::list_available_themes_excludes_invalid_custom_files`  (lines 1458–1479)

```
fn list_available_themes_excludes_invalid_custom_files()
```

**Purpose**: Checks that theme discovery includes valid custom themes but filters out invalid `.tmTheme` files.

**Data flow**: It creates a temp themes directory, writes one valid and one invalid custom theme file, calls `list_available_themes`, and asserts presence of the valid custom entry and absence of the invalid one.

**Call relations**: This test validates the file-validation filter inside `list_available_themes`.

*Call graph*: calls 1 internal fn (list_available_themes); 5 external calls (assert!, create_dir, write, tempdir, write_minimal_tmtheme).


##### `tests::list_available_themes_returns_stable_sorted_order`  (lines 1482–1503)

```
fn list_available_themes_returns_stable_sorted_order()
```

**Purpose**: Verifies that discovered theme entries are sorted case-insensitively with stable ordering across built-in and custom themes.

**Data flow**: It creates several custom theme files with mixed-case names, calls `list_available_themes`, derives the actual `(is_custom, name)` list, computes an independently sorted expected copy, and asserts equality.

**Call relations**: This test covers the final sorting policy in `list_available_themes`.

*Call graph*: calls 1 internal fn (list_available_themes); 4 external calls (assert_eq!, create_dir, tempdir, write_minimal_tmtheme).


##### `tests::parse_theme_name_is_exhaustive`  (lines 1506–1566)

```
fn parse_theme_name_is_exhaustive()
```

**Purpose**: Guards against upstream bundled-theme additions by asserting that every embedded two_face theme variant is reachable through the local kebab-case mapping.

**Data flow**: It queries `EmbeddedLazyThemeSet::theme_names()`, asserts the expected count, maps the local kebab-case list through `parse_theme_name`, and asserts that every upstream variant appears in the mapped set.

**Call relations**: This test protects the maintenance contract around `parse_theme_name` and the bundled theme inventory.

*Call graph*: 3 external calls (theme_names, assert!, assert_eq!).


### `tui/src/markdown_render.rs`

`domain_logic` · `rendering and transcript layout`

This is the main rendering engine behind the TUI transcript. Public entry points build a `pulldown-cmark` parser with strikethrough and table support, wrap it in `DecodedTextMerge` so adjacent decoded text events stay contiguous, and feed the stream into a stateful `Writer`. The writer maintains inline style stack, list numbering, indentation contexts, blockquote state, code-block buffering, optional current link metadata, current line assembly, and an optional `TableState` while inside `Tag::Table`.

Normal text flow is event-driven: `handle_event` dispatches to tag open/close handlers and content handlers, while `flush_current_line` performs width-aware wrapping with preserved hyperlink column remapping. Lists and blockquotes are represented as `IndentContext` entries so prefixes and markers can be reconstructed precisely for first and continuation lines. Fenced code blocks with a recognized language are buffered verbatim and syntax-highlighted only at close; unknown or untyped code stays plain and unwrapped.

Links are split into two policies: web links render label plus visible ` (destination)` suffix and carry hyperlink annotations; local file links suppress the markdown label entirely and instead render a normalized target path, optionally shortened relative to a provided cwd and augmented with normalized `:line[:col]` or hash-anchor ranges. Soft breaks immediately after such local-link targets are specially delayed so a following `: description` stays on the same visible line.

Table rendering is a substantial subsystem. `TableState` accumulates rich `TableCell`s with inline spans and hyperlinks. On close, rows are normalized to the declared column count, parser spillover rows are heuristically extracted, per-column metrics classify columns as `Narrative`, `TokenHeavy`, or `Compact`, and widths are allocated by iterative shrinking with kind-specific floors. If the grid cannot fit readably, the renderer falls back either to raw pipe output (header-only case) or to vertical key/value records via `table_key_value`. Otherwise it emits themed header/body separators and wrapped aligned rows while preserving hyperlink ranges across wrapped cell fragments.

#### Function details

##### `MarkdownStyles::default`  (lines 105–122)

```
fn default() -> Self
```

**Purpose**: Defines the default visual style palette used by the markdown renderer for headings, emphasis, code, links, list markers, and blockquotes.

**Data flow**: It takes no inputs and returns a `MarkdownStyles` struct populated with concrete `ratatui::style::Style` values: bold/underlined H1, bold H2, bold+italic H3, italic H4-H6, cyan code, italic emphasis, bold strong, crossed-out strikethrough, light-blue ordered markers, cyan-underlined links, and green blockquotes.

**Call relations**: Used during `Writer::new` to seed the renderer’s style table. All later style application in the writer references these prebuilt fields.

*Call graph*: called by 1 (new); 1 external calls (new).


##### `IndentContext::new`  (lines 133–139)

```
fn new(prefix: Vec<Span<'static>>, marker: Option<Vec<Span<'static>>>, is_list: bool) -> Self
```

**Purpose**: Constructs one indentation/frame entry describing a blockquote or list nesting level.

**Data flow**: It takes a prefix span vector, an optional marker span vector, and an `is_list` flag, and returns an `IndentContext` storing those values unchanged.

**Call relations**: Called when entering blockquotes, code blocks, and list items so `Writer::prefix_spans` can later reconstruct visible prefixes for first and continuation lines.

*Call graph*: called by 3 (start_blockquote, start_codeblock, start_item).


##### `TableCell::ensure_line`  (lines 155–159)

```
fn ensure_line(&mut self)
```

**Purpose**: Guarantees that a table cell has at least one logical line buffer before content is appended.

**Data flow**: It mutably inspects `self.lines`; if empty, it pushes a new blank `HyperlinkLine(Line::default())`. It returns no value.

**Call relations**: Used internally by `TableCell::push_span` and `TableCell::push_annotated` so cell content appends always have a destination line.

*Call graph*: calls 1 internal fn (new); called by 2 (push_annotated, push_span); 1 external calls (default).


##### `TableCell::push_span`  (lines 162–167)

```
fn push_span(&mut self, span: Span<'static>)
```

**Purpose**: Appends a styled span to the current logical line of a table cell.

**Data flow**: It takes a `Span<'static>`, ensures a line exists, then pushes the span into the last line’s `Line` spans. It mutates the cell in place and returns nothing.

**Call relations**: Used while parsing table-cell text/code/html content into the active `TableCell`.

*Call graph*: calls 1 internal fn (ensure_line).


##### `TableCell::push_annotated`  (lines 169–180)

```
fn push_annotated(&mut self, mut appended: HyperlinkLine)
```

**Purpose**: Appends a hyperlink-aware rendered fragment to the current table-cell line while shifting hyperlink column ranges to their new positions.

**Data flow**: It takes a mutable `HyperlinkLine`, ensures the cell has a current line, computes the existing line width as a shift, appends the incoming spans, and extends hyperlink metadata after offsetting each link’s `columns` range by that shift.

**Call relations**: Used by table-cell text/link rendering paths when content already carries hyperlink annotations and must be merged into the active cell.

*Call graph*: calls 1 internal fn (ensure_line).


##### `TableCell::hard_break`  (lines 183–185)

```
fn hard_break(&mut self)
```

**Purpose**: Starts a new logical line inside a table cell, preserving hard-break semantics within cell content.

**Data flow**: It pushes a fresh blank `HyperlinkLine` onto `self.lines` and returns nothing.

**Call relations**: Called when table-cell content contains hard breaks or multiline HTML/text segments.

*Call graph*: calls 1 internal fn (new); 1 external calls (default).


##### `TableCell::plain_text`  (lines 187–199)

```
fn plain_text(&self) -> String
```

**Purpose**: Projects a rich table cell into plain text for width measurement and heuristics.

**Data flow**: It iterates over each logical line and each span within that line, concatenating span contents into a `String` and inserting a single space between logical lines. It returns the resulting plain-text string without style or hyperlink metadata.

**Call relations**: Used by table layout and key/value fallback code to measure widths, classify columns, and render plain-text labels.

*Call graph*: called by 2 (render_aligned_field, render_stacked_field); 2 external calls (new, write!).


##### `TableState::new`  (lines 226–236)

```
fn new(alignments: Vec<Alignment>) -> Self
```

**Purpose**: Initializes table-parsing state when a markdown table starts.

**Data flow**: It takes the parser-provided alignment vector and returns a `TableState` with empty header/rows/current row/current cell, `current_row_has_table_pipe_syntax` false, and `in_header` false.

**Call relations**: Created by `Writer::start_table` and then mutated by subsequent table head/row/cell handlers until `Writer::end_table` consumes it.

*Call graph*: called by 1 (start_table); 1 external calls (new).


##### `render_markdown_text`  (lines 287–289)

```
fn render_markdown_text(input: &str) -> Text<'static>
```

**Purpose**: Convenience entry point that renders markdown without an explicit width constraint.

**Data flow**: It takes an input string and forwards it to `render_markdown_text_with_width` with `None`, returning the resulting `Text<'static>`.

**Call relations**: Used by many tests and callers that want intrinsic-width rendering. It is a thin wrapper over the width-aware entry point.

*Call graph*: calls 1 internal fn (render_markdown_text_with_width); called by 72 (vt100_deep_nested_mixed_list_third_level_marker_is_colored, crlf_code_block_no_extra_blank_lines, fenced_code_info_string_with_metadata_highlights, blockquote_heading_inherits_heading_style, blockquote_in_ordered_list_on_next_line, blockquote_in_unordered_list_on_next_line, blockquote_inside_nested_list, blockquote_list_then_nested_blockquote, blockquote_multiple_with_break, blockquote_nested_two_levels (+15 more)).


##### `render_markdown_text_with_width`  (lines 298–301)

```
fn render_markdown_text_with_width(input: &str, width: Option<usize>) -> Text<'static>
```

**Purpose**: Renders markdown with an optional terminal width, using the process current directory for local-link shortening.

**Data flow**: It takes input markdown and an optional width, reads `std::env::current_dir().ok()`, and forwards input, width, and the cwd reference to `render_markdown_text_with_width_and_cwd`, returning the resulting `Text<'static>`.

**Call relations**: Called by the no-width wrapper and many tests. It exists to supply a default cwd when callers do not have a session-specific one.

*Call graph*: calls 1 internal fn (render_markdown_text_with_width_and_cwd); called by 20 (render_markdown_text, does_not_split_long_url_like_token_without_scheme, does_not_wrap_code_blocks, wraps_blockquotes, wraps_blockquotes_inside_lists, wraps_list_items_containing_blockquotes, wraps_list_items_preserving_indent, wraps_nested_lists, wraps_ordered_lists, wraps_plain_text_when_width_provided (+10 more)); 1 external calls (current_dir).


##### `render_markdown_text_with_width_and_cwd`  (lines 308–316)

```
fn render_markdown_text_with_width_and_cwd(
    input: &str,
    width: Option<usize>,
    cwd: Option<&Path>,
) -> Text<'static>
```

**Purpose**: Renders markdown into plain visible ratatui text while honoring both width and an explicit cwd for local file-link display.

**Data flow**: It takes input markdown, optional width, and optional cwd, calls `render_markdown_lines_with_width_and_cwd` to get hyperlink-aware lines, strips them to visible `Line`s with `visible_lines`, wraps them in `Text::from`, and returns the `Text<'static>`.

**Call relations**: This is the main public text-returning entry point used by higher-level helpers in `markdown.rs` and by tests that need cwd-stable local-link rendering.

*Call graph*: calls 2 internal fn (render_markdown_lines_with_width_and_cwd, visible_lines); called by 8 (append_markdown, append_markdown_agent, render_markdown_text_with_width, consecutive_unordered_list_local_file_links_do_not_detach_paths, render_markdown_text_for_cwd, table_wraps_file_paths_before_collapsing_narrative_columns_snapshot, unordered_list_local_file_link_soft_break_before_colon_stays_inline, unordered_list_local_file_link_stays_inline_with_following_text); 1 external calls (from).


##### `render_markdown_lines_with_width_and_cwd`  (lines 318–330)

```
fn render_markdown_lines_with_width_and_cwd(
    input: &str,
    width: Option<usize>,
    cwd: Option<&Path>,
) -> Vec<HyperlinkLine>
```

**Purpose**: Runs the full markdown parser and writer pipeline and returns hyperlink-aware rendered lines.

**Data flow**: It takes input markdown, optional width, and optional cwd; enables pulldown-cmark strikethrough and tables; builds a parser with offsets; wraps it in `DecodedTextMerge`; constructs a `Writer`; runs it; and returns `w.text` as `Vec<HyperlinkLine>`.

**Call relations**: This is the lowest public rendering entry point in the file. It feeds all richer rendering consumers, including agent-link rendering and hyperlink annotation tests.

*Call graph*: calls 2 internal fn (new, new); called by 10 (render_markdown_agent_with_links_and_cwd, render_markdown_text_with_width_and_cwd, annotates_explicit_web_link_label_and_visible_destination, does_not_annotate_code_or_non_web_markdown_links, key_value_table_keeps_web_annotations, pipe_table_fallback_keeps_web_annotations, wrapped_table_url_fragments_keep_complete_web_destination, bare_url_with_tilde_keeps_complete_hyperlink, merged_text_events_preserve_entity_decoding, table_url_with_tilde_keeps_complete_hyperlink); 2 external calls (empty, new_ext).


##### `should_render_link_destination`  (lines 343–345)

```
fn should_render_link_destination(dest_url: &str) -> bool
```

**Purpose**: Decides whether a markdown link should visibly show its destination after the label.

**Data flow**: It takes a destination URL string and returns `true` for non-local links and `false` for local path-like links by negating `is_local_path_like_link`.

**Call relations**: Used by `Writer::push_link` to choose between web-link suffix rendering and local-file-link target substitution.

*Call graph*: calls 1 internal fn (is_local_path_like_link); called by 1 (push_link).


##### `Writer::new`  (lines 404–433)

```
fn new(input: &'a str, iter: I, wrap_width: Option<usize>, cwd: Option<&Path>) -> Self
```

**Purpose**: Constructs a fresh markdown event consumer with empty rendering state and optional wrapping/cwd configuration.

**Data flow**: It takes the original input string, an event iterator, optional wrap width, and optional cwd. It initializes empty output, default styles, empty inline/list/indent/link/table state, blank current-line buffers, stores `wrap_width`, and clones `cwd` into an owned `PathBuf` when present.

**Call relations**: Created only by `render_markdown_lines_with_width_and_cwd`, after which `Writer::run` drives the full parse/render lifecycle.

*Call graph*: calls 1 internal fn (default); called by 1 (render_markdown_lines_with_width_and_cwd); 3 external calls (new, default, new).


##### `Writer::run`  (lines 435–440)

```
fn run(&mut self)
```

**Purpose**: Consumes the entire parser event stream and finalizes any partially assembled line.

**Data flow**: It repeatedly pulls `(Event, Range)` pairs from `self.iter`, passes each to `handle_event`, and after iteration ends calls `flush_current_line`. It mutates `self.text` and all writer state in place.

**Call relations**: Top-level driver for the writer; invoked once per render by `render_markdown_lines_with_width_and_cwd`.

*Call graph*: calls 2 internal fn (flush_current_line, handle_event); 1 external calls (next).


##### `Writer::handle_event`  (lines 442–464)

```
fn handle_event(&mut self, event: Event<'a>, range: Range<usize>)
```

**Purpose**: Dispatches one pulldown-cmark event into the appropriate block or inline rendering logic.

**Data flow**: It takes an `Event` and source `Range`, first calls `prepare_for_event`, then matches the event: starts/ends tags, routes text/code/html/breaks, emits horizontal rules as `———` with surrounding blank-line logic, and ignores footnotes/task markers. It mutates current line/output/table/link/list state accordingly.

**Call relations**: Called from `run` for every parser event. It is the central dispatcher into `start_tag`, `end_tag`, and content handlers.

*Call graph*: calls 11 internal fn (code, end_tag, flush_current_line, hard_break, html, prepare_for_event, push_blank_line, push_line, soft_break, start_tag (+1 more)); called by 1 (run); 1 external calls (from).


##### `Writer::prepare_for_event`  (lines 466–481)

```
fn prepare_for_event(&mut self, event: &Event<'a>)
```

**Purpose**: Resolves a deferred soft break after a local file-link target before the next event is processed.

**Data flow**: It reads `pending_local_link_soft_break`; if false it does nothing. If true and the next event is text beginning with `:`, it clears the pending flag and keeps content inline. Otherwise it clears the flag and inserts a blank current line via `push_line(Line::default())`.

**Call relations**: Always called at the start of `handle_event`. It exists specifically to support list items like `- [file](...)` followed by `: description` on the next markdown line.

*Call graph*: calls 1 internal fn (push_line); called by 1 (handle_event); 2 external calls (default, matches!).


##### `Writer::start_tag`  (lines 483–514)

```
fn start_tag(&mut self, tag: Tag<'a>, range: Range<usize>)
```

**Purpose**: Handles opening markdown tags by updating writer state or entering specialized rendering modes.

**Data flow**: It takes a `Tag` and source range, then matches paragraphs, headings, blockquotes, code blocks, lists/items, emphasis/strong/strikethrough, links, and tables. Depending on the tag it pushes styles, starts structural contexts, records code-block language/indent, or initializes table parsing state.

**Call relations**: Called from `handle_event` for every `Event::Start`. It delegates to the corresponding `start_*` helpers and to `push_inline_style`/`push_link`.

*Call graph*: calls 12 internal fn (push_inline_style, push_link, start_blockquote, start_codeblock, start_heading, start_item, start_list, start_paragraph, start_table, start_table_cell (+2 more)); called by 1 (handle_event); 1 external calls (from).


##### `Writer::end_tag`  (lines 516–545)

```
fn end_tag(&mut self, tag: TagEnd)
```

**Purpose**: Handles closing markdown tags by flushing or unwinding the corresponding rendering state.

**Data flow**: It takes a `TagEnd`, matches the closing construct, and calls the relevant `end_*` helper. For list items it also flushes the current line, checks whether the item rendered across multiple visible lines to decide whether the next sibling needs a blank separator, pops the indent stack, and clears `pending_marker_line`.

**Call relations**: Called from `handle_event` for every `Event::End`. It is the symmetric counterpart to `start_tag`.

*Call graph*: calls 12 internal fn (end_blockquote, end_codeblock, end_heading, end_list, end_paragraph, end_table, end_table_cell, end_table_head, end_table_row, flush_current_line (+2 more)); called by 1 (handle_event).


##### `Writer::start_paragraph`  (lines 547–557)

```
fn start_paragraph(&mut self)
```

**Purpose**: Begins a paragraph outside tables, inserting a separating blank line when required.

**Data flow**: If currently inside a table cell it returns immediately. Otherwise, when `needs_newline` is set it emits a blank line, then starts a fresh current line, clears `needs_newline`, and marks `in_paragraph = true`.

**Call relations**: Invoked by `start_tag` on `Tag::Paragraph`.

*Call graph*: calls 3 internal fn (in_table_cell, push_blank_line, push_line); called by 1 (start_tag); 1 external calls (default).


##### `Writer::end_paragraph`  (lines 559–566)

```
fn end_paragraph(&mut self)
```

**Purpose**: Marks the end of a paragraph and requests separation before the next block.

**Data flow**: Outside table cells, it sets `needs_newline = true`, clears `in_paragraph`, and clears `pending_marker_line`.

**Call relations**: Invoked by `end_tag` on `TagEnd::Paragraph`.

*Call graph*: calls 1 internal fn (in_table_cell); called by 1 (end_tag).


##### `Writer::start_heading`  (lines 568–588)

```
fn start_heading(&mut self, level: HeadingLevel)
```

**Purpose**: Starts a heading line with the appropriate heading marker text and heading style.

**Data flow**: Outside table cells, it inserts a blank separator if `needs_newline` is set, selects the style for the given `HeadingLevel`, creates a line containing `#`, `##`, etc. plus a trailing space, pushes that line, pushes the heading style onto the inline-style stack, and clears `needs_newline`.

**Call relations**: Called by `start_tag` for heading tags. The matching `end_heading` later pops the heading style.

*Call graph*: calls 3 internal fn (in_table_cell, push_inline_style, push_line); called by 1 (start_tag); 4 external calls (default, from, format!, vec!).


##### `Writer::end_heading`  (lines 590–596)

```
fn end_heading(&mut self)
```

**Purpose**: Closes a heading block and restores the previous inline style context.

**Data flow**: Outside table cells, it sets `needs_newline = true` and pops the top inline style.

**Call relations**: Called by `end_tag` for heading ends after heading text has been emitted through normal text events.

*Call graph*: calls 2 internal fn (in_table_cell, pop_inline_style); called by 1 (end_tag).


##### `Writer::start_blockquote`  (lines 598–611)

```
fn start_blockquote(&mut self)
```

**Purpose**: Enters blockquote context so subsequent lines receive a `> ` prefix and blockquote styling.

**Data flow**: Outside table cells, it emits a blank separator if needed, then pushes an `IndentContext` whose prefix is `"> "`, with no marker and `is_list = false`.

**Call relations**: Called by `start_tag` on `Tag::BlockQuote`; later unwound by `end_blockquote`.

*Call graph*: calls 3 internal fn (new, in_table_cell, push_blank_line); called by 1 (start_tag); 1 external calls (vec!).


##### `Writer::end_blockquote`  (lines 613–619)

```
fn end_blockquote(&mut self)
```

**Purpose**: Leaves the current blockquote nesting level and requests a separating newline before the next block.

**Data flow**: Outside table cells, it pops one indent context and sets `needs_newline = true`.

**Call relations**: Called by `end_tag` on `TagEnd::BlockQuote`.

*Call graph*: calls 1 internal fn (in_table_cell); called by 1 (end_tag).


##### `Writer::text`  (lines 621–673)

```
fn text(&mut self, text: CowStr<'a>)
```

**Purpose**: Processes decoded text content, routing it either into table cells, code-block buffers, or normal wrapped line assembly.

**Data flow**: It takes a `CowStr` text event. If a local-file-link label is being suppressed, it returns. In table cells it forwards to `push_text_to_table_cell`. In fenced code blocks with a known language it appends verbatim to `code_block_buffer`. Otherwise it handles pending marker lines, inserts blank current lines when `needs_newline` or multiline text requires them, applies the current inline style, and pushes each logical line through `push_text_spans`.

**Call relations**: Called by `handle_event` for `Event::Text`. It is one of the main content paths and interacts with link suppression, code buffering, and table-cell accumulation.

*Call graph*: calls 5 internal fn (in_table_cell, push_line, push_text_spans, push_text_to_table_cell, suppressing_local_link_label); called by 1 (handle_event); 2 external calls (lines, default).


##### `Writer::code`  (lines 675–691)

```
fn code(&mut self, code: CowStr<'a>)
```

**Purpose**: Renders inline code spans with code styling, either into the current line or the active table cell.

**Data flow**: It takes a code `CowStr`, returns early when suppressing a local-link label, resets local-link end tracking, and either pushes a styled code span into the current table cell or into the current output line, creating a line first if a list marker is pending.

**Call relations**: Called by `handle_event` for `Event::Code`. It complements `text` for inline code content.

*Call graph*: calls 5 internal fn (in_table_cell, push_line, push_span, push_span_to_table_cell, suppressing_local_link_label); called by 1 (handle_event); 3 external calls (into_string, default, from).


##### `Writer::html`  (lines 693–724)

```
fn html(&mut self, html: CowStr<'a>, inline: bool)
```

**Purpose**: Emits inline or block HTML verbatim, preserving line breaks and current inline style where applicable.

**Data flow**: It takes HTML text and an `inline` flag. If suppressing a local-link label it returns. In table cells it splits HTML on lines, inserts hard breaks between lines, appends styled spans, and adds a trailing hard break for block HTML. Outside tables it similarly emits each line into the current output, inserting new lines as needed, and sets `needs_newline` to `!inline`.

**Call relations**: Called by `handle_event` for both `Event::Html` and `Event::InlineHtml`.

*Call graph*: calls 6 internal fn (in_table_cell, push_line, push_span, push_span_to_table_cell, push_table_cell_hard_break, suppressing_local_link_label); called by 1 (handle_event); 3 external calls (lines, default, styled).


##### `Writer::hard_break`  (lines 726–736)

```
fn hard_break(&mut self)
```

**Purpose**: Handles markdown hard breaks by starting a new visible line or a new logical line inside a table cell.

**Data flow**: It returns early when suppressing a local-link label, clears local-link end tracking, and either calls `push_table_cell_hard_break` or starts a new blank current line with `push_line(Line::default())`.

**Call relations**: Called by `handle_event` for `Event::HardBreak`.

*Call graph*: calls 4 internal fn (in_table_cell, push_line, push_table_cell_hard_break, suppressing_local_link_label); called by 1 (handle_event); 1 external calls (default).


##### `Writer::soft_break`  (lines 738–754)

```
fn soft_break(&mut self)
```

**Purpose**: Handles markdown soft breaks, usually as visible line breaks, with special treatment for table cells and local file-link suffixes.

**Data flow**: It returns early when suppressing a local-link label. In table cells it inserts a styled space into the current cell. If the current line just ended with a rendered local-link target, it sets `pending_local_link_soft_break` instead of breaking immediately. Otherwise it clears local-link tracking and starts a new blank current line.

**Call relations**: Called by `handle_event` for `Event::SoftBreak`; its deferred-break behavior is completed by `prepare_for_event`.

*Call graph*: calls 4 internal fn (in_table_cell, push_line, push_span_to_table_cell, suppressing_local_link_label); called by 1 (handle_event); 2 external calls (default, styled).


##### `Writer::start_list`  (lines 756–762)

```
fn start_list(&mut self, index: Option<u64>)
```

**Purpose**: Begins a list nesting level and initializes numbering/blank-line bookkeeping for its items.

**Data flow**: It takes an optional starting index. If this is the outermost list and `needs_newline` is set, it starts a blank line. It then pushes the starting index onto `list_indices` and `false` onto `list_needs_blank_before_next_item`.

**Call relations**: Called by `start_tag` for `Tag::List`; item-specific indentation is handled later by `start_item`.

*Call graph*: calls 1 internal fn (push_line); called by 1 (start_tag); 1 external calls (default).


##### `Writer::end_list`  (lines 764–768)

```
fn end_list(&mut self)
```

**Purpose**: Closes the current list nesting level and marks that following content should start after a newline.

**Data flow**: It pops one entry from `list_indices` and `list_needs_blank_before_next_item`, then sets `needs_newline = true`.

**Call relations**: Called by `end_tag` for `TagEnd::List`.

*Call graph*: called by 1 (end_tag).


##### `Writer::start_item`  (lines 770–818)

```
fn start_item(&mut self)
```

**Purpose**: Starts a list item, computes its visible marker and continuation indent, and records whether later sibling items need blank separation.

**Data flow**: It consumes any pending blank-before-next-item flag, flushing a blank line if needed; flushes the current line; records the current output line count; sets `pending_marker_line = true`; computes nesting depth, ordered/unordered marker text, marker style, and continuation indent width; pushes a corresponding `IndentContext`; and clears `needs_newline`.

**Call relations**: Called by `start_tag` for `Tag::Item`. Its marker/indent state is later consumed by `prefix_spans`, and `end_tag` for `TagEnd::Item` uses the recorded start line count to decide sibling spacing.

*Call graph*: calls 3 internal fn (new, flush_current_line, push_blank_line); called by 1 (start_tag); 2 external calls (new, vec!).


##### `Writer::start_codeblock`  (lines 820–845)

```
fn start_codeblock(&mut self, lang: Option<String>, indent: Option<Span<'static>>)
```

**Purpose**: Enters code-block mode, preserving indentation context and optionally preparing for syntax highlighting.

**Data flow**: It flushes the current line, inserts a blank separator if output already exists, sets `in_code_block = true`, extracts the first language token from the info string by splitting on commas/spaces/tabs, stores it in `code_block_lang`, clears `code_block_buffer`, pushes an indent context containing either four spaces for indented code or an empty prefix for fenced code, and sets `needs_newline = true`.

**Call relations**: Called by `start_tag` for `Tag::CodeBlock`; `end_codeblock` later emits buffered highlighted lines if a known language was present.

*Call graph*: calls 3 internal fn (new, flush_current_line, push_blank_line); called by 1 (start_tag); 1 external calls (vec!).


##### `Writer::end_codeblock`  (lines 847–865)

```
fn end_codeblock(&mut self)
```

**Purpose**: Closes code-block mode and emits syntax-highlighted lines when a known language was buffered.

**Data flow**: If `code_block_lang` is set, it takes the buffered code string, highlights it with `highlight_code_to_lines`, and for each highlighted line starts a new output line and pushes its spans. It then sets `needs_newline = true`, clears `in_code_block`, and pops the code-block indent context.

**Call relations**: Called by `end_tag` for `TagEnd::CodeBlock`. It is the only place where buffered fenced code is turned into visible output.

*Call graph*: calls 3 internal fn (push_line, push_span, highlight_code_to_lines); called by 1 (end_tag); 2 external calls (default, take).


##### `Writer::start_table`  (lines 867–874)

```
fn start_table(&mut self, alignments: Vec<Alignment>)
```

**Purpose**: Begins table parsing after flushing any current paragraph/list line and inserting required separation.

**Data flow**: It flushes the current line, emits a blank line if `needs_newline` was set, clears that flag, and stores a fresh `TableState::new(alignments)` in `self.table_state`.

**Call relations**: Called by `start_tag` for `Tag::Table`; subsequent table head/row/cell handlers mutate the stored state until `end_table` consumes it.

*Call graph*: calls 3 internal fn (new, flush_current_line, push_blank_line); called by 1 (start_tag).


##### `Writer::end_table`  (lines 876–902)

```
fn end_table(&mut self)
```

**Purpose**: Finalizes the accumulated table, renders it in grid or record form, appends any spillover prose rows, and restores normal block flow.

**Data flow**: It takes the current `TableState`, passes it to `render_table_lines`, then emits each returned table line either through `push_prewrapped_line` (for pre-laid-out grid/record output) or `push_hyperlink_line` plus `flush_current_line` (for pipe fallback). It then emits spillover lines as normal hyperlink lines, clears `pending_marker_line`, and sets `needs_newline = true`.

**Call relations**: Called by `end_tag` for `TagEnd::Table`. It is the bridge from parsed table structure to final visible output.

*Call graph*: calls 4 internal fn (flush_current_line, push_hyperlink_line, push_prewrapped_line, render_table_lines); called by 1 (end_tag).


##### `Writer::start_table_head`  (lines 904–909)

```
fn start_table_head(&mut self)
```

**Purpose**: Marks that subsequent table rows belong to the header section and initializes the current row buffer.

**Data flow**: If a table is active, it sets `in_header = true` and initializes `current_row` to an empty vector.

**Call relations**: Called by `start_tag` for `Tag::TableHead`.

*Call graph*: called by 1 (start_tag); 1 external calls (new).


##### `Writer::end_table_head`  (lines 911–925)

```
fn end_table_head(&mut self)
```

**Purpose**: Flushes any partially accumulated header cell/row into the table header and exits header mode.

**Data flow**: It moves any `current_cell` into `current_row`, moves `current_row` into `header` if present, and sets `in_header = false`.

**Call relations**: Called by `end_tag` for `TagEnd::TableHead`.

*Call graph*: called by 1 (end_tag).


##### `Writer::start_table_row`  (lines 927–933)

```
fn start_table_row(&mut self, source_range: Range<usize>)
```

**Purpose**: Starts a new table row and records whether the source row visibly used boundary pipes.

**Data flow**: It computes `has_table_pipe_syntax` by slicing the original source range and checking whether the trimmed row starts or ends with `|`, then initializes `current_row` and stores that boolean in `current_row_has_table_pipe_syntax`.

**Call relations**: Called by `start_tag` for `Tag::TableRow`; the pipe-syntax flag later feeds spillover-row heuristics.

*Call graph*: calls 1 internal fn (has_table_row_boundary_pipe); called by 1 (start_tag); 1 external calls (new).


##### `Writer::has_table_row_boundary_pipe`  (lines 935–941)

```
fn has_table_row_boundary_pipe(&self, source_range: Range<usize>) -> bool
```

**Purpose**: Checks whether the original markdown source for a table row had a leading or trailing pipe character.

**Data flow**: It takes a source byte range, slices `self.input` if possible, trims it, and returns true when the trimmed text starts with `|` or ends with `|`.

**Call relations**: Used only by `start_table_row` to preserve source-shape information for spillover detection.

*Call graph*: called by 1 (start_table_row).


##### `Writer::end_table_row`  (lines 943–968)

```
fn end_table_row(&mut self)
```

**Purpose**: Flushes the current cell into the current row and then stores the row into either the header or body collection.

**Data flow**: It moves any active `current_cell` into `current_row`, takes the row, and either stores it as `header` when `in_header` is true or pushes a `TableBodyRow { cells, has_table_pipe_syntax }` into `rows`. It then resets `current_row_has_table_pipe_syntax`.

**Call relations**: Called by `end_tag` for `TagEnd::TableRow`.

*Call graph*: called by 1 (end_tag).


##### `Writer::start_table_cell`  (lines 970–974)

```
fn start_table_cell(&mut self)
```

**Purpose**: Begins accumulation of one table cell.

**Data flow**: If a table is active, it sets `current_cell = Some(TableCell::default())`.

**Call relations**: Called by `start_tag` for `Tag::TableCell`; later content events append into this cell until `end_table_cell`.

*Call graph*: called by 1 (start_tag); 1 external calls (default).


##### `Writer::end_table_cell`  (lines 976–987)

```
fn end_table_cell(&mut self)
```

**Purpose**: Flushes the active table cell into the current row.

**Data flow**: If a table is active and `current_cell` exists, it takes that cell and pushes it into `current_row`, creating the row vector if necessary.

**Call relations**: Called by `end_tag` for `TagEnd::TableCell`.

*Call graph*: called by 1 (end_tag).


##### `Writer::in_table_cell`  (lines 989–994)

```
fn in_table_cell(&self) -> bool
```

**Purpose**: Reports whether the writer is currently accumulating content inside a table cell.

**Data flow**: It inspects `self.table_state.current_cell` and returns a boolean.

**Call relations**: Queried by many content and block handlers to switch between normal line rendering and table-cell accumulation.

*Call graph*: called by 12 (code, end_blockquote, end_heading, end_paragraph, hard_break, html, pop_link, soft_break, start_blockquote, start_heading (+2 more)).


##### `Writer::push_span_to_table_cell`  (lines 996–1002)

```
fn push_span_to_table_cell(&mut self, span: Span<'static>)
```

**Purpose**: Appends a span directly into the active table cell if one exists.

**Data flow**: It takes a `Span<'static>`, finds `self.table_state.current_cell`, and calls `cell.push_span(span)` when present.

**Call relations**: Used by inline code, HTML, local-link rendering, and soft-break handling inside tables.

*Call graph*: called by 4 (code, html, pop_link, soft_break).


##### `Writer::push_table_cell_hard_break`  (lines 1004–1010)

```
fn push_table_cell_hard_break(&mut self)
```

**Purpose**: Starts a new logical line inside the active table cell.

**Data flow**: It finds the active `current_cell` and calls `cell.hard_break()` if present.

**Call relations**: Used by hard-break and multiline text/HTML handling inside tables.

*Call graph*: called by 3 (hard_break, html, push_text_to_table_cell).


##### `Writer::push_text_to_table_cell`  (lines 1012–1020)

```
fn push_text_to_table_cell(&mut self, text: &str)
```

**Purpose**: Splits plain text on line boundaries and appends it into the active table cell with current inline styling.

**Data flow**: It takes a text slice, reads the current inline style, splits the text on `.lines()`, inserts table-cell hard breaks between logical lines, and forwards each line to `push_text_spans_to_table_cell`.

**Call relations**: Called by `text` when the writer is inside a table cell.

*Call graph*: calls 2 internal fn (push_table_cell_hard_break, push_text_spans_to_table_cell); called by 1 (text).


##### `Writer::push_text_spans_to_table_cell`  (lines 1022–1042)

```
fn push_text_spans_to_table_cell(&mut self, text: &str, style: Style)
```

**Purpose**: Converts one text fragment into a hyperlink-aware table-cell line fragment and appends it to the active cell.

**Data flow**: It takes plain text and a style, builds a styled span, determines whether the current link is a web destination, and then either wraps the span in a `HyperlinkLine` with explicit destination, leaves it plain when inside a markdown link or code block, or auto-annotates bare web URLs. It then merges the annotated fragment into the active cell with hyperlink-column shifting.

**Call relations**: Used only by `push_text_to_table_cell`; it mirrors `push_text_spans` for the table-cell case.

*Call graph*: calls 2 internal fn (new, annotate_web_urls_in_line); called by 1 (push_text_to_table_cell); 4 external calls (default, from, styled, take).


##### `Writer::render_table_lines`  (lines 1055–1177)

```
fn render_table_lines(&self, mut table_state: TableState) -> RenderedTableLines
```

**Purpose**: Transforms a completed `TableState` into final rendered table output, choosing among aligned grid, key/value records, or raw pipe fallback.

**Data flow**: It takes ownership of a `TableState`, derives `column_count`, extracts spillover rows using `is_spillover_row`, normalizes header/body row lengths, computes column metrics and available widths, asks `compute_column_widths` for a grid allocation, and then either: returns empty output for zero columns; renders key/value records via `table_key_value::render_records` when widths are impossible or readability heuristics demand it; renders raw pipe lines for header-only fallback; or renders aligned rows plus themed separators with `render_table_row` and `render_table_separator`. It also flattens spillover rows into plain `spillover_lines`.

**Call relations**: Called only by `end_table`. It is the central table-layout decision point and delegates to many helper methods plus the `table_key_value` submodule.

*Call graph*: calls 9 internal fn (available_record_width, available_table_width, compute_column_widths, render_table_pipe_fallback, render_table_row, render_records, should_render_records, foreground_style_for_scopes, table_separator_style); called by 1 (end_table); 7 external calls (collect_table_column_metrics, is_spillover_row, normalize_row, render_table_separator, default, new, with_capacity).


##### `Writer::normalize_row`  (lines 1179–1182)

```
fn normalize_row(row: &mut Vec<TableCell>, column_count: usize)
```

**Purpose**: Forces a row to exactly match the declared table column count.

**Data flow**: It truncates the mutable row vector to `column_count` and then resizes it with default `TableCell`s until it reaches that length.

**Call relations**: Used by `render_table_lines` on both header and body rows before width computation.

*Call graph*: 1 external calls (default).


##### `Writer::available_table_width`  (lines 1185–1194)

```
fn available_table_width(&self, column_count: usize) -> Option<usize>
```

**Purpose**: Computes the content-width budget available for table columns after subtracting current indent, gutters, and cell padding.

**Data flow**: It reads `self.wrap_width`; when present, it computes the visible prefix width from `prefix_spans(self.pending_marker_line)`, subtracts inter-column gaps and per-cell padding, and returns the remaining width as `Option<usize>`.

**Call relations**: Used by `render_table_lines` before column-width allocation.

*Call graph*: called by 1 (render_table_lines).


##### `Writer::available_record_width`  (lines 1197–1203)

```
fn available_record_width(&self) -> Option<usize>
```

**Purpose**: Computes the width budget available for key/value record fallback rendering.

**Data flow**: It reads `self.wrap_width`; when present, it subtracts only the current visible prefix width from the wrap width and returns the remainder.

**Call relations**: Used by `render_table_lines` when delegating to `table_key_value::render_records`.

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

**Purpose**: Allocates per-column widths for aligned table rendering under an optional width budget, using column-kind-aware shrink priorities and floors.

**Data flow**: It takes header cells, body rows, alignments, and optional available width. It computes metrics, initializes widths to each column’s max content width with a hard minimum of 3, returns them unchanged when no width budget exists, returns `None` when even the minimum total cannot fit, computes preferred floors with `preferred_column_floor`, relaxes those floors if necessary in shrink-priority order, then repeatedly shrinks one column at a time using `next_column_to_shrink` until total width fits or no shrinkable columns remain. It returns `Some(widths)` on success or `None` if fitting still fails.

**Call relations**: Called by `render_table_lines` as the main grid-allocation algorithm.

*Call graph*: called by 1 (render_table_lines); 3 external calls (len, collect_table_column_metrics, next_column_to_shrink).


##### `Writer::collect_table_column_metrics`  (lines 1278–1343)

```
fn collect_table_column_metrics(
        header: &[TableCell],
        rows: &[Vec<TableCell>],
        column_count: usize,
    ) -> Vec<TableColumnMetrics>
```

**Purpose**: Measures each table column’s widest content, longest tokens, and content shape to classify it as narrative, token-heavy, or compact.

**Data flow**: It iterates column-by-column across the header and all body rows, computing max display width, longest header/body token widths, counts of words and long tokens, average words per non-empty body cell, and average cell width. It returns a `Vec<TableColumnMetrics>` whose `kind` is `TokenHeavy` when long tokens dominate, `Narrative` when prose density is high, and `Compact` otherwise.

**Call relations**: Used by both `render_table_lines` and `compute_column_widths`, and indirectly by key/value fallback heuristics.

*Call graph*: 3 external calls (cell_display_width, longest_token_width, with_capacity).


##### `Writer::preferred_column_floor`  (lines 1351–1359)

```
fn preferred_column_floor(metrics: &TableColumnMetrics, min_column_width: usize) -> usize
```

**Purpose**: Computes the soft minimum width a column should try to retain before the shrink loop pushes it lower.

**Data flow**: It takes one `TableColumnMetrics` and a hard minimum width. Narrative and token-heavy columns target 16 cells; compact columns target the max of header token width and body token width capped at 16. The result is clamped between the hard minimum and the column’s max width.

**Call relations**: Used by `compute_column_widths` to initialize shrink floors.


##### `Writer::next_column_to_shrink`  (lines 1366–1383)

```
fn next_column_to_shrink(
        widths: &[usize],
        floors: &[usize],
        metrics: &[TableColumnMetrics],
    ) -> Option<usize>
```

**Purpose**: Chooses which column should lose one character of width next during iterative table fitting.

**Data flow**: It examines current widths, floors, and metrics, filters to columns still above floor, and returns the index with the best `(shrink priority, inverse slack)` ordering: token-heavy first, then narrative, then compact; within a kind, columns with more slack are preferred.

**Call relations**: Called repeatedly by `compute_column_widths` during width reduction.


##### `Writer::column_shrink_priority`  (lines 1385–1391)

```
fn column_shrink_priority(kind: TableColumnKind) -> usize
```

**Purpose**: Maps a `TableColumnKind` to the numeric priority used by width-shrinking decisions.

**Data flow**: It takes a column kind and returns `0` for `TokenHeavy`, `1` for `Narrative`, and `2` for `Compact`.

**Call relations**: Used by both `preferred_column_floor` relaxation and `next_column_to_shrink` ordering.


##### `Writer::render_table_separator`  (lines 1393–1406)

```
fn render_table_separator(
        column_widths: &[usize],
        separator_char: char,
        style: Style,
    ) -> HyperlinkLine
```

**Purpose**: Builds one themed separator line spanning all table columns.

**Data flow**: It takes column widths, a separator character, and a style; repeats the separator character for each column width plus cell padding, joins segments with the configured column gap, wraps the result in a styled `HyperlinkLine`, and returns it.

**Call relations**: Used by `render_table_lines` for both header and body row separators.

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

**Purpose**: Renders one logical table row into one or more visible lines with alignment, wrapping, padding, and hyperlink remapping preserved.

**Data flow**: It wraps each cell to its assigned width with `wrap_cell`, computes the row height as the max wrapped-cell height, and for each visible row line builds spans with left/right padding according to the column alignment. It trims trailing empty columns by finding the last visible column, constructs a `HyperlinkLine` for each output line, and shifts each wrapped cell hyperlink range into its final column position.

**Call relations**: Called by `render_table_lines` for the header and each body row in aligned-grid mode.

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

**Purpose**: Renders a table as raw pipe-delimited markdown lines when aligned grid layout is impossible and there are no body records worth transposing.

**Data flow**: It takes header, rows, and alignments, converts the header and each row with `row_to_pipe_line`, inserts a delimiter line from `alignments_to_pipe_delimiter`, and returns the resulting `Vec<HyperlinkLine>`.

**Call relations**: Used by `render_table_lines` only in the narrow fallback case where width allocation fails but there are no body rows to render as records.

*Call graph*: calls 1 internal fn (new); called by 1 (render_table_lines); 4 external calls (from, alignments_to_pipe_delimiter, row_to_pipe_line, new).


##### `Writer::row_to_pipe_line`  (lines 1515–1562)

```
fn row_to_pipe_line(row: &[TableCell]) -> HyperlinkLine
```

**Purpose**: Converts one rich table row into a single pipe-delimited markdown line while preserving hyperlink destinations and escaping literal pipe characters inside cell content.

**Data flow**: It iterates cells and their logical lines, concatenates visible text, tracks hyperlink destination changes by display column, escapes `|` as `\|`, flushes contiguous text runs into a `HyperlinkLine` with the appropriate destination, and surrounds each cell with `|` separators.

**Call relations**: Used by `render_table_pipe_fallback` for header and body rows.

*Call graph*: calls 1 internal fn (new); 3 external calls (default, new, width).


##### `Writer::alignments_to_pipe_delimiter`  (lines 1564–1578)

```
fn alignments_to_pipe_delimiter(alignments: &[Alignment]) -> String
```

**Purpose**: Builds the markdown delimiter row corresponding to a table’s alignment specification.

**Data flow**: It takes the alignment slice and returns a string like `|:---|:---:|---:|`, choosing the segment form for left, center, right, or none alignment.

**Call relations**: Used by `render_table_pipe_fallback` to emit the delimiter line.

*Call graph*: 1 external calls (new).


##### `Writer::wrap_cell`  (lines 1586–1607)

```
fn wrap_cell(&self, cell: &TableCell, width: usize) -> Vec<HyperlinkLine>
```

**Purpose**: Wraps one table cell’s logical lines to a target width while preserving styles and hyperlink ranges.

**Data flow**: It takes a `TableCell` and width. Empty cells become a single blank `HyperlinkLine`. Otherwise each logical source line is wrapped independently with `word_wrap_line`, converted to static lines, and remapped back to hyperlink-aware fragments with `remap_wrapped_line`. If wrapping yields nothing, a blank line is inserted.

**Call relations**: Used by aligned-grid rendering and by key/value fallback heuristics to estimate cell heights.

*Call graph*: calls 4 internal fn (new, remap_wrapped_line, new, word_wrap_line); 3 external calls (default, new, vec!).


##### `Writer::is_spillover_row`  (lines 1620–1652)

```
fn is_spillover_row(row: &TableBodyRow, next_row: Option<&TableBodyRow>) -> bool
```

**Purpose**: Heuristically detects body rows that are really prose accidentally absorbed into a multi-column table by pulldown-cmark’s lenient parsing.

**Data flow**: It inspects a `TableBodyRow` and optional next row, extracts the first non-empty-only text with `first_non_empty_only_text`, and returns true when the row is a single non-pipe row, looks like HTML content, is an intro label followed by HTML content, or is a trailing HTML-intro label line.

**Call relations**: Used by `render_table_lines` before normal row rendering so spillover prose can be emitted after the table instead of inside the grid.

*Call graph*: 3 external calls (first_non_empty_only_text, looks_like_html_content, looks_like_html_label_line).


##### `Writer::first_non_empty_only_text`  (lines 1654–1663)

```
fn first_non_empty_only_text(row: &[TableCell]) -> Option<String>
```

**Purpose**: Returns the first cell’s plain text only when all remaining cells in the row are empty.

**Data flow**: It reads the first cell’s `plain_text`, rejects empty first cells, checks that every later cell’s plain text trims to empty, and returns `Some(first_text)` or `None`.

**Call relations**: Used by spillover-row heuristics.

*Call graph*: 1 external calls (first).


##### `Writer::looks_like_html_content`  (lines 1665–1686)

```
fn looks_like_html_content(text: &str) -> bool
```

**Purpose**: Detects whether a text string contains HTML-tag-like content.

**Data flow**: It scans the byte string for `<`, optionally skips `/` or `!`, and returns true when an ASCII alphabetic tag start is followed somewhere later by `>`.

**Call relations**: Used by `is_spillover_row` to identify HTML spillover rows.


##### `Writer::looks_like_html_label_line`  (lines 1688–1697)

```
fn looks_like_html_label_line(text: &str) -> bool
```

**Purpose**: Detects label lines such as `HTML block:` that should be treated as spillover when they trail a table.

**Data flow**: It trims the text, requires a trailing `:`, strips it, and returns true when any remaining word equals `html` case-insensitively.

**Call relations**: Used by `is_spillover_row` for trailing-label spillover detection.


##### `Writer::spans_display_width`  (lines 1703–1705)

```
fn spans_display_width(spans: &[Span<'_>]) -> usize
```

**Purpose**: Computes the visible display width of a span slice using Unicode width rules.

**Data flow**: It sums `span.content.width()` across the input slice and returns the total width.

**Call relations**: Used by line/cell width helpers and table width budgeting.

*Call graph*: 1 external calls (iter).


##### `Writer::line_display_width`  (lines 1708–1710)

```
fn line_display_width(line: &Line<'_>) -> usize
```

**Purpose**: Computes the visible display width of a `Line` by summing its spans.

**Data flow**: It forwards the line’s spans to `spans_display_width` and returns the result.

**Call relations**: Used throughout table rendering and hyperlink offset calculations.

*Call graph*: 1 external calls (spans_display_width).


##### `Writer::cell_display_width`  (lines 1713–1719)

```
fn cell_display_width(cell: &TableCell) -> usize
```

**Purpose**: Computes the maximum visible width among a table cell’s logical lines.

**Data flow**: It maps each `HyperlinkLine` in the cell to `line_display_width(&line.line)`, takes the maximum, and returns 0 for empty cells.

**Call relations**: Used by `collect_table_column_metrics`.


##### `Writer::longest_token_width`  (lines 1722–1724)

```
fn longest_token_width(text: &str) -> usize
```

**Purpose**: Finds the display width of the longest whitespace-delimited token in a string.

**Data flow**: It splits the text on whitespace, maps each token to Unicode width, and returns the maximum or 0.

**Call relations**: Used by `collect_table_column_metrics`.


##### `Writer::push_inline_style`  (lines 1726–1730)

```
fn push_inline_style(&mut self, style: Style)
```

**Purpose**: Pushes a new inline style onto the stack after patching it over the current effective style.

**Data flow**: It reads the current top style or default, patches it with the new style, and pushes the merged style onto `inline_styles`.

**Call relations**: Used when entering emphasis, strong, strikethrough, and headings.

*Call graph*: called by 2 (start_heading, start_tag).


##### `Writer::pop_inline_style`  (lines 1732–1734)

```
fn pop_inline_style(&mut self)
```

**Purpose**: Removes the most recent inline style layer.

**Data flow**: It pops one entry from `inline_styles` and returns nothing.

**Call relations**: Used when closing emphasis/strong/strikethrough and headings.

*Call graph*: called by 2 (end_heading, end_tag).


##### `Writer::push_link`  (lines 1736–1747)

```
fn push_link(&mut self, dest_url: String)
```

**Purpose**: Begins link rendering state, deciding whether the link is a visible web destination or a hidden-label local file target.

**Data flow**: It takes a destination string, computes `show_destination` with `should_render_link_destination`, computes `local_target_display` with `render_local_link_target` for local path-like links, and stores a `LinkState` in `self.link`.

**Call relations**: Called by `start_tag` on `Tag::Link`; `pop_link` later emits the visible destination or local target text.

*Call graph*: calls 3 internal fn (is_local_path_like_link, render_local_link_target, should_render_link_destination); called by 1 (start_tag).


##### `Writer::pop_link`  (lines 1749–1799)

```
fn pop_link(&mut self)
```

**Purpose**: Closes the current link and emits either a visible destination suffix for web links or a normalized local target path for local file links.

**Data flow**: It takes the current `LinkState`. For web links with `show_destination = true`, it appends ` (destination)` either into the active table cell or current line, styling the destination as a hyperlink and preserving hyperlink metadata. For local links with `local_target_display`, it emits that target in code-like cyan styling, suppressing the original markdown label and marking that the line ended with a local-link target so a following soft break may be deferred.

**Call relations**: Called by `end_tag` on `TagEnd::Link`. It works in tandem with `push_link`, `suppressing_local_link_label`, and `prepare_for_event`.

*Call graph*: calls 7 internal fn (in_table_cell, push_annotated, push_line, push_span, push_span_to_table_cell, new, web_destination); called by 1 (end_tag); 2 external calls (default, styled).


##### `Writer::suppressing_local_link_label`  (lines 1801–1806)

```
fn suppressing_local_link_label(&self) -> bool
```

**Purpose**: Reports whether the current link is a local file link whose markdown label should be ignored in favor of the rendered target path.

**Data flow**: It inspects `self.link.local_target_display` and returns true when present.

**Call relations**: Checked by `text`, `code`, `html`, `hard_break`, and `soft_break` so local-link labels do not leak into output.

*Call graph*: called by 5 (code, hard_break, html, soft_break, text).


##### `Writer::flush_current_line`  (lines 1808–1841)

```
fn flush_current_line(&mut self)
```

**Purpose**: Finalizes the currently assembled line, applying wrapping and indent prefixes, remapping hyperlinks, and pushing finished output lines.

**Data flow**: If `current_line_content` exists, it reads the current style and code-block flag. For non-code lines with a wrap width, it wraps the line with `adaptive_wrap_line` using stored initial/subsequent indent spans, converts wrapped lines to static form, remaps hyperlinks with `remap_wrapped_line`, and pushes each wrapped output line. Otherwise it prepends the initial indent spans directly, shifts hyperlink ranges by the indent width, and pushes the single line. It then clears current-line buffers and local-link end tracking.

**Call relations**: Called from many structural transitions—event loop end, line starts, blank lines, table emission, code blocks—to ensure partially built lines are committed before state changes.

*Call graph*: calls 4 internal fn (push_output_line, remap_wrapped_line, new, adaptive_wrap_line); called by 10 (end_table, end_tag, handle_event, push_blank_line, push_line, push_prewrapped_line, run, start_codeblock, start_item, start_table); 1 external calls (from_iter).


##### `Writer::is_blockquote_active`  (lines 1850–1854)

```
fn is_blockquote_active(&self) -> bool
```

**Purpose**: Checks whether any active indent context represents a blockquote.

**Data flow**: It scans `indent_stack` for any prefix span containing `>` and returns a boolean.

**Call relations**: Used by `push_line` and `push_prewrapped_line` to patch blockquote styling onto emitted lines.

*Call graph*: called by 2 (push_line, push_prewrapped_line).


##### `Writer::push_prewrapped_line`  (lines 1856–1873)

```
fn push_prewrapped_line(&mut self, mut line: HyperlinkLine, pending_marker_line: bool)
```

**Purpose**: Pushes a line whose layout is already fixed, such as a rendered table row, without subjecting it to normal word wrapping.

**Data flow**: It flushes any current line, computes whether blockquote styling should patch the line style, prepends the current prefix spans for either a pending marker line or normal continuation, shifts hyperlink ranges by the prefix width, and pushes the resulting `HyperlinkLine` directly to output.

**Call relations**: Used by `end_table` for aligned-grid and key/value-record table output.

*Call graph*: calls 5 internal fn (flush_current_line, is_blockquote_active, prefix_spans, push_output_line, style); called by 1 (end_table); 1 external calls (from).


##### `Writer::push_line`  (lines 1875–1893)

```
fn push_line(&mut self, line: Line<'static>)
```

**Purpose**: Starts a new current line buffer with the correct initial and continuation prefixes for the current indent/list context.

**Data flow**: It flushes any existing current line, computes blockquote style, captures whether a list marker was pending, stores `current_initial_indent` and `current_subsequent_indent` from `prefix_spans`, initializes `current_line_content` from the provided line, records whether the line is in a code block, clears local-link end tracking, and clears `pending_marker_line`.

**Call relations**: This is the main line-construction primitive used by most content and structural handlers.

*Call graph*: calls 4 internal fn (flush_current_line, is_blockquote_active, prefix_spans, new); called by 16 (code, end_codeblock, handle_event, hard_break, html, pop_link, prepare_for_event, push_annotated, push_blank_line, push_hyperlink_line (+6 more)).


##### `Writer::push_hyperlink_line`  (lines 1895–1901)

```
fn push_hyperlink_line(&mut self, line: HyperlinkLine)
```

**Purpose**: Starts a new current line from an existing hyperlink-aware line while preserving its hyperlink metadata.

**Data flow**: It extracts the incoming line’s hyperlinks, calls `push_line` with the visible `Line`, then restores the hyperlinks into `current_line_content`.

**Call relations**: Used by `end_table` when emitting non-prewrapped spillover or pipe-fallback lines.

*Call graph*: calls 1 internal fn (push_line); called by 1 (end_table).


##### `Writer::push_span`  (lines 1903–1909)

```
fn push_span(&mut self, span: Span<'static>)
```

**Purpose**: Appends a span to the current line, creating a new line first if necessary.

**Data flow**: If `current_line_content` exists it pushes the span into that line; otherwise it starts a new line containing just that span.

**Call relations**: Used by inline code, HTML, local-link destination suffixes, and highlighted code emission.

*Call graph*: calls 1 internal fn (push_line); called by 4 (code, end_codeblock, html, pop_link); 2 external calls (from, vec!).


##### `Writer::push_annotated`  (lines 1911–1924)

```
fn push_annotated(&mut self, mut appended: HyperlinkLine)
```

**Purpose**: Appends a hyperlink-aware fragment to the current line while shifting hyperlink ranges to the appended position.

**Data flow**: It ensures a current line exists, computes the current line width as a shift, appends the incoming spans, offsets each incoming hyperlink range by that shift, and extends the current line’s hyperlink list.

**Call relations**: Used by `push_text_spans` and `pop_link` when appending annotated web-link fragments.

*Call graph*: calls 1 internal fn (push_line); called by 2 (pop_link, push_text_spans); 1 external calls (default).


##### `Writer::push_text_spans`  (lines 1926–1942)

```
fn push_text_spans(&mut self, text: &str, style: Style)
```

**Purpose**: Converts one plain text fragment into a hyperlink-aware line fragment and appends it to the current output line.

**Data flow**: It takes text and a style, builds a styled span, checks whether the current markdown link is a web destination, and then either wraps the span in an explicit hyperlink fragment, leaves it plain when inside a markdown link or code block, or auto-annotates bare web URLs. It appends the result with `push_annotated`.

**Call relations**: Used by `text` for normal non-table text rendering.

*Call graph*: calls 3 internal fn (push_annotated, new, annotate_web_urls_in_line); called by 1 (text); 3 external calls (default, from, styled).


##### `Writer::push_blank_line`  (lines 1944–1952)

```
fn push_blank_line(&mut self)
```

**Purpose**: Emits a visible blank line, with special handling so pure-list contexts do not accidentally inherit list prefixes.

**Data flow**: It flushes the current line. If every indent context is a list, it pushes a raw blank output line directly; otherwise it starts and immediately flushes a blank current line so non-list prefixes such as blockquotes are preserved.

**Call relations**: Used whenever block-level separation is needed between paragraphs, lists, blockquotes, code blocks, rules, and tables.

*Call graph*: calls 4 internal fn (flush_current_line, push_line, push_output_line, new); called by 6 (handle_event, start_blockquote, start_codeblock, start_item, start_paragraph, start_table); 1 external calls (default).


##### `Writer::push_output_line`  (lines 1954–1956)

```
fn push_output_line(&mut self, line: HyperlinkLine)
```

**Purpose**: Appends a fully rendered hyperlink-aware line to the final output buffer.

**Data flow**: It takes a `HyperlinkLine` and pushes it onto `self.text`.

**Call relations**: Used only by finalization helpers such as `flush_current_line`, `push_blank_line`, and `push_prewrapped_line`.

*Call graph*: called by 3 (flush_current_line, push_blank_line, push_prewrapped_line).


##### `Writer::prefix_spans`  (lines 1958–1989)

```
fn prefix_spans(&self, pending_marker_line: bool) -> Vec<Span<'static>>
```

**Purpose**: Computes the visible prefix spans that should precede the current line, taking list markers, continuation indents, and nested blockquotes into account.

**Data flow**: It inspects `indent_stack` and the `pending_marker_line` flag. For marker lines it finds the deepest pending list marker and emits that marker while suppressing intermediate list prefixes above it; for continuation lines it emits only the deepest list indent plus all non-list prefixes. It returns a new `Vec<Span<'static>>`.

**Call relations**: Used by `push_line`, `push_prewrapped_line`, and width-budget calculations to keep indentation and markers consistent across wrapped and prewrapped output.

*Call graph*: called by 2 (push_line, push_prewrapped_line); 1 external calls (new).


##### `is_local_path_like_link`  (lines 1992–2004)

```
fn is_local_path_like_link(dest_url: &str) -> bool
```

**Purpose**: Recognizes markdown link destinations that should be treated as local filesystem paths rather than visible web URLs.

**Data flow**: It takes a destination string and returns true for `file://` URLs, Unix absolute paths, `~/`, `./`, `../`, UNC paths, and Windows drive-letter paths.

**Call relations**: Used by `should_render_link_destination` and `Writer::push_link` to switch into local-file-link rendering behavior.

*Call graph*: called by 2 (push_link, should_render_link_destination); 1 external calls (matches!).


##### `render_local_link_target`  (lines 2010–2017)

```
fn render_local_link_target(dest_url: &str, cwd: Option<&Path>) -> Option<String>
```

**Purpose**: Parses and formats a local link destination into the exact visible path text shown in transcripts.

**Data flow**: It takes a destination string and optional cwd, parses it into normalized path text plus optional location suffix with `parse_local_link_target`, shortens the path against cwd with `display_local_link_path`, appends the suffix if present, and returns the final display string.

**Call relations**: Used by `Writer::push_link` when a link destination is local-path-like.

*Call graph*: calls 2 internal fn (display_local_link_path, parse_local_link_target); called by 1 (push_link).


##### `parse_local_link_target`  (lines 2027–2058)

```
fn parse_local_link_target(dest_url: &str) -> Option<(String, Option<String>)>
```

**Purpose**: Splits a local link destination into normalized path text and an optional normalized location suffix.

**Data flow**: For `file://` URLs it parses the URL, converts it to local path text with `file_url_to_local_path_text`, and normalizes any hash fragment location suffix. For plain path-like inputs it prefers `#L...` fragments over trailing `:line[:col]` suffixes, decodes percent-encoding, expands `~/`, normalizes separators, and returns `(path_text, Option<suffix>)`. It returns `None` only when a `file://` URL cannot be parsed into a local path.

**Call relations**: Used only by `render_local_link_target`; it is the core parser for local-link display semantics.

*Call graph*: calls 4 internal fn (expand_local_link_path, extract_colon_location_suffix, file_url_to_local_path_text, normalize_hash_location_suffix_fragment); called by 1 (render_local_link_target); 3 external calls (parse, Borrowed, decode).


##### `normalize_hash_location_suffix_fragment`  (lines 2064–2069)

```
fn normalize_hash_location_suffix_fragment(fragment: &str) -> Option<String>
```

**Purpose**: Converts a hash fragment like `L74C3-L76C9` into the normalized display suffix format used by transcripts.

**Data flow**: It checks the fragment against `HASH_LOCATION_SUFFIX_RE`, prefixes it with `#`, passes it through `normalize_markdown_hash_location_suffix`, and returns the normalized suffix string or `None` for non-location fragments.

**Call relations**: Used by `parse_local_link_target` for both `file://` fragments and plain `path#fragment` inputs.

*Call graph*: called by 1 (parse_local_link_target).


##### `extract_colon_location_suffix`  (lines 2075–2080)

```
fn extract_colon_location_suffix(path_text: &str) -> Option<String>
```

**Purpose**: Extracts a trailing `:line`, `:line:col`, or range suffix from a path-like string without misreading embedded colons.

**Data flow**: It runs `COLON_LOCATION_SUFFIX_RE` against the input, requires the match to end at the end of the string, and returns the matched suffix as a `String` when present.

**Call relations**: Used by `parse_local_link_target` after hash-fragment parsing has had priority.

*Call graph*: called by 1 (parse_local_link_target).


##### `expand_local_link_path`  (lines 2086–2096)

```
fn expand_local_link_path(path_text: &str) -> String
```

**Purpose**: Expands `~/...` paths when possible and normalizes path separators for display.

**Data flow**: If the input starts with `~/` and `home_dir()` is available, it joins the remainder onto the home directory and normalizes the resulting path text. Otherwise it normalizes the original text directly.

**Call relations**: Used by `parse_local_link_target` for non-URL local paths.

*Call graph*: calls 1 internal fn (normalize_local_link_path_text); called by 1 (parse_local_link_target); 1 external calls (home_dir).


##### `file_url_to_local_path_text`  (lines 2103–2124)

```
fn file_url_to_local_path_text(url: &Url) -> Option<String>
```

**Purpose**: Converts a `file://` URL into normalized local path text, including fallback handling for Windows and UNC encodings that `Url::to_file_path()` rejects.

**Data flow**: It first tries `url.to_file_path()` and normalizes the resulting path. If that fails, it reconstructs a path string from `host_str()` and `path()`, preserving UNC hosts and stripping the leading slash from `/C:/...` drive-letter forms, then normalizes separators and returns the result.

**Call relations**: Used by `parse_local_link_target` for `file://` destinations.

*Call graph*: calls 1 internal fn (normalize_local_link_path_text); called by 1 (parse_local_link_target); 5 external calls (host_str, path, to_file_path, format!, matches!).


##### `normalize_local_link_path_text`  (lines 2132–2140)

```
fn normalize_local_link_path_text(path_text: &str) -> String
```

**Purpose**: Normalizes local path text into a stable display form using forward slashes and UNC normalization.

**Data flow**: It takes a path string and returns either `//server/share/...` for UNC-style `\\server\share...` inputs or a simple backslash-to-slash replacement for all other paths.

**Call relations**: Used by path expansion, file-URL conversion, and final display shortening.

*Call graph*: called by 3 (display_local_link_path, expand_local_link_path, file_url_to_local_path_text); 1 external calls (format!).


##### `is_absolute_local_link_path`  (lines 2142–2149)

```
fn is_absolute_local_link_path(path_text: &str) -> bool
```

**Purpose**: Determines whether normalized local path text is absolute rather than relative.

**Data flow**: It returns true for Unix absolute paths, UNC paths, and Windows drive-letter absolute paths.

**Call relations**: Used by `display_local_link_path` to decide whether cwd-relative shortening is applicable.

*Call graph*: called by 1 (display_local_link_path); 1 external calls (matches!).


##### `trim_trailing_local_path_separator`  (lines 2155–2163)

```
fn trim_trailing_local_path_separator(path_text: &str) -> &str
```

**Purpose**: Removes trailing `/` characters from local path text while preserving root forms like `/`, `//`, and `C:/`.

**Data flow**: It returns the input unchanged for root-like paths and otherwise trims trailing slashes.

**Call relations**: Used by `strip_local_path_prefix` before lexical prefix comparison.

*Call graph*: called by 1 (strip_local_path_prefix); 1 external calls (matches!).


##### `strip_local_path_prefix`  (lines 2170–2186)

```
fn strip_local_path_prefix(path_text: &'a str, cwd_text: &str) -> Option<&'a str>
```

**Purpose**: Lexically removes a cwd prefix from an absolute path only when the path is strictly underneath that cwd.

**Data flow**: It trims trailing separators from both inputs, returns `None` when the path equals the cwd exactly, handles root cwd specially by stripping a single leading slash, and otherwise strips `cwd_text` plus one following slash from `path_text`, returning the relative remainder.

**Call relations**: Used by `display_local_link_path` to shorten absolute local-link targets against the session cwd.

*Call graph*: calls 1 internal fn (trim_trailing_local_path_separator); called by 1 (display_local_link_path).


##### `display_local_link_path`  (lines 2193–2209)

```
fn display_local_link_path(path_text: &str, cwd: Option<&Path>) -> String
```

**Purpose**: Chooses the final visible path text for a local link after normalization and optional cwd-relative shortening.

**Data flow**: It normalizes the input path text, returns it unchanged when relative, and for absolute paths optionally normalizes the provided cwd and strips it from the path with `strip_local_path_prefix`. If stripping succeeds it returns the relative remainder; otherwise it preserves the absolute path.

**Call relations**: Used by `render_local_link_target` as the final display-policy step.

*Call graph*: calls 3 internal fn (is_absolute_local_link_path, normalize_local_link_path_text, strip_local_path_prefix); called by 1 (render_local_link_target).


##### `tests::lines_to_strings`  (lines 2222–2232)

```
fn lines_to_strings(text: &Text<'_>) -> Vec<String>
```

**Purpose**: Test helper that converts rendered `Text` into plain strings line-by-line.

**Data flow**: It takes a `Text`, concatenates each line’s span contents, and returns a `Vec<String>`.

**Call relations**: Shared by many unit tests in this file.


##### `tests::wraps_plain_text_when_width_provided`  (lines 2235–2247)

```
fn wraps_plain_text_when_width_provided()
```

**Purpose**: Verifies width-constrained plain text wraps into expected line breaks.

**Data flow**: It renders a sentence at width 16, converts to strings, and asserts the exact wrapped lines.

**Call relations**: Exercises `render_markdown_text_with_width` wrapping behavior.

*Call graph*: calls 1 internal fn (render_markdown_text_with_width); 2 external calls (assert_eq!, lines_to_strings).


##### `tests::wraps_list_items_preserving_indent`  (lines 2250–2258)

```
fn wraps_list_items_preserving_indent()
```

**Purpose**: Checks that wrapped unordered-list continuation lines keep the correct indent under the marker.

**Data flow**: It renders one bullet item at width 14, converts to strings, and asserts the marker line plus indented continuation line.

**Call relations**: Covers list-prefix handling in `flush_current_line` and `prefix_spans`.

*Call graph*: calls 1 internal fn (render_markdown_text_with_width); 2 external calls (assert_eq!, lines_to_strings).


##### `tests::wraps_nested_lists`  (lines 2261–2277)

```
fn wraps_nested_lists()
```

**Purpose**: Ensures nested list wrapping preserves both outer and inner indentation levels.

**Data flow**: It renders a nested bullet list at width 20, converts to strings, and asserts the exact wrapped output for both levels.

**Call relations**: Exercises nested `IndentContext` handling.

*Call graph*: calls 1 internal fn (render_markdown_text_with_width); 2 external calls (assert_eq!, lines_to_strings).


##### `tests::wraps_ordered_lists`  (lines 2280–2293)

```
fn wraps_ordered_lists()
```

**Purpose**: Verifies ordered-list markers and continuation indentation are rendered correctly under wrapping.

**Data flow**: It renders one ordered item at width 18, converts to strings, and asserts the marker line plus aligned continuation lines.

**Call relations**: Covers ordered-marker width computation in `start_item`.

*Call graph*: calls 1 internal fn (render_markdown_text_with_width); 2 external calls (assert_eq!, lines_to_strings).


##### `tests::wraps_blockquotes`  (lines 2296–2308)

```
fn wraps_blockquotes()
```

**Purpose**: Checks that wrapped blockquote lines repeat the `> ` prefix on each visible line.

**Data flow**: It renders a long blockquote at width 22, converts to strings, and asserts the expected quoted wrapped lines.

**Call relations**: Exercises blockquote prefix propagation through wrapping.

*Call graph*: calls 1 internal fn (render_markdown_text_with_width); 2 external calls (assert_eq!, lines_to_strings).


##### `tests::wraps_blockquotes_inside_lists`  (lines 2311–2323)

```
fn wraps_blockquotes_inside_lists()
```

**Purpose**: Ensures blockquotes nested inside list items wrap with both list indentation and quote prefix preserved.

**Data flow**: It renders a list item containing a blockquote at width 24, converts to strings, and asserts the exact prefixed lines.

**Call relations**: Covers combined list and blockquote prefix composition.

*Call graph*: calls 1 internal fn (render_markdown_text_with_width); 2 external calls (assert_eq!, lines_to_strings).


##### `tests::wraps_list_items_containing_blockquotes`  (lines 2326–2338)

```
fn wraps_list_items_containing_blockquotes()
```

**Purpose**: Verifies ordered-list items containing blockquotes render and wrap with correct marker and quote alignment.

**Data flow**: It renders an ordered item followed by a quoted continuation at width 24, converts to strings, and asserts the expected lines.

**Call relations**: Exercises interaction between ordered markers and nested blockquotes.

*Call graph*: calls 1 internal fn (render_markdown_text_with_width); 2 external calls (assert_eq!, lines_to_strings).


##### `tests::does_not_wrap_code_blocks`  (lines 2341–2349)

```
fn does_not_wrap_code_blocks()
```

**Purpose**: Confirms code blocks are not width-wrapped even when a narrow width is supplied.

**Data flow**: It renders a fenced code block at width 10, converts to strings, and asserts the long code line remains intact.

**Call relations**: Covers the `current_line_in_code_block` bypass in `flush_current_line`.

*Call graph*: calls 1 internal fn (render_markdown_text_with_width); 2 external calls (assert_eq!, lines_to_strings).


##### `tests::does_not_split_long_url_like_token_without_scheme`  (lines 2352–2363)

```
fn does_not_split_long_url_like_token_without_scheme()
```

**Purpose**: Checks that long URL-like tokens without a scheme are kept intact rather than split across wrapped lines.

**Data flow**: It renders one long path-like token at width 24, converts to strings, and asserts the full token appears on exactly one line.

**Call relations**: Exercises adaptive wrapping behavior around long tokens.

*Call graph*: calls 1 internal fn (render_markdown_text_with_width); 2 external calls (assert_eq!, lines_to_strings).


##### `tests::fenced_code_info_string_with_metadata_highlights`  (lines 2366–2383)

```
fn fenced_code_info_string_with_metadata_highlights()
```

**Purpose**: Verifies that fenced code blocks still syntax-highlight when the info string contains metadata after the language token.

**Data flow**: For several info-string variants, it renders markdown with `render_markdown_text`, scans spans for RGB foreground colors, and asserts highlighting occurred.

**Call relations**: Covers language-token extraction in `start_codeblock` and highlighting in `end_codeblock`.

*Call graph*: calls 1 internal fn (render_markdown_text); 2 external calls (assert!, format!).


##### `tests::crlf_code_block_no_extra_blank_lines`  (lines 2386–2398)

```
fn crlf_code_block_no_extra_blank_lines()
```

**Purpose**: Ensures CRLF-split code-block text events are concatenated verbatim without inserting spurious blank lines.

**Data flow**: It renders a CRLF fenced Rust block, converts to strings, and asserts exactly the two intended code lines appear.

**Call relations**: Guards the code-buffer accumulation path in `text` and `end_codeblock`.

*Call graph*: calls 1 internal fn (render_markdown_text); 2 external calls (assert_eq!, lines_to_strings).


##### `tests::wrap_cell_preserves_hard_break_lines`  (lines 2401–2424)

```
fn wrap_cell_preserves_hard_break_lines()
```

**Purpose**: Checks that table-cell hard breaks remain separate logical lines when wrapping a cell.

**Data flow**: It constructs a `TableCell` with two lines separated by `hard_break`, creates a dummy writer, wraps the cell, converts wrapped lines to strings, and asserts both lines remain distinct.

**Call relations**: Directly tests `Writer::wrap_cell` independent of full markdown parsing.

*Call graph*: 4 external calls (new, assert_eq!, empty, default).


##### `tests::make_cell`  (lines 2432–2436)

```
fn make_cell(text: &str) -> TableCell
```

**Purpose**: Builds a one-line plain-text `TableCell` fixture for table-layout unit tests.

**Data flow**: It creates a default `TableCell`, pushes one raw span containing the provided text, and returns the cell.

**Call relations**: Used by many table metric and spillover tests in this file.

*Call graph*: 2 external calls (raw, default).


##### `tests::make_body_row`  (lines 2438–2443)

```
fn make_body_row(cells: Vec<TableCell>, has_table_pipe_syntax: bool) -> TableBodyRow
```

**Purpose**: Constructs a `TableBodyRow` fixture from cells and a pipe-syntax flag.

**Data flow**: It takes a vector of cells and a boolean and returns a `TableBodyRow` with those fields.

**Call relations**: Used by spillover-row tests.


##### `tests::column_classification_narrative_by_word_count`  (lines 2448–2459)

```
fn column_classification_narrative_by_word_count()
```

**Purpose**: Verifies that prose-heavy columns classify as `Narrative` while short-value columns remain `Compact`.

**Data flow**: It builds a two-column header and rows, calls `collect_table_column_metrics`, and asserts the resulting kinds for both columns.

**Call relations**: Exercises the column-kind heuristic in `collect_table_column_metrics`.

*Call graph*: 3 external calls (collect_table_column_metrics, assert_eq!, vec!).


##### `tests::column_classification_token_heavy_by_url_like_tokens`  (lines 2462–2470)

```
fn column_classification_token_heavy_by_url_like_tokens()
```

**Purpose**: Checks that columns dominated by long URL-like tokens classify as `TokenHeavy`.

**Data flow**: It builds a one-column URL table, computes metrics, and asserts the column kind is `TokenHeavy`.

**Call relations**: Targets token-density classification logic.

*Call graph*: 3 external calls (collect_table_column_metrics, assert_eq!, vec!).


##### `tests::column_classification_token_heavy_for_local_path_lists`  (lines 2473–2485)

```
fn column_classification_token_heavy_for_local_path_lists()
```

**Purpose**: Ensures columns containing long local-path lists are also treated as token-heavy.

**Data flow**: It builds a one-column table of long file-path lists, computes metrics, and asserts `TokenHeavy` classification.

**Call relations**: Covers token-heavy detection for path-like rather than URL-like content.

*Call graph*: 3 external calls (collect_table_column_metrics, assert_eq!, vec!).


##### `tests::column_classification_compact_all_short`  (lines 2488–2498)

```
fn column_classification_compact_all_short()
```

**Purpose**: Verifies that short status/count columns remain `Compact`.

**Data flow**: It builds a small two-column table, computes metrics, and asserts both kinds are `Compact`.

**Call relations**: Covers the compact fallback branch of column classification.

*Call graph*: 3 external calls (collect_table_column_metrics, assert_eq!, vec!).


##### `tests::preferred_floor_narrative_retains_readable_width`  (lines 2501–2517)

```
fn preferred_floor_narrative_retains_readable_width()
```

**Purpose**: Checks the preferred-width floor chosen for narrative columns.

**Data flow**: It constructs two `TableColumnMetrics` values with `Narrative` kind and asserts `preferred_column_floor` returns 16 when possible and clamps to max width when narrower.

**Call relations**: Directly tests `preferred_column_floor`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::preferred_floor_token_heavy_retains_readable_width`  (lines 2520–2528)

```
fn preferred_floor_token_heavy_retains_readable_width()
```

**Purpose**: Verifies token-heavy columns also retain the 16-cell readable soft floor.

**Data flow**: It constructs a token-heavy metrics value and asserts `preferred_column_floor` returns 16.

**Call relations**: Direct unit test for token-heavy floor behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::preferred_floor_compact_uses_body_token`  (lines 2531–2551)

```
fn preferred_floor_compact_uses_body_token()
```

**Purpose**: Checks that compact-column floors are driven by header/body token widths with the documented 16-cell cap.

**Data flow**: It constructs compact metrics values with different body token widths and asserts the computed floors match the expected formulas.

**Call relations**: Directly tests compact-column floor logic.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::next_column_to_shrink_prefers_token_heavy_then_narrative`  (lines 2554–2587)

```
fn next_column_to_shrink_prefers_token_heavy_then_narrative()
```

**Purpose**: Verifies the shrink-order heuristic used during table width fitting.

**Data flow**: It defines widths, floors, and metrics for narrative, token-heavy, and compact columns, calls `next_column_to_shrink`, and asserts token-heavy is chosen first and narrative before compact once token-heavy reaches floor.

**Call relations**: Direct unit test for the iterative shrink selector.

*Call graph*: 2 external calls (next_column_to_shrink, assert_eq!).


##### `tests::spillover_detects_single_cell_row`  (lines 2592–2598)

```
fn spillover_detects_single_cell_row()
```

**Purpose**: Checks that a single-cell non-pipe body row is treated as spillover prose.

**Data flow**: It builds a one-cell row without pipe syntax and asserts `is_spillover_row` returns true.

**Call relations**: Exercises one spillover heuristic branch.

*Call graph*: 3 external calls (assert!, make_body_row, vec!).


##### `tests::spillover_keeps_single_cell_row_with_table_pipe_syntax`  (lines 2601–2607)

```
fn spillover_keeps_single_cell_row_with_table_pipe_syntax()
```

**Purpose**: Ensures sparse rows that explicitly used table pipe syntax are not discarded as spillover.

**Data flow**: It builds a one-cell row with `has_table_pipe_syntax = true` and asserts `is_spillover_row` is false.

**Call relations**: Covers the explicit-pipe exception in spillover detection.

*Call graph*: 3 external calls (assert!, make_body_row, vec!).


##### `tests::spillover_detects_html_content`  (lines 2610–2621)

```
fn spillover_detects_html_content()
```

**Purpose**: Verifies rows whose only non-empty cell contains HTML-like content are treated as spillover.

**Data flow**: It builds a three-cell row with HTML in the first cell and empties elsewhere, then asserts `is_spillover_row` is true.

**Call relations**: Exercises HTML-content spillover detection.

*Call graph*: 3 external calls (assert!, make_body_row, vec!).


##### `tests::spillover_detects_label_followed_by_html`  (lines 2624–2635)

```
fn spillover_detects_label_followed_by_html()
```

**Purpose**: Checks that an intro label row followed by HTML content is treated as spillover.

**Data flow**: It builds a row containing `HTML block:` and a following row containing `<div>x</div>`, then asserts the first row is spillover when passed with the next row.

**Call relations**: Covers the paired-label-plus-HTML spillover heuristic.

*Call graph*: 3 external calls (assert!, make_body_row, vec!).


##### `tests::spillover_detects_trailing_html_label`  (lines 2638–2645)

```
fn spillover_detects_trailing_html_label()
```

**Purpose**: Ensures a trailing `HTML block:` label at table end is also treated as spillover.

**Data flow**: It builds a row containing `HTML block:` with no next row and asserts `is_spillover_row` is true.

**Call relations**: Covers the trailing-label spillover branch.

*Call graph*: 3 external calls (assert!, make_body_row, vec!).


##### `tests::spillover_keeps_normal_multi_cell_row`  (lines 2648–2655)

```
fn spillover_keeps_normal_multi_cell_row()
```

**Purpose**: Verifies ordinary multi-cell rows are not misclassified as spillover.

**Data flow**: It builds a three-cell populated row with pipe syntax and asserts `is_spillover_row` is false.

**Call relations**: Negative control for spillover heuristics.

*Call graph*: 3 external calls (assert!, make_body_row, vec!).


##### `tests::spillover_keeps_label_when_next_is_not_html`  (lines 2658–2669)

```
fn spillover_keeps_label_when_next_is_not_html()
```

**Purpose**: Ensures ordinary label-like rows are preserved when the following row is not HTML content.

**Data flow**: It builds a `Status:` row followed by an `ok` row and asserts `is_spillover_row` is false.

**Call relations**: Negative control for the label-followed-by-HTML heuristic.

*Call graph*: 3 external calls (assert!, make_body_row, vec!).


##### `tests::annotates_explicit_web_link_label_and_visible_destination`  (lines 2672–2689)

```
fn annotates_explicit_web_link_label_and_visible_destination()
```

**Purpose**: Checks that explicit markdown web links produce hyperlink annotations for both the label and visible destination suffix.

**Data flow**: It renders a sentence containing `[docs](https://example.com/reference)`, collects all hyperlink annotations from the output lines, and asserts there are two annotations and both point to the same destination.

**Call relations**: Exercises `push_link`, `pop_link`, and hyperlink annotation propagation.

*Call graph*: calls 1 internal fn (render_markdown_lines_with_width_and_cwd); 2 external calls (assert!, assert_eq!).


##### `tests::wrapped_table_url_fragments_keep_complete_web_destination`  (lines 2692–2714)

```
fn wrapped_table_url_fragments_keep_complete_web_destination()
```

**Purpose**: Verifies that when a long URL wraps inside a table, every wrapped hyperlink fragment still points to the full original destination.

**Data flow**: It renders a narrow table containing a long URL, filters lines with hyperlinks, asserts the URL wrapped across multiple rows, and checks every hyperlink destination equals the original URL.

**Call relations**: Covers hyperlink remapping through `wrap_cell` and `render_table_row`.

*Call graph*: calls 1 internal fn (render_markdown_lines_with_width_and_cwd); 2 external calls (assert!, format!).


##### `tests::key_value_table_keeps_web_annotations`  (lines 2717–2734)

```
fn key_value_table_keeps_web_annotations()
```

**Purpose**: Ensures hyperlink annotations survive when a table falls back to key/value record rendering.

**Data flow**: It renders a narrow six-column table that triggers record fallback, collects all hyperlink destinations from the output, and asserts they are non-empty and all equal the original destination.

**Call relations**: Exercises the `table_key_value` fallback path with hyperlinks.

*Call graph*: calls 1 internal fn (render_markdown_lines_with_width_and_cwd); 2 external calls (assert!, format!).


##### `tests::does_not_annotate_code_or_non_web_markdown_links`  (lines 2737–2746)

```
fn does_not_annotate_code_or_non_web_markdown_links()
```

**Purpose**: Checks that code spans, code blocks, and non-web markdown links such as `mailto:` do not produce hyperlink annotations.

**Data flow**: It renders markdown containing inline code URLs, fenced code URLs, mailto links, and a table mailto link, then asserts every output line has an empty hyperlink list.

**Call relations**: Covers the annotation suppression branches in `push_text_spans`, `push_text_spans_to_table_cell`, and link handling.

*Call graph*: calls 1 internal fn (render_markdown_lines_with_width_and_cwd); 1 external calls (assert!).


##### `tests::pipe_table_fallback_keeps_web_annotations`  (lines 2749–2770)

```
fn pipe_table_fallback_keeps_web_annotations()
```

**Purpose**: Verifies that raw pipe-table fallback still preserves hyperlink annotations for visible web destinations while excluding code and label text.

**Data flow**: It renders an extremely narrow table that falls back to pipe output, collects all hyperlink destinations, and asserts the plain URL and explicit target URL are present while the code URL and visible label URL are absent.

**Call relations**: Exercises `render_table_pipe_fallback` and `row_to_pipe_line` hyperlink preservation.

*Call graph*: calls 1 internal fn (render_markdown_lines_with_width_and_cwd); 2 external calls (assert!, format!).


### `tui/src/markdown.rs`

`domain_logic` · `rendering and streamed transcript formatting`

This module is the thin API layer above the lower-level renderer in `markdown_render.rs`. `append_markdown` is the generic path: it renders a markdown string with an optional width and optional working directory, then appends the owned `ratatui::text::Line<'static>` values into a caller-provided vector. `append_markdown_agent` and `render_markdown_agent_with_links_and_cwd` add one extra normalization step for agent responses: `unwrap_markdown_fences`.

That unwrapper is intentionally conservative and source-preserving. It first takes a zero-copy fast path when no backtick or tilde fences exist. Otherwise it scans line-by-line, tracking at most one active fence. Non-markdown fences become `Passthrough`; ` ```md ` and ` ```markdown ` fences become buffered `MarkdownCandidate`s. For candidates, it stores the opening line range and all body line ranges without copying until the closing fence arrives. Only if the buffered body contains a table header line immediately followed by a delimiter line does it drop the opening/closing fence markers and emit only the body. If the body is not table-like, or if the fence is unclosed at EOF, the original fenced source is re-emitted unchanged. Blockquoted fences are handled specially by stripping and later requiring the blockquote prefix consistently.

The tests cover plain-text preservation, ordered-list rendering, code-block indentation, markdown-fence table unwrapping, non-markdown fence passthrough, blockquoted fence behavior, and edge cases where apparent tables should not unwrap.

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

**Purpose**: Renders markdown source into styled ratatui lines and appends them to an existing output buffer. It is the standard path for already-normalized markdown.

**Data flow**: Inputs are `markdown_source`, optional `width`, optional `cwd`, and a mutable `Vec<Line<'static>>`. It calls `render_markdown_text_with_width_and_cwd`, takes the resulting `Text`'s lines, and appends owned copies into `lines` via `push_owned_lines`.

**Call relations**: Used broadly by tests and streaming code that want normal markdown rendering without fence rewriting. It delegates all parsing and styling to `markdown_render` and only performs append semantics.

*Call graph*: calls 2 internal fn (render_markdown_text_with_width_and_cwd, push_owned_lines); called by 13 (append_markdown_keeps_ordered_list_line_unsplit_in_context, append_markdown_matches_tui_markdown_for_ordered_item, append_markdown_preserves_full_text_line, citations_render_as_plain_text, indented_code_blocks_preserve_leading_whitespace, commit_complete_lines, finalize_and_drain, assert_streamed_equals_full, heading_not_inlined_when_split_across_chunks, loose_list_with_split_dashes_matches_full_render (+3 more)).


##### `append_markdown_agent`  (lines 55–67)

```
fn append_markdown_agent(
    markdown_source: &str,
    width: Option<usize>,
    lines: &mut Vec<Line<'static>>,
)
```

**Purpose**: Renders agent markdown after first stripping markdown fences around actual tables so those tables are parsed structurally instead of as code.

**Data flow**: It takes `markdown_source`, optional `width`, and a mutable output vector. It normalizes the source with `unwrap_markdown_fences`, renders the normalized text with no cwd override, and appends the resulting owned lines into `lines`.

**Call relations**: Called by agent-specific tests and streaming/controller paths that need table-friendly rendering. It sits between raw agent text and the lower-level renderer, delegating normalization to `unwrap_markdown_fences` and rendering to `markdown_render`.

*Call graph*: calls 3 internal fn (unwrap_markdown_fences, render_markdown_text_with_width_and_cwd, push_owned_lines); called by 20 (append_markdown_agent_keeps_markdown_fence_when_content_is_not_table, append_markdown_agent_keeps_non_markdown_fences_as_code, append_markdown_agent_unwraps_markdown_fences_for_no_outer_table_rendering, append_markdown_agent_unwraps_markdown_fences_for_single_column_table, append_markdown_agent_unwraps_markdown_fences_for_table_rendering, append_markdown_agent_unwraps_markdown_fences_for_two_column_no_outer_table, collector_source_chunks_round_trip_into_agent_fence_unwrapping, controller_handles_table_immediately_after_heading, controller_holds_blockquoted_table_tail_until_stable, controller_keeps_markdown_fenced_no_outer_tables_mutable_until_finalize (+10 more)).


##### `render_markdown_agent_with_links_and_cwd`  (lines 69–76)

```
fn render_markdown_agent_with_links_and_cwd(
    markdown_source: &str,
    width: Option<usize>,
    cwd: Option<&Path>,
) -> Vec<HyperlinkLine>
```

**Purpose**: Produces hyperlink-aware rendered lines for agent markdown, using the same fence-unwrapping normalization as `append_markdown_agent` while preserving cwd-sensitive local-link display.

**Data flow**: It takes markdown source, optional width, and optional cwd; rewrites the source with `unwrap_markdown_fences`; then returns the `Vec<HyperlinkLine>` from `render_markdown_lines_with_width_and_cwd`.

**Call relations**: Used by hyperlink-aware display and source-rendering paths that need richer line metadata than plain `Line<'static>`. It parallels `append_markdown_agent` but returns hyperlink annotations instead of appending plain lines.

*Call graph*: calls 2 internal fn (unwrap_markdown_fences, render_markdown_lines_with_width_and_cwd); called by 4 (display_hyperlink_lines, display_hyperlink_lines, render_source, stable_prefix_len_for_source_start).


##### `unwrap_markdown_fences`  (lines 89–295)

```
fn unwrap_markdown_fences(markdown_source: &'a str) -> Cow<'a, str>
```

**Purpose**: Scans markdown source and removes only `md`/`markdown` fences whose buffered contents contain a real markdown table, leaving all other fences untouched.

**Data flow**: It takes a source `&str` and returns `Cow<str>`. If no fence markers exist, it returns `Cow::Borrowed`. Otherwise it iterates over newline-inclusive source lines, parses opening fences after stripping up to three spaces of indent, tracks fence marker kind/length and whether the fence is blockquoted, buffers candidate markdown-fence body ranges, and on close either emits only the body (table detected) or re-emits opening/body/closing ranges unchanged. Unclosed markdown candidates at EOF are also re-emitted with their opening line. The output is an owned reconstructed string when any scanning occurs.

**Call relations**: This is the normalization core used by both agent-rendering entry points and directly by several tests. Internally it relies on `table_detect` helpers for fence parsing, blockquote stripping, markdown-info detection, and table header/delimiter recognition.

*Call graph*: called by 6 (append_markdown_agent, render_markdown_agent_with_links_and_cwd, append_markdown_agent_keeps_markdown_fence_with_blank_line_between_header_and_delimiter, append_markdown_agent_keeps_non_blockquoted_markdown_fence_with_blockquote_table_example, append_markdown_agent_unwraps_blockquoted_markdown_fence_table, unwrap_markdown_fences_repro_keeps_fence_without_header_delimiter_pair); 7 external calls (MarkdownCandidate, Passthrough, new, Borrowed, Owned, with_capacity, new).


##### `tests::lines_to_strings`  (lines 303–313)

```
fn lines_to_strings(lines: &[Line<'static>]) -> Vec<String>
```

**Purpose**: Converts rendered ratatui lines into plain strings for assertion-friendly comparisons in tests.

**Data flow**: It takes a slice of `Line<'static>`, concatenates each line’s span contents into a `String`, and returns the resulting `Vec<String>`.

**Call relations**: Shared by nearly every test in this module to compare rendered output without caring about style metadata.

*Call graph*: 1 external calls (iter).


##### `tests::citations_render_as_plain_text`  (lines 316–328)

```
fn citations_render_as_plain_text()
```

**Purpose**: Checks that citation-like text containing brackets and daggers is preserved as ordinary text rather than being transformed or split.

**Data flow**: It renders a two-line source with `append_markdown`, converts the output with `lines_to_strings`, and asserts the two original lines are preserved exactly.

**Call relations**: Exercises the plain markdown path through `append_markdown` for citation-shaped text.

*Call graph*: calls 1 internal fn (append_markdown); 3 external calls (new, assert_eq!, lines_to_strings).


##### `tests::indented_code_blocks_preserve_leading_whitespace`  (lines 331–338)

```
fn indented_code_blocks_preserve_leading_whitespace()
```

**Purpose**: Verifies that indented code blocks keep their leading spaces and surrounding blank lines in rendered output.

**Data flow**: It renders a paragraph, blank line, indented code line, blank line, and trailing paragraph via `append_markdown`, converts to strings, and asserts the exact five-line sequence.

**Call relations**: Covers the generic renderer path for CommonMark indented code blocks.

*Call graph*: calls 1 internal fn (append_markdown); 3 external calls (new, assert_eq!, lines_to_strings).


##### `tests::append_markdown_preserves_full_text_line`  (lines 341–360)

```
fn append_markdown_preserves_full_text_line()
```

**Purpose**: Ensures a long plain-text line remains a single rendered line when no width constraint is provided.

**Data flow**: It renders one long line with `append_markdown`, asserts only one output line exists, then concatenates all spans from that line and compares the full text.

**Call relations**: Validates the no-wrap behavior of the standard markdown append path.

*Call graph*: calls 1 internal fn (append_markdown); 2 external calls (new, assert_eq!).


##### `tests::append_markdown_matches_tui_markdown_for_ordered_item`  (lines 363–373)

```
fn append_markdown_matches_tui_markdown_for_ordered_item()
```

**Purpose**: Checks that a simple ordered-list item renders as one intact line rather than splitting marker and content.

**Data flow**: It renders `1. Tight item` with `append_markdown`, converts lines to strings, and asserts the single expected line.

**Call relations**: Targets ordered-list formatting through the standard renderer.

*Call graph*: calls 1 internal fn (append_markdown); 3 external calls (new, assert_eq!, lines_to_strings).


##### `tests::append_markdown_keeps_ordered_list_line_unsplit_in_context`  (lines 376–395)

```
fn append_markdown_keeps_ordered_list_line_unsplit_in_context()
```

**Purpose**: Guards against a regression where an ordered-list marker and its text could render on separate lines when preceded by context text.

**Data flow**: It renders a short paragraph followed by `1. Tight item`, converts output to strings, asserts that the intact ordered-list line exists, and asserts no adjacent pair equals `"1."` then `"Tight item"`.

**Call relations**: Exercises `append_markdown` in a contextual case where list parsing and line assembly interact.

*Call graph*: calls 1 internal fn (append_markdown); 3 external calls (new, assert!, lines_to_strings).


##### `tests::append_markdown_agent_unwraps_markdown_fences_for_table_rendering`  (lines 398–405)

```
fn append_markdown_agent_unwraps_markdown_fences_for_table_rendering()
```

**Purpose**: Verifies that a fenced `markdown` table is unwrapped and rendered as a styled table with separators.

**Data flow**: It renders a fenced table through `append_markdown_agent`, converts lines to strings, and asserts that separator glyphs and row content appear in the output.

**Call relations**: Directly tests the happy path of `unwrap_markdown_fences` as used by the agent renderer.

*Call graph*: calls 1 internal fn (append_markdown_agent); 3 external calls (new, assert!, lines_to_strings).


##### `tests::append_markdown_agent_unwraps_markdown_fences_for_no_outer_table_rendering`  (lines 408–424)

```
fn append_markdown_agent_unwraps_markdown_fences_for_no_outer_table_rendering()
```

**Purpose**: Checks that a `md` fence containing a table without outer pipes still unwraps and renders as a native table.

**Data flow**: It renders a fence containing header, delimiter, and rows without leading/trailing pipes, then asserts table separators and aligned header text appear while the raw header line does not.

**Call relations**: Covers the table-detection logic’s acceptance of non-outer-pipe markdown tables.

*Call graph*: calls 1 internal fn (append_markdown_agent); 3 external calls (new, assert!, lines_to_strings).


##### `tests::append_markdown_agent_unwraps_markdown_fences_for_two_column_no_outer_table`  (lines 427–435)

```
fn append_markdown_agent_unwraps_markdown_fences_for_two_column_no_outer_table()
```

**Purpose**: Confirms that a minimal two-column no-outer-pipe table inside a markdown fence unwraps correctly.

**Data flow**: It renders the fenced source with `append_markdown_agent`, converts to strings, and asserts separator glyphs and aligned row content appear while the raw header line does not.

**Call relations**: Another positive case for fence unwrapping, focused on a small table shape.

*Call graph*: calls 1 internal fn (append_markdown_agent); 3 external calls (new, assert!, lines_to_strings).


##### `tests::append_markdown_agent_unwraps_markdown_fences_for_single_column_table`  (lines 438–445)

```
fn append_markdown_agent_unwraps_markdown_fences_for_single_column_table()
```

**Purpose**: Ensures single-column markdown tables inside `md` fences are also unwrapped and rendered structurally.

**Data flow**: It renders a fenced single-column table, converts output to strings, and asserts table separators appear while the raw pipe header line does not.

**Call relations**: Covers the lower-column-count edge case of the unwrapping logic.

*Call graph*: calls 1 internal fn (append_markdown_agent); 3 external calls (new, assert!, lines_to_strings).


##### `tests::append_markdown_agent_keeps_non_markdown_fences_as_code`  (lines 448–461)

```
fn append_markdown_agent_keeps_non_markdown_fences_as_code()
```

**Purpose**: Verifies that fences with non-markdown info strings such as `rust` are passed through unchanged and rendered as code content.

**Data flow**: It renders a `rust` fenced pseudo-table through `append_markdown_agent`, converts to strings, and asserts the output is exactly the three raw code lines.

**Call relations**: Exercises the `Passthrough` branch in `unwrap_markdown_fences`.

*Call graph*: calls 1 internal fn (append_markdown_agent); 3 external calls (new, assert_eq!, lines_to_strings).


##### `tests::append_markdown_agent_unwraps_blockquoted_markdown_fence_table`  (lines 464–471)

```
fn append_markdown_agent_unwraps_blockquoted_markdown_fence_table()
```

**Purpose**: Checks that a blockquoted markdown fence containing a table has its fence markers removed during normalization.

**Data flow**: It calls `unwrap_markdown_fences` directly on a blockquoted fenced table and asserts the resulting string no longer contains fence markers.

**Call relations**: Targets the blockquote-aware fence parsing path in the unwrapper.

*Call graph*: calls 1 internal fn (unwrap_markdown_fences); 1 external calls (assert!).


##### `tests::append_markdown_agent_keeps_non_blockquoted_markdown_fence_with_blockquote_table_example`  (lines 474–478)

```
fn append_markdown_agent_keeps_non_blockquoted_markdown_fence_with_blockquote_table_example()
```

**Purpose**: Ensures that a normal markdown fence whose contents merely contain blockquoted table syntax is not unwrapped incorrectly.

**Data flow**: It normalizes the source with `unwrap_markdown_fences` and asserts the output equals the original source exactly.

**Call relations**: Covers a subtle false-positive case where table-looking lines should not trigger unwrapping because the fence itself is not blockquoted.

*Call graph*: calls 1 internal fn (unwrap_markdown_fences); 1 external calls (assert_eq!).


##### `tests::append_markdown_agent_keeps_markdown_fence_when_content_is_not_table`  (lines 481–487)

```
fn append_markdown_agent_keeps_markdown_fence_when_content_is_not_table()
```

**Purpose**: Verifies that markdown fences containing non-table markdown remain fenced and therefore render as code-like literal text.

**Data flow**: It renders a fenced `**bold**` snippet through `append_markdown_agent`, converts to strings, and asserts the literal `**bold**` line is preserved.

**Call relations**: Exercises the branch where a markdown fence closes successfully but `markdown_fence_contains_table` returns false.

*Call graph*: calls 1 internal fn (append_markdown_agent); 3 external calls (new, assert_eq!, lines_to_strings).


##### `tests::unwrap_markdown_fences_repro_keeps_fence_without_header_delimiter_pair`  (lines 490–494)

```
fn unwrap_markdown_fences_repro_keeps_fence_without_header_delimiter_pair()
```

**Purpose**: Guards against unwrapping when table-like lines exist but there is no valid adjacent header-plus-delimiter pair.

**Data flow**: It normalizes a fenced source containing a header-like line, unrelated text, a delimiter-like line, and a heading, then asserts the source is unchanged.

**Call relations**: Tests the adjacency requirement inside `markdown_fence_contains_table`.

*Call graph*: calls 1 internal fn (unwrap_markdown_fences); 1 external calls (assert_eq!).


##### `tests::append_markdown_agent_keeps_markdown_fence_with_blank_line_between_header_and_delimiter`  (lines 497–501)

```
fn append_markdown_agent_keeps_markdown_fence_with_blank_line_between_header_and_delimiter()
```

**Purpose**: Ensures a blank line between a would-be table header and delimiter prevents fence unwrapping.

**Data flow**: It calls `unwrap_markdown_fences` on a fenced source with a blank line between header and delimiter and asserts the original source is preserved.

**Call relations**: Covers another conservative edge case in table detection.

*Call graph*: calls 1 internal fn (unwrap_markdown_fences); 1 external calls (assert_eq!).


### `tui/src/markdown_stream.rs`

`orchestration` · `streaming response assembly`

This module does not parse markdown in production; it defines stable source boundaries for incremental rendering. `MarkdownStreamCollector` stores the raw accumulated source in `buffer` and tracks how many bytes have already been emitted through `committed_source_len`. In tests it also tracks `committed_line_count` and a fixed `cwd` so rendered local-file-link text stays stable across incremental commits.

The production-facing API is source-oriented. `push_delta` appends raw token deltas. `commit_complete_source` finds the last newline in the buffer and returns only the newly completed source slice since the previous commit, leaving any trailing partial line buffered. `finalize_and_drain_source` returns the remaining uncommitted suffix, forcing a trailing newline when non-empty so downstream markdown block parsing can safely finalize, then resets the collector.

Under `cfg(test)`, the collector also offers rendered-line helpers. `commit_complete_lines` re-renders the entire newline-complete source prefix with `markdown::append_markdown`, drops a trailing blank line if it is only the paragraph terminator, and returns only the newly completed rendered lines since the previous commit. `finalize_and_drain` similarly renders the whole buffer (temporarily appending a newline if needed), returns only lines beyond the last committed rendered line, and clears state. This whole-file re-render strategy avoids incremental markdown-state bugs while still exposing newline-gated commit semantics.

The tests stress newline gating, finalization of partial lines, style preservation in streamed blockquotes and nested lists, heading boundaries across chunk splits, table/header behavior, UTF-8 and wide-character safety, and many fuzz-derived regressions asserting streamed output exactly matches a full one-shot render.

#### Function details

##### `MarkdownStreamCollector::new`  (lines 46–59)

```
fn new(width: Option<usize>, cwd: &Path) -> Self
```

**Purpose**: Creates a fresh collector for one markdown stream, optionally remembering width and cwd for test-only rendering helpers.

**Data flow**: It takes an optional width and a cwd path. In non-test builds the cwd is ignored; in test builds it is cloned into `cwd`. It initializes an empty `buffer`, zero `committed_source_len`, zero `committed_line_count` in tests, and stores the width.

**Call relations**: Constructed by test helpers and tests before pushing deltas. In production the same constructor seeds raw source accumulation without using the rendering-only fields.

*Call graph*: called by 9 (simulate_stream_markdown_for_tests, collector_source_chunks_round_trip_into_agent_fence_unwrapping, finalize_commits_partial_line, heading_not_inlined_when_split_across_chunks, heading_starts_on_new_line_when_following_paragraph, no_commit_until_newline, pipe_text_without_table_prefix_is_not_delayed, table_header_commits_without_holdback, new); 2 external calls (to_path_buf, new).


##### `MarkdownStreamCollector::set_width`  (lines 62–64)

```
fn set_width(&mut self, width: Option<usize>)
```

**Purpose**: Updates the width used by test-only rendered-line commit helpers.

**Data flow**: It takes an optional width and stores it in `self.width`.

**Call relations**: Standalone mutator for tests or callers that want to change wrapping before subsequent rendered commits.


##### `MarkdownStreamCollector::clear`  (lines 67–74)

```
fn clear(&mut self)
```

**Purpose**: Resets the collector to an empty initial state.

**Data flow**: It clears `buffer`, resets `committed_source_len` to 0, and in tests also resets `committed_line_count` to 0.

**Call relations**: Used internally by both finalize methods after draining output, and effectively defines the collector’s post-stream teardown behavior.

*Call graph*: called by 3 (finalize_and_drain, finalize_and_drain_source, clear).


##### `MarkdownStreamCollector::push_delta`  (lines 77–80)

```
fn push_delta(&mut self, delta: &str)
```

**Purpose**: Appends one raw streaming delta to the buffered markdown source.

**Data flow**: It takes a `&str` delta, logs it with `tracing::trace!`, and appends it to `self.buffer`.

**Call relations**: Called repeatedly by stream-driving code or tests before commit/finalize operations.

*Call graph*: 1 external calls (trace!).


##### `MarkdownStreamCollector::commit_complete_source`  (lines 87–96)

```
fn commit_complete_source(&mut self) -> Option<String>
```

**Purpose**: Returns the newly completed raw source chunk up to the latest newline, if any.

**Data flow**: It searches `self.buffer` for the last `\n`, computes `commit_end` as one past that index, returns `None` if no newline exists or if that boundary is not beyond `committed_source_len`, otherwise clones the slice from `committed_source_len..commit_end`, updates `committed_source_len`, and returns the new chunk.

**Call relations**: This is the production-oriented incremental API. Tests also use it in the round-trip case that feeds committed source into agent fence unwrapping.


##### `MarkdownStreamCollector::finalize_and_drain_source`  (lines 104–116)

```
fn finalize_and_drain_source(&mut self) -> String
```

**Purpose**: Returns any remaining uncommitted raw source at stream end, forcing a trailing newline when needed, and clears the collector.

**Data flow**: If all buffered source has already been committed, it clears state and returns an empty string. Otherwise it clones the uncommitted suffix, appends `\n` if missing, clears the collector, and returns the final chunk.

**Call relations**: Used at stream completion after zero or more `commit_complete_source` calls.

*Call graph*: calls 1 internal fn (clear); 1 external calls (new).


##### `MarkdownStreamCollector::commit_complete_lines`  (lines 126–155)

```
fn commit_complete_lines(&mut self) -> Vec<Line<'static>>
```

**Purpose**: Test-only helper that re-renders the newline-complete source prefix and returns only newly completed rendered lines.

**Data flow**: It finds the last newline boundary, returns an empty vector if none exists or nothing new is complete, clones the complete source prefix, renders it with `markdown::append_markdown` using stored width and cwd, trims one trailing blank line if it is spaces-only, compares the rendered line count to `committed_line_count`, returns only the newly completed slice, and updates both `committed_source_len` and `committed_line_count`.

**Call relations**: Used by streaming tests and `simulate_stream_markdown_for_tests` to model incremental rendering without maintaining parser state across chunks.

*Call graph*: calls 2 internal fn (append_markdown, is_blank_line_spaces_only); 2 external calls (as_path, new).


##### `MarkdownStreamCollector::finalize_and_drain`  (lines 161–191)

```
fn finalize_and_drain(&mut self) -> Vec<Line<'static>>
```

**Purpose**: Test-only helper that renders the full remaining buffer at stream end and returns only lines not already emitted by prior commits.

**Data flow**: It clones the full buffer, returns empty after clearing if the buffer is empty, appends a newline if missing, logs debug/trace diagnostics, renders with `markdown::append_markdown`, slices off already committed rendered lines using `committed_line_count`, clears the collector, and returns the remaining lines.

**Call relations**: Used by `simulate_stream_markdown_for_tests` when `finalize` is requested and by direct tests of partial-line finalization.

*Call graph*: calls 2 internal fn (append_markdown, clear); 4 external calls (as_path, new, debug!, trace!).


##### `test_cwd`  (lines 195–199)

```
fn test_cwd() -> PathBuf
```

**Purpose**: Provides a stable absolute cwd for streaming tests without depending on platform-specific root semantics.

**Data flow**: It returns `std::env::temp_dir()` as a `PathBuf`.

**Call relations**: Used by `simulate_stream_markdown_for_tests` and direct tests when constructing collectors.

*Call graph*: called by 1 (simulate_stream_markdown_for_tests); 1 external calls (temp_dir).


##### `simulate_stream_markdown_for_tests`  (lines 202–218)

```
fn simulate_stream_markdown_for_tests(
    deltas: &[&str],
    finalize: bool,
) -> Vec<Line<'static>>
```

**Purpose**: Feeds a sequence of deltas through a collector, committing after newline-bearing chunks and optionally finalizing at the end, to simulate streamed markdown rendering in tests.

**Data flow**: It takes a slice of delta strings and a `finalize` flag, constructs a collector with `test_cwd`, pushes each delta, calls `commit_complete_lines` whenever the delta contains a newline, accumulates all emitted lines, optionally appends `finalize_and_drain()` output, and returns the combined rendered lines.

**Call relations**: Shared by many tests that compare streamed rendering against full rendering or inspect streamed styles.

*Call graph*: calls 2 internal fn (new, test_cwd); called by 6 (assert_streamed_equals_full, empty_fenced_block_is_dropped_and_separator_preserved_before_heading, loose_list_with_split_dashes_matches_full_render, loose_vs_tight_list_items_streaming_matches_full, paragraph_then_empty_fence_then_heading_keeps_heading_on_new_line, utf8_boundary_safety_and_wide_chars); 1 external calls (new).


##### `tests::no_commit_until_newline`  (lines 226–234)

```
async fn no_commit_until_newline()
```

**Purpose**: Verifies that rendered-line commits do not occur until a newline completes a source line.

**Data flow**: It creates a collector, pushes a partial line, asserts `commit_complete_lines()` is empty, pushes `!\n`, commits again, and asserts exactly one line is emitted.

**Call relations**: Basic newline-gating test for the collector.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, assert_eq!, test_cwd).


##### `tests::finalize_commits_partial_line`  (lines 237–242)

```
async fn finalize_commits_partial_line()
```

**Purpose**: Checks that finalization emits a trailing partial line even without a newline.

**Data flow**: It creates a collector, pushes a line without newline, calls `finalize_and_drain`, and asserts one rendered line is returned.

**Call relations**: Covers the finalize path for incomplete trailing source.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, test_cwd).


##### `tests::e2e_stream_blockquote_simple_is_green`  (lines 245–255)

```
async fn e2e_stream_blockquote_simple_is_green()
```

**Purpose**: Ensures a simple streamed blockquote renders with green styling.

**Data flow**: It simulates streaming one quoted line, asserts one output line exists, and checks the line foreground color is green.

**Call relations**: End-to-end style preservation test using `simulate_stream_markdown_for_tests`.

*Call graph*: 2 external calls (assert_eq!, simulate_stream_markdown_for_tests).


##### `tests::e2e_stream_blockquote_nested_is_green`  (lines 258–281)

```
async fn e2e_stream_blockquote_nested_is_green()
```

**Purpose**: Checks nested streamed blockquotes keep green styling on non-blank rendered lines.

**Data flow**: It simulates streaming two quoted lines, filters out blank or quote-only lines, asserts two remain, and checks both have green foreground color.

**Call relations**: Covers nested blockquote styling under streaming commits.

*Call graph*: 2 external calls (assert_eq!, simulate_stream_markdown_for_tests).


##### `tests::e2e_stream_blockquote_with_list_items_is_green`  (lines 284–292)

```
async fn e2e_stream_blockquote_with_list_items_is_green()
```

**Purpose**: Verifies quoted list items remain green when streamed.

**Data flow**: It simulates streaming two quoted bullet items, asserts two lines, and checks both line styles are green.

**Call relations**: Exercises combined blockquote/list styling through the streaming path.

*Call graph*: 2 external calls (assert_eq!, simulate_stream_markdown_for_tests).


##### `tests::e2e_stream_nested_mixed_lists_ordered_marker_is_light_blue`  (lines 295–323)

```
async fn e2e_stream_nested_mixed_lists_ordered_marker_is_light_blue()
```

**Purpose**: Checks that a deeply nested ordered-list marker remains light blue in streamed output.

**Data flow**: It simulates streaming a mixed nested list, finds the line containing `Third level (ordered)`, scans its spans, and asserts at least one span has light-blue foreground.

**Call relations**: End-to-end streamed styling test for ordered markers.

*Call graph*: 2 external calls (assert!, simulate_stream_markdown_for_tests).


##### `tests::e2e_stream_blockquote_wrap_preserves_green_style`  (lines 326–360)

```
async fn e2e_stream_blockquote_wrap_preserves_green_style()
```

**Purpose**: Verifies that after streamed rendering, additional wrapping still preserves green styling on wrapped blockquote lines.

**Data flow**: It simulates streaming one long quoted line, wraps the resulting lines with `word_wrap_lines` at width 24, filters non-blank lines, asserts multiple wrapped lines exist, and checks the first span of each wrapped line is green.

**Call relations**: Tests style stability after post-render wrapping.

*Call graph*: calls 2 internal fn (new, word_wrap_lines); 3 external calls (assert!, assert_eq!, simulate_stream_markdown_for_tests).


##### `tests::heading_starts_on_new_line_when_following_paragraph`  (lines 363–415)

```
async fn heading_starts_on_new_line_when_following_paragraph()
```

**Purpose**: Checks that a heading streamed after a paragraph commits as a separate later chunk with a blank separator.

**Data flow**: It creates a collector, commits `Hello.\n`, asserts only the paragraph line appears, then pushes `## Heading\n`, commits again, and asserts the second commit contains a blank line and the heading line.

**Call relations**: Regression test for block-boundary handling across commits.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, test_cwd).


##### `tests::heading_not_inlined_when_split_across_chunks`  (lines 418–489)

```
async fn heading_not_inlined_when_split_across_chunks()
```

**Purpose**: Ensures a heading split across chunks is not merged into the preceding paragraph when the newline arrives separately.

**Data flow**: It creates a collector, pushes a paragraph without newline and confirms no commit, then pushes a chunk beginning with newline plus partial heading text and asserts only the paragraph commits, then pushes the final newline and asserts the heading commits separately with a blank separator. It also sanity-checks one-shot `append_markdown` rendering of a simple line.

**Call relations**: Covers chunk-boundary correctness for headings and validates the collector’s newline gating against full rendering.

*Call graph*: calls 2 internal fn (append_markdown, new); 4 external calls (new, assert!, assert_eq!, test_cwd).


##### `tests::lines_to_plain_strings`  (lines 491–502)

```
fn lines_to_plain_strings(lines: &[ratatui::text::Line<'_>]) -> Vec<String>
```

**Purpose**: Converts rendered lines into plain strings for streaming test assertions.

**Data flow**: It takes a slice of `Line`, concatenates each line’s span contents, and returns a `Vec<String>`.

**Call relations**: Shared helper for many tests in this module.

*Call graph*: 1 external calls (iter).


##### `tests::table_header_commits_without_holdback`  (lines 505–529)

```
async fn table_header_commits_without_holdback()
```

**Purpose**: Verifies that table-like lines are committed immediately at newline boundaries rather than being artificially delayed.

**Data flow**: It creates a collector, pushes a header row and asserts it commits as `| A | B |`, then pushes delimiter and body rows and asserts each subsequent commit is non-empty.

**Call relations**: Regression test ensuring the collector is newline-gated only, not markdown-structure-gated.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert!, assert_eq!, test_cwd, lines_to_plain_strings).


##### `tests::pipe_text_without_table_prefix_is_not_delayed`  (lines 532–538)

```
async fn pipe_text_without_table_prefix_is_not_delayed()
```

**Purpose**: Checks ordinary text containing pipe characters commits normally and is not mistaken for a table needing holdback.

**Data flow**: It creates a collector, pushes one line of text with pipes, commits, converts to strings, and asserts the exact line is returned.

**Call relations**: Negative control for table-like source handling.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, test_cwd, lines_to_plain_strings).


##### `tests::lists_and_fences_commit_without_duplication`  (lines 541–547)

```
async fn lists_and_fences_commit_without_duplication()
```

**Purpose**: Verifies streamed rendering of lists and fenced code blocks matches full rendering without duplicated lines.

**Data flow**: It calls `assert_streamed_equals_full` on one list-chunk sequence and one fenced-code chunk sequence.

**Call relations**: Delegates to the shared streamed-vs-full assertion helper.

*Call graph*: 1 external calls (assert_streamed_equals_full).


##### `tests::utf8_boundary_safety_and_wide_chars`  (lines 550–582)

```
async fn utf8_boundary_safety_and_wide_chars()
```

**Purpose**: Checks that chunk boundaries through emoji, CJK, control characters, and combining marks do not corrupt or duplicate streamed output.

**Data flow**: It defines a full input and chunked deltas, renders the streamed version with `simulate_stream_markdown_for_tests`, renders the full version with `append_markdown`, converts both to plain strings, and asserts equality.

**Call relations**: Regression test for UTF-8 and display-width safety across chunk boundaries.

*Call graph*: calls 2 internal fn (append_markdown, simulate_stream_markdown_for_tests); 5 external calls (new, assert_eq!, test_cwd, lines_to_plain_strings, vec!).


##### `tests::e2e_stream_deep_nested_third_level_marker_is_light_blue`  (lines 585–631)

```
async fn e2e_stream_deep_nested_third_level_marker_is_light_blue()
```

**Purpose**: Checks that in streamed output the third-level ordered marker span is light blue while following content remains default-colored.

**Data flow**: It simulates streaming a deeply nested list, finds the line containing `1. Third level (ordered)`, asserts it has spans, checks the first span foreground is light blue, then finds the first non-space content span after it and asserts that span has no foreground color.

**Call relations**: More precise streamed styling test than the earlier marker-presence check.

*Call graph*: 4 external calls (assert!, assert_eq!, simulate_stream_markdown_for_tests, lines_to_plain_strings).


##### `tests::empty_fenced_block_is_dropped_and_separator_preserved_before_heading`  (lines 634–649)

```
async fn empty_fenced_block_is_dropped_and_separator_preserved_before_heading()
```

**Purpose**: Ensures an empty fenced code block produces no visible fence markers while still allowing a following heading to render separately.

**Data flow**: It simulates streaming an empty fenced block followed by a heading, converts output to strings, asserts no line contains ``` and some line equals `## Heading`.

**Call relations**: Regression test for empty-block handling in streamed rendering.

*Call graph*: calls 1 internal fn (simulate_stream_markdown_for_tests); 3 external calls (assert!, lines_to_plain_strings, vec!).


##### `tests::paragraph_then_empty_fence_then_heading_keeps_heading_on_new_line`  (lines 652–668)

```
async fn paragraph_then_empty_fence_then_heading_keeps_heading_on_new_line()
```

**Purpose**: Checks that an empty fenced block between a paragraph and heading does not cause the heading to merge with the paragraph.

**Data flow**: It simulates streaming paragraph, empty fence, and heading chunks, converts output to strings, finds the paragraph and heading indices, and asserts the heading appears later.

**Call relations**: Another block-boundary regression test around empty fences.

*Call graph*: calls 1 internal fn (simulate_stream_markdown_for_tests); 4 external calls (assert!, panic!, lines_to_plain_strings, vec!).


##### `tests::loose_list_with_split_dashes_matches_full_render`  (lines 671–694)

```
async fn loose_list_with_split_dashes_matches_full_render()
```

**Purpose**: Verifies a fuzz-minimized loose-list chunk sequence renders identically to a full one-shot render.

**Data flow**: It simulates streaming the deltas, renders the concatenated full markdown with `append_markdown`, converts both outputs to plain strings, and asserts equality.

**Call relations**: Regression test derived from a discovered streaming mismatch.

*Call graph*: calls 2 internal fn (append_markdown, simulate_stream_markdown_for_tests); 5 external calls (new, assert_eq!, test_cwd, lines_to_plain_strings, vec!).


##### `tests::loose_vs_tight_list_items_streaming_matches_full`  (lines 697–801)

```
async fn loose_vs_tight_list_items_streaming_matches_full()
```

**Purpose**: Checks a long real-world loose-vs-tight list chunk sequence renders to the exact expected streamed lines.

**Data flow**: It simulates streaming many small deltas, converts output to strings, also renders the full concatenated markdown for diagnostics, defines the exact expected line vector, and asserts the streamed output equals that expected sequence.

**Call relations**: Large regression test for list semantics under chunked streaming.

*Call graph*: calls 2 internal fn (append_markdown, simulate_stream_markdown_for_tests); 5 external calls (new, assert_eq!, test_cwd, lines_to_plain_strings, vec!).


##### `tests::assert_streamed_equals_full`  (lines 804–818)

```
async fn assert_streamed_equals_full(deltas: &[&str])
```

**Purpose**: Shared helper that asserts streamed rendering of a delta sequence matches a full one-shot render exactly.

**Data flow**: It simulates streaming the deltas with finalization, converts output to strings, concatenates the full markdown, renders it with `append_markdown`, converts that output to strings, and asserts equality with the full source included in the failure message.

**Call relations**: Used by multiple fuzz/regression tests in this module.

*Call graph*: calls 2 internal fn (append_markdown, simulate_stream_markdown_for_tests); 4 external calls (new, assert_eq!, test_cwd, lines_to_plain_strings).


##### `tests::fuzz_class_bullet_duplication_variant_1`  (lines 821–827)

```
async fn fuzz_class_bullet_duplication_variant_1()
```

**Purpose**: Regression test for one fuzz-discovered bullet-duplication streaming sequence.

**Data flow**: It passes the two delta chunks to `assert_streamed_equals_full` and awaits completion.

**Call relations**: Thin wrapper around the shared streamed-vs-full helper.

*Call graph*: 1 external calls (assert_streamed_equals_full).


##### `tests::fuzz_class_bullet_duplication_variant_2`  (lines 830–836)

```
async fn fuzz_class_bullet_duplication_variant_2()
```

**Purpose**: Regression test for a second fuzz-discovered bullet-duplication sequence.

**Data flow**: It passes the delta chunks to `assert_streamed_equals_full` and awaits completion.

**Call relations**: Another thin wrapper around the shared helper.

*Call graph*: 1 external calls (assert_streamed_equals_full).


##### `tests::streaming_html_block_then_text_matches_full`  (lines 839–846)

```
async fn streaming_html_block_then_text_matches_full()
```

**Purpose**: Checks that streaming an HTML block followed by text matches full rendering.

**Data flow**: It passes three chunks to `assert_streamed_equals_full` and awaits completion.

**Call relations**: Regression coverage for HTML block boundaries.

*Call graph*: 1 external calls (assert_streamed_equals_full).


##### `tests::table_like_lines_inside_fenced_code_are_not_held`  (lines 849–851)

```
async fn table_like_lines_inside_fenced_code_are_not_held()
```

**Purpose**: Verifies table-looking lines inside fenced code blocks are streamed normally and still match full rendering.

**Data flow**: It passes fenced-code chunks containing a pipe row to `assert_streamed_equals_full` and awaits completion.

**Call relations**: Negative control for table-like content inside code fences.

*Call graph*: 1 external calls (assert_streamed_equals_full).


##### `tests::collector_source_chunks_round_trip_into_agent_fence_unwrapping`  (lines 854–888)

```
async fn collector_source_chunks_round_trip_into_agent_fence_unwrapping()
```

**Purpose**: Checks that source chunks committed by the collector can be concatenated and then fed into agent fence unwrapping to render a markdown-fenced table structurally.

**Data flow**: It creates a collector, pushes markdown-fenced table deltas, accumulates committed raw source from `commit_complete_source`, appends the final drained source, renders the concatenated source with `append_markdown_agent`, converts lines to strings, and asserts a table separator appears while the raw header line does not.

**Call relations**: Bridges this module’s source-boundary logic with `markdown.rs` agent fence unwrapping.

*Call graph*: calls 2 internal fn (append_markdown_agent, new); 5 external calls (new, new, assert!, test_cwd, lines_to_plain_strings).


### `tui/src/streaming/mod.rs`

`data_model` · `stream request handling`

This module is the leaf-level state container behind streamed transcript rendering. Its central type, `StreamState`, owns three pieces of state: a `MarkdownStreamCollector` that accumulates raw markdown deltas until they become commit-safe, a `VecDeque<QueuedLine>` holding committed `HyperlinkLine` render lines waiting to be emitted, and a `has_seen_delta` flag that tracks whether the current stream lifecycle has received any content yet. Each queued line is wrapped in a private `QueuedLine` record that stores both the rendered line and the `Instant` when it entered the queue; that timestamp is the mechanism used by policy code in sibling modules to reason about queue age without inspecting text.

The design is intentionally simple and invariant-driven: queue order is preserved strictly by pushing at the back and draining from the front, and queue-drain methods never reorder or peek ahead. `new` binds the markdown collector to a stable session working directory so local file links render consistently for the lifetime of a stream. `clear` resets the entire lifecycle, while `clear_queue` deliberately preserves collector state for re-render/rebuild scenarios. The drain APIs come in single-step and bounded-batch forms, with `drain_n` clamping to the current queue length so callers can request aggressive drains safely. A focused unit test verifies that clamping behavior.

#### Function details

##### `StreamState::new`  (lines 41–47)

```
fn new(width: Option<usize>, cwd: &Path) -> Self
```

**Purpose**: Constructs a fresh `StreamState` with an empty committed-line queue, a new `MarkdownStreamCollector`, and `has_seen_delta` cleared. It also fixes the collector's hyperlink resolution base to the provided current working directory.

**Data flow**: Inputs are an optional wrap `width` and a `cwd: &Path`. The function creates a `MarkdownStreamCollector::new(width, cwd)`, initializes `queued_lines` as an empty `VecDeque`, sets `has_seen_delta` to `false`, and returns the assembled `StreamState` value without mutating external state.

**Call relations**: This is the creation point used by higher-level stream setup code and by the queue-drain unit test. It delegates collector initialization to the markdown collector because link rendering and width-sensitive markdown accumulation belong there, while this module owns only queue and lifecycle state.

*Call graph*: calls 1 internal fn (new); called by 2 (new, drain_n_clamps_to_available_lines); 1 external calls (new).


##### `StreamState::clear`  (lines 49–53)

```
fn clear(&mut self)
```

**Purpose**: Resets the stream for a new lifecycle by wiping both in-flight markdown accumulation and any queued committed render lines. It also clears the delta-seen marker so downstream logic treats the next stream as brand new.

**Data flow**: It takes `&mut self`, calls `self.collector.clear()`, empties `self.queued_lines`, sets `self.has_seen_delta = false`, and returns `()`. All state changes are internal to the `StreamState` instance.

**Call relations**: This is invoked from stream reset logic when a turn or stream is being restarted. It delegates markdown-specific cleanup to the collector and performs queue/lifecycle cleanup locally so callers get a full-state reset in one step.

*Call graph*: calls 1 internal fn (clear); called by 1 (reset); 1 external calls (clear).


##### `StreamState::step`  (lines 55–61)

```
fn step(&mut self) -> Vec<HyperlinkLine>
```

**Purpose**: Removes at most one committed render line from the front of the queue and returns it in a vector. The vector shape matches callers that consume batches even when draining one line at a time.

**Data flow**: Given `&mut self`, it pops the front `QueuedLine` from `queued_lines`, maps it to its contained `HyperlinkLine`, converts the optional result into an iterator, collects that into `Vec<HyperlinkLine>`, and returns either an empty vector or a single-element vector.

**Call relations**: Tick-style streaming code uses this when policy decides to emit one line per commit cycle. It does not delegate further; its role is to preserve FIFO semantics while adapting the queue to the batch-oriented interface expected by the caller.

*Call graph*: called by 1 (tick); 1 external calls (pop_front).


##### `StreamState::drain_n`  (lines 66–72)

```
fn drain_n(&mut self, max_lines: usize) -> Vec<HyperlinkLine>
```

**Purpose**: Removes up to a caller-specified number of committed lines from the queue front and returns them in arrival order. It never over-drains: requests larger than the queue depth are clamped to the available count.

**Data flow**: It reads `max_lines` and the current queue length, computes `end = min(max_lines, self.queued_lines.len())`, drains the range `..end` from the `VecDeque`, maps each `QueuedLine` to its `line`, collects the results into `Vec<HyperlinkLine>`, and returns that vector.

**Call relations**: Batch-oriented commit logic calls this when adaptive chunking decides to flush multiple lines at once. The method is intentionally self-bounding so upstream policy can ask for large batches without separately guarding against queue underflow.

*Call graph*: called by 1 (tick_batch); 2 external calls (drain, len).


##### `StreamState::clear_queue`  (lines 74–76)

```
fn clear_queue(&mut self)
```

**Purpose**: Drops only the committed-line queue while leaving markdown collector contents and stream-lifecycle flags untouched. This supports re-render and queue-rebuild operations that should not discard source accumulation.

**Data flow**: It takes `&mut self`, calls `self.queued_lines.clear()`, and returns `()`. `collector` and `has_seen_delta` are preserved exactly as they were.

**Call relations**: Rendering-mode and width-change paths use this before rebuilding a stable queue from existing collector/render state. It is narrower than `clear` specifically so those callers can discard stale queued render lines without resetting the underlying stream.

*Call graph*: called by 4 (rebuild_stable_queue_from_render, set_render_mode, set_width, sync_stable_queue); 1 external calls (clear).


##### `StreamState::is_idle`  (lines 78–80)

```
fn is_idle(&self) -> bool
```

**Purpose**: Reports whether there are currently no committed lines waiting to be emitted. It is a pure queue-state query.

**Data flow**: It reads `self.queued_lines.is_empty()` and returns the resulting `bool` without mutating any state.

**Call relations**: Higher-level idle checks call this to decide whether a stream has pending visible output. It is a leaf accessor over the queue and delegates no work.

*Call graph*: called by 1 (is_idle); 1 external calls (is_empty).


##### `StreamState::queued_len`  (lines 82–84)

```
fn queued_len(&self) -> usize
```

**Purpose**: Returns the current number of committed render lines buffered in the queue. This is used by policy code that reacts to queue pressure.

**Data flow**: It reads `self.queued_lines.len()` and returns that `usize`, with no side effects.

**Call relations**: Queue-pressure and reconfiguration code consult this when deciding drain sizes or whether a queue rebuild is needed. It is a simple accessor that exposes queue depth without exposing queue contents.

*Call graph*: called by 4 (queued_lines, set_render_mode, set_width, sync_stable_queue); 1 external calls (len).


##### `StreamState::oldest_queued_age`  (lines 86–90)

```
fn oldest_queued_age(&self, now: Instant) -> Option<Duration>
```

**Purpose**: Computes how long the oldest queued line has been waiting, if any line is queued. This exposes latency information while preserving queue encapsulation.

**Data flow**: It takes `now: Instant`, reads the front element of `queued_lines`, and if present computes `now.saturating_duration_since(queued.enqueued_at)`. It returns `Some(Duration)` for a non-empty queue or `None` when the queue is empty.

**Call relations**: Streaming policy code calls this when age-based draining decisions matter. The method relies on the enqueue timestamp captured by `enqueue`, so callers do not need direct access to queue internals.

*Call graph*: called by 1 (oldest_queued_age); 1 external calls (front).


##### `StreamState::enqueue`  (lines 92–99)

```
fn enqueue(&mut self, lines: Vec<HyperlinkLine>)
```

**Purpose**: Appends newly committed render lines to the back of the queue and stamps them all with the same enqueue time. Using one shared timestamp per batch makes oldest-age calculations stable and cheap.

**Data flow**: It consumes `lines: Vec<HyperlinkLine>`, captures `let now = Instant::now()`, transforms each line into a `QueuedLine { line, enqueued_at: now }`, extends `self.queued_lines` with those records, and returns `()`. The queue grows; no other state changes.

**Call relations**: Queue rebuild and synchronization paths call this after producing committed render lines from collector state. It does not render or inspect text itself; its job is to preserve FIFO order and attach timing metadata for later policy decisions.

*Call graph*: called by 2 (rebuild_stable_queue_from_render, sync_stable_queue); 2 external calls (now, extend).


##### `tests::test_cwd`  (lines 109–113)

```
fn test_cwd() -> PathBuf
```

**Purpose**: Provides a stable absolute working directory for tests without hard-coding platform-specific root semantics. It isolates stream-state tests from filesystem-path assumptions.

**Data flow**: It reads the process temporary directory via `std::env::temp_dir()` and returns that `PathBuf`.

**Call relations**: The queue-drain test uses this helper when constructing `StreamState::new`, ensuring the collector receives a valid absolute cwd while keeping the fixture portable.

*Call graph*: 1 external calls (temp_dir).


##### `tests::drain_n_clamps_to_available_lines`  (lines 116–123)

```
fn drain_n_clamps_to_available_lines()
```

**Purpose**: Verifies that `StreamState::drain_n` returns all available lines when asked for more than the queue contains, and leaves the queue empty afterward. It locks in the method's clamping contract.

**Data flow**: The test creates a `StreamState`, enqueues one `HyperlinkLine`, calls `drain_n(8)`, then asserts that the returned vector contains exactly the original line and that `state.is_idle()` is true. Its outputs are test assertions only.

**Call relations**: This test exercises the public queue API in the same shape batch-drain callers use. It specifically guards the edge case where requested drain size exceeds queue depth.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert!, assert_eq!, test_cwd, vec!).


### `tui/src/streaming/controller.rs`

`domain_logic` · `active streaming, resize handling, stream finalization`

This is the core streaming engine for TUI transcript updates. `StreamCore` owns the shared mechanics: append-only `raw_source`, a full `rendered_lines` snapshot at the current width, queue bookkeeping (`enqueued_stable_len` vs `emitted_stable_len`), a `StreamState` animation queue, current cwd for stable local-link rendering, render mode (`Rich` vs `Raw`), and incremental table-holdback state via `TableHoldbackScanner`. The central invariant is that only the stable prefix may be queued into scrollback; the tail beginning at `enqueued_stable_len` remains mutable and is shown in the active-cell slot.

`push_delta` only commits newline-terminated source from the collector into `raw_source`, which prevents partial table rows from briefly appearing and then reshaping. After each committed chunk it updates the holdback scanner, re-renders the full source, and advances the stable boundary with `sync_stable_queue`. Table holdback is the key design choice: when the scanner reports `PendingHeader` or `Confirmed`, `active_tail_budget_lines` withholds all rendered lines from the candidate table start onward, because adding rows can change column widths and rewrite earlier table lines. A cached `stable_prefix_len_for_source_start` avoids repeatedly re-rendering the unchanged prefix while a table is still streaming.

Resize and render-mode changes intentionally rebuild queue state from source rather than trying to remap old wrapped lines. `set_width` and `set_render_mode` re-render, clamp `emitted_stable_len`, preserve at least one pending line when wrapped content compresses, clear the old queue, and either mark everything emitted or rebuild the queue from the current render. `StreamController` and `PlanStreamController` are thin wrappers over `StreamCore`: the former emits `AgentMessageCell`s and tracks whether the bullet header has already been shown; the latter adds a `Proposed Plan` header, top/bottom padding, indentation via `prefix_hyperlink_lines`, and background styling from `proposed_plan_style`. The extensive tests cover resize edge cases, live-tail correctness, table detection in plain/blockquoted/fenced/no-outer-pipes forms, semantic hyperlink preservation, and equivalence between streamed output and full final markdown rendering.

#### Function details

##### `StreamCore::new`  (lines 107–120)

```
fn new(width: Option<usize>, cwd: &Path, render_mode: HistoryRenderMode) -> Self
```

**Purpose**: Initializes the shared streaming core with empty source, empty render snapshots, queue counters at zero, and a fresh holdback scanner.

**Data flow**: It takes optional width, cwd path, and `HistoryRenderMode`; constructs `StreamState::new(width, cwd)`, allocates `raw_source` and `rendered_lines` with initial capacities, clones `cwd` into a `PathBuf`, initializes counters and caches, and returns the `StreamCore`.

**Call relations**: It is called by both `StreamController::new` and `PlanStreamController::new`.

*Call graph*: calls 2 internal fn (new, new); called by 2 (new, new); 3 external calls (to_path_buf, with_capacity, with_capacity).


##### `StreamCore::push_delta`  (lines 129–145)

```
fn push_delta(&mut self, delta: &str) -> bool
```

**Purpose**: Accepts an incremental source delta, commits only complete newline-terminated source into the canonical raw buffer, re-renders, and queues any newly stable lines.

**Data flow**: It takes `&str delta`, marks `state.has_seen_delta` when non-empty, pushes the delta into the collector, and if the delta contains a newline and the collector can commit complete source, appends that committed source to `raw_source`, feeds it to `holdback_scanner`, recomputes `rendered_lines`, syncs the stable queue, and returns whether any lines were enqueued.

**Call relations**: This is the ingestion path used by both controller wrappers via their `push` methods.

*Call graph*: calls 3 internal fn (recompute_streaming_render, sync_stable_queue, push_source_chunk); called by 2 (push, push).


##### `StreamCore::finalize_remaining`  (lines 154–166)

```
fn finalize_remaining(&mut self) -> Vec<HyperlinkLine>
```

**Purpose**: Drains any remaining uncommitted source, renders the final canonical snapshot, and returns the rendered lines that have not yet been emitted.

**Data flow**: It finalizes and drains the collector’s remaining source, appends any remainder to `raw_source`, updates the holdback scanner, renders the full `raw_source` through `render_source`, and returns either an empty vector if everything was already emitted or the suffix from `emitted_stable_len` onward.

**Call relations**: Both controller wrappers call this during `finalize` before consuming `raw_source` and resetting state.

*Call graph*: calls 2 internal fn (render_source, push_source_chunk); called by 2 (finalize, finalize); 1 external calls (new).


##### `StreamCore::tick`  (lines 169–173)

```
fn tick(&mut self) -> Vec<HyperlinkLine>
```

**Purpose**: Dequeues one queued stable line from the animation queue and updates the emitted count.

**Data flow**: It calls `self.state.step()`, adds the number of returned lines to `emitted_stable_len`, and returns the drained `Vec<HyperlinkLine>`.

**Call relations**: It is used by both controller wrappers’ single-line commit-tick methods.

*Call graph*: calls 1 internal fn (step); called by 2 (on_commit_tick, on_commit_tick).


##### `StreamCore::tick_batch`  (lines 176–186)

```
fn tick_batch(&mut self, max_lines: usize) -> Vec<HyperlinkLine>
```

**Purpose**: Dequeues up to `max_lines` queued stable lines and updates the emitted count.

**Data flow**: It returns an empty vector immediately for `max_lines == 0`; otherwise it calls `self.state.drain_n(max_lines)`, increments `emitted_stable_len` by the drained length when non-empty, and returns the drained lines.

**Call relations**: It is used by both controller wrappers’ batch commit-tick methods.

*Call graph*: calls 1 internal fn (drain_n); called by 2 (on_commit_tick_batch, on_commit_tick_batch); 1 external calls (new).


##### `StreamCore::is_idle`  (lines 192–194)

```
fn is_idle(&self) -> bool
```

**Purpose**: Reports whether the underlying stream state has no queued work and no active collector activity.

**Data flow**: It delegates directly to `self.state.is_idle()` and returns the boolean result.

**Call relations**: Both controller wrappers use this after each tick to report post-drain idle state.

*Call graph*: calls 1 internal fn (is_idle); called by 4 (on_commit_tick, on_commit_tick_batch, on_commit_tick, on_commit_tick_batch).


##### `StreamCore::queued_lines`  (lines 197–199)

```
fn queued_lines(&self) -> usize
```

**Purpose**: Returns the number of stable lines currently waiting in the animation queue.

**Data flow**: It delegates to `self.state.queued_len()`.

**Call relations**: This feeds queue-pressure sampling and various tests.

*Call graph*: calls 1 internal fn (queued_len); called by 2 (queued_lines, queued_lines).


##### `StreamCore::oldest_queued_age`  (lines 202–204)

```
fn oldest_queued_age(&self, now: Instant) -> Option<Duration>
```

**Purpose**: Returns the age of the oldest queued stable line at the given instant.

**Data flow**: It delegates to `self.state.oldest_queued_age(now)` and returns `Option<Duration>`.

**Call relations**: Commit-tick orchestration uses this for adaptive chunking decisions.

*Call graph*: calls 1 internal fn (oldest_queued_age); called by 2 (oldest_queued_age, oldest_queued_age).


##### `StreamCore::current_tail_lines`  (lines 214–217)

```
fn current_tail_lines(&self) -> Vec<HyperlinkLine>
```

**Purpose**: Returns the mutable tail region of the current render snapshot that has not yet been enqueued as stable.

**Data flow**: It computes `start = min(enqueued_stable_len, rendered_lines.len())` and clones `rendered_lines[start..]` into a new vector.

**Call relations**: Both controller wrappers expose this to the UI so the live tail can be shown separately from queued scrollback.

*Call graph*: called by 2 (current_tail_lines, current_tail_lines).


##### `StreamCore::has_tail`  (lines 220–222)

```
fn has_tail(&self) -> bool
```

**Purpose**: Reports whether the current render snapshot contains any mutable tail beyond the stable boundary.

**Data flow**: It compares `enqueued_stable_len < rendered_lines.len()` and returns the result.

**Call relations**: This is used by wrapper accessors and by resize/render-mode logic to decide whether a live tail must be preserved.

*Call graph*: called by 4 (has_live_tail, has_live_tail, set_render_mode, set_width).


##### `StreamCore::set_width`  (lines 233–265)

```
fn set_width(&mut self, width: Option<usize>)
```

**Purpose**: Re-renders the stream at a new width and rebuilds queue state so emitted content stays emitted while pending content remains drainable.

**Data flow**: It takes an optional width, returns early if unchanged, records whether there was a pending queue or live tail, updates `self.width` and the collector width, returns early if `raw_source` is empty, re-renders, clamps `emitted_stable_len` to the new render length, backs it up by one line when wrapped pending content compressed into fewer lines, clears the queue, and either marks all lines as already enqueued or rebuilds the stable queue from the new render.

**Call relations**: It is exposed through both controller wrappers and is heavily exercised by resize tests.

*Call graph*: calls 5 internal fn (clear_queue, queued_len, has_tail, rebuild_stable_queue_from_render, recompute_streaming_render); called by 2 (set_width, set_width).


##### `StreamCore::reset`  (lines 268–276)

```
fn reset(&mut self)
```

**Purpose**: Clears all per-stream state so the core can be reused for the next answer or plan stream.

**Data flow**: It clears `state`, empties `raw_source` and `rendered_lines`, resets stable/emitted counters, drops the stable-prefix cache, and resets the holdback scanner.

**Call relations**: Both wrapper `finalize` methods call this after consuming the final source.

*Call graph*: calls 2 internal fn (clear, reset); called by 2 (finalize, finalize).


##### `StreamCore::render_source`  (lines 278–287)

```
fn render_source(&self, source: &str) -> Vec<HyperlinkLine>
```

**Purpose**: Renders source text into hyperlink-aware lines according to the current render mode.

**Data flow**: It takes `&str source`; in `HistoryRenderMode::Rich` it calls `render_markdown_agent_with_links_and_cwd(source, width, Some(cwd))`, while in `Raw` mode it converts `raw_lines_from_source(source)` through `plain_hyperlink_lines`; it returns the resulting `Vec<HyperlinkLine>`.

**Call relations**: It is the shared rendering primitive used by finalization and full re-render recomputation.

*Call graph*: calls 3 internal fn (raw_lines_from_source, render_markdown_agent_with_links_and_cwd, plain_hyperlink_lines); called by 2 (finalize_remaining, recompute_streaming_render); 1 external calls (as_path).


##### `StreamCore::recompute_streaming_render`  (lines 289–291)

```
fn recompute_streaming_render(&mut self)
```

**Purpose**: Refreshes the cached rendered snapshot from the current raw source.

**Data flow**: It calls `render_source(&self.raw_source)` and stores the result in `self.rendered_lines`.

**Call relations**: It is invoked after committed source changes, width changes, and render-mode changes.

*Call graph*: calls 1 internal fn (render_source); called by 3 (push_delta, set_render_mode, set_width).


##### `StreamCore::set_render_mode`  (lines 293–319)

```
fn set_render_mode(&mut self, render_mode: HistoryRenderMode)
```

**Purpose**: Switches between rich markdown rendering and raw rendering while preserving emitted-vs-pending semantics.

**Data flow**: It takes a new `HistoryRenderMode`, returns early if unchanged, records whether there was pending queue or live tail, updates `self.render_mode`, returns early if `raw_source` is empty, re-renders, clamps and possibly backs up `emitted_stable_len` similarly to `set_width`, clears the queue, and either marks everything emitted or rebuilds the stable queue from the new render.

**Call relations**: Both controller wrappers expose this so higher-level UI code can toggle render mode mid-stream.

*Call graph*: calls 5 internal fn (clear_queue, queued_len, has_tail, rebuild_stable_queue_from_render, recompute_streaming_render); called by 2 (set_render_mode, set_render_mode).


##### `StreamCore::compute_target_stable_len`  (lines 322–328)

```
fn compute_target_stable_len(&mut self) -> usize
```

**Purpose**: Computes how many rendered lines should currently belong to the stable region rather than the mutable tail.

**Data flow**: It asks `active_tail_budget_lines()` how many lines must remain mutable, subtracts that from `rendered_lines.len()`, and ensures the result is at least `emitted_stable_len`.

**Call relations**: This helper is used by both queue-sync and queue-rebuild paths.

*Call graph*: calls 1 internal fn (active_tail_budget_lines); called by 2 (rebuild_stable_queue_from_render, sync_stable_queue).


##### `StreamCore::sync_stable_queue`  (lines 332–356)

```
fn sync_stable_queue(&mut self) -> bool
```

**Purpose**: Advances or rebuilds the queued stable region to match the current target stable boundary after a new committed delta.

**Data flow**: It computes `target_stable_len`, and if that target moved backward it clears the queue and re-enqueues the range from `emitted_stable_len` to the new target. If the target is unchanged it returns false. Otherwise it enqueues the newly stable suffix from `enqueued_stable_len` to `target_stable_len`, updates `enqueued_stable_len`, and returns whether anything was queued.

**Call relations**: It is called from `push_delta` after each committed-source re-render.

*Call graph*: calls 4 internal fn (clear_queue, enqueue, queued_len, compute_target_stable_len); called by 1 (push_delta).


##### `StreamCore::rebuild_stable_queue_from_render`  (lines 363–371)

```
fn rebuild_stable_queue_from_render(&mut self)
```

**Purpose**: Reconstructs the queued stable region from the current render snapshot, typically after width or render-mode changes invalidated the old queue.

**Data flow**: It computes `target_stable_len`, clears the queue, enqueues the range from `emitted_stable_len` to `target_stable_len` when non-empty, and sets `enqueued_stable_len = target_stable_len`.

**Call relations**: It is used by `set_width` and `set_render_mode` after a full re-render.

*Call graph*: calls 3 internal fn (clear_queue, enqueue, compute_target_stable_len); called by 2 (set_render_mode, set_width).


##### `StreamCore::active_tail_budget_lines`  (lines 381–401)

```
fn active_tail_budget_lines(&mut self) -> usize
```

**Purpose**: Determines how many rendered lines must remain mutable because of active table holdback.

**Data flow**: It returns 0 immediately in raw render mode. Otherwise it reads the current `TableHoldbackState` from `holdback_scanner`, maps `Confirmed { table_start }` and `PendingHeader { header_start }` to `tail_budget_from_source_start(start)`, maps `None` to 0, emits a trace log with timing and state, and returns the tail budget.

**Call relations**: This is the key bridge between holdback detection and stable-queue sizing, used by `compute_target_stable_len`.

*Call graph*: calls 2 internal fn (tail_budget_from_source_start, state); called by 1 (compute_target_stable_len); 2 external calls (now, trace!).


##### `StreamCore::tail_budget_from_source_start`  (lines 408–415)

```
fn tail_budget_from_source_start(&mut self, source_start: usize) -> usize
```

**Purpose**: Converts a raw-source byte offset marking the start of a mutable table region into a rendered-line tail budget.

**Data flow**: It takes `source_start`, returns the full render length when the start is 0, otherwise clamps the offset to `raw_source.len()`, computes the rendered stable-prefix length before that offset, and returns `rendered_lines.len() - stable_prefix_len` with saturation.

**Call relations**: It is called by `active_tail_budget_lines` for both pending and confirmed table holdback states.

*Call graph*: calls 1 internal fn (stable_prefix_len_for_source_start); called by 1 (active_tail_budget_lines).


##### `StreamCore::stable_prefix_len_for_source_start`  (lines 422–456)

```
fn stable_prefix_len_for_source_start(&mut self, source_start: usize) -> usize
```

**Purpose**: Renders the source prefix before a candidate table start and caches its rendered line count for repeated holdback calculations.

**Data flow**: It takes `source_start`, first checks `stable_prefix_len_cache` for a matching `(source_start, width)` entry and returns the cached count on hit. On miss it renders `raw_source[..source_start]` with `render_markdown_agent_with_links_and_cwd`, records the resulting line count plus cache key, emits a trace log with timing, and returns the count.

**Call relations**: It is only used by `tail_budget_from_source_start`, and the cache is important during dense table streaming where the same prefix is queried repeatedly.

*Call graph*: calls 1 internal fn (render_markdown_agent_with_links_and_cwd); called by 1 (tail_budget_from_source_start); 3 external calls (now, as_path, trace!).


##### `StreamController::new`  (lines 473–478)

```
fn new(width: Option<usize>, cwd: &Path, render_mode: HistoryRenderMode) -> Self
```

**Purpose**: Constructs the main agent-message streaming controller around a fresh `StreamCore`.

**Data flow**: It takes optional width, cwd, and render mode, creates `StreamCore::new(...)`, initializes `header_emitted = false`, and returns the controller.

**Call relations**: Higher-level answer-stream handling creates this controller for agent message streaming.

*Call graph*: calls 1 internal fn (new); called by 4 (handle_streaming_delta, flush_answer_stream_keeps_default_reflow_for_plain_text_tail, flush_answer_stream_requests_scrollback_reflow_for_live_table_tail, stream_controller).


##### `StreamController::push`  (lines 480–482)

```
fn push(&mut self, delta: &str) -> bool
```

**Purpose**: Feeds a source delta into the main stream controller and reports whether any stable lines were queued.

**Data flow**: It takes `&str delta`, forwards to `self.core.push_delta(delta)`, and returns the boolean result.

**Call relations**: This is the wrapper entry point used by answer-stream ingestion.

*Call graph*: calls 1 internal fn (push_delta).


##### `StreamController::finalize`  (lines 486–498)

```
fn finalize(&mut self) -> (Option<Box<dyn HistoryCell>>, Option<String>)
```

**Purpose**: Finalizes the main stream, emits any remaining rendered content as a history cell, and returns the consumed raw markdown source for transcript consolidation.

**Data flow**: It asks `core.finalize_remaining()` for un-emitted lines, returns `(None, None)` after reset if `raw_source` is empty, otherwise `take`s ownership of `core.raw_source`, emits the remaining lines through `emit`, resets the core, and returns `(cell_opt, Some(source))`.

**Call relations**: This is called when an answer stream ends; it consumes the source before reset so transcript consolidation can use the canonical markdown.

*Call graph*: calls 3 internal fn (emit, finalize_remaining, reset); 1 external calls (take).


##### `StreamController::on_commit_tick`  (lines 500–503)

```
fn on_commit_tick(&mut self) -> (Option<Box<dyn HistoryCell>>, bool)
```

**Purpose**: Drains one queued stable step from the main stream and wraps it as an agent-message history cell.

**Data flow**: It calls `core.tick()`, passes the drained lines to `emit`, queries `core.is_idle()`, and returns `(cell_opt, idle_bool)`.

**Call relations**: Commit-tick orchestration uses this for `DrainPlan::Single`.

*Call graph*: calls 3 internal fn (emit, is_idle, tick); called by 1 (drain_stream_controller).


##### `StreamController::on_commit_tick_batch`  (lines 505–511)

```
fn on_commit_tick_batch(
        &mut self,
        max_lines: usize,
    ) -> (Option<Box<dyn HistoryCell>>, bool)
```

**Purpose**: Drains up to `max_lines` queued stable lines from the main stream and wraps them as an agent-message history cell.

**Data flow**: It calls `core.tick_batch(max_lines)`, emits the drained lines, queries idle state, and returns `(cell_opt, idle_bool)`.

**Call relations**: Commit-tick orchestration uses this for `DrainPlan::Batch`.

*Call graph*: calls 3 internal fn (emit, is_idle, tick_batch); called by 1 (drain_stream_controller).


##### `StreamController::queued_lines`  (lines 517–519)

```
fn queued_lines(&self) -> usize
```

**Purpose**: Exposes the main stream’s queued stable line count.

**Data flow**: It delegates to `core.queued_lines()`.

**Call relations**: This is used by queue-pressure sampling and tests.

*Call graph*: calls 1 internal fn (queued_lines).


##### `StreamController::oldest_queued_age`  (lines 521–523)

```
fn oldest_queued_age(&self, now: Instant) -> Option<Duration>
```

**Purpose**: Exposes the age of the oldest queued stable line in the main stream.

**Data flow**: It delegates to `core.oldest_queued_age(now)`.

**Call relations**: Commit-tick orchestration uses this when building combined queue snapshots.

*Call graph*: calls 1 internal fn (oldest_queued_age).


##### `StreamController::current_tail_lines`  (lines 526–528)

```
fn current_tail_lines(&self) -> Vec<HyperlinkLine>
```

**Purpose**: Exposes the current mutable tail lines for live rendering.

**Data flow**: It delegates to `core.current_tail_lines()`.

**Call relations**: The UI uses this to show in-flight content that has not yet been committed to scrollback.

*Call graph*: calls 1 internal fn (current_tail_lines).


##### `StreamController::tail_starts_stream`  (lines 531–533)

```
fn tail_starts_stream(&self) -> bool
```

**Purpose**: Reports whether the current tail begins at the very start of the stream before any header-emitted stable content exists.

**Data flow**: It returns `!self.header_emitted && self.core.enqueued_stable_len == 0`.

**Call relations**: This helps higher-level rendering decide whether the live tail should visually start a new stream block.


##### `StreamController::has_live_tail`  (lines 536–538)

```
fn has_live_tail(&self) -> bool
```

**Purpose**: Reports whether the main stream currently has any mutable tail content.

**Data flow**: It delegates to `core.has_tail()`.

**Call relations**: This is used by UI logic and tests, especially around table holdback and resize behavior.

*Call graph*: calls 1 internal fn (has_tail).


##### `StreamController::clear_queue`  (lines 540–543)

```
fn clear_queue(&mut self)
```

**Purpose**: Drops any queued stable lines while preserving the already emitted boundary.

**Data flow**: It clears `core.state`’s queue and sets `core.enqueued_stable_len = core.emitted_stable_len`.

**Call relations**: This is an imperative escape hatch for higher-level code that wants to discard pending queued output.


##### `StreamController::set_width`  (lines 545–547)

```
fn set_width(&mut self, width: Option<usize>)
```

**Purpose**: Updates the main stream’s render width and rebuilds queue/tail state accordingly.

**Data flow**: It forwards the new width to `core.set_width(width)`.

**Call relations**: Higher-level resize handling calls this on terminal width changes.

*Call graph*: calls 1 internal fn (set_width).


##### `StreamController::set_render_mode`  (lines 549–551)

```
fn set_render_mode(&mut self, render_mode: HistoryRenderMode)
```

**Purpose**: Switches the main stream between rich and raw rendering modes.

**Data flow**: It forwards the new mode to `core.set_render_mode(render_mode)`.

**Call relations**: This is used when the transcript view toggles render mode mid-stream.

*Call graph*: calls 1 internal fn (set_render_mode).


##### `StreamController::emit`  (lines 553–564)

```
fn emit(&mut self, lines: Vec<HyperlinkLine>) -> Option<Box<dyn HistoryCell>>
```

**Purpose**: Wraps rendered hyperlink lines into an `AgentMessageCell`, marking whether this is the first emitted chunk of the stream.

**Data flow**: It takes a vector of `HyperlinkLine`, returns `None` if empty, otherwise constructs `history_cell::AgentMessageCell::new_hyperlink_lines(lines, first_chunk_flag)`, flips `header_emitted` to true, boxes the cell, and returns it.

**Call relations**: It is the final formatting step used by `finalize`, `on_commit_tick`, and `on_commit_tick_batch`.

*Call graph*: calls 1 internal fn (new_hyperlink_lines); called by 3 (finalize, on_commit_tick, on_commit_tick_batch); 1 external calls (new).


##### `PlanStreamController::new`  (lines 586–592)

```
fn new(width: Option<usize>, cwd: &Path, render_mode: HistoryRenderMode) -> Self
```

**Purpose**: Constructs the proposed-plan streaming controller around a fresh `StreamCore` plus plan-specific header/padding flags.

**Data flow**: It takes optional width, cwd, and render mode, creates `StreamCore::new(...)`, initializes `header_emitted = false` and `top_padding_emitted = false`, and returns the controller.

**Call relations**: Higher-level plan-stream handling creates this controller for proposed-plan output.

*Call graph*: calls 1 internal fn (new); called by 5 (on_plan_delta, completed_token_activity_refresh_retries_after_plan_item_completion, completed_plan_table_tail_skips_provisional_history_insert, finalized_plan_stream_preserves_semantic_url_fragments, plan_stream_controller).


##### `PlanStreamController::push`  (lines 594–596)

```
fn push(&mut self, delta: &str) -> bool
```

**Purpose**: Feeds a source delta into the plan stream controller and reports whether any stable lines were queued.

**Data flow**: It forwards the delta to `core.push_delta(delta)` and returns the boolean result.

**Call relations**: This is the ingestion path for incremental plan markdown.

*Call graph*: calls 1 internal fn (push_delta).


##### `PlanStreamController::finalize`  (lines 600–612)

```
fn finalize(&mut self) -> (Option<Box<dyn HistoryCell>>, Option<String>)
```

**Purpose**: Finalizes the plan stream, emits any remaining content with bottom padding, and returns the consumed raw markdown source.

**Data flow**: It gets remaining lines from `core.finalize_remaining()`, returns `(None, None)` after reset if `raw_source` is empty, otherwise takes ownership of `core.raw_source`, emits the remaining lines through `emit(..., true)`, resets the core, and returns `(cell_opt, Some(source))`.

**Call relations**: This mirrors `StreamController::finalize` but includes plan-block closing padding.

*Call graph*: calls 3 internal fn (emit, finalize_remaining, reset); 1 external calls (take).


##### `PlanStreamController::on_commit_tick`  (lines 614–620)

```
fn on_commit_tick(&mut self) -> (Option<Box<dyn HistoryCell>>, bool)
```

**Purpose**: Drains one queued stable step from the plan stream and wraps it as a proposed-plan history cell without bottom padding.

**Data flow**: It calls `core.tick()`, emits the drained lines with `include_bottom_padding = false`, queries idle state, and returns `(cell_opt, idle_bool)`.

**Call relations**: Commit-tick orchestration uses this for single-line plan draining.

*Call graph*: calls 3 internal fn (emit, is_idle, tick); called by 1 (drain_plan_stream_controller).


##### `PlanStreamController::on_commit_tick_batch`  (lines 622–631)

```
fn on_commit_tick_batch(
        &mut self,
        max_lines: usize,
    ) -> (Option<Box<dyn HistoryCell>>, bool)
```

**Purpose**: Drains up to `max_lines` queued stable lines from the plan stream and wraps them as a proposed-plan history cell without bottom padding.

**Data flow**: It calls `core.tick_batch(max_lines)`, emits the drained lines with no bottom padding, queries idle state, and returns `(cell_opt, idle_bool)`.

**Call relations**: Commit-tick orchestration uses this for batch plan draining.

*Call graph*: calls 3 internal fn (emit, is_idle, tick_batch); called by 1 (drain_plan_stream_controller).


##### `PlanStreamController::queued_lines`  (lines 634–636)

```
fn queued_lines(&self) -> usize
```

**Purpose**: Exposes the plan stream’s queued stable line count.

**Data flow**: It delegates to `core.queued_lines()`.

**Call relations**: This contributes to combined queue-pressure sampling.

*Call graph*: calls 1 internal fn (queued_lines).


##### `PlanStreamController::has_live_tail`  (lines 639–641)

```
fn has_live_tail(&self) -> bool
```

**Purpose**: Reports whether the plan stream currently has mutable tail content.

**Data flow**: It delegates to `core.has_tail()`.

**Call relations**: UI logic and tests use this around plan-table holdback behavior.

*Call graph*: calls 1 internal fn (has_tail).


##### `PlanStreamController::current_tail_lines`  (lines 644–646)

```
fn current_tail_lines(&self) -> Vec<HyperlinkLine>
```

**Purpose**: Exposes the raw mutable tail lines of the plan stream before plan-block decoration is applied.

**Data flow**: It delegates to `core.current_tail_lines()`.

**Call relations**: It is used directly and also by `current_tail_display_lines`.

*Call graph*: calls 1 internal fn (current_tail_lines); called by 1 (current_tail_display_lines).


##### `PlanStreamController::tail_starts_stream`  (lines 649–651)

```
fn tail_starts_stream(&self) -> bool
```

**Purpose**: Reports whether the current plan tail begins at the start of the stream before any plan header has been emitted.

**Data flow**: It returns `!self.header_emitted && self.core.enqueued_stable_len == 0`.

**Call relations**: This mirrors the main stream controller’s stream-start tail check.


##### `PlanStreamController::current_tail_display_lines`  (lines 653–659)

```
fn current_tail_display_lines(&self) -> Vec<HyperlinkLine>
```

**Purpose**: Returns the current plan tail decorated with plan header/indentation styling as it should appear live in the UI.

**Data flow**: It fetches `current_tail_lines()`, returns an empty vector if there are none, otherwise passes them to `render_display_lines(..., false)` and returns the decorated lines.

**Call relations**: This is the plan-specific live-tail rendering helper used by higher-level UI code.

*Call graph*: calls 2 internal fn (current_tail_lines, render_display_lines); 1 external calls (new).


##### `PlanStreamController::oldest_queued_age`  (lines 661–663)

```
fn oldest_queued_age(&self, now: Instant) -> Option<Duration>
```

**Purpose**: Exposes the age of the oldest queued stable line in the plan stream.

**Data flow**: It delegates to `core.oldest_queued_age(now)`.

**Call relations**: Commit-tick orchestration uses this when combining queue snapshots.

*Call graph*: calls 1 internal fn (oldest_queued_age).


##### `PlanStreamController::clear_queue`  (lines 665–668)

```
fn clear_queue(&mut self)
```

**Purpose**: Drops any queued stable plan lines while preserving the already emitted boundary.

**Data flow**: It clears `core.state`’s queue and sets `core.enqueued_stable_len = core.emitted_stable_len`.

**Call relations**: This mirrors the main stream controller’s queue-clearing escape hatch.


##### `PlanStreamController::set_width`  (lines 670–672)

```
fn set_width(&mut self, width: Option<usize>)
```

**Purpose**: Updates the plan stream’s render width and rebuilds queue/tail state accordingly.

**Data flow**: It forwards the width to `core.set_width(width)`.

**Call relations**: Higher-level resize handling calls this for plan streams.

*Call graph*: calls 1 internal fn (set_width).


##### `PlanStreamController::set_render_mode`  (lines 674–676)

```
fn set_render_mode(&mut self, render_mode: HistoryRenderMode)
```

**Purpose**: Switches the plan stream between rich and raw rendering modes.

**Data flow**: It forwards the mode to `core.set_render_mode(render_mode)`.

**Call relations**: This mirrors the main stream controller’s render-mode toggle.

*Call graph*: calls 1 internal fn (set_render_mode).


##### `PlanStreamController::emit`  (lines 678–696)

```
fn emit(
        &mut self,
        lines: Vec<HyperlinkLine>,
        include_bottom_padding: bool,
    ) -> Option<Box<dyn HistoryCell>>
```

**Purpose**: Wraps rendered lines into a styled proposed-plan history cell, optionally including bottom padding on finalization.

**Data flow**: It takes `Vec<HyperlinkLine>` and `include_bottom_padding`; returns `None` only when both the lines are empty and bottom padding is not requested. Otherwise it computes whether this is a continuation, decorates the lines with `render_display_lines`, marks header and top padding as emitted, constructs `history_cell::new_proposed_plan_stream(...)`, boxes it, and returns it.

**Call relations**: It is the final formatting step used by plan finalization and commit ticks.

*Call graph*: calls 1 internal fn (render_display_lines); called by 3 (finalize, on_commit_tick, on_commit_tick_batch); 2 external calls (new, new_proposed_plan_stream).


##### `PlanStreamController::render_display_lines`  (lines 698–727)

```
fn render_display_lines(
        &self,
        lines: Vec<HyperlinkLine>,
        include_bottom_padding: bool,
    ) -> Vec<HyperlinkLine>
```

**Purpose**: Applies plan-specific header, blank-line padding, indentation, and background styling to rendered markdown lines.

**Data flow**: It takes raw `HyperlinkLine`s plus a bottom-padding flag, prepends a `• Proposed Plan` header and spacer when the header has not yet been emitted, optionally inserts top and bottom blank lines around the plan body, prefixes each plan line with two-space margins via `prefix_hyperlink_lines`, applies `proposed_plan_style()` to each line, and returns the decorated vector.

**Call relations**: It is used by both `emit` and `current_tail_display_lines` so live tails and committed plan cells share the same visual framing.

*Call graph*: calls 3 internal fn (proposed_plan_style, new, prefix_hyperlink_lines); called by 2 (current_tail_display_lines, emit); 3 external calls (from, with_capacity, vec!).


##### `tests::test_cwd`  (lines 737–741)

```
fn test_cwd() -> PathBuf
```

**Purpose**: Provides a stable absolute cwd for streaming tests without hard-coding platform-specific roots.

**Data flow**: It returns `std::env::temp_dir()` as a `PathBuf`.

**Call relations**: This helper is used by the controller-construction test fixtures.

*Call graph*: 1 external calls (temp_dir).


##### `tests::stream_controller`  (lines 743–745)

```
fn stream_controller(width: Option<usize>) -> StreamController
```

**Purpose**: Constructs a rich-rendering `StreamController` test fixture at the requested width.

**Data flow**: It takes an optional width, calls `StreamController::new(width, &test_cwd(), HistoryRenderMode::Rich)`, and returns the controller.

**Call relations**: Most main-stream tests use this helper.

*Call graph*: calls 1 internal fn (new); 1 external calls (test_cwd).


##### `tests::plan_stream_controller`  (lines 747–749)

```
fn plan_stream_controller(width: Option<usize>) -> PlanStreamController
```

**Purpose**: Constructs a rich-rendering `PlanStreamController` test fixture at the requested width.

**Data flow**: It takes an optional width, calls `PlanStreamController::new(width, &test_cwd(), HistoryRenderMode::Rich)`, and returns the controller.

**Call relations**: Most plan-stream tests use this helper.

*Call graph*: calls 1 internal fn (new); 1 external calls (test_cwd).


##### `tests::lines_to_plain_strings`  (lines 751–762)

```
fn lines_to_plain_strings(lines: &[ratatui::text::Line<'_>]) -> Vec<String>
```

**Purpose**: Flattens `ratatui::Line` values into plain strings for assertions.

**Data flow**: It iterates each line’s spans, concatenates their content, and returns a `Vec<String>`.

**Call relations**: Many tests use this to compare rendered transcript output independent of styling.

*Call graph*: 1 external calls (iter).


##### `tests::hyperlink_lines_to_plain_strings`  (lines 764–766)

```
fn hyperlink_lines_to_plain_strings(lines: &[HyperlinkLine]) -> Vec<String>
```

**Purpose**: Converts `HyperlinkLine` values into visible plain strings by stripping hyperlink metadata.

**Data flow**: It clones the input lines, passes them through `visible_lines`, then flattens them with `lines_to_plain_strings`.

**Call relations**: Tests use this when comparing live-tail output against expected visible markdown rendering.

*Call graph*: calls 1 internal fn (visible_lines); 2 external calls (lines_to_plain_strings, to_vec).


##### `tests::collect_streamed_lines`  (lines 768–787)

```
fn collect_streamed_lines(deltas: &[&str], width: Option<usize>) -> Vec<String>
```

**Purpose**: Runs a sequence of deltas through a `StreamController`, draining commit ticks and finalization, and returns the visible transcript lines without the leading bullet prefix.

**Data flow**: It constructs a controller, pushes each delta, repeatedly drains `on_commit_tick()` until idle after each push, finalizes at the end, flattens transcript lines to strings, strips the first two characters from each line, and returns the collected vector.

**Call relations**: Many equivalence tests use this helper to compare streamed output against full markdown rendering.

*Call graph*: 3 external calls (new, lines_to_plain_strings, stream_controller).


##### `tests::collect_plan_streamed_lines`  (lines 789–805)

```
fn collect_plan_streamed_lines(deltas: &[&str], width: Option<usize>) -> Vec<String>
```

**Purpose**: Runs a sequence of deltas through a `PlanStreamController`, draining commit ticks and finalization, and returns the visible transcript lines.

**Data flow**: It constructs a plan controller, pushes each delta, drains `on_commit_tick()` until idle after each push, finalizes, flattens transcript lines to strings, and returns them.

**Call relations**: Plan-stream equivalence tests use this helper.

*Call graph*: 3 external calls (new, lines_to_plain_strings, plan_stream_controller).


##### `tests::controller_set_width_rebuilds_queued_lines`  (lines 808–827)

```
fn controller_set_width_rebuilds_queued_lines()
```

**Purpose**: Verifies that resizing before draining queued content rebuilds the queue using the new wrapping width.

**Data flow**: It pushes a long line at width 120, asserts one queued line, resizes to width 24, drains the batch, flattens transcript lines, and asserts the rendered output now spans multiple lines.

**Call relations**: This test targets `StreamCore::set_width` queue rebuild behavior.

*Call graph*: 4 external calls (assert!, assert_eq!, lines_to_plain_strings, stream_controller).


##### `tests::controller_set_width_no_duplicate_after_emit`  (lines 830–846)

```
fn controller_set_width_no_duplicate_after_emit()
```

**Purpose**: Checks that already emitted content is not re-queued after a resize.

**Data flow**: It pushes and fully emits a long line, asserts the queue is empty, resizes narrower, and asserts the queue remains empty.

**Call relations**: It guards against replaying emitted content during width changes.

*Call graph*: 3 external calls (assert!, assert_eq!, stream_controller).


##### `tests::controller_tick_batch_zero_is_noop`  (lines 849–862)

```
fn controller_tick_batch_zero_is_noop()
```

**Purpose**: Ensures a batch drain request of zero lines does not emit content or change queue state.

**Data flow**: It queues one line, calls `on_commit_tick_batch(0)`, and asserts no cell was emitted, idle is false, and queue depth is unchanged.

**Call relations**: This covers the explicit zero-batch fast path in `StreamCore::tick_batch`.

*Call graph*: 3 external calls (assert!, assert_eq!, stream_controller).


##### `tests::controller_has_live_tail_reflects_tail_presence`  (lines 865–875)

```
fn controller_has_live_tail_reflects_tail_presence()
```

**Purpose**: Checks that `has_live_tail` tracks whether rendered lines extend beyond the stable boundary.

**Data flow**: It mutates the controller’s internal `rendered_lines` and `enqueued_stable_len` directly and asserts `has_live_tail()` toggles accordingly.

**Call relations**: This is a focused unit test for the tail-presence predicate.

*Call graph*: 3 external calls (assert!, stream_controller, vec!).


##### `tests::plan_controller_has_live_tail_reflects_tail_presence`  (lines 878–888)

```
fn plan_controller_has_live_tail_reflects_tail_presence()
```

**Purpose**: Checks the same tail-presence behavior for the plan stream controller.

**Data flow**: It mutates the plan controller’s internal render snapshot and stable boundary and asserts `has_live_tail()` toggles accordingly.

**Call relations**: It mirrors the previous test for the plan wrapper.

*Call graph*: 3 external calls (assert!, plan_stream_controller, vec!).


##### `tests::controller_live_tail_keeps_uncommitted_table_cell_newline_gated`  (lines 891–902)

```
fn controller_live_tail_keeps_uncommitted_table_cell_newline_gated()
```

**Purpose**: Verifies that an unterminated partial table row does not appear in the live tail before a newline commits it.

**Data flow**: It pushes a table header, delimiter, and a partial row without newline, reads `current_tail_lines()`, joins them to plain strings, and asserts the partial content is absent.

**Call relations**: This test targets the newline-gated commit behavior in `push_delta`.

*Call graph*: 3 external calls (assert!, hyperlink_lines_to_plain_strings, stream_controller).


##### `tests::controller_live_tail_requires_table_holdback_state`  (lines 905–914)

```
fn controller_live_tail_requires_table_holdback_state()
```

**Purpose**: Checks that plain text without table holdback does not produce a live tail.

**Data flow**: It pushes plain text without a newline, then asserts `current_tail_lines()` is empty and `has_live_tail()` is false.

**Call relations**: It confirms that mutable tails are reserved for holdback scenarios rather than any incomplete text.

*Call graph*: 2 external calls (assert!, stream_controller).


##### `tests::controller_live_tail_rerenders_table_tail_after_resize`  (lines 917–942)

```
fn controller_live_tail_rerenders_table_tail_after_resize()
```

**Purpose**: Verifies that a live table tail is fully re-rendered at each new width rather than preserving stale wrapped lines.

**Data flow**: It streams a table into holdback state, repeatedly changes width, converts the current tail to plain strings, independently renders the full raw source at that width with `append_markdown_agent`, and asserts equality each time.

**Call relations**: This test exercises the source-backed re-render contract for mutable table tails.

*Call graph*: calls 1 internal fn (append_markdown_agent); 5 external calls (new, assert_eq!, hyperlink_lines_to_plain_strings, lines_to_plain_strings, stream_controller).


##### `tests::controller_set_width_partial_drain_no_lost_lines`  (lines 945–968)

```
fn controller_set_width_partial_drain_no_lost_lines()
```

**Purpose**: Checks that resizing after partially draining queued content does not lose still-pending lines by finalization time.

**Data flow**: It queues wrapped content plus a second line, drains one tick, resizes narrower, finalizes, and asserts the final transcript still contains `second line` and returns source.

**Call relations**: It guards against pending-content loss during width remapping.

*Call graph*: 2 external calls (assert!, stream_controller).


##### `tests::controller_set_width_partial_drain_keeps_pending_queue`  (lines 971–1003)

```
fn controller_set_width_partial_drain_keeps_pending_queue()
```

**Purpose**: Ensures pending queued lines remain queued and continue draining after a resize that occurs mid-stream.

**Data flow**: It queues two lines, drains one tick, resizes narrower, asserts queue depth stays positive, then drains until idle and asserts the drained output still contains `second line`.

**Call relations**: This complements the previous test by checking continued incremental draining rather than only finalization.

*Call graph*: 4 external calls (new, assert!, lines_to_plain_strings, stream_controller).


##### `tests::controller_set_width_preserves_in_flight_tail`  (lines 1006–1019)

```
fn controller_set_width_preserves_in_flight_tail()
```

**Purpose**: Verifies that an uncommitted non-table tail survives a resize and appears in the final output.

**Data flow**: It pushes text without newline, resizes, finalizes, flattens transcript lines, and asserts the final output equals a single bullet-prefixed line containing the tail text.

**Call relations**: It covers resize behavior for collector-held tail content rather than queued stable lines.

*Call graph*: 3 external calls (assert_eq!, lines_to_plain_strings, stream_controller).


##### `tests::controller_set_width_preserves_table_tail_when_queue_is_empty`  (lines 1022–1050)

```
fn controller_set_width_preserves_table_tail_when_queue_is_empty()
```

**Purpose**: Checks that a mutable table tail is preserved across resize even when there are no queued stable lines left.

**Data flow**: It streams and drains an intro line, pushes a table header that remains in holdback, asserts queue depth is zero and live tail exists, resizes, then asserts the tail still contains the table header content.

**Call relations**: This targets the `had_live_tail` branch in `set_width`.

*Call graph*: 4 external calls (assert!, assert_eq!, hyperlink_lines_to_plain_strings, stream_controller).


##### `tests::plan_controller_set_width_preserves_in_flight_tail`  (lines 1053–1072)

```
fn plan_controller_set_width_preserves_in_flight_tail()
```

**Purpose**: Verifies that an uncommitted plan tail survives a resize and appears in the finalized plan output.

**Data flow**: It pushes a plan item without newline, resizes, finalizes, flattens transcript lines, and asserts some line still contains the item text.

**Call relations**: It mirrors the main-stream in-flight-tail resize test for plan streams.

*Call graph*: 3 external calls (assert!, lines_to_plain_strings, plan_stream_controller).


##### `tests::plan_controller_holds_table_header_as_live_tail`  (lines 1075–1086)

```
fn plan_controller_holds_table_header_as_live_tail()
```

**Purpose**: Checks that a plan-stream table header is held as mutable tail rather than queued immediately.

**Data flow**: It drains an intro line, pushes a table header, asserts `push` returned false and `has_live_tail()` is true.

**Call relations**: It confirms that table holdback applies equally to plan streams.

*Call graph*: 2 external calls (assert!, plan_stream_controller).


##### `tests::controller_loose_vs_tight_with_commit_ticks_matches_full`  (lines 1089–1205)

```
fn controller_loose_vs_tight_with_commit_ticks_matches_full()
```

**Purpose**: Verifies that incrementally streamed markdown with loose and tight list structures matches the final full markdown render exactly.

**Data flow**: It pushes many small deltas through a controller, drains commit ticks after each, finalizes, strips bullet prefixes, renders the concatenated source with `append_markdown_agent`, and asserts both the streamed output and an explicit expected line list.

**Call relations**: This is a broad regression test for incremental markdown correctness outside table-specific logic.

*Call graph*: calls 1 internal fn (append_markdown_agent); 5 external calls (new, assert_eq!, lines_to_plain_strings, stream_controller, vec!).


##### `tests::controller_streamed_table_matches_full_render_widths`  (lines 1208–1224)

```
fn controller_streamed_table_matches_full_render_widths()
```

**Purpose**: Checks that a streamed pipe table produces the same final visible lines as rendering the full source at once.

**Data flow**: It streams a small table through `collect_streamed_lines`, renders the concatenated source with `append_markdown_agent`, and asserts equality.

**Call relations**: It validates the core table-holdback-and-finalization behavior.

*Call graph*: calls 1 internal fn (append_markdown_agent); 5 external calls (new, assert_eq!, collect_streamed_lines, lines_to_plain_strings, vec!).


##### `tests::controller_holds_blockquoted_table_tail_until_stable`  (lines 1227–1243)

```
fn controller_holds_blockquoted_table_tail_until_stable()
```

**Purpose**: Verifies that blockquoted tables are also held mutable until stable and finalize to the same output as a full render.

**Data flow**: It streams a blockquoted table, collects streamed lines, renders the full source, and asserts equality.

**Call relations**: It extends table holdback coverage to blockquoted markdown.

*Call graph*: calls 1 internal fn (append_markdown_agent); 5 external calls (new, assert_eq!, collect_streamed_lines, lines_to_plain_strings, vec!).


##### `tests::controller_keeps_pre_table_lines_queued_when_table_is_confirmed`  (lines 1246–1271)

```
fn controller_keeps_pre_table_lines_queued_when_table_is_confirmed()
```

**Purpose**: Checks that prose before a confirmed table remains independently queueable and can commit while the table stays mutable.

**Data flow**: It queues an intro line, then confirms a table with header and delimiter, asserts queue depth remains one, drains one tick, and asserts the committed cell contains the intro line and the controller is idle afterward.

**Call relations**: It targets the stable-prefix/tail split once table holdback begins.

*Call graph*: 3 external calls (assert!, assert_eq!, stream_controller).


##### `tests::controller_set_width_during_confirmed_table_stream_matches_finalize_render`  (lines 1274–1307)

```
fn controller_set_width_during_confirmed_table_stream_matches_finalize_render()
```

**Purpose**: Verifies that resizing during a confirmed table stream still yields final output identical to a full render at the new width.

**Data flow**: It streams a table at width 120, asserts nothing is queued because the table is mutable, resizes to width 32, finalizes, strips bullet prefixes, renders the final source at width 32, and asserts equality.

**Call relations**: It combines table holdback with width remapping and finalization.

*Call graph*: calls 1 internal fn (append_markdown_agent); 4 external calls (new, assert_eq!, lines_to_plain_strings, stream_controller).


##### `tests::controller_does_not_hold_back_pipe_prose_without_table_delimiter`  (lines 1310–1323)

```
fn controller_does_not_hold_back_pipe_prose_without_table_delimiter()
```

**Purpose**: Checks that prose containing pipes but no following table delimiter is not indefinitely held back as a speculative table.

**Data flow**: It pushes a pipe-containing prose line and drains it, then pushes another line and asserts a commit occurs.

**Call relations**: It guards against false-positive table holdback on ordinary pipe prose.

*Call graph*: 2 external calls (assert!, stream_controller).


##### `tests::controller_does_not_stall_repeated_pipe_prose_paragraphs`  (lines 1326–1345)

```
fn controller_does_not_stall_repeated_pipe_prose_paragraphs()
```

**Purpose**: Ensures repeated paragraphs containing pipes continue streaming and do not stall due to speculative table detection.

**Data flow**: It pushes one pipe-prose paragraph and drains it, pushes a second, drains again, and asserts the second commit includes the first paragraph.

**Call relations**: It further protects against holdback false positives across paragraph boundaries.

*Call graph*: 2 external calls (assert!, stream_controller).


##### `tests::controller_handles_table_immediately_after_heading`  (lines 1348–1366)

```
fn controller_handles_table_immediately_after_heading()
```

**Purpose**: Verifies correct streaming when a table begins immediately after a heading.

**Data flow**: It streams a heading followed by a table, collects streamed lines, renders the full source, and asserts equality.

**Call relations**: It covers a common markdown shape where table detection starts right after another block element.

*Call graph*: calls 1 internal fn (append_markdown_agent); 5 external calls (new, assert_eq!, collect_streamed_lines, lines_to_plain_strings, vec!).


##### `tests::controller_renders_separators_for_multi_table_response_shape`  (lines 1369–1388)

```
fn controller_renders_separators_for_multi_table_response_shape()
```

**Purpose**: Checks that streamed output for a complex multi-table response includes rendered table separators rather than leaving raw markdown headers.

**Data flow**: It splits a long source into newline-inclusive chunks, streams them, and asserts at least one output line contains the heavy separator character `━`.

**Call relations**: This is a broad regression test for table conversion in realistic multi-table responses.

*Call graph*: 2 external calls (assert!, collect_streamed_lines).


##### `tests::controller_renders_separators_for_no_outer_pipes_table_shape`  (lines 1391–1418)

```
fn controller_renders_separators_for_no_outer_pipes_table_shape()
```

**Purpose**: Verifies that no-outer-pipes markdown tables are recognized, converted, and matched against full rendering.

**Data flow**: It streams a source containing both standard and no-outer-pipes tables, compares streamed output to full rendering, and asserts the raw no-outer header is absent while separator characters are present.

**Call relations**: It covers the more permissive table-detection path for markdown tables without outer pipes.

*Call graph*: calls 1 internal fn (append_markdown_agent); 5 external calls (new, assert!, assert_eq!, collect_streamed_lines, lines_to_plain_strings).


##### `tests::controller_stabilizes_first_no_outer_pipes_table_in_response`  (lines 1421–1449)

```
fn controller_stabilizes_first_no_outer_pipes_table_in_response()
```

**Purpose**: Checks that a response beginning with a no-outer-pipes table stabilizes correctly and matches full rendering.

**Data flow**: It streams a heading plus no-outer-pipes table and trailing paragraph, compares streamed output to full rendering, and asserts separators are present while the raw header is absent.

**Call relations**: It targets no-outer-pipes detection when that table is the first table-like structure in the response.

*Call graph*: calls 1 internal fn (append_markdown_agent); 6 external calls (new, assert!, assert_eq!, collect_streamed_lines, lines_to_plain_strings, vec!).


##### `tests::controller_stabilizes_two_column_no_outer_table_in_response`  (lines 1452–1476)

```
fn controller_stabilizes_two_column_no_outer_table_in_response()
```

**Purpose**: Verifies correct stabilization of a minimal two-column no-outer-pipes table.

**Data flow**: It streams a short no-outer-pipes table plus trailing paragraph, compares streamed output to full rendering, and asserts separators are present while the raw header is absent.

**Call relations**: It covers a compact edge case of no-outer-pipes table detection.

*Call graph*: calls 1 internal fn (append_markdown_agent); 6 external calls (new, assert!, assert_eq!, collect_streamed_lines, lines_to_plain_strings, vec!).


##### `tests::controller_converts_no_outer_table_between_preboxed_sections`  (lines 1479–1504)

```
fn controller_converts_no_outer_table_between_preboxed_sections()
```

**Purpose**: Checks that a no-outer-pipes table embedded between already boxed sections is still converted rather than left raw.

**Data flow**: It streams a source containing preboxed text, a no-outer-pipes table, and another preboxed section, then asserts the raw header is absent and a converted header line appears.

**Call relations**: This test guards against context-sensitive failures in no-outer-pipes detection.

*Call graph*: 2 external calls (assert!, collect_streamed_lines).


##### `tests::controller_keeps_markdown_fenced_tables_mutable_until_finalize`  (lines 1507–1531)

```
fn controller_keeps_markdown_fenced_tables_mutable_until_finalize()
```

**Purpose**: Verifies that tables inside markdown fences are still treated as markdown tables and held mutable until finalization.

**Data flow**: It streams a fenced `md` table, compares streamed output to full rendering, and asserts separators are present while the raw header line is absent.

**Call relations**: It covers holdback behavior inside markdown-designated code fences.

*Call graph*: calls 1 internal fn (append_markdown_agent); 6 external calls (new, assert!, assert_eq!, collect_streamed_lines, lines_to_plain_strings, vec!).


##### `tests::controller_keeps_markdown_fenced_no_outer_tables_mutable_until_finalize`  (lines 1534–1562)

```
fn controller_keeps_markdown_fenced_no_outer_tables_mutable_until_finalize()
```

**Purpose**: Verifies the same fenced-markdown behavior for no-outer-pipes tables.

**Data flow**: It streams a fenced `md` no-outer-pipes table, compares streamed output to full rendering, and asserts separators are present while the raw header is absent.

**Call relations**: It extends fenced markdown coverage to the no-outer-pipes table form.

*Call graph*: calls 1 internal fn (append_markdown_agent); 6 external calls (new, assert!, assert_eq!, collect_streamed_lines, lines_to_plain_strings, vec!).


##### `tests::controller_live_view_matches_render_during_interleaved_table_streaming`  (lines 1565–1608)

```
fn controller_live_view_matches_render_during_interleaved_table_streaming()
```

**Purpose**: Checks that the combination of emitted stable lines plus current live tail always matches a full render of the committed raw source after every delta.

**Data flow**: It streams a long source chunk by chunk, draining commit ticks after each chunk, combines already emitted transcript lines with `visible_lines(current_tail_lines())`, renders the current `raw_source` with `append_markdown_agent`, and asserts equality after every delta.

**Call relations**: This is a strong invariant test for the stable/tail partition during active streaming.

*Call graph*: calls 2 internal fn (append_markdown_agent, visible_lines); 4 external calls (new, assert_eq!, lines_to_plain_strings, stream_controller).


##### `tests::finalized_stream_table_preserves_semantic_url_fragments`  (lines 1611–1632)

```
fn finalized_stream_table_preserves_semantic_url_fragments()
```

**Purpose**: Verifies that hyperlinks split across wrapped table rows still preserve the original destination URL in all hyperlink fragments after finalization.

**Data flow**: It finalizes a streamed table containing a long URL at narrow width, collects display hyperlink lines from the resulting cell, filters rows with hyperlinks, and asserts every hyperlink destination equals the original URL.

**Call relations**: It guards against hyperlink corruption during table rendering and wrapping.

*Call graph*: 3 external calls (assert!, format!, stream_controller).


##### `tests::controller_keeps_non_markdown_fenced_tables_as_code`  (lines 1635–1661)

```
fn controller_keeps_non_markdown_fenced_tables_as_code()
```

**Purpose**: Checks that table-like text inside non-markdown fences remains raw code rather than being converted into a rendered table.

**Data flow**: It streams a fenced `sh` block containing pipe lines, compares streamed output to full rendering, and asserts the raw pipe header remains while no separator characters appear.

**Call relations**: It validates the fence-type filtering in table holdback detection.

*Call graph*: calls 1 internal fn (append_markdown_agent); 6 external calls (new, assert!, assert_eq!, collect_streamed_lines, lines_to_plain_strings, vec!).


##### `tests::plan_controller_streamed_table_matches_final_render`  (lines 1664–1689)

```
fn plan_controller_streamed_table_matches_final_render()
```

**Purpose**: Verifies that streamed plan-table output matches the final plan render and contains converted table separators.

**Data flow**: It streams a plan containing a table, collects streamed lines, compares them to a baseline produced by streaming the full source in one chunk, and asserts separators are present while the raw header is absent.

**Call relations**: It covers table holdback and plan-block decoration together.

*Call graph*: 4 external calls (assert!, assert_eq!, collect_plan_streamed_lines, vec!).


##### `tests::finalized_plan_stream_preserves_semantic_url_fragments`  (lines 1692–1717)

```
fn finalized_plan_stream_preserves_semantic_url_fragments()
```

**Purpose**: Checks that finalized plan-table hyperlinks preserve the original destination URL across wrapped fragments.

**Data flow**: It finalizes a narrow-width plan table containing a long URL, collects display hyperlink lines, filters linked rows, and asserts every hyperlink destination equals the original URL.

**Call relations**: It mirrors the main-stream hyperlink-preservation test for plan streams.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, format!, test_cwd).


##### `tests::plan_controller_streamed_markdown_fenced_table_matches_final_render`  (lines 1720–1747)

```
fn plan_controller_streamed_markdown_fenced_table_matches_final_render()
```

**Purpose**: Verifies that markdown-fenced tables inside plan streams are converted and match the final render.

**Data flow**: It streams a plan containing a fenced `md` table, compares streamed lines to a one-chunk baseline, and asserts separators are present while the raw header is absent.

**Call relations**: It extends plan-stream coverage to fenced markdown tables.

*Call graph*: 4 external calls (assert!, assert_eq!, collect_plan_streamed_lines, vec!).


##### `tests::table_holdback_state_detects_header_plus_delimiter`  (lines 1750–1756)

```
fn table_holdback_state_detects_header_plus_delimiter()
```

**Purpose**: Checks that a standard pipe-table header followed by a delimiter is recognized as confirmed table holdback state.

**Data flow**: It passes a short source string to `table_holdback_state` and asserts the result matches `TableHoldbackState::Confirmed`.

**Call relations**: This is a focused scanner-state test imported under `cfg(test)`.

*Call graph*: 1 external calls (assert!).


##### `tests::table_holdback_state_detects_single_column_header_plus_delimiter`  (lines 1759–1765)

```
fn table_holdback_state_detects_single_column_header_plus_delimiter()
```

**Purpose**: Checks that even a single-column pipe table is recognized as confirmed holdback state.

**Data flow**: It passes a one-column header+delimiter source to `table_holdback_state` and asserts a confirmed result.

**Call relations**: It covers a minimal valid table shape for the scanner.

*Call graph*: 1 external calls (assert!).


##### `tests::table_holdback_state_ignores_table_like_lines_inside_unclosed_long_fence`  (lines 1768–1774)

```
fn table_holdback_state_ignores_table_like_lines_inside_unclosed_long_fence()
```

**Purpose**: Verifies that table-like lines inside an open non-markdown fence do not trigger holdback.

**Data flow**: It passes a source containing nested fence-like text and pipe lines to `table_holdback_state` and asserts the result is `None`.

**Call relations**: It tests scanner fence handling for long/open fences.

*Call graph*: 1 external calls (assert!).


##### `tests::table_holdback_state_treats_indented_fence_text_as_plain_content`  (lines 1777–1786)

```
fn table_holdback_state_treats_indented_fence_text_as_plain_content()
```

**Purpose**: Checks that indented fence-like text does not open a real fence and therefore does not block table detection.

**Data flow**: It passes a source beginning with indented fence text plus a table to `table_holdback_state` and asserts a confirmed result.

**Call relations**: It covers a subtle markdown parsing edge case in the scanner.

*Call graph*: 1 external calls (assert!).


##### `tests::table_holdback_state_ignores_table_like_lines_inside_blockquoted_other_fence`  (lines 1789–1795)

```
fn table_holdback_state_ignores_table_like_lines_inside_blockquoted_other_fence()
```

**Purpose**: Verifies that table-like lines inside a blockquoted non-markdown fence are ignored by holdback detection.

**Data flow**: It passes a blockquoted fenced source to `table_holdback_state` and asserts the result is `None`.

**Call relations**: It extends fence filtering to blockquoted contexts.

*Call graph*: 1 external calls (assert!).


##### `tests::incremental_holdback_matches_stateless_scan_per_chunk`  (lines 1798–1821)

```
fn incremental_holdback_matches_stateless_scan_per_chunk()
```

**Purpose**: Checks that the incremental `TableHoldbackScanner` produces the same state as rescanning the full accumulated source after each chunk.

**Data flow**: It feeds a sequence of chunks into both an accumulating source string and a `TableHoldbackScanner`, comparing `scanner.state()` to `table_holdback_state(&source)` after each chunk.

**Call relations**: This validates the correctness of the incremental scanner against the stateless reference implementation.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, assert_eq!).


##### `tests::incremental_holdback_detects_header_delimiter_across_chunk_boundary`  (lines 1824–1836)

```
fn incremental_holdback_detects_header_delimiter_across_chunk_boundary()
```

**Purpose**: Verifies that the incremental scanner can transition from pending header to confirmed table when the delimiter arrives in a later chunk.

**Data flow**: It pushes a header chunk into a fresh scanner and asserts `PendingHeader`, then pushes the delimiter chunk and asserts `Confirmed`.

**Call relations**: It targets a key streaming-specific scanner transition.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::controller_set_width_after_first_line_emit_does_not_requeue_first_line`  (lines 1839–1866)

```
fn controller_set_width_after_first_line_emit_does_not_requeue_first_line()
```

**Purpose**: Checks that resizing after the first line has already emitted does not cause that first line to reappear in the remaining finalized output.

**Data flow**: It queues two lines, emits the first, resizes narrower, finalizes, strips bullet prefixes from remaining lines, and asserts the first token is absent while the second line remains.

**Call relations**: It guards against replay of already emitted content after partial drain plus resize.

*Call graph*: 2 external calls (assert!, stream_controller).


##### `tests::controller_set_width_partial_wrapped_emit_preserves_remaining_content`  (lines 1869–1895)

```
fn controller_set_width_partial_wrapped_emit_preserves_remaining_content()
```

**Purpose**: Verifies that resizing after partially emitting a wrapped source line does not lose later pending content.

**Data flow**: It queues a long wrapped line plus a tail line, emits one wrapped line, resizes wider, finalizes, and asserts the remaining output still contains `tail line`.

**Call relations**: It covers width remapping when only part of a wrapped logical line has already emitted.

*Call graph*: 2 external calls (assert!, stream_controller).


##### `tests::controller_set_width_partial_wrapped_emit_keeps_wrapped_remainder`  (lines 1898–1921)

```
fn controller_set_width_partial_wrapped_emit_keeps_wrapped_remainder()
```

**Purpose**: Checks that the un-emitted remainder of a partially emitted wrapped line survives a resize.

**Data flow**: It queues a long line that wraps at width 18, emits one wrapped line, resizes to width 80, finalizes, joins remaining lines, and asserts later words from the original line are still present.

**Call relations**: This is another regression test for preserving pending wrapped content across width changes.

*Call graph*: 2 external calls (assert!, stream_controller).


### `tui/src/streaming/chunking.rs`

`domain_logic` · `streaming commit-tick decisions`

This module is the policy layer for streaming commit pacing. Its core types are `ChunkingMode` (`Smooth` or `CatchUp`), `QueueSnapshot` (queued line count plus oldest queued age), `DrainPlan` (`Single` or `Batch(usize)`), `ChunkingDecision`, and the stateful `AdaptiveChunkingPolicy`. The policy is intentionally source-agnostic: it only looks at queue depth and age, not which controller produced the backlog.

`AdaptiveChunkingPolicy` tracks three pieces of state across ticks: the current mode, when queue pressure first dropped below exit thresholds, and when catch-up mode last exited. `decide` is the main entry point. If the queue is empty, it records a catch-up exit if needed, resets to `Smooth`, clears exit-hold tracking, and returns a `Single` drain plan. Otherwise it either tries to enter catch-up from smooth mode or tries to exit catch-up via hysteresis. Entering catch-up requires `should_enter_catch_up(snapshot)` and is blocked during `REENTER_CATCH_UP_HOLD` unless `is_severe_backlog(snapshot)` is true. Exiting catch-up requires both depth and age to stay below `EXIT_*` thresholds continuously for `EXIT_HOLD`.

The helper predicates encode the threshold logic directly: entering is triggered by either depth or age pressure, exiting requires both signals to be low, and severe backlog is a higher threshold used only to bypass re-entry suppression. Tests cover default smooth behavior, threshold-triggered entry, full-backlog batch draining, hysteresis-based exit, idle reset, re-entry hold, and severe-backlog bypass.

#### Function details

##### `AdaptiveChunkingPolicy::mode`  (lines 165–167)

```
fn mode(&self) -> ChunkingMode
```

**Purpose**: Returns the policy mode resulting from the most recent decision.

**Data flow**: It reads `self.mode` and returns the `ChunkingMode` by value.

**Call relations**: It is used by commit-tick orchestration to compare the prior mode against the new decision and emit transition logs.

*Call graph*: called by 1 (resolve_chunking_plan).


##### `AdaptiveChunkingPolicy::reset`  (lines 170–174)

```
fn reset(&mut self)
```

**Purpose**: Restores the policy to baseline smooth mode and clears all hysteresis state.

**Data flow**: It sets `self.mode = Smooth`, `below_exit_threshold_since = None`, and `last_catch_up_exit_at = None`.

**Call relations**: This is an external reset hook for callers that want to discard prior queue-pressure history.


##### `AdaptiveChunkingPolicy::decide`  (lines 180–210)

```
fn decide(&mut self, snapshot: QueueSnapshot, now: Instant) -> ChunkingDecision
```

**Purpose**: Computes the next chunking decision from the current queue snapshot and current time.

**Data flow**: It takes a `QueueSnapshot` and `Instant`. For an empty queue it notes a catch-up exit, resets mode and exit-hold state, and returns `ChunkingDecision { Smooth, false, Single }`. Otherwise it either calls `maybe_enter_catch_up` or `maybe_exit_catch_up` depending on current mode, then maps the resulting mode to `DrainPlan::Single` or `DrainPlan::Batch(snapshot.queued_lines.max(1))` and returns the full decision.

**Call relations**: This is the policy’s main entry point, called by commit-tick orchestration on every tick.

*Call graph*: calls 3 internal fn (maybe_enter_catch_up, maybe_exit_catch_up, note_catch_up_exit); called by 1 (resolve_chunking_plan); 1 external calls (Batch).


##### `AdaptiveChunkingPolicy::maybe_enter_catch_up`  (lines 216–227)

```
fn maybe_enter_catch_up(&mut self, snapshot: QueueSnapshot, now: Instant) -> bool
```

**Purpose**: Transitions from smooth mode into catch-up mode when queue pressure crosses entry thresholds and re-entry suppression allows it.

**Data flow**: It takes a snapshot and time, returns `false` immediately if `should_enter_catch_up` is false, returns `false` during active re-entry hold unless `is_severe_backlog` is true, otherwise sets mode to `CatchUp`, clears exit-hold and last-exit state, and returns `true`.

**Call relations**: It is only called from `decide` while the policy is currently in `Smooth` mode.

*Call graph*: calls 3 internal fn (reentry_hold_active, is_severe_backlog, should_enter_catch_up); called by 1 (decide).


##### `AdaptiveChunkingPolicy::maybe_exit_catch_up`  (lines 233–250)

```
fn maybe_exit_catch_up(&mut self, snapshot: QueueSnapshot, now: Instant)
```

**Purpose**: Applies exit hysteresis while in catch-up mode and switches back to smooth only after sustained low pressure.

**Data flow**: It takes a snapshot and time, clears `below_exit_threshold_since` if `should_exit_catch_up` is false, otherwise starts the hold timer if absent or, once `EXIT_HOLD` has elapsed, sets mode to `Smooth`, clears the hold timer, and records `last_catch_up_exit_at = Some(now)`.

**Call relations**: It is only called from `decide` while the policy is currently in `CatchUp` mode.

*Call graph*: calls 1 internal fn (should_exit_catch_up); called by 1 (decide); 1 external calls (saturating_duration_since).


##### `AdaptiveChunkingPolicy::note_catch_up_exit`  (lines 252–256)

```
fn note_catch_up_exit(&mut self, now: Instant)
```

**Purpose**: Records the time of an implicit catch-up exit caused by the queue becoming empty.

**Data flow**: It takes `now` and, if `self.mode == CatchUp`, stores `Some(now)` in `last_catch_up_exit_at`.

**Call relations**: It is called by `decide` in the empty-queue fast path so re-entry hold still applies after an idle drain.

*Call graph*: called by 1 (decide).


##### `AdaptiveChunkingPolicy::reentry_hold_active`  (lines 258–261)

```
fn reentry_hold_active(&self, now: Instant) -> bool
```

**Purpose**: Reports whether the post-exit cooldown window is still active.

**Data flow**: It takes `now`, reads `last_catch_up_exit_at`, and returns true when the elapsed time since that exit is less than `REENTER_CATCH_UP_HOLD`.

**Call relations**: It is consulted by `maybe_enter_catch_up` before allowing a new catch-up transition.

*Call graph*: called by 1 (maybe_enter_catch_up).


##### `should_enter_catch_up`  (lines 267–272)

```
fn should_enter_catch_up(snapshot: QueueSnapshot) -> bool
```

**Purpose**: Determines whether current queue pressure is high enough to justify entering catch-up mode.

**Data flow**: It takes a `QueueSnapshot` and returns true if either `queued_lines >= ENTER_QUEUE_DEPTH_LINES` or `oldest_age >= ENTER_OLDEST_AGE`.

**Call relations**: It is the threshold predicate used by `maybe_enter_catch_up`.

*Call graph*: called by 1 (maybe_enter_catch_up).


##### `should_exit_catch_up`  (lines 278–283)

```
fn should_exit_catch_up(snapshot: QueueSnapshot) -> bool
```

**Purpose**: Determines whether queue pressure is low enough to begin or continue exit hysteresis.

**Data flow**: It takes a `QueueSnapshot` and returns true only when `queued_lines <= EXIT_QUEUE_DEPTH_LINES` and `oldest_age <= EXIT_OLDEST_AGE`.

**Call relations**: It is the threshold predicate used by `maybe_exit_catch_up`.

*Call graph*: called by 1 (maybe_exit_catch_up).


##### `is_severe_backlog`  (lines 289–294)

```
fn is_severe_backlog(snapshot: QueueSnapshot) -> bool
```

**Purpose**: Determines whether backlog is severe enough to bypass re-entry hold after a recent catch-up exit.

**Data flow**: It takes a `QueueSnapshot` and returns true if either `queued_lines >= SEVERE_QUEUE_DEPTH_LINES` or `oldest_age >= SEVERE_OLDEST_AGE`.

**Call relations**: It is only used by `maybe_enter_catch_up` as an override for the cooldown gate.

*Call graph*: called by 1 (maybe_enter_catch_up).


##### `tests::snapshot`  (lines 301–306)

```
fn snapshot(queued_lines: usize, oldest_age_ms: u64) -> QueueSnapshot
```

**Purpose**: Creates a `QueueSnapshot` fixture from a queued-line count and oldest-age milliseconds.

**Data flow**: It takes `queued_lines` and `oldest_age_ms`, wraps the age in `Some(Duration::from_millis(...))`, and returns the snapshot.

**Call relations**: This helper is shared by all policy tests in the module.

*Call graph*: 1 external calls (from_millis).


##### `tests::smooth_mode_is_default`  (lines 309–317)

```
fn smooth_mode_is_default()
```

**Purpose**: Verifies that a fresh policy starts in smooth mode and drains one line for a low-pressure queue.

**Data flow**: It creates a default policy and a low-pressure snapshot, calls `decide`, and asserts mode, transition flag, and drain plan.

**Call relations**: This test establishes the baseline behavior before any threshold crossings.

*Call graph*: 4 external calls (now, assert_eq!, default, snapshot).


##### `tests::enters_catch_up_on_depth_threshold`  (lines 320–328)

```
fn enters_catch_up_on_depth_threshold()
```

**Purpose**: Checks that hitting the queue-depth threshold alone is enough to enter catch-up mode.

**Data flow**: It creates a default policy, passes a snapshot with 8 queued lines and low age to `decide`, and asserts catch-up mode with `Batch(8)`.

**Call relations**: It covers the depth-trigger branch of `should_enter_catch_up`.

*Call graph*: 4 external calls (now, assert_eq!, default, snapshot).


##### `tests::enters_catch_up_on_age_threshold`  (lines 331–339)

```
fn enters_catch_up_on_age_threshold()
```

**Purpose**: Checks that hitting the oldest-age threshold alone is enough to enter catch-up mode.

**Data flow**: It creates a default policy, passes a snapshot with low depth but 120ms oldest age, and asserts catch-up mode with a batch drain.

**Call relations**: It covers the age-trigger branch of `should_enter_catch_up`.

*Call graph*: 4 external calls (now, assert_eq!, default, snapshot).


##### `tests::severe_backlog_uses_faster_paced_batches`  (lines 342–353)

```
fn severe_backlog_uses_faster_paced_batches()
```

**Purpose**: Verifies that once in catch-up mode, the drain plan expands to the full current backlog size under severe queue depth.

**Data flow**: It first enters catch-up with a moderate backlog, then calls `decide` again with 64 queued lines and asserts the returned plan is `Batch(64)`.

**Call relations**: This test demonstrates that catch-up mode drains the current backlog size rather than a fixed batch size.

*Call graph*: 5 external calls (from_millis, now, assert_eq!, default, snapshot).


##### `tests::catch_up_batch_drains_current_backlog`  (lines 356–362)

```
fn catch_up_batch_drains_current_backlog()
```

**Purpose**: Checks that a very large backlog in catch-up mode produces a batch plan equal to the full queued depth.

**Data flow**: It creates a default policy, decides on a snapshot with 512 queued lines and high age, and asserts `Batch(512)`.

**Call relations**: It reinforces the full-backlog drain contract of catch-up mode.

*Call graph*: 4 external calls (now, assert_eq!, default, snapshot).


##### `tests::exits_catch_up_after_hysteresis_hold`  (lines 365–384)

```
fn exits_catch_up_after_hysteresis_hold()
```

**Purpose**: Verifies that catch-up mode does not exit immediately when pressure drops, but does exit after the full hold duration.

**Data flow**: It enters catch-up at `t0`, decides again below exit thresholds before `EXIT_HOLD` and asserts mode remains `CatchUp`, then decides again after enough time has elapsed and asserts mode becomes `Smooth` with `Single` drain.

**Call relations**: This test covers the hysteresis timing logic in `maybe_exit_catch_up`.

*Call graph*: 5 external calls (from_millis, now, assert_eq!, default, snapshot).


##### `tests::drops_back_to_smooth_when_idle`  (lines 387–402)

```
fn drops_back_to_smooth_when_idle()
```

**Purpose**: Checks that an empty queue immediately resets the policy to smooth mode.

**Data flow**: It enters catch-up, then calls `decide` with `queued_lines = 0` and `oldest_age = None`, and asserts the result is smooth with a single-line plan.

**Call relations**: It exercises the empty-queue fast path in `decide`.

*Call graph*: 5 external calls (from_millis, now, assert_eq!, default, snapshot).


##### `tests::holds_reentry_after_catch_up_exit`  (lines 405–434)

```
fn holds_reentry_after_catch_up_exit()
```

**Purpose**: Verifies that after a catch-up exit, the policy suppresses immediate re-entry for the configured cooldown window.

**Data flow**: It enters catch-up, exits by draining to idle, then calls `decide` during the hold window with threshold-crossing pressure and asserts mode stays `Smooth`; after the hold expires it calls again and asserts re-entry to `CatchUp`.

**Call relations**: This test targets `reentry_hold_active` and its effect inside `maybe_enter_catch_up`.

*Call graph*: 5 external calls (from_millis, now, assert_eq!, default, snapshot).


##### `tests::severe_backlog_can_reenter_during_hold`  (lines 437–456)

```
fn severe_backlog_can_reenter_during_hold()
```

**Purpose**: Checks that severe backlog bypasses the re-entry cooldown after a recent catch-up exit.

**Data flow**: It enters catch-up, exits to idle, then calls `decide` during the hold window with a severe backlog snapshot and asserts immediate re-entry to `CatchUp` with `Batch(64)`.

**Call relations**: It covers the severe-backlog override path in `maybe_enter_catch_up`.

*Call graph*: 5 external calls (from_millis, now, assert_eq!, default, snapshot).


### `tui/src/streaming/commit_tick.rs`

`orchestration` · `streaming commit ticks`

This module is the orchestration layer between the abstract chunking policy and the concrete stream controllers. Its public inputs are an `AdaptiveChunkingPolicy`, optional `StreamController` and `PlanStreamController`, a `CommitTickScope`, and the current `Instant`. Its output is `CommitTickOutput`, which reports the history cells emitted during the tick plus whether any controller existed and whether all present controllers are idle afterward.

`run_commit_tick` is the main entry point. It first computes a combined `QueueSnapshot` with `stream_queue_snapshot`, summing queued lines across both controllers and taking the maximum oldest queued age so the policy reacts to the worst visible lag. It then asks `resolve_chunking_plan` for a `ChunkingDecision`; that helper compares the policy’s prior mode to the new one and emits a trace log whenever the mode changes, including queue depth, oldest age in milliseconds, and whether the transition entered catch-up. If the caller requested `CommitTickScope::CatchUpOnly` and the decision is not in catch-up mode, the function returns `CommitTickOutput::default()` to indicate that no commit should occur.

Otherwise `apply_commit_tick_plan` drains both controllers using the same `DrainPlan`. `DrainPlan::Single` maps to each controller’s one-line `on_commit_tick`, while `Batch(n)` maps to `on_commit_tick_batch(n)`. The function accumulates any returned `HistoryCell`s, marks `has_controller` if either controller was present, and computes `all_idle` as the conjunction of each controller’s post-drain idle flag. A small `max_duration` helper handles optional oldest-age aggregation cleanly.

#### Function details

##### `CommitTickOutput::default`  (lines 53–59)

```
fn default() -> Self
```

**Purpose**: Creates the sentinel output representing a suppressed or no-op commit tick.

**Data flow**: It constructs and returns `CommitTickOutput { cells: Vec::new(), has_controller: false, all_idle: true }`.

**Call relations**: It is used both when `run_commit_tick` intentionally suppresses a tick and as the starting accumulator in `apply_commit_tick_plan`.

*Call graph*: called by 2 (apply_commit_tick_plan, run_commit_tick); 1 external calls (new).


##### `run_commit_tick`  (lines 69–91)

```
fn run_commit_tick(
    policy: &mut AdaptiveChunkingPolicy,
    stream_controller: Option<&mut StreamController>,
    plan_stream_controller: Option<&mut PlanStreamController>,
    scope: CommitTickS
```

**Purpose**: Runs one commit tick by sampling queue pressure, resolving chunking policy, optionally suppressing non-catch-up ticks, and draining available controllers.

**Data flow**: It takes mutable policy and optional mutable controller references plus scope and time. It builds a combined snapshot with `stream_queue_snapshot`, gets a decision from `resolve_chunking_plan`, returns `CommitTickOutput::default()` if scope is `CatchUpOnly` and mode is not `CatchUp`, otherwise delegates to `apply_commit_tick_plan` with the chosen `DrainPlan` and returns that output.

**Call relations**: This is the module’s top-level orchestration function, called by higher-level streaming drivers on each commit tick.

*Call graph*: calls 4 internal fn (default, apply_commit_tick_plan, resolve_chunking_plan, stream_queue_snapshot).


##### `stream_queue_snapshot`  (lines 97–118)

```
fn stream_queue_snapshot(
    stream_controller: Option<&StreamController>,
    plan_stream_controller: Option<&PlanStreamController>,
    now: Instant,
) -> QueueSnapshot
```

**Purpose**: Combines queue depth and oldest queued age across the main and plan stream controllers into one policy snapshot.

**Data flow**: It takes optional shared references to both controllers plus `now`, sums `queued_lines()` from each present controller, combines `oldest_queued_age(now)` using `max_duration`, and returns `QueueSnapshot { queued_lines, oldest_age }`.

**Call relations**: It is called only by `run_commit_tick` before policy evaluation.

*Call graph*: calls 1 internal fn (max_duration); called by 1 (run_commit_tick).


##### `resolve_chunking_plan`  (lines 124–142)

```
fn resolve_chunking_plan(
    policy: &mut AdaptiveChunkingPolicy,
    snapshot: QueueSnapshot,
    now: Instant,
) -> ChunkingDecision
```

**Purpose**: Asks the adaptive policy for a decision and emits a trace log when the chunking mode changes.

**Data flow**: It takes mutable policy, a `QueueSnapshot`, and `now`; reads the prior mode via `policy.mode()`, computes the new decision with `policy.decide(snapshot, now)`, conditionally logs transition metadata with `tracing::trace!`, and returns the decision.

**Call relations**: It is the policy-facing half of `run_commit_tick`, isolating observability from the rest of the orchestration.

*Call graph*: calls 2 internal fn (decide, mode); called by 1 (run_commit_tick); 1 external calls (trace!).


##### `apply_commit_tick_plan`  (lines 148–173)

```
fn apply_commit_tick_plan(
    drain_plan: DrainPlan,
    stream_controller: Option<&mut StreamController>,
    plan_stream_controller: Option<&mut PlanStreamController>,
) -> CommitTickOutput
```

**Purpose**: Applies a resolved drain plan to all present stream controllers and aggregates their emitted cells and idle state.

**Data flow**: It takes a `DrainPlan` and optional mutable controller references, starts from `CommitTickOutput::default()`, drains each present controller through the appropriate helper, pushes any returned `HistoryCell` into `output.cells`, sets `has_controller = true` when applicable, folds each controller’s idle flag into `all_idle`, and returns the output.

**Call relations**: It is called by `run_commit_tick` after policy resolution and scope filtering.

*Call graph*: calls 3 internal fn (default, drain_plan_stream_controller, drain_stream_controller); called by 1 (run_commit_tick).


##### `drain_stream_controller`  (lines 180–188)

```
fn drain_stream_controller(
    controller: &mut StreamController,
    drain_plan: DrainPlan,
) -> (Option<Box<dyn HistoryCell>>, bool)
```

**Purpose**: Executes one drain step on the main stream controller according to the chosen drain plan.

**Data flow**: It takes `&mut StreamController` and a `DrainPlan`, dispatches `Single` to `controller.on_commit_tick()` and `Batch(max_lines)` to `controller.on_commit_tick_batch(max_lines)`, and returns that pair of `(Option<Box<dyn HistoryCell>>, bool)`.

**Call relations**: It is used by `apply_commit_tick_plan` so the main stream follows the same chunking decision as the plan stream.

*Call graph*: calls 2 internal fn (on_commit_tick, on_commit_tick_batch); called by 1 (apply_commit_tick_plan).


##### `drain_plan_stream_controller`  (lines 194–202)

```
fn drain_plan_stream_controller(
    controller: &mut PlanStreamController,
    drain_plan: DrainPlan,
) -> (Option<Box<dyn HistoryCell>>, bool)
```

**Purpose**: Executes one drain step on the plan stream controller according to the chosen drain plan.

**Data flow**: It takes `&mut PlanStreamController` and a `DrainPlan`, dispatches `Single` to `controller.on_commit_tick()` and `Batch(max_lines)` to `controller.on_commit_tick_batch(max_lines)`, and returns the resulting cell/idle pair.

**Call relations**: It mirrors `drain_stream_controller` and is called from `apply_commit_tick_plan`.

*Call graph*: calls 2 internal fn (on_commit_tick, on_commit_tick_batch); called by 1 (apply_commit_tick_plan).


##### `max_duration`  (lines 207–214)

```
fn max_duration(lhs: Option<Duration>, rhs: Option<Duration>) -> Option<Duration>
```

**Purpose**: Returns the greater of two optional durations while preserving whichever side is present when only one exists.

**Data flow**: It takes `Option<Duration>` for `lhs` and `rhs`, compares both when present, and returns the maximum or the sole present value or `None`.

**Call relations**: It is a local helper used by `stream_queue_snapshot` to aggregate oldest queued ages across controllers.

*Call graph*: called by 1 (stream_queue_snapshot).


### Transcript cell foundations
These files provide the core transcript cell abstraction and the concrete history-cell renderers that streaming and event projection emit.

### `tui/src/history_cell/mod.rs`

`domain_logic` · `cross-cutting; active whenever transcript cells are measured, rendered, copied, or shown in the transcript overlay`

This module is the root of the history-cell subsystem: it declares the `HistoryCell` trait, the `HistoryRenderMode` switch (`Rich` vs `Raw`), and the `Renderable` implementation for `Box<dyn HistoryCell>` that actually paints cells into a ratatui buffer. The trait separates several representations of the same cell: styled viewport lines (`display_lines`), plain copy-friendly lines (`raw_lines`), transcript-overlay lines (`transcript_lines`), and hyperlink-aware variants (`display_hyperlink_lines`, `transcript_hyperlink_lines`). Default implementations intentionally route rich mode through `HyperlinkLine` metadata and raw mode through plain `Line` values so callers can choose between terminal hyperlinks and literal text without each cell reimplementing the switch.

Height calculation is centralized here. `desired_height_for_mode` and `desired_transcript_height` use `Paragraph::line_count` with `Wrap { trim: false }` so row counts reflect ratatui’s actual viewport wrapping, including long unbreakable tokens such as URLs. `desired_transcript_height` also contains a specific workaround for a ratatui bug where a single whitespace-only line reports two rows. The `Renderable for Box<dyn HistoryCell>` implementation clears the entire draw area before rendering, computes bottom-scroll offset when content overflows, renders visible lines, and then overlays hyperlink annotations with the same vertical scroll offset. The module also exposes `as_any`/`as_any_mut` for runtime downcasting of trait objects and small helpers for converting source text or styled lines into plain `Line<'static>` collections.

#### Function details

##### `raw_lines_from_source`  (lines 150–164)

```
fn raw_lines_from_source(source: &str) -> Vec<Line<'static>>
```

**Purpose**: Converts a raw newline-delimited source string into one `Line<'static>` per logical source line without inventing an extra trailing blank line for a terminal newline.

**Data flow**: It reads `source: &str`, returns an empty vector immediately for the empty string, otherwise splits on `\n`, removes the final empty segment when `source` ends with a newline, and maps each remaining slice into an owned `Line`. It writes no external state.

**Call relations**: This helper is used by source-backed renderers such as `render_source` to preserve original line boundaries in raw mode instead of rewrapping or restyling content.

*Call graph*: called by 1 (render_source); 1 external calls (new).


##### `plain_lines`  (lines 166–178)

```
fn plain_lines(lines: impl IntoIterator<Item = Line<'static>>) -> Vec<Line<'static>>
```

**Purpose**: Strips styling and span structure from rich ratatui lines, producing plain text lines suitable for raw scrollback or transcript export.

**Data flow**: It consumes any iterator of `Line<'static>`, concatenates each line’s span contents into a single owned `String`, and returns a new vector of plain `Line` values containing only text. It discards all style and hyperlink-related structure.

**Call relations**: Concrete cells call this when their raw representation should mirror rich content textually but not preserve formatting, such as diff summaries or pre-rendered streaming lines.

*Call graph*: called by 4 (raw_lines, raw_lines, raw_lines, raw_lines); 1 external calls (into_iter).


##### `HistoryCell::display_hyperlink_lines`  (lines 197–199)

```
fn display_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Provides the default hyperlink-aware rich representation by wrapping ordinary display lines in hyperlink metadata with no extra annotations.

**Data flow**: It reads `self` and `width`, calls `self.display_lines(width)`, then converts those lines with `plain_hyperlink_lines` into `Vec<HyperlinkLine>`. It returns metadata-bearing lines but does not mutate cell state.

**Call relations**: This is the default path used by rich-mode rendering unless a concrete cell overrides it to annotate URLs or preserve richer hyperlink information.

*Call graph*: calls 1 internal fn (plain_hyperlink_lines); called by 2 (display_hyperlink_lines_for_mode, display_lines_for_mode).


##### `HistoryCell::display_lines_for_mode`  (lines 201–206)

```
fn display_lines_for_mode(&self, width: u16, mode: HistoryRenderMode) -> Vec<Line<'static>>
```

**Purpose**: Selects the visible line representation for either rich viewport rendering or raw scrollback mode.

**Data flow**: It reads `mode`; in `Rich` mode it obtains hyperlink lines from `display_hyperlink_lines(width)` and strips them to visible `Line`s with `visible_lines`, while in `Raw` mode it returns `self.raw_lines()`. No state is changed.

**Call relations**: Height measurement delegates here so the same mode switch controls both what is shown and how many rows it occupies.

*Call graph*: calls 2 internal fn (display_hyperlink_lines, visible_lines); called by 1 (desired_height_for_mode).


##### `HistoryCell::display_hyperlink_lines_for_mode`  (lines 208–217)

```
fn display_hyperlink_lines_for_mode(
        &self,
        width: u16,
        mode: HistoryRenderMode,
    ) -> Vec<HyperlinkLine>
```

**Purpose**: Selects hyperlink-aware output for rich mode and synthesizes plain hyperlink wrappers around raw lines for raw mode.

**Data flow**: Given `width` and `mode`, it returns `self.display_hyperlink_lines(width)` for `Rich`, or wraps `self.raw_lines()` with `plain_hyperlink_lines` for `Raw`. This preserves a uniform `Vec<HyperlinkLine>` return type across modes.

**Call relations**: Callers that need hyperlink metadata regardless of mode, such as history insertion/display plumbing, use this instead of branching themselves.

*Call graph*: calls 2 internal fn (display_hyperlink_lines, plain_hyperlink_lines); called by 1 (display_lines_for_history_insert).


##### `HistoryCell::desired_height`  (lines 226–228)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Computes the default viewport row count for a cell in normal rich rendering mode.

**Data flow**: It forwards `self` and `width` to `desired_height_for_mode(width, HistoryRenderMode::Rich)` and returns that `u16` result unchanged.

**Call relations**: This is the standard sizing entry point used by render/layout code and by the `Renderable` impl for boxed cells unless a concrete cell overrides sizing.

*Call graph*: calls 1 internal fn (desired_height_for_mode); called by 3 (desired_height, desired_height, desired_height).


##### `HistoryCell::desired_height_for_mode`  (lines 230–236)

```
fn desired_height_for_mode(&self, width: u16, mode: HistoryRenderMode) -> u16
```

**Purpose**: Measures how many terminal rows a cell will occupy for a specific render mode after ratatui wrapping is applied.

**Data flow**: It builds a `Paragraph` from `self.display_lines_for_mode(width, mode)`, enables `Wrap { trim: false }`, asks ratatui for `line_count(width)`, and converts the result to `u16`, falling back to `0` on conversion failure. It reads only the cell’s rendered lines.

**Call relations**: This underpins `desired_height`; centralizing the measurement here keeps rich/raw mode sizing consistent with actual paragraph rendering.

*Call graph*: calls 1 internal fn (display_lines_for_mode); called by 1 (desired_height); 2 external calls (new, from).


##### `HistoryCell::transcript_lines`  (lines 243–245)

```
fn transcript_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Defines the default transcript-overlay representation as identical to the main display representation.

**Data flow**: It reads `self` and `width` and simply returns `self.display_lines(width)`. No state is modified.

**Call relations**: Cells whose transcript view differs from their main viewport rendering override this; otherwise transcript rendering and display rendering stay aligned automatically.

*Call graph*: called by 2 (transcript_hyperlink_lines, render_transcript).


##### `HistoryCell::transcript_hyperlink_lines`  (lines 252–254)

```
fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Provides the default hyperlink-aware transcript representation by wrapping transcript lines without extra annotations.

**Data flow**: It calls `self.transcript_lines(width)` and converts the result with `plain_hyperlink_lines`, returning `Vec<HyperlinkLine>`. It preserves transcript text while discarding any richer hyperlink semantics unless overridden.

**Call relations**: Transcript height measurement uses this path, and cells whose transcript should preserve rich hyperlinks can override it to delegate to their display hyperlink renderer.

*Call graph*: calls 2 internal fn (transcript_lines, plain_hyperlink_lines); called by 1 (desired_transcript_height).


##### `HistoryCell::desired_transcript_height`  (lines 261–279)

```
fn desired_transcript_height(&self, width: u16) -> u16
```

**Purpose**: Measures transcript-overlay height, including a special-case correction for whitespace-only single-line content.

**Data flow**: It obtains transcript hyperlink lines, converts them to visible lines, checks whether the result is exactly one line whose spans are all whitespace and returns `1` in that case, otherwise constructs a wrapped `Paragraph`, asks for `line_count(width)`, and converts to `u16` with `0` fallback. It writes no state.

**Call relations**: Transcript overlay layout uses this instead of `desired_height` because transcript content may differ from viewport content and because the whitespace bug workaround is transcript-specific.

*Call graph*: calls 2 internal fn (transcript_hyperlink_lines, visible_lines); 2 external calls (new, from).


##### `HistoryCell::is_stream_continuation`  (lines 281–283)

```
fn is_stream_continuation(&self) -> bool
```

**Purpose**: Marks whether a cell should be treated as a continuation fragment of an in-flight stream rather than a standalone history item.

**Data flow**: The default implementation ignores inputs and returns `false`.

**Call relations**: Streaming cell types override this so history insertion logic can merge or visually treat streamed tails differently from committed standalone cells.

*Call graph*: called by 1 (display_lines_for_history_insert).


##### `HistoryCell::transcript_animation_tick`  (lines 295–297)

```
fn transcript_animation_tick(&self) -> Option<u64>
```

**Purpose**: Lets animated active cells expose a coarse time-based cache key so transcript-overlay rendering can refresh while the main viewport animates.

**Data flow**: The default implementation returns `None`, signaling stable transcript output with no time-dependent invalidation requirement.

**Call relations**: Only cells with elapsed-time-dependent visuals need to override this; otherwise transcript caching can safely reuse prior rendered output.


##### `Box::render`  (lines 301–318)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders any boxed history cell into a ratatui buffer, including wrapping, bottom-aligned overflow scrolling, area clearing, and hyperlink annotation.

**Data flow**: It reads `area`, asks the cell for `display_hyperlink_lines(area.width)`, derives visible lines, constructs a wrapped `Paragraph`, computes a vertical scroll offset `y` equal to overflow rows beyond `area.height`, clears the full `area` with `Clear`, renders the paragraph scrolled by `(y, 0)`, and then writes hyperlink metadata into `buf` via `mark_buffer_hyperlinks`. The buffer is the primary output state it mutates.

**Call relations**: This is the concrete bridge from abstract `HistoryCell` content to on-screen drawing. It is invoked wherever boxed cells participate in the generic `Renderable` pipeline.

*Call graph*: calls 2 internal fn (mark_buffer_hyperlinks, visible_lines); 4 external calls (new, from, try_from, from).


##### `Box::desired_height`  (lines 319–321)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Adapts boxed trait objects to the `Renderable` sizing API by forwarding to the underlying `HistoryCell` implementation.

**Data flow**: It reads `self` and `width`, calls `HistoryCell::desired_height(self.as_ref(), width)`, and returns the resulting row count.

**Call relations**: Layout code that works with `Renderable` values uses this method to size boxed history cells without knowing their concrete type.

*Call graph*: calls 1 internal fn (desired_height).


##### `HistoryCell::as_any`  (lines 325–327)

```
fn as_any(&self) -> &dyn Any
```

**Purpose**: Exposes an immutable `Any` view of a history cell for runtime downcasting from `dyn HistoryCell`.

**Data flow**: It returns `self` as `&dyn Any` without transforming data or mutating state.

**Call relations**: Code that stores heterogeneous cells behind trait objects can use this to inspect concrete types when special-case behavior is required.


##### `HistoryCell::as_any_mut`  (lines 329–331)

```
fn as_any_mut(&mut self) -> &mut dyn Any
```

**Purpose**: Exposes a mutable `Any` view of a history cell for runtime downcasting and in-place mutation of concrete active cells.

**Data flow**: It returns `self` as `&mut dyn Any`, enabling callers to downcast and mutate the underlying concrete value.

**Call relations**: This supports controller paths that keep an active cell boxed as `dyn HistoryCell` but need to update concrete streaming state in place.


### `tui/src/history_cell/messages.rs`

`domain_logic` · `request handling`

This file is the main message-rendering layer for transcript history. `UserHistoryCell` stores the raw user message plus structured `TextElement`s and image references. Its renderer reserves space for the live prefix margin, optionally emits remote-image placeholder lines, and either wraps plain message text or reconstructs styled spans from byte-range elements via `build_user_message_lines_with_elements`. That helper sorts elements by byte range, interleaves plain and highlighted spans line by line, and skips malformed UTF-8 boundaries instead of panicking. Trailing blank lines are trimmed before wrapping so user messages do not accumulate empty transcript rows. `ReasoningSummaryCell` stores markdown-like reasoning content plus the session `cwd`; it renders through `append_markdown`, then dims and italicizes every span and prefixes wrapped lines with `• `. It can be transcript-only, meaning hidden in the viewport but present in transcript output. `AgentMessageCell` stores already-rendered `HyperlinkLine`s for streamed assistant chunks and wraps them with a bullet only on the first logical line, preserving leading whitespace on continuations. `AgentMarkdownCell` is the finalized source-backed assistant cell: instead of storing wrapped lines, it stores raw markdown and re-renders it at the current width with local-file-link resolution relative to the captured `cwd`, which is crucial after terminal resize or later `/cd`. `StreamingAgentTailCell` is the transient active-cell version of the mutable stream tail; it deliberately does not re-wrap because in-progress tables would break. The file ends with constructors for user prompts and reasoning-summary extraction from a full reasoning buffer.

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

**Purpose**: Builds logical user-message lines that interleave plain text with specially styled `TextElement` ranges. It preserves explicit newlines and tolerates malformed byte ranges by skipping them.

**Data flow**: Consumes the raw `message`, a slice of `TextElement`, and base/element `Style`s. It clones and sorts elements by `byte_range.start`, then iterates `message.split('\n')` while tracking absolute byte offsets. For each line it computes overlap between the line and each element, validates UTF-8 character boundaries, pushes plain spans for uncovered segments and styled spans for element-covered segments, then emits either a span-based `Line` or a plain `Line` styled with `style`. It returns the collected `Vec<Line<'static>>`.

**Call relations**: This helper is used by `UserHistoryCell::display_lines` when the message includes structured text elements, allowing the cell to preserve semantic highlighting during wrapping.

*Call graph*: called by 1 (display_lines); 6 external calls (from, from, styled, new, sort_by_key, to_vec).


##### `remote_image_display_line`  (lines 80–82)

```
fn remote_image_display_line(style: Style, index: usize) -> Line<'static>
```

**Purpose**: Builds one styled line representing a remote image attachment placeholder in a user message. It reuses the same label text used for local-image placeholders.

**Data flow**: Consumes a `Style` and one-based image index, creates a `Line` from `local_image_label_text(index)`, applies the provided style, and returns it.

**Call relations**: This helper is used by `UserHistoryCell::display_lines` when rendering remote image URL placeholders above the message body.

*Call graph*: 1 external calls (from).


##### `trim_trailing_blank_lines`  (lines 84–92)

```
fn trim_trailing_blank_lines(mut lines: Vec<Line<'static>>) -> Vec<Line<'static>>
```

**Purpose**: Removes trailing blank or whitespace-only lines from a rendered line vector. It prevents user-message rendering from ending with unnecessary empty transcript rows.

**Data flow**: Consumes a mutable `Vec<Line<'static>>`, repeatedly inspects the last line, and pops it while all spans in that line contain only trimmed-empty content. It returns the trimmed vector.

**Call relations**: This helper is used by `UserHistoryCell::display_lines` after wrapping either plain or element-aware message lines.

*Call graph*: called by 1 (display_lines).


##### `UserHistoryCell::display_lines`  (lines 95–177)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Renders a user prompt with optional remote-image placeholders and wrapped message text. It applies user-message styling, prefixes body lines with `› `, and trims trailing blank content.

**Data flow**: Reads `self.message`, `self.text_elements`, and `self.remote_image_urls`. It computes a wrap width by subtracting `LIVE_PREFIX_COLS + 1`, derives `style` and cyan `element_style`, optionally wraps remote-image placeholder lines via `remote_image_display_line`, and then renders the message either as plain wrapped lines or via `build_user_message_lines_with_elements` followed by wrapping. Both paths trim trailing blank lines with `trim_trailing_blank_lines`. If both remote images and message are absent it returns an empty vector; otherwise it builds an output vector starting with a blank styled line, prefixes remote-image lines with two spaces, inserts a blank separator if both sections exist, prefixes message lines with bold dim `› ` and continuation `  `, appends a trailing blank styled line, and returns the result.

**Call relations**: This is the main visible renderer for user prompts. It delegates element-aware line construction and blank-line trimming to helpers and is paired with `raw_lines` for plain transcript output.

*Call graph*: calls 3 internal fn (build_user_message_lines_with_elements, trim_trailing_blank_lines, new); 4 external calls (from, new, from, vec!).


##### `UserHistoryCell::raw_lines`  (lines 179–193)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces a plain-text representation of the user prompt and any remote-image placeholders. It strips styling and wrapping prefixes while preserving section order.

**Data flow**: Starts from `raw_lines_from_source(self.message.trim_end_matches(['\r', '\n']))`, then if `remote_image_urls` is non-empty inserts a blank line after any message content and appends one `Line` per remote image using `local_image_label_text(index)`. It returns the resulting vector.

**Call relations**: This raw-output method complements `display_lines`, preserving message text and remote-image placeholders without viewport-specific formatting.

*Call graph*: 1 external calls (from).


##### `ReasoningSummaryCell::new`  (lines 208–215)

```
fn new(header: String, content: String, cwd: &Path, transcript_only: bool) -> Self
```

**Purpose**: Constructs a reasoning summary cell while snapshotting the session working directory. The captured `cwd` ensures local file links render consistently even after later directory changes.

**Data flow**: Consumes `header`, `content`, borrowed `cwd`, and `transcript_only`, clones `cwd` into a `PathBuf`, stores all fields, and returns the new cell.

**Call relations**: This constructor is used by `new_reasoning_summary_block` and tests that need a source-backed reasoning cell with stable file-link context.

*Call graph*: called by 5 (new_reasoning_summary_block, reasoning_summary_height_matches_wrapped_rendering_for_url_like_content, source_backed_cells_render_raw_source_without_prefix_or_style, wrapped_and_prefixed_cells_handle_tiny_widths, thread_to_transcript_cells); 1 external calls (to_path_buf).


##### `ReasoningSummaryCell::lines`  (lines 217–244)

```
fn lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Renders the reasoning summary body into dim italic wrapped lines with a bullet prefix. It parses markdown-like content and resolves local file links relative to the stored `cwd`.

**Data flow**: Reads `self.content` and `self.cwd`, calls `append_markdown` with usable content width reserving two columns, collects rendered lines, patches every span with a dim italic `summary_style`, then wraps the styled lines with `adaptive_wrap_lines` using initial indent `• ` and subsequent indent `  `. It returns the wrapped lines.

**Call relations**: This internal renderer is shared by both `display_lines` and `transcript_lines`, ensuring viewport and transcript reasoning output use the same markdown rendering.

*Call graph*: calls 2 internal fn (usable_content_width_u16, new); called by 2 (display_lines, transcript_lines); 3 external calls (as_path, default, new).


##### `ReasoningSummaryCell::display_lines`  (lines 248–254)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns visible reasoning-summary lines unless the cell is marked transcript-only. Transcript-only summaries are hidden from the viewport.

**Data flow**: Reads `self.transcript_only`; if true returns an empty vector, otherwise calls `self.lines(width)` and returns that result.

**Call relations**: This method is the viewport-facing rendering path and intentionally differs from `transcript_lines` only when `transcript_only` is set.

*Call graph*: calls 1 internal fn (lines); 1 external calls (new).


##### `ReasoningSummaryCell::transcript_lines`  (lines 256–258)

```
fn transcript_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns reasoning-summary lines for transcript rendering regardless of `transcript_only`. Transcript output always includes the summary content.

**Data flow**: Forwards the width to `self.lines(width)` and returns the resulting vector.

**Call relations**: This method ensures transcript export/history includes reasoning summaries even when the viewport suppresses them.

*Call graph*: calls 1 internal fn (lines).


##### `ReasoningSummaryCell::raw_lines`  (lines 260–266)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces plain raw lines for the reasoning summary when it is visible in the viewport; transcript-only summaries return no raw viewport lines. It uses the trimmed source content rather than rendered markdown lines.

**Data flow**: Reads `self.transcript_only`; if true returns an empty vector, otherwise calls `raw_lines_from_source(self.content.trim())` and returns the result.

**Call relations**: This raw-output method complements `display_lines` for viewport-visible reasoning summaries.

*Call graph*: 1 external calls (new).


##### `AgentMessageCell::new`  (lines 277–282)

```
fn new(lines: Vec<Line<'static>>, is_first_line: bool) -> Self
```

**Purpose**: Constructs a streamed assistant message cell from plain rendered lines in tests. It converts them into hyperlink-line form while preserving whether this chunk starts a new message.

**Data flow**: Consumes `Vec<Line<'static>>` and `is_first_line`, converts the lines with `plain_hyperlink_lines`, stores them with the flag, and returns the new cell.

**Call relations**: This constructor is test-only; production code typically uses `new_hyperlink_lines` with already annotated hyperlink lines.

*Call graph*: called by 4 (consolidation_walker_replaces_agent_message_cells, empty_agent_message_cell_transcript, streamed_agent_list_paragraph_preserves_item_indent_when_wrapped, wrapped_and_prefixed_cells_handle_tiny_widths).


##### `AgentMessageCell::new_hyperlink_lines`  (lines 284–289)

```
fn new_hyperlink_lines(lines: Vec<HyperlinkLine>, is_first_line: bool) -> Self
```

**Purpose**: Constructs a streamed assistant message cell from already prepared hyperlink-aware lines. It preserves whether the first rendered line should receive the bullet prefix.

**Data flow**: Consumes `Vec<HyperlinkLine>` and `is_first_line`, stores them directly, and returns the new cell.

**Call relations**: This is the normal constructor used by streaming message emission code when assistant output arrives incrementally.

*Call graph*: called by 1 (emit).


##### `AgentMessageCell::display_lines`  (lines 293–295)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns the visible assistant message lines by stripping hyperlink metadata from the hyperlink-aware rendering path. It keeps one source of truth for wrapping.

**Data flow**: Calls `self.display_hyperlink_lines(width)`, passes the result to `visible_lines`, and returns the resulting `Vec<Line<'static>>`.

**Call relations**: This method delegates to `display_hyperlink_lines`, ensuring plain and hyperlink-aware rendering stay synchronized.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `AgentMessageCell::display_hyperlink_lines`  (lines 297–317)

```
fn display_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Wraps streamed assistant lines with hyperlink preservation and message-prefix indentation. Only the first logical line of the first chunk gets the bullet prefix; continuations preserve leading whitespace.

**Data flow**: Iterates `self.lines` with index. For each line it chooses `initial_indent` as `• ` dimmed only when `index == 0 && self.is_first_line`, otherwise `  `. It builds `subsequent_indent` from two spaces plus any leading whitespace prefix extracted from the line via `insert_history::leading_whitespace_prefix`, then wraps the single hyperlink line with `adaptive_wrap_hyperlink_lines` and appends the wrapped output. It returns the accumulated `Vec<HyperlinkLine>`.

**Call relations**: This is the core renderer for streamed assistant chunks and is reused by both `display_lines` and `transcript_hyperlink_lines`.

*Call graph*: calls 3 internal fn (leading_whitespace_prefix, adaptive_wrap_hyperlink_lines, new); called by 2 (display_lines, transcript_hyperlink_lines); 3 external calls (from, new, from_ref).


##### `AgentMessageCell::transcript_hyperlink_lines`  (lines 319–321)

```
fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Returns transcript hyperlink lines identical to the visible hyperlink rendering for streamed assistant chunks. There is no transcript-specific divergence.

**Data flow**: Forwards the width to `display_hyperlink_lines` and returns the result.

**Call relations**: This method simply reuses the main hyperlink-aware renderer.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `AgentMessageCell::raw_lines`  (lines 323–325)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces plain raw lines from the stored streamed assistant chunk lines. It strips hyperlink metadata and styling without re-wrapping.

**Data flow**: Clones `self.lines`, converts them to visible `Line`s with `visible_lines`, passes those through `plain_lines`, and returns the result.

**Call relations**: This raw-output method complements the wrapped visible rendering while preserving the underlying streamed content.


##### `AgentMessageCell::is_stream_continuation`  (lines 327–329)

```
fn is_stream_continuation(&self) -> bool
```

**Purpose**: Reports whether this assistant chunk continues an existing streamed message rather than starting a new one. It is the inverse of `is_first_line`.

**Data flow**: Reads `self.is_first_line` and returns `!self.is_first_line`.

**Call relations**: This flag is used by higher-level transcript logic that needs to understand chunk boundaries within a streamed assistant response.


##### `AgentMarkdownCell::new`  (lines 355–360)

```
fn new(markdown_source: String, cwd: &Path) -> Self
```

**Purpose**: Constructs a finalized assistant message cell backed by raw markdown source and a captured working directory. This allows correct re-rendering after resize or cwd changes.

**Data flow**: Consumes `markdown_source` and borrowed `cwd`, clones `cwd` into a `PathBuf`, stores both fields, and returns the new cell.

**Call relations**: This constructor is used when stream consolidation replaces many `AgentMessageCell`s with one source-backed finalized assistant message.

*Call graph*: called by 10 (handle_consolidate_agent_message, agent_markdown_cell_does_not_split_words_after_inline_markdown, agent_markdown_cell_narrow_width_shows_prefix_only, agent_markdown_cell_renders_source_at_different_widths, agent_markdown_cell_survives_insert_history_rewrap, consolidation_walker_replaces_agent_message_cells, source_backed_cells_render_raw_source_without_prefix_or_style, wrapped_and_prefixed_cells_handle_tiny_widths, transcript_overlay_live_tail_preserves_semantic_web_links, thread_to_transcript_cells); 1 external calls (to_path_buf).


##### `AgentMarkdownCell::display_lines`  (lines 364–366)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns visible assistant markdown lines by stripping hyperlink metadata from the hyperlink-aware markdown renderer. It keeps markdown reflow logic centralized.

**Data flow**: Calls `self.display_hyperlink_lines(width)`, converts the result with `visible_lines`, and returns the visible lines.

**Call relations**: This method delegates to `display_hyperlink_lines`, which is the source of truth for markdown rendering and link annotation.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `AgentMarkdownCell::display_hyperlink_lines`  (lines 368–387)

```
fn display_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Re-renders the stored markdown source at the current width with hyperlink and local-file-link support, then prefixes it as an assistant message. It intentionally renders from source rather than preserving stale wrapped lines.

**Data flow**: Reads `self.markdown_source` and `self.cwd`. It computes usable content width reserving two columns; if no width is available, it returns a single blank hyperlink line prefixed with `• `. Otherwise it calls `render_markdown_agent_with_links_and_cwd` with the markdown source, wrap width, and cwd, then prefixes the resulting hyperlink lines with initial `• ` dimmed and subsequent `  `. It returns the prefixed `Vec<HyperlinkLine>`.

**Call relations**: This is the core finalized-assistant renderer used by both visible and transcript hyperlink output. It is what makes resize reflow and cwd-stable file links work correctly.

*Call graph*: calls 2 internal fn (render_markdown_agent_with_links_and_cwd, usable_content_width_u16); called by 2 (display_lines, transcript_hyperlink_lines); 2 external calls (as_path, vec!).


##### `AgentMarkdownCell::transcript_hyperlink_lines`  (lines 389–391)

```
fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Returns transcript hyperlink lines identical to the visible markdown rendering. Finalized assistant markdown does not distinguish transcript from viewport layout.

**Data flow**: Forwards the width to `display_hyperlink_lines` and returns the result.

**Call relations**: This method simply reuses the main markdown hyperlink renderer.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `AgentMarkdownCell::raw_lines`  (lines 393–395)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns the raw markdown source split into plain lines. It preserves the original assistant message source rather than rendered terminal formatting.

**Data flow**: Calls `raw_lines_from_source(&self.markdown_source)` and returns the resulting vector.

**Call relations**: This raw-output method is the source-faithful counterpart to the width-dependent markdown renderer.


##### `StreamingAgentTailCell::new`  (lines 410–415)

```
fn new(lines: Vec<HyperlinkLine>, is_first_line: bool) -> Self
```

**Purpose**: Constructs the transient active-cell representation of the mutable tail of a streaming assistant response. It stores already rendered hyperlink lines and whether this tail starts a new message.

**Data flow**: Consumes `Vec<HyperlinkLine>` and `is_first_line`, stores them directly, and returns the new cell.

**Call relations**: This constructor is used by stream-synchronization code while assistant output is still in flight.

*Call graph*: called by 2 (sync_active_stream_tail, streaming_agent_tail_blank_line_uses_one_viewport_row).


##### `StreamingAgentTailCell::display_lines`  (lines 419–421)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns visible lines for the streaming tail by stripping hyperlink metadata from the hyperlink-aware tail renderer. It avoids duplicating prefix logic.

**Data flow**: Calls `self.display_hyperlink_lines(width)`, converts the result with `visible_lines`, and returns the visible lines.

**Call relations**: This method delegates to `display_hyperlink_lines`, which is the authoritative rendering path for the in-flight tail.

*Call graph*: calls 1 internal fn (display_hyperlink_lines); called by 1 (raw_lines).


##### `StreamingAgentTailCell::display_hyperlink_lines`  (lines 423–447)

```
fn display_hyperlink_lines(&self, _width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Prefixes the already rendered streaming tail lines without re-wrapping them, preserving in-progress table structure. It also normalizes whitespace-only lines to truly blank lines with no hyperlinks.

**Data flow**: Clones `self.lines`, prefixes them with `prefix_hyperlink_lines` using initial `• ` dimmed when `is_first_line` else `  ` and subsequent `  `. It then iterates the prefixed lines and, for any line whose spans are all whitespace, replaces `line.line` with `Line::default().style(line.line.style)` and clears `line.hyperlinks`. It returns the adjusted `Vec<HyperlinkLine>`.

**Call relations**: This is the core renderer for the active streaming tail and is reused by both visible and transcript hyperlink output. Its no-rewrap policy is specific to in-flight content.

*Call graph*: called by 2 (display_lines, transcript_hyperlink_lines); 1 external calls (default).


##### `StreamingAgentTailCell::transcript_hyperlink_lines`  (lines 449–451)

```
fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Returns transcript hyperlink lines identical to the visible streaming-tail rendering. The active tail uses one rendering path in both contexts.

**Data flow**: Forwards the width to `display_hyperlink_lines` and returns the result.

**Call relations**: This method simply delegates to the main tail renderer.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `StreamingAgentTailCell::raw_lines`  (lines 453–455)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces plain raw lines for the streaming tail by rendering it at maximal width and stripping styling. This preserves the current in-flight visible content.

**Data flow**: Calls `self.display_lines(u16::MAX)`, passes the result through `plain_lines`, and returns the resulting vector.

**Call relations**: This raw-output method depends on the visible tail renderer so blank-line normalization and prefix behavior remain aligned.

*Call graph*: calls 1 internal fn (display_lines).


##### `StreamingAgentTailCell::is_stream_continuation`  (lines 457–459)

```
fn is_stream_continuation(&self) -> bool
```

**Purpose**: Reports whether this tail continues an existing assistant message rather than starting a new one. It mirrors the semantics used by `AgentMessageCell`.

**Data flow**: Reads `self.is_first_line` and returns `!self.is_first_line`.

**Call relations**: This flag is used by higher-level streaming logic to understand whether the active tail begins a new assistant message.


##### `new_user_prompt`  (lines 461–473)

```
fn new_user_prompt(
    message: String,
    text_elements: Vec<TextElement>,
    local_image_paths: Vec<PathBuf>,
    remote_image_urls: Vec<String>,
) -> UserHistoryCell
```

**Purpose**: Convenience constructor for `UserHistoryCell`. It packages the raw message, structured text elements, and image references into one history cell value.

**Data flow**: Consumes `message`, `text_elements`, `local_image_paths`, and `remote_image_urls`, stores them directly in a `UserHistoryCell`, and returns it.

**Call relations**: This helper is the normal entrypoint used when adding a user prompt to transcript history.


##### `new_reasoning_summary_block`  (lines 478–510)

```
fn new_reasoning_summary_block(
    full_reasoning_buffer: String,
    cwd: &Path,
) -> Box<dyn HistoryCell>
```

**Purpose**: Extracts a collapsed reasoning summary cell from the full reasoning buffer, preserving the session working directory for later link rendering. If no bolded header-plus-body split is found, it falls back to a transcript-only summary.

**Data flow**: Consumes the full reasoning buffer and borrowed `cwd`, clones `cwd` to a `PathBuf`, trims the buffer, then searches for the first `**...**` span. If it finds a bolded header and there is remaining content after the closing `**`, it splits the buffer into `header_buffer` and `summary_buffer` and returns a boxed `ReasoningSummaryCell::new(..., transcript_only: false)`. Otherwise it returns a boxed `ReasoningSummaryCell` with empty header, the full trimmed buffer as content, and `transcript_only: true`.

**Call relations**: This helper is used when a reasoning block finishes and the app needs to inject a collapsed reasoning artifact into history. It delegates actual rendering behavior to `ReasoningSummaryCell`.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, to_path_buf).


### `tui/src/history_cell/plans.rs`

`domain_logic` · `during plan streaming, plan finalization, and later transcript display or resize reflow`

This file contains both source-backed and pre-rendered plan cells. `ProposedPlanCell` is the finalized form: it stores raw markdown plus the session cwd so it can re-render markdown links and wrapping correctly on terminal resize. Its rich rendering prepends a `• Proposed Plan` header, inserts blank spacer lines, renders markdown through `render_markdown_agent_with_links_and_cwd`, substitutes an italic `(empty)` marker when the body is empty, prefixes body lines with two-space indentation, and applies `proposed_plan_style` to the whole plan block. Raw mode returns the original markdown split by source newlines.

`ProposedPlanStreamCell` and `StreamingPlanTailCell` are transient streaming representations that hold already-rendered `HyperlinkLine`s. They can display and transcript-render those lines directly and expose `is_stream_continuation` so insertion logic can treat them as stream fragments. Because they are not source-backed, they cannot reflow on resize and are intended to be replaced by `ProposedPlanCell` once streaming completes.

`PlanUpdateCell` renders `UpdatePlanArgs` as a user-friendly checklist. It optionally shows a dim italic explanation note, then either an italic `(no steps provided)` placeholder or one wrapped line group per `PlanItemArg`, styling completed steps as crossed-out/dim with `✔`, in-progress steps as bold cyan `□`, and pending steps as dim `□`. The final block is prefixed with `  └ ` / `    ` indentation. Raw mode emits plain text lines including `Debug`-formatted statuses for each step.

#### Function details

##### `StreamingPlanTailCell::new`  (lines 17–22)

```
fn new(lines: Vec<HyperlinkLine>, is_stream_continuation: bool) -> Self
```

**Purpose**: Constructs a transient active-cell tail from already rendered hyperlink lines and a continuation flag.

**Data flow**: It takes `lines: Vec<HyperlinkLine>` and `is_stream_continuation: bool`, stores them directly, and returns a `StreamingPlanTailCell`.

**Call relations**: Streaming synchronization logic creates this cell when updating the mutable active tail of an in-flight proposed plan.

*Call graph*: called by 1 (sync_active_stream_tail).


##### `StreamingPlanTailCell::display_lines`  (lines 26–28)

```
fn display_lines(&self, _width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns the visible rich lines for the streaming tail without rewrapping or re-rendering source.

**Data flow**: It clones `self.lines`, strips hyperlink metadata with `visible_lines`, and returns the resulting `Vec<Line<'static>>`.

**Call relations**: Main viewport rendering uses this for transient plan-tail display.


##### `StreamingPlanTailCell::display_hyperlink_lines`  (lines 30–32)

```
fn display_hyperlink_lines(&self, _width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Exposes the pre-rendered hyperlink-aware lines for the streaming tail unchanged.

**Data flow**: It clones and returns `self.lines` directly.

**Call relations**: Transcript and rich rendering paths use this to preserve hyperlink metadata already computed upstream.

*Call graph*: called by 1 (transcript_hyperlink_lines).


##### `StreamingPlanTailCell::transcript_hyperlink_lines`  (lines 34–36)

```
fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Keeps transcript-overlay rendering identical to the main rich rendering for the streaming tail.

**Data flow**: It forwards `width` to `self.display_hyperlink_lines(width)` and returns the cloned lines.

**Call relations**: Transcript overlay uses this so the active streamed tail matches the viewport exactly.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `StreamingPlanTailCell::raw_lines`  (lines 38–40)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces plain-text raw lines from the pre-rendered streaming tail.

**Data flow**: It clones `self.lines`, converts them to visible `Line`s with `visible_lines`, strips styling with `plain_lines`, and returns the result.

**Call relations**: Raw transcript mode uses this for copyable output from transient streamed plan tails.


##### `StreamingPlanTailCell::is_stream_continuation`  (lines 42–44)

```
fn is_stream_continuation(&self) -> bool
```

**Purpose**: Reports whether this tail should be treated as a continuation of a prior streamed plan fragment.

**Data flow**: It returns the stored `self.is_stream_continuation` boolean.

**Call relations**: History insertion logic consults this flag when deciding how to merge or visually place streamed plan fragments.


##### `new_plan_update`  (lines 47–50)

```
fn new_plan_update(update: UpdatePlanArgs) -> PlanUpdateCell
```

**Purpose**: Converts protocol `UpdatePlanArgs` into a `PlanUpdateCell` ready for transcript rendering.

**Data flow**: It destructures `update` into `explanation` and `plan`, stores both fields in a new `PlanUpdateCell`, and returns it.

**Call relations**: Plan-update events call this helper to transform protocol payloads into UI history cells.


##### `new_proposed_plan`  (lines 57–62)

```
fn new_proposed_plan(plan_markdown: String, cwd: &Path) -> ProposedPlanCell
```

**Purpose**: Creates the finalized, source-backed proposed-plan cell from markdown and the current cwd.

**Data flow**: It takes `plan_markdown: String` and `cwd: &Path`, clones `cwd` with `to_path_buf`, stores both in `ProposedPlanCell`, and returns it.

**Call relations**: Controllers use this after a plan stream completes so the finalized history entry can re-render correctly on future resizes.

*Call graph*: 1 external calls (to_path_buf).


##### `new_proposed_plan_stream`  (lines 68–76)

```
fn new_proposed_plan_stream(
    lines: Vec<impl Into<HyperlinkLine>>,
    is_stream_continuation: bool,
) -> ProposedPlanStreamCell
```

**Purpose**: Creates a transient proposed-plan stream cell from already rendered lines and a continuation marker.

**Data flow**: It consumes `lines: Vec<impl Into<HyperlinkLine>>`, converts each item into `HyperlinkLine`, collects them into a vector, stores `is_stream_continuation`, and returns `ProposedPlanStreamCell`.

**Call relations**: Streaming plan output uses this helper before consolidation into a source-backed `ProposedPlanCell`.


##### `ProposedPlanCell::display_lines`  (lines 101–103)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns the visible rich lines for a finalized proposed plan by stripping hyperlink metadata from its rich rendering.

**Data flow**: It calls `self.display_hyperlink_lines(width)`, converts the result with `visible_lines`, and returns the visible lines.

**Call relations**: Main viewport rendering uses this convenience wrapper while hyperlink-aware paths call the richer method directly.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `ProposedPlanCell::display_hyperlink_lines`  (lines 105–127)

```
fn display_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Renders the finalized proposed plan as a styled, indented markdown block with a header and preserved local-link context.

**Data flow**: It initializes header lines for `• Proposed Plan` and a blank spacer, creates a plan block starting with another blank line, computes `wrap_width` as `width - 4` clamped to at least 1, renders `self.plan_markdown` with `render_markdown_agent_with_links_and_cwd(..., Some(self.cwd.as_path()))`, substitutes an italic `(empty)` line if the markdown renderer returns no body, prefixes body lines with two-space indentation via `prefix_hyperlink_lines`, appends a trailing blank line, styles the entire plan block with `proposed_plan_style`, and returns the combined `Vec<HyperlinkLine>`.

**Call relations**: Both viewport and transcript rich rendering delegate here so finalized plans have one canonical styled representation.

*Call graph*: calls 2 internal fn (render_markdown_agent_with_links_and_cwd, new); called by 2 (display_lines, transcript_hyperlink_lines); 3 external calls (from, as_path, vec!).


##### `ProposedPlanCell::transcript_hyperlink_lines`  (lines 129–131)

```
fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Uses the same hyperlink-aware rendering for transcript overlay as for the main viewport.

**Data flow**: It returns `self.display_hyperlink_lines(width)` unchanged.

**Call relations**: Transcript overlay relies on this to keep finalized plan appearance consistent across views.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `ProposedPlanCell::raw_lines`  (lines 133–135)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns the original markdown source split into raw logical lines.

**Data flow**: It passes `&self.plan_markdown` to `raw_lines_from_source` and returns the resulting plain `Vec<Line<'static>>`.

**Call relations**: Raw transcript mode uses this source-faithful representation instead of the styled markdown rendering.


##### `ProposedPlanStreamCell::display_lines`  (lines 139–141)

```
fn display_lines(&self, _width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns visible rich lines for a transient streamed plan fragment without re-rendering source.

**Data flow**: It clones `self.lines`, strips hyperlink metadata with `visible_lines`, and returns the visible lines.

**Call relations**: Main viewport rendering uses this for in-flight streamed plan fragments.


##### `ProposedPlanStreamCell::display_hyperlink_lines`  (lines 143–145)

```
fn display_hyperlink_lines(&self, _width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Exposes the pre-rendered hyperlink lines of a streamed plan fragment unchanged.

**Data flow**: It clones and returns `self.lines`.

**Call relations**: Transcript and rich rendering paths use this to preserve hyperlink metadata generated during streaming.

*Call graph*: called by 1 (transcript_hyperlink_lines).


##### `ProposedPlanStreamCell::transcript_hyperlink_lines`  (lines 147–149)

```
fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Keeps transcript-overlay rendering identical to the rich viewport rendering for streamed plan fragments.

**Data flow**: It forwards to `self.display_hyperlink_lines(width)` and returns the cloned lines.

**Call relations**: Transcript overlay uses this so streamed plan fragments appear the same in both contexts.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `ProposedPlanStreamCell::raw_lines`  (lines 151–153)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces plain-text raw lines from the pre-rendered streamed plan fragment.

**Data flow**: It clones `self.lines`, converts them to visible lines with `visible_lines`, strips styling via `plain_lines`, and returns the result.

**Call relations**: Raw transcript mode uses this for copyable output from transient streamed plan cells.


##### `ProposedPlanStreamCell::is_stream_continuation`  (lines 155–157)

```
fn is_stream_continuation(&self) -> bool
```

**Purpose**: Reports whether this streamed plan fragment continues a previous fragment.

**Data flow**: It returns the stored `self.is_stream_continuation` flag.

**Call relations**: History insertion logic checks this to decide how to place or merge streamed plan fragments.


##### `PlanUpdateCell::display_lines`  (lines 167–217)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Renders a structured plan update as a checklist-style transcript block with optional explanation and per-step status styling.

**Data flow**: It reads `self.explanation`, `self.plan`, and `width`. Two local closures wrap note text and step text using `adaptive_wrap_line` and `push_owned_lines`; step rendering chooses marker and style from `StepStatus` (`✔` crossed-out/dim for completed, bold cyan `□` for in-progress, dim `□` for pending). The function starts with a `• Updated Plan` header, trims and filters the optional explanation before rendering it, emits `(no steps provided)` when `plan` is empty, otherwise renders each `PlanItemArg { step, status }`, prefixes the resulting block with `prefix_lines(..., "  └ ", "    ")`, and returns the full line vector.

**Call relations**: Plan-update events use this rich renderer to present machine-structured plan state in a readable todo-list form.

*Call graph*: 2 external calls (from, vec!).


##### `PlanUpdateCell::raw_lines`  (lines 219–237)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces a plain-text representation of a plan update, preserving explanation line breaks and exposing step statuses textually.

**Data flow**: It starts with `Updated Plan`, trims and filters the optional explanation and extends with `raw_lines_from_source(explanation)` when present, emits `(no steps provided)` if `self.plan` is empty, otherwise appends one line per step formatted as `"{status:?}: {step}"`, and returns the vector.

**Call relations**: Raw transcript mode uses this simpler textual form instead of the styled checklist rendering.

*Call graph*: 3 external calls (from, format!, vec!).


### `tui/src/history_cell/approvals.rs`

`domain_logic` · `request handling`

This file contains the approval-specific presentation logic for transcript history cells. It defines two enums that capture the rendered semantics: `ReviewDecision` distinguishes one-time approvals, session approvals, policy amendments, denials, timeouts, and aborts; `ApprovalDecisionSubject` distinguishes command execution from network access. The helper pipeline for command text starts with `exec_snippet`, which strips shell-wrapper noise via `strip_bash_lc_and_escape`, truncates to the first line with an ellipsis if multiline, and then limits the visible grapheme count to 80. `new_approval_decision_cell` is the main constructor: it pattern-matches both decision and subject, chooses a green check or red cross prefix, and builds a `Vec<Span>` summary with exact wording that varies by actor (`User` vs `Guardian`) and by whether a command snippet is available. Network policy amendments also inspect `NetworkPolicyRuleAction` to distinguish persisted allow vs deny rules. All of these summaries are wrapped in `PrefixedWrappedHistoryCell`, so long command snippets wrap under a fixed two-space continuation prefix. The remaining constructors cover guardian-specific patch/action outcomes and a cyan `PlainHistoryCell` status line for in-progress review state. A small `ApprovalDecisionActor::subject` helper centralizes the actor prefix strings used throughout the wording.

#### Function details

##### `truncate_exec_snippet`  (lines 5–12)

```
fn truncate_exec_snippet(full_cmd: &str) -> String
```

**Purpose**: Reduces a full command string to a short, single-snippet display form. Multiline commands are collapsed to the first line plus ` ...`, then grapheme-truncated for transcript readability.

**Data flow**: Accepts `&str` command text, splits once on newline, formats either the first line with an ellipsis or the whole command unchanged, then passes that intermediate string through `truncate_text` with an 80-grapheme limit. It returns the truncated `String` without mutating external state.

**Call relations**: This helper is only used by `exec_snippet`, which first normalizes shell-wrapper syntax before applying this display-oriented truncation.

*Call graph*: called by 1 (exec_snippet); 1 external calls (format!).


##### `exec_snippet`  (lines 14–17)

```
fn exec_snippet(command: &[String]) -> String
```

**Purpose**: Produces the user-visible command snippet for approval cells from a shell command vector. It removes `bash -lc` wrapping and escaping noise before truncating.

**Data flow**: Takes a borrowed slice of command arguments, converts it to a normalized command string with `strip_bash_lc_and_escape`, then passes that string to `truncate_exec_snippet`. It returns the resulting `String`.

**Call relations**: This is the common command-summary helper used directly in some approval branches and indirectly through `non_empty_exec_snippet` when the caller wants to suppress empty snippets.

*Call graph*: calls 1 internal fn (truncate_exec_snippet); called by 2 (new_approval_decision_cell, non_empty_exec_snippet).


##### `non_empty_exec_snippet`  (lines 19–22)

```
fn non_empty_exec_snippet(command: &[String]) -> Option<String>
```

**Purpose**: Returns a command snippet only when the normalized command text is non-empty. It lets approval wording fall back to generic phrases like `this request` when there is nothing useful to show.

**Data flow**: Accepts a borrowed command slice, computes the snippet via `exec_snippet`, and converts it into `Option<String>` using `then_some` based on emptiness. It writes no state.

**Call relations**: This helper is used by `new_approval_decision_cell` in branches where the wording differs depending on whether a concrete command snippet exists.

*Call graph*: calls 1 internal fn (exec_snippet); called by 1 (new_approval_decision_cell).


##### `new_approval_decision_cell`  (lines 45–264)

```
fn new_approval_decision_cell(
    subject: ApprovalDecisionSubject,
    decision: ReviewDecision,
    actor: ApprovalDecisionActor,
) -> Box<dyn HistoryCell>
```

**Purpose**: Builds the main approval/denial transcript cell for command and network-access review outcomes. It selects exact wording, color, and emphasis based on decision type, subject, and actor.

**Data flow**: Consumes an `ApprovalDecisionSubject`, `ReviewDecision`, and `ApprovalDecisionActor`. It pattern-matches the decision, then often pattern-matches the subject again to build a `(symbol, summary)` pair where `symbol` is a colored `Span` and `summary` is a `Vec<Span>` containing actor text, bolded verbs, optional dimmed command snippets or targets, and qualifiers like `this time` or `every time this session`. For command-related branches it calls `non_empty_exec_snippet` or `exec_snippet`; for network policy amendments it may derive the target from either the subject or the amendment payload. It returns a boxed `PrefixedWrappedHistoryCell` with the summary line and a two-space continuation prefix.

**Call relations**: This constructor is the central approval-cell factory used by higher-level transcript assembly whenever a review decision event arrives. It delegates command summarization to the snippet helpers and wrapping/prefix behavior to `PrefixedWrappedHistoryCell::new`.

*Call graph*: calls 3 internal fn (exec_snippet, non_empty_exec_snippet, new); 4 external calls (new, from, from, vec!).


##### `ApprovalDecisionActor::subject`  (lines 273–278)

```
fn subject(self) -> &'static str
```

**Purpose**: Returns the actor prefix string used in approval summaries. It keeps user-facing wording consistent between user-driven and guardian-driven decisions.

**Data flow**: Consumes `self` by value and matches `User` to `You ` and `Guardian` to `Auto-reviewer `. It returns a `'static` string slice and does not allocate.

**Call relations**: This helper is called throughout `new_approval_decision_cell` to prepend actor-specific wording without duplicating string literals.


##### `new_guardian_denied_patch_request`  (lines 281–301)

```
fn new_guardian_denied_patch_request(files: Vec<String>) -> Box<dyn HistoryCell>
```

**Purpose**: Builds a guardian denial cell specifically for patch-application requests. It summarizes either the single touched file or the count of touched files.

**Data flow**: Consumes a `Vec<String>` of file paths, initializes a summary span vector with `Request denied for codex to apply`, then branches on `files.len()`: for one file it inserts the dimmed filename, otherwise it inserts the dimmed file count and the word `files`. It returns a boxed `PrefixedWrappedHistoryCell` with a red `✗ ` prefix.

**Call relations**: This specialized constructor is used when the guardian denies a patch request rather than a generic action request, so the transcript can mention file scope concretely.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, from, from, vec!).


##### `new_guardian_denied_action_request`  (lines 303–311)

```
fn new_guardian_denied_action_request(summary: String) -> Box<dyn HistoryCell>
```

**Purpose**: Builds a guardian denial cell for a generic summarized action. It renders the supplied summary text dimmed after a fixed denial phrase.

**Data flow**: Consumes an owned `String` summary, constructs a single `Line` from spans `Request`, bold `denied`, `for`, and the dimmed summary, then wraps it in a boxed `PrefixedWrappedHistoryCell` with a red prefix.

**Call relations**: This is the generic guardian-denial constructor used when the caller already has a concise action summary and does not need patch-specific file counting.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, from, vec!).


##### `new_guardian_approved_action_request`  (lines 313–321)

```
fn new_guardian_approved_action_request(summary: String) -> Box<dyn HistoryCell>
```

**Purpose**: Builds a guardian approval cell for a generic summarized action. It mirrors the denied-action constructor but uses approval wording and a green prefix.

**Data flow**: Consumes an owned `String` summary, builds a `Line` containing `Request approved for <summary>` with the verb bolded and the summary dimmed, and returns a boxed `PrefixedWrappedHistoryCell` prefixed by green `✔ `.

**Call relations**: This constructor is used for guardian-approved generic actions, complementing the denial and timeout variants with parallel formatting.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, from, vec!).


##### `new_guardian_timed_out_patch_request`  (lines 323–343)

```
fn new_guardian_timed_out_patch_request(files: Vec<String>) -> Box<dyn HistoryCell>
```

**Purpose**: Builds a timeout cell for patch requests that were not reviewed in time. It reports either the single touched file or the number of touched files.

**Data flow**: Consumes a `Vec<String>` of file paths, assembles spans beginning with `Review timed out before codex could apply`, then inserts either a dimmed filename or a dimmed file count plus `files` depending on length. It returns a boxed `PrefixedWrappedHistoryCell` with a red `✗ ` prefix.

**Call relations**: This specialized constructor is used for patch-review timeout events so the transcript can preserve patch scope even when no approval decision was reached.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, from, from, vec!).


##### `new_guardian_timed_out_action_request`  (lines 345–353)

```
fn new_guardian_timed_out_action_request(summary: String) -> Box<dyn HistoryCell>
```

**Purpose**: Builds a timeout cell for a generic action request. It states that review timed out before the summarized action could proceed.

**Data flow**: Consumes an owned summary `String`, creates a `Line` from spans `Review`, bold `timed out`, `before`, and the dimmed summary, and returns a boxed `PrefixedWrappedHistoryCell` with a red prefix.

**Call relations**: This is the generic timeout counterpart to the guardian approval and denial action constructors.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, from, vec!).


##### `new_review_status_line`  (lines 356–360)

```
fn new_review_status_line(message: String) -> PlainHistoryCell
```

**Purpose**: Creates a plain cyan status line describing the current review state while approval is still pending. Unlike decision cells, it is not prefixed with success/failure symbols.

**Data flow**: Consumes an owned `String` message, wraps `message.cyan()` in a single `Line`, stores it in a `PlainHistoryCell`, and returns that cell by value.

**Call relations**: This helper is used for transient review-status updates rather than final approval outcomes, so it returns a simple plain cell instead of a wrapped prefixed one.

*Call graph*: 1 external calls (vec!).


### `tui/src/history_cell/exec.rs`

`domain_logic` · `request handling`

This file covers two related transcript artifacts for background terminals. `UnifiedExecInteractionCell` represents a single interaction with a background terminal, storing an optional `command_display` and the exact `stdin` sent. Its `display_lines` method distinguishes a pure wait event from actual interaction: waits render as a single bold bullet line, while interactions render a dim arrow header plus wrapped stdin lines under a tree-style `└` prefix. `raw_lines` mirrors that distinction in plain text and appends the original stdin via `raw_lines_from_source`. The free constructor `new_unified_exec_interaction` is just a convenience wrapper. The second half of the file summarizes multiple running background terminals. `UnifiedExecProcessesCell` stores `UnifiedExecProcessDetails` entries containing a command display and recent output chunks. Its renderer emits a `Background terminals` heading, handles the empty case explicitly, limits output to 16 processes, truncates command snippets to the first line and at most 80 graphemes, then further width-truncates both commands and recent chunks with a ` [...]` suffix when needed. Extremely narrow widths degrade gracefully to showing only prefixes. If more than 16 processes exist, it appends an `... and N more running` line. `new_unified_exec_processes_output` packages a magenta `/ps` command line and the summary cell into a `CompositeHistoryCell`.

#### Function details

##### `UnifiedExecInteractionCell::new`  (lines 12–17)

```
fn new(command_display: Option<String>, stdin: String) -> Self
```

**Purpose**: Constructs a history cell representing one background-terminal interaction or wait event. It stores the optional command label and the stdin payload exactly as provided.

**Data flow**: Consumes `Option<String>` for `command_display` and an owned `String` for `stdin`, stores them in the struct, and returns the new `UnifiedExecInteractionCell`.

**Call relations**: This constructor underlies the public helper `new_unified_exec_interaction` and is also exercised directly by tests that validate wrapping and height behavior.

*Call graph*: called by 3 (new_unified_exec_interaction, unified_exec_interaction_cell_does_not_split_url_like_stdin_token, unified_exec_interaction_cell_height_matches_wrapped_rendering).


##### `UnifiedExecInteractionCell::display_lines`  (lines 21–63)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Renders the interaction as wrapped transcript lines, with different layouts for pure waits versus actual stdin input. It preserves stdin line boundaries and indents them under a header.

**Data flow**: Reads `self.command_display` and `self.stdin`. If `width == 0`, it returns no lines. It computes whether this is a wait-only event from `stdin.is_empty()`, builds a header line with either `• Waited for background terminal` or `↳ Interacted with background terminal`, optionally appends a dimmed command label, wraps that header with `adaptive_wrap_line`, and pushes the wrapped lines into output. For non-empty stdin it splits `stdin` into lines, converts them to `Line`s, wraps them with `adaptive_wrap_lines` using `  └ ` and `    ` indents, and appends them. It returns the assembled `Vec<Line<'static>>`.

**Call relations**: This is the visible rendering path for interaction cells. It is paired with `raw_lines`, which preserves the same semantic distinction without viewport-specific wrapping.

*Call graph*: calls 1 internal fn (new); 3 external calls (from, new, vec!).


##### `UnifiedExecInteractionCell::raw_lines`  (lines 65–95)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces an unwrapped plain-text representation of the interaction. It emits a descriptive header and, for actual interactions, appends the original stdin content as raw lines.

**Data flow**: Reads `self.stdin` and optional non-empty `self.command_display`. For empty stdin it returns a single line `Waited for background terminal` with an optional `: <command>` suffix. Otherwise it returns `Interacted with background terminal` with an optional command suffix, then extends the output with `raw_lines_from_source(&self.stdin)`. It returns the resulting vector.

**Call relations**: This raw-output method complements `display_lines`, preserving the same event semantics for transcript export or testing.

*Call graph*: 3 external calls (from, new, format!).


##### `new_unified_exec_interaction`  (lines 98–103)

```
fn new_unified_exec_interaction(
    command_display: Option<String>,
    stdin: String,
) -> UnifiedExecInteractionCell
```

**Purpose**: Convenience constructor for `UnifiedExecInteractionCell`. It lets callers create the cell without naming the concrete type directly.

**Data flow**: Consumes `command_display` and `stdin`, forwards them to `UnifiedExecInteractionCell::new`, and returns the resulting cell by value.

**Call relations**: This helper is the normal entrypoint used by higher-level code when recording a background-terminal interaction.

*Call graph*: calls 1 internal fn (new).


##### `UnifiedExecProcessesCell::new`  (lines 111–113)

```
fn new(processes: Vec<UnifiedExecProcessDetails>) -> Self
```

**Purpose**: Constructs the internal process-summary cell from a list of process details. It stores the process list unchanged for later width-aware rendering.

**Data flow**: Consumes a `Vec<UnifiedExecProcessDetails>`, stores it in the struct, and returns the new `UnifiedExecProcessesCell`.

**Call relations**: This private constructor is used by `new_unified_exec_processes_output` when assembling the `/ps` transcript artifact.

*Call graph*: called by 1 (new_unified_exec_processes_output).


##### `UnifiedExecProcessesCell::display_lines`  (lines 123–225)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Renders a compact summary of running background terminals, including truncated command snippets and recent output chunks. It enforces a maximum of 16 displayed processes and degrades gracefully on narrow widths.

**Data flow**: Reads `self.processes` and the requested width. If width is zero it returns no lines. Otherwise it emits a heading and blank line, handles the empty-process case with an italic message, then iterates up to 16 processes. For each process it derives a first-line command snippet, truncates it to 80 graphemes or multiline indication, then width-truncates it with `take_prefix_by_width`, appending ` [...]` when needed. It emits each process under `  • ` in cyan, then iterates `recent_chunks`, width-truncating each under `    ↳ ` for the first chunk and `      ` for later chunks. If additional processes remain, it appends an `... and N more running` line. It returns the built `Vec<Line<'static>>`.

**Call relations**: This renderer is reused by both `raw_lines` and `desired_height`, making it the single source of truth for process-summary layout.

*Call graph*: called by 2 (desired_height, raw_lines); 5 external calls (from, width, new, format!, vec!).


##### `UnifiedExecProcessesCell::raw_lines`  (lines 227–229)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns a plain-text version of the process summary by reusing the widest possible visible rendering. This avoids maintaining a separate raw formatting path.

**Data flow**: Calls `self.display_lines(u16::MAX)`, passes the result through `plain_lines`, and returns the plain vector. It does not mutate state.

**Call relations**: This method delegates entirely to `display_lines`, ensuring raw output stays structurally aligned with visible output.

*Call graph*: calls 1 internal fn (display_lines).


##### `UnifiedExecProcessesCell::desired_height`  (lines 231–233)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Computes the rendered height of the process summary at a given width. It uses the actual display renderer rather than estimating.

**Data flow**: Calls `self.display_lines(width)`, takes the resulting vector length, casts it to `u16`, and returns it.

**Call relations**: This method depends on `display_lines` so height calculations exactly match the visible process-summary layout.

*Call graph*: calls 1 internal fn (display_lines).


##### `new_unified_exec_processes_output`  (lines 236–242)

```
fn new_unified_exec_processes_output(
    processes: Vec<UnifiedExecProcessDetails>,
) -> CompositeHistoryCell
```

**Purpose**: Builds the full `/ps` transcript artifact by combining the command line and the process summary. It returns a composite cell ready for insertion into history.

**Data flow**: Consumes a `Vec<UnifiedExecProcessDetails>`, creates a `PlainHistoryCell` containing a magenta `/ps` line, creates a `UnifiedExecProcessesCell` from the process list, boxes both, and returns a `CompositeHistoryCell` containing them in order.

**Call relations**: This is the public constructor used when the TUI records a process-summary output. It delegates actual summary rendering to `UnifiedExecProcessesCell::new` and composition to `CompositeHistoryCell::new`.

*Call graph*: calls 3 internal fn (new, new, new); 1 external calls (vec!).


### `tui/src/history_cell/mcp.rs`

`domain_logic` · `request handling`

This file contains the TUI presentation layer for Model Context Protocol activity. `McpToolCallCell` tracks one tool invocation by `call_id`, `McpInvocation` metadata, start time, optional duration, optional result, and animation preference. While active, it renders a spinner-like bullet and `Calling`; once completed, it switches to green or red bullets and `Called`. Invocation text is produced by `format_mcp_invocation`, and if it does not fit inline, it wraps under a tree prefix. Result details are rendered block-by-block: text content is truncated and wrapped, images/audio become placeholder strings, resources become URI summaries, and errors are prefixed with `Error:`. `complete` also probes the result for the first decodable image block via `try_new_completed_mcp_tool_call_with_image_output` and `decode_mcp_image`, returning an extra `HistoryCell` that simply signals `tool result (image output)`. The file also renders MCP inventory. `empty_mcp_output` shows a `/mcp` header plus docs link when nothing is configured. Test-only `new_mcp_tools_output` formats local config-derived server details including transport, auth, tools, resources, and templates; production `new_mcp_tools_output_from_statuses` mirrors that layout from app-server `McpServerStatus` responses, optionally omitting resource detail. Finally, `McpInventoryLoadingCell` is a transient spinner row shown while inventory RPCs are in flight.

#### Function details

##### `CompletedMcpToolCallWithImageOutput::display_lines`  (lines 10–12)

```
fn display_lines(&self, _width: u16) -> Vec<Line<'static>>
```

**Purpose**: Renders the visible placeholder line for an MCP tool result that included decodable image output. It does not attempt inline image rendering.

**Data flow**: Ignores width and returns a one-element `Vec<Line<'static>>` containing `tool result (image output)`.

**Call relations**: This method is used when `McpToolCallCell::complete` detects image output and returns an additional boxed history cell.

*Call graph*: 1 external calls (vec!).


##### `CompletedMcpToolCallWithImageOutput::raw_lines`  (lines 14–16)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns the plain-text raw representation of the image-output placeholder cell. It matches the visible wording exactly.

**Data flow**: Returns a one-element vector containing `Line::from("tool result (image output)")`.

**Call relations**: This raw-output method complements the visible placeholder cell returned from image-bearing MCP tool completions.

*Call graph*: 1 external calls (vec!).


##### `mcp_auth_status_label`  (lines 18–25)

```
fn mcp_auth_status_label(status: McpAuthStatus) -> &'static str
```

**Purpose**: Maps `McpAuthStatus` values to the exact labels shown in MCP inventory output. The labels are title-cased and user-facing.

**Data flow**: Consumes an `McpAuthStatus`, matches each variant, and returns a `'static` string slice such as `Unsupported`, `Not logged in`, `Bearer token`, or `OAuth`.

**Call relations**: This helper is used by both config-based and status-based MCP inventory renderers so auth wording stays consistent.


##### `McpToolCallCell::new`  (lines 44–57)

```
fn new(
        call_id: String,
        invocation: McpInvocation,
        animations_enabled: bool,
    ) -> Self
```

**Purpose**: Constructs a new active MCP tool-call cell with the current start time and no result yet. It initializes the state needed for later completion and animation.

**Data flow**: Consumes `call_id`, `McpInvocation`, and `animations_enabled`, records `Instant::now()` into `start_time`, sets `duration` and `result` to `None`, and returns the new cell.

**Call relations**: This constructor is wrapped by `new_active_mcp_tool_call`, which is the public helper used when an MCP tool call begins.

*Call graph*: called by 1 (new_active_mcp_tool_call); 1 external calls (now).


##### `McpToolCallCell::call_id`  (lines 59–61)

```
fn call_id(&self) -> &str
```

**Purpose**: Returns the stable call identifier associated with this MCP tool invocation. It allows external code to match completion events to the active cell.

**Data flow**: Borrows `self.call_id` and returns it as `&str` without allocation or mutation.

**Call relations**: This accessor is used by higher-level orchestration code that tracks active MCP tool calls by id.


##### `McpToolCallCell::complete`  (lines 63–73)

```
fn complete(
        &mut self,
        duration: Duration,
        result: Result<codex_protocol::mcp::CallToolResult, String>,
    ) -> Option<Box<dyn HistoryCell>>
```

**Purpose**: Marks the tool call as finished, stores its duration and result, and optionally returns an extra history cell if the result contains decodable image output. The main cell itself remains responsible for textual invocation/result rendering.

**Data flow**: Consumes a mutable reference to the cell, a `Duration`, and a `Result<CallToolResult, String>`. It first probes the result with `try_new_completed_mcp_tool_call_with_image_output`, boxing any returned image-output cell, then stores `duration` and `result` into `self` and returns the optional boxed cell.

**Call relations**: This method is called when an MCP tool call completes. It delegates image detection to `try_new_completed_mcp_tool_call_with_image_output` before mutating the cell’s stored result.

*Call graph*: calls 1 internal fn (try_new_completed_mcp_tool_call_with_image_output).


##### `McpToolCallCell::success`  (lines 75–81)

```
fn success(&self) -> Option<bool>
```

**Purpose**: Computes the semantic success state of the tool call from the stored result. It distinguishes active (`None`), successful (`Some(true)`), and failed (`Some(false)`) states.

**Data flow**: Reads `self.result.as_ref()`. For `Ok(result)` it returns `Some(!result.is_error.unwrap_or(false))`; for `Err(_)` it returns `Some(false)`; for no result yet it returns `None`.

**Call relations**: This helper is used by both `display_lines` and `raw_lines` to choose `Calling` vs `Called` wording and success/failure bullet styling.

*Call graph*: called by 2 (display_lines, raw_lines).


##### `McpToolCallCell::mark_failed`  (lines 83–87)

```
fn mark_failed(&mut self)
```

**Purpose**: Marks an in-flight MCP tool call as interrupted failure using the elapsed wall-clock time. It is used when the call ends abnormally without a normal result payload.

**Data flow**: Reads `self.start_time.elapsed()`, stores that duration in `self.duration`, and stores `Some(Err("interrupted".to_string()))` in `self.result`.

**Call relations**: This mutator is used by higher-level MCP orchestration when an active call must be failed locally rather than completed with a server result.

*Call graph*: 1 external calls (elapsed).


##### `McpToolCallCell::render_content_block`  (lines 89–116)

```
fn render_content_block(block: &serde_json::Value, width: usize) -> String
```

**Purpose**: Converts one MCP content block into a short textual summary suitable for transcript display. It understands text, image, audio, embedded resources, and resource links, with a JSON fallback for unparseable blocks.

**Data flow**: Consumes a borrowed JSON `block` and a wrapping width. It attempts `serde_json::from_value::<rmcp::model::Content>(block.clone())`; on failure it stringifies the raw JSON and truncates it with `format_and_truncate_tool_result`. On success it matches `content.raw`: text is truncated and wrapped, image/audio become placeholder strings, embedded resources become `embedded resource: <uri>`, and resource links become `link: <uri>`. It returns the resulting `String`.

**Call relations**: This helper is used by both visible and raw MCP tool-call renderers so content-block interpretation stays consistent across output modes.

*Call graph*: 3 external calls (clone, to_string, format!).


##### `McpToolCallCell::display_lines`  (lines 120–213)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Renders the MCP tool call as visible transcript lines, including animated or static status bullet, invocation text, and wrapped result details. It adapts layout depending on whether the invocation fits inline with the header.

**Data flow**: Reads `self.success()`, `self.start_time`, `self.animations_enabled`, `self.invocation`, and optional `self.result`. It chooses a bullet: green bold for success, red bold for failure, or an activity indicator/static dim bullet while active. It chooses `Calling` or `Called`, formats the invocation with `format_mcp_invocation`, and either appends it inline to the header or wraps it under `  └ `. It then builds `detail_lines` by iterating result content blocks and rendering each through `render_content_block`, wrapping each segment under a four-column tree budget; errors are rendered as truncated `Error: ...` text. If detail lines exist, it prefixes them with either `  └ ` or `    ` depending on whether the invocation was inline. It returns the assembled `Vec<Line<'static>>`.

**Call relations**: This is the main visible renderer for MCP tool calls. It depends on `success`, `format_mcp_invocation`, and `render_content_block`, and it is the source of truth for active/completed MCP call presentation.

*Call graph*: calls 4 internal fn (success, format_mcp_invocation, from_animations_enabled, new); 6 external calls (from, render_content_block, new, format!, clone, vec!).


##### `McpToolCallCell::raw_lines`  (lines 215–239)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces a plain-text representation of the MCP tool call and its result details. It preserves semantic content without viewport-specific prefixes or wrapping artifacts.

**Data flow**: Reads `self.success()` to choose `Calling` or `Called`, formats a header line with `format_mcp_invocation(self.invocation.clone())`, then if `self.result` exists iterates content blocks and converts each through `render_content_block` at `RAW_TOOL_OUTPUT_WIDTH`, appending `raw_lines_from_source(&text)` for successful content or `Error: <err>` for failures. It returns the resulting vector.

**Call relations**: This raw-output method parallels `display_lines` but uses plain source-oriented line splitting instead of tree-prefixed wrapping.

*Call graph*: calls 1 internal fn (success); 4 external calls (from, render_content_block, format!, vec!).


##### `McpToolCallCell::transcript_animation_tick`  (lines 241–246)

```
fn transcript_animation_tick(&self) -> Option<u64>
```

**Purpose**: Returns a fast animation tick for active MCP tool calls when animations are enabled. Completed calls and reduced-motion mode produce no animation tick.

**Data flow**: Reads `self.animations_enabled` and `self.result`. If animations are disabled or a result is already present, it returns `None`; otherwise it computes `self.start_time.elapsed().as_millis() / 50` and returns that as `Some(u64)`.

**Call relations**: This method is used by transcript rendering infrastructure to know when an active MCP call’s spinner-like indicator should refresh.

*Call graph*: 1 external calls (elapsed).


##### `new_active_mcp_tool_call`  (lines 249–255)

```
fn new_active_mcp_tool_call(
    call_id: String,
    invocation: McpInvocation,
    animations_enabled: bool,
) -> McpToolCallCell
```

**Purpose**: Public convenience constructor for an active MCP tool-call cell. It hides the concrete type’s constructor behind a module-level helper.

**Data flow**: Consumes `call_id`, `McpInvocation`, and `animations_enabled`, forwards them to `McpToolCallCell::new`, and returns the resulting cell.

**Call relations**: This helper is the normal entrypoint used by higher-level code when an MCP tool call starts.

*Call graph*: calls 1 internal fn (new).


##### `try_new_completed_mcp_tool_call_with_image_output`  (lines 268–279)

```
fn try_new_completed_mcp_tool_call_with_image_output(
    result: &Result<codex_protocol::mcp::CallToolResult, String>,
) -> Option<CompletedMcpToolCallWithImageOutput>
```

**Purpose**: Scans a completed MCP tool result for the first decodable image block and, if found, creates the lightweight image-output placeholder cell. It intentionally returns at most one extra cell.

**Data flow**: Reads a borrowed `Result<CallToolResult, String>`, returns `None` immediately for errors, otherwise iterates `content` and applies `decode_mcp_image` with `find_map`. If an image decodes successfully, it wraps it in `CompletedMcpToolCallWithImageOutput { _image: image }` and returns `Some`; otherwise returns `None`.

**Call relations**: This helper is called only by `McpToolCallCell::complete` before the result is stored, allowing the completion path to emit an additional transcript artifact for image output.

*Call graph*: called by 1 (complete).


##### `decode_mcp_image`  (lines 285–317)

```
fn decode_mcp_image(block: &serde_json::Value) -> Option<DynamicImage>
```

**Purpose**: Attempts to decode one MCP content block into an in-memory image. It accepts both raw base64 and `data:` URLs and rejects non-image blocks or invalid bytes.

**Data flow**: Consumes a borrowed JSON block, parses it into `rmcp::model::Content`, pattern-matches `RawContent::Image`, extracts the base64 payload from either a `data:` URL or plain string, decodes it with base64, wraps the bytes in an `ImageReader` with guessed format, and finally decodes to `DynamicImage`. Any parse, base64, format-guess, or decode failure logs an error and returns `None`; success returns `Some(DynamicImage)`.

**Call relations**: This helper is used by `try_new_completed_mcp_tool_call_with_image_output` while scanning result content for image-bearing blocks.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, clone).


##### `empty_mcp_output`  (lines 319–339)

```
fn empty_mcp_output() -> PlainHistoryCell
```

**Purpose**: Builds the `/mcp` output shown when no MCP servers are configured. It includes a docs hyperlink to guide setup.

**Data flow**: Constructs a fixed `Vec<Line<'static>>` containing a magenta `/mcp` command line, `MCP Tools` heading, italic `No MCP servers configured.` message, and a dimmed line with an OSC-8 hyperlink to the MCP docs. It returns `PlainHistoryCell::new(lines)`.

**Call relations**: This helper is used when the MCP inventory is empty at the configuration level, before any server-specific listing can be rendered.

*Call graph*: calls 1 internal fn (new); 1 external calls (vec!).


##### `new_mcp_tools_output`  (lines 343–513)

```
fn new_mcp_tools_output(
    config: &Config,
    tools: HashMap<String, codex_protocol::mcp::Tool>,
    resources: HashMap<String, Vec<Resource>>,
    resource_templates: HashMap<String, Vec<Resource
```

**Purpose**: Builds a detailed `/mcp` inventory cell from in-process config and tool/resource maps. It is test-only and mirrors the production layout while including transport-specific configuration details.

**Data flow**: Consumes `Config`, maps of tools/resources/resource templates, and auth statuses. It starts with `/mcp` header lines, emits a no-tools message if appropriate, clones and sorts configured servers, then for each server computes the qualified tool-name prefix, extracts and sorts tool names, resolves auth status, and renders server rows. Disabled servers show `(disabled)` and optional reason; enabled servers show status, auth, transport details (`Command`, `Cwd`, `Env` for stdio or `URL`, masked `HTTP headers`, and `Env HTTP headers` for streamable HTTP), plus tools, resources, and resource templates. It returns a `PlainHistoryCell` containing all assembled lines.

**Call relations**: This function is used in tests to validate MCP inventory formatting against local config structures rather than app-server status responses.

*Call graph*: 4 external calls (from, new, format!, vec!).


##### `new_mcp_tools_output_from_statuses`  (lines 524–616)

```
fn new_mcp_tools_output_from_statuses(
    statuses: &[McpServerStatus],
    detail: McpServerStatusDetail,
) -> PlainHistoryCell
```

**Purpose**: Builds the production `/mcp` inventory cell from app-server `McpServerStatus` responses. It sorts servers alphabetically and optionally includes resources and resource templates depending on the requested detail level.

**Data flow**: Consumes a slice of `McpServerStatus` and a `McpServerStatusDetail` flag. It initializes `/mcp` header lines, sorts statuses by `name`, emits a no-tools message if none of the statuses expose tools, then for each status renders the server name, converts app-server auth status into local `McpAuthStatus` for labeling, sorts and renders tool names, and when `detail` is `Full` also renders resources and resource templates with titles/names plus dimmed URIs. It returns a `PlainHistoryCell` containing the assembled lines.

**Call relations**: This is the production inventory renderer used after the app-server returns MCP status pages. It mirrors the test-only config-based renderer but intentionally trusts server-owned state instead of enriching from local config.

*Call graph*: 6 external calls (from, iter, sort_by, format!, matches!, vec!).


##### `McpInventoryLoadingCell::new`  (lines 631–636)

```
fn new(animations_enabled: bool) -> Self
```

**Purpose**: Constructs the transient loading cell shown while MCP inventory is being fetched. It records the start time for spinner animation.

**Data flow**: Consumes `animations_enabled`, stores `Instant::now()` in `start_time`, stores the flag, and returns the new cell.

**Call relations**: This constructor is wrapped by `new_mcp_inventory_loading`, which is the public helper used when an inventory RPC starts.

*Call graph*: called by 1 (new_mcp_inventory_loading); 1 external calls (now).


##### `McpInventoryLoadingCell::display_lines`  (lines 640–655)

```
fn display_lines(&self, _width: u16) -> Vec<Line<'static>>
```

**Purpose**: Renders the visible loading row for in-flight MCP inventory fetches. It shows an animated or static bullet followed by `Loading MCP inventory…`.

**Data flow**: Reads `self.start_time` and `self.animations_enabled`, obtains an activity indicator using motion helpers with `ReducedMotionIndicator::StaticBullet`, falls back to a dim bullet if needed, and returns a one-line vector containing the indicator, a space, bold `Loading MCP inventory`, and a dim ellipsis.

**Call relations**: This visible renderer is used while the loading cell occupies the active-cell slot during MCP inventory fetches.

*Call graph*: 1 external calls (vec!).


##### `McpInventoryLoadingCell::raw_lines`  (lines 657–659)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns the plain-text raw representation of the MCP inventory loading row. It omits animation and styling.

**Data flow**: Returns a one-element vector containing `Line::from("Loading MCP inventory...")`.

**Call relations**: This raw-output method complements the visible loading row for transcript/export contexts.

*Call graph*: 1 external calls (vec!).


##### `McpInventoryLoadingCell::transcript_animation_tick`  (lines 661–666)

```
fn transcript_animation_tick(&self) -> Option<u64>
```

**Purpose**: Returns an animation tick for the loading spinner when animations are enabled. Reduced-motion mode disables transcript animation.

**Data flow**: Reads `self.animations_enabled`; if false returns `None`, otherwise computes `self.start_time.elapsed().as_millis() / 50` and returns it as `Some(u64)`.

**Call relations**: This method lets transcript rendering know when the loading row’s spinner should refresh.

*Call graph*: 1 external calls (elapsed).


##### `new_mcp_inventory_loading`  (lines 670–672)

```
fn new_mcp_inventory_loading(animations_enabled: bool) -> McpInventoryLoadingCell
```

**Purpose**: Public convenience constructor for the MCP inventory loading cell. It hides the concrete type behind a module-level helper.

**Data flow**: Consumes `animations_enabled`, forwards it to `McpInventoryLoadingCell::new`, and returns the resulting cell.

**Call relations**: This helper is used by higher-level code when inserting the transient MCP inventory loading row.

*Call graph*: calls 1 internal fn (new).


##### `format_mcp_invocation`  (lines 673–692)

```
fn format_mcp_invocation(invocation: McpInvocation) -> Line<'a>
```

**Purpose**: Formats an MCP invocation as `server.tool(args)` with cyan server/tool names and dimmed compact JSON arguments. It is the shared invocation formatter for MCP tool-call rendering.

**Data flow**: Consumes an owned `McpInvocation`, serializes `arguments` to compact JSON with `serde_json::to_string` falling back to `Value::to_string`, defaults to an empty argument string when absent, builds a span vector `[server, '.', tool, '(', args, ')']` with styling, and returns it as a `Line`.

**Call relations**: This helper is used by `McpToolCallCell::display_lines` and `raw_lines` so invocation formatting stays consistent across visible and raw output.

*Call graph*: called by 1 (display_lines); 1 external calls (vec!).


### `tui/src/history_cell/notices.rs`

`domain_logic` · `event handling and transcript rendering whenever the UI needs to show warnings, notices, or update prompts`

This file groups several small notice-oriented cell types whose job is to inject non-conversational status messages into transcript history. `UpdateAvailableHistoryCell` renders a bordered card announcing a newer CLI version, showing either a concrete update command from `UpdateAction` or a fallback installation URL, plus a release-notes link. Its rich rendering computes an inner width from the content width and available terminal width, wraps with `adaptive_wrap_lines`, and then delegates border drawing to the shared session-card helpers. It also overrides hyperlink rendering so URLs become clickable in terminals that support hyperlinks.

`CyberPolicyNoticeCell` is a fixed informational warning shown when a chat is flagged for possible cybersecurity risk. It builds a cyan/bold heading, wraps a dim explanatory paragraph with indentation preserved, and appends the Trusted Access for Cyber URL as a separate line. `DeprecationNoticeCell` renders a red warning summary and optional dim details, wrapping details in rich mode and preserving original line breaks in raw mode via `raw_lines_from_source`. The remaining constructors (`new_warning_event`, `new_info_event`, `new_error_event`) produce lightweight prefixed/plain cells for generic notices. Across the file, rich mode emphasizes styling and wrapping, while raw mode intentionally emits plain, copyable text with no borders or color semantics.

#### Function details

##### `UpdateAvailableHistoryCell::new`  (lines 14–19)

```
fn new(latest_version: String, update_action: Option<UpdateAction>) -> Self
```

**Purpose**: Constructs an update-notice cell with the discovered latest version and an optional platform-specific update action.

**Data flow**: It takes `latest_version: String` and `update_action: Option<UpdateAction>`, stores them directly in a new `UpdateAvailableHistoryCell`, and returns the struct.

**Call relations**: Startup or update-check flows create this cell when a newer CLI version is detected; snapshot tests also instantiate it directly to verify rendering.

*Call graph*: called by 3 (run, standalone_unix_update_available_history_cell_snapshot, standalone_windows_update_available_history_cell_snapshot).


##### `UpdateAvailableHistoryCell::display_lines`  (lines 23–57)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the bordered rich-text update card shown in the main history viewport.

**Data flow**: It reads `self.latest_version`, `self.update_action`, and the current `width`; chooses either a `Run <command> to update.` line or an installation-options URL line; assembles a multi-line `Text` containing the version transition and release-notes URL; computes `inner_width` as the smaller of content width and `width - 4`, clamped to at least 1; wraps the content with `adaptive_wrap_lines`; and returns bordered lines via `with_border_with_inner_width`.

**Call relations**: Its output feeds `display_hyperlink_lines`, which adds URL annotations before the card is rendered in rich mode.

*Call graph*: calls 1 internal fn (new); called by 1 (display_hyperlink_lines); 3 external calls (line!, text!, from).


##### `UpdateAvailableHistoryCell::raw_lines`  (lines 59–73)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces a plain-text, copy-friendly version of the update notice without borders or styling.

**Data flow**: It reads the same version and optional update action, formats either the update command instruction or fallback installation URL, and returns a fixed vector of six `Line` values: title, version transition, instruction, blank line, release-notes label, and release-notes URL.

**Call relations**: This is used when the transcript is shown in raw mode or copied/exported without rich formatting.

*Call graph*: 2 external calls (format!, vec!).


##### `UpdateAvailableHistoryCell::display_hyperlink_lines`  (lines 75–77)

```
fn display_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Annotates the rich update card so embedded web URLs become terminal hyperlinks.

**Data flow**: It calls `self.display_lines(width)` to get the bordered rich lines, passes them to `annotate_web_urls`, and returns hyperlink-aware lines.

**Call relations**: Rich rendering and transcript rendering use this override instead of the trait default so the GitHub URLs remain clickable.

*Call graph*: calls 2 internal fn (display_lines, annotate_web_urls); called by 1 (transcript_hyperlink_lines).


##### `UpdateAvailableHistoryCell::transcript_hyperlink_lines`  (lines 79–81)

```
fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Keeps the transcript-overlay representation identical to the rich viewport representation for update notices.

**Data flow**: It forwards `width` to `self.display_hyperlink_lines(width)` and returns the result unchanged.

**Call relations**: The transcript overlay uses this so the same bordered, hyperlink-annotated card appears there as in the main viewport.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `new_warning_event`  (lines 84–86)

```
fn new_warning_event(message: String) -> PrefixedWrappedHistoryCell
```

**Purpose**: Creates a generic yellow warning cell with a warning-sign prefix and wrapped body text.

**Data flow**: It takes a warning `message: String`, styles both the message and the `⚠ ` prefix yellow, uses `"  "` as the continuation indent, and returns a `PrefixedWrappedHistoryCell`.

**Call relations**: Callers use this helper for ad hoc warning notices without defining a dedicated cell type.

*Call graph*: calls 1 internal fn (new).


##### `new_cyber_policy_error_event`  (lines 93–95)

```
fn new_cyber_policy_error_event() -> CyberPolicyNoticeCell
```

**Purpose**: Constructs the fixed cybersecurity-policy notice cell.

**Data flow**: It takes no arguments and returns the zero-sized `CyberPolicyNoticeCell` value.

**Call relations**: Policy enforcement paths call this when a conversation is flagged and the UI needs to explain the restriction.


##### `CyberPolicyNoticeCell::display_lines`  (lines 98–129)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Renders the styled cybersecurity-risk notice with wrapped explanatory text and a visible enrollment URL.

**Data flow**: It starts a `Vec<Line>` with a cyan info marker and bold heading, computes `wrap_width` as `width - 2` clamped to at least 1, builds a dim explanatory `Line` containing an underlined cyan link label, wraps that line with a two-space subsequent indent using `adaptive_wrap_line`, appends the wrapped lines with `push_owned_lines`, then adds a final line containing the trusted-access URL in cyan/underlined style.

**Call relations**: Its rich output is later passed through `display_hyperlink_lines` so the visible URL becomes clickable.

*Call graph*: calls 1 internal fn (new); called by 1 (display_hyperlink_lines); 3 external calls (from, new, vec!).


##### `CyberPolicyNoticeCell::raw_lines`  (lines 131–139)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns a plain-text version of the cybersecurity notice suitable for raw transcript mode.

**Data flow**: It emits three lines: the heading sentence, the explanatory paragraph as one plain string, and the trusted-access URL constant.

**Call relations**: Raw transcript and copy/export paths use this instead of the styled wrapped representation.

*Call graph*: 1 external calls (vec!).


##### `CyberPolicyNoticeCell::display_hyperlink_lines`  (lines 141–143)

```
fn display_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Adds terminal hyperlink metadata to the cybersecurity notice’s rich lines.

**Data flow**: It renders the notice with `display_lines(width)`, passes the lines to `annotate_web_urls`, and returns `Vec<HyperlinkLine>`.

**Call relations**: This override ensures the trusted-access URL is hyperlink-annotated in both the main viewport and transcript overlay.

*Call graph*: calls 2 internal fn (display_lines, annotate_web_urls); called by 1 (transcript_hyperlink_lines).


##### `CyberPolicyNoticeCell::transcript_hyperlink_lines`  (lines 145–147)

```
fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Uses the same hyperlink-annotated rendering for transcript overlay as for the main viewport.

**Data flow**: It simply returns `self.display_hyperlink_lines(width)`.

**Call relations**: Transcript rendering delegates here so no alternate transcript-specific formatting is introduced.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `new_deprecation_notice`  (lines 156–161)

```
fn new_deprecation_notice(
    summary: String,
    details: Option<String>,
) -> DeprecationNoticeCell
```

**Purpose**: Constructs a deprecation notice cell from a required summary and optional detail text.

**Data flow**: It takes `summary: String` and `details: Option<String>`, stores them in `DeprecationNoticeCell`, and returns the new struct.

**Call relations**: Feature or protocol deprecation paths use this helper to create a dedicated warning cell.


##### `DeprecationNoticeCell::display_lines`  (lines 164–177)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Renders a red deprecation warning with optional wrapped detail text beneath it.

**Data flow**: It initializes a line vector with a bold red `⚠ ` prefix plus the red summary, computes `wrap_width` as `width - 4` clamped to at least 1, and if `details` is present wraps a dim detail line with `adaptive_wrap_line` and appends the wrapped output via `push_owned_lines`.

**Call relations**: This rich representation is used in the main viewport; unlike update and cyber notices, it does not override hyperlink handling.

*Call graph*: calls 1 internal fn (new); 3 external calls (from, new, vec!).


##### `DeprecationNoticeCell::raw_lines`  (lines 179–185)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces plain-text deprecation output while preserving explicit line breaks in the optional details.

**Data flow**: It starts with a single line containing `self.summary`; if `details` exists, it extends the vector with `raw_lines_from_source(details)`, which splits the detail string on source newlines without styling.

**Call relations**: Raw mode uses this to keep multiline deprecation details faithful to their original text.

*Call graph*: 1 external calls (vec!).


##### `new_info_event`  (lines 187–195)

```
fn new_info_event(message: String, hint: Option<String>) -> PlainHistoryCell
```

**Purpose**: Creates a simple bullet-style informational cell with an optional dim hint appended on the same line.

**Data flow**: It builds a span vector beginning with a dim `• ` prefix and the main `message`, conditionally appends a space and dark-gray `hint`, wraps the spans into one `Line`, and returns a `PlainHistoryCell` containing that single line.

**Call relations**: General informational events use this lightweight helper instead of a dedicated struct.

*Call graph*: 1 external calls (vec!).


##### `new_error_event`  (lines 197–203)

```
fn new_error_event(message: String) -> PlainHistoryCell
```

**Purpose**: Creates a compact red error cell prefixed with a square marker.

**Data flow**: It formats `■ {message}` as a single red span, wraps it into one `Line`, and returns a `PlainHistoryCell` containing that line.

**Call relations**: Error-reporting paths use this helper for terse transcript-visible failures that do not need richer structure.

*Call graph*: 1 external calls (vec!).


### `tui/src/history_cell/patches.rs`

`domain_logic` · `tool-result rendering after patch proposals, patch failures, image viewing, or image generation events`

This file covers transcript cells for patch and image operations. `PatchHistoryCell` is the source-backed representation of a proposed patch summary: it stores a `HashMap<PathBuf, FileChange>` plus the working directory used to format paths. In rich mode it delegates directly to `create_diff_summary`, passing the current terminal width so the summary can be width-aware. In raw mode it renders the same summary at a very large fixed width (`RAW_DIFF_SUMMARY_WIDTH`) and then strips styling with `plain_lines`, ensuring raw scrollback contains unwrapped, copyable file summary lines rather than viewport-dependent wrapping.

The constructor `new_patch_event` snapshots the current cwd into the cell so later re-renders remain stable even if process state changes. `new_patch_apply_failure` builds a plain failure cell headed by a bold magenta title and, when stderr is non-empty after trimming, formats stderr through the shared command-output pipeline (`output_lines`) with tool-call limits and stderr-only settings. The image helpers are intentionally lightweight transcript summaries: `new_view_image_tool_call` shows a bullet plus a cwd-relative display path for a viewed image, while `new_image_generation_call` shows either success or failure, prefers a revised prompt over the call id as the detail line, and emits a `file://` URL when a saved path can be converted to one. These helpers keep patch/image tool activity visible in history without embedding full binary or diff payloads.

#### Function details

##### `PatchHistoryCell::display_lines`  (lines 12–14)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Renders the rich file-level diff summary for a patch using the current viewport width.

**Data flow**: It reads `self.changes`, `self.cwd`, and `width`, passes them to `create_diff_summary`, and returns the resulting styled `Vec<Line<'static>>`.

**Call relations**: Main history rendering calls this when a patch summary cell is displayed in rich mode.


##### `PatchHistoryCell::raw_lines`  (lines 16–22)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces a plain-text patch summary that is independent of the current terminal width.

**Data flow**: It calls `create_diff_summary` with `RAW_DIFF_SUMMARY_WIDTH` so lines are effectively unwrapped, then converts the styled output to plain text with `plain_lines` and returns it.

**Call relations**: Raw transcript mode uses this to avoid width-sensitive wrapping artifacts in copied patch summaries.


##### `new_patch_event`  (lines 27–35)

```
fn new_patch_event(
    changes: HashMap<PathBuf, FileChange>,
    cwd: &Path,
) -> PatchHistoryCell
```

**Purpose**: Constructs a patch-summary cell from a set of file changes and the current working directory.

**Data flow**: It takes ownership of `changes: HashMap<PathBuf, FileChange>`, clones `cwd` into an owned `PathBuf` with `to_path_buf`, and returns a `PatchHistoryCell` containing both.

**Call relations**: Patch-generation flows call this when they want to append a summarized proposed patch to history.

*Call graph*: 1 external calls (to_path_buf).


##### `new_patch_apply_failure`  (lines 37–61)

```
fn new_patch_apply_failure(stderr: String) -> PlainHistoryCell
```

**Purpose**: Builds a plain history cell describing a failed patch application and optionally includes formatted stderr output.

**Data flow**: It starts a mutable line vector with a bold magenta title. If `stderr.trim()` is non-empty, it wraps `stderr` into a synthetic `CommandOutput` with exit code 1 and passes it to `output_lines` using `OutputLinesParams` configured for stderr-only output, angle-pipe markers, prefixes, and `TOOL_CALL_MAX_LINES`; it then extends the line vector with the formatted output lines and returns `PlainHistoryCell { lines }`.

**Call relations**: Patch-application error paths use this helper so failures are rendered consistently with other command-output transcript entries.

*Call graph*: 3 external calls (from, new, new).


##### `new_view_image_tool_call`  (lines 63–72)

```
fn new_view_image_tool_call(path: AbsolutePathBuf, cwd: &Path) -> PlainHistoryCell
```

**Purpose**: Creates a concise transcript entry indicating that an image file was viewed.

**Data flow**: It takes an absolute image `path` and `cwd`, computes a display-friendly path with `display_path_for(path.as_path(), cwd)`, builds two lines (`Viewed Image` and an indented path line), and returns them in a `PlainHistoryCell`.

**Call relations**: Image-view tool calls use this helper to leave a readable breadcrumb in history without rendering image contents.

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

**Purpose**: Creates a transcript summary for an image-generation tool call, including failure/success heading, prompt-or-call detail, and optional saved-file location.

**Data flow**: It takes `call_id`, `status`, optional `revised_prompt`, and optional `saved_path`. It chooses `detail` as `revised_prompt.unwrap_or(call_id)`, selects a red failure heading when `status == "failed"` or a neutral success heading otherwise, initializes lines with the heading and detail, and if `saved_path` exists converts it to a `file://` URL with `Url::from_file_path` falling back to `display()` text on failure before appending a `Saved to:` line. It returns a `PlainHistoryCell`.

**Call relations**: Image-generation result handling uses this helper to summarize the call in transcript history after the tool completes.

*Call graph*: 2 external calls (from_file_path, vec!).


### `tui/src/history_cell/request_user_input.rs`

`domain_logic` · `after a request-user-input tool interaction completes or is interrupted, during transcript/history rendering`

This file turns a finished request-user-input interaction into a readable history cell. `RequestUserInputResultCell` stores the original ordered `questions`, a map of `answers` keyed by question id, and an `interrupted` flag. Its rich rendering first computes answered vs total counts by checking whether each question id maps to a non-empty answer list. It then emits a header like `Questions 2/3 answered`, optionally appending `(interrupted)` in cyan. For each question, it wraps the question text with a bullet prefix, marks the last wrapped line with a dim `(unanswered)` suffix when no answer exists, and then renders answers. Secret questions never reveal content; they show a cyan `••••••` placeholder. Non-secret answers are split by `split_request_user_input_answer` into selected options and an optional freeform note encoded as a `user_note: ...` entry. Options are rendered as repeated `answer:` lines, while notes use either `note:` or `answer:` labels depending on whether the question had predefined options.

The helper `wrap_with_prefix` centralizes adaptive wrapping with styled content and distinct initial/subsequent prefixes, so all question and answer blocks align consistently. Raw mode mirrors the same semantics in plain text: unanswered markers, masked secret answers, and explicit `answer:` / `note:` lines. If an interrupted exchange still has unanswered questions, rich mode appends a cyan dim summary line indicating how many remained unanswered.

#### Function details

##### `RequestUserInputResultCell::display_lines`  (lines 14–109)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the rich transcript view of a completed or interrupted question/answer exchange with wrapping, masking, and interruption summaries.

**Data flow**: It reads `self.questions`, `self.answers`, `self.interrupted`, and `width`; computes `total`, `answered`, and `unanswered`; builds a header line with counts and optional interrupted marker; then for each question looks up its answer by `question.id`, wraps the question text with `wrap_with_prefix`, appends a dim `(unanswered)` suffix to the last wrapped question line when no answer exists, and either skips answer rendering, emits a masked cyan `••••••` answer for secret questions, or splits the answer into `options` and `note` via `split_request_user_input_answer` and wraps each with appropriate prefixes and cyan styling. If interrupted with remaining unanswered questions, it appends a cyan dim summary line. It returns the accumulated `Vec<Line<'static>>`.

**Call relations**: This is the main rich renderer for completed request-user-input history entries; it delegates all line wrapping to `wrap_with_prefix` and answer parsing to `split_request_user_input_answer`.

*Call graph*: calls 2 internal fn (split_request_user_input_answer, wrap_with_prefix); 3 external calls (default, format!, vec!).


##### `RequestUserInputResultCell::raw_lines`  (lines 111–151)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces a plain-text version of the question/answer exchange while preserving masking and unanswered semantics.

**Data flow**: It recomputes `total` and `answered`, starts with a `Questions X/Y answered` line and optional `(interrupted)` line, then for each question appends the plain question text followed by either `answer: ******` for secret answered questions, one `answer: <option>` line per parsed option plus optional `note: <note>` for non-secret answers, or `(unanswered)` when no non-empty answer exists. It returns the resulting vector.

**Call relations**: Raw transcript mode uses this textual representation; it shares answer parsing logic with the rich renderer through `split_request_user_input_answer`.

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

**Purpose**: Wraps a plain string into one or more styled ratatui lines with distinct initial and continuation prefixes.

**Data flow**: It takes `text`, `width`, `initial_prefix`, `subsequent_prefix`, and `style`; creates a one-span `Line` from `text` with the given style; builds `RtOptions` with `width.max(1)` and the provided prefixes converted into `Line`s; wraps the line with `adaptive_wrap_line`; copies the wrapped borrowed lines into an owned output vector with `push_owned_lines`; and returns that vector.

**Call relations**: The rich request-user-input renderer calls this for every question, answer, note, and interruption-summary block so indentation and wrapping stay consistent.

*Call graph*: calls 1 internal fn (new); called by 1 (display_lines); 3 external calls (from, new, vec!).


##### `split_request_user_input_answer`  (lines 174–187)

```
fn split_request_user_input_answer(
    answer: &ToolRequestUserInputAnswer,
) -> (Vec<String>, Option<String>)
```

**Purpose**: Separates a tool answer payload into selected option strings and an optional freeform note encoded in-band.

**Data flow**: It iterates over `answer.answers`; entries beginning with `"user_note: "` are stripped and stored as `note`, while all other entries are cloned into the `options` vector. It returns `(options, note)`.

**Call relations**: Both rich and raw renderers call this helper so they interpret the protocol’s mixed answer list the same way.

*Call graph*: called by 2 (display_lines, raw_lines); 1 external calls (new).


### `tui/src/history_cell/search.rs`

`domain_logic` · `during active web-search tool calls and later when completed search activity is shown in transcript history`

This file models web-search activity as a mutable `WebSearchCell` plus a few formatting helpers. The helper trio normalizes user-facing text: `web_search_header` chooses between present-tense and past-tense headings based on completion state; `web_search_action_detail` extracts a concise detail string from each `WebSearchAction` variant, including fallback logic for multi-query searches and formatted `FindInPage` combinations; and `web_search_detail` falls back to the original query when the action-specific detail is empty.

`WebSearchCell` stores a stable `call_id`, current `query`, optional latest `action`, `start_time`, completion flag, and whether animations are enabled. This lets active cells update in place as the tool reports more specific actions and later flip to completed state. Rich rendering chooses a dim bullet for completed searches or an animated activity indicator for active ones, using `MotionMode::from_animations_enabled` and `ReducedMotionIndicator::StaticBullet` as fallback behavior. It then builds either a bare bold header or a header-plus-detail line, using `for` as the separator only after completion, and delegates wrapping/indentation to `PrefixedWrappedHistoryCell`. Raw mode emits the same semantics as a single plain line. The two constructor helpers distinguish active searches, which start incomplete and animation-capable, from completed historical searches, which are created with an action and immediately marked complete.

#### Function details

##### `web_search_header`  (lines 5–11)

```
fn web_search_header(completed: bool) -> &'static str
```

**Purpose**: Returns the user-facing heading text for a web-search cell based on whether the search has completed.

**Data flow**: It reads `completed: bool` and returns either `"Searched the web"` or `"Searching the web"`.

**Call relations**: Both rich and raw renderers call this helper so tense stays consistent across display modes.

*Call graph*: called by 2 (display_lines, raw_lines).


##### `web_search_action_detail`  (lines 13–38)

```
fn web_search_action_detail(action: &WebSearchAction) -> String
```

**Purpose**: Extracts a concise descriptive detail string from a specific `WebSearchAction` variant.

**Data flow**: For `Search`, it prefers the explicit `query` when non-empty, otherwise inspects `queries`, chooses the first query, and appends ` ...` when multiple queries exist and the first is non-empty. For `OpenPage`, it returns the URL or empty string. For `FindInPage`, it formats combinations of `pattern` and `url` into strings like `'pattern' in url`, `'pattern'`, or just the URL. For `Other`, it returns an empty string.

**Call relations**: This helper feeds `web_search_detail`, which decides whether to use action-derived detail or fall back to the original query.

*Call graph*: 2 external calls (new, format!).


##### `web_search_detail`  (lines 40–47)

```
fn web_search_detail(action: Option<&WebSearchAction>, query: &str) -> String
```

**Purpose**: Chooses the best detail text to show for a web-search cell, preferring action-specific detail but falling back to the original query.

**Data flow**: It maps `action: Option<&WebSearchAction>` through `web_search_action_detail`, defaults to an empty string when absent, and returns either that detail or `query.to_string()` if the detail is empty.

**Call relations**: Both `display_lines` and `raw_lines` use this helper so active and completed cells present the same detail-selection logic.

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

**Purpose**: Constructs a mutable web-search cell with initial query/action state and a fresh start timestamp.

**Data flow**: It takes `call_id`, `query`, optional `action`, and `animations_enabled`, stores them, sets `start_time` to `Instant::now()`, initializes `completed` to `false`, and returns the struct.

**Call relations**: Both active and completed constructor helpers delegate here; completed historical cells then call `complete` immediately.

*Call graph*: called by 2 (new_active_web_search_call, new_web_search_call); 1 external calls (now).


##### `WebSearchCell::call_id`  (lines 76–78)

```
fn call_id(&self) -> &str
```

**Purpose**: Returns the stable tool call identifier associated with this web-search cell.

**Data flow**: It reads `self.call_id` and returns it as `&str`.

**Call relations**: Controller code can use this accessor to match incoming search updates to the correct active cell.


##### `WebSearchCell::update`  (lines 80–83)

```
fn update(&mut self, action: WebSearchAction, query: String)
```

**Purpose**: Mutates an active web-search cell with a newer action and query string as the tool progresses.

**Data flow**: It takes a new `action` and `query`, stores `Some(action)` into `self.action`, replaces `self.query`, and returns `()`. It does not alter completion state or timestamp.

**Call relations**: Streaming/tool-update logic calls this on an in-flight cell when the search transitions from generic searching to a more specific action.


##### `WebSearchCell::complete`  (lines 85–87)

```
fn complete(&mut self)
```

**Purpose**: Marks the web-search cell as finished so rendering switches to completed wording and static bullet styling.

**Data flow**: It sets `self.completed = true` and returns `()`. No other fields change.

**Call relations**: Completion handling calls this when the search finishes; the completed constructor helper also invokes it immediately.


##### `WebSearchCell::display_lines`  (lines 91–111)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Renders the rich web-search transcript line with either an animated activity indicator or a static bullet plus optional detail text.

**Data flow**: It reads completion state, `start_time`, `animations_enabled`, `action`, `query`, and `width`. If completed, it uses a dim bullet; otherwise it asks `activity_indicator` for an animated marker using `MotionMode::from_animations_enabled(self.animations_enabled)` and falls back to a dim bullet. It computes `header` and `detail`, builds either a bold header-only `Text` or a line containing header, separator (`" for "` when completed, otherwise a space), and detail, then constructs a `PrefixedWrappedHistoryCell` with prefix `[bullet, " "]` and continuation indent `"  "`, and returns that cell’s wrapped display lines.

**Call relations**: This is the main rich renderer for search activity; it depends on the helper functions for wording and on the shared prefixed-wrapper cell for layout.

*Call graph*: calls 4 internal fn (new, web_search_detail, web_search_header, from_animations_enabled); 2 external calls (from, vec!).


##### `WebSearchCell::raw_lines`  (lines 113–122)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces a single-line plain-text representation of the search activity with the same wording as rich mode.

**Data flow**: It computes `header` and `detail`; if `detail` is empty it returns one line containing just the header, otherwise it formats `header + separator + detail` where the separator is `" for "` only when completed and a space otherwise.

**Call relations**: Raw transcript mode uses this simplified textual form instead of the animated/styled rich rendering.

*Call graph*: calls 2 internal fn (web_search_detail, web_search_header); 1 external calls (vec!).


##### `new_active_web_search_call`  (lines 125–131)

```
fn new_active_web_search_call(
    call_id: String,
    query: String,
    animations_enabled: bool,
) -> WebSearchCell
```

**Purpose**: Creates an in-flight web-search cell with no specific action yet and configurable animation behavior.

**Data flow**: It takes `call_id`, `query`, and `animations_enabled`, passes them to `WebSearchCell::new` with `action` set to `None`, and returns the new incomplete cell.

**Call relations**: Tool-start handling uses this helper when a web search begins and may later update in place.

*Call graph*: calls 1 internal fn (new).


##### `new_web_search_call`  (lines 133–146)

```
fn new_web_search_call(
    call_id: String,
    query: String,
    action: WebSearchAction,
) -> WebSearchCell
```

**Purpose**: Creates a completed historical web-search cell from a known action and query.

**Data flow**: It constructs a `WebSearchCell` with `Some(action)` and `animations_enabled` forced to `false`, then mutably calls `complete()` before returning the cell.

**Call relations**: Non-streaming or already-finished search events use this helper to append a finalized search entry directly to history.

*Call graph*: calls 1 internal fn (new).


### `tui/src/history_cell/hook_cell.rs`

`domain_logic` · `request handling`

This file is a substantial stateful renderer for hook runs. `HookCell` owns a list of `HookRunCell`s plus an `animations_enabled` flag so viewport and transcript rendering stay consistent. Each run carries stable protocol metadata (`id`, `event_name`, optional `status_message`) and a `HookRunState` state machine: `PendingReveal` hides newly started hooks until `HOOK_RUN_REVEAL_DELAY`, `VisibleRunning` shows active hooks, `QuietLinger` keeps a visible quiet success on screen until `QUIET_HOOK_MIN_VISIBLE`, and `Completed` stores final `HookRunStatus` plus `HookOutputEntry`s. The live API supports starting runs, completing them by matching `id`, replaying already-completed runs, advancing timers, querying whether the cell should render or flush, and splitting persistent completed runs away from ephemeral active bookkeeping. Rendering coalesces adjacent visible-running hooks with the same `event_name` and `status_message` into a single grouped line while preserving independent underlying runs. Completed runs render their own bullet line plus indented output entries, where only the first line gets a kind-specific prefix like `warning:` or `hook context:`. Animation support is centralized in `push_running_hook_header`, which uses motion helpers for spinners and shimmer text, but falls back to bold static text when animations are disabled. The tests focus on subtle policy edges: warning bullets, multiline output formatting, transcript animation gating, and no-spinner behavior under reduced motion.

#### Function details

##### `HookCell::new_active`  (lines 119–126)

```
fn new_active(run: HookRunSummary, animations_enabled: bool) -> Self
```

**Purpose**: Creates a hook cell initialized with one newly started live run. It starts from an empty run list and immediately inserts the run in pending-reveal state.

**Data flow**: Consumes a `HookRunSummary` and `animations_enabled` flag, constructs `HookCell { runs: Vec::new(), animations_enabled }`, calls `start_run(run)` to insert the run with current timing, and returns the populated cell.

**Call relations**: This constructor is used by the public `new_active_hook_cell` wrapper and by tests that need a live hook cell with reveal/animation behavior.

*Call graph*: called by 5 (new_active_hook_cell, pending_hook_does_not_animate_transcript, visible_hook_animates_transcript_when_animations_enabled, visible_hook_does_not_animate_transcript_when_animations_disabled, visible_hook_without_animations_omits_spinner); 1 external calls (new).


##### `HookCell::new_completed`  (lines 129–136)

```
fn new_completed(run: HookRunSummary, animations_enabled: bool) -> Self
```

**Purpose**: Creates a hook cell initialized from an already completed run summary. It is intended for replay or restoration paths where the final outcome is already known.

**Data flow**: Consumes a `HookRunSummary` and animation flag, constructs an empty `HookCell`, calls `add_completed_run(run)`, and returns the result.

**Call relations**: This constructor is exposed through `new_completed_hook_cell` and used in tests that validate completed-hook rendering without simulating live transitions.

*Call graph*: called by 2 (new_completed_hook_cell, completed_hook_cell); 1 external calls (new).


##### `HookCell::is_empty`  (lines 138–140)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether the cell currently contains any hook runs at all. It is a simple structural check used by lifecycle decisions.

**Data flow**: Reads `self.runs.is_empty()` and returns the resulting `bool`. It does not mutate state.

**Call relations**: This helper feeds `should_flush`, which needs to distinguish an inactive-but-populated cell from a truly empty one.

*Call graph*: called by 1 (should_flush).


##### `HookCell::is_active`  (lines 143–145)

```
fn is_active(&self) -> bool
```

**Purpose**: Reports whether any contained run is still active due to pending completion or timer-driven transitions. Active includes hidden pending runs and quiet linger states, not just visibly running hooks.

**Data flow**: Iterates `self.runs` and returns `true` if any `run.state.is_active()` is true; otherwise returns `false`.

**Call relations**: This method is used by `should_flush` and by higher-level active-cell management to know whether the hook cell can still change over time.

*Call graph*: called by 1 (should_flush).


##### `HookCell::should_flush`  (lines 148–150)

```
fn should_flush(&self) -> bool
```

**Purpose**: Indicates when a completed hook cell should be moved out of the active slot. A cell flushes only after all active timers are done but while it still contains runs worth preserving.

**Data flow**: Calls `is_active()` and `is_empty()`, then returns `!is_active && !is_empty`. It reads internal run state but does not modify it.

**Call relations**: This lifecycle predicate is used by callers managing the active hook cell to know when to commit or clear it.

*Call graph*: calls 2 internal fn (is_active, is_empty).


##### `HookCell::should_render`  (lines 153–155)

```
fn should_render(&self) -> bool
```

**Purpose**: Reports whether the cell currently has any visible content. Hidden pending runs do not count, while visible running, lingering, and completed runs do.

**Data flow**: Iterates `self.runs` and returns whether any `run.state.should_render()` is true.

**Call relations**: This predicate lets higher-level code avoid drawing an active hook cell before reveal delay has elapsed.


##### `HookCell::take_completed_persistent_runs`  (lines 161–176)

```
fn take_completed_persistent_runs(&mut self) -> Option<Self>
```

**Purpose**: Splits durable completed runs out of the active cell into a separate `HookCell`. Quiet successes and other non-persistent runs remain behind so they can disappear naturally.

**Data flow**: Drains `self.runs`, partitions runs by `run.state.has_persistent_output()`, stores non-persistent runs back into `self.runs`, and if any persistent runs were found returns `Some(HookCell { runs: completed, animations_enabled: self.animations_enabled })`; otherwise returns `None`.

**Call relations**: This method is used by callers that need to move failures, blocked/stopped hooks, or output-bearing completions into durable transcript history while leaving ephemeral active-cell bookkeeping in place.

*Call graph*: 1 external calls (new).


##### `HookCell::has_visible_running_run`  (lines 179–181)

```
fn has_visible_running_run(&self) -> bool
```

**Purpose**: Reports whether the active hook cell currently occupies viewport space with at least one visible running row. It ignores hidden pending runs and completed-only content.

**Data flow**: Iterates `self.runs` and returns whether any `run.state.is_running_visible()` is true.

**Call relations**: This helper is used by callers that need to know whether the active hook cell is currently taking up visible rows in the viewport.


##### `HookCell::advance_time`  (lines 184–192)

```
fn advance_time(&mut self, now: Instant) -> bool
```

**Purpose**: Advances the hook-run state machine based on the current time, revealing due runs and removing expired quiet lingers. It also reports whether anything changed that would require a redraw.

**Data flow**: Takes `now: Instant`, records the old run count, iterates mutable runs calling `run.state.reveal_if_due(now)` and OR-ing the returned change flags, then retains only runs whose `quiet_linger_expired(now)` is false. It returns `true` if any state changed or if the run count shrank.

**Call relations**: This timer tick is called by higher-level scheduling code whenever hook deadlines may have elapsed. It relies on `HookRunState` transition helpers to keep reveal and linger logic centralized.


##### `HookCell::start_run`  (lines 198–212)

```
fn start_run(&mut self, run: HookRunSummary)
```

**Purpose**: Inserts a newly started hook run or refreshes an existing run with the same protocol id. Duplicate begin events reset the reveal timer instead of creating duplicate rows.

**Data flow**: Consumes a `HookRunSummary`, captures `Instant::now()`, searches `self.runs` for a matching `id`, and if found updates `event_name`, `status_message`, and `state` to `HookRunState::pending(now)`. Otherwise it pushes a new `HookRunCell` with the run metadata and pending state.

**Call relations**: This method is called by `new_active` during construction and by live hook-event handling when begin events arrive. It delegates initial-state creation to `HookRunState::pending`.

*Call graph*: calls 1 internal fn (pending); 1 external calls (now).


##### `HookCell::complete_run`  (lines 218–243)

```
fn complete_run(&mut self, run: HookRunSummary) -> bool
```

**Purpose**: Completes a live run by matching its id and transitioning it according to quiet-success policy or persistent completion policy. It returns whether the run was found in this cell.

**Data flow**: Consumes a `HookRunSummary`, searches `self.runs` for a matching `id`, and returns `false` if absent. If the summary is a quiet success per `hook_run_is_quiet_success`, it calls `complete_quiet_success(Instant::now())` on the existing state and removes the run immediately if that returns false. Otherwise it destructures the summary, updates the existing run’s metadata, and replaces its state with `HookRunState::completed(status, entries)`. It returns `true` when a matching run was processed.

**Call relations**: This method is used by live hook-end handling. It depends on `hook_run_is_quiet_success` to decide whether to suppress history and on `HookRunState::completed` for durable completions.

*Call graph*: calls 2 internal fn (completed, hook_run_is_quiet_success); 1 external calls (now).


##### `HookCell::add_completed_run`  (lines 248–266)

```
fn add_completed_run(&mut self, run: HookRunSummary)
```

**Purpose**: Adds a completed run directly without requiring a prior live begin event. Quiet successes are intentionally ignored so replayed history matches live suppression policy.

**Data flow**: Consumes a `HookRunSummary`, returns immediately if `hook_run_is_quiet_success(&run)` is true, otherwise destructures the summary and pushes a new `HookRunCell` with completed state built from `status` and `entries`.

**Call relations**: This method is used by `new_completed` and replay/restoration paths where only final hook summaries are available.

*Call graph*: calls 2 internal fn (completed, hook_run_is_quiet_success).


##### `HookCell::next_timer_deadline`  (lines 268–273)

```
fn next_timer_deadline(&self) -> Option<Instant>
```

**Purpose**: Returns the earliest pending reveal or quiet-linger deadline across all runs. It lets the caller schedule the next redraw precisely.

**Data flow**: Iterates `self.runs`, collects each `run.state.next_timer_deadline()`, takes the minimum `Instant`, and returns it as `Option<Instant>`.

**Call relations**: This helper supports external timer scheduling for hook-cell redraws, complementing `advance_time`.


##### `HookCell::expire_quiet_runs_now_for_test`  (lines 276–280)

```
fn expire_quiet_runs_now_for_test(&mut self)
```

**Purpose**: Forces all quiet-linger runs to expire immediately in tests. It exists only behind `#[cfg(test)]` to make timing-sensitive behavior deterministic.

**Data flow**: Mutably iterates `self.runs` and calls `run.expire_quiet_linger_now_for_test()` on each. It updates internal deadlines but returns nothing.

**Call relations**: This test-only helper is used by unit tests that need to bypass real-time waiting for quiet-linger expiration.


##### `HookCell::reveal_running_runs_now_for_test`  (lines 283–288)

```
fn reveal_running_runs_now_for_test(&mut self)
```

**Purpose**: Forces pending runs to become revealable immediately in tests. It avoids waiting for the normal reveal delay.

**Data flow**: Captures `Instant::now()`, mutably iterates `self.runs`, and calls `run.reveal_running_now_for_test(now)` on each. It mutates internal reveal deadlines and returns nothing.

**Call relations**: This test-only helper is used by animation and rendering tests that need visible running hooks without sleeping.

*Call graph*: 1 external calls (now).


##### `HookCell::reveal_running_runs_after_delayed_redraw_for_test`  (lines 291–296)

```
fn reveal_running_runs_after_delayed_redraw_for_test(&mut self)
```

**Purpose**: Adjusts pending runs so a later redraw behaves as though the reveal delay elapsed well in the past. It is used to test delayed redraw interactions with quiet-success linger timing.

**Data flow**: Captures `Instant::now()`, mutably iterates `self.runs`, and calls `run.reveal_running_after_delayed_redraw_for_test(now)` on each. It mutates reveal deadlines only.

**Call relations**: This test-only helper supports edge-case tests around delayed redraws and minimum visible duration.

*Call graph*: 1 external calls (now).


##### `HookCell::display_lines`  (lines 301–340)

```
fn display_lines(&self, _width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the visible hook transcript lines, coalescing adjacent visible-running hooks with the same event and status into grouped rows while rendering completed runs individually. It also inserts blank separators between logical hook blocks.

**Data flow**: Reads `self.runs` and `self.animations_enabled`, iterates runs in order, skips states where `should_render()` is false, and maintains an optional `RunningHookGroup`. For visible-running runs it either increments the current group when `running_group_key()` matches or flushes the previous group and starts a new one, preserving the earliest start time via `earliest_instant`. For completed runs it flushes any pending running group, inserts a separator with `push_hook_line_separator`, and delegates line emission to `run.push_display_lines`. After the loop it flushes any remaining running group and returns the accumulated `Vec<Line<'static>>`.

**Call relations**: This is the central rendering method for `HookCell`; `transcript_lines`, `raw_lines`, and `render` all depend on it. It delegates grouped-row formatting to `push_running_hook_group` and per-run formatting to `HookRunCell::push_display_lines`.

*Call graph*: calls 4 internal fn (new, earliest_instant, push_hook_line_separator, push_running_hook_group); called by 3 (raw_lines, render, transcript_lines); 1 external calls (new).


##### `HookCell::transcript_lines`  (lines 343–345)

```
fn transcript_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns transcript lines identical to viewport lines for hooks. Hook rendering intentionally does not diverge between these two contexts.

**Data flow**: Accepts a width, forwards it to `display_lines`, and returns the resulting lines.

**Call relations**: This method simply delegates to `display_lines`, ensuring one rendering path for both transcript and viewport output.

*Call graph*: calls 1 internal fn (display_lines).


##### `HookCell::raw_lines`  (lines 347–349)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces plain raw lines from the current hook display output. It strips styling while preserving the same line structure.

**Data flow**: Calls `display_lines(u16::MAX)`, passes the result to `plain_lines`, and returns the plain vector.

**Call relations**: This raw-output path reuses the visible renderer so completed output formatting and grouping stay consistent.

*Call graph*: calls 1 internal fn (display_lines); 1 external calls (plain_lines).


##### `HookCell::transcript_animation_tick`  (lines 352–363)

```
fn transcript_animation_tick(&self) -> Option<u64>
```

**Purpose**: Computes a coarse animation tick for transcript overlays while visible running hooks are active. It disables animation when animations are globally off or when no visible running hook exists.

**Data flow**: Reads `self.animations_enabled`, then finds the first run whose state is visibly running and has a `start_time`, computes elapsed milliseconds from that instant, divides by 600, and returns the quotient as `Some(u64)`. If animations are disabled or no visible running run exists, it returns `None`.

**Call relations**: This method is used by transcript rendering infrastructure to know when hook transcript output should be considered visually changed due to animation.


##### `HookCell::render`  (lines 367–371)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the hook cell directly into a ratatui buffer. It converts the cell’s display lines into a wrapped `Paragraph` widget.

**Data flow**: Reads the target `Rect` width, calls `display_lines(area.width)`, wraps the resulting `Text` in a `Paragraph` with `Wrap { trim: false }`, and renders it into the provided `Buffer`.

**Call relations**: This method implements the `Renderable` trait for hook cells and relies on `display_lines` as the source of truth for line content.

*Call graph*: calls 1 internal fn (display_lines); 2 external calls (new, from).


##### `HookCell::desired_height`  (lines 373–375)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Returns the rendered height of the hook cell at a given width using the generic `HistoryCell` height logic. It does not implement custom sizing beyond that.

**Data flow**: Forwards `self` and `width` to `HistoryCell::desired_height` and returns the resulting `u16`.

**Call relations**: This method satisfies the `Renderable` trait and delegates sizing to the trait’s standard line-count-based implementation.

*Call graph*: calls 1 internal fn (desired_height).


##### `HookRunCell::expire_quiet_linger_now_for_test`  (lines 380–387)

```
fn expire_quiet_linger_now_for_test(&mut self)
```

**Purpose**: For test use, forces a quiet-linger run’s removal deadline to the current instant. Non-linger states are left unchanged.

**Data flow**: Mutably matches `self.state`; if it is `HookRunState::QuietLinger`, it overwrites `removal_deadline` with `Instant::now()`. It returns nothing.

**Call relations**: This helper is called by `HookCell::expire_quiet_runs_now_for_test` to make quiet-success cleanup deterministic in tests.

*Call graph*: 1 external calls (now).


##### `HookRunCell::reveal_running_now_for_test`  (lines 390–397)

```
fn reveal_running_now_for_test(&mut self, now: Instant)
```

**Purpose**: For test use, forces a pending run’s reveal deadline to a supplied instant so it can become visible immediately on the next advance. Other states are unchanged.

**Data flow**: Mutably matches `self.state`; if it is `PendingReveal`, it overwrites `reveal_deadline` with the provided `now`. It returns nothing.

**Call relations**: This helper is used by `HookCell::reveal_running_runs_now_for_test` to bypass the normal reveal delay.


##### `HookRunCell::reveal_running_after_delayed_redraw_for_test`  (lines 400–410)

```
fn reveal_running_after_delayed_redraw_for_test(&mut self, now: Instant)
```

**Purpose**: For test use, backdates a pending run’s reveal deadline so a later redraw simulates a hook that became visible well before completion. This helps exercise quiet-success linger timing.

**Data flow**: Mutably matches `self.state`; if it is `PendingReveal`, it computes a delayed deadline by subtracting `QUIET_HOOK_MIN_VISIBLE + 100ms` from the provided `now` when possible, falling back to `now`, and stores that deadline. It returns nothing.

**Call relations**: This helper is called by `HookCell::reveal_running_runs_after_delayed_redraw_for_test` in timing-sensitive tests.

*Call graph*: 2 external calls (from_millis, checked_sub).


##### `HookRunCell::running_group_key`  (lines 413–420)

```
fn running_group_key(&self) -> Option<RunningHookGroupKey>
```

**Purpose**: Returns the grouping key for runs that should render as active running rows. Completed and hidden pending runs do not participate in grouping.

**Data flow**: Checks `self.state.is_running_visible()`, and if true constructs `RunningHookGroupKey { event_name: self.event_name, status_message: self.status_message.clone() }`; otherwise returns `None`.

**Call relations**: This helper is used by `HookCell::display_lines` to decide whether adjacent runs can be coalesced into one grouped running row.

*Call graph*: calls 1 internal fn (is_running_visible).


##### `HookRunCell::push_display_lines`  (lines 423–465)

```
fn push_display_lines(&self, lines: &mut Vec<Line<'static>>, animations_enabled: bool)
```

**Purpose**: Appends the visible lines for one ungrouped hook run. Running states render a shared running header, while completed states render a status line plus indented output entries.

**Data flow**: Reads `self.event_name`, `self.status_message`, and `self.state`, plus mutable output `lines` and `animations_enabled`. For `VisibleRunning` and `QuietLinger`, it formats `Running <label> hook` and delegates to `push_running_hook_header`. For `Completed`, it lowercases the debug-formatted status, computes a bullet via `hook_completed_bullet`, pushes a header line `<bullet> <label> hook (<status>)`, then iterates `entries`: the first line of each entry gets `HOOK_OUTPUT_INDENT` plus `hook_output_prefix(kind)`, subsequent non-empty lines get `HOOK_OUTPUT_BODY_INDENT`, and empty lines are preserved as blank lines. `PendingReveal` emits nothing.

**Call relations**: This per-run renderer is called by `HookCell::display_lines` for completed runs and any ungrouped visible run paths. It delegates status labeling and output-prefix selection to helper functions.

*Call graph*: calls 4 internal fn (hook_completed_bullet, hook_event_label, hook_output_prefix, push_running_hook_header); 2 external calls (format!, vec!).


##### `HookRunState::pending`  (lines 470–475)

```
fn pending(start_time: Instant) -> Self
```

**Purpose**: Creates the initial hidden state for a newly started live hook run. The reveal deadline is offset by the configured reveal delay.

**Data flow**: Consumes a `start_time: Instant` and returns `HookRunState::PendingReveal { start_time, reveal_deadline: start_time + HOOK_RUN_REVEAL_DELAY }`.

**Call relations**: This constructor is used by `HookCell::start_run` whenever a run begins or a duplicate begin event refreshes an existing run.

*Call graph*: called by 1 (start_run).


##### `HookRunState::completed`  (lines 478–480)

```
fn completed(status: HookRunStatus, entries: Vec<HookOutputEntry>) -> Self
```

**Purpose**: Creates the persistent completed state for a hook run with a final status and output entries. It does not apply quiet-success suppression itself.

**Data flow**: Consumes a `HookRunStatus` and `Vec<HookOutputEntry>`, stores them in `HookRunState::Completed`, and returns that state.

**Call relations**: This constructor is used by `HookCell::complete_run` and `HookCell::add_completed_run` after higher-level logic has decided the completion should be preserved.

*Call graph*: called by 2 (add_completed_run, complete_run).


##### `HookRunState::is_active`  (lines 483–490)

```
fn is_active(&self) -> bool
```

**Purpose**: Reports whether the run is still part of the live state machine. Pending, visible-running, and quiet-linger states are active; completed is not.

**Data flow**: Matches `self` and returns `true` for `PendingReveal`, `VisibleRunning`, and `QuietLinger`, otherwise `false`.

**Call relations**: This predicate is used by `HookCell::is_active` to determine whether the overall hook cell can still change due to events or timers.


##### `HookRunState::should_render`  (lines 493–500)

```
fn should_render(&self) -> bool
```

**Purpose**: Reports whether the run currently contributes visible lines. Hidden pending runs do not render; visible-running, quiet-linger, and completed runs do.

**Data flow**: Matches `self` and returns a boolean based on the variant. It does not mutate state.

**Call relations**: This predicate is used by `HookCell::should_render` and `HookCell::display_lines` to skip hidden pending runs.


##### `HookRunState::has_persistent_output`  (lines 503–512)

```
fn has_persistent_output(&self) -> bool
```

**Purpose**: Determines whether a completed run should survive outside the active cell. Successful completions without output are treated as non-persistent quiet successes.

**Data flow**: Matches `self`; for `Completed`, it returns true when `status != HookRunStatus::Completed` or `entries` is non-empty, and false otherwise. All active-state variants return false.

**Call relations**: This predicate drives `HookCell::take_completed_persistent_runs`, which separates durable history from ephemeral active-cell state.


##### `HookRunState::start_time`  (lines 517–524)

```
fn start_time(&self) -> Option<Instant>
```

**Purpose**: Returns the original start time for active states so animation and grouping can remain stable across transitions. Completed runs intentionally have no start time.

**Data flow**: Matches `self` and returns `Some(start_time)` for `PendingReveal`, `VisibleRunning`, and `QuietLinger`, otherwise `None`.

**Call relations**: This helper is used during grouped running rendering and transcript animation tick calculation.


##### `HookRunState::is_running_visible`  (lines 527–532)

```
fn is_running_visible(&self) -> bool
```

**Purpose**: Reports whether the run should be treated as an in-progress visible row. Quiet linger counts as visible-running for grouping and occupancy purposes.

**Data flow**: Uses `matches!` to return true for `VisibleRunning` and `QuietLinger`, false otherwise.

**Call relations**: This predicate is used by `HookRunCell::running_group_key` and by `HookCell::has_visible_running_run` to identify visible active rows.

*Call graph*: called by 1 (running_group_key); 1 external calls (matches!).


##### `HookRunState::reveal_if_due`  (lines 538–554)

```
fn reveal_if_due(&mut self, now: Instant) -> bool
```

**Purpose**: Transitions a pending run into visible-running once its reveal deadline has passed. It reports whether the state actually changed.

**Data flow**: Mutably matches `self` as `PendingReveal`, compares `now` to `reveal_deadline`, and if due replaces `self` with `VisibleRunning { start_time, visible_since: now }` and returns `true`. Non-pending states or not-yet-due pending states return `false`.

**Call relations**: This timer transition is called from `HookCell::advance_time` so redraw scheduling can reveal hooks only after the configured delay.


##### `HookRunState::next_timer_deadline`  (lines 557–567)

```
fn next_timer_deadline(&self) -> Option<Instant>
```

**Purpose**: Returns the next timer deadline owned by this run, if any. Pending runs expose reveal deadlines and quiet-linger runs expose removal deadlines.

**Data flow**: Matches `self` and returns `Some(reveal_deadline)` for `PendingReveal`, `Some(removal_deadline)` for `QuietLinger`, and `None` for `VisibleRunning` and `Completed`.

**Call relations**: This helper feeds `HookCell::next_timer_deadline`, which computes the earliest deadline across all runs.


##### `HookRunState::quiet_linger_expired`  (lines 570–579)

```
fn quiet_linger_expired(&self, now: Instant) -> bool
```

**Purpose**: Checks whether a quiet-linger run has stayed visible long enough to be removed. Other states never expire through this path.

**Data flow**: Matches `self`; for `QuietLinger` it compares `now >= removal_deadline`, otherwise returns false.

**Call relations**: This predicate is used by `HookCell::advance_time` when retaining or dropping runs after timer advancement.


##### `HookRunState::complete_quiet_success`  (lines 585–604)

```
fn complete_quiet_success(&mut self, now: Instant) -> bool
```

**Purpose**: Handles completion of a visible quiet-success run by either converting it into a temporary linger state or signaling that it can be removed immediately. Runs that were never visible also return false.

**Data flow**: Mutably matches `self` as `VisibleRunning`, computes `minimum_deadline = visible_since + QUIET_HOOK_MIN_VISIBLE`, and if `now` is before that deadline replaces `self` with `QuietLinger { start_time, removal_deadline: minimum_deadline }` and returns `true`. If the run was not visible-running or has already been visible long enough, it returns `false` without preserving it.

**Call relations**: This transition is used by `HookCell::complete_run` specifically for quiet successes, implementing the policy that visible quiet hooks linger briefly but invisible or already-long-visible ones disappear.


##### `RunningHookGroup::new`  (lines 608–614)

```
fn new(key: RunningHookGroupKey, start_time: Option<Instant>) -> Self
```

**Purpose**: Initializes a grouping accumulator for adjacent running hooks that share the same event and status message. The initial count is always one.

**Data flow**: Consumes a `RunningHookGroupKey` and optional `start_time`, stores them with `count: 1`, and returns the new group.

**Call relations**: This constructor is used by `HookCell::display_lines` whenever it starts a new adjacent running-hook group.

*Call graph*: called by 1 (display_lines).


##### `push_running_hook_group`  (lines 618–637)

```
fn push_running_hook_group(
    lines: &mut Vec<Line<'static>>,
    group: &RunningHookGroup,
    animations_enabled: bool,
)
```

**Purpose**: Emits one grouped running-hook status row for one or more adjacent visible-running hooks. It chooses singular or plural wording based on the group count.

**Data flow**: Mutably borrows the output line vector, reads the `RunningHookGroup`, inserts a separator via `push_hook_line_separator`, derives the event label with `hook_event_label`, formats either `Running <label> hook` or `Running N <label> hooks`, and delegates actual header styling to `push_running_hook_header` with the group’s earliest start time and shared status message.

**Call relations**: This helper is called by `HookCell::display_lines` whenever a running group must be flushed, either before a completed run or at the end of iteration.

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

**Purpose**: Builds the animated or static header line used for all running hook rows. It combines optional activity indicator, shimmer/bold hook text, and optional dimmed status message.

**Data flow**: Mutably borrows the output line vector and reads `hook_text`, optional `start_time`, optional `status_message`, and `animations_enabled`. It derives `MotionMode`, optionally gets an indicator from `activity_indicator`, appends shimmer spans from `shimmer_text`, patches the last span to bold when animations are disabled, conditionally appends `: <status_message>` if non-empty, and pushes the assembled spans as one `Line`.

**Call relations**: This helper is shared by `HookRunCell::push_display_lines` for single running rows and by `push_running_hook_group` for grouped rows, keeping running-header styling consistent.

*Call graph*: calls 3 internal fn (from_animations_enabled, activity_indicator, shimmer_text); called by 2 (push_display_lines, push_running_hook_group); 2 external calls (default, new).


##### `push_hook_line_separator`  (lines 669–673)

```
fn push_hook_line_separator(lines: &mut Vec<Line<'static>>)
```

**Purpose**: Adds a blank line between hook blocks without ever creating a leading blank line. It is a tiny layout helper for grouped and completed hook sections.

**Data flow**: Mutably borrows the output line vector and pushes an empty line only if the vector is not already empty.

**Call relations**: This helper is used by both `HookCell::display_lines` and `push_running_hook_group` to maintain clean spacing between logical hook blocks.

*Call graph*: called by 2 (display_lines, push_running_hook_group).


##### `earliest_instant`  (lines 676–683)

```
fn earliest_instant(left: Option<Instant>, right: Option<Instant>) -> Option<Instant>
```

**Purpose**: Combines two optional instants while preserving the earliest known time. It is used so grouped running hooks inherit the oldest spinner phase.

**Data flow**: Consumes two `Option<Instant>` values and returns `Some(min)` when both are present, the present one when only one exists, or `None` when both are absent.

**Call relations**: This helper is called by `HookCell::display_lines` when folding adjacent running hooks into one group.

*Call graph*: called by 1 (display_lines).


##### `new_active_hook_cell`  (lines 685–687)

```
fn new_active_hook_cell(run: HookRunSummary, animations_enabled: bool) -> HookCell
```

**Purpose**: Public convenience constructor for a live hook cell. It hides the internal `HookCell::new_active` method behind a module-level helper.

**Data flow**: Consumes a `HookRunSummary` and animation flag, forwards them to `HookCell::new_active`, and returns the resulting `HookCell`.

**Call relations**: This is the external entrypoint used by other modules when a hook begins.

*Call graph*: calls 1 internal fn (new_active).


##### `new_completed_hook_cell`  (lines 689–691)

```
fn new_completed_hook_cell(run: HookRunSummary, animations_enabled: bool) -> HookCell
```

**Purpose**: Public convenience constructor for a completed hook cell. It wraps `HookCell::new_completed` for callers outside the impl block.

**Data flow**: Consumes a `HookRunSummary` and animation flag, forwards them to `HookCell::new_completed`, and returns the resulting `HookCell`.

**Call relations**: This helper is used by replay/restoration code and tests that need a completed hook cell directly.

*Call graph*: calls 1 internal fn (new_completed).


##### `hook_run_is_quiet_success`  (lines 694–696)

```
fn hook_run_is_quiet_success(run: &HookRunSummary) -> bool
```

**Purpose**: Identifies hook completions that should be invisible in history: successful completion with no output entries. This is the core policy predicate for quiet-hook suppression.

**Data flow**: Reads a borrowed `HookRunSummary` and returns true when `run.status == HookRunStatus::Completed` and `run.entries.is_empty()`, otherwise false.

**Call relations**: This predicate is used by both `HookCell::complete_run` and `HookCell::add_completed_run` to decide whether a completion should be suppressed or preserved.

*Call graph*: called by 2 (add_completed_run, complete_run).


##### `hook_completed_bullet`  (lines 698–713)

```
fn hook_completed_bullet(status: HookRunStatus, entries: &[HookOutputEntry]) -> Span<'static>
```

**Purpose**: Chooses the bullet styling for a completed hook based on final status and whether any output entry is a warning. Successful warnings use an uncolored bold bullet, plain successes use green bold, and failures/stops use red bold.

**Data flow**: Consumes a `HookRunStatus` and slice of `HookOutputEntry`. It matches on status; for `Completed` it scans entries for any `Warning` kind and returns either bold default-color `•` or green bold `•`, for blocked/failed/stopped it returns red bold `•`, and for `Running` it returns an unstyled bullet.

**Call relations**: This helper is used by `HookRunCell::push_display_lines` when rendering completed runs and is directly tested to lock down warning-bullet behavior.

*Call graph*: called by 2 (push_display_lines, completed_hook_with_warning_uses_default_bold_bullet); 1 external calls (iter).


##### `hook_output_prefix`  (lines 715–723)

```
fn hook_output_prefix(kind: HookOutputEntryKind) -> &'static str
```

**Purpose**: Maps a hook output entry kind to the textual prefix shown on the first line of that entry. It standardizes labels like `warning:` and `hook context:`.

**Data flow**: Consumes a `HookOutputEntryKind`, matches it, and returns the corresponding `'static` string slice.

**Call relations**: This helper is used by `HookRunCell::push_display_lines` when rendering completed hook output entries.

*Call graph*: called by 1 (push_display_lines).


##### `hook_event_label`  (lines 725–738)

```
fn hook_event_label(event_name: HookEventName) -> &'static str
```

**Purpose**: Maps a `HookEventName` enum to the exact label shown in running and completed hook headers. The labels preserve protocol naming like `PostToolUse` and `SessionStart`.

**Data flow**: Consumes a `HookEventName`, matches each variant, and returns a `'static` string slice.

**Call relations**: This helper is used by both `HookRunCell::push_display_lines` and `push_running_hook_group` so all hook headers share the same event-name wording.

*Call graph*: called by 2 (push_display_lines, push_running_hook_group).


##### `tests::completed_hook_with_warning_uses_default_bold_bullet`  (lines 749–760)

```
fn completed_hook_with_warning_uses_default_bold_bullet()
```

**Purpose**: Verifies that a completed hook containing a warning entry uses a bold bullet without forcing a foreground color. This preserves warning semantics distinct from plain success green.

**Data flow**: Builds a warning `HookOutputEntry`, calls `hook_completed_bullet`, and asserts on the returned span’s content, foreground color, and bold modifier.

**Call relations**: This test directly exercises the bullet-selection helper to prevent regressions in warning styling.

*Call graph*: calls 1 internal fn (hook_completed_bullet); 3 external calls (assert!, assert_eq!, vec!).


##### `tests::completed_hook_multiline_context_preserves_display_and_raw_lines`  (lines 763–783)

```
fn completed_hook_multiline_context_preserves_display_and_raw_lines()
```

**Purpose**: Checks that multiline context output renders with the prefix only on the first line and preserves blank lines in both display and raw output. It validates parity between visible and raw representations.

**Data flow**: Constructs a completed hook cell with one multiline `Context` entry via `completed_hook_cell`, converts both `display_lines` and `raw_lines` to plain strings with `line_texts`, and asserts exact equality with the expected vector.

**Call relations**: This test covers the completed-output formatting path implemented in `HookRunCell::push_display_lines` and reused by `raw_lines`.

*Call graph*: 3 external calls (assert_eq!, completed_hook_cell, vec!).


##### `tests::completed_hook_multiline_warning_prefixes_first_line_only`  (lines 786–804)

```
fn completed_hook_multiline_warning_prefixes_first_line_only()
```

**Purpose**: Verifies that multiline warning output prefixes only the first line with `warning:` and indents continuation lines without repeating the label.

**Data flow**: Builds a completed hook cell containing a multiline `Warning` entry, renders `display_lines`, converts them to strings, and asserts the exact expected sequence.

**Call relations**: This test targets the first-line-versus-continuation formatting logic in `HookRunCell::push_display_lines`.

*Call graph*: 3 external calls (assert_eq!, completed_hook_cell, vec!).


##### `tests::pending_hook_does_not_animate_transcript`  (lines 807–812)

```
fn pending_hook_does_not_animate_transcript()
```

**Purpose**: Ensures that a newly started but still hidden pending hook does not report a transcript animation tick. Hidden hooks should not trigger transcript animation churn.

**Data flow**: Creates a live hook cell with `HookCell::new_active(hook_run_summary("hook-1"), true)` and asserts that `transcript_animation_tick()` returns `None`.

**Call relations**: This test validates the interaction between pending reveal state and transcript animation gating.

*Call graph*: calls 1 internal fn (new_active); 2 external calls (assert_eq!, hook_run_summary).


##### `tests::visible_hook_animates_transcript_when_animations_enabled`  (lines 815–822)

```
fn visible_hook_animates_transcript_when_animations_enabled()
```

**Purpose**: Checks that a visible running hook reports an animation tick when animations are enabled. This confirms transcript overlays can refresh animated hook rows.

**Data flow**: Creates a live hook cell with animations enabled, forces reveal via the test helper, advances time, and asserts that `transcript_animation_tick()` returns `Some(0)`.

**Call relations**: This test exercises the reveal path plus transcript animation logic under enabled animations.

*Call graph*: calls 1 internal fn (new_active); 3 external calls (now, assert_eq!, hook_run_summary).


##### `tests::visible_hook_does_not_animate_transcript_when_animations_disabled`  (lines 825–834)

```
fn visible_hook_does_not_animate_transcript_when_animations_disabled()
```

**Purpose**: Ensures that visible running hooks do not animate transcript output when animations are globally disabled. The transcript should remain static in reduced-motion mode.

**Data flow**: Creates a live hook cell with animations disabled, forces reveal, advances time, and asserts that `transcript_animation_tick()` returns `None`.

**Call relations**: This test validates the `animations_enabled` gate in `HookCell::transcript_animation_tick`.

*Call graph*: calls 1 internal fn (new_active); 3 external calls (now, assert_eq!, hook_run_summary).


##### `tests::visible_hook_without_animations_omits_spinner`  (lines 837–855)

```
fn visible_hook_without_animations_omits_spinner()
```

**Purpose**: Verifies that a visible running hook renders plain bold text without a spinner when animations are disabled. This locks down reduced-motion rendering behavior.

**Data flow**: Creates a live hook cell with animations disabled, forces reveal, advances time, renders `display_lines(80)`, converts each line to text, and asserts the exact single-line output.

**Call relations**: This test covers `push_running_hook_header` behavior when `animations_enabled` is false.

*Call graph*: calls 1 internal fn (new_active); 3 external calls (now, assert_eq!, hook_run_summary).


##### `tests::completed_hook_cell`  (lines 857–870)

```
fn completed_hook_cell(
        event_name: HookEventName,
        status: HookRunStatus,
        entries: Vec<HookOutputEntry>,
    ) -> HookCell
```

**Purpose**: Builds a reusable completed-hook fixture for rendering tests. It starts from a generic running summary and overwrites the completion-specific fields.

**Data flow**: Accepts `event_name`, `status`, and `entries`, creates a base summary with `hook_run_summary`, mutates its event, status, status message, completion timestamps, and entries, then returns `HookCell::new_completed(run, false)`.

**Call relations**: This helper is used by multiple tests that need a completed hook cell with controlled output content.

*Call graph*: calls 1 internal fn (new_completed); 1 external calls (hook_run_summary).


##### `tests::line_texts`  (lines 872–874)

```
fn line_texts(lines: &[Line<'_>]) -> Vec<String>
```

**Purpose**: Converts a slice of ratatui `Line`s into plain `String`s for concise assertions. It keeps rendering tests readable.

**Data flow**: Accepts `&[Line]`, iterates over the slice, maps each line through `line_text`, collects the results into `Vec<String>`, and returns it.

**Call relations**: This helper is used by completed-hook rendering tests to compare line content without style metadata.

*Call graph*: 1 external calls (iter).


##### `tests::line_text`  (lines 876–881)

```
fn line_text(line: &Line<'_>) -> String
```

**Purpose**: Flattens one ratatui `Line` into its concatenated textual content. It ignores style and hyperlink metadata.

**Data flow**: Reads a borrowed `Line`, iterates its spans, concatenates each span’s `content` into a `String`, and returns that string.

**Call relations**: This helper underpins `line_texts` in rendering assertions.


##### `tests::hook_run_summary`  (lines 883–900)

```
fn hook_run_summary(id: &str) -> HookRunSummary
```

**Purpose**: Constructs a baseline `HookRunSummary` fixture representing a running `PostToolUse` hook with a status message. It supplies realistic protocol metadata for tests.

**Data flow**: Accepts an `id: &str`, fills a `HookRunSummary` with fixed handler type, execution mode, scope, source path, source, display order, running status, status message, timestamps, and empty entries, and returns it.

**Call relations**: This fixture helper is used by tests that need either live or completed hook summaries as starting data.

*Call graph*: 2 external calls (new, test_path_buf).


### Chat widget streaming and turn state
These files turn low-level stream and tool events into live chat-widget state, transcript updates, command and hook lifecycle changes, and finalized turn behavior.

### `tui/src/chatwidget/exec_state.rs`

`data_model` · `cross-cutting`

This file is the lightweight state/model companion for command execution handling. It defines `RunningCommand`, which stores the split command vector, parsed command actions (`Vec<ParsedCommand>`), and original `ExecCommandSource` for a currently running call. It also defines `UnifiedExecProcessSummary`, the per-process record used by the unified-exec footer: stable key, current call id, display command, and a rolling list of recent output lines.

Two small helper structs model unified-exec waiting behavior. `UnifiedExecWaitState` remembers the last unified interaction command display so duplicate wait interactions can be suppressed. `UnifiedExecWaitStreak` groups repeated empty-stdin terminal polls for a single process and stores an optional non-empty command display; its update method only fills in the display once, preserving the first meaningful label.

The free functions provide the classification and parsing glue used by lifecycle handlers. `is_unified_exec_source` identifies the two unified-exec sources. `is_standard_tool_call` rejects empty parsed-command lists and any list containing `ParsedCommand::Unknown`, which is important because unified exec may still need a status indicator even when transcript rendering is skipped. `command_execution_command_and_parsed` converts the raw command string and protocol-layer `CommandAction` slice into the split command vector and core parsed-command vector expected by the UI.

#### Function details

##### `UnifiedExecWaitState::new`  (lines 26–28)

```
fn new(command_display: String) -> Self
```

**Purpose**: Creates a wait-state record for the most recent unified-exec interaction command display. It is used to detect duplicate wait interactions across command starts.

**Data flow**: Takes an owned `String` `command_display` and returns `UnifiedExecWaitState { command_display }` with no side effects.

**Call relations**: Constructed from the immediate command-start handler when a unified-exec interaction begins. Its stored value is later compared through `is_duplicate` to decide whether a new wait interaction should be suppressed.

*Call graph*: called by 1 (handle_command_execution_started_now).


##### `UnifiedExecWaitState::is_duplicate`  (lines 30–32)

```
fn is_duplicate(&self, command_display: &str) -> bool
```

**Purpose**: Checks whether a candidate command display matches the stored unified wait command exactly. This is the suppression predicate for repeated wait interactions.

**Data flow**: Reads `self.command_display` and compares it to the borrowed `command_display` argument, returning a boolean equality result.

**Call relations**: Used by command-start logic to avoid rendering duplicate unified wait interactions back-to-back.


##### `UnifiedExecWaitStreak::new`  (lines 42–47)

```
fn new(process_id: String, command_display: Option<String>) -> Self
```

**Purpose**: Creates a new grouped waiting streak for a unified-exec process. It normalizes away empty command-display strings so the streak only stores meaningful labels.

**Data flow**: Takes `process_id` and optional `command_display`, filters the display with `!display.is_empty()`, and returns `UnifiedExecWaitStreak { process_id, command_display }`.

**Call relations**: Created from terminal-interaction handling when empty-stdin polling begins for a process or switches to a different process.

*Call graph*: called by 1 (on_terminal_interaction).


##### `UnifiedExecWaitStreak::update_command_display`  (lines 49–54)

```
fn update_command_display(&mut self, command_display: Option<String>)
```

**Purpose**: Fills in the streak's command display if it is currently missing, but never overwrites an existing non-empty display. This preserves the first useful label associated with the streak.

**Data flow**: Mutably reads `self.command_display`; if it is already `Some`, returns immediately. Otherwise it filters the incoming optional string for non-empty content and stores it into `self.command_display`.

**Call relations**: Used during repeated empty-stdin terminal polling when later events provide a command display for an already-open wait streak.


##### `is_unified_exec_source`  (lines 57–62)

```
fn is_unified_exec_source(source: ExecCommandSource) -> bool
```

**Purpose**: Classifies whether a command execution source belongs to the unified-exec subsystem. It recognizes startup and interaction variants only.

**Data flow**: Takes an `ExecCommandSource` by value and returns true when it matches `UnifiedExecStartup` or `UnifiedExecInteraction`, false otherwise.

**Call relations**: This predicate is used by command lifecycle handlers to branch into unified-exec-specific tracking and rendering behavior.

*Call graph*: 1 external calls (matches!).


##### `is_standard_tool_call`  (lines 64–69)

```
fn is_standard_tool_call(parsed_cmd: &[ParsedCommand]) -> bool
```

**Purpose**: Determines whether a parsed command list represents a normal tool call suitable for standard exec-cell rendering. It rejects unknown parses and empty command lists.

**Data flow**: Reads a slice of `ParsedCommand`, returns false if it is empty, otherwise iterates through all entries and returns true only if none match `ParsedCommand::Unknown { .. }`.

**Call relations**: Used by command-start handling to keep unified-exec status indicators visible while skipping transcript rendering for non-standard or unknown parsed commands.

*Call graph*: 2 external calls (is_empty, iter).


##### `command_execution_command_and_parsed`  (lines 71–83)

```
fn command_execution_command_and_parsed(
    command: &str,
    command_actions: &[codex_app_server_protocol::CommandAction],
) -> (Vec<String>, Vec<ParsedCommand>)
```

**Purpose**: Converts protocol-layer command execution payload into the split command vector and core parsed-command vector used by the UI. It is the shared parser bridge for command lifecycle code.

**Data flow**: Accepts raw command text and a slice of protocol `CommandAction`. It calls `split_command_string(command)` to produce `Vec<String>`, clones and converts each action with `CommandAction::into_core`, collects them into `Vec<ParsedCommand>`, and returns the pair.

**Call relations**: This helper is used by command-start handling to derive both displayable command tokens and parsed command metadata from incoming execution events.

*Call graph*: calls 1 internal fn (split_command_string); 1 external calls (iter).


### `tui/src/chatwidget/status_state.rs`

`data_model` · `request handling and streaming status updates`

This file is the in-memory model for status presentation rather than the rendering itself. `StatusIndicatorState` stores the exact footer payload currently intended for display: a `header`, optional multiline `details`, and a `details_max_lines` cap seeded from `STATUS_DETAILS_DEFAULT_MAX_LINES`. Its `working()` constructor establishes the default visible state, and `is_guardian_review()` recognizes the special guardian-review headers by exact string/prefix matching so other code can tell whether the current footer came from approval review aggregation.

`TerminalTitleStatusKind` deliberately compresses richer runtime states into three stable title labels: `Working`, `WaitingForBackgroundTerminal`, and `Thinking`. `PendingGuardianReviewStatus` tracks multiple concurrent approval-review requests as `id`/`detail` pairs, updating entries in place by id and removing them on completion. Its derived `status_indicator_state()` is where the aggregation policy lives: one pending review renders a singular header and one-line detail; multiple reviews render up to three bullet lines plus a `+N more` overflow line, with a taller line budget.

`StatusState` ties these pieces together for `ChatWidget`: the currently cached footer state, the pending guardian-review set, the terminal-title bucket, an optional retry header remembered across transient stream errors, and a boolean requesting deferred footer restoration after streaming drains. The tests pin two subtle invariants: parallel guardian reviews collapse into one combined footer, and retry headers are one-shot via `take()`.

#### Function details

##### `StatusIndicatorState::working`  (lines 13–19)

```
fn working() -> Self
```

**Purpose**: Builds the canonical default footer status used when a task is simply running without extra detail. It hardcodes the header to `Working`, clears details, and applies the default detail line limit.

**Data flow**: Takes no arguments and reads the module constant `STATUS_DETAILS_DEFAULT_MAX_LINES` → constructs a new `StatusIndicatorState` with `header = "Working"`, `details = None`, and the default max-lines value → returns that struct without mutating external state.

**Call relations**: Used as the baseline status constructor when `StatusState` is initialized, so callers that create a fresh widget status cache start from a visible working state instead of an empty footer.

*Call graph*: called by 1 (default); 1 external calls (from).


##### `StatusIndicatorState::is_guardian_review`  (lines 21–23)

```
fn is_guardian_review(&self) -> bool
```

**Purpose**: Detects whether the current status header represents guardian approval review. The check is intentionally string-based so callers can recognize both the singular fixed phrase and pluralized variants.

**Data flow**: Reads `self.header` → compares it to `"Reviewing approval request"` and also checks whether it starts with `"Reviewing "` → returns `true` for guardian-review-derived headers and `false` otherwise.

**Call relations**: This is a leaf predicate used by surrounding status-management code when it needs to distinguish guardian-generated footer content from ordinary task statuses.


##### `PendingGuardianReviewStatus::start_or_update`  (lines 51–58)

```
fn start_or_update(&mut self, id: String, detail: String)
```

**Purpose**: Registers a pending guardian review entry or refreshes the detail text for an existing one with the same id. This keeps the pending-review set deduplicated by request id.

**Data flow**: Consumes `id: String` and `detail: String`, mutably reads `self.entries` → searches for an existing entry whose `id` matches; if found, overwrites only `detail`, otherwise pushes a new `PendingGuardianReviewStatusEntry { id, detail }` → returns `()` after mutating the vector in place.

**Call relations**: Called by external guardian-review event handling whenever a review starts or emits updated descriptive text, ensuring later aggregation reflects the latest detail per request.


##### `PendingGuardianReviewStatus::finish`  (lines 60–64)

```
fn finish(&mut self, id: &str) -> bool
```

**Purpose**: Removes a pending guardian review by id and reports whether anything actually changed. The boolean lets callers know whether a completion event matched tracked state.

**Data flow**: Takes `id: &str`, reads the original `self.entries.len()` → retains only entries whose `entry.id != id`, shrinking the vector if a match existed → returns `true` when the length changed and `false` when no tracked entry matched.

**Call relations**: Used by completion handling for guardian reviews so the widget can drop finished requests and decide whether it needs to recompute or restore footer state.


##### `PendingGuardianReviewStatus::is_empty`  (lines 66–68)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether there are any guardian reviews still pending. It is a thin convenience wrapper over the backing vector.

**Data flow**: Reads `self.entries.is_empty()` → returns the resulting boolean without mutating state.

**Call relations**: Serves callers that need a quick emptiness check before deciding whether guardian-specific footer content should remain active.


##### `PendingGuardianReviewStatus::status_indicator_state`  (lines 74–104)

```
fn status_indicator_state(&self) -> Option<StatusIndicatorState>
```

**Purpose**: Synthesizes the footer snapshot that should be shown while guardian approval reviews are in flight. It converts the full pending-entry set into a single `StatusIndicatorState` with singular/plural headers and compact detail formatting.

**Data flow**: Reads `self.entries` → if there is exactly one entry, clones its `detail`; if there are multiple, formats up to three bullet lines and appends `+N more` for overflow; if there are none, yields `None` early → derives a singular or plural `header` and chooses `details_max_lines` of `1` or `4` based on entry count → returns `Some(StatusIndicatorState { ... })` only when there is at least one detail-bearing pending entry.

**Call relations**: Invoked by external status-management code when guardian review state changes; it is the sole place that translates the tracked pending-review set into the footer cache that temporarily overrides generic status text.

*Call graph*: 2 external calls (from, format!).


##### `StatusState::default`  (lines 117–125)

```
fn default() -> Self
```

**Purpose**: Creates the initial status cache for a new `ChatWidget`. The default starts in a visible working state, with no pending guardian reviews, no retry header, and no deferred restore request.

**Data flow**: Takes no arguments → calls `StatusIndicatorState::working()` and `PendingGuardianReviewStatus::default()` → returns a `StatusState` whose `terminal_title_status_kind` is `Working`, `retry_status_header` is `None`, and `pending_status_indicator_restore` is `false`.

**Call relations**: Used when constructing a widget and in tests that need a clean status cache; downstream code then mutates this struct as turns, retries, and streaming events occur.

*Call graph*: calls 1 internal fn (working); called by 2 (new_with_op_target, retry_status_header_is_taken_once); 1 external calls (default).


##### `StatusState::set_status`  (lines 129–131)

```
fn set_status(&mut self, status: StatusIndicatorState)
```

**Purpose**: Replaces the cached current footer snapshot wholesale. It does not merge fields or apply policy; it simply stores the provided state.

**Data flow**: Consumes `status: StatusIndicatorState`, mutably writes `self.current_status = status` → returns `()`.

**Call relations**: Called by higher-level chatwidget status logic after it has already decided what the footer should be, making this method the simple assignment point for the cache.


##### `StatusState::take_retry_status_header`  (lines 133–135)

```
fn take_retry_status_header(&mut self) -> Option<String>
```

**Purpose**: Extracts and clears the remembered pre-retry header in one step. This enforces one-time restoration semantics.

**Data flow**: Mutably reads `self.retry_status_header` and applies `take()` → returns the previous `Option<String>` while leaving the field as `None`.

**Call relations**: Used by retry-recovery flow when a transient stream error ends and the widget wants to restore the prior header exactly once rather than repeatedly.

*Call graph*: called by 1 (restore_retry_status_header_if_present).


##### `StatusState::remember_retry_status_header`  (lines 137–141)

```
fn remember_retry_status_header(&mut self)
```

**Purpose**: Captures the current header as the retry-restore target, but only if one has not already been saved. This prevents later retry messages from overwriting the original status being preserved.

**Data flow**: Mutably reads `self.retry_status_header` and `self.current_status.header` → if no retry header is stored, clones the current header into `self.retry_status_header`; otherwise leaves state unchanged → returns `()`.

**Call relations**: Called before showing retry/error status so later recovery can restore the original header; its guard against overwriting is what makes the remembered value stable across repeated retry updates.


##### `tests::guardian_status_aggregates_parallel_reviews`  (lines 151–164)

```
fn guardian_status_aggregates_parallel_reviews()
```

**Purpose**: Verifies that multiple pending guardian reviews collapse into one pluralized footer with bullet-point details. The test locks down both formatting and line-budget behavior.

**Data flow**: Creates a default `PendingGuardianReviewStatus`, inserts two entries, computes `status_indicator_state()` → compares the returned `Some(StatusIndicatorState { ... })` against the expected header, joined bullet details, and `details_max_lines = 4`.

**Call relations**: This unit test exercises the aggregation branch of `PendingGuardianReviewStatus::status_indicator_state`, specifically the multi-entry formatting path.

*Call graph*: 2 external calls (assert_eq!, default).


##### `tests::retry_status_header_is_taken_once`  (lines 167–178)

```
fn retry_status_header_is_taken_once()
```

**Purpose**: Confirms that remembered retry headers are consumable exactly once. It protects the invariant that restoration clears the saved header.

**Data flow**: Creates a default `StatusState`, mutates `current_status.header` to `Thinking`, calls `remember_retry_status_header()`, then calls `take_retry_status_header()` twice → asserts the first call returns `Some("Thinking")` and the second returns `None`.

**Call relations**: This test covers the interaction between `remember_retry_status_header` and `take_retry_status_header`, ensuring the retry-restore cache behaves as a one-shot slot.

*Call graph*: calls 1 internal fn (default); 1 external calls (assert_eq!).


### `tui/src/chatwidget/transcript.rs`

`data_model` · `cross-cutting`

This file is a focused state container rather than a rendering module. `TranscriptState` stores the current live `active_cell`, a wrapping `active_cell_revision` used to invalidate overlay caches, and several pieces of transcript-derived memory: the latest completed agent markdown, a bounded history of copyable agent responses keyed by visible user-turn count, and booleans that summarize what happened during the current turn. Those booleans drive later UI decisions such as whether a final message separator should be inserted, whether a plan implementation prompt is eligible, and whether work activity occurred.

The copy-history logic is intentionally tied to `visible_user_turn_count`, not raw event count. `record_agent_markdown` either overwrites the latest entry for the current visible user turn or appends a new `AgentTurnMarkdown`, then trims the vector to `MAX_AGENT_COPY_HISTORY` by dropping the oldest entry. `truncate_copy_history_to_user_turn_count` supports rollback: it resets the visible turn count, retains only entries at or before that turn, recomputes `last_agent_markdown`, and sets `copy_history_evicted_by_rollback` when rollback removed all retained copy sources. `reset_turn_flags` clears only per-turn transient flags and plan buffers, leaving longer-lived copy history intact.

The tests cover the two subtle invariants: `active_cell_revision` wraps safely at `u64::MAX`, and rollback to an earlier visible turn restores the correct latest copy source without falsely marking eviction.

#### Function details

##### `TranscriptState::new`  (lines 50–55)

```
fn new(active_cell: Option<Box<dyn HistoryCell>>) -> Self
```

**Purpose**: Constructs a new transcript state with an optional preexisting active cell and all other fields at their defaults. It is the standard initializer used when a chat widget is created or reset around a known active cell.

**Data flow**: Takes `Option<Box<dyn HistoryCell>>`, stores it in `active_cell`, fills all remaining fields from `Default`, and returns the new `TranscriptState` value. It does not mutate external state.

**Call relations**: Called by the widget constructor path (`new_with_op_target`) to seed transcript state, optionally preserving an already-created active cell.

*Call graph*: called by 1 (new_with_op_target); 1 external calls (default).


##### `TranscriptState::bump_active_cell_revision`  (lines 57–61)

```
fn bump_active_cell_revision(&mut self)
```

**Purpose**: Advances the active-cell revision counter with wrapping arithmetic so cache invalidation remains monotonic enough without overflow risk. It is a tiny but important invalidation primitive.

**Data flow**: Reads the current `active_cell_revision`, replaces it with `wrapping_add(1)`, and returns nothing. It mutates only the revision field.

**Call relations**: Used by higher-level chat-widget methods whenever active-cell content changes and transcript overlay caches must be invalidated.

*Call graph*: called by 1 (bump_active_cell_revision).


##### `TranscriptState::record_agent_markdown`  (lines 63–81)

```
fn record_agent_markdown(&mut self, markdown: String)
```

**Purpose**: Stores a copyable agent response for the current visible user turn, updating the latest entry in place when multiple copy sources occur in the same turn. It also maintains the bounded copy-history window.

**Data flow**: Consumes a `String` markdown payload, compares the last `agent_turn_markdowns` entry’s `user_turn_count` to `visible_user_turn_count`, and either overwrites that entry’s markdown or pushes a new `AgentTurnMarkdown`. If the vector exceeds `MAX_AGENT_COPY_HISTORY`, it removes the oldest entry. It then sets `last_agent_markdown`, clears `copy_history_evicted_by_rollback`, marks `saw_copy_source_this_turn = true`, and returns nothing.

**Call relations**: Called by the chat-widget layer when a turn produces a copyable assistant response. Its output is later consumed by completion notifications and rollback logic.

*Call graph*: called by 1 (record_agent_markdown).


##### `TranscriptState::record_visible_user_turn`  (lines 83–85)

```
fn record_visible_user_turn(&mut self)
```

**Purpose**: Advances the count of user turns currently represented in the visible transcript. This count is the key used to associate copyable agent markdown with transcript visibility.

**Data flow**: Reads `visible_user_turn_count`, increments it with `saturating_add(1)`, stores the result, and returns nothing. It mutates only that counter.

**Call relations**: Called by the widget’s copy-history bookkeeping when a new visible user turn is committed.

*Call graph*: called by 1 (record_visible_user_turn_for_copy).


##### `TranscriptState::reset_copy_history`  (lines 87–93)

```
fn reset_copy_history(&mut self)
```

**Purpose**: Clears all retained copyable agent-response history and resets visible-turn tracking. It is the full reset path for copy-source state.

**Data flow**: Sets `last_agent_markdown` to `None`, clears `agent_turn_markdowns`, resets `visible_user_turn_count` to `0`, clears `copy_history_evicted_by_rollback`, clears `saw_copy_source_this_turn`, and returns nothing.

**Call relations**: Used when transcript history is being fully reset rather than merely rolled back to an earlier visible turn.


##### `TranscriptState::truncate_copy_history_to_user_turn_count`  (lines 95–107)

```
fn truncate_copy_history_to_user_turn_count(&mut self, user_turn_count: usize)
```

**Purpose**: Rolls copy-history state back to a specified visible user-turn count. It preserves only copy sources that still correspond to visible transcript content.

**Data flow**: Takes a `user_turn_count`, stores it into `visible_user_turn_count`, remembers whether any copy history existed, retains only `agent_turn_markdowns` entries whose `user_turn_count` is at most the target, recomputes `last_agent_markdown` from the retained tail entry, sets `copy_history_evicted_by_rollback` if history existed but no retained markdown remains, clears `saw_copy_source_this_turn`, and returns nothing.

**Call relations**: Used by rollback flows to keep copy-source state aligned with the visible transcript after local thread rewinds.


##### `TranscriptState::reset_turn_flags`  (lines 109–117)

```
fn reset_turn_flags(&mut self)
```

**Purpose**: Clears transient per-turn transcript flags and plan-stream buffers without disturbing longer-lived copy history. It prepares transcript state for the start of a new agent turn.

**Data flow**: Resets `saw_copy_source_this_turn`, `saw_plan_update_this_turn`, `saw_plan_item_this_turn`, and `had_work_activity` to `false`; clears `latest_proposed_plan_markdown`; empties `plan_delta_buffer`; sets `plan_item_active = false`; and returns nothing.

**Call relations**: Called at turn start by the runtime layer so each agent turn begins with clean transient transcript flags.


##### `tests::active_cell_revision_wraps`  (lines 127–136)

```
fn active_cell_revision_wraps()
```

**Purpose**: Verifies that bumping the active-cell revision at `u64::MAX` wraps back to zero rather than panicking or saturating. This protects the cache-invalidation counter’s overflow behavior.

**Data flow**: Creates a `TranscriptState` with `active_cell_revision = u64::MAX`, calls `bump_active_cell_revision`, then asserts the field equals `0`. It writes only local test state.

**Call relations**: This unit test exercises `TranscriptState::bump_active_cell_revision` directly to lock in the intended wrapping semantics.

*Call graph*: 2 external calls (assert_eq!, default).


##### `tests::copy_history_tracks_latest_visible_turn`  (lines 139–150)

```
fn copy_history_tracks_latest_visible_turn()
```

**Purpose**: Verifies that truncating copy history to an earlier visible user turn restores the correct latest markdown and does not falsely mark eviction. It captures the rollback invariant for copy-source selection.

**Data flow**: Builds a default `TranscriptState`, records two visible user turns and two markdown entries, truncates history to turn `1`, then asserts `last_agent_markdown` is `"first"` and `copy_history_evicted_by_rollback` is false. It mutates only local test state.

**Call relations**: This test exercises the interaction among `record_visible_user_turn`, `record_agent_markdown`, and `truncate_copy_history_to_user_turn_count`.

*Call graph*: 3 external calls (assert!, assert_eq!, default).


### `tui/src/chatwidget/user_messages.rs`

`data_model` · `cross-cutting`

This file is the core user-input model layer for `ChatWidget`. It defines `UserMessage`, `QueuedUserMessage`, `ThreadComposerState`, `ThreadInputState`, `UserMessageDisplay`, and the small `PendingSteerCompareKey` used to suppress duplicate pending-steer transcript rows. The central design constraint is that the backend preserves structured chunks—text elements, local images, remote image URLs, mentions—while the transcript and composer often need a flattened prompt string plus aligned byte ranges.

Several helpers preserve that alignment during merges. `append_text_with_rebased_elements` appends text while shifting each `TextElement`’s byte range by the current output length. Placeholder remapping is more subtle: local image placeholders like `[Image #1]` and pasted-content placeholders can collide when drafts are merged after interrupts or restores. `build_placeholder_mapping`, `remap_placeholders_in_text`, `remap_colliding_paste_placeholders`, and `remap_placeholders_for_message_and_history_record` systematically rename placeholders, rewrite the visible text, and update element ranges and stored placeholder metadata so attachment order and transcript text stay consistent.

Merge helpers operate in two layers: first remap placeholders across all messages, then concatenate text with newline separators while extending image and mention lists. History-record support allows the transcript to preserve an override text projection distinct from the raw message text, and restore/display helpers consistently choose between raw and overridden forms. The `ChatWidget` methods at the bottom convert either raw parts or app-server `UserInput` items into `UserMessageDisplay`, stripping any hidden prompt-context prefix and rebasing visible text-element ranges to match what the user actually sees.

#### Function details

##### `QueuedUserMessage::new`  (lines 67–73)

```
fn new(user_message: UserMessage, action: QueuedInputAction) -> Self
```

**Purpose**: Constructs a queued user message from a `UserMessage` and a queued-input action, starting with no pending pasted-content placeholders. It is the canonical initializer for queued submissions.

**Data flow**: Takes a `UserMessage` and `QueuedInputAction`, stores them in a new `QueuedUserMessage`, initializes `pending_pastes` to an empty vector, and returns the struct.

**Call relations**: Used directly and indirectly through `From<UserMessage>` whenever the widget needs to enqueue a user message for later submission.

*Call graph*: 1 external calls (new).


##### `QueuedUserMessage::into_user_message`  (lines 75–77)

```
fn into_user_message(self) -> UserMessage
```

**Purpose**: Consumes a queued user message and returns the underlying `UserMessage`, discarding queue-specific metadata. It is the unwrap operation for queued messages.

**Data flow**: Takes ownership of `self`, moves out `self.user_message`, and returns it. No external state is mutated.

**Call relations**: Used by queue-draining code when only the message payload is needed and the queued action/paste metadata are no longer relevant.


##### `QueuedUserMessage::from`  (lines 81–83)

```
fn from(user_message: UserMessage) -> Self
```

**Purpose**: Converts a plain `UserMessage` into a queued message with the default plain queued-input action. It is the ergonomic adapter used by queueing code.

**Data flow**: Takes a `UserMessage`, calls `QueuedUserMessage::new(user_message, QueuedInputAction::Plain)`, and returns the resulting `QueuedUserMessage`.

**Call relations**: Called by queue-management flows such as `pop_next_queued_user_message` and `submit_user_message_with_history_and_shell_escape_policy` when a plain message needs to enter the queued-message pipeline.

*Call graph*: called by 2 (pop_next_queued_user_message, submit_user_message_with_history_and_shell_escape_policy); 1 external calls (new).


##### `QueuedUserMessage::deref`  (lines 89–91)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Provides shared-reference deref access from `QueuedUserMessage` to its inner `UserMessage`. This lets queued messages be read like plain messages in many contexts.

**Data flow**: Takes `&self` and returns `&self.user_message` as `&UserMessage`. It does not mutate state.

**Call relations**: Used implicitly by Rust deref coercions wherever queued messages are inspected through the `UserMessage` interface.


##### `ThreadComposerState::has_content`  (lines 111–118)

```
fn has_content(&self) -> bool
```

**Purpose**: Reports whether the composer contains any meaningful draft content across text, images, mentions, text elements, or pending pastes. It is broader than checking plain text alone.

**Data flow**: Reads all composer fields and returns true if any of `text`, `local_images`, `remote_image_urls`, `text_elements`, `mention_bindings`, or `pending_pastes` are nonempty; otherwise returns false.

**Call relations**: Used by composer and restore logic to decide whether there is draft state worth preserving or showing.


##### `UserMessage::from`  (lines 152–161)

```
fn from(text: &str) -> Self
```

**Purpose**: Converts a `String` into a plain-text `UserMessage` with no images, text elements, or mention bindings. It is the owned-string constructor for simple prompts.

**Data flow**: Takes a `String`, stores it as `text`, initializes `local_images`, `remote_image_urls`, `text_elements`, and `mention_bindings` as empty vectors, and returns the new `UserMessage`.

**Call relations**: Used widely by tests and input-reset/restore flows whenever a simple text-only user message is needed.

*Call graph*: called by 22 (side_restore_user_message_puts_inline_question_back_in_composer, clear_resets_all_input_queues, preview_keeps_queue_categories_separate, alt_up_edits_most_recent_queued_message, interrupt_prepends_queued_messages_before_existing_composer_text, interrupt_restores_queued_messages_into_composer, output_free_interrupted_turn_requests_prompt_restore, patch_activity_prevents_cancelled_turn_prompt_restore, thinking_status_keeps_cancelled_turn_prompt_restore_eligible, unbound_queued_message_edit_does_not_fall_back_to_alt_up (+12 more)); 1 external calls (new).


##### `create_initial_user_message`  (lines 171–196)

```
fn create_initial_user_message(
    text: Option<String>,
    local_image_paths: Vec<PathBuf>,
    text_elements: Vec<TextElement>,
) -> Option<UserMessage>
```

**Purpose**: Builds an optional initial `UserMessage` from startup text, local image paths, and text elements, returning `None` when there is no actual content. It is the constructor used for prefilled initial prompts.

**Data flow**: Takes optional text, a vector of local image `PathBuf`s, and text elements. It normalizes missing text to empty, returns `None` if both text and image paths are empty, otherwise enumerates image paths into `LocalImageAttachment`s with placeholders from `local_image_label_text`, and returns `Some(UserMessage)` containing the text, generated local images, provided text elements, and empty remote-image/mention vectors.

**Call relations**: Used when initializing the composer or thread from externally supplied starting content.

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

**Purpose**: Appends text to an output buffer while rebasing each appended `TextElement`’s byte range to the new combined string. It is the primitive that keeps structured text-element ranges aligned during concatenation.

**Data flow**: Takes mutable references to a target `String` and target `Vec<TextElement>`, plus source text and iterable text elements. It records the current target length as an offset, appends the text, then extends the target elements with copies whose `byte_range.start` and `byte_range.end` are each increased by that offset. It returns nothing.

**Call relations**: Called by `merge_remapped_user_messages` and `ChatWidget::user_message_display_from_inputs` whenever multiple text segments must be flattened into one visible message without losing element alignment.

*Call graph*: called by 2 (user_message_display_from_inputs, merge_remapped_user_messages); 1 external calls (into_iter).


##### `app_server_text_elements`  (lines 213–215)

```
fn app_server_text_elements(elements: &[TextElement]) -> Vec<AppServerTextElement>
```

**Purpose**: Converts internal `TextElement` values into the app-server protocol’s `TextElement` type. It is the outbound adapter for structured text metadata.

**Data flow**: Takes a slice of internal `TextElement`, clones each element, converts each via `Into`, collects them into a `Vec<AppServerTextElement>`, and returns that vector.

**Call relations**: Used by outbound request-building code when a `UserMessage` must be serialized into app-server protocol structures.

*Call graph*: 1 external calls (iter).


##### `build_placeholder_mapping`  (lines 217–233)

```
fn build_placeholder_mapping(
    local_images: Vec<LocalImageAttachment>,
    next_label: &mut usize,
) -> (HashMap<String, String>, Vec<LocalImageAttachment>)
```

**Purpose**: Assigns fresh sequential placeholders to a batch of local image attachments and returns both the old-to-new mapping and the remapped attachments. It is the first step in avoiding placeholder collisions across merged drafts.

**Data flow**: Consumes a vector of `LocalImageAttachment` and a mutable `next_label` counter. For each attachment it generates a new placeholder via `local_image_label_text(*next_label)`, increments the counter, records the old-to-new mapping, and pushes a remapped attachment with the new placeholder and original path. It returns `(HashMap<String, String>, Vec<LocalImageAttachment>)`.

**Call relations**: Called by `remap_placeholders_for_message_and_history_record` before rewriting message text and history overrides to match the new attachment labels.

*Call graph*: calls 1 internal fn (local_image_label_text); called by 1 (remap_placeholders_for_message_and_history_record); 2 external calls (new, new).


##### `remap_placeholders_in_text`  (lines 235–280)

```
fn remap_placeholders_in_text(
    text: String,
    text_elements: Vec<TextElement>,
    mapping: &HashMap<String, String>,
) -> (String, Vec<TextElement>)
```

**Purpose**: Rewrites placeholder-bearing text and text elements according to a provided mapping, preserving element ordering and updating byte ranges to match the rebuilt string. It is the core text-level placeholder remapper.

**Data flow**: Takes owned `text`, owned `Vec<TextElement>`, and a placeholder mapping. If the mapping is empty it returns the inputs unchanged. Otherwise it sorts elements by start offset, walks the original text from left to right, copies untouched segments, replaces each element’s covered text with either the mapped placeholder or the original substring, updates the element’s stored placeholder when remapped, rewrites its byte range to the rebuilt string’s offsets, appends trailing text, and returns the rebuilt `(String, Vec<TextElement>)`.

**Call relations**: Used by both `remap_colliding_paste_placeholders` and `remap_placeholders_for_message_and_history_record` to keep visible text and structured element metadata synchronized after placeholder renaming.

*Call graph*: called by 2 (remap_colliding_paste_placeholders, remap_placeholders_for_message_and_history_record); 2 external calls (new, new).


##### `remap_colliding_paste_placeholders`  (lines 282–308)

```
fn remap_colliding_paste_placeholders(
    mut message: UserMessage,
    mut pending_pastes: Vec<(String, String)>,
    used: &mut HashSet<String>,
) -> (UserMessage, Vec<(String, String)>)
```

**Purpose**: Renames pasted-content placeholders that would collide with already-used placeholders, then rewrites the message text and text elements to match. It prevents ambiguous pasted-content labels after draft restoration or merging.

**Data flow**: Takes a `UserMessage`, a vector of `(placeholder, text)` pending pastes, and a mutable `HashSet<String>` of already-used placeholders. It scans pending pastes, leaving unique placeholders unchanged and generating suffixed replacements like `[Pasted Content N chars] #2` for collisions, records the mapping, rewrites `message.text` and `message.text_elements` through `remap_placeholders_in_text`, and returns the updated `(UserMessage, Vec<(String, String)>)`.

**Call relations**: Called by `drain_pending_messages_for_restore` when restoring multiple drafts that may contain duplicate pasted-content placeholders.

*Call graph*: calls 1 internal fn (remap_placeholders_in_text); called by 1 (drain_pending_messages_for_restore); 2 external calls (new, format!).


##### `remap_placeholders_for_message_and_history_record`  (lines 315–351)

```
fn remap_placeholders_for_message_and_history_record(
    message: UserMessage,
    history_record: UserMessageHistoryRecord,
    next_label: &mut usize,
) -> (UserMessage, UserMessageHistoryRecord)
```

**Purpose**: Remaps local-image placeholders consistently across both a `UserMessage` and its associated history-record override text. This keeps restored drafts and transcript rows aligned after merges or interrupts.

**Data flow**: Consumes a `UserMessage`, a `UserMessageHistoryRecord`, and a mutable `next_label` counter. It destructures the message, builds a placeholder mapping and remapped local images, rewrites the message text/text elements with that mapping, and if the history record is a nonempty `Override`, rewrites the override text/text elements too. It returns the remapped `(UserMessage, UserMessageHistoryRecord)` pair.

**Call relations**: Called by `remap_user_messages_with_history_records` and the test-only `remap_placeholders_for_message` helper to ensure message payloads and transcript-history projections stay in sync.

*Call graph*: calls 2 internal fn (build_placeholder_mapping, remap_placeholders_in_text); called by 1 (remap_placeholders_for_message); 1 external calls (Override).


##### `remap_placeholders_for_message`  (lines 354–364)

```
fn remap_placeholders_for_message(
    message: UserMessage,
    next_label: &mut usize,
) -> UserMessage
```

**Purpose**: Test-visible helper that remaps placeholders for a message alone, using the default history-record mode. It exposes the shared remapping logic without requiring callers to construct a history record.

**Data flow**: Takes a `UserMessage` and mutable `next_label`, calls `remap_placeholders_for_message_and_history_record` with `UserMessageHistoryRecord::UserMessageText`, and returns only the remapped `UserMessage`.

**Call relations**: Used in tests to exercise placeholder remapping behavior through the same implementation used by production merge paths.

*Call graph*: calls 1 internal fn (remap_placeholders_for_message_and_history_record).


##### `remap_user_messages_with_history_records`  (lines 366–384)

```
fn remap_user_messages_with_history_records(
    messages: Vec<(UserMessage, UserMessageHistoryRecord)>,
) -> Vec<(UserMessage, UserMessageHistoryRecord)>
```

**Purpose**: Applies consistent placeholder remapping across a whole sequence of messages and history records before they are merged. It starts local-image numbering after any remote images already present.

**Data flow**: Consumes a vector of `(UserMessage, UserMessageHistoryRecord)` pairs, sums all `remote_image_urls.len()` values to compute `total_remote_images`, initializes `next_image_label = total_remote_images + 1`, remaps each pair through `remap_placeholders_for_message_and_history_record`, collects the results, and returns the remapped vector.

**Call relations**: Called by both `merge_user_messages` and `merge_user_messages_with_history_record` so all merge paths share the same placeholder-renumbering policy.

*Call graph*: called by 2 (merge_user_messages, merge_user_messages_with_history_record).


##### `merge_user_messages`  (lines 386–394)

```
fn merge_user_messages(messages: Vec<UserMessage>) -> UserMessage
```

**Purpose**: Merges multiple `UserMessage` values into one combined message, first remapping placeholders to avoid collisions. It is the plain-message merge path when no separate history overrides are involved.

**Data flow**: Takes a vector of `UserMessage`, wraps each in a `(message, UserMessageHistoryRecord::UserMessageText)` pair, remaps placeholders across the set, discards the history records, merges the remapped messages with newline-separated text concatenation and concatenated attachment/mention lists, and returns the combined `UserMessage`.

**Call relations**: Used by higher-level queue/interruption flows that need to collapse multiple pending user messages into one outbound message.

*Call graph*: calls 2 internal fn (merge_remapped_user_messages, remap_user_messages_with_history_records).


##### `merge_remapped_user_messages`  (lines 396–428)

```
fn merge_remapped_user_messages(messages: impl IntoIterator<Item = UserMessage>) -> UserMessage
```

**Purpose**: Concatenates already-remapped user messages into a single `UserMessage`, preserving text-element alignment and attachment ordering. It assumes placeholder collisions have already been resolved.

**Data flow**: Takes an iterator of `UserMessage`, initializes an empty combined message, then for each message appends a newline before all but the first, appends text and rebased text elements via `append_text_with_rebased_elements`, and extends local images, remote image URLs, and mention bindings. It returns the combined `UserMessage`.

**Call relations**: Called by `merge_user_messages` and `merge_user_messages_with_history_record` after placeholder remapping has been completed.

*Call graph*: calls 1 internal fn (append_text_with_rebased_elements); called by 2 (merge_user_messages, merge_user_messages_with_history_record); 3 external calls (into_iter, new, new).


##### `user_message_for_restore`  (lines 430–444)

```
fn user_message_for_restore(
    message: UserMessage,
    history_record: &UserMessageHistoryRecord,
) -> UserMessage
```

**Purpose**: Chooses the correct `UserMessage` representation to restore into the composer, honoring any nonempty history override text. It lets transcript-visible text differ from the raw stored message when needed.

**Data flow**: Consumes a `UserMessage` and a `&UserMessageHistoryRecord`. If the record is `Override` with nonempty text, it returns a new `UserMessage` using the override text and text elements while preserving the original message’s other fields; otherwise it returns the original message unchanged.

**Call relations**: Called by `user_message_display_for_history` and other restore/display flows that need the transcript-facing version of a message.

*Call graph*: called by 1 (user_message_display_for_history).


##### `user_message_preview_text`  (lines 446–458)

```
fn user_message_preview_text(
    message: &UserMessage,
    history_record: Option<&UserMessageHistoryRecord>,
) -> String
```

**Purpose**: Returns the text that should be shown when previewing a user message, preferring a nonempty history override when present. It is the text-only counterpart to full restore/display projection.

**Data flow**: Takes `&UserMessage` and optional `&UserMessageHistoryRecord`. If the record is a nonempty `Override`, it returns the override text clone; otherwise it returns `message.text.clone()`. It does not mutate state.

**Call relations**: Used by preview surfaces that only need the visible text, not the full display structure with images and text elements.


##### `user_message_display_for_history`  (lines 460–475)

```
fn user_message_display_for_history(
    message: UserMessage,
    history_record: &UserMessageHistoryRecord,
) -> UserMessageDisplay
```

**Purpose**: Builds the transcript-display projection for a user message, applying any history override and converting attachments into the display struct expected by history rendering. It is the main adapter from stored message state to transcript row content.

**Data flow**: Consumes a `UserMessage` and `&UserMessageHistoryRecord`, first transforms the message through `user_message_for_restore`, then calls `ChatWidget::user_message_display_from_parts` with the resulting text, text elements, local image paths, and remote image URLs. It returns a `UserMessageDisplay`.

**Call relations**: Called by `on_committed_user_message` when rendering a committed user message into transcript history.

*Call graph*: calls 1 internal fn (user_message_for_restore); called by 1 (on_committed_user_message); 1 external calls (user_message_display_from_parts).


##### `merge_user_messages_with_history_record`  (lines 477–524)

```
fn merge_user_messages_with_history_record(
    messages: Vec<(UserMessage, UserMessageHistoryRecord)>,
) -> (UserMessage, UserMessageHistoryRecord)
```

**Purpose**: Merges multiple user messages while also producing a merged history-record projection that preserves any override text. It is the full-fidelity merge path used when transcript-visible text may differ from raw message text.

**Data flow**: Consumes a vector of `(UserMessage, UserMessageHistoryRecord)` pairs, remaps placeholders across them, then computes the merged history record: if all records are `UserMessageText`, it returns that marker; otherwise it concatenates either override text or fallback message text segment by segment with newline separators, rebasing text elements as it goes, and wraps the result in `UserMessageHistoryRecord::Override`. It then merges the remapped messages themselves via `merge_remapped_user_messages` and returns `(merged_message, merged_history_record)`.

**Call relations**: Used by higher-level restore/interrupt flows that need both a merged outbound message and a transcript/history projection that preserves prior overrides.

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

**Purpose**: Builds a `UserMessageDisplay` from raw message parts, stripping any hidden prompt-context prefix and rebasing text-element ranges to the visible request text. It ensures transcript and UI surfaces show only the user-visible portion of the prompt.

**Data flow**: Takes owned `message`, `text_elements`, local image paths, and remote image URLs. It calls `extract_prompt_request_with_offset` to split out the visible request and its byte offset within the raw message, computes the visible range end, filters text elements to those fully inside the visible request, shifts their byte ranges left by the prompt-request offset, and returns `UserMessageDisplay { message: visible_request, remote_image_urls, local_images, text_elements }`.

**Call relations**: Called by `user_message_display_for_history` and `ChatWidget::user_message_display_from_inputs` to produce the final display projection used by transcript and related UI surfaces.

*Call graph*: 1 external calls (extract_prompt_request_with_offset).


##### `ChatWidget::pending_steer_compare_key_from_items`  (lines 581–599)

```
fn pending_steer_compare_key_from_items(
        items: &[UserInput],
    ) -> PendingSteerCompareKey
```

**Purpose**: Builds the lightweight compare key used to match pending steers against committed app-server user-message items without full request serialization. It intentionally tracks only flattened text and total image count.

**Data flow**: Takes a slice of `UserInput`, initializes empty `message` and `image_count`, then iterates items: appending text for `UserInput::Text`, incrementing `image_count` for `Image` and `LocalImage`, and ignoring `Skill` and `Mention`. It returns `PendingSteerCompareKey { message, image_count }`.

**Call relations**: Used by pending-steer suppression logic to cheaply compare queued steer submissions with later committed user-message items.

*Call graph*: 1 external calls (new).


##### `ChatWidget::user_message_display_from_inputs`  (lines 601–640)

```
fn user_message_display_from_inputs(items: &[UserInput]) -> UserMessageDisplay
```

**Purpose**: Converts structured app-server `UserInput` items into the flattened `UserMessageDisplay` used by transcript rendering. It reconstructs visible text, images, and text-element placeholders from protocol chunks.

**Data flow**: Takes a slice of `UserInput`, initializes empty message/image/text-element accumulators, then iterates items. For `Text`, it appends text and rebased internal `TextElement`s converted from protocol elements, preserving placeholders when available or deriving them from the covered substring. For `Image`, it collects remote URLs; for `LocalImage`, local paths; `Skill` and `Mention` are ignored for display. Finally it passes the accumulated parts to `user_message_display_from_parts` and returns the resulting `UserMessageDisplay`.

**Call relations**: Used when transcript rendering starts from app-server input items rather than an already-built `UserMessage`. It relies on `append_text_with_rebased_elements` and then delegates final visible-range stripping to `ChatWidget::user_message_display_from_parts`.

*Call graph*: calls 1 internal fn (append_text_with_rebased_elements); 3 external calls (user_message_display_from_parts, new, new).


### `tui/src/chatwidget/command_lifecycle.rs`

`domain_logic` · `request handling`

This file is the command-lifecycle renderer for `ChatWidget`. It receives `ThreadItem::CommandExecution` events and decides whether to update transient UI state, mutate the active transcript cell, or emit finalized history cells through `AppEvent::InsertHistoryCell`. A central distinction is between ordinary command executions and unified-exec sources (`UnifiedExecStartup` / `UnifiedExecInteraction`). Unified exec commands are tracked in `self.unified_exec_processes` by process key so the bottom pane can show a footer of active commands and recent output, while terminal polling with empty stdin is coalesced into `self.unified_exec_wait_streak` instead of spamming transcript rows.

The start path parses command text and actions, ensures the status indicator is visible, records `RunningCommand` metadata in `self.running_commands`, and either appends the call into the current `ExecCell` group or creates a new active exec cell. Duplicate unified wait interactions are suppressed via `self.last_unified_wait` and `self.suppressed_exec_calls`. Streaming output updates both the unified footer cache and the active `ExecCell` if one is present.

Completion is careful about grouping invariants: if the active exec cell tracks the call id, it completes in place; if another exec group is active, the finished call is rendered as an orphan finalized history cell; otherwise a new cell is built from the completion payload. Unified-exec interaction completions intentionally blank command output in the exec cell because that content is surfaced elsewhere. User-shell completions additionally trigger queued input dispatch.

#### Function details

##### `ChatWidget::flush_unified_exec_wait_streak`  (lines 9–18)

```
fn flush_unified_exec_wait_streak(&mut self)
```

**Purpose**: Finalizes the currently accumulated unified-exec waiting streak into a single history interaction row. It converts repeated background-terminal polling for one process into one transcript entry and restores the normal reasoning/status header afterward.

**Data flow**: Reads `self.unified_exec_wait_streak`; if it is `None`, returns immediately. Otherwise takes ownership of the streak, marks `self.transcript.needs_final_message_separator = true`, builds a history cell with `history_cell::new_unified_exec_interaction(wait.command_display, String::new())`, sends it through `self.app_event_tx` as `AppEvent::InsertHistoryCell`, and then calls `restore_reasoning_status_header()` to reset the status surface.

**Call relations**: This is reached from terminal-interaction and command-completion paths when a pending wait streak must be materialized before switching processes or ending the process entirely. It does not recurse into command handling; its job is to flush deferred wait UI into durable history at the exact boundary where the streak should stop.

*Call graph*: called by 2 (on_command_execution_completed, on_terminal_interaction); 4 external calls (new, new, InsertHistoryCell, new_unified_exec_interaction).


##### `ChatWidget::on_command_execution_started`  (lines 20–52)

```
fn on_command_execution_started(&mut self, item: ThreadItem)
```

**Purpose**: Processes an incoming command-start event, with extra filtering and bookkeeping for unified-exec commands before handing off to the immediate or deferred renderer. It decides whether the event should affect the transcript at all when the task UI is not active or when the parsed command is not a standard tool call.

**Data flow**: Consumes a `ThreadItem`; if it is not `ThreadItem::CommandExecution`, returns. Extracts `id`, `command`, `process_id`, `source`, and `command_actions`, derives parsed command data via `command_execution_command_and_parsed`, flushes any answer stream separator, and for unified-exec sources may record process start in `self.unified_exec_processes`, ensure the bottom-pane status indicator, and early-return when the task is not running or the parsed command is non-standard. It clones the item and passes one copy into the deferred queue closure and one into the immediate handler closure.

**Call relations**: This is the public event entry for command starts. For unified startup commands it delegates to `track_unified_exec_process_begin` before any transcript rendering. After filtering, it routes through `defer_or_handle`, which either queues the start event or invokes `ChatWidget::handle_command_execution_started_now` immediately depending on broader widget state.

*Call graph*: calls 1 internal fn (track_unified_exec_process_begin); 1 external calls (clone).


##### `ChatWidget::on_exec_command_output_delta`  (lines 54–73)

```
fn on_exec_command_output_delta(&mut self, call_id: &str, delta: &str)
```

**Purpose**: Applies a streamed stdout/stderr delta to both unified-exec footer state and the currently active `ExecCell`, if one exists. It only redraws when appending the delta actually changes the visible exec cell.

**Data flow**: Takes `call_id` and `delta`, first forwarding the bytes to `track_unified_exec_output_chunk` to update recent footer lines. If `self.bottom_pane.is_task_running()` is false, returns. Otherwise it looks up `self.transcript.active_cell`, downcasts it to `ExecCell`, and calls `append_output(call_id, delta)`. When that returns true, it bumps the active-cell revision and requests a redraw.

**Call relations**: This is the streaming-output counterpart to command start/completion. It always updates unified-exec process summaries first, then conditionally updates the active transcript cell only while the task pane is active and the active cell is an exec cell.

*Call graph*: calls 1 internal fn (track_unified_exec_output_chunk).


##### `ChatWidget::on_terminal_interaction`  (lines 75–132)

```
fn on_terminal_interaction(&mut self, process_id: String, stdin: String)
```

**Purpose**: Handles terminal interaction events associated with unified exec, distinguishing between empty-stdin background polling and actual stdin text entered or surfaced for a process. Empty stdin updates a single waiting status surface; non-empty stdin becomes a transcript interaction row.

**Data flow**: Accepts a `process_id` and `stdin`. If no task is running, returns. It looks up the matching process in `self.unified_exec_processes` to derive an optional `command_display`; if both stdin is empty and no command display is known, it returns. It flushes answer-stream separators, then for empty stdin ensures the status indicator, shows the interrupt hint, sets `self.status_state.terminal_title_status_kind` to `WaitingForBackgroundTerminal`, updates the status text, and mutates `self.unified_exec_wait_streak` by updating the current streak, flushing and replacing it when the process changes, or creating a new streak. For non-empty stdin, it flushes a matching wait streak if present and appends a `new_unified_exec_interaction(command_display, stdin)` history cell.

**Call relations**: This method is invoked when terminal-side interaction arrives during unified exec. It calls `flush_unified_exec_wait_streak` only at process boundaries or before rendering real interaction input, so repeated empty polls stay collapsed until a meaningful transition occurs.

*Call graph*: calls 2 internal fn (flush_unified_exec_wait_streak, new); 1 external calls (new_unified_exec_interaction).


##### `ChatWidget::on_command_execution_completed`  (lines 134–163)

```
fn on_command_execution_completed(&mut self, item: ThreadItem)
```

**Purpose**: Processes a command-end event, cleaning up unified-exec wait/process tracking before routing the completion into the deferred or immediate exec-cell finalizer. It prevents stale unified footer and waiting state from surviving after process termination.

**Data flow**: Consumes a `ThreadItem`; if it is not a command execution, returns. For unified-exec sources, it checks whether the ending `process_id` matches the current `self.unified_exec_wait_streak` and flushes that streak if so, removes the process from `self.unified_exec_processes` via `track_unified_exec_process_end`, and returns early if the task pane is no longer running. It clones the item and passes it into `defer_or_handle` for queued or immediate completion handling.

**Call relations**: This is the public completion entrypoint paired with `on_command_execution_started`. It performs unified-exec cleanup first, then hands off to `ChatWidget::handle_command_execution_completed_now`, which performs the actual transcript/history mutation.

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

**Purpose**: Registers or refreshes a unified-exec process summary used by the bottom-pane footer. It normalizes the process key and command display so later output chunks and terminal interactions can be associated with the right process.

**Data flow**: Takes `call_id`, optional `process_id`, and raw `command`. It chooses a stable key from `process_id.unwrap_or(call_id)`, splits the command string, strips shell-wrapper noise for display, then searches `self.unified_exec_processes` for an existing entry with that key. If found, it updates `call_id`, replaces `command_display`, and clears `recent_chunks`; otherwise it pushes a new `UnifiedExecProcessSummary`. Finally it synchronizes the footer list into the bottom pane.

**Call relations**: Called only from the command-start path for unified startup commands. Its sole downstream action is `sync_unified_exec_footer`, which propagates the updated process list into the bottom-pane UI.

*Call graph*: calls 1 internal fn (sync_unified_exec_footer); called by 1 (on_command_execution_started); 1 external calls (new).


##### `ChatWidget::track_unified_exec_process_end`  (lines 193–205)

```
fn track_unified_exec_process_end(
        &mut self,
        call_id: &str,
        process_id: Option<&str>,
    )
```

**Purpose**: Removes a unified-exec process summary when the process finishes and refreshes the footer only if the tracked set actually changed. This keeps the bottom-pane process list aligned with active unified-exec work.

**Data flow**: Accepts `call_id` and optional `process_id`, derives the same keying rule used at process start, records the vector length before removal, retains only entries whose `key` differs, and if the length changed calls `sync_unified_exec_footer()`.

**Call relations**: Reached from the command-completion entry path after any pending wait streak is flushed. It is the symmetric cleanup step for `track_unified_exec_process_begin`.

*Call graph*: calls 1 internal fn (sync_unified_exec_footer); called by 1 (on_command_execution_completed).


##### `ChatWidget::sync_unified_exec_footer`  (lines 207–214)

```
fn sync_unified_exec_footer(&mut self)
```

**Purpose**: Projects the current unified-exec process summaries into the bottom-pane footer model. It exposes only the command display strings, not the full process metadata.

**Data flow**: Reads `self.unified_exec_processes`, clones each `command_display` into a collection, and passes that collection to `self.bottom_pane.set_unified_exec_processes(processes)`.

**Call relations**: This is a small synchronization helper used after unified-exec process insertion or removal. It has no branching logic of its own; it is the final UI propagation step for process-summary changes.

*Call graph*: called by 2 (track_unified_exec_process_begin, track_unified_exec_process_end).


##### `ChatWidget::track_unified_exec_output_chunk`  (lines 217–240)

```
fn track_unified_exec_output_chunk(&mut self, call_id: &str, chunk: &[u8])
```

**Purpose**: Caches the most recent non-empty output lines for a unified-exec process so the footer can show a short rolling summary. It trims trailing whitespace and caps retained lines to the last three.

**Data flow**: Takes a `call_id` and raw byte `chunk`, finds the matching `UnifiedExecProcessSummary` by `call_id`, and returns if none exists. It decodes bytes with `String::from_utf8_lossy`, iterates over `.lines()`, trims line endings, filters out empty lines, and pushes each remaining line into `process.recent_chunks`. If the vector exceeds `MAX_RECENT_CHUNKS` (3), it drains the oldest entries from the front.

**Call relations**: Called from `on_exec_command_output_delta` before any active-cell update. It is intentionally footer-focused bookkeeping and does not itself trigger redraws or transcript mutations.

*Call graph*: called by 1 (on_exec_command_output_delta); 1 external calls (from_utf8_lossy).


##### `ChatWidget::handle_command_execution_started_now`  (lines 242–313)

```
fn handle_command_execution_started_now(&mut self, item: ThreadItem)
```

**Purpose**: Immediately materializes a command-start event into widget state and the active exec transcript cell. It records the running command, suppresses duplicate unified wait interactions, and preserves exec-cell grouping when multiple calls belong together.

**Data flow**: Consumes a `ThreadItem::CommandExecution`, records visible turn activity, parses command text/actions, ensures the bottom-pane status indicator, annotates parsed commands, and inserts a `RunningCommand` into `self.running_commands` keyed by call id. It computes whether the source is `UnifiedExecInteraction`, updates `self.last_unified_wait`, and if the interaction duplicates the previous wait command inserts the id into `self.suppressed_exec_calls` and returns. Otherwise it tries to downcast `self.transcript.active_cell` to `ExecCell` and extend it with `with_added_call`; if that succeeds it replaces the cell in place, else it flushes the current active cell and creates a fresh exec cell with `new_active_exec_command`. In both rendering cases it bumps the active-cell revision and requests redraw.

**Call relations**: This is the immediate branch target of `on_command_execution_started` after `defer_or_handle` decides not to queue the event. It depends on the helper parsing and wait-state logic established elsewhere in the file and sets up state later consumed by `handle_command_execution_completed_now`.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, matches!).


##### `ChatWidget::handle_command_execution_completed_now`  (lines 323–458)

```
fn handle_command_execution_completed_now(&mut self, item: ThreadItem)
```

**Purpose**: Immediately finalizes a command execution while preserving the invariant that unrelated exec groups must not be merged into the active `ExecCell`. It reconstructs missing start-state when necessary, suppresses hidden unified-wait calls, and chooses between completing the active cell, emitting an orphan history cell, or creating a new cell from the end payload.

**Data flow**: Consumes a `ThreadItem::CommandExecution`, extracts end-event fields, converts command text/actions into fallback parsed data, computes `Duration` from `duration_ms`, defaults missing `exit_code` and `aggregated_output`, and removes any matching `RunningCommand` from `self.running_commands`. If the id is in `self.suppressed_exec_calls`, it returns early. Otherwise it chooses command/parsed/source from the running-state record when available, annotates parsed commands, detects unified-exec interaction and user-shell sources, and inspects `self.transcript.active_cell` to classify the end target as `ActiveTracked`, `OrphanHistoryWhileActiveExec`, or `NewCell`. It builds a `CommandOutput`, blanking formatted and aggregated output for unified-exec interactions. For `ActiveTracked`, it completes the call inside the active `ExecCell` and either flushes or redraws. For `OrphanHistoryWhileActiveExec`, it creates a standalone exec cell, completes it, marks a separator, and sends it as `InsertHistoryCell`. For `NewCell`, it flushes any active cell, creates and completes a new exec cell, then either adds it directly to history or installs it as the active cell depending on `should_flush()`. Finally it marks `self.transcript.had_work_activity = true` and, for `UserShell`, calls `maybe_send_next_queued_input()`.

**Call relations**: This is the immediate completion handler reached from `on_command_execution_completed` through `defer_or_handle`. It consumes the running-command state created by `handle_command_execution_started_now`, respects suppression decisions made there, and is the file's main enforcement point for exec-cell grouping correctness.

*Call graph*: 6 external calls (new, from_millis, new, InsertHistoryCell, debug_assert!, matches!).


### `tui/src/chatwidget/hook_lifecycle.rs`

`domain_logic` · `request handling`

This file groups all hook-run lifecycle behavior for `ChatWidget`. Hook output is managed separately from normal transcript cells through `self.active_hook_cell`, which can contain running hook rows, completed persistent runs waiting to be flushed, or become empty once all visible hook activity is done. The methods here carefully distinguish between dropping transient state and persisting completed output.

`on_hook_started` records visible activity, flushes any answer stream separator and previously completed hook output, then either appends the new run to the existing hook cell or creates a fresh active hook cell. `on_hook_completed` first tries to complete an existing run in the active cell; if that fails, it either appends the completed run as a persistent completed entry or creates a standalone completed hook cell. Afterward it flushes any completed persistent runs and, if the remaining active hook cell is idle or flushable, moves it into history.

`flush_completed_hook_output` extracts completed persistent runs from the active hook cell, inserts them into history via `AppEvent::InsertHistoryCell`, and requests pending usage output insertion. `finish_active_hook_cell_if_idle` handles the final transition of an empty or fully flushable hook cell. `update_due_hook_visibility` advances time-based hook visibility using `Instant::now`, and `schedule_hook_timer_if_needed` requests future frames both for animation (50 ms cadence while a visible run is active) and for the next explicit hook timer deadline.

#### Function details

##### `ChatWidget::clear_active_hook_cell`  (lines 10–15)

```
fn clear_active_hook_cell(&mut self)
```

**Purpose**: Drops the transient active hook cell without writing it into history. It is used when live hook status should disappear rather than persist.

**Data flow**: Calls `self.active_hook_cell.take()` and, if it removed a cell, bumps the active-cell revision and requests pending usage output insertion.

**Call relations**: This is a local cleanup helper for transient hook UI. Unlike the flush paths, it intentionally does not emit `InsertHistoryCell`.


##### `ChatWidget::on_hook_started`  (lines 17–35)

```
fn on_hook_started(&mut self, run: codex_app_server_protocol::HookRunSummary)
```

**Purpose**: Begins rendering a hook run in the active hook cell, creating the cell if necessary and flushing any previously completed hook output first. It ensures hook activity becomes visible immediately.

**Data flow**: Takes a `HookRunSummary`, records visible turn activity, flushes answer-stream separators, calls `flush_completed_hook_output()`, then matches `self.active_hook_cell.as_mut()`. If a cell exists, it calls `cell.start_run(run)` and bumps the revision; otherwise it creates a new active hook cell with `history_cell::new_active_hook_cell(run, self.config.animations)`, stores it, and bumps the revision. It then requests redraw.

**Call relations**: This is the hook-start event handler. It delegates completed-output persistence to `flush_completed_hook_output` before mutating the active hook cell.

*Call graph*: calls 1 internal fn (flush_completed_hook_output); 1 external calls (new_active_hook_cell).


##### `ChatWidget::on_hook_completed`  (lines 37–67)

```
fn on_hook_completed(
        &mut self,
        completed: codex_app_server_protocol::HookRunSummary,
    )
```

**Purpose**: Marks a hook run complete, either by completing an existing active run or by adding/creating completed hook output, then flushes and finalizes hook UI as needed. It is the main completion path for hook lifecycle events.

**Data flow**: Accepts a completed `HookRunSummary`. It first tries `self.active_hook_cell.as_mut().map(|cell| cell.complete_run(completed.clone())).unwrap_or(false)`. If that succeeds, it bumps the revision. Otherwise, if an active cell exists it calls `cell.add_completed_run(completed)` and bumps the revision; if no cell exists it creates `history_cell::new_completed_hook_cell(completed, self.config.animations)` and installs it as `self.active_hook_cell` only when the new cell is non-empty. It then calls `flush_completed_hook_output()`, `finish_active_hook_cell_if_idle()`, and requests redraw.

**Call relations**: This is the hook-completion counterpart to `on_hook_started`. It relies on `flush_completed_hook_output` to persist completed runs and on `finish_active_hook_cell_if_idle` to remove or flush any remaining active hook cell.

*Call graph*: calls 2 internal fn (finish_active_hook_cell_if_idle, flush_completed_hook_output); 1 external calls (new_completed_hook_cell).


##### `ChatWidget::flush_completed_hook_output`  (lines 69–89)

```
fn flush_completed_hook_output(&mut self)
```

**Purpose**: Extracts completed persistent hook runs from the active hook cell and inserts them into transcript history. It also clears the active hook cell entirely if nothing remains visible afterward.

**Data flow**: Attempts to call `HookCell::take_completed_persistent_runs` on `self.active_hook_cell.as_mut()`; if that yields `None`, returns. It then checks whether the remaining active hook cell is empty and sets `self.active_hook_cell = None` if so. Next it bumps the active-cell revision, marks `self.transcript.needs_final_message_separator = true`, sends `AppEvent::InsertHistoryCell(Box::new(completed_cell))` through `self.app_event_tx`, and requests pending usage output insertion.

**Call relations**: Called from both hook-start and hook-completion paths to persist completed hook output at safe boundaries. It is the history-emission step for completed persistent runs.

*Call graph*: called by 2 (on_hook_completed, on_hook_started); 2 external calls (new, InsertHistoryCell).


##### `ChatWidget::finish_active_hook_cell_if_idle`  (lines 91–110)

```
fn finish_active_hook_cell_if_idle(&mut self)
```

**Purpose**: Finalizes the remaining active hook cell when it has become empty or otherwise ready to flush into history. It prevents stale hook UI from lingering after all visible work is done.

**Data flow**: Reads `self.active_hook_cell.as_ref()` and returns if absent. If `cell.is_empty()`, it clears `self.active_hook_cell`, bumps the revision, and requests pending usage output insertion. Otherwise, if `cell.should_flush()` and `self.active_hook_cell.take()` succeeds, it bumps the revision, marks `self.transcript.needs_final_message_separator = true`, sends the cell as `AppEvent::InsertHistoryCell`, and requests pending usage output insertion.

**Call relations**: Used after hook completion and after time-based visibility updates. It is the final cleanup/flush step once no active hook content needs to remain transient.

*Call graph*: called by 2 (on_hook_completed, update_due_hook_visibility); 2 external calls (new, InsertHistoryCell).


##### `ChatWidget::update_due_hook_visibility`  (lines 112–121)

```
fn update_due_hook_visibility(&mut self)
```

**Purpose**: Advances time-based hook visibility state and then flushes or clears the hook cell if it has become idle. This supports timers such as elapsed displays or delayed disappearance.

**Data flow**: If `self.active_hook_cell` is absent, returns. Otherwise it gets `now = Instant::now()`, calls `cell.advance_time(now)`, bumps the active-cell revision if that returns true, and then calls `finish_active_hook_cell_if_idle()`.

**Call relations**: This method is invoked on scheduled frames or timer ticks. It delegates final cleanup decisions to `finish_active_hook_cell_if_idle` after updating time-sensitive hook state.

*Call graph*: calls 1 internal fn (finish_active_hook_cell_if_idle); 1 external calls (now).


##### `ChatWidget::schedule_hook_timer_if_needed`  (lines 123–143)

```
fn schedule_hook_timer_if_needed(&self)
```

**Purpose**: Schedules future frames required for hook animations and explicit hook deadlines. It ensures the UI wakes up both for smooth running-run visibility and for the next non-animation timer event.

**Data flow**: Reads `self.config.animations` and whether `self.active_hook_cell` has a visible running run; if both are true, it asks `self.frame_requester` to schedule a frame in 50 ms. It then queries `HookCell::next_timer_deadline` from the active hook cell; if present, computes `delay = deadline.saturating_duration_since(Instant::now())` and schedules another frame for that delay.

**Call relations**: This is the timer-planning companion to `update_due_hook_visibility`. It does not mutate hook content itself; it arranges for future calls when animation or deadline-driven updates are needed.

*Call graph*: 2 external calls (from_millis, now).


### `tui/src/chatwidget/turn_runtime.rs`

`orchestration` · `main loop`

This module is the turn driver for `ChatWidget`. It synchronizes the bottom pane’s single 'task running' indicator from two underlying lifecycles—agent-turn execution and MCP startup—and resets or finalizes a large amount of turn-scoped state. `on_task_started` is the canonical entry transition: it clears pending-start flags, starts `turn_lifecycle`, resets transcript turn flags and adaptive chunking, tears down any stale plan stream controller, resets runtime metrics and telemetry, clears quit-shortcut and hook-cell state, restores working status surfaces, marks the pet notification as running, and redraws.

`on_task_complete` is the most complex path. It chooses a copy source for notifications without overwriting a more specific item-level source, flushes active answer and plan streams, optionally queues plan consolidation, drains unified exec wait state, collects runtime metrics, and decides whether to insert a `FinalMessageSeparator` based on `had_work_activity`, separator need, and metrics presence. It then clears running-state UI, emits review-mode pet notifications, refreshes pending-input previews, optionally prompts for plan implementation in plan mode, starts exactly one queued follow-up input if present, and only sends the final 'turn complete' notification when the agent is truly waiting for the user.

The error paths all converge through `finalize_turn`, which drops transient stream tails, marks active cells failed, clears running command state, resets stream controllers, refreshes status-line data, and preserves MCP startup tracking. `handle_non_retry_error` classifies app-server errors into steer rejection, cyber-policy, server-overloaded, usage-limit, or generic error flows. The module also records plan progress for status surfaces and deduplicated warnings for model verification.

#### Function details

##### `ChatWidget::update_task_running_state`  (lines 13–19)

```
fn update_task_running_state(&mut self)
```

**Purpose**: Recomputes the bottom-pane running indicator from current agent-turn and MCP-startup state, then refreshes related status surfaces. It is the single place where the widget derives 'task running' UI from multiple lifecycles.

**Data flow**: Reads `self.turn_lifecycle.agent_turn_running` and `self.mcp_startup_status`, writes the OR of those conditions into `bottom_pane.set_task_running(...)`, then refreshes plan-mode nudges and status surfaces. It returns nothing.

**Call relations**: Called whenever turn-running state changes, specifically from `on_task_started`, `on_task_complete`, and `finalize_turn`, so the bottom pane stays synchronized with lifecycle transitions.

*Call graph*: called by 3 (finalize_turn, on_task_complete, on_task_started).


##### `ChatWidget::collect_runtime_metrics_delta`  (lines 21–25)

```
fn collect_runtime_metrics_delta(&mut self)
```

**Purpose**: Pulls any pending runtime-metrics summary from session telemetry and applies it to the turn accumulator. It is the polling bridge between telemetry collection and transcript/UI reporting.

**Data flow**: Reads `self.session_telemetry.runtime_metrics_summary()`, and if it returns `Some(delta)`, forwards that delta to `apply_runtime_metrics_delta`. It mutates turn metrics indirectly and returns nothing.

**Call relations**: Used by `refresh_runtime_metrics` for periodic updates and by `on_task_complete` before final separator insertion so the latest metrics are included.

*Call graph*: calls 1 internal fn (apply_runtime_metrics_delta); called by 2 (on_task_complete, refresh_runtime_metrics).


##### `ChatWidget::apply_runtime_metrics_delta`  (lines 27–33)

```
fn apply_runtime_metrics_delta(&mut self, delta: RuntimeMetricsSummary)
```

**Purpose**: Merges a runtime-metrics delta into the current turn totals and optionally logs websocket timing information into history. It centralizes the policy for when timing metrics become visible.

**Data flow**: Consumes a `RuntimeMetricsSummary delta`, computes `should_log_timing` via `has_websocket_timing_metrics(delta)`, merges the delta into `self.turn_runtime_metrics`, and if timing should be logged calls `log_websocket_timing_totals(delta)`. It returns nothing.

**Call relations**: Called only from `collect_runtime_metrics_delta`. It delegates transcript logging to `ChatWidget::log_websocket_timing_totals` when the delta contains websocket timing data.

*Call graph*: calls 1 internal fn (log_websocket_timing_totals); called by 1 (collect_runtime_metrics_delta).


##### `ChatWidget::log_websocket_timing_totals`  (lines 35–41)

```
fn log_websocket_timing_totals(&mut self, delta: RuntimeMetricsSummary)
```

**Purpose**: Appends a plain-history line summarizing websocket timing totals when a human-readable label can be derived. It exposes timing diagnostics directly in the transcript.

**Data flow**: Consumes a `RuntimeMetricsSummary delta`, derives a responses-API summary from it, asks `history_cell::runtime_metrics_label` for an optional label, and if present appends a single bullet line like `WebSocket timing: ...` to plain history. It mutates transcript history and returns nothing.

**Call relations**: Called from `apply_runtime_metrics_delta` only when timing metrics are present. It is the final rendering step for websocket timing diagnostics.

*Call graph*: calls 1 internal fn (responses_api_summary); called by 1 (apply_runtime_metrics_delta); 2 external calls (runtime_metrics_label, vec!).


##### `ChatWidget::refresh_runtime_metrics`  (lines 43–45)

```
fn refresh_runtime_metrics(&mut self)
```

**Purpose**: Refreshes runtime metrics by polling telemetry for any new delta. It is a thin convenience wrapper around the collection step.

**Data flow**: Reads no explicit inputs beyond `self`, calls `collect_runtime_metrics_delta`, mutates turn metrics/history indirectly, and returns nothing.

**Call relations**: Used by callers that want a named 'refresh' operation without caring about the telemetry-delta details.

*Call graph*: calls 1 internal fn (collect_runtime_metrics_delta).


##### `ChatWidget::on_task_started`  (lines 49–79)

```
fn on_task_started(&mut self)
```

**Purpose**: Performs the full start-of-turn transition for the chat widget. It resets turn-scoped state, starts lifecycle tracking, restores working UI, and marks the widget as actively running.

**Data flow**: Clears `input_queue.user_turn_pending_start`, starts `turn_lifecycle` with `Instant::now()`, resets transcript turn flags and adaptive chunking, tears down any existing plan stream controller and requests deferred usage-output insertion if one existed, resets `turn_runtime_metrics` and session telemetry, clears quit-shortcut hints and active hook cells, resets pending status-indicator restoration, shows the interrupt hint, sets terminal-title status to `Working`, conditionally sets the status header to `Working` unless MCP startup owns it, clears reasoning buffers, sets the ambient pet notification to `Running`, requests redraw, and returns nothing.

**Call relations**: Called when a new agent task begins. It concludes by invoking `update_task_running_state` so the bottom pane reflects the new running state.

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

**Purpose**: Performs the full end-of-turn transition, including copy-source finalization, stream shutdown, runtime-metrics insertion, running-state cleanup, follow-up input dispatch, and user notification. It is the central completion orchestrator for agent turns.

**Data flow**: Accepts optional `last_agent_message`, optional `duration_ms`, and `from_replay`. It sanitizes the final assistant markdown relative to cwd, records it as a copy source only if no earlier item-level source was seen this turn, derives a notification preview from either the final payload or retained transcript markdown, clears `saw_copy_source_this_turn`, flushes answer streams, finalizes any active plan stream controller and possibly queues `AppEvent::ConsolidateProposedPlan`, flushes unified exec wait state, and if not replaying collects runtime metrics and may append a `FinalMessageSeparator` containing elapsed seconds and/or runtime metrics. It then clears pending status restoration, pending-start flags, active hook cells, running command/suppression/wait state, finishes `turn_lifecycle`, updates task-running UI, emits a review pet notification when live, redraws, refreshes pending-input preview, maybe opens the plan-implementation prompt, clears `saw_plan_item_this_turn` for live completions, maybe sends one queued follow-up input, conditionally notifies `AgentTurnComplete` only when no immediate continuation will start, and finally checks for pending rate-limit prompts.

**Call relations**: Called when the backend reports turn completion. It invokes `collect_runtime_metrics_delta`, `update_task_running_state`, `maybe_prompt_plan_implementation`, and follow-up-input logic to bridge from one turn into the next or into an idle waiting state.

*Call graph*: calls 6 internal fn (agent_turn_preview, collect_runtime_metrics_delta, has_queued_follow_up_messages, maybe_prompt_plan_implementation, update_task_running_state, new); 2 external calls (ConsolidateProposedPlan, default).


##### `ChatWidget::maybe_prompt_plan_implementation`  (lines 210–235)

```
fn maybe_prompt_plan_implementation(&mut self)
```

**Purpose**: Decides whether to open the plan-implementation prompt after a turn completes in plan mode. It gates the prompt on collaboration mode, queue emptiness, modal state, plan-item presence, and rate-limit prompt state.

**Data flow**: Reads collaboration-mode enablement, queued follow-up state, active mode kind, transcript flags, bottom-pane modal/popup state, and `rate_limit_switch_prompt`. If any guard fails it returns early; otherwise it opens the plan implementation prompt. It mutates UI state only when all conditions pass.

**Call relations**: Called from `on_task_complete` after pending-input preview refresh. When all guards pass it delegates actual prompt construction to `ChatWidget::open_plan_implementation_prompt`.

*Call graph*: calls 2 internal fn (has_queued_follow_up_messages, open_plan_implementation_prompt); called by 1 (on_task_complete); 1 external calls (matches!).


##### `ChatWidget::open_plan_implementation_prompt`  (lines 237–250)

```
fn open_plan_implementation_prompt(&mut self)
```

**Purpose**: Builds and shows the selection view that asks whether to implement the newly proposed plan. It also emits a plan-mode prompt notification.

**Data flow**: Reads the model catalog to compute the default collaboration-mode mask, derives an optional context-usage label from `plan_implementation_context_usage_label`, builds selection-view params with the latest proposed plan markdown and context label, shows that selection view in the bottom pane, notifies `PlanModePrompt` with the fixed implementation title, and returns nothing.

**Call relations**: Called only from `maybe_prompt_plan_implementation` once all eligibility checks pass. It delegates parameter construction to `plan_implementation::selection_view_params`.

*Call graph*: calls 3 internal fn (selection_view_params, plan_implementation_context_usage_label, default_mode_mask); called by 1 (maybe_prompt_plan_implementation).


##### `ChatWidget::plan_implementation_context_usage_label`  (lines 259–279)

```
fn plan_implementation_context_usage_label(&self) -> Option<String>
```

**Purpose**: Computes a short label describing context already used, for display in the plan-implementation prompt. It prefers percentage-used when available and falls back to compact token counts.

**Data flow**: Reads `self.token_info`; if absent returns `None`. Otherwise it computes remaining-context percent and used-token count via helper methods. If a remaining percent exists, it converts that into `used_percent = 100 - percent.clamp(0, 100)` and returns `Some("N% used")` when positive. If no percent exists but used tokens are known and positive, it returns `Some("<compact tokens> used")`. Otherwise it returns `None`.

**Call relations**: Called by `open_plan_implementation_prompt` to enrich the prompt footer with context-usage information only when there is meaningful evidence of prior context consumption.

*Call graph*: called by 1 (open_plan_implementation_prompt); 1 external calls (format!).


##### `ChatWidget::has_queued_follow_up_messages`  (lines 281–283)

```
fn has_queued_follow_up_messages(&self) -> bool
```

**Purpose**: Reports whether there are queued follow-up user messages waiting to start another turn. It is a small forwarding helper over the input queue.

**Data flow**: Reads `self.input_queue` and returns the boolean result of `has_queued_follow_up_messages()`. It does not mutate state.

**Call relations**: Used by both `maybe_prompt_plan_implementation` and `on_task_complete` to suppress prompts or notifications when another turn will begin immediately.

*Call graph*: called by 2 (maybe_prompt_plan_implementation, on_task_complete).


##### `ChatWidget::handle_app_server_steer_rejected_error`  (lines 285–293)

```
fn handle_app_server_steer_rejected_error(
        &mut self,
        codex_error_info: &AppServerCodexErrorInfo,
    ) -> bool
```

**Purpose**: Recognizes the specific app-server error that means the active turn cannot be steered and converts it into a queued rejected-steer flow. It returns whether that special-case handling succeeded.

**Data flow**: Reads an `&AppServerCodexErrorInfo`, checks whether it matches `ActiveTurnNotSteerable`, and if so calls `enqueue_rejected_steer()`. It returns the resulting boolean and otherwise returns false.

**Call relations**: Called from `handle_non_retry_error` before generic error handling. A true result short-circuits the rest of the error-classification flow.

*Call graph*: 1 external calls (matches!).


##### `ChatWidget::finalize_turn`  (lines 299–326)

```
fn finalize_turn(&mut self)
```

**Purpose**: Performs shared turn-cleanup logic for abnormal termination paths such as errors and cancellations. It clears transient live UI state, marks active cells failed, stops running indicators, and resets stream/runtime buffers without touching overlapping MCP startup tracking.

**Data flow**: Clears any preview-only stream tail, finalizes the active cell as failed, clears active hook cells, resets `input_queue.user_turn_pending_start`, finishes `turn_lifecycle`, updates task-running UI, clears running command/suppression/wait state, resets adaptive chunking, drops stream and plan-stream controllers, requests deferred usage-output insertion after stream shutdown, clears pending status-indicator restoration, clears cancel-edit state, refreshes branch and git-summary status lines, maybe shows a pending rate-limit prompt, and returns nothing.

**Call relations**: This shared cleanup routine is called by `on_server_overloaded_error`, `on_error`, and `on_cyber_policy_error` so all abnormal turn endings leave the widget in a consistent stopped state.

*Call graph*: calls 1 internal fn (update_task_running_state); called by 3 (on_cyber_policy_error, on_error, on_server_overloaded_error).


##### `ChatWidget::on_server_overloaded_error`  (lines 328–341)

```
fn on_server_overloaded_error(&mut self, message: String)
```

**Purpose**: Handles the server-overloaded error case by finalizing the turn, appending a warning event, and attempting to continue with queued input. It substitutes a default overload message when the backend message is blank.

**Data flow**: Consumes a `String message`, clears `submit_pending_steers_after_interrupt`, calls `finalize_turn`, normalizes empty/whitespace-only messages to a fixed overload string, appends a warning history cell, requests redraw, then tries to send the next queued input. It returns nothing.

**Call relations**: Reached from `handle_non_retry_error` when the classified rate-limit kind is `ServerOverloaded`. It uses `finalize_turn` for cleanup and `history_cell::new_warning_event` for transcript output.

*Call graph*: calls 1 internal fn (finalize_turn); called by 1 (handle_non_retry_error); 1 external calls (new_warning_event).


##### `ChatWidget::on_error`  (lines 343–356)

```
fn on_error(&mut self, message: String)
```

**Purpose**: Handles a generic terminal error by flushing streamed output, finalizing the turn, appending an error event, and marking the pet notification as failed. It then tries to continue with queued input.

**Data flow**: Consumes a `String message`, clears `submit_pending_steers_after_interrupt`, flushes answer-stream separation, calls `finalize_turn`, appends an error history cell, sets ambient pet notification to `Failed`, requests redraw, and invokes `maybe_send_next_queued_input()`. It returns nothing.

**Call relations**: Called directly from `handle_non_retry_error` for generic failures and from `on_rate_limit_error` for several rate-limit outcomes. It is the standard terminal-error path.

*Call graph*: calls 1 internal fn (finalize_turn); called by 2 (handle_non_retry_error, on_rate_limit_error); 1 external calls (new_error_event).


##### `ChatWidget::on_cyber_policy_error`  (lines 358–366)

```
fn on_cyber_policy_error(&mut self)
```

**Purpose**: Handles the specialized cyber-policy failure path by finalizing the turn and appending a dedicated transcript event. It then attempts to continue with queued input.

**Data flow**: Clears `submit_pending_steers_after_interrupt`, calls `finalize_turn`, appends a cyber-policy error history cell, requests redraw, and invokes `maybe_send_next_queued_input()`. It returns nothing.

**Call relations**: Reached from `handle_non_retry_error` when the app-server error info identifies a cyber-policy violation. It shares cleanup with other error paths via `finalize_turn`.

*Call graph*: calls 1 internal fn (finalize_turn); called by 1 (handle_non_retry_error); 1 external calls (new_cyber_policy_error_event).


##### `ChatWidget::on_rate_limit_error`  (lines 368–411)

```
fn on_rate_limit_error(&mut self, error_kind: RateLimitErrorKind, message: String)
```

**Purpose**: Maps rate-limit and usage-limit failures into user-facing error flows, including workspace-owner/member variants and optional owner-nudge prompts. It rewrites some stored reached-type variants when the error is specifically a usage-limit condition.

**Data flow**: Consumes a `RateLimitErrorKind` and message string, computes whether this is a usage-limit error, rewrites `self.codex_rate_limit_reached_type` accordingly, stores the rewritten type back, then matches it. Depending on the resulting type it calls `on_error` with either a fixed explanatory message or the provided message, and for workspace-member depletion/usage-limit cases also opens a workspace-owner nudge prompt with the appropriate credit type. It returns nothing.

**Call relations**: Called from `handle_non_retry_error` for classified generic or usage-limit rate-limit failures. It delegates final transcript/error rendering to `on_error` and may trigger additional billing/owner guidance UI.

*Call graph*: calls 1 internal fn (on_error); called by 1 (handle_non_retry_error); 1 external calls (matches!).


##### `ChatWidget::handle_non_retry_error`  (lines 413–440)

```
fn handle_non_retry_error(
        &mut self,
        message: String,
        codex_error_info: Option<AppServerCodexErrorInfo>,
    )
```

**Purpose**: Classifies a non-retryable backend error and dispatches it to the correct specialized handler. It is the top-level decision tree for terminal error handling.

**Data flow**: Consumes a message string and optional `AppServerCodexErrorInfo`. It first checks whether the error is a steer-rejected case handled by `handle_app_server_steer_rejected_error`; otherwise checks for cyber-policy errors; otherwise extracts a rate-limit kind and dispatches `ServerOverloaded` to `on_server_overloaded_error` and `UsageLimit`/`Generic` to `on_rate_limit_error`; if none of those apply it falls back to `on_error(message)`. It returns nothing.

**Call relations**: This function is the central error dispatcher. It delegates to `on_cyber_policy_error`, `on_server_overloaded_error`, `on_rate_limit_error`, or `on_error` depending on classification.

*Call graph*: calls 4 internal fn (on_cyber_policy_error, on_error, on_rate_limit_error, on_server_overloaded_error).


##### `ChatWidget::on_warning`  (lines 442–449)

```
fn on_warning(&mut self, message: impl Into<String>)
```

**Purpose**: Appends a warning event to history only if the warning-display policy says it should be shown. It suppresses repeated fallback-model-metadata warnings for the same model slug.

**Data flow**: Accepts any `Into<String>` message, converts it to `String`, asks `self.warning_display_state.should_display(&message)` whether it should be shown, and if true appends a warning history cell and requests redraw. It returns nothing.

**Call relations**: Called by `on_app_server_model_verification` and potentially other warning sources. It delegates deduplication policy to `WarningDisplayState::should_display`.

*Call graph*: called by 1 (on_app_server_model_verification); 2 external calls (into, new_warning_event).


##### `ChatWidget::on_app_server_model_verification`  (lines 451–458)

```
fn on_app_server_model_verification(
        &mut self,
        verifications: &[AppServerModelVerification],
    )
```

**Purpose**: Responds to model-verification flags from the app server by surfacing any relevant warnings. Currently it only reacts to the trusted-access-for-cyber verification.

**Data flow**: Reads a slice of `AppServerModelVerification`, checks whether it contains `TrustedAccessForCyber`, and if so calls `on_warning` with the fixed trusted-access warning string. It returns nothing.

**Call relations**: This is a narrow adapter from app-server verification metadata into the generic warning path implemented by `ChatWidget::on_warning`.

*Call graph*: calls 1 internal fn (on_warning); 1 external calls (contains).


##### `ChatWidget::on_plan_update`  (lines 460–474)

```
fn on_plan_update(&mut self, update: UpdatePlanArgs)
```

**Purpose**: Records a plan update in transcript and status state, including completed-versus-total step counts for status surfaces. It marks the current turn as having emitted a plan update.

**Data flow**: Consumes `UpdatePlanArgs`, sets `transcript.saw_plan_update_this_turn = true`, computes `total` from `update.plan.len()`, counts completed steps by inspecting each `StepStatus`, stores `last_plan_progress` when total is nonzero, refreshes status surfaces, appends a plan-update history cell, and returns nothing.

**Call relations**: Called when the backend emits an `update_plan` event. It delegates transcript rendering to `history_cell::new_plan_update` while keeping status-line progress in sync.

*Call graph*: 1 external calls (new_plan_update).


##### `ChatWidget::interrupted_turn_message`  (lines 476–482)

```
fn interrupted_turn_message(&self, reason: TurnAbortReason) -> String
```

**Purpose**: Returns the user-facing transcript message for an interrupted turn, with a special string for budget-limited interruptions. It encapsulates the wording policy for interruption reasons.

**Data flow**: Takes a `TurnAbortReason`, compares it to `BudgetLimited`, and returns either the budget-specific message or the generic interruption/help text. It does not mutate state.

**Call relations**: Used by interruption-handling code elsewhere to obtain consistent user-visible messaging for aborted turns.


### `tui/src/chatwidget/streaming.rs`

`domain_logic` · `during live turn streaming and stream completion`

This module is the runtime core for incremental transcript updates. It maintains two independent stream controllers—one for assistant output and one for plan output—and coordinates them with the active transcript cell, commit animation, and footer visibility. Incoming deltas are appended into the appropriate controller, which may queue wrapped lines for periodic commit ticks. While a stream tail is visible, the bottom-pane status indicator is hidden to avoid duplicate in-progress affordances; restoration is deferred through `pending_status_indicator_restore` until commentary has completed and all stream queues are idle.

Assistant streaming starts in `handle_streaming_delta()`, which flushes any active exec grouping, optionally inserts a final-message separator, creates a `StreamController`, pushes deltas, starts commit animation, and updates the active tail cell. Completion flows through `finalize_completed_assistant_message()` and `flush_answer_stream_with_separator()`, which finalize the controller, optionally add a boxed history cell immediately, and queue `AppEvent::ConsolidateAgentMessage` so streamed cells can be replaced by a resize-friendly markdown cell. Plan streaming mirrors this with `PlanStreamController`, transcript plan buffers, and `ConsolidateProposedPlan` events.

Reasoning deltas are handled differently: they never stream into history. Instead, the module accumulates markdown in `reasoning_buffer`, extracts the first bold span as a transient status header, and later writes the full reasoning block into history only on finalization. The file also manages retry/error status preservation, commit-tick pacing via `run_commit_tick_with_scope`, FIFO interrupt deferral while writes are active, and stream-tail bookkeeping through `sync_active_stream_tail()` and `clear_active_stream_tail()`.

#### Function details

##### `ChatWidget::restore_reasoning_status_header`  (lines 9–17)

```
fn restore_reasoning_status_header(&mut self)
```

**Purpose**: Restores the footer header from the current reasoning buffer when possible, or falls back to a generic working header if a task is still running. This is used after other transient statuses have displaced reasoning-derived status text.

**Data flow**: Reads `self.reasoning_buffer` via `extract_first_bold` and `self.bottom_pane.is_task_running()` → if a bold heading exists, sets `self.status_state.terminal_title_status_kind = Thinking` and calls `set_status_header(header)`; otherwise, if a task is running, sets the title status kind to `Working` and sets the header to `Working` → mutates status state and footer header.

**Call relations**: Called by external chatwidget status logic when it needs to reestablish the reasoning-derived header after interruptions such as temporary exec or retry statuses.

*Call graph*: 1 external calls (from).


##### `ChatWidget::flush_answer_stream_with_separator`  (lines 19–59)

```
fn flush_answer_stream_with_separator(&mut self)
```

**Purpose**: Finalizes the active assistant stream controller, converts any streamed tail into durable history or deferred consolidation input, and stops commit animation when all stream queues are drained. It also triggers post-stream usage insertion logic.

**Data flow**: Reads and removes `self.stream_controller`, remembers whether one existed, and inspects whether it had a live tail to choose a `ConsolidationScrollbackReflow` mode. It clears the active stream tail, finalizes the controller into `(cell, source)`, either stores the finalized cell immediately in history or defers it depending on reflow requirements, parses markdown source for visible content, and sends `AppEvent::ConsolidateAgentMessage { source, cwd, scrollback_reflow, deferred_history_cell }` when source exists. Afterward it resets `adaptive_chunking`; if a controller existed and both assistant/plan queues are idle, it sends `AppEvent::StopCommitAnimation`; if a controller existed at all, it requests pending usage-output insertion after shutdown.

**Call relations**: Called from `finalize_completed_assistant_message` at assistant-message completion. It delegates tail cleanup to `clear_active_stream_tail` and uses `stream_controllers_idle` to decide whether commit animation can stop.

*Call graph*: calls 2 internal fn (clear_active_stream_tail, stream_controllers_idle); called by 1 (finalize_completed_assistant_message).


##### `ChatWidget::stream_controllers_idle`  (lines 61–71)

```
fn stream_controllers_idle(&self) -> bool
```

**Purpose**: Reports whether both assistant and plan stream controllers have no queued lines left to commit. Missing controllers count as idle.

**Data flow**: Reads `self.stream_controller` and `self.plan_stream_controller`, mapping each existing controller to `queued_lines() == 0` and treating `None` as `true` → returns the conjunction of both booleans.

**Call relations**: Used after stream finalization and during deferred status restoration to ensure the UI only restores the footer once all visible streaming work has drained.

*Call graph*: called by 2 (flush_answer_stream_with_separator, maybe_restore_status_indicator_after_stream_idle).


##### `ChatWidget::maybe_restore_status_indicator_after_stream_idle`  (lines 79–95)

```
fn maybe_restore_status_indicator_after_stream_idle(&mut self)
```

**Purpose**: Restores the footer status indicator only when a deferred restore has been requested, the turn is still running, and both stream queues are idle. This prevents flicker while streamed output is still actively committing.

**Data flow**: Reads `self.status_state.pending_status_indicator_restore`, `self.bottom_pane.is_task_running()`, and `stream_controllers_idle()` → if any gate fails, returns. Otherwise ensures the status indicator exists, calls `set_status` with the cached `current_status` header/details/max-lines, and clears `pending_status_indicator_restore`.

**Call relations**: Invoked after commentary completion, plan completion, and commit ticks that drain all queues. It is the single gate that turns the deferred-restore flag into an actual footer reappearance.

*Call graph*: calls 1 internal fn (stream_controllers_idle); called by 3 (on_agent_message_item_completed, on_plan_item_completed, run_commit_tick_with_scope).


##### `ChatWidget::finalize_completed_assistant_message`  (lines 97–109)

```
fn finalize_completed_assistant_message(&mut self, message: Option<&str>)
```

**Purpose**: Completes one assistant message item by ensuring any final payload is streamed if needed, flushing the stream controller, marking stream completion, and requesting a redraw.

**Data flow**: Consumes `message: Option<&str>` → if no `stream_controller` exists and `message` is present/non-empty, forwards it to `handle_streaming_delta` so non-streamed completions still render. Then calls `flush_answer_stream_with_separator()`, `handle_stream_finished()`, and `request_redraw()` → mutates transcript/history, stream state, interrupt queue state, and redraw scheduling.

**Call relations**: Called from `on_agent_message_item_completed` after the message text has been parsed into visible markdown. It bridges between item-completion events and the lower-level stream finalization path.

*Call graph*: calls 3 internal fn (flush_answer_stream_with_separator, handle_stream_finished, handle_streaming_delta); called by 1 (on_agent_message_item_completed).


##### `ChatWidget::on_agent_message_delta`  (lines 111–113)

```
fn on_agent_message_delta(&mut self, delta: String)
```

**Purpose**: Accepts one assistant text delta and routes it into the normal assistant streaming pipeline. It is a thin event adapter.

**Data flow**: Consumes `delta: String` → passes it directly to `handle_streaming_delta(delta)` → returns `()` after that method mutates stream state and transcript tail.

**Call relations**: Called by higher-level server-notification handling whenever an `AgentMessageDelta` arrives.

*Call graph*: calls 1 internal fn (handle_streaming_delta).


##### `ChatWidget::on_plan_delta`  (lines 115–145)

```
fn on_plan_delta(&mut self, delta: String)
```

**Purpose**: Streams one plan delta into the plan transcript path, but only while the active collaboration mode is `Plan`. It initializes plan-stream state, accumulates transcript buffers, and triggers commit animation as lines become ready.

**Data flow**: Consumes `delta: String`, first checks `active_mode_kind() != ModeKind::Plan` and returns early if not in plan mode. For non-empty deltas it records visible turn activity. It marks `transcript.plan_item_active`, clears the plan buffer on first delta, appends the delta to `transcript.plan_delta_buffer`, lazily creates `PlanStreamController::new(current_stream_width(4), &config.cwd, history_render_mode())` after flushing active exec/history cells, pushes the delta into the controller, and if `push` reports ready lines sends `AppEvent::StartCommitAnimation` and runs `run_catch_up_commit_tick()`. Finally it syncs the active stream tail and requests redraw.

**Call relations**: Called by plan-delta event handling. It parallels assistant streaming but uses the plan-specific controller and transcript fields.

*Call graph*: calls 3 internal fn (run_catch_up_commit_tick, sync_active_stream_tail, new).


##### `ChatWidget::on_plan_item_completed`  (lines 147–198)

```
fn on_plan_item_completed(&mut self, text: String)
```

**Purpose**: Finalizes a completed plan item, reconciling streamed plan text with the final payload, recording transcript history, and optionally restoring the footer once stream queues drain. It also queues consolidation of streamed plan output.

**Data flow**: Consumes final `text: String`, compares it with trimmed `transcript.plan_delta_buffer`, and chooses `plan_text` from the explicit text unless that is empty. Non-empty plan text is recorded via `record_agent_markdown` and stored in `transcript.latest_proposed_plan_markdown`. It notes whether a plan stream controller existed, clears plan transcript flags, then finalizes and removes `plan_stream_controller` if present, clearing the active tail and distinguishing live-tail vs finalized-cell cases. Depending on what finalization produced, it either adds the finalized streamed cell to history and sends `AppEvent::ConsolidateProposedPlan(source)`, adds a fresh proposed-plan history cell from `plan_text`, or sends consolidation without adding a cell. If streaming had occurred, it sets `pending_status_indicator_restore = true`, calls `maybe_restore_status_indicator_after_stream_idle()`, and requests pending usage-output insertion after stream shutdown.

**Call relations**: Called when a plan item completes. It delegates tail cleanup to `clear_active_stream_tail` and restoration gating to `maybe_restore_status_indicator_after_stream_idle`.

*Call graph*: calls 2 internal fn (clear_active_stream_tail, maybe_restore_status_indicator_after_stream_idle); 2 external calls (ConsolidateProposedPlan, new_proposed_plan).


##### `ChatWidget::on_agent_reasoning_delta`  (lines 200–220)

```
fn on_agent_reasoning_delta(&mut self, delta: String)
```

**Purpose**: Accumulates reasoning markdown and derives a transient footer header from the first bold span, without streaming reasoning into transcript history. Unified exec waiting takes precedence over this derived header.

**Data flow**: Consumes `delta: String`, appends it to `self.reasoning_buffer`, checks `self.unified_exec_wait_streak`, and if exec waiting is active only requests redraw. Otherwise extracts the first bold span from the buffer; when found, sets `self.status_state.terminal_title_status_kind = Thinking` and updates the footer header via `set_status_header(header)`. It always requests redraw at the end.

**Call relations**: Called by reasoning-delta event handling. It feeds the status system rather than the transcript stream controllers.


##### `ChatWidget::on_agent_reasoning_final`  (lines 222–235)

```
fn on_agent_reasoning_final(&mut self)
```

**Purpose**: Commits the accumulated reasoning content into transcript history as a summary block and clears the reasoning buffers. This is the only point where reasoning text becomes durable history.

**Data flow**: Appends `reasoning_buffer` into `full_reasoning_buffer`, and if the combined buffer is non-empty creates a `history_cell::new_reasoning_summary_block(full_reasoning_buffer.clone(), &config.cwd)` and adds it to history. Then clears both reasoning buffers and requests redraw.

**Call relations**: Called when a reasoning block ends, complementing `on_agent_reasoning_delta` and `on_reasoning_section_break`.

*Call graph*: 1 external calls (new_reasoning_summary_block).


##### `ChatWidget::on_reasoning_section_break`  (lines 237–242)

```
fn on_reasoning_section_break(&mut self)
```

**Purpose**: Separates reasoning sections while preserving transcript-only content. It moves the current reasoning chunk into the full buffer with a blank-line separator and resets the live extraction buffer.

**Data flow**: Appends `reasoning_buffer` and then `"\n\n"` to `full_reasoning_buffer`, clears `reasoning_buffer`, and returns `()`.

**Call relations**: Called on reasoning section boundaries so later finalization can emit one combined reasoning summary block while header extraction starts fresh for the next section.


##### `ChatWidget::on_stream_error`  (lines 244–254)

```
fn on_stream_error(&mut self, message: String, additional_details: Option<String>)
```

**Purpose**: Shows a retry/error status in the footer while preserving the previous header for later restoration. It also marks the terminal-title status bucket as `Thinking` during the retry state.

**Data flow**: Consumes `message` and optional `additional_details`, calls `status_state.remember_retry_status_header()`, ensures the bottom-pane status indicator exists, sets `status_state.terminal_title_status_kind = Thinking`, and calls `set_status(message, additional_details, CapitalizeFirst, STATUS_DETAILS_DEFAULT_MAX_LINES)` → mutates status cache and visible footer.

**Call relations**: Called by higher-level error handling for transient stream failures, setting up the retry-header restoration path later exercised when streaming resumes.


##### `ChatWidget::on_agent_message_item_completed`  (lines 261–302)

```
fn on_agent_message_item_completed(
        &mut self,
        item: AgentMessageItem,
        from_replay: bool,
    )
```

**Purpose**: Handles completion of an `AgentMessage` item, including finalizing visible markdown, recording final answers, syncing created-branch metadata back to the thread, and deciding whether footer restoration should be deferred. Commentary and final-answer phases are treated differently.

**Data flow**: Consumes `item` and `from_replay`, concatenates all `AgentMessageContent::Text` pieces into `message`, parses it with `parse_assistant_markdown`, and finalizes the visible markdown through `finalize_completed_assistant_message((!visible_markdown.is_empty()).then_some(...))`. If the phase is `FinalAnswer` or `None` and visible markdown is non-empty, records it via `record_agent_markdown`. For live (non-replay) messages, if the parsed markdown indicates a created branch cwd and thread/runner are available, spawns a task that looks up the branch name and sends `AppEvent::SyncThreadGitBranch { thread_id, branch }`. Finally it sets `status_state.pending_status_indicator_restore` to `true` for commentary, or for final-answer/legacy messages only when pending steers remain, then calls `maybe_restore_status_indicator_after_stream_idle()`.

**Call relations**: Called by item-completion event handling for assistant messages. It is the high-level completion policy layer above `finalize_completed_assistant_message`.

*Call graph*: calls 3 internal fn (current_branch_name, finalize_completed_assistant_message, maybe_restore_status_indicator_after_stream_idle); 4 external calls (from, new, matches!, spawn).


##### `ChatWidget::on_commit_tick`  (lines 306–308)

```
fn on_commit_tick(&mut self)
```

**Purpose**: Entry point for periodic stream commit ticks from the app loop. It simply runs a regular commit tick.

**Data flow**: Takes no arguments → calls `run_commit_tick()` → returns `()` after that method mutates stream/history state.

**Call relations**: Invoked by timer-driven app events to advance queued streamed lines into transcript history.

*Call graph*: calls 1 internal fn (run_commit_tick).


##### `ChatWidget::run_commit_tick`  (lines 311–313)

```
fn run_commit_tick(&mut self)
```

**Purpose**: Runs a normal commit tick that may commit lines in any pacing mode. It is the standard periodic drain path.

**Data flow**: Takes no arguments → calls `run_commit_tick_with_scope(CommitTickScope::AnyMode)` → returns `()`.

**Call relations**: Called from `on_commit_tick`; it exists mainly to name the regular-scope variant distinctly from catch-up ticks.

*Call graph*: calls 1 internal fn (run_commit_tick_with_scope); called by 1 (on_commit_tick).


##### `ChatWidget::run_catch_up_commit_tick`  (lines 316–318)

```
fn run_catch_up_commit_tick(&mut self)
```

**Purpose**: Runs an opportunistic commit tick only when adaptive chunking is currently in catch-up mode. This helps reduce queue lag immediately after new deltas arrive.

**Data flow**: Takes no arguments → calls `run_commit_tick_with_scope(CommitTickScope::CatchUpOnly)` → returns `()`.

**Call relations**: Triggered from assistant and plan delta handlers right after a push reports ready lines, so the UI can drain backlog faster without waiting for the next periodic tick.

*Call graph*: calls 1 internal fn (run_commit_tick_with_scope); called by 2 (handle_streaming_delta, on_plan_delta).


##### `ChatWidget::run_commit_tick_with_scope`  (lines 326–349)

```
fn run_commit_tick_with_scope(&mut self, scope: CommitTickScope)
```

**Purpose**: Drains queued streamed lines from assistant and plan controllers according to the requested pacing scope, inserts committed cells into history, updates the active tail, and stops animation/restores status when all controllers go idle.

**Data flow**: Consumes `scope`, captures `now = Instant::now()`, and calls the free `run_commit_tick(&mut adaptive_chunking, stream_controller.as_mut(), plan_stream_controller.as_mut(), scope, now)` helper. For each returned cell it hides the status indicator and adds the cell to history. It then syncs the active stream tail. If the outcome says a controller exists and all are idle, it calls `maybe_restore_status_indicator_after_stream_idle()` and sends `AppEvent::StopCommitAnimation`. If `turn_lifecycle.agent_turn_running` is true, it refreshes runtime metrics.

**Call relations**: This is the central commit-drain routine used by both periodic and catch-up ticks. It sits between low-level stream controllers and visible transcript/history updates.

*Call graph*: calls 2 internal fn (maybe_restore_status_indicator_after_stream_idle, sync_active_stream_tail); called by 2 (run_catch_up_commit_tick, run_commit_tick); 1 external calls (now).


##### `ChatWidget::flush_interrupt_queue`  (lines 351–355)

```
fn flush_interrupt_queue(&mut self)
```

**Purpose**: Executes all deferred interrupts in FIFO order once streaming has reached a safe point. It temporarily takes ownership of the interrupt manager to satisfy borrowing rules.

**Data flow**: Moves `self.interrupts` out with `std::mem::take`, calls `mgr.flush_all(self)`, then writes the manager back into `self.interrupts` → mutates widget state according to queued interrupt handlers.

**Call relations**: Called from `handle_stream_finished` after non-exec content has been inserted, ensuring deferred interrupts are processed only after stream writes complete.

*Call graph*: called by 1 (handle_stream_finished); 1 external calls (take).


##### `ChatWidget::defer_or_handle`  (lines 358–371)

```
fn defer_or_handle(
        &mut self,
        push: impl FnOnce(&mut InterruptManager),
        handle: impl FnOnce(&mut Self),
    )
```

**Purpose**: Either queues an interrupt-like action or handles it immediately, preserving deterministic FIFO ordering once any interrupt has been deferred. Active assistant streaming forces deferral.

**Data flow**: Consumes two closures: `push` for enqueueing into `InterruptManager` and `handle` for immediate execution. Reads whether `self.stream_controller.is_some()` or `!self.interrupts.is_empty()` → if either is true, invokes `push(&mut self.interrupts)`; otherwise invokes `handle(self)`.

**Call relations**: Used by external event handlers that may need to postpone state mutations until after streaming writes finish, preventing reordering such as `ExecEnd` arriving before a deferred `ExecBegin` is applied.


##### `ChatWidget::handle_stream_finished`  (lines 373–380)

```
fn handle_stream_finished(&mut self)
```

**Purpose**: Performs post-stream cleanup once a non-exec stream has completed. It clears any pending task-complete footer suppression and flushes deferred interrupts.

**Data flow**: Reads `self.task_complete_pending` → if true, hides the status indicator and resets the flag to `false`. Then calls `flush_interrupt_queue()` → mutates footer visibility and interrupt queue state.

**Call relations**: Called from `finalize_completed_assistant_message` after the assistant stream has been flushed, marking the point where deferred interrupts become safe to apply.

*Call graph*: calls 1 internal fn (flush_interrupt_queue); called by 1 (finalize_completed_assistant_message).


##### `ChatWidget::handle_streaming_delta`  (lines 383–416)

```
fn handle_streaming_delta(&mut self, delta: String)
```

**Purpose**: Main assistant-stream ingestion path. It records visible activity, initializes the assistant stream controller when needed, inserts a final-message separator between turns when appropriate, pushes the delta, starts commit animation, updates the active tail, and requests redraw.

**Data flow**: Consumes `delta: String`; for non-empty deltas it records visible turn activity. If no `stream_controller` exists, it flushes unified exec waiting and any active cell, conditionally inserts `history_cell::FinalMessageSeparator` based on transcript flags, resets the separator flag, and creates `StreamController::new(current_stream_width(2), &config.cwd, history_render_mode())`. It then pushes the delta into the controller; if `push` reports ready lines, sends `AppEvent::StartCommitAnimation` and runs `run_catch_up_commit_tick()`. Finally it syncs the active stream tail and requests redraw.

**Call relations**: Called by raw assistant delta events and by assistant-message finalization when a non-streamed final payload still needs to be rendered through the same path.

*Call graph*: calls 4 internal fn (run_catch_up_commit_tick, sync_active_stream_tail, new, new); called by 2 (finalize_completed_assistant_message, on_agent_message_delta).


##### `ChatWidget::active_cell_is_stream_tail`  (lines 418–423)

```
fn active_cell_is_stream_tail(&self) -> bool
```

**Purpose**: Checks whether the transcript’s current active cell is one of the temporary streaming tail cell types. It recognizes both assistant and plan tails by downcasting.

**Data flow**: Reads `self.transcript.active_cell`, and if present tests whether `cell.as_any().is::<history_cell::StreamingAgentTailCell>()` or `...StreamingPlanTailCell>()` → returns a boolean.

**Call relations**: Used by tail-management helpers to avoid clearing or reporting unrelated active cells.

*Call graph*: called by 2 (clear_active_stream_tail, has_active_stream_tail).


##### `ChatWidget::has_active_stream_tail`  (lines 425–428)

```
fn has_active_stream_tail(&self) -> bool
```

**Purpose**: Reports whether there is currently a stream controller and the active transcript cell is its temporary tail. This is stricter than checking the active cell alone.

**Data flow**: Reads whether `self.stream_controller` or `self.plan_stream_controller` is `Some`, then combines that with `active_cell_is_stream_tail()` → returns the conjunction.

**Call relations**: Used by external code that needs to know whether a visible stream tail is actively attached to a live stream.

*Call graph*: calls 1 internal fn (active_cell_is_stream_tail).


##### `ChatWidget::sync_active_stream_tail`  (lines 430–465)

```
fn sync_active_stream_tail(&mut self)
```

**Purpose**: Keeps `transcript.active_cell` synchronized with the current assistant or plan stream tail lines. It creates the appropriate temporary tail cell, hides the footer while a tail is visible, and clears the tail when no lines remain.

**Data flow**: First checks `self.stream_controller.as_ref()`: if present, reads `current_tail_lines()`, clears the active tail and returns if empty, otherwise hides the status indicator, stores a new `history_cell::StreamingAgentTailCell::new(tail_lines, controller.tail_starts_stream())` in `transcript.active_cell`, and bumps the active-cell revision. If no assistant controller exists, it repeats the same pattern for `plan_stream_controller`, using `current_tail_display_lines()` and `StreamingPlanTailCell::new(tail_lines, !controller.tail_starts_stream())`. If neither controller exists, it clears the active tail.

**Call relations**: Called after assistant deltas, plan deltas, and commit ticks so the visible tail cell always reflects the latest queued-but-uncommitted stream content.

*Call graph*: calls 3 internal fn (clear_active_stream_tail, new, new); called by 3 (handle_streaming_delta, on_plan_delta, run_commit_tick_with_scope); 1 external calls (new).


##### `ChatWidget::clear_active_stream_tail`  (lines 467–472)

```
fn clear_active_stream_tail(&mut self)
```

**Purpose**: Removes the active transcript cell only when it is one of the temporary stream-tail cells. This avoids accidentally clearing unrelated active cells.

**Data flow**: Checks `active_cell_is_stream_tail()` → if true, sets `self.transcript.active_cell = None` and bumps the active-cell revision; otherwise leaves state unchanged.

**Call relations**: Used during stream finalization and tail synchronization whenever the current tail disappears or is being replaced.

*Call graph*: calls 1 internal fn (active_cell_is_stream_tail); called by 3 (flush_answer_stream_with_separator, on_plan_item_completed, sync_active_stream_tail).


### `tui/src/app/agent_message_consolidation.rs`

`domain_logic` · `stream finalization / transcript update`

This module contains the post-stream consolidation logic for agent responses. During streaming, the UI may accumulate multiple provisional `AgentMessageCell`s in `App::transcript_cells` so it can animate output incrementally. Once the response is finalized, `handle_consolidate_agent_message` replaces that trailing run with a single `history_cell::AgentMarkdownCell` built from the full markdown source and the working directory used for link/path resolution.

The method first optionally inserts a deferred history cell into both the transcript overlay and the transcript cell list; this preserves ordering for finalize paths that intentionally delay one provisional cell. It then computes the current transcript tail range by calling `trailing_run_start::<history_cell::AgentMessageCell>`, which finds the contiguous suffix of stream cells to replace. If such a range exists, it splices in one consolidated `Arc<dyn HistoryCell>`, mirrors the replacement into the transcript overlay via `consolidate_cells`, schedules a redraw, and finishes any required scrollback reflow. If no matching tail exists, it skips replacement and only completes any pending stream reflow.

The companion helper `finish_agent_message_consolidation` translates the `ConsolidationScrollbackReflow` enum into either conditional or mandatory reflow completion, keeping the main method focused on transcript mutation rather than reflow policy.

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

**Purpose**: Replaces the trailing run of provisional streaming agent-message cells with one finalized markdown-backed history cell and updates overlay state to match.

**Data flow**: Takes finalized markdown `source`, `cwd`, a `scrollback_reflow` policy, and an optional deferred history cell. If a deferred cell is present, it converts it into `Arc<dyn HistoryCell>`, inserts it into the transcript overlay if active, and pushes it into `self.transcript_cells`. It then computes the `[start..end)` suffix of `AgentMessageCell`s, constructs an `AgentMarkdownCell` from `source` and `cwd`, splices that single cell into `self.transcript_cells`, mirrors the consolidation into the transcript overlay, schedules a frame, and finishes reflow according to policy. If no suffix exists, it only attempts to finish stream reflow.

**Call relations**: This method is called when a streaming agent response reaches its finalized form. It delegates tail detection to `trailing_run_start`, cell construction to `AgentMarkdownCell::new`, overlay synchronization to `consolidate_cells`, and reflow completion to `finish_agent_message_consolidation` or `maybe_finish_stream_reflow`.

*Call graph*: calls 2 internal fn (finish_agent_message_consolidation, new); 4 external calls (new, frame_requester, once, debug!).


##### `App::finish_agent_message_consolidation`  (lines 76–91)

```
fn finish_agent_message_consolidation(
        &mut self,
        tui: &mut tui::Tui,
        scrollback_reflow: ConsolidationScrollbackReflow,
    ) -> Result<()>
```

**Purpose**: Applies the requested scrollback reflow policy after transcript consolidation completes.

**Data flow**: Reads the `ConsolidationScrollbackReflow` enum and either calls `maybe_finish_stream_reflow` for conditional completion or `finish_required_stream_reflow` when reflow must happen. It returns `Result<()>` from the delegated reflow operation.

**Call relations**: This helper is called only by `handle_consolidate_agent_message`. It isolates the policy switch so the consolidation method can focus on transcript and overlay mutation.

*Call graph*: called by 1 (handle_consolidate_agent_message).


### `tui/src/transcript_reflow.rs`

`domain_logic` · `request handling`

This file defines the resize-reflow bookkeeping used by the TUI when terminal-owned scrollback must be reconstructed from Codex’s in-memory transcript cells. The central type, `TranscriptReflowState`, deliberately separates `last_observed_width` from `last_reflow_width`: a terminal may report one width during a draw and settle on another after Codex has already rebuilt history, so the code must distinguish “seen” from “actually repaired.” It also stores `pending_reflow_width` and `pending_until` to implement trailing debounce with the fixed `TRANSCRIPT_REFLOW_DEBOUNCE` interval of 75 ms.

The other axis of state is stream finalization. `ran_during_stream` records that a rebuild happened while output was still transient, and `resize_requested_during_stream` records that a resize occurred before stream cells were consolidated into source-backed history. The invariant is that either condition forces exactly one final post-stream reflow, drained by `take_stream_finish_reflow_needed`. Width-only and height-only rebuild scheduling are both represented: `schedule_debounced(Some(width))` reserves a width-targeted repair, while `schedule_debounced(None)` or `schedule_immediate()` can request a rebuild without claiming a width. The module does not render or clear terminal content itself; it only exposes enough state for higher-level resize-reflow code to decide when to rebuild and when a request has been satisfied.

#### Function details

##### `TranscriptReflowState::clear`  (lines 42–44)

```
fn clear(&mut self)
```

**Purpose**: Resets the entire reflow state machine back to its default, forgetting observed widths, pending deadlines, and stream-related repair flags.

**Data flow**: Takes `&mut self`, overwrites the whole struct with `Self::default()`, and returns `()`. This clears `last_observed_width`, `last_reflow_width`, `pending_reflow_width`, `pending_until`, `ran_during_stream`, and `resize_requested_during_stream` in one step.

**Call relations**: Used when transcript state is discarded so later draws do not rebuild from stale resize metadata. It delegates only to the derived default constructor to guarantee a clean baseline.

*Call graph*: 1 external calls (default).


##### `TranscriptReflowState::note_width`  (lines 51–60)

```
fn note_width(&mut self, width: u16) -> TranscriptWidthChange
```

**Purpose**: Records the width seen during a draw and reports whether this width initialized the state or changed from the previous observed width.

**Data flow**: Consumes a `width: u16`, replaces `last_observed_width`, and if this is the first width ever seen also seeds `last_reflow_width` to the same value. It returns a `TranscriptWidthChange` with `initialized` true on first observation and `changed` true only when a prior width existed and differs.

**Call relations**: Called by higher-level draw/resize logic before deciding whether to schedule repair work. It is intentionally conservative on first draw so initialization does not trigger a pointless rebuild.


##### `TranscriptReflowState::reflow_needed_for_width`  (lines 68–70)

```
fn reflow_needed_for_width(&self, width: u16) -> bool
```

**Purpose**: Answers whether a rebuild is still needed for a specific width, comparing against actual rebuilt width rather than merely observed width.

**Data flow**: Reads `last_reflow_width` and `pending_reflow_width`, compares both to the input `width`, and returns `true` only if the transcript has neither already been rebuilt at that width nor already scheduled for that width.

**Call relations**: Used by resize scheduling code to avoid duplicate requests while still allowing a second repair when the terminal settles on a width that was observed but not yet actually rebuilt.


##### `TranscriptReflowState::schedule_debounced`  (lines 78–85)

```
fn schedule_debounced(&mut self, target_width: Option<u16>) -> bool
```

**Purpose**: Schedules a trailing-debounced reflow deadline, optionally associating the pending work with a target width.

**Data flow**: Reads the current time with `Instant::now()`, optionally stores `target_width` into `pending_reflow_width`, sets `pending_until` to now plus `TRANSCRIPT_REFLOW_DEBOUNCE`, and returns `false`. Existing deadlines are overwritten, effectively postponing the rebuild.

**Call relations**: Invoked by resize handling when repeated terminal size changes should collapse into one later rebuild. It delegates only to time acquisition; the caller decides when to poll `pending_is_due` and perform the actual reflow.

*Call graph*: 1 external calls (now).


##### `TranscriptReflowState::schedule_immediate`  (lines 91–94)

```
fn schedule_immediate(&mut self)
```

**Purpose**: Marks a reflow as due immediately on the next draw opportunity, without reserving a specific width target.

**Data flow**: Clears `pending_reflow_width`, sets `pending_until` to `Instant::now()`, and returns `()`. The resulting state makes `pending_is_due` true as soon as checked with a current or later timestamp.

**Call relations**: Used after stream consolidation when waiting for debounce would leave transiently wrapped rows visible. It bypasses width suppression so a source-backed rebuild can happen right away.

*Call graph*: 1 external calls (now).


##### `TranscriptReflowState::set_due_for_test`  (lines 97–99)

```
fn set_due_for_test(&mut self)
```

**Purpose**: For tests only, forces the pending deadline into the past so due-state assertions do not need to sleep.

**Data flow**: Writes `pending_until` as `Instant::now() - 1ms` and returns `()`. It does not touch width or stream flags.

**Call relations**: Only test code uses this helper to simulate an expired debounce interval deterministically.

*Call graph*: 2 external calls (from_millis, now).


##### `TranscriptReflowState::pending_is_due`  (lines 101–103)

```
fn pending_is_due(&self, now: Instant) -> bool
```

**Purpose**: Checks whether a pending reflow deadline has been reached.

**Data flow**: Reads `pending_until` and compares it to the supplied `now: Instant`, returning `true` when a deadline exists and `now >= deadline`.

**Call relations**: Called by outer scheduling logic that owns the draw loop and decides when deferred repair work should actually run.


##### `TranscriptReflowState::pending_until`  (lines 105–107)

```
fn pending_until(&self) -> Option<Instant>
```

**Purpose**: Exposes the currently scheduled reflow deadline, if any.

**Data flow**: Returns the stored `Option<Instant>` from `pending_until` without mutation.

**Call relations**: Primarily useful to callers and tests that need to inspect or compare the debounce deadline.


##### `TranscriptReflowState::has_pending_reflow`  (lines 109–111)

```
fn has_pending_reflow(&self) -> bool
```

**Purpose**: Reports whether any reflow is currently scheduled.

**Data flow**: Reads `pending_until` and returns `true` if it is `Some(_)`, otherwise `false`.

**Call relations**: Used by higher-level orchestration to know whether resize repair work is outstanding at all.


##### `TranscriptReflowState::clear_pending_reflow`  (lines 113–116)

```
fn clear_pending_reflow(&mut self)
```

**Purpose**: Cancels any scheduled reflow and forgets its associated target width.

**Data flow**: Sets both `pending_until` and `pending_reflow_width` to `None`, returning `()`. It leaves observed/reflowed widths and stream flags untouched.

**Call relations**: Called after a pending request is abandoned or superseded so the same width can be scheduled again later.


##### `TranscriptReflowState::mark_reflowed_width`  (lines 123–125)

```
fn mark_reflowed_width(&mut self, width: u16) -> bool
```

**Purpose**: Records the width at which transcript scrollback was actually rebuilt and reports whether that changed the remembered rebuilt width.

**Data flow**: Replaces `last_reflow_width` with the input `width` and returns `true` if the previous value was different or absent, `false` if it was already the same width.

**Call relations**: Used after the real rebuild completes so future `reflow_needed_for_width` checks compare against the width that truly repaired scrollback.


##### `TranscriptReflowState::mark_ran_during_stream`  (lines 132–134)

```
fn mark_ran_during_stream(&mut self)
```

**Purpose**: Marks that a reflow occurred while stream output was still transient and therefore may need a later source-backed repair.

**Data flow**: Sets `ran_during_stream` to `true` and returns `()`. No other fields are modified.

**Call relations**: Called by stream-aware resize logic when a rebuild happens before consolidation, so finalization can trigger one more authoritative reflow.


##### `TranscriptReflowState::mark_resize_requested_during_stream`  (lines 142–144)

```
fn mark_resize_requested_during_stream(&mut self)
```

**Purpose**: Marks that a resize requiring repair happened while streaming or before transient cells were consolidated.

**Data flow**: Sets `resize_requested_during_stream` to `true` and returns `()`. Width/deadline state is preserved.

**Call relations**: Used when debounce may outlive the stream itself; this flag ensures consolidation still notices that a final source-backed repair is owed.


##### `TranscriptReflowState::take_stream_finish_reflow_needed`  (lines 151–156)

```
fn take_stream_finish_reflow_needed(&mut self) -> bool
```

**Purpose**: Drains and returns whether stream completion must trigger one final source-backed reflow.

**Data flow**: Reads `ran_during_stream` and `resize_requested_during_stream`, computes `needed` as their logical OR, then resets both flags to `false` and returns `needed`.

**Call relations**: Called by stream-consolidation code after transient cells become durable history. Its draining behavior enforces the design choice that each stream episode causes at most one post-finish repair.


##### `TranscriptReflowState::clear_stream_flags`  (lines 162–165)

```
fn clear_stream_flags(&mut self)
```

**Purpose**: Clears only the stream-related repair flags while preserving width tracking and pending debounce state.

**Data flow**: Sets `ran_during_stream` and `resize_requested_during_stream` to `false`, returning `()`. It does not alter widths or deadlines.

**Call relations**: Used after a required final stream reflow has completed, avoiding the broader reset that `clear()` would perform.


##### `tests::schedule_debounced_postpones_existing_reflow`  (lines 182–195)

```
fn schedule_debounced_postpones_existing_reflow()
```

**Purpose**: Verifies that scheduling a second debounced reflow pushes the deadline later instead of keeping the original one.

**Data flow**: Creates a default state, schedules a reflow, captures the first deadline, sleeps briefly, schedules again, and asserts the new `pending_until` is greater.

**Call relations**: Exercises `schedule_debounced`’s trailing-debounce behavior under repeated resize-like requests.

*Call graph*: 4 external calls (from_millis, assert!, sleep, default).


##### `tests::schedule_debounced_postpones_due_existing_reflow`  (lines 198–208)

```
fn schedule_debounced_postpones_due_existing_reflow()
```

**Purpose**: Checks that rescheduling after an already-due request starts a fresh debounce window in the future.

**Data flow**: Builds default state, forces a past-due deadline with `set_due_for_test`, records current time, reschedules, and asserts the new deadline is after that timestamp.

**Call relations**: Confirms that `schedule_debounced` does not preserve stale due deadlines.

*Call graph*: 3 external calls (now, assert!, default).


##### `tests::first_observed_width_marks_reflow_baseline`  (lines 211–220)

```
fn first_observed_width_marks_reflow_baseline()
```

**Purpose**: Ensures the first observed width initializes both observed and rebuilt-width baselines without requiring reflow.

**Data flow**: Creates default state, calls `note_width(80)`, then asserts `initialized` is true, both width fields are `Some(80)`, and `reflow_needed_for_width(80)` is false.

**Call relations**: Documents the invariant that first draw initialization is not treated as a resize.

*Call graph*: 3 external calls (assert!, assert_eq!, default).


##### `tests::mark_reflowed_width_records_actual_rebuild_width`  (lines 223–231)

```
fn mark_reflowed_width_records_actual_rebuild_width()
```

**Purpose**: Confirms that actual rebuilt width can diverge from last observed width and is stored separately.

**Data flow**: Initializes width at 80, calls `mark_reflowed_width(100)`, and asserts observed width remains 80 while rebuilt width becomes 100.

**Call relations**: Validates the module’s core distinction between observed and repaired widths.

*Call graph*: 3 external calls (assert!, assert_eq!, default).


##### `tests::reflow_needed_compares_against_actual_rebuild_width`  (lines 234–241)

```
fn reflow_needed_compares_against_actual_rebuild_width()
```

**Purpose**: Checks that reflow necessity is based on `last_reflow_width`, not merely the latest observed width.

**Data flow**: Observes width 80, marks rebuilt width 90, then observes width 100 and asserts `reflow_needed_for_width(100)` is true.

**Call relations**: Covers the case where the terminal reports a width that has been seen but not yet repaired.

*Call graph*: 2 external calls (assert!, default).


##### `tests::pending_reflow_target_prevents_repeated_reschedule`  (lines 244–252)

```
fn pending_reflow_target_prevents_repeated_reschedule()
```

**Purpose**: Verifies that once a width-targeted reflow is pending, the same width is no longer considered in need of scheduling.

**Data flow**: Observes width 80, confirms width 100 needs reflow, schedules a debounced target for 100, then asserts `reflow_needed_for_width(100)` becomes false.

**Call relations**: Tests the suppression effect of `pending_reflow_width`.

*Call graph*: 2 external calls (assert!, default).


##### `tests::clear_pending_reflow_allows_same_width_to_be_rescheduled`  (lines 255–263)

```
fn clear_pending_reflow_allows_same_width_to_be_rescheduled()
```

**Purpose**: Ensures clearing pending state reopens the ability to schedule the same width again.

**Data flow**: Observes width 80, schedules width 100, clears pending state, and asserts width 100 once again reports as needing reflow.

**Call relations**: Demonstrates that `clear_pending_reflow` removes width-target suppression.

*Call graph*: 2 external calls (assert!, default).


##### `tests::mark_reflowed_width_reports_unchanged_width`  (lines 266–272)

```
fn mark_reflowed_width_reports_unchanged_width()
```

**Purpose**: Checks the boolean return from `mark_reflowed_width`, distinguishing first-set/change from no-op repeat.

**Data flow**: Calls `mark_reflowed_width(100)` twice and asserts the first returns true, the second false, with stored width remaining 100.

**Call relations**: Documents the function’s change-detection contract.

*Call graph*: 3 external calls (assert!, assert_eq!, default).


##### `tests::take_stream_finish_reflow_needed_drains_resize_request`  (lines 275–281)

```
fn take_stream_finish_reflow_needed_drains_resize_request()
```

**Purpose**: Verifies that a resize-during-stream request produces exactly one drained post-stream repair signal.

**Data flow**: Marks `resize_requested_during_stream`, calls `take_stream_finish_reflow_needed()` twice, and asserts true then false.

**Call relations**: Tests the one-shot semantics of the resize-during-stream flag.

*Call graph*: 2 external calls (assert!, default).


##### `tests::take_stream_finish_reflow_needed_drains_ran_during_stream`  (lines 284–290)

```
fn take_stream_finish_reflow_needed_drains_ran_during_stream()
```

**Purpose**: Verifies that a mid-stream reflow also produces exactly one drained post-stream repair signal.

**Data flow**: Marks `ran_during_stream`, calls `take_stream_finish_reflow_needed()` twice, and asserts true then false.

**Call relations**: Covers the second source of final stream repair demand.

*Call graph*: 2 external calls (assert!, default).


##### `tests::clear_resets_stream_reflow_flags`  (lines 293–301)

```
fn clear_resets_stream_reflow_flags()
```

**Purpose**: Checks that a full state reset removes both stream-related repair flags.

**Data flow**: Sets both stream flags, calls `clear()`, then asserts `take_stream_finish_reflow_needed()` returns false.

**Call relations**: Confirms that `clear()` fully discards pending stream repair state along with width/debounce metadata.

*Call graph*: 2 external calls (assert!, default).


### `tui/src/app/resize_reflow.rs`

`orchestration` · `request handling and redraw/pre-render during terminal resize, replay, stream consolidation, and rollback`

This file is the TUI’s transcript reflow engine. Its core job is to regenerate terminal scrollback from `self.transcript_cells: Vec<Arc<dyn HistoryCell>>` whenever width or height changes make previously emitted rows invalid. The module keeps rendering line-oriented via `HyperlinkLine`, because the terminal accepts already wrapped rows, while `HistoryCell`s remain the source of truth. `ReflowCellDisplay` and `ReflowRenderResult` are transient render products used during rebuilds.

A key invariant is separator insertion: non-stream-continuation cells get a blank line before them except for the first emitted history item. That state is tracked by `has_emitted_history_lines`, and reset whenever the terminal is cleared or pending reflow is abandoned. Reflow can be row-capped; to avoid formatting the whole backlog, `render_transcript_lines_for_reflow` walks backward from the transcript tail, then extends upward if the retained suffix starts inside a stream-continuation run so separators are not misapplied.

The file also handles deferred history insertion when overlays own rendering, startup buffering for large resume replays, and a special thread-switch buffering mode that skips per-cell writes and instead renders only the retained transcript tail once replay completes. Resize work is debounced through `self.transcript_reflow`; stream-time resizes are marked so consolidation can force one final source-backed rebuild after transient stream cells are replaced by finalized cells. Terminal clearing differs between alt-screen and normal screen, and rollback rebuilds always clear even when no cells remain so removed prompts disappear from scrollback.

#### Function details

##### `trailing_run_start`  (lines 47–66)

```
fn trailing_run_start(transcript_cells: &[Arc<dyn HistoryCell>]) -> usize
```

**Purpose**: Finds the start index of the trailing run of transcript cells of a specific concrete `HistoryCell` type, including the leading non-continuation cell if present. This lets callers detect whether the transcript tail still contains unconsolidated stream cells.

**Data flow**: Reads a slice of `Arc<dyn HistoryCell>` and inspects each trailing element with `is_stream_continuation()` and `as_any().is::<T>()`. It walks backward over continuation cells of type `T`, then optionally includes one preceding non-continuation cell of the same type. It returns the computed start index into the original slice.

**Call relations**: Used indirectly by stream-time resize logic through `App::should_mark_reflow_as_stream_time`, where the app needs to know whether trailing `AgentMessageCell` or `ProposedPlanStreamCell` instances are still present after a controller has stopped but before consolidation has replaced them.


##### `App::reset_history_emission_state`  (lines 69–72)

```
fn reset_history_emission_state(&mut self)
```

**Purpose**: Resets separator-emission bookkeeping for transcript history output. It clears both the boolean that tracks whether any history has been emitted and any deferred lines waiting behind an overlay.

**Data flow**: Mutates `self.has_emitted_history_lines` to `false` and empties `self.deferred_history_lines`. It returns no value.

**Call relations**: Called when pending resize work is discarded without a terminal, when rollback leaves no transcript, and when immediate reflow finds no cells. In each case the caller has invalidated prior emission context and needs future inserts to behave as if history output is starting fresh.

*Call graph*: called by 3 (maybe_clear_resize_reflow_without_terminal, rebuild_transcript_after_backtrack, reflow_transcript_now).


##### `App::display_lines_for_history_insert`  (lines 74–89)

```
fn display_lines_for_history_insert(
        &mut self,
        cell: &dyn HistoryCell,
        width: u16,
    ) -> Vec<HyperlinkLine>
```

**Purpose**: Renders one `HistoryCell` into wrapped `HyperlinkLine`s for the current history render mode and inserts the blank separator line required between top-level history items. Stream continuations deliberately skip separator insertion.

**Data flow**: Takes `&dyn HistoryCell` and a wrap `width`, reads `self.chat_widget.history_render_mode()` and `self.has_emitted_history_lines`, calls the cell’s `display_hyperlink_lines_for_mode`, and conditionally prepends `HyperlinkLine::new(Line::from(""))`. It updates `self.has_emitted_history_lines` when the first non-empty non-continuation cell is emitted and returns the rendered line vector.

**Call relations**: This is the shared rendering helper for both direct history insertion and startup replay insertion. Its callers rely on it to keep separator behavior identical across normal incremental output and buffered replay paths.

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

**Purpose**: Inserts a rendered history cell into terminal scrollback immediately, unless an overlay is active, in which case it defers the rendered lines. Empty render results are ignored.

**Data flow**: Accepts `&mut tui::Tui`, a `HistoryCell`, and width; obtains rendered lines from `display_lines_for_history_insert`. If the result is empty it returns early. Otherwise it either appends lines to `self.deferred_history_lines` when `self.overlay` is present or writes them to the terminal via `insert_history_hyperlink_lines_with_wrap_policy` using `self.history_line_wrap_policy()`.

**Call relations**: Used by higher-level transcript emission paths when finalized cells are appended during normal operation. It delegates rendering and wrap-policy selection locally, and branches on overlay ownership so resize-sensitive output is not written to the wrong surface.

*Call graph*: calls 2 internal fn (display_lines_for_history_insert, history_line_wrap_policy); 1 external calls (insert_history_hyperlink_lines_with_wrap_policy).


##### `App::begin_initial_history_replay_buffer`  (lines 117–121)

```
fn begin_initial_history_replay_buffer(&mut self)
```

**Purpose**: Starts buffering startup resume replay rows before they are written to terminal scrollback. This allows startup replay to obey the same row-cap semantics as later resize rebuilds.

**Data flow**: Checks `self.overlay`; if no overlay is active, sets `self.initial_history_replay_buffer` to a default `InitialHistoryReplayBuffer`. Otherwise it leaves state unchanged.

**Call relations**: Invoked during startup replay setup. It intentionally refuses to split transcript ownership with overlays, so overlay-driven replay continues through the normal deferred-history path instead of this buffer.

*Call graph*: 1 external calls (default).


##### `App::begin_thread_switch_history_replay_buffer`  (lines 128–135)

```
fn begin_thread_switch_history_replay_buffer(&mut self)
```

**Purpose**: Starts a special replay buffer for thread switches that postpones terminal writes until replay is complete and then renders only the retained transcript tail. This avoids formatting and inserting every historical cell when a row cap exists.

**Data flow**: Reads `self.resize_reflow_max_rows()` and `self.overlay`. If a row cap exists and no overlay is active, it installs an `InitialHistoryReplayBuffer` with an empty `VecDeque` and `render_from_transcript_tail: true`; otherwise it does nothing.

**Call relations**: Used during thread-switch replay setup. Its later counterpart `finish_initial_history_replay_buffer` detects `render_from_transcript_tail` and delegates to full transcript-tail rendering instead of flushing buffered per-cell lines.

*Call graph*: calls 1 internal fn (resize_reflow_max_rows); 1 external calls (new).


##### `App::finish_initial_history_replay_buffer`  (lines 142–166)

```
fn finish_initial_history_replay_buffer(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Flushes buffered startup or thread-switch replay output into terminal scrollback. In transcript-tail mode it renders from `self.transcript_cells` at the end instead of replaying retained per-cell rows.

**Data flow**: Takes ownership of `self.initial_history_replay_buffer`. If absent, it returns. If the buffer has no retained lines but `render_from_transcript_tail` is true, it reads the terminal width, calls `render_transcript_lines_for_reflow`, and inserts the resulting lines with the current wrap policy. Otherwise it collects `retained_lines` into a `Vec` and inserts them directly.

**Call relations**: Called after initial replay completes. It is the sink for both buffering modes started by `begin_initial_history_replay_buffer` and `begin_thread_switch_history_replay_buffer`, choosing between direct retained-row flush and source-backed tail rendering.

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

**Purpose**: Routes replay-time history insertion through the active initial replay buffer, enforcing row caps on buffered display lines and avoiding writes when thread-switch replay will render from the transcript tail later.

**Data flow**: Accepts `tui`, `cell`, and `width`. If the active buffer is in `render_from_transcript_tail` mode, it returns immediately. Otherwise it renders the cell via `display_lines_for_history_insert`; empty output is ignored. With a buffer present and a row cap, it trims via `buffer_initial_history_replay_display_lines`; without a cap it either defers to `self.deferred_history_lines` if an overlay exists or writes directly to the terminal using `history_line_wrap_policy()`.

**Call relations**: Used during startup replay insertion. It mirrors normal insertion behavior but interposes buffering logic so startup replay and later resize rebuilds retain the same tail rows under capped scrollback.

*Call graph*: calls 3 internal fn (display_lines_for_history_insert, history_line_wrap_policy, resize_reflow_max_rows); 2 external calls (buffer_initial_history_replay_display_lines, insert_history_hyperlink_lines_with_wrap_policy).


##### `App::history_line_wrap_policy`  (lines 203–209)

```
fn history_line_wrap_policy(&self) -> HistoryLineWrapPolicy
```

**Purpose**: Chooses whether history lines should be pre-wrapped by the app or wrapped by the terminal. Raw output mode uses terminal wrapping; normal chat mode uses pre-wrapped lines.

**Data flow**: Reads `self.chat_widget.raw_output_mode()` and returns either `HistoryLineWrapPolicy::Terminal` or `HistoryLineWrapPolicy::PreWrap`.

**Call relations**: This small policy helper is used by all terminal insertion paths in this file so startup replay, rollback rebuilds, and resize reflow all emit rows with the same wrapping contract.

*Call graph*: called by 5 (finish_initial_history_replay_buffer, insert_history_cell_lines, insert_history_cell_lines_with_initial_replay_buffer, rebuild_transcript_after_backtrack, reflow_transcript_now).


##### `App::buffer_initial_history_replay_display_lines`  (lines 216–225)

```
fn buffer_initial_history_replay_display_lines(
        buffer: &mut InitialHistoryReplayBuffer,
        display: Vec<HyperlinkLine>,
        max_rows: usize,
    )
```

**Purpose**: Appends rendered replay rows to the startup buffer while enforcing a maximum retained row count by dropping the oldest rows first. The trimming happens at the display-line level, not by removing source cells.

**Data flow**: Takes a mutable `InitialHistoryReplayBuffer`, a `Vec<HyperlinkLine>`, and `max_rows`. It extends `buffer.retained_lines` with the new lines, then repeatedly pops from the front until the deque length is at most `max_rows`. It returns no value.

**Call relations**: Used by replay insertion when a resize reflow row cap is configured. Keeping this logic local to rendered rows preserves full transcript source for copy, overlays, and future rebuilds.


##### `App::schedule_resize_reflow`  (lines 227–229)

```
fn schedule_resize_reflow(&mut self, target_width: Option<u16>) -> bool
```

**Purpose**: Schedules a debounced transcript reflow for a target width through the app’s `TranscriptReflowState`. It returns whether a new frame should be requested immediately.

**Data flow**: Passes `target_width: Option<u16>` into `self.transcript_reflow.schedule_debounced` and returns that boolean result unchanged.

**Call relations**: Called from draw-size change handling after width or height changes indicate transcript rebuild work. It isolates the debounce-state mutation from the higher-level frame scheduling logic.

*Call graph*: called by 1 (handle_draw_size_change).


##### `App::resize_reflow_max_rows`  (lines 231–233)

```
fn resize_reflow_max_rows(&self) -> Option<usize>
```

**Purpose**: Resolves the configured maximum number of rows that resize reflow and replay buffering should retain. A disabled cap yields `None`.

**Data flow**: Reads `self.config.terminal_resize_reflow` and passes it to `crate::resize_reflow_cap::resize_reflow_max_rows`, returning the resulting `Option<usize>`.

**Call relations**: Queried by startup replay buffering, thread-switch replay buffering, and transcript rendering. It centralizes interpretation of the terminal resize reflow config so all row-capped paths agree.

*Call graph*: calls 1 internal fn (resize_reflow_max_rows); called by 3 (begin_thread_switch_history_replay_buffer, insert_history_cell_lines_with_initial_replay_buffer, render_transcript_lines_for_reflow).


##### `App::clear_terminal_for_resize_replay`  (lines 235–247)

```
fn clear_terminal_for_resize_replay(&mut self, tui: &mut tui::Tui) -> Result<()>
```

**Purpose**: Clears the terminal before replaying rebuilt transcript rows and resets the viewport origin to the top. It uses different clearing behavior depending on whether the alt screen is active.

**Data flow**: Reads terminal state from `tui`. If `is_alt_screen_active()` is true, it clears only the visible screen; otherwise it clears scrollback plus visible screen via ANSI. It then normalizes `tui.terminal.viewport_area.y` to `0` if needed and writes the updated viewport area back. Returns `Result<()>` for terminal I/O failures.

**Call relations**: Used by both resize reflow and rollback rebuilds immediately before reinserting rebuilt transcript lines. The callers depend on it to remove stale rows and ensure replay starts from a consistent viewport origin.

*Call graph*: called by 2 (rebuild_transcript_after_backtrack, reflow_transcript_now); 1 external calls (is_alt_screen_active).


##### `App::maybe_finish_stream_reflow`  (lines 256–264)

```
fn maybe_finish_stream_reflow(&mut self, tui: &mut tui::Tui) -> Result<()>
```

**Purpose**: Completes any deferred resize repair required after stream consolidation. If a resize happened during streaming, it forces an immediate source-backed reflow; otherwise it may simply request a frame when a pending debounce deadline has arrived.

**Data flow**: Reads and clears the stream-finish flag via `self.transcript_reflow.take_stream_finish_reflow_needed()`. If set, it schedules an immediate reflow and runs `maybe_run_resize_reflow`. Otherwise, if a pending reflow is already due at `Instant::now()`, it requests a frame from `tui.frame_requester()`. Returns `Result<()>`.

**Call relations**: Called after transient stream cells have been consolidated or confirmed. It bridges stream lifecycle code to the resize reflow machinery so finalized cells replace stale stream-wrapped rows in scrollback.

*Call graph*: calls 2 internal fn (maybe_run_resize_reflow, schedule_immediate_resize_reflow); 2 external calls (now, frame_requester).


##### `App::schedule_immediate_resize_reflow`  (lines 266–269)

```
fn schedule_immediate_resize_reflow(&mut self, tui: &mut tui::Tui)
```

**Purpose**: Marks transcript reflow as immediately due and requests a frame so the rebuild can run promptly. It is the non-debounced counterpart to normal resize scheduling.

**Data flow**: Mutates `self.transcript_reflow` via `schedule_immediate()` and then calls `tui.frame_requester().schedule_frame()`. It returns no value.

**Call relations**: Used by stream-finalization paths that must not wait for debounce quiet time. Its callers then invoke `maybe_run_resize_reflow` to execute the rebuild on the next pre-render cycle.

*Call graph*: called by 2 (finish_required_stream_reflow, maybe_finish_stream_reflow); 1 external calls (frame_requester).


##### `App::finish_required_stream_reflow`  (lines 276–283)

```
fn finish_required_stream_reflow(&mut self, tui: &mut tui::Tui) -> Result<()>
```

**Purpose**: Forces a strict immediate reflow after stream-finalized output such as a consolidated proposed plan. It also clears stream flags once no further reflow remains pending.

**Data flow**: Schedules immediate reflow, runs `maybe_run_resize_reflow`, then checks `self.transcript_reflow.has_pending_reflow()`. If nothing remains pending, it clears stream flags. Returns `Result<()>`.

**Call relations**: Used by stricter stream consolidation flows where skipping the final rebuild would leave pre-consolidation wrapping visible. It is a stronger variant of `maybe_finish_stream_reflow` that always drives the reflow path.

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

**Purpose**: Processes a newly observed terminal size, updates width tracking, decides whether transcript rebuild is needed, and schedules debounced reflow plus follow-up frames. It also refreshes resize-sensitive widget state and status-line content.

**Data flow**: Takes current `size`, previous `last_known_screen_size`, and a `FrameRequester`. It updates width tracking through `self.transcript_reflow.note_width` and `reflow_needed_for_width`, compares heights, and computes `should_rebuild_transcript`. On width initialization or change it calls `self.chat_widget.on_terminal_resize`. If rebuild is needed, it may mark the resize as stream-time, schedule a debounced reflow with an optional target width, and request either an immediate or delayed frame. If size changed at all it refreshes the status line, then calls `maybe_clear_resize_reflow_without_terminal`. It returns the rebuild-needed boolean.

**Call relations**: Called from `handle_draw_pre_render` before each frame. It is the main decision point that translates raw terminal size changes into transcript reflow scheduling and ancillary UI updates.

*Call graph*: calls 5 internal fn (maybe_clear_resize_reflow_without_terminal, schedule_resize_reflow, should_mark_reflow_as_stream_time, schedule_frame, schedule_frame_in); called by 1 (handle_draw_pre_render).


##### `App::maybe_clear_resize_reflow_without_terminal`  (lines 322–333)

```
fn maybe_clear_resize_reflow_without_terminal(&mut self)
```

**Purpose**: Cancels stale pending resize reflow when there is no terminal-owned transcript to repair. This prevents a deferred reflow from lingering forever in an empty, overlay-free state.

**Data flow**: Reads `self.transcript_reflow.pending_until()`, current time, `self.overlay`, and `self.transcript_cells`. If a pending deadline exists but is already due, no overlay is active, and there are no transcript cells, it clears pending reflow and resets history emission state. Otherwise it leaves state unchanged.

**Call relations**: Invoked at the end of draw-size handling. It is a cleanup path for edge cases where resize scheduling happened before any transcript existed or after transcript state was cleared.

*Call graph*: calls 1 internal fn (reset_history_emission_state); called by 1 (handle_draw_size_change); 1 external calls (now).


##### `App::handle_draw_pre_render`  (lines 335–350)

```
fn handle_draw_pre_render(&mut self, tui: &mut tui::Tui) -> Result<()>
```

**Purpose**: Runs pre-render resize bookkeeping for a frame: samples terminal size, schedules or executes transcript rebuilds, and drops queued history lines that were wrapped for the old viewport. It is the frame-time entrypoint into this module.

**Data flow**: Reads the current terminal size from `tui.terminal.size()`, passes it with `last_known_screen_size` and the frame requester into `handle_draw_size_change`, and if a rebuild is needed clears pending history lines from `tui`. It then calls `maybe_run_resize_reflow` and returns `Result<()>`.

**Call relations**: Called by the app’s draw loop before rendering. It orchestrates size-change detection, stale queued-output invalidation, and execution of any due transcript reflow.

*Call graph*: calls 2 internal fn (handle_draw_size_change, maybe_run_resize_reflow); 2 external calls (clear_pending_history_lines, frame_requester).


##### `App::maybe_run_resize_reflow`  (lines 358–396)

```
fn maybe_run_resize_reflow(&mut self, tui: &mut tui::Tui) -> Result<()>
```

**Purpose**: Executes a pending transcript reflow once its debounce deadline has passed and no overlay is active. It also tracks whether the reflow happened during stream-time state and schedules a cheap follow-up draw to catch terminals that settle width late.

**Data flow**: Reads the pending deadline from `self.transcript_reflow`; if absent it returns. If the deadline is still in the future, it re-arms a delayed frame for the remaining duration and exits. If an overlay is active, it exits without clearing the pending reflow. Otherwise it clears pending reflow, computes whether the reflow is happening during active or trailing stream state, calls `reflow_transcript_now`, records the reflowed width, optionally marks that a reflow ran during stream time, and schedules another frame after `TRANSCRIPT_REFLOW_DEBOUNCE`. Returns `Result<()>`.

**Call relations**: Reached from pre-render handling and stream-finalization paths. It is the executor for work previously scheduled by `handle_draw_size_change` or forced by stream consolidation.

*Call graph*: calls 2 internal fn (reflow_transcript_now, should_mark_reflow_as_stream_time); called by 3 (finish_required_stream_reflow, handle_draw_pre_render, maybe_finish_stream_reflow); 2 external calls (now, frame_requester).


##### `App::reflow_transcript_now`  (lines 398–424)

```
fn reflow_transcript_now(&mut self, tui: &mut tui::Tui) -> Result<u16>
```

**Purpose**: Immediately rebuilds terminal scrollback from `self.transcript_cells` for the current terminal width. It clears stale queued output, clears the terminal, and reinserts freshly rendered transcript lines.

**Data flow**: Reads terminal width from `tui.terminal.size()`, converts it through `self.chat_widget.history_wrap_width`, and checks whether `self.transcript_cells` is empty. If empty, it clears pending history lines, resets history emission state, and returns the terminal width. Otherwise it renders lines via `render_transcript_lines_for_reflow`, clears pending history lines, clears the terminal for replay, empties `self.deferred_history_lines`, inserts the rebuilt lines with `history_line_wrap_policy()`, and returns the terminal width.

**Call relations**: Called only by `maybe_run_resize_reflow` once debounce conditions are satisfied. It is the concrete terminal mutation step of resize reflow.

*Call graph*: calls 4 internal fn (clear_terminal_for_resize_replay, history_line_wrap_policy, render_transcript_lines_for_reflow, reset_history_emission_state); called by 1 (maybe_run_resize_reflow); 2 external calls (clear_pending_history_lines, insert_history_hyperlink_lines_with_wrap_policy).


##### `App::rebuild_transcript_after_backtrack`  (lines 431–453)

```
fn rebuild_transcript_after_backtrack(&mut self, tui: &mut tui::Tui) -> Result<()>
```

**Purpose**: Rebuilds terminal scrollback after rollback/backtrack removes transcript cells. Unlike resize reflow, it always clears the terminal even when the transcript becomes empty so cancelled prompts disappear from scrollback.

**Data flow**: Reads terminal width and computes wrapped width. If `self.transcript_cells` is empty it resets history emission state and uses an empty line vector; otherwise it renders via `render_transcript_lines_for_reflow`. It then clears pending history lines, clears the terminal, empties `self.deferred_history_lines`, inserts rebuilt lines if any, and returns `Result<()>`.

**Call relations**: Used by rollback flows after transcript source has been truncated. It shares most mechanics with resize reflow but differs in its empty-transcript behavior because rollback semantics require removing stale scrollback content.

*Call graph*: calls 4 internal fn (clear_terminal_for_resize_replay, history_line_wrap_policy, render_transcript_lines_for_reflow, reset_history_emission_state); 3 external calls (new, clear_pending_history_lines, insert_history_hyperlink_lines_with_wrap_policy).


##### `App::render_transcript_lines_for_reflow`  (lines 462–523)

```
fn render_transcript_lines_for_reflow(&mut self, width: u16) -> ReflowRenderResult
```

**Purpose**: Renders the transcript source into wrapped `HyperlinkLine`s suitable for replay into terminal scrollback, honoring the configured row cap and preserving stream-continuation grouping. It reconstructs separators after collecting the retained cell suffix and trims final rows exactly to the cap.

**Data flow**: Takes a wrap `width`, reads `self.transcript_cells`, `self.chat_widget.history_render_mode()`, and `self.resize_reflow_max_rows()`. It walks backward through transcript cells, rendering each cell’s lines and accumulating `ReflowCellDisplay` entries in a `VecDeque` until the row cap is exceeded or the transcript is exhausted. If the retained suffix begins with a stream continuation, it extends farther backward to include the run’s first cell. It then rebuilds a flat `Vec<HyperlinkLine>` with blank separators before non-continuation cells except the first, trims from the front if the final line count still exceeds the cap, updates `self.has_emitted_history_lines`, and returns `ReflowRenderResult { lines }`.

**Call relations**: This is the central pure-ish rendering routine used by resize reflow, rollback rebuilds, and transcript-tail startup/thread-switch replay. Other functions in the file prepare terminal state around it, but this function decides exactly which rows survive and how they are separated.

*Call graph*: calls 2 internal fn (resize_reflow_max_rows, new); called by 3 (finish_initial_history_replay_buffer, rebuild_transcript_after_backtrack, reflow_transcript_now); 3 external calls (from, new, new).


##### `App::should_mark_reflow_as_stream_time`  (lines 530–537)

```
fn should_mark_reflow_as_stream_time(&self) -> bool
```

**Purpose**: Determines whether current transcript state should be treated as stream-time for resize bookkeeping. It covers both actively streaming controllers and the narrow post-stream window where transient stream cells still trail the transcript.

**Data flow**: Reads `self.chat_widget.has_active_agent_stream()`, `has_active_plan_stream()`, and checks whether trailing runs of `history_cell::AgentMessageCell` or `history_cell::ProposedPlanStreamCell` exist by comparing `trailing_run_start::<T>(&self.transcript_cells)` against the transcript length. Returns `true` if any of those conditions hold.

**Call relations**: Consulted when scheduling resize work and when executing a due reflow. Its result drives stream-time flags that later force a final source-backed rebuild after consolidation.

*Call graph*: called by 2 (handle_draw_size_change, maybe_run_resize_reflow).


### Execution and auxiliary transcript rendering
These files cover execution-cell models and rendering plus adjacent rich renderers used for diffs, directives, overlays, and compact status/footer surfaces.

### `tui/src/exec_cell/mod.rs`

`orchestration` · `interactive UI`

This module root organizes the TUI execution-cell subsystem into two internal parts: `model`, which defines the state and data structures for command execution cells, and `render`, which turns that state into displayable output. The file then re-exports a curated set of crate-visible items. From `model`, it exposes `CommandOutput` and `ExecCell` for general use, and `ExecCall` only under `#[cfg(test)]`, signaling that this type is intended primarily for test construction or assertions rather than production coupling. From `render`, it exposes `OutputLinesParams`, the `TOOL_CALL_MAX_LINES` rendering limit constant, and the helper functions `new_active_exec_command` and `output_lines`. This split indicates a design where execution-cell state is maintained separately from presentation logic, but consumers elsewhere in the TUI can still create active command views and derive line-oriented output without reaching into submodule internals. The file itself contains no executable code; its main role is to define the subsystem boundary and keep the rest of the TUI dependent on a small, stable API instead of the full implementation details of command-output rendering.


### `tui/src/exec_cell/model.rs`

`data_model` · `exec event accumulation / transcript state`

This file contains the stateful model behind exec-related transcript entries. `ExecCall` represents one command invocation with stable `call_id`, raw command argv, parsed command structure, optional `CommandOutput`, execution source, timing fields, and optional interaction input. `ExecCell` groups one or more `ExecCall`s and carries an `animations_enabled` flag used by rendering.

The key design distinction is between ordinary command cells and ‘exploring’ cells. `is_exploring_call` classifies a call as exploratory only when its source is not `UserShell`, its parsed command list is non-empty, and every parsed command is one of `Read`, `ListFiles`, or `Search`. `is_exploring_cell` requires all grouped calls to satisfy that predicate. `with_added_call` only appends a new call when both the existing cell and the new call are exploratory, preserving the invariant that grouped cells are homogeneous exploratory bundles.

Completion and failure handling are explicit. `complete_call` searches calls in reverse so the most recent matching `call_id` wins, then stores output, duration, and clears `start_time`; it returns `false` when no matching call exists so callers can treat that as a routing mismatch rather than silently dropping an event. `append_output` similarly targets the most recent matching call and lazily creates a default `CommandOutput` to accumulate interleaved stdout/stderr chunks. `mark_failed` finalizes any still-active calls with exit code 1, empty outputs, and elapsed duration computed from `start_time` when available.

The remaining accessors expose activity state, active start time, animation preference, and iteration over grouped calls for the rendering layer.

#### Function details

##### `ExecCell::new`  (lines 42–47)

```
fn new(call: ExecCall, animations_enabled: bool) -> Self
```

**Purpose**: Creates a new exec cell containing exactly one initial call and the chosen animation setting.

**Data flow**: Consumes an `ExecCall` and `animations_enabled: bool`, stores the call in a one-element `Vec`, and returns `ExecCell`.

**Call relations**: Used when a new active command first appears before any grouping or completion logic applies.

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

**Purpose**: Attempts to append a new call to an existing cell, but only if both the existing cell and the new call qualify as exploratory.

**Data flow**: Builds a fresh `ExecCall` with the provided identifiers, command data, source, interaction input, `output: None`, `start_time: Some(Instant::now())`, and `duration: None`. If `self.is_exploring_cell()` and `Self::is_exploring_call(&call)` are both true, it returns a new `ExecCell` whose `calls` are the old calls plus the new one; otherwise it returns `None`.

**Call relations**: Used by higher-level exec-event routing when deciding whether a new command should coalesce into an existing exploring transcript cell.

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

**Purpose**: Marks the most recent matching call as finished and reports whether a matching call was found.

**Data flow**: Searches `self.calls` in reverse for `call_id`, and if found writes `Some(output)` into `call.output`, `Some(duration)` into `call.duration`, clears `call.start_time`, and returns `true`; otherwise returns `false`.

**Call relations**: Called when an exec-end event arrives. The boolean result lets callers detect orphan completions instead of attaching them to the wrong cell.


##### `ExecCell::should_flush`  (lines 97–99)

```
fn should_flush(&self) -> bool
```

**Purpose**: Reports whether this cell should be flushed as a completed non-exploring command entry.

**Data flow**: Returns `true` only when `!self.is_exploring_cell()` and every call has `output.is_some()`.

**Call relations**: Used by higher-level transcript logic to decide when a command cell is fully complete and ready for finalization.

*Call graph*: calls 1 internal fn (is_exploring_cell).


##### `ExecCell::mark_failed`  (lines 101–117)

```
fn mark_failed(&mut self)
```

**Purpose**: Finalizes any still-active calls as failed with exit code 1 and empty outputs.

**Data flow**: Iterates mutable calls; for each call lacking output, computes elapsed duration from `start_time` or zero milliseconds, clears `start_time`, stores `Some(duration)`, and inserts a `CommandOutput` with `exit_code: 1` and empty `formatted_output`/`aggregated_output`.

**Call relations**: Used when an active exec cell must be force-closed due to upstream failure or interruption.

*Call graph*: 1 external calls (new).


##### `ExecCell::is_exploring_cell`  (lines 119–121)

```
fn is_exploring_cell(&self) -> bool
```

**Purpose**: Determines whether every call in the cell is exploratory and therefore eligible for grouped exploring presentation.

**Data flow**: Returns whether `self.calls.iter().all(Self::is_exploring_call)`.

**Call relations**: Used by grouping, flushing, and rendering decisions.

*Call graph*: called by 2 (should_flush, with_added_call).


##### `ExecCell::is_active`  (lines 123–125)

```
fn is_active(&self) -> bool
```

**Purpose**: Reports whether any call in the cell is still running or incomplete.

**Data flow**: Returns whether any call has `output.is_none()`.

**Call relations**: Used by rendering to choose active indicators and labels.


##### `ExecCell::active_start_time`  (lines 127–132)

```
fn active_start_time(&self) -> Option<Instant>
```

**Purpose**: Returns the start time of the first still-active call, if any.

**Data flow**: Finds the first call with `output.is_none()` and returns its `start_time`.

**Call relations**: Used by the rendering layer to animate or stabilize activity indicators.


##### `ExecCell::animations_enabled`  (lines 134–136)

```
fn animations_enabled(&self) -> bool
```

**Purpose**: Exposes whether motion/animation should be used when rendering this cell.

**Data flow**: Returns the stored `animations_enabled` boolean.

**Call relations**: Used by render helpers when choosing activity indicators.


##### `ExecCell::iter_calls`  (lines 138–140)

```
fn iter_calls(&self) -> impl Iterator<Item = &ExecCall>
```

**Purpose**: Provides read-only iteration over the calls contained in the cell.

**Data flow**: Returns `self.calls.iter()`.

**Call relations**: Used by transcript rendering to display each grouped call.


##### `ExecCell::append_output`  (lines 142–152)

```
fn append_output(&mut self, call_id: &str, chunk: &str) -> bool
```

**Purpose**: Appends a streamed output chunk to the most recent matching call, lazily creating a default output record if needed.

**Data flow**: If `chunk` is empty, returns `false`. Otherwise it searches calls in reverse by `call_id`; on match it inserts `CommandOutput::default()` if `output` is `None`, appends `chunk` to `aggregated_output`, and returns `true`; if no call matches, returns `false`.

**Call relations**: Used by streaming exec-output event handling before final completion arrives.


##### `ExecCell::is_exploring_call`  (lines 154–165)

```
fn is_exploring_call(call: &ExecCall) -> bool
```

**Purpose**: Classifies a single call as exploratory based on source and parsed command kinds.

**Data flow**: Returns `false` for `UserShell`, `false` when `parsed` is empty, and otherwise checks that every parsed command is `Read`, `ListFiles`, or `Search`.

**Call relations**: Used by `is_exploring_cell` and `with_added_call` to preserve grouping invariants.

*Call graph*: 1 external calls (matches!).


##### `ExecCall::is_user_shell_command`  (lines 169–171)

```
fn is_user_shell_command(&self) -> bool
```

**Purpose**: Reports whether the call originated from the user shell rather than an agent/tool execution source.

**Data flow**: Matches `self.source` against `ExecCommandSource::UserShell` and returns a boolean.

**Call relations**: Used by rendering to choose labels and output truncation limits.

*Call graph*: 1 external calls (matches!).


##### `ExecCall::is_unified_exec_interaction`  (lines 173–175)

```
fn is_unified_exec_interaction(&self) -> bool
```

**Purpose**: Reports whether the call represents a unified exec interaction event rather than a normal command execution.

**Data flow**: Matches `self.source` against `ExecCommandSource::UnifiedExecInteraction` and returns a boolean.

**Call relations**: Used by rendering to change header wording and suppress normal output formatting.

*Call graph*: 1 external calls (matches!).


### `tui/src/exec_cell/render.rs`

`domain_logic` · `transcript rendering / chat cell display`

This file is the presentation layer for the exec-cell model. `new_active_exec_command` constructs a fresh active `ExecCell`, while the rest of the file focuses on turning cells into `ratatui::text::Line` sequences for either compact chat display or full transcript output. The `HistoryCell` implementation dispatches between `exploring_display_lines` and `command_display_lines` for compact mode, and `transcript_lines` for the full transcript.

Command rendering distinguishes ordinary commands, user-shell commands, and unified exec interactions. Commands are de-shellwrapped with `strip_bash_lc_and_escape`, syntax-highlighted with `highlight_bash_to_lines`, and wrapped using adaptive wrapping configured to avoid hyphenating long URL-like tokens. Active commands show an animated or static activity marker depending on `animations_enabled`; completed commands show green/red bullets and durations. Unified interactions are summarized as either `Waited for ...` or `Interacted with ..., sent ...`, with interaction input sanitized, newline-escaped, backtick-escaped, and truncated to 80 characters.

Output rendering is deliberately layered. `output_lines` first truncates logical lines from the head and tail with an ellipsis line containing the transcript hint. `command_display_lines` then wraps those lines to viewport width, prefixes them with the output gutter, and applies `truncate_lines_middle`, which measures actual wrapped row counts via `Paragraph::line_count` so a few very long lines cannot flood the viewport. This row-aware truncation preserves a head and tail region and inserts an ellipsis line whose omitted count remains in logical-line units, optionally carrying forward an upstream omitted count.

Exploring cells render as grouped summaries of read/list/search activity. Consecutive read-only calls are coalesced into a single `Read` line with deduplicated filenames, while other parsed commands become labeled lines like `List`, `Search`, or `Run`, all wrapped under prefixed indentation blocks defined by `PrefixedBlock` and `ExecDisplayLayout`.

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

**Purpose**: Creates a new active exec cell from raw command metadata at command start time.

**Data flow**: Builds an `ExecCall` with the provided identifiers, command argv, parsed commands, source, optional interaction input, `output: None`, `start_time: Some(Instant::now())`, and `duration: None`, then wraps it in `ExecCell::new` with the given animation flag.

**Call relations**: Used by higher-level exec event handling when a command begins.

*Call graph*: calls 1 internal fn (new); 1 external calls (now).


##### `format_unified_exec_interaction`  (lines 67–80)

```
fn format_unified_exec_interaction(command: &[String], input: Option<&str>) -> String
```

**Purpose**: Formats a unified exec interaction into a human-readable sentence describing either waiting or sending input to a command.

**Data flow**: Attempts to extract the shell script from `command` with `extract_bash_command`; otherwise joins argv with spaces. If `input` is present and non-empty, it summarizes it with `summarize_interaction_input` and returns `Interacted with ...`; otherwise returns `Waited for ...`.

**Call relations**: Used by `command_display_lines` when rendering `UnifiedExecInteraction` calls.

*Call graph*: calls 2 internal fn (extract_bash_command, summarize_interaction_input); called by 1 (command_display_lines); 1 external calls (format!).


##### `summarize_interaction_input`  (lines 82–95)

```
fn summarize_interaction_input(input: &str) -> String
```

**Purpose**: Sanitizes and truncates interaction input for inline display.

**Data flow**: Replaces newlines with `\n`, escapes backticks, and if the resulting character count exceeds `MAX_INTERACTION_PREVIEW_CHARS`, copies the first 80 characters into a new `String` and appends `...`; otherwise returns the sanitized string unchanged.

**Call relations**: Called only by `format_unified_exec_interaction`.

*Call graph*: called by 1 (format_unified_exec_interaction); 1 external calls (new).


##### `output_lines`  (lines 103–184)

```
fn output_lines(
    output: Option<&CommandOutput>,
    params: OutputLinesParams,
) -> OutputLines
```

**Purpose**: Converts aggregated command output into dimmed display lines with optional prefixing and logical-line truncation from the middle.

**Data flow**: Takes optional `CommandOutput` and `OutputLinesParams`. It returns empty output when there is no output or when `only_err` is true and `exit_code == 0`. Otherwise it splits `aggregated_output` into lines, emits up to `line_limit` head lines with ANSI escapes parsed by `ansi_escape_line`, optionally inserts an ellipsis line if more than `2 * line_limit` lines exist, emits the tail lines, dims all spans, and returns `OutputLines { lines, omitted }`.

**Call relations**: Used by `command_display_lines` and directly by tests. It performs the first-stage logical truncation before viewport-aware wrapping/trimming.

*Call graph*: called by 3 (command_display_lines, output_lines_ellipsis_includes_transcript_hint, user_shell_output_is_limited_by_screen_lines); 3 external calls (new, ansi_escape_line, output_ellipsis_line).


##### `activity_marker`  (lines 186–193)

```
fn activity_marker(start_time: Option<Instant>, animations_enabled: bool) -> Span<'static>
```

**Purpose**: Returns the activity indicator span for an active command, respecting reduced-motion settings and falling back to a static bullet.

**Data flow**: Calls `activity_indicator(start_time, MotionMode::from_animations_enabled(animations_enabled), ReducedMotionIndicator::StaticBullet)` and returns its span or a dim `•` fallback.

**Call relations**: Used by `command_display_lines` and `exploring_display_lines` for active cells.

*Call graph*: calls 2 internal fn (from_animations_enabled, activity_indicator); called by 1 (command_display_lines).


##### `ExecCell::display_lines`  (lines 196–202)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Chooses the compact display representation for an exec cell based on whether it is exploratory.

**Data flow**: Checks `self.is_exploring_cell()` and returns either `self.exploring_display_lines(width)` or `self.command_display_lines(width)`.

**Call relations**: Implements the compact `HistoryCell` display path.

*Call graph*: calls 2 internal fn (command_display_lines, exploring_display_lines).


##### `ExecCell::transcript_lines`  (lines 204–246)

```
fn transcript_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the full transcript representation for all calls in the cell, including wrapped command text, formatted output, and completion status lines.

**Data flow**: Iterates `self.iter_calls()`, inserts blank lines between calls, de-shellwraps and highlights each command, wraps it with `$ ` initial indent and four-space continuation indent, then if output exists and the call is not a unified interaction, wraps each `formatted_output` line after ANSI parsing. Finally it appends a green `✓` or red `✗ (code)` line with dim duration text.

**Call relations**: Used by `raw_lines` and by transcript-height calculations elsewhere in the system.

*Call graph*: calls 6 internal fn (strip_bash_lc_and_escape, highlight_bash_to_lines, push_owned_lines, new, adaptive_wrap_line, adaptive_wrap_lines); called by 1 (raw_lines); 3 external calls (from, format!, vec!).


##### `ExecCell::raw_lines`  (lines 248–250)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns the transcript lines converted to plain, unstyled lines.

**Data flow**: Calls `self.transcript_lines(u16::MAX)` and passes the result through `plain_lines`.

**Call relations**: Implements the raw-history extraction path for `HistoryCell`.

*Call graph*: calls 2 internal fn (transcript_lines, plain_lines).


##### `ExecCell::output_ellipsis_text`  (lines 254–256)

```
fn output_ellipsis_text(omitted: usize) -> String
```

**Purpose**: Formats the output-truncation ellipsis message including the transcript shortcut hint.

**Data flow**: Takes an omitted logical-line count and returns `… +{omitted} lines (ctrl + t to view transcript)`.

**Call relations**: Used by output ellipsis line builders and row-count estimation.

*Call graph*: 1 external calls (format!).


##### `ExecCell::output_ellipsis_line`  (lines 258–260)

```
fn output_ellipsis_line(omitted: usize) -> Line<'static>
```

**Purpose**: Builds a dimmed `Line` containing the output-truncation ellipsis message.

**Data flow**: Wraps `Self::output_ellipsis_text(omitted).dim()` in a `Line` and returns it.

**Call relations**: Used by `output_lines` when logical output truncation occurs.

*Call graph*: 2 external calls (from, vec!).


##### `ExecCell::exploring_display_lines`  (lines 262–363)

```
fn exploring_display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Renders a grouped exploring cell as a compact summary of read/list/search activity.

**Data flow**: Starts with a header line showing active/completed bullet plus `Exploring` or `Explored`. It clones `self.calls`, coalesces consecutive read-only calls by extending `parsed`, then for each grouped call builds labeled lines: `Read` with deduplicated names, `List` with path/cmd, `Search` with query and optional path, or `Run` for unknown parsed commands. Each line is adaptively wrapped with title-based indentation, accumulated, then prefixed under a `  └ ` / `    ` block.

**Call relations**: Used by `display_lines` when `is_exploring_cell()` is true.

*Call graph*: calls 4 internal fn (prefix_lines, push_owned_lines, new, adaptive_wrap_line); called by 1 (display_lines); 3 external calls (from, new, vec!).


##### `ExecCell::command_display_lines`  (lines 365–508)

```
fn command_display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Renders a non-exploring exec cell as a compact command block with header, wrapped command text, and optionally truncated output.

**Data flow**: Assumes exactly one call. It computes success state and bullet color/activity marker, chooses a title (`Running`, `You ran`, `Ran`, or none for interactions), formats the command or interaction summary, highlights and wraps the first command line into the header and remaining command lines into a continuation block, then if output exists computes logical output lines with `output_lines`, wraps them to the output block width, prefixes them, and trims them with `truncate_lines_middle` using row-aware limits. If there is no output and the call is not an interaction, it inserts a dim `(no output)` line.

**Call relations**: Used by `display_lines` for ordinary command cells. It orchestrates most of the rendering helpers in this file.

*Call graph*: calls 9 internal fn (activity_marker, format_unified_exec_interaction, output_lines, strip_bash_lc_and_escape, highlight_bash_to_lines, prefix_lines, push_owned_lines, new, adaptive_wrap_line); called by 1 (display_lines); 7 external calls (from, limit_lines_from_start, truncate_lines_middle, from, new, panic!, vec!).


##### `ExecCell::limit_lines_from_start`  (lines 510–521)

```
fn limit_lines_from_start(lines: &[Line<'static>], keep: usize) -> Vec<Line<'static>>
```

**Purpose**: Keeps only the first `keep` logical lines of a block and appends a simple ellipsis line if anything was omitted.

**Data flow**: If `lines.len() <= keep`, clones and returns all lines. If `keep == 0`, returns only `ellipsis_line(lines.len())`. Otherwise returns the first `keep` lines plus `ellipsis_line(lines.len() - keep)`.

**Call relations**: Used to cap command continuation lines before output rendering begins.

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

**Purpose**: Truncates a block of already-prefixed lines to fit within a maximum number of wrapped viewport rows, preserving head and tail content with an ellipsis line in the middle.

**Data flow**: Measures each logical line’s wrapped row cost at the given width, using `Paragraph::line_count` except for whitespace-only lines where it computes width manually. If total rows fit, it returns all lines. Otherwise it estimates ellipsis row cost with `output_ellipsis_row_count`, reserves space for that ellipsis, fills a head region and tail region within the remaining row budget, computes omitted logical-line count by combining `omitted_hint` with newly hidden lines, inserts `output_ellipsis_line_with_prefix`, and returns the assembled lines.

**Call relations**: Used by `command_display_lines` after wrapping output so truncation respects actual on-screen row usage.

*Call graph*: 8 external calls (iter, len, to_vec, output_ellipsis_line_with_prefix, output_ellipsis_row_count, new, from, vec!).


##### `ExecCell::ellipsis_line`  (lines 632–634)

```
fn ellipsis_line(omitted: usize) -> Line<'static>
```

**Purpose**: Builds a simple dimmed ellipsis line without the transcript hint, used for command-text truncation rather than output truncation.

**Data flow**: Formats `… +{omitted} lines`, dims it, wraps it in a `Line`, and returns it.

**Call relations**: Used by `limit_lines_from_start`.

*Call graph*: 2 external calls (from, vec!).


##### `ExecCell::output_ellipsis_row_count`  (lines 636–647)

```
fn output_ellipsis_row_count(
        omitted: usize,
        width: u16,
        prefix: Option<&Line<'static>>,
    ) -> usize
```

**Purpose**: Computes how many wrapped viewport rows the output ellipsis line will occupy at a given width and optional prefix.

**Data flow**: Builds the prefixed ellipsis line with `output_ellipsis_line_with_prefix`, wraps it in a one-line `Paragraph`, calls `line_count(width)`, and returns at least 1.

**Call relations**: Used by `truncate_lines_middle` to reserve row budget for the ellipsis itself.

*Call graph*: 3 external calls (new, from, vec!).


##### `ExecCell::output_ellipsis_line_with_prefix`  (lines 651–658)

```
fn output_ellipsis_line_with_prefix(
        omitted: usize,
        prefix: Option<&Line<'static>>,
    ) -> Line<'static>
```

**Purpose**: Builds an output ellipsis line and prepends an optional gutter prefix so it aligns with output blocks.

**Data flow**: Clones the optional prefix line or starts from default, appends the dimmed `output_ellipsis_text(omitted)` span, and returns the resulting `Line`.

**Call relations**: Used by both row-count estimation and final middle-truncation output.

*Call graph*: 1 external calls (output_ellipsis_text).


##### `PrefixedBlock::new`  (lines 668–673)

```
fn new(initial_prefix: &'static str, subsequent_prefix: &'static str) -> Self
```

**Purpose**: Constructs a prefix-layout descriptor for wrapped blocks with distinct initial and subsequent prefixes.

**Data flow**: Stores the two static prefix strings into `PrefixedBlock`.

**Call relations**: Used to define the constant `EXEC_DISPLAY_LAYOUT`.


##### `PrefixedBlock::wrap_width`  (lines 675–679)

```
fn wrap_width(self, total_width: u16) -> usize
```

**Purpose**: Computes how many content columns remain after accounting for the widest of the block’s prefixes.

**Data flow**: Measures both prefixes with `UnicodeWidthStr::width`, takes the maximum, subtracts it from `total_width`, and returns at least 1.

**Call relations**: Used by command and output wrapping to derive content widths from total terminal width.

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

**Purpose**: Constructs the immutable layout configuration describing command continuation and output block prefixes and line limits.

**Data flow**: Stores the provided `PrefixedBlock`s and max-line counts into `ExecDisplayLayout`.

**Call relations**: Used once to define the `EXEC_DISPLAY_LAYOUT` constant.


##### `tests::render_line_text`  (lines 719–724)

```
fn render_line_text(line: &Line<'static>) -> String
```

**Purpose**: Converts a styled `Line` into plain text for assertions.

**Data flow**: Concatenates all span contents in the line into a `String`.

**Call relations**: Shared helper for render-oriented tests.


##### `tests::user_shell_output_is_limited_by_screen_lines`  (lines 727–829)

```
fn user_shell_output_is_limited_by_screen_lines()
```

**Purpose**: Regression test ensuring user-shell output truncation is based on wrapped screen rows, not just logical lines.

**Data flow**: Builds very long URL-like output lines, computes how many wrapped rows they would occupy without truncation, asserts that exceeds the user-shell limit, renders `command_display_lines` for a user-shell call at narrow width, measures rendered rows, checks an ellipsis line is present, and asserts the transcript hint appears.

**Call relations**: Exercises the interaction between `output_lines`, wrapping, prefixing, and `truncate_lines_middle`.

*Call graph*: calls 6 internal fn (new, output_lines, prefix_lines, push_owned_lines, new, adaptive_wrap_line); 8 external calls (new, from, new, from, new, assert!, format!, vec!).


##### `tests::truncate_lines_middle_keeps_omitted_count_in_line_units`  (lines 832–858)

```
fn truncate_lines_middle_keeps_omitted_count_in_line_units()
```

**Purpose**: Verifies that middle truncation reports omitted logical lines rather than omitted wrapped rows.

**Data flow**: Builds a small line set including a preexisting output ellipsis hint, truncates it to two rows with an omitted hint of 4, converts lines to text, and asserts the resulting ellipsis reports `+6 lines`.

**Call relations**: Covers omitted-count accounting in `truncate_lines_middle`.

*Call graph*: 4 external calls (from, assert!, truncate_lines_middle, vec!).


##### `tests::output_lines_ellipsis_includes_transcript_hint`  (lines 861–888)

```
fn output_lines_ellipsis_includes_transcript_hint()
```

**Purpose**: Checks that logical output truncation includes the transcript shortcut hint in its ellipsis line.

**Data flow**: Builds seven lines of aggregated output, renders with `line_limit: 2`, converts lines to text, and asserts one line contains `… +3 lines (ctrl + t to view transcript)`.

**Call relations**: Direct test of `output_lines` ellipsis formatting.

*Call graph*: calls 1 internal fn (output_lines); 2 external calls (new, assert!).


##### `tests::command_truncation_ellipsis_does_not_include_transcript_hint`  (lines 891–910)

```
fn command_truncation_ellipsis_does_not_include_transcript_hint()
```

**Purpose**: Verifies that command-text truncation uses the simpler ellipsis without the transcript hint.

**Data flow**: Calls `limit_lines_from_start` on three lines with `keep = 2`, converts to text, and asserts the result is `first`, `second`, `… +1 lines`.

**Call relations**: Distinguishes command continuation truncation from output truncation.

*Call graph*: 3 external calls (from, assert_eq!, limit_lines_from_start).


##### `tests::truncate_lines_middle_does_not_truncate_blank_prefixed_output_lines`  (lines 913–924)

```
fn truncate_lines_middle_does_not_truncate_blank_prefixed_output_lines()
```

**Purpose**: Ensures blank prefixed output lines are counted correctly and not spuriously truncated when they still fit.

**Data flow**: Builds a block with one start line, many blank prefixed lines, and one end line, truncates with a row budget that should fit exactly, and asserts the output is unchanged.

**Call relations**: Regression test for whitespace-only row counting in `truncate_lines_middle`.

*Call graph*: 5 external calls (from, assert_eq!, repeat_n, truncate_lines_middle, vec!).


##### `tests::command_display_does_not_split_long_url_token`  (lines 927–958)

```
fn command_display_does_not_split_long_url_token()
```

**Purpose**: Verifies command wrapping does not hyphenate or split a long URL token across multiple rendered lines.

**Data flow**: Builds a user-shell call whose command contains a long URL, renders `command_display_lines` at narrow width, converts lines to text, and asserts exactly one rendered line contains the full URL.

**Call relations**: Covers `WordSplitter::NoHyphenation` behavior in command wrapping.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert_eq!, vec!).


##### `tests::active_command_without_animations_is_stable`  (lines 961–987)

```
fn active_command_without_animations_is_stable()
```

**Purpose**: Checks that rendering an active command with animations disabled is deterministic across repeated renders.

**Data flow**: Builds an active agent call with `start_time`, renders `command_display_lines` twice, converts both to text, and asserts they are identical and equal to `• Running echo done`.

**Call relations**: Covers `activity_marker` fallback behavior when animations are disabled.

*Call graph*: calls 1 internal fn (new); 4 external calls (now, new, assert_eq!, vec!).


##### `tests::exploring_display_does_not_split_long_url_like_search_query`  (lines 990–1027)

```
fn exploring_display_does_not_split_long_url_like_search_query()
```

**Purpose**: Verifies exploring summaries also avoid splitting long URL-like search queries.

**Data flow**: Builds an exploring search call with a long query, renders `display_lines` at narrow width, converts lines to text, and asserts exactly one line contains the full query.

**Call relations**: Covers no-hyphenation wrapping in `exploring_display_lines`.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, vec!).


##### `tests::output_display_does_not_split_long_url_like_token_without_scheme`  (lines 1030–1065)

```
fn output_display_does_not_split_long_url_like_token_without_scheme()
```

**Purpose**: Verifies wrapped output lines do not split long URL-like tokens lacking a URL scheme.

**Data flow**: Builds a user-shell call with long aggregated output, renders `command_display_lines` at narrow width, converts lines to text, and asserts exactly one line contains the full token.

**Call relations**: Covers output wrapping behavior with `WordSplitter::NoHyphenation`.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, new, assert_eq!, vec!).


##### `tests::desired_transcript_height_accounts_for_wrapped_url_like_rows`  (lines 1068–1094)

```
fn desired_transcript_height_accounts_for_wrapped_url_like_rows()
```

**Purpose**: Checks that transcript height calculations account for wrapped rows rather than just logical line count.

**Data flow**: Builds a call whose formatted output is a long URL, compares `cell.transcript_lines(width).len()` to `cell.desired_transcript_height(width)`, and asserts the wrapped height is larger.

**Call relations**: Regression test for transcript sizing behavior downstream of `transcript_lines`.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert!, vec!).


### `tui/src/diff_render.rs`

`domain_logic` · `diff rendering / transcript and preview generation`

This file is the presentation engine for `FileChange` values. It can render a single change as a `Renderable`, convert a `DiffSummary` into a column of per-file blocks, or produce plain `Vec<Line>` summaries for transcript-like displays. The renderer understands added, deleted, and updated files; for updates it parses unified diffs with `diffy`, computes add/remove counts, inserts hunk separators, and preserves syntax-highlighter parser state within each hunk by highlighting the whole hunk text at once.

A major concern here is styling. The file derives a `DiffRenderStyleContext` once per render pass from terminal background lightness, detected color depth, and syntax-theme diff scope backgrounds. It distinguishes `DiffTheme` (dark/light) from `DiffColorLevel` (truecolor/256/16), with `RichDiffColorLevel` encoding the invariant that only truecolor and 256-color modes may use tinted backgrounds. Theme-provided `markup.inserted`/`markup.deleted` backgrounds override hardcoded palettes when available; ANSI-16 intentionally degrades to foreground-only styling.

Wrapping is also custom. `push_wrapped_diff_line_inner_with_theme_and_color_level` composes gutter, sign, and content spans, then delegates to `wrap_styled_spans`, which wraps by Unicode display width, treats tabs as four columns, preserves styles across split boundaries, and avoids infinite loops on wide or zero-width characters. Path display is normalized relative to cwd, git repo root, or home directory so summaries remain readable in mixed absolute/relative environments. Large update diffs skip syntax highlighting entirely once configured byte/line thresholds are exceeded, preventing pathological render-time slowdowns.

#### Function details

##### `RichDiffColorLevel::from_diff_color_level`  (lines 160–166)

```
fn from_diff_color_level(level: DiffColorLevel) -> Option<Self>
```

**Purpose**: Converts the general diff color level into the subset that supports tinted backgrounds. ANSI-16 returns `None` to force callers onto foreground-only styling paths.

**Data flow**: Matches `DiffColorLevel` and returns `Some(TrueColor)`, `Some(Ansi256)`, or `None`.

**Call relations**: Used by background-producing helpers and gutter styling to branch away from unsupported ANSI-16 backgrounds.

*Call graph*: called by 3 (fallback_diff_backgrounds, resolve_diff_backgrounds_for, style_gutter_for).


##### `resolve_diff_backgrounds`  (lines 199–204)

```
fn resolve_diff_backgrounds(
    theme: DiffTheme,
    color_level: DiffColorLevel,
) -> ResolvedDiffBackgrounds
```

**Purpose**: Resolves insert/delete background colors for the current environment using syntax-theme diff scopes when available.

**Data flow**: Takes `theme` and `color_level`, queries `diff_scope_background_rgbs()`, delegates to `resolve_diff_backgrounds_for`, and returns `ResolvedDiffBackgrounds`.

**Call relations**: Called by `current_diff_render_style_context` during per-frame style-context construction.

*Call graph*: calls 2 internal fn (resolve_diff_backgrounds_for, diff_scope_background_rgbs); called by 1 (current_diff_render_style_context).


##### `current_diff_render_style_context`  (lines 215–224)

```
fn current_diff_render_style_context() -> DiffRenderStyleContext
```

**Purpose**: Snapshots all terminal- and theme-dependent diff styling decisions into one reusable context for a render pass.

**Data flow**: Calls `diff_theme()`, `diff_color_level()`, and `resolve_diff_backgrounds(...)`, then packages the results into `DiffRenderStyleContext`.

**Call relations**: Used at the top of diff rendering and preview code so every line in a frame shares consistent palette decisions.

*Call graph*: calls 3 internal fn (diff_color_level, diff_theme, resolve_diff_backgrounds); called by 6 (render_change, fallback_wrapping_uses_display_width_for_tabs_and_wide_chars, ui_snapshot_syntax_highlighted_insert_wraps, ui_snapshot_syntax_highlighted_insert_wraps_text, ui_snapshot_wrap_behavior_insert, render_preview).


##### `resolve_diff_backgrounds_for`  (lines 232–249)

```
fn resolve_diff_backgrounds_for(
    theme: DiffTheme,
    color_level: DiffColorLevel,
    scope_backgrounds: DiffScopeBackgroundRgbs,
) -> ResolvedDiffBackgrounds
```

**Purpose**: Pure helper that starts from fallback diff backgrounds and overrides them with syntax-theme scope backgrounds when color depth permits.

**Data flow**: Builds fallback backgrounds, early-returns them for ANSI-16, otherwise replaces `add` and/or `del` with `color_from_rgb_for_level(...)` for any provided inserted/deleted RGBs.

**Call relations**: Called by the environment-reading wrapper and directly by tests to validate background-resolution policy.

*Call graph*: calls 3 internal fn (from_diff_color_level, color_from_rgb_for_level, fallback_diff_backgrounds); called by 5 (resolve_diff_backgrounds, ansi16_disables_line_and_gutter_backgrounds, theme_scope_backgrounds_override_truecolor_fallback_when_available, theme_scope_backgrounds_quantize_to_ansi256, ui_snapshot_theme_scope_background_resolution).


##### `fallback_diff_backgrounds`  (lines 253–264)

```
fn fallback_diff_backgrounds(
    theme: DiffTheme,
    color_level: DiffColorLevel,
) -> ResolvedDiffBackgrounds
```

**Purpose**: Returns the hardcoded insert/delete background palette for the given theme and color depth, or empty backgrounds for ANSI-16.

**Data flow**: Converts `DiffColorLevel` to `RichDiffColorLevel`; if rich, computes `add` and `del` via `add_line_bg` and `del_line_bg`, otherwise returns `ResolvedDiffBackgrounds::default()`.

**Call relations**: Baseline used by `resolve_diff_backgrounds_for` and many style tests.

*Call graph*: calls 3 internal fn (from_diff_color_level, add_line_bg, del_line_bg); called by 6 (resolve_diff_backgrounds_for, ansi16_add_style_uses_foreground_only, ansi16_del_style_uses_foreground_only, ansi16_sign_styles_use_foreground_only, light_theme_wrapped_lines_keep_number_gutter_contrast, ui_snapshot_ansi16_insert_delete_no_background); 1 external calls (default).


##### `color_from_rgb_for_level`  (lines 268–273)

```
fn color_from_rgb_for_level(rgb: (u8, u8, u8), color_level: RichDiffColorLevel) -> Color
```

**Purpose**: Converts an RGB triple into either a truecolor `Color` or the nearest ANSI-256 indexed color.

**Data flow**: Matches `RichDiffColorLevel`; truecolor passes through `rgb_color(rgb)`, ANSI-256 delegates to `quantize_rgb_to_ansi256(rgb)`.

**Call relations**: Used when syntax-theme diff scope backgrounds override the fallback palette.

*Call graph*: calls 2 internal fn (quantize_rgb_to_ansi256, rgb_color); called by 1 (resolve_diff_backgrounds_for).


##### `quantize_rgb_to_ansi256`  (lines 281–294)

```
fn quantize_rgb_to_ansi256(target: (u8, u8, u8)) -> Color
```

**Purpose**: Finds the nearest ANSI-256 palette entry to a target RGB using perceptual distance, excluding the first 16 terminal-configurable system colors.

**Data flow**: Iterates `XTERM_COLORS` from index 16 onward, chooses the minimum perceptual distance to `target`, and returns `indexed_color(best_index)` or a dark-green fallback index if none exists.

**Call relations**: Used only by `color_from_rgb_for_level` for ANSI-256 quantization.

*Call graph*: calls 1 internal fn (indexed_color); called by 1 (color_from_rgb_for_level).


##### `DiffSummary::new`  (lines 302–304)

```
fn new(changes: HashMap<PathBuf, FileChange>, cwd: AbsolutePathBuf) -> Self
```

**Purpose**: Constructs a diff summary from a map of file changes and the current working directory.

**Data flow**: Stores the provided `HashMap<PathBuf, FileChange>` and `AbsolutePathBuf` into the struct.

**Call relations**: Used by callers that want to convert a summary into a boxed `Renderable`.


##### `FileChange::render`  (lines 308–312)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Implements `Renderable` for a single file change by rendering it into wrapped diff lines and placing them in a `Paragraph`.

**Data flow**: Creates a temporary `Vec<RtLine>`, fills it with `render_change(self, ...)`, then renders `Paragraph::new(lines)` into the provided area and buffer.

**Call relations**: Used when a single `FileChange` is embedded directly in UI layouts.

*Call graph*: calls 1 internal fn (render_change); 2 external calls (new, vec!).


##### `FileChange::desired_height`  (lines 314–318)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Computes how many logical diff lines a single file change will render at a given width.

**Data flow**: Renders the change into a temporary vector with `render_change` and returns `lines.len() as u16`.

**Call relations**: Supports layout sizing for `Renderable` consumers.

*Call graph*: calls 1 internal fn (render_change); 1 external calls (vec!).


##### `Box::from`  (lines 322–343)

```
fn from(val: DiffSummary) -> Self
```

**Purpose**: Converts a `DiffSummary` into a boxed column renderable containing per-file headers, counts, spacing, and indented diff bodies.

**Data flow**: Collects sorted rows, inserts blank separators between files, formats each path with `display_path_for`, appends line-count summary spans, wraps each `FileChange` in an `InsetRenderable`, and returns `Box<dyn Renderable>` containing a `ColumnRenderable`.

**Call relations**: Used when diff summaries need to participate in the generic renderable layout system.

*Call graph*: calls 6 internal fn (collect_rows, display_path_for, render_line_count_summary, tlbr, with, new); 3 external calls (new, from, vec!).


##### `create_diff_summary`  (lines 346–353)

```
fn create_diff_summary(
    changes: &HashMap<PathBuf, FileChange>,
    cwd: &Path,
    wrap_cols: usize,
) -> Vec<RtLine<'static>>
```

**Purpose**: Builds a plain-text diff summary block suitable for transcript or preview rendering.

**Data flow**: Collects sorted rows from the change map, then renders them with `render_changes_block(rows, wrap_cols, cwd)` into `Vec<RtLine<'static>>`.

**Call relations**: Primary summary entry point used by tests and higher-level diff display code.

*Call graph*: calls 2 internal fn (collect_rows, render_changes_block); called by 12 (add_diff_uses_path_extension_for_highlighting, delete_diff_uses_path_extension_for_highlighting, diff_summary_for_tests, large_update_diff_skips_highlighting, rename_diff_uses_destination_extension_for_highlighting, snapshot_diff_gallery, ui_snapshot_apply_update_block_line_numbers_three_digits_text, ui_snapshot_apply_update_block_relativizes_path, ui_snapshot_apply_update_block_wraps_long_lines, ui_snapshot_apply_update_block_wraps_long_lines_text (+2 more)).


##### `collect_rows`  (lines 366–391)

```
fn collect_rows(changes: &HashMap<PathBuf, FileChange>) -> Vec<Row>
```

**Purpose**: Normalizes the unordered change map into sorted per-file rows with precomputed add/remove counts and optional rename destinations.

**Data flow**: Iterates the `HashMap`, computes `(added, removed)` from file contents or `calculate_add_remove_from_diff`, extracts `move_path` for updates, clones each `FileChange`, pushes `Row` structs, sorts them by path, and returns the vector.

**Call relations**: Used by both boxed and plain-text summary renderers.

*Call graph*: calls 1 internal fn (calculate_add_remove_from_diff); called by 2 (from, create_diff_summary); 1 external calls (new).


##### `render_line_count_summary`  (lines 393–401)

```
fn render_line_count_summary(added: usize, removed: usize) -> Vec<RtSpan<'static>>
```

**Purpose**: Formats `(+added -removed)` as colored spans for file headers and summary headers.

**Data flow**: Builds a `Vec<RtSpan>` containing parentheses, green `+N`, a space, red `-N`, and closing parenthesis.

**Call relations**: Used by both `Box::from` and `render_changes_block`.

*Call graph*: called by 2 (from, render_changes_block); 2 external calls (new, format!).


##### `render_changes_block`  (lines 403–465)

```
fn render_changes_block(rows: Vec<Row>, wrap_cols: usize, cwd: &Path) -> Vec<RtLine<'static>>
```

**Purpose**: Renders a multi-file diff summary with an overall header, optional per-file headers, and indented diff bodies.

**Data flow**: Takes sorted `Row`s, computes total add/remove counts and file count, builds a summary header, then for each row optionally emits a file header, detects syntax language from the destination path on renames, renders the change body with `render_change`, prefixes it with four spaces, and returns all lines.

**Call relations**: Called by `create_diff_summary`; it orchestrates summary-level formatting around the lower-level per-change renderer.

*Call graph*: calls 4 internal fn (detect_lang_for_path, render_change, render_line_count_summary, prefix_lines); called by 1 (create_diff_summary); 4 external calls (from, new, format!, vec!).


##### `detect_lang_for_path`  (lines 470–473)

```
fn detect_lang_for_path(path: &Path) -> Option<String>
```

**Purpose**: Extracts a file extension string for downstream syntax-highlighting lookup.

**Data flow**: Reads `path.extension()?.to_str()?` and returns it as `Some(String)` or `None` for extensionless/unicode-invalid paths.

**Call relations**: Used by `render_changes_block` to choose highlighting language, especially for rename destinations.

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

**Purpose**: Renders one `FileChange` into styled, wrapped diff lines, including syntax highlighting, hunk separators, and line numbers.

**Data flow**: Builds a `DiffRenderStyleContext`, then matches on `FileChange`. Adds and deletes pre-highlight whole-file content when a language is known, compute line-number width, and emit wrapped insert/delete lines. Updates parse unified diff text with `diffy::Patch::from_str`, compute max line number and total diff size, disable highlighting if `exceeds_highlight_limits`, highlight each hunk as one block when allowed, emit `⋮` separators between hunks, and push wrapped lines for insert/delete/context entries.

**Call relations**: Core renderer used by `FileChange`’s `Renderable` impl, summary rendering, and height calculation.

*Call graph*: calls 5 internal fn (current_diff_render_style_context, line_number_width, push_wrapped_diff_line_inner_with_theme_and_color_level, style_gutter_for, exceeds_highlight_limits); called by 3 (desired_height, render, render_changes_block); 5 external calls (from, styled, from_str, format!, vec!).


##### `display_path_for`  (lines 742–763)

```
fn display_path_for(path: &Path, cwd: &Path) -> String
```

**Purpose**: Formats a path for display relative to cwd when possible, otherwise relative to repo root or home directory for readability.

**Data flow**: If the path is already relative, returns it unchanged. Otherwise it first tries `strip_prefix(cwd)`, then checks whether `cwd` and `path` share a git repo root and uses `pathdiff::diff_paths` if so; failing that, it tries `relativize_to_home` and prefixes `~`, else falls back to the absolute path string.

**Call relations**: Used in diff summaries and tested directly to keep displayed paths stable and concise.

*Call graph*: calls 1 internal fn (relativize_to_home); called by 2 (from, display_path_prefers_cwd_without_git_repo); 5 external calls (display, is_relative, strip_prefix, get_git_repo_root, diff_paths).


##### `calculate_add_remove_from_diff`  (lines 765–780)

```
fn calculate_add_remove_from_diff(diff: &str) -> (usize, usize)
```

**Purpose**: Counts inserted and deleted lines in a unified diff string.

**Data flow**: Parses the diff with `diffy::Patch::from_str`; if successful, folds over all hunk lines counting `Insert` and `Delete` variants, otherwise returns `(0, 0)`.

**Call relations**: Used by `collect_rows` to summarize update diffs.

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

**Purpose**: Convenience wrapper for rendering a plain-text diff line with a precomputed style context.

**Data flow**: Passes line number, kind, text, width, line-number width, `None` syntax spans, and the style-context fields into `push_wrapped_diff_line_inner_with_theme_and_color_level`.

**Call relations**: Used by preview code and tests that do not have syntax-highlighted spans.

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

**Purpose**: Convenience wrapper for rendering a syntax-highlighted diff line with a precomputed style context.

**Data flow**: Passes all arguments plus `Some(syntax_spans)` and the style-context fields into the inner wrapping/rendering function.

**Call relations**: Used by preview code and tests that already have syntax-highlighted spans.

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

**Purpose**: Builds one or more wrapped output lines for a diff line, composing gutter, sign, content styling, optional syntax spans, and full-line background tint.

**Data flow**: Computes gutter width and prefix columns, selects sign/content styles from `kind`, derives line background and gutter style, optionally overlays syntax spans (adding `DIM` for delete lines), wraps content with `wrap_styled_spans`, then constructs first-line and continuation-line `RtLine`s with appropriate gutter/sign prefixes and returns them.

**Call relations**: This is the shared rendering core behind all wrapped diff-line entry points and the per-line work inside `render_change`.

*Call graph*: calls 8 internal fn (style_add, style_context, style_del, style_gutter_for, style_line_bg_for, style_sign_add, style_sign_del, wrap_styled_spans); called by 5 (push_wrapped_diff_line_with_style_context, push_wrapped_diff_line_with_syntax_and_style_context, render_change, light_theme_wrapped_lines_keep_number_gutter_contrast, ui_snapshot_ansi16_insert_delete_no_background); 5 external calls (from, styled, new, format!, vec!).


##### `wrap_styled_spans`  (lines 952–1021)

```
fn wrap_styled_spans(spans: &[RtSpan<'static>], max_cols: usize) -> Vec<Vec<RtSpan<'static>>>
```

**Purpose**: Wraps styled spans into chunks that fit within a maximum display width while preserving styles and respecting Unicode/tab widths.

**Data flow**: Iterates spans and their characters, tracking current column width. It accumulates as many characters as fit, flushes completed lines into `result`, forces progress when a single character would overflow an empty remainder, treats tabs as `TAB_WIDTH`, and returns `Vec<Vec<RtSpan>>` chunks.

**Call relations**: Used by the inner diff-line renderer and directly tested for width, style-preservation, and edge-case behavior.

*Call graph*: called by 7 (push_wrapped_diff_line_inner_with_theme_and_color_level, wrap_styled_spans_flushes_at_span_boundary, wrap_styled_spans_preserves_styles, wrap_styled_spans_single_line, wrap_styled_spans_splits_long_content, wrap_styled_spans_tabs_have_visible_width, wrap_styled_spans_wraps_before_first_overflowing_char); 3 external calls (styled, new, take).


##### `line_number_width`  (lines 1023–1029)

```
fn line_number_width(max_line_number: usize) -> usize
```

**Purpose**: Returns the number of columns needed to display the largest line number in a diff block, with a minimum of one.

**Data flow**: If `max_line_number == 0`, returns `1`; otherwise converts the number to string and returns its length.

**Call relations**: Used throughout diff rendering to keep gutter alignment stable.

*Call graph*: called by 8 (render_change, fallback_wrapping_uses_display_width_for_tabs_and_wide_chars, light_theme_wrapped_lines_keep_number_gutter_contrast, ui_snapshot_ansi16_insert_delete_no_background, ui_snapshot_syntax_highlighted_insert_wraps, ui_snapshot_syntax_highlighted_insert_wraps_text, ui_snapshot_wrap_behavior_insert, render_preview).


##### `diff_theme_for_bg`  (lines 1032–1039)

```
fn diff_theme_for_bg(bg: Option<(u8, u8, u8)>) -> DiffTheme
```

**Purpose**: Classifies a sampled terminal background as light or dark for diff palette selection.

**Data flow**: If an RGB background is present and `is_light(rgb)` is true, returns `DiffTheme::Light`; otherwise returns `DiffTheme::Dark`.

**Call relations**: Pure helper used by `diff_theme` and tests.

*Call graph*: calls 1 internal fn (is_light); called by 1 (diff_theme).


##### `diff_theme`  (lines 1042–1044)

```
fn diff_theme() -> DiffTheme
```

**Purpose**: Determines the current diff theme by probing the terminal’s default background color.

**Data flow**: Calls `default_bg()` and feeds the result into `diff_theme_for_bg`.

**Call relations**: Used by `current_diff_render_style_context`.

*Call graph*: calls 2 internal fn (diff_theme_for_bg, default_bg); called by 1 (current_diff_render_style_context).


##### `diff_color_level`  (lines 1054–1061)

```
fn diff_color_level() -> DiffColorLevel
```

**Purpose**: Determines the renderer’s effective diff color depth from runtime terminal signals and environment variables.

**Data flow**: Reads `stdout_color_level()`, `terminal_info().name`, whether `WT_SESSION` is set, and whether `FORCE_COLOR` is set, then passes them to `diff_color_level_for_terminal`.

**Call relations**: Environment-reading wrapper used by `current_diff_render_style_context`.

*Call graph*: calls 3 internal fn (diff_color_level_for_terminal, has_force_color_override, stdout_color_level); called by 1 (current_diff_render_style_context); 2 external calls (terminal_info, var_os).


##### `has_force_color_override`  (lines 1064–1066)

```
fn has_force_color_override() -> bool
```

**Purpose**: Reports whether `FORCE_COLOR` is explicitly present in the environment.

**Data flow**: Checks `std::env::var_os("FORCE_COLOR")` and returns a boolean.

**Call relations**: Used by `diff_color_level` to preserve explicit user overrides.

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

**Purpose**: Maps raw terminal color support and Windows Terminal heuristics into the renderer’s diff color level policy.

**Data flow**: Given `StdoutColorLevel`, `TerminalName`, `has_wt_session`, and `has_force_color_override`, it first promotes any WT_SESSION without FORCE_COLOR to truecolor, otherwise maps raw levels to base diff levels and applies an extra ANSI-16→truecolor promotion for identified Windows Terminal sessions without FORCE_COLOR.

**Call relations**: Pure policy function used by `diff_color_level` and heavily exercised by tests.

*Call graph*: called by 1 (diff_color_level).


##### `style_line_bg_for`  (lines 1141–1151)

```
fn style_line_bg_for(kind: DiffLineType, diff_backgrounds: ResolvedDiffBackgrounds) -> Style
```

**Purpose**: Returns the full-line background style for insert/delete/context lines based on resolved diff backgrounds.

**Data flow**: Matches `DiffLineType`; insert/delete return `Style::default().bg(...)` when a background exists, otherwise default style, and context always returns default style.

**Call relations**: Used by the inner diff-line renderer to tint the entire row.

*Call graph*: called by 1 (push_wrapped_diff_line_inner_with_theme_and_color_level); 1 external calls (default).


##### `style_context`  (lines 1153–1155)

```
fn style_context() -> Style
```

**Purpose**: Returns the neutral style for context lines and context gutter signs.

**Data flow**: Returns `Style::default()`.

**Call relations**: Used by the inner diff-line renderer for unchanged lines.

*Call graph*: called by 1 (push_wrapped_diff_line_inner_with_theme_and_color_level); 1 external calls (default).


##### `add_line_bg`  (lines 1157–1164)

```
fn add_line_bg(theme: DiffTheme, color_level: RichDiffColorLevel) -> Color
```

**Purpose**: Returns the fallback insert-line background color for a given theme and rich color level.

**Data flow**: Matches `(theme, color_level)` and returns either a truecolor RGB or ANSI-256 indexed `Color` constant.

**Call relations**: Used by `fallback_diff_backgrounds`.

*Call graph*: calls 2 internal fn (indexed_color, rgb_color); called by 1 (fallback_diff_backgrounds).


##### `del_line_bg`  (lines 1166–1173)

```
fn del_line_bg(theme: DiffTheme, color_level: RichDiffColorLevel) -> Color
```

**Purpose**: Returns the fallback delete-line background color for a given theme and rich color level.

**Data flow**: Matches `(theme, color_level)` and returns the corresponding RGB or indexed `Color` constant.

**Call relations**: Used by `fallback_diff_backgrounds`.

*Call graph*: calls 2 internal fn (indexed_color, rgb_color); called by 1 (fallback_diff_backgrounds).


##### `light_gutter_fg`  (lines 1175–1181)

```
fn light_gutter_fg(color_level: DiffColorLevel) -> Color
```

**Purpose**: Returns the foreground color used for line-number gutters on light backgrounds.

**Data flow**: Maps truecolor and ANSI-256 to configured palette colors and ANSI-16 to `Color::Black`.

**Call relations**: Used by `style_gutter_for`.

*Call graph*: calls 2 internal fn (indexed_color, rgb_color); called by 1 (style_gutter_for).


##### `light_add_num_bg`  (lines 1183–1188)

```
fn light_add_num_bg(color_level: RichDiffColorLevel) -> Color
```

**Purpose**: Returns the light-theme insert gutter background color for rich color levels.

**Data flow**: Maps `RichDiffColorLevel` to either the configured RGB or ANSI-256 indexed color.

**Call relations**: Used by `style_gutter_for` for insert lines on light themes.

*Call graph*: calls 2 internal fn (indexed_color, rgb_color); called by 1 (style_gutter_for).


##### `light_del_num_bg`  (lines 1190–1195)

```
fn light_del_num_bg(color_level: RichDiffColorLevel) -> Color
```

**Purpose**: Returns the light-theme delete gutter background color for rich color levels.

**Data flow**: Maps `RichDiffColorLevel` to either the configured RGB or ANSI-256 indexed color.

**Call relations**: Used by `style_gutter_for` for delete lines on light themes.

*Call graph*: calls 2 internal fn (indexed_color, rgb_color); called by 1 (style_gutter_for).


##### `style_gutter_for`  (lines 1200–1220)

```
fn style_gutter_for(kind: DiffLineType, theme: DiffTheme, color_level: DiffColorLevel) -> Style
```

**Purpose**: Computes the line-number gutter style, using opaque tinted backgrounds on light themes when color depth allows and dim styling otherwise.

**Data flow**: Matches on theme, line kind, and rich-color availability. Light insert/delete lines get readable foreground plus optional add/del gutter backgrounds; all other cases fall back to `style_gutter_dim()`.

**Call relations**: Used by both the inner diff-line renderer and hunk-separator rendering in `render_change`.

*Call graph*: calls 5 internal fn (from_diff_color_level, light_add_num_bg, light_del_num_bg, light_gutter_fg, style_gutter_dim); called by 2 (push_wrapped_diff_line_inner_with_theme_and_color_level, render_change); 1 external calls (default).


##### `style_sign_add`  (lines 1225–1234)

```
fn style_sign_add(
    theme: DiffTheme,
    color_level: DiffColorLevel,
    diff_backgrounds: ResolvedDiffBackgrounds,
) -> Style
```

**Purpose**: Computes the style for the `+` sign on insert lines.

**Data flow**: On light themes returns foreground-only green; on dark themes delegates to `style_add(...)` so the sign shares the full insert style.

**Call relations**: Used by the inner diff-line renderer and tested for ANSI-16 behavior.

*Call graph*: calls 1 internal fn (style_add); called by 2 (push_wrapped_diff_line_inner_with_theme_and_color_level, ansi16_sign_styles_use_foreground_only); 1 external calls (default).


##### `style_sign_del`  (lines 1237–1246)

```
fn style_sign_del(
    theme: DiffTheme,
    color_level: DiffColorLevel,
    diff_backgrounds: ResolvedDiffBackgrounds,
) -> Style
```

**Purpose**: Computes the style for the `-` sign on delete lines.

**Data flow**: On light themes returns foreground-only red; on dark themes delegates to `style_del(...)`.

**Call relations**: Used by the inner diff-line renderer and tested for ANSI-16 behavior.

*Call graph*: calls 1 internal fn (style_del); called by 2 (push_wrapped_diff_line_inner_with_theme_and_color_level, ansi16_sign_styles_use_foreground_only); 1 external calls (default).


##### `style_add`  (lines 1259–1277)

```
fn style_add(
    theme: DiffTheme,
    color_level: DiffColorLevel,
    diff_backgrounds: ResolvedDiffBackgrounds,
) -> Style
```

**Purpose**: Computes the content style for plain insert lines, combining foreground and optional background according to theme and color depth.

**Data flow**: Matches `(theme, color_level, diff_backgrounds.add)`; ANSI-16 is green foreground only, light rich modes use background-only pastel fills, dark rich modes use green foreground plus tinted background, and missing backgrounds degrade gracefully to foreground-only or default style.

**Call relations**: Used by the inner diff-line renderer and by `style_sign_add` on dark themes.

*Call graph*: called by 3 (push_wrapped_diff_line_inner_with_theme_and_color_level, style_sign_add, ansi16_add_style_uses_foreground_only); 1 external calls (default).


##### `style_del`  (lines 1283–1301)

```
fn style_del(
    theme: DiffTheme,
    color_level: DiffColorLevel,
    diff_backgrounds: ResolvedDiffBackgrounds,
) -> Style
```

**Purpose**: Computes the content style for plain delete lines, mirroring `style_add` with red foreground and delete backgrounds.

**Data flow**: Matches `(theme, color_level, diff_backgrounds.del)` and returns the appropriate foreground/background combination or graceful fallback.

**Call relations**: Used by the inner diff-line renderer and by `style_sign_del` on dark themes.

*Call graph*: called by 3 (push_wrapped_diff_line_inner_with_theme_and_color_level, style_sign_del, ansi16_del_style_uses_foreground_only); 1 external calls (default).


##### `style_gutter_dim`  (lines 1303–1305)

```
fn style_gutter_dim() -> Style
```

**Purpose**: Returns the dimmed gutter style used on dark themes and non-special cases.

**Data flow**: Builds `Style::default().add_modifier(Modifier::DIM)`.

**Call relations**: Fallback branch for `style_gutter_for`.

*Call graph*: called by 1 (style_gutter_for); 1 external calls (default).


##### `tests::ansi16_add_style_uses_foreground_only`  (lines 1321–1329)

```
fn ansi16_add_style_uses_foreground_only()
```

**Purpose**: Verifies that insert styling in ANSI-16 mode does not apply a background.

**Data flow**: Builds fallback ANSI-16 backgrounds, computes `style_add`, and asserts green foreground with no background.

**Call relations**: Unit test for ANSI-16 degradation policy.

*Call graph*: calls 2 internal fn (fallback_diff_backgrounds, style_add); 1 external calls (assert_eq!).


##### `tests::ansi16_del_style_uses_foreground_only`  (lines 1332–1340)

```
fn ansi16_del_style_uses_foreground_only()
```

**Purpose**: Verifies that delete styling in ANSI-16 mode does not apply a background.

**Data flow**: Builds fallback ANSI-16 backgrounds, computes `style_del`, and asserts red foreground with no background.

**Call relations**: Complements the insert ANSI-16 style test.

*Call graph*: calls 2 internal fn (fallback_diff_backgrounds, style_del); 1 external calls (assert_eq!).


##### `tests::ansi16_sign_styles_use_foreground_only`  (lines 1343–1359)

```
fn ansi16_sign_styles_use_foreground_only()
```

**Purpose**: Checks that `+` and `-` sign styles also avoid backgrounds in ANSI-16 mode.

**Data flow**: Computes `style_sign_add` and `style_sign_del` with ANSI-16 fallback backgrounds and asserts foreground-only colors.

**Call relations**: Covers sign-specific styling policy.

*Call graph*: calls 3 internal fn (fallback_diff_backgrounds, style_sign_add, style_sign_del); 1 external calls (assert_eq!).


##### `tests::diff_summary_for_tests`  (lines 1360–1362)

```
fn diff_summary_for_tests(changes: &HashMap<PathBuf, FileChange>) -> Vec<RtLine<'static>>
```

**Purpose**: Convenience helper that renders a diff summary against `/` with width 80.

**Data flow**: Delegates to `create_diff_summary(changes, &PathBuf::from("/"), 80)`.

**Call relations**: Shared by many snapshot tests.

*Call graph*: calls 1 internal fn (create_diff_summary); 1 external calls (from).


##### `tests::snapshot_lines`  (lines 1364–1374)

```
fn snapshot_lines(name: &str, lines: Vec<RtLine<'static>>, width: u16, height: u16)
```

**Purpose**: Renders a set of diff lines into a test terminal and snapshots the backend output.

**Data flow**: Creates a `Terminal<TestBackend>`, draws a `Paragraph` containing the provided lines with wrapping disabled for trimming, and snapshots the backend.

**Call relations**: Shared visual snapshot helper for diff-render tests.

*Call graph*: 3 external calls (new, assert_snapshot!, new).


##### `tests::display_width`  (lines 1376–1380)

```
fn display_width(text: &str) -> usize
```

**Purpose**: Computes display width for plain test strings using the same tab-width convention as the renderer.

**Data flow**: Sums per-character widths, treating tabs as `TAB_WIDTH` and unknown widths as zero.

**Call relations**: Used by `line_display_width` in wrapping tests.


##### `tests::line_display_width`  (lines 1382–1387)

```
fn line_display_width(line: &RtLine<'static>) -> usize
```

**Purpose**: Computes the total display width of a rendered `RtLine` by summing its spans.

**Data flow**: Iterates spans, measures each span’s content with the test `display_width`, and sums the results.

**Call relations**: Used to assert wrapped lines stay within width budgets.


##### `tests::snapshot_lines_text`  (lines 1389–1404)

```
fn snapshot_lines_text(name: &str, lines: &[RtLine<'static>])
```

**Purpose**: Converts rendered lines to trimmed plain text and snapshots that text for easier visual inspection of indentation and wrapping.

**Data flow**: Concatenates span contents per line, trims trailing spaces, joins with newlines, and snapshots the resulting string.

**Call relations**: Used by text-oriented snapshot tests.

*Call graph*: 2 external calls (iter, assert_snapshot!).


##### `tests::diff_gallery_changes`  (lines 1406–1460)

```
fn diff_gallery_changes() -> HashMap<PathBuf, FileChange>
```

**Purpose**: Builds a representative multi-file diff fixture covering adds, deletes, updates, renames, tabs, emoji, and CJK text.

**Data flow**: Creates a `HashMap<PathBuf, FileChange>` containing several synthetic file changes, including unified diffs generated by `diffy::create_patch`.

**Call relations**: Used by gallery snapshot tests to exercise many rendering paths at once.

*Call graph*: 3 external calls (new, from, create_patch).


##### `tests::snapshot_diff_gallery`  (lines 1462–1469)

```
fn snapshot_diff_gallery(name: &str, width: u16, height: u16)
```

**Purpose**: Renders the gallery fixture at a given terminal size and snapshots the result.

**Data flow**: Calls `create_diff_summary` on `diff_gallery_changes()` with the requested width, then delegates to `snapshot_lines`.

**Call relations**: Shared helper for multi-size gallery snapshots.

*Call graph*: calls 1 internal fn (create_diff_summary); 4 external calls (from, diff_gallery_changes, snapshot_lines, from).


##### `tests::display_path_prefers_cwd_without_git_repo`  (lines 1472–1489)

```
fn display_path_prefers_cwd_without_git_repo()
```

**Purpose**: Verifies that absolute paths under cwd are displayed relative to cwd even outside a git repo.

**Data flow**: Builds a cwd and child path, calls `display_path_for`, and asserts the result is the relative `tui/example.png` path.

**Call relations**: Direct test of path-display normalization.

*Call graph*: calls 1 internal fn (display_path_for); 3 external calls (from, assert_eq!, cfg!).


##### `tests::ui_snapshot_wrap_behavior_insert`  (lines 1492–1513)

```
fn ui_snapshot_wrap_behavior_insert()
```

**Purpose**: Snapshots wrapping behavior for a long inserted line rendered directly through the wrapped-line helper.

**Data flow**: Builds a long string, renders it with `push_wrapped_diff_line_with_style_context`, and snapshots the resulting lines in a test terminal.

**Call relations**: Exercises the plain wrapped-line path.

*Call graph*: calls 3 internal fn (current_diff_render_style_context, line_number_width, push_wrapped_diff_line_with_style_context); 1 external calls (snapshot_lines).


##### `tests::ui_snapshot_apply_update_block`  (lines 1516–1538)

```
fn ui_snapshot_apply_update_block()
```

**Purpose**: Snapshots rendering of a simple one-file update diff block.

**Data flow**: Creates a one-line replacement patch, renders a summary with `diff_summary_for_tests`, and snapshots it.

**Call relations**: Covers update-diff summary rendering.

*Call graph*: 5 external calls (new, from, create_patch, diff_summary_for_tests, snapshot_lines).


##### `tests::ui_snapshot_apply_update_with_rename_block`  (lines 1541–1563)

```
fn ui_snapshot_apply_update_with_rename_block()
```

**Purpose**: Snapshots rendering of an update diff that also includes a rename destination.

**Data flow**: Creates a patch plus `move_path`, renders the summary, and snapshots it.

**Call relations**: Covers rename header formatting and destination-path display.

*Call graph*: 5 external calls (new, from, create_patch, diff_summary_for_tests, snapshot_lines).


##### `tests::ui_snapshot_apply_multiple_files_block`  (lines 1566–1596)

```
fn ui_snapshot_apply_multiple_files_block()
```

**Purpose**: Snapshots a summary containing multiple files so combined headers and per-file rows are exercised.

**Data flow**: Builds one update and one add change, renders the summary, and snapshots it.

**Call relations**: Covers multi-file summary header logic.

*Call graph*: 5 external calls (new, from, create_patch, diff_summary_for_tests, snapshot_lines).


##### `tests::ui_snapshot_apply_add_block`  (lines 1599–1616)

```
fn ui_snapshot_apply_add_block()
```

**Purpose**: Snapshots rendering of a newly added file block.

**Data flow**: Builds a single `FileChange::Add`, renders the summary, and snapshots it.

**Call relations**: Covers add-file rendering.

*Call graph*: 4 external calls (new, from, diff_summary_for_tests, snapshot_lines).


##### `tests::ui_snapshot_apply_delete_block`  (lines 1619–1635)

```
fn ui_snapshot_apply_delete_block()
```

**Purpose**: Snapshots rendering of a deleted file block.

**Data flow**: Builds a single `FileChange::Delete`, renders the summary, and snapshots it.

**Call relations**: Covers delete-file rendering.

*Call graph*: 4 external calls (new, from, diff_summary_for_tests, snapshot_lines).


##### `tests::ui_snapshot_apply_update_block_wraps_long_lines`  (lines 1638–1662)

```
fn ui_snapshot_apply_update_block_wraps_long_lines()
```

**Purpose**: Snapshots an update diff whose modified line is long enough to wrap multiple times.

**Data flow**: Creates a patch with a very long inserted line, renders with a narrower wrap width than backend width, and snapshots the result.

**Call relations**: Exercises wrapped update rendering without paragraph auto-wrap interference.

*Call graph*: calls 1 internal fn (create_diff_summary); 4 external calls (new, from, create_patch, snapshot_lines).


##### `tests::ui_snapshot_apply_update_block_wraps_long_lines_text`  (lines 1665–1683)

```
fn ui_snapshot_apply_update_block_wraps_long_lines_text()
```

**Purpose**: Text snapshot that verifies wrapped continuation alignment under the gutter for long update lines.

**Data flow**: Creates a wrapping demo patch, renders with narrow wrap columns, and snapshots the plain text lines.

**Call relations**: Focuses on indentation and continuation layout.

*Call graph*: calls 1 internal fn (create_diff_summary); 4 external calls (new, from, create_patch, snapshot_lines_text).


##### `tests::ui_snapshot_apply_update_block_line_numbers_three_digits_text`  (lines 1686–1710)

```
fn ui_snapshot_apply_update_block_line_numbers_three_digits_text()
```

**Purpose**: Snapshots line-number alignment when diff line numbers reach three digits.

**Data flow**: Builds a 110-line patch with one changed line, renders the summary, and snapshots the text output.

**Call relations**: Covers gutter-width scaling.

*Call graph*: calls 1 internal fn (create_diff_summary); 4 external calls (new, from, create_patch, snapshot_lines_text).


##### `tests::ui_snapshot_apply_update_block_relativizes_path`  (lines 1713–1739)

```
fn ui_snapshot_apply_update_block_relativizes_path()
```

**Purpose**: Snapshots that absolute old/new paths under cwd are displayed relatively in rename summaries.

**Data flow**: Builds absolute old/new paths under current dir, renders the summary, and snapshots it.

**Call relations**: Exercises `display_path_for` inside summary rendering.

*Call graph*: calls 1 internal fn (create_diff_summary); 4 external calls (new, create_patch, current_dir, snapshot_lines).


##### `tests::ui_snapshot_syntax_highlighted_insert_wraps`  (lines 1742–1773)

```
fn ui_snapshot_syntax_highlighted_insert_wraps()
```

**Purpose**: Verifies and snapshots that a long syntax-highlighted insert line wraps into multiple rendered lines.

**Data flow**: Highlights a long Rust line, renders it with `push_wrapped_diff_line_with_syntax_and_style_context`, asserts multiple output lines, and snapshots them.

**Call relations**: Exercises syntax-span wrapping.

*Call graph*: calls 4 internal fn (current_diff_render_style_context, line_number_width, push_wrapped_diff_line_with_syntax_and_style_context, highlight_code_to_styled_spans); 2 external calls (assert!, snapshot_lines).


##### `tests::ui_snapshot_syntax_highlighted_insert_wraps_text`  (lines 1776–1794)

```
fn ui_snapshot_syntax_highlighted_insert_wraps_text()
```

**Purpose**: Text snapshot companion for syntax-highlighted wrapped insert rendering.

**Data flow**: Highlights a long Rust line, renders wrapped syntax lines, and snapshots the plain text output.

**Call relations**: Focuses on textual continuation layout for syntax-highlighted content.

*Call graph*: calls 4 internal fn (current_diff_render_style_context, line_number_width, push_wrapped_diff_line_with_syntax_and_style_context, highlight_code_to_styled_spans); 1 external calls (snapshot_lines_text).


##### `tests::ui_snapshot_diff_gallery_80x24`  (lines 1797–1799)

```
fn ui_snapshot_diff_gallery_80x24()
```

**Purpose**: Snapshots the gallery fixture at 80x24.

**Data flow**: Delegates to `snapshot_diff_gallery("diff_gallery_80x24", 80, 24)`.

**Call relations**: One of several gallery size regressions.

*Call graph*: 1 external calls (snapshot_diff_gallery).


##### `tests::ui_snapshot_diff_gallery_94x35`  (lines 1802–1804)

```
fn ui_snapshot_diff_gallery_94x35()
```

**Purpose**: Snapshots the gallery fixture at 94x35.

**Data flow**: Delegates to `snapshot_diff_gallery("diff_gallery_94x35", 94, 35)`.

**Call relations**: Gallery regression at a medium terminal size.

*Call graph*: 1 external calls (snapshot_diff_gallery).


##### `tests::ui_snapshot_diff_gallery_120x40`  (lines 1807–1813)

```
fn ui_snapshot_diff_gallery_120x40()
```

**Purpose**: Snapshots the gallery fixture at 120x40.

**Data flow**: Delegates to `snapshot_diff_gallery("diff_gallery_120x40", 120, 40)`.

**Call relations**: Gallery regression at a wide terminal size.

*Call graph*: 1 external calls (snapshot_diff_gallery).


##### `tests::ui_snapshot_ansi16_insert_delete_no_background`  (lines 1816–1846)

```
fn ui_snapshot_ansi16_insert_delete_no_background()
```

**Purpose**: Snapshots insert/delete rendering in ANSI-16 mode to ensure no backgrounds are applied.

**Data flow**: Renders one insert and one delete line through the inner helper with ANSI-16 fallback backgrounds, then snapshots the result.

**Call relations**: Visual regression for ANSI-16 degradation.

*Call graph*: calls 3 internal fn (fallback_diff_backgrounds, line_number_width, push_wrapped_diff_line_inner_with_theme_and_color_level); 1 external calls (snapshot_lines).


##### `tests::truecolor_dark_theme_uses_configured_backgrounds`  (lines 1849–1880)

```
fn truecolor_dark_theme_uses_configured_backgrounds()
```

**Purpose**: Verifies dark truecolor fallback backgrounds and gutter styles match configured constants.

**Data flow**: Computes styles from `fallback_diff_backgrounds(Dark, TrueColor)` and asserts exact `Style` values for insert/delete line backgrounds and dim gutters.

**Call relations**: Unit test for dark truecolor palette selection.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::ansi256_dark_theme_uses_distinct_add_and_delete_backgrounds`  (lines 1883–1909)

```
fn ansi256_dark_theme_uses_distinct_add_and_delete_backgrounds()
```

**Purpose**: Verifies dark ANSI-256 insert and delete backgrounds are distinct and match configured palette indices.

**Data flow**: Computes line background styles for insert and delete and asserts exact indexed colors plus inequality.

**Call relations**: Unit test for ANSI-256 fallback palette.

*Call graph*: 2 external calls (assert_eq!, assert_ne!).


##### `tests::theme_scope_backgrounds_override_truecolor_fallback_when_available`  (lines 1912–1929)

```
fn theme_scope_backgrounds_override_truecolor_fallback_when_available()
```

**Purpose**: Checks that syntax-theme diff scope backgrounds override fallback truecolor backgrounds.

**Data flow**: Calls `resolve_diff_backgrounds_for` with explicit inserted/deleted RGBs and asserts `style_line_bg_for` uses those RGBs.

**Call relations**: Covers theme-scope override behavior.

*Call graph*: calls 1 internal fn (resolve_diff_backgrounds_for); 1 external calls (assert_eq!).


##### `tests::theme_scope_backgrounds_quantize_to_ansi256`  (lines 1932–1949)

```
fn theme_scope_backgrounds_quantize_to_ansi256()
```

**Purpose**: Checks that syntax-theme diff scope backgrounds are quantized when rendering in ANSI-256 mode.

**Data flow**: Resolves backgrounds with an inserted RGB and no deleted RGB under ANSI-256, then asserts the insert background quantizes to index 22 while delete falls back.

**Call relations**: Covers ANSI-256 theme-scope quantization.

*Call graph*: calls 1 internal fn (resolve_diff_backgrounds_for); 1 external calls (assert_eq!).


##### `tests::ui_snapshot_theme_scope_background_resolution`  (lines 1952–1967)

```
fn ui_snapshot_theme_scope_background_resolution()
```

**Purpose**: Snapshots the resolved insert/delete background colors when only one theme scope background is provided.

**Data flow**: Resolves backgrounds, formats the resulting insert/delete background debug values into a string, and snapshots it.

**Call relations**: Regression test for background-resolution output.

*Call graph*: calls 1 internal fn (resolve_diff_backgrounds_for); 2 external calls (assert_snapshot!, format!).


##### `tests::ansi16_disables_line_and_gutter_backgrounds`  (lines 1970–2017)

```
fn ansi16_disables_line_and_gutter_backgrounds()
```

**Purpose**: Verifies that ANSI-16 mode disables both line backgrounds and rich gutter backgrounds even if theme scopes provide RGBs.

**Data flow**: Asserts default line backgrounds and black light-theme gutter foregrounds for ANSI-16 fallback and themed backgrounds.

**Call relations**: Covers the invariant encoded by `RichDiffColorLevel`.

*Call graph*: calls 1 internal fn (resolve_diff_backgrounds_for); 1 external calls (assert_eq!).


##### `tests::light_truecolor_theme_uses_readable_gutter_and_line_backgrounds`  (lines 2020–2055)

```
fn light_truecolor_theme_uses_readable_gutter_and_line_backgrounds()
```

**Purpose**: Verifies the configured light-theme truecolor line and gutter backgrounds.

**Data flow**: Computes styles from `fallback_diff_backgrounds(Light, TrueColor)` and asserts exact RGB-based line and gutter styles.

**Call relations**: Unit test for light truecolor palette selection.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::light_theme_wrapped_lines_keep_number_gutter_contrast`  (lines 2058–2089)

```
fn light_theme_wrapped_lines_keep_number_gutter_contrast()
```

**Purpose**: Checks that wrapped continuation lines preserve the same readable gutter styling and line background on light themes.

**Data flow**: Renders a wrapped insert line under light truecolor settings, asserts multiple lines, and compares first and continuation gutter styles and line backgrounds.

**Call relations**: Covers continuation-line styling consistency.

*Call graph*: calls 3 internal fn (fallback_diff_backgrounds, line_number_width, push_wrapped_diff_line_inner_with_theme_and_color_level); 2 external calls (assert!, assert_eq!).


##### `tests::windows_terminal_promotes_ansi16_to_truecolor_for_diffs`  (lines 2092–2102)

```
fn windows_terminal_promotes_ansi16_to_truecolor_for_diffs()
```

**Purpose**: Verifies Windows Terminal ANSI-16 sessions are promoted to truecolor when no override is present.

**Data flow**: Calls `diff_color_level_for_terminal` with `Ansi16`, `WindowsTerminal`, no WT_SESSION, no FORCE_COLOR, and asserts `TrueColor`.

**Call relations**: Unit test for Windows Terminal promotion policy.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::wt_session_promotes_ansi16_to_truecolor_for_diffs`  (lines 2105–2115)

```
fn wt_session_promotes_ansi16_to_truecolor_for_diffs()
```

**Purpose**: Verifies that WT_SESSION alone promotes ANSI-16 to truecolor.

**Data flow**: Calls the pure policy helper with `has_wt_session = true` and asserts `TrueColor`.

**Call relations**: Covers the WT_SESSION-specific promotion branch.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::non_windows_terminal_keeps_ansi16_diff_palette`  (lines 2118–2128)

```
fn non_windows_terminal_keeps_ansi16_diff_palette()
```

**Purpose**: Verifies non-Windows terminals remain on ANSI-16 when only ANSI-16 support is reported.

**Data flow**: Calls the policy helper with `WezTerm`, no WT_SESSION, no FORCE_COLOR, and asserts `Ansi16`.

**Call relations**: Negative control for promotion logic.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::wt_session_promotes_unknown_color_level_to_truecolor`  (lines 2131–2141)

```
fn wt_session_promotes_unknown_color_level_to_truecolor()
```

**Purpose**: Verifies WT_SESSION also promotes an otherwise unknown color level to truecolor.

**Data flow**: Calls the policy helper with `Unknown`, `WindowsTerminal`, WT_SESSION present, and asserts `TrueColor`.

**Call relations**: Covers the unconditional WT_SESSION promotion branch.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::non_wt_windows_terminal_keeps_unknown_color_level_conservative`  (lines 2144–2154)

```
fn non_wt_windows_terminal_keeps_unknown_color_level_conservative()
```

**Purpose**: Verifies unknown color level without WT_SESSION stays conservative even on Windows Terminal.

**Data flow**: Calls the policy helper with `Unknown`, `WindowsTerminal`, no WT_SESSION, and asserts `Ansi16`.

**Call relations**: Negative control for unknown-level handling.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::explicit_force_override_keeps_ansi16_on_windows_terminal`  (lines 2157–2167)

```
fn explicit_force_override_keeps_ansi16_on_windows_terminal()
```

**Purpose**: Verifies `FORCE_COLOR` suppresses Windows Terminal ANSI-16 promotion.

**Data flow**: Calls the policy helper with ANSI-16, Windows Terminal, and `has_force_color_override = true`, asserting `Ansi16`.

**Call relations**: Covers explicit user override behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::explicit_force_override_keeps_ansi256_on_windows_terminal`  (lines 2170–2180)

```
fn explicit_force_override_keeps_ansi256_on_windows_terminal()
```

**Purpose**: Verifies `FORCE_COLOR` also preserves ANSI-256 instead of promoting to truecolor.

**Data flow**: Calls the policy helper with ANSI-256, WT_SESSION present, FORCE_COLOR present, and asserts `Ansi256`.

**Call relations**: Complements the ANSI-16 override test.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::add_diff_uses_path_extension_for_highlighting`  (lines 2183–2202)

```
fn add_diff_uses_path_extension_for_highlighting()
```

**Purpose**: Checks that added files use their path extension to trigger syntax highlighting.

**Data flow**: Builds an added `.rs` file, renders the summary, scans spans for RGB foreground colors, and asserts at least one exists.

**Call relations**: Covers language detection for added files.

*Call graph*: calls 1 internal fn (create_diff_summary); 3 external calls (new, from, assert!).


##### `tests::cpp_module_extensions_use_cpp_highlighting`  (lines 2205–2236)

```
fn cpp_module_extensions_use_cpp_highlighting()
```

**Purpose**: Verifies several C++ module-related extensions all trigger syntax highlighting.

**Data flow**: For each extension, builds an added file, renders the summary, collects RGB-colored token contents, asserts non-empty highlighting, and snapshots the collected tokens.

**Call relations**: Regression test for extension-based syntax detection.

*Call graph*: 1 external calls (assert_debug_snapshot!).


##### `tests::unknown_extension_falls_back_without_syntax_highlighting`  (lines 2239–2254)

```
fn unknown_extension_falls_back_without_syntax_highlighting()
```

**Purpose**: Checks that unknown file extensions do not produce syntax-highlighted RGB spans.

**Data flow**: Builds an added file with an unknown extension, renders the summary, and asserts all span foregrounds are non-RGB.

**Call relations**: Negative control for language detection.

*Call graph*: calls 1 internal fn (create_diff_summary); 3 external calls (new, from, assert!).


##### `tests::delete_diff_uses_path_extension_for_highlighting`  (lines 2257–2276)

```
fn delete_diff_uses_path_extension_for_highlighting()
```

**Purpose**: Checks that deleted files also use their path extension for syntax highlighting.

**Data flow**: Builds a deleted `.py` file, renders the summary, scans for RGB foreground spans, and asserts highlighting occurred.

**Call relations**: Covers language detection for deleted files.

*Call graph*: calls 1 internal fn (create_diff_summary); 3 external calls (new, from, assert!).


##### `tests::detect_lang_for_common_paths`  (lines 2279–2288)

```
fn detect_lang_for_common_paths()
```

**Purpose**: Verifies extension detection succeeds for common source files and fails for extensionless names.

**Data flow**: Calls `detect_lang_for_path` on several paths and asserts `Some` or `None` as appropriate.

**Call relations**: Direct unit test for extension extraction.

*Call graph*: 1 external calls (assert!).


##### `tests::wrap_styled_spans_single_line`  (lines 2291–2296)

```
fn wrap_styled_spans_single_line()
```

**Purpose**: Verifies that short content fitting within the width budget produces exactly one wrapped chunk.

**Data flow**: Wraps a single short span at width 80 and asserts the result length is 1.

**Call relations**: Basic sanity test for `wrap_styled_spans`.

*Call graph*: calls 1 internal fn (wrap_styled_spans); 2 external calls (assert_eq!, vec!).


##### `tests::wrap_styled_spans_splits_long_content`  (lines 2299–2309)

```
fn wrap_styled_spans_splits_long_content()
```

**Purpose**: Verifies that long content wider than the width budget is split into multiple chunks.

**Data flow**: Wraps a 100-character span at width 40 and asserts at least three output lines.

**Call relations**: Basic long-line wrapping test.

*Call graph*: calls 1 internal fn (wrap_styled_spans); 2 external calls (assert!, vec!).


##### `tests::wrap_styled_spans_flushes_at_span_boundary`  (lines 2312–2334)

```
fn wrap_styled_spans_flushes_at_span_boundary()
```

**Purpose**: Checks that when one span exactly fills a line, the next span starts on a fresh line instead of overflowing.

**Data flow**: Wraps two differently styled spans at width 4, asserts two lines are produced, and checks the first line width stays within budget.

**Call relations**: Regression test for exact-boundary flushing.

*Call graph*: calls 1 internal fn (wrap_styled_spans); 4 external calls (default, assert!, assert_eq!, vec!).


##### `tests::wrap_styled_spans_preserves_styles`  (lines 2337–2348)

```
fn wrap_styled_spans_preserves_styles()
```

**Purpose**: Verifies that span styles survive wrapping splits unchanged.

**Data flow**: Wraps a long green span at width 20 and asserts every resulting span still has the original style.

**Call relations**: Covers style preservation across wraps.

*Call graph*: calls 1 internal fn (wrap_styled_spans); 3 external calls (default, assert_eq!, vec!).


##### `tests::wrap_styled_spans_tabs_have_visible_width`  (lines 2351–2361)

```
fn wrap_styled_spans_tabs_have_visible_width()
```

**Purpose**: Checks that tabs count as visible columns during wrapping rather than zero-width characters.

**Data flow**: Wraps `\tabcde` at width 8 and asserts the result spans at least two lines.

**Call relations**: Covers tab-width handling.

*Call graph*: calls 1 internal fn (wrap_styled_spans); 2 external calls (assert!, vec!).


##### `tests::wrap_styled_spans_wraps_before_first_overflowing_char`  (lines 2364–2390)

```
fn wrap_styled_spans_wraps_before_first_overflowing_char()
```

**Purpose**: Verifies wrapping breaks before the first character that would overflow, including tabs and wide characters.

**Data flow**: Wraps `abcd\t界` at width 5, reconstructs line texts, asserts the split is `["abcd", "\t", "界"]`, and checks each line’s display width stays within 5.

**Call relations**: Regression test for overflow-before-consume behavior.

*Call graph*: calls 1 internal fn (wrap_styled_spans); 3 external calls (assert!, assert_eq!, vec!).


##### `tests::fallback_wrapping_uses_display_width_for_tabs_and_wide_chars`  (lines 2393–2411)

```
fn fallback_wrapping_uses_display_width_for_tabs_and_wide_chars()
```

**Purpose**: Checks that the plain diff-line wrapper respects display width for tabs and wide characters.

**Data flow**: Renders `abcd\t界🙂` as an insert line at width 8 and asserts multiple lines are produced and each rendered line’s display width stays within budget.

**Call relations**: End-to-end wrapping test through the public plain-line helper.

*Call graph*: calls 3 internal fn (current_diff_render_style_context, line_number_width, push_wrapped_diff_line_with_style_context); 1 external calls (assert!).


##### `tests::large_update_diff_skips_highlighting`  (lines 2414–2465)

```
fn large_update_diff_skips_highlighting()
```

**Purpose**: Verifies that very large update diffs render without syntax highlighting to avoid pathological performance.

**Data flow**: Builds a 10,500-line patch, renders the summary, asserts substantial output exists, and panics if any span has an RGB foreground color.

**Call relations**: Covers the `exceeds_highlight_limits` guardrail in `render_change`.

*Call graph*: calls 1 internal fn (create_diff_summary); 5 external calls (new, from, assert!, create_patch, panic!).


##### `tests::rename_diff_uses_destination_extension_for_highlighting`  (lines 2468–2495)

```
fn rename_diff_uses_destination_extension_for_highlighting()
```

**Purpose**: Checks that renamed update diffs use the destination extension, not the source extension, for syntax highlighting.

**Data flow**: Builds a rename from `.xyzzy` to `.rs`, renders the summary, scans for RGB spans, and asserts highlighting occurred.

**Call relations**: Regression test for rename-language detection.

*Call graph*: calls 1 internal fn (create_diff_summary); 4 external calls (new, from, assert!, create_patch).


##### `tests::update_diff_preserves_multiline_highlight_state_within_hunk`  (lines 2498–2533)

```
fn update_diff_preserves_multiline_highlight_state_within_hunk()
```

**Purpose**: Verifies that syntax highlighting for update diffs preserves parser state across consecutive lines within a hunk.

**Data flow**: Builds a Rust patch introducing a multiline string, computes expected highlighting for the multiline snippet directly, renders the diff summary, extracts the style of the `world` span from output, and asserts it matches the expected style.

**Call relations**: Covers the hunk-level highlighting strategy in `render_change`.

*Call graph*: calls 2 internal fn (create_diff_summary, highlight_code_to_styled_spans); 4 external calls (new, from, assert_eq!, create_patch).


### `tui/src/git_action_directives.rs`

`domain_logic` · `response parsing`

This file defines the directive grammar embedded in assistant responses. `GitActionDirective` models supported hidden actions: stage, commit, create branch, push, and create PR, each carrying a `cwd` and, where needed, branch name, URL, or draft flag. `ParsedAssistantMarkdown` stores the cleaned `visible_markdown` plus the deduplicated `git_actions` extracted from the original text.

`parse_assistant_markdown` processes the input line by line. It first gives each line to `rewrite_code_comment_line`; if that recognizes a leading `:code-comment{...}`/`::...`/`:::...` directive, it converts it into a visible markdown bullet with title, normalized file path relative to `cwd` when possible, line range, and body text, preserving indentation and any suffix after the closing brace. Otherwise it calls `strip_line_directives`, which removes inline `::git-*{...}` directives from the visible text while collecting parsed actions. A `HashSet` prevents duplicate actions from being appended more than once. After processing all lines, trailing empty visible lines are trimmed.

Attribute parsing is intentionally split: code-comment directives use `parse_code_comment_attributes` plus `parse_quoted_value`, which supports escaped quotes inside quoted values; Git directives use the simpler `parse_attributes`, which accepts quoted or unquoted whitespace-delimited values but does not handle escapes. Priority handling for code comments is nuanced: an explicit `[P#]` prefix in the title wins, otherwise a numeric `priority` attribute in `0..=3` is prepended. Helper methods expose the cwd of branch-creation directives and the last such cwd in a parsed markdown block.

#### Function details

##### `GitActionDirective::created_branch_cwd`  (lines 32–37)

```
fn created_branch_cwd(&self) -> Option<&str>
```

**Purpose**: Returns the working directory only for `CreateBranch` directives. It is a narrow accessor used to identify branch-creation context.

**Data flow**: It takes `&self`, matches on the enum variant, returns `Some(cwd)` for `GitActionDirective::CreateBranch`, and `None` for all other variants. It is pure and borrows the stored string slice.

**Call relations**: This helper is consumed by `ParsedAssistantMarkdown::last_created_branch_cwd`, which scans parsed actions for the most recent branch-creation directive.


##### `ParsedAssistantMarkdown::last_created_branch_cwd`  (lines 47–52)

```
fn last_created_branch_cwd(&self) -> Option<&str>
```

**Purpose**: Finds the cwd from the last branch-creation directive in the parsed action list. It gives later logic a quick way to infer where a newly created branch lives.

**Data flow**: It reads `self.git_actions`, iterates in reverse order, applies `GitActionDirective::created_branch_cwd` with `find_map`, and returns the first matching cwd as `Option<&str>`. It does not mutate state.

**Call relations**: Callers use this after `parse_assistant_markdown` when they need branch-context information from the extracted directives.


##### `parse_assistant_markdown`  (lines 55–85)

```
fn parse_assistant_markdown(markdown: &str, cwd: &Path) -> ParsedAssistantMarkdown
```

**Purpose**: Parses assistant markdown into visible text and a deduplicated list of hidden Git actions. It also rewrites standalone code-comment directives into readable markdown rows.

**Data flow**: It takes the raw markdown string and current `cwd`, initializes `git_actions`, a `HashSet` of seen actions, and `visible_lines`, then iterates over `markdown.lines()`. For each line it first calls `rewrite_code_comment_line`; if that returns `Some`, it trims trailing whitespace and pushes the rewritten line. Otherwise it calls `strip_line_directives`, inserts any newly seen actions into `git_actions`, and pushes the directive-stripped visible line with trailing whitespace removed. After the loop it pops trailing empty lines and returns `ParsedAssistantMarkdown { visible_markdown: visible_lines.join("\n"), git_actions }`.

**Call relations**: This is the main parser entry point used by transcript rendering and all tests in this module. It delegates code-comment recognition to `rewrite_code_comment_line` and inline Git directive stripping to `strip_line_directives`.

*Call graph*: calls 2 internal fn (rewrite_code_comment_line, strip_line_directives); called by 6 (hides_malformed_directives_without_materializing_rows, last_created_branch_cwd_uses_the_last_matching_directive, preserves_non_directive_and_malformed_code_comment_text, renders_code_comment_directives_as_markdown, strips_and_parses_git_action_directives, thread_to_transcript_cells); 2 external calls (new, new).


##### `rewrite_code_comment_line`  (lines 87–132)

```
fn rewrite_code_comment_line(line: &str, cwd: &Path) -> Option<String>
```

**Purpose**: Recognizes a leading code-comment directive line and rewrites it into a visible markdown bullet with title, location, and body. It supports one to three leading colons and preserves indentation.

**Data flow**: It takes a line and `cwd`, strips leading spaces/tabs to compute indentation, counts leading `:` bytes and rejects counts outside `1..=3`, then looks for a `code-comment{...}` payload. It splits attributes from any suffix at the last `}`, parses attributes with `parse_code_comment_attributes`, extracts required `title`, `body`, and `file`, computes `start` and `end` via `directive_integer`, decides whether to prepend `[P#]` based on `title_has_priority` and the `priority` attribute, normalizes the file path relative to `cwd` and with `/` separators, formats either `file:start` or `file:start-end`, and returns the final multi-line markdown string. Invalid structure or missing required fields yields `None`.

**Call relations**: Only `parse_assistant_markdown` calls this, and it takes precedence over inline Git directive stripping so code-comment lines become visible markdown instead of being treated as ordinary text.

*Call graph*: calls 3 internal fn (directive_integer, parse_code_comment_attributes, title_has_priority); called by 1 (parse_assistant_markdown); 2 external calls (new, format!).


##### `strip_line_directives`  (lines 134–160)

```
fn strip_line_directives(line: &str) -> (String, Vec<GitActionDirective>)
```

**Purpose**: Removes inline `::git-*{...}` directives from a line while collecting any successfully parsed actions. Malformed directive syntax is left visible from the point parsing fails.

**Data flow**: It takes a line, initializes `visible`, `actions`, and `remaining`, then repeatedly searches for `::git-`. For each occurrence it copies preceding text into `visible`, locates the directive name and balanced `{...}` segment by searching for braces, and if either brace is missing it appends the untouched remainder and returns. When a full directive is found it calls `parse_git_action`; successful parses are pushed into `actions`, and parsing then continues after the closing brace. At the end it appends any leftover text and returns `(visible, actions)`.

**Call relations**: This helper is called by `parse_assistant_markdown` for all lines not consumed by `rewrite_code_comment_line`. It delegates directive semantics to `parse_git_action`.

*Call graph*: calls 1 internal fn (parse_git_action); called by 1 (parse_assistant_markdown); 2 external calls (new, new).


##### `directive_integer`  (lines 162–169)

```
fn directive_integer(attributes: &HashMap<String, String>, name: &str) -> Option<i64>
```

**Purpose**: Parses an integer attribute value, optionally accepting a leading `P` or `p` prefix. It is used for code-comment line numbers and priorities.

**Data flow**: It takes an attribute map and a key name, looks up the string value, trims whitespace, strips a leading `P`/`p`, attempts `.parse()` to `i64`, and returns `Option<i64>`. It is pure.

**Call relations**: `rewrite_code_comment_line` uses this helper to interpret `start`, `end`, and `priority` attributes without duplicating parsing logic.

*Call graph*: called by 1 (rewrite_code_comment_line).


##### `title_has_priority`  (lines 171–178)

```
fn title_has_priority(title: &str) -> bool
```

**Purpose**: Detects whether a title already begins with a `[P#]` priority marker. This prevents the parser from prepending a second priority prefix.

**Data flow**: It trims leading whitespace from the title, inspects the first four bytes, and returns true only when they match `[`, `P` or `p`, an ASCII digit, and `]`. It has no side effects.

**Call relations**: This helper is called by `rewrite_code_comment_line` before deciding whether to synthesize a priority prefix from the `priority` attribute.

*Call graph*: called by 1 (rewrite_code_comment_line); 1 external calls (matches!).


##### `parse_code_comment_attributes`  (lines 180–200)

```
fn parse_code_comment_attributes(input: &str) -> Option<HashMap<String, String>>
```

**Purpose**: Parses whitespace-separated `key=value` attributes for code-comment directives, supporting quoted values with escaped quotes. It is more capable than the Git directive attribute parser because code-comment bodies can contain spaces and embedded quotes.

**Data flow**: It takes the raw attribute string, trims it, loops until empty, finds the next `=`, validates a non-empty key, then parses either a quoted value via `parse_quoted_value` or an unquoted token up to the next whitespace. Each parsed pair is inserted into a `HashMap<String, String>`. Any malformed structure returns `None`; otherwise it returns the completed map.

**Call relations**: Only `rewrite_code_comment_line` calls this helper, relying on it to decode rich attributes like `title`, `body`, and `file`.

*Call graph*: calls 1 internal fn (parse_quoted_value); called by 1 (rewrite_code_comment_line); 1 external calls (new).


##### `parse_git_action`  (lines 202–224)

```
fn parse_git_action(name: &str, attributes: &str) -> Option<GitActionDirective>
```

**Purpose**: Converts a directive name plus raw attributes into a concrete `GitActionDirective` variant. It validates required fields like `cwd` and `branch` according to the directive type.

**Data flow**: It takes a directive `name` and attribute string, parses the attributes with `parse_attributes`, clones the required `cwd`, then matches the name to construct `Stage`, `Commit`, `CreateBranch`, `Push`, or `CreatePr`. `CreatePr` also reads optional `url` and interprets `isDraft=true` as a boolean. Unknown names or missing required attributes return `None`.

**Call relations**: This helper is called by `strip_line_directives` for each syntactically complete inline directive. It delegates low-level key/value parsing to `parse_attributes`.

*Call graph*: calls 1 internal fn (parse_attributes); called by 1 (strip_line_directives).


##### `parse_attributes`  (lines 226–247)

```
fn parse_attributes(input: &str) -> Option<std::collections::HashMap<String, String>>
```

**Purpose**: Parses simple whitespace-separated `key=value` pairs for Git directives. It supports quoted values but not escaped quotes inside them.

**Data flow**: It takes the raw attribute string, trims it, repeatedly finds `=`, validates a non-empty key, then parses either a quoted value up to the next `"` or an unquoted token up to whitespace. Parsed pairs are inserted into a `HashMap<String, String>`, and malformed input returns `None`.

**Call relations**: Only `parse_git_action` uses this helper, since Git directives need simpler parsing than code-comment directives.

*Call graph*: called by 1 (parse_git_action); 1 external calls (new).


##### `parse_quoted_value`  (lines 249–267)

```
fn parse_quoted_value(input: &str) -> Option<(String, &str)>
```

**Purpose**: Parses a quoted attribute value for code-comment directives, honoring `\"` as an escaped quote. It returns both the decoded value and the remaining unparsed suffix.

**Data flow**: It takes the input after an opening quote, iterates through characters with indices, accumulates decoded characters into a `String`, treats backslash-plus-quote as a literal quote, and stops when it finds an unescaped closing quote. On success it returns `(value, rest_after_quote)`; if no closing quote exists it returns `None`.

**Call relations**: This helper is used only by `parse_code_comment_attributes`, enabling richer quoted values for code-comment titles and bodies.

*Call graph*: called by 1 (parse_code_comment_attributes); 1 external calls (new).


##### `tests::strips_and_parses_git_action_directives`  (lines 275–297)

```
fn strips_and_parses_git_action_directives()
```

**Purpose**: Verifies that inline Git directives are removed from visible markdown and parsed into the expected action list. It also confirms duplicate directives are preserved only when their payload differs.

**Data flow**: It calls `parse_assistant_markdown` on markdown containing stage and push directives plus a second stage directive with a different cwd, then asserts the visible markdown is just `Done` and the parsed `git_actions` vector matches the expected variants and field values.

**Call relations**: This test exercises the main parser path through `parse_assistant_markdown`, `strip_line_directives`, `parse_git_action`, and `parse_attributes`.

*Call graph*: calls 1 internal fn (parse_assistant_markdown); 2 external calls (new, assert_eq!).


##### `tests::hides_malformed_directives_without_materializing_rows`  (lines 300–305)

```
fn hides_malformed_directives_without_materializing_rows()
```

**Purpose**: Checks that malformed Git directives are stripped from the visible text but do not produce parsed actions. It protects the parser’s fail-soft behavior for incomplete directives.

**Data flow**: It parses a line containing `::git-push{cwd="/repo"}` without the required branch attribute, then asserts the visible markdown is `Done` and `git_actions` is empty. It performs no side effects.

**Call relations**: This test targets the branch where `strip_line_directives` finds a syntactically complete directive but `parse_git_action` rejects it semantically.

*Call graph*: calls 1 internal fn (parse_assistant_markdown); 3 external calls (new, assert!, assert_eq!).


##### `tests::renders_code_comment_directives_as_markdown`  (lines 308–321)

```
fn renders_code_comment_directives_as_markdown()
```

**Purpose**: Verifies that code-comment directives are rewritten into readable markdown bullets with normalized paths, ranges, and priority handling. It also confirms they do not leak Git actions.

**Data flow**: It builds a multiline markdown string containing two code-comment directives, calls `parse_assistant_markdown`, snapshots `parsed.visible_markdown` with insta, and asserts `parsed.git_actions` is empty. The snapshot captures formatting details such as title rewriting and location rendering.

**Call relations**: This test exercises `parse_assistant_markdown` through `rewrite_code_comment_line`, `parse_code_comment_attributes`, `parse_quoted_value`, `directive_integer`, and `title_has_priority`.

*Call graph*: calls 1 internal fn (parse_assistant_markdown); 4 external calls (new, assert!, concat!, assert_snapshot!).


##### `tests::preserves_non_directive_and_malformed_code_comment_text`  (lines 324–329)

```
fn preserves_non_directive_and_malformed_code_comment_text()
```

**Purpose**: Ensures that inline mentions of `::code-comment{...}` and malformed code-comment directives remain visible as ordinary text. It prevents over-eager rewriting.

**Data flow**: It passes markdown containing an inline code-comment mention and a malformed standalone code-comment directive to `parse_assistant_markdown`, then asserts the visible markdown is unchanged from the input. It has no side effects.

**Call relations**: This test covers the negative paths in `rewrite_code_comment_line`, confirming that only properly structured leading directives are rewritten.

*Call graph*: calls 1 internal fn (parse_assistant_markdown); 2 external calls (new, assert_eq!).


##### `tests::last_created_branch_cwd_uses_the_last_matching_directive`  (lines 332–339)

```
fn last_created_branch_cwd_uses_the_last_matching_directive()
```

**Purpose**: Checks that branch-context lookup returns the cwd from the most recent `git-create-branch` directive. It validates reverse-order scanning over parsed actions.

**Data flow**: It parses markdown containing two create-branch directives with a push directive between them, then asserts `parsed.last_created_branch_cwd()` returns `Some("/second")`. It reads only parser output.

**Call relations**: This test exercises both `parse_assistant_markdown` and `ParsedAssistantMarkdown::last_created_branch_cwd`, indirectly relying on `GitActionDirective::created_branch_cwd`.

*Call graph*: calls 1 internal fn (parse_assistant_markdown); 2 external calls (new, assert_eq!).


### `tui/src/bottom_pane/mentions_v2/render.rs`

`domain_logic` · `request handling`

This file is the presentation layer for mentions_v2. `render_popup` splits the provided area into a list region and, when height permits, a one-line footer region. The list region is inset two columns from the left before `render_rows` draws visible rows. `render_rows` handles three cases: zero-height areas, empty result sets (rendering the italic empty/loading message), and populated lists. For populated lists it computes the visible window from `ScrollState`, respecting `MAX_POPUP_ROWS` and correcting `start_idx` so the selected row stays on screen.

Each row is assembled by `build_line`, which creates a right-aligned type tag from `MentionType::span`, computes remaining content width, truncates the content with ellipsis, pads so the tag column lines up, and returns a `Line`. `content_line` composes a primary column and optional secondary column; the primary column width is precomputed across visible rows so descriptions and paths align vertically.

Filesystem rows get special treatment. `file_name_start` only recognizes rows whose `selection` is `Selection::File` and whose `mention_type` is filesystem-related; for those, `file_name` extracts the basename and `path_spans` renders the parent path dimmed, preserving fuzzy-match bolding in the path portion when indices exist. Non-filesystem rows instead render `display_name` directly, with plugin names magenta, skills dim, and direct fuzzy-match characters bolded according to `match_indices`. Descriptions are omitted when empty. The byte/char conversion logic carefully uses `char_indices` and character counts so Unicode display names are sliced at character boundaries rather than raw bytes.

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

**Purpose**: Splits the popup area into list and footer regions, renders the rows, and optionally paints the footer with search-mode hints.

**Data flow**: Takes the target `Rect`, mutable `Buffer`, row slice, `ScrollState`, empty-message string, and active `SearchMode`. It computes a footer row only when `area.height > 2`, insets the list area on the left by two columns, calls `render_rows` for the list, then shifts the footer area right by two columns and calls `render_footer`.

**Call relations**: Called by `Popup::render_ref` as the top-level renderer for the mentions popup. It delegates row painting to `render_rows` and footer painting to `render_footer`.

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

**Purpose**: Draws the visible subset of popup rows or an empty-state message inside the list area.

**Data flow**: Reads the drawing area, buffer, row slice, scroll state, and empty-message text. It returns early for zero-height areas; renders an italic `Line` from `empty_message` when `rows` is empty; otherwise computes `visible_items`, derives `start_idx` from `scroll_top` and `selected_idx`, calculates the maximum primary-column width across visible rows, builds each visible line with `build_line`, and renders each line into successive one-row rectangles.

**Call relations**: Used only by `render_popup`. It is the main loop that turns derived row data plus scroll state into terminal output.

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

**Purpose**: Constructs one fully formatted popup row, including selection emphasis, truncated content, padding, and the right-side type tag.

**Data flow**: Takes a `SearchResult`, `selected` flag, total row width, and precomputed primary-column width. It derives `base_style` and `dim_style` from selection state, obtains the type tag via `row.mention_type.span(base_style)`, computes remaining content width, builds and truncates the content line, appends style-preserving padding spaces so the tag aligns at the right edge, then returns the assembled `Line<'static>`.

**Call relations**: Called from `render_rows` for each visible row. It delegates content composition to `content_line` and overflow handling to the shared truncation helper.

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

**Purpose**: Builds the left-side content area for a row by combining the primary text with an optional secondary description/path segment.

**Data flow**: Reads the row plus base and dim styles and the aligned primary-column width. It starts with `primary_spans(row, base_style)`, then if `secondary_line` returns content, inserts dimmed padding equal to the difference between the aligned primary width and this row’s primary width plus two spaces, appends the secondary spans, and returns the resulting `Line<'static>`.

**Call relations**: Called by `build_line` after selection styling is known. It delegates the actual text extraction to `primary_spans`, `secondary_line`, and `primary_text_width`.

*Call graph*: calls 3 internal fn (primary_spans, primary_text_width, secondary_line); called by 1 (build_line); 2 external calls (from, new).


##### `primary_spans`  (lines 182–213)

```
fn primary_spans(row: &SearchResult, base_style: Style) -> Vec<Span<'static>>
```

**Purpose**: Produces the main visible label for a row, either as a filesystem basename or as the full display name with optional fuzzy-match highlighting.

**Data flow**: Reads a `SearchResult` and base style. If `file_name(row)` returns a basename, it styles that basename cyan for files or with the base style for directories and returns it as a single span. Otherwise it chooses a name style by `mention_type`, and either emits one span for the whole `display_name` or iterates characters, bolding only those whose character indices appear in `match_indices`.

**Call relations**: Used by `content_line` as the primary column generator. It depends on `file_name` to switch into filesystem-specific rendering.

*Call graph*: calls 1 internal fn (file_name); called by 1 (content_line); 5 external calls (dim, fg, magenta, with_capacity, vec!).


##### `secondary_line`  (lines 215–237)

```
fn secondary_line(
    row: &SearchResult,
    base_style: Style,
    dim_style: Style,
) -> Option<Line<'static>>
```

**Purpose**: Builds the optional secondary text shown after the primary column, using path-plus-description for filesystem rows or description-only for tool rows.

**Data flow**: Reads the row and styles. If `file_name(row)` is present, it starts with `path_spans(row, base_style)`, optionally appends a dimmed separator and non-empty description, and returns that as `Some(Line)`. Otherwise it returns `Some(Line)` only when `row.description` exists and is non-empty, styling it dimly; empty descriptions yield `None`.

**Call relations**: Called by `content_line` to decide whether a row has secondary content. It delegates filesystem path formatting to `path_spans`.

*Call graph*: calls 2 internal fn (file_name, path_spans); called by 1 (content_line); 1 external calls (from).


##### `path_spans`  (lines 239–271)

```
fn path_spans(row: &SearchResult, base_style: Style) -> Vec<Span<'static>>
```

**Purpose**: Formats the parent-path portion of a filesystem row, preserving fuzzy-match emphasis in the path when indices are available.

**Data flow**: Reads the row and base style, computes `file_name_start`, and builds a vector of spans for the path prefix. If the basename starts at character 0, it emits `./` in dim style. If match indices exist, it iterates characters up to the basename boundary and bolds matched path characters. If there are no indices but a valid basename boundary exists, it slices the prefix by converting the character offset to a byte offset. If no valid filesystem split exists, it falls back to the full display name in base style.

**Call relations**: Used by `secondary_line` only for filesystem rows. It relies on `file_name_start` to know where the basename begins.

*Call graph*: calls 1 internal fn (file_name_start); called by 1 (secondary_line); 2 external calls (dim, with_capacity).


##### `primary_text_width`  (lines 273–277)

```
fn primary_text_width(row: &SearchResult) -> usize
```

**Purpose**: Computes the character width of the row’s primary column for alignment calculations.

**Data flow**: Reads the row, asks `file_name(row)` for a basename when applicable, counts characters in that basename or in `display_name`, and returns the resulting `usize` width.

**Call relations**: Called by `content_line` for per-row padding and by `render_rows` when computing the maximum primary-column width across visible rows.

*Call graph*: calls 1 internal fn (file_name); called by 1 (content_line).


##### `file_name`  (lines 279–295)

```
fn file_name(row: &SearchResult) -> Option<&str>
```

**Purpose**: Extracts the basename slice from a filesystem row’s display name when the row represents a real file or directory selection.

**Data flow**: Reads the row, computes `file_name_start(row)`, and returns `None` when the sentinel `usize::MAX` indicates no filesystem split. If the start is zero, it returns the whole `display_name`. Otherwise it converts the character offset to a byte offset with `char_indices` and returns the suffix slice from that byte onward.

**Call relations**: Used by `primary_spans`, `secondary_line`, and `primary_text_width` to switch between generic-name rendering and path-aware filesystem rendering.

*Call graph*: calls 1 internal fn (file_name_start); called by 3 (primary_spans, primary_text_width, secondary_line).


##### `file_name_start`  (lines 297–306)

```
fn file_name_start(row: &SearchResult) -> usize
```

**Purpose**: Determines the character index where the basename begins for filesystem rows, or a sentinel when basename/path splitting should not be applied.

**Data flow**: Reads `row.selection` and `row.mention_type`. For `Selection::File(_)` rows whose mention type is filesystem-related, it finds the last `/` or `\` in `display_name`, converts the prefix length to a character count, and returns that count; if no separator exists it returns `0`. For non-filesystem selections or tool rows it returns `usize::MAX`.

**Call relations**: This is the low-level helper behind `file_name` and `path_spans`. Its sentinel return value is the invariant that tells the renderer whether path splitting is valid for a row.

*Call graph*: called by 2 (file_name, path_spans).


### `tui/src/bottom_pane/request_user_input/layout.rs`

`orchestration` · `rendering`

This module isolates the overlay's height-allocation policy from its rendering and input logic. The exported result type, `LayoutSections`, carries concrete `Rect`s for progress, question, options, and notes areas, plus the already-wrapped question lines and the number of footer rows reserved below those areas. Internally, layout is first expressed as a `LayoutPlan` of heights and spacer counts, then converted into rectangles by `build_layout_areas`.

`layout_sections` is the top-level dispatcher. It inspects whether the current question has options, whether notes should be visible, and the preferred heights for footer, notes, and wrapped question text. It then chooses either `layout_with_options` or `layout_without_options`. The options path first truncates question lines if they would crowd out even a one-row options area, then delegates to `layout_with_options_normal`, which allocates question and options first, shrinks options if necessary to preserve progress/footer/spacer room, and branches depending on whether notes are visible. When notes are hidden, it prefers progress and footer, then grows options back with any leftover space. When notes are visible, it reserves footer first, then a spacer before notes, then gives remaining space to notes. The no-options path either truncates the question aggressively in `layout_without_options_tight` when height is insufficient even for the question, or in `layout_without_options_normal` allocates notes, footer, and finally a progress line from remaining space. The result is a deterministic, space-aware layout policy shared by rendering and desired-height calculations.

#### Function details

##### `RequestUserInputOverlay::layout_sections`  (lines 19–60)

```
fn layout_sections(&self, area: Rect) -> LayoutSections
```

**Purpose**: Computes the full set of layout rectangles and wrapped question lines for the overlay in a given area. It is the top-level layout entrypoint used by rendering code.

**Data flow**: Reads overlay state through methods such as `has_options`, `notes_ui_visible`, `footer_required_height`, `notes_input_height`, and `wrapped_question_lines`. It computes `question_height`, chooses either `layout_with_options` or `layout_without_options` to obtain a `LayoutPlan`, converts that plan into concrete rectangles with `build_layout_areas`, and returns a `LayoutSections` struct containing those areas, the possibly truncated `question_lines`, and `footer_lines` from the plan.

**Call relations**: Called by overlay rendering code; it delegates the actual height-allocation policy to the specialized options/no-options helpers.

*Call graph*: calls 3 internal fn (build_layout_areas, layout_with_options, layout_without_options).


##### `RequestUserInputOverlay::layout_with_options`  (lines 63–95)

```
fn layout_with_options(
        &self,
        args: OptionsLayoutArgs,
        question_lines: &mut Vec<String>,
    ) -> LayoutPlan
```

**Purpose**: Prepares layout inputs for questions that have selectable options, including truncating the wrapped question text if necessary to leave at least one row for options. It then hands off to the normal options-layout allocator.

**Data flow**: Takes `OptionsLayoutArgs` and mutable `question_lines`. It computes `min_options_height`, derives the maximum allowable question height from available height, truncates `question_lines` and `question_height` if needed, computes option heights via `options_preferred_height(width)` and `options_required_height(width)`, packages those into `OptionsHeights`, and returns the `LayoutPlan` from `layout_with_options_normal`.

**Call relations**: Used only by `layout_sections` on the options-present path.

*Call graph*: calls 1 internal fn (layout_with_options_normal); called by 1 (layout_sections).


##### `RequestUserInputOverlay::layout_with_options_normal`  (lines 99–196)

```
fn layout_with_options_normal(
        &self,
        args: OptionsNormalArgs,
        options: OptionsHeights,
    ) -> LayoutPlan
```

**Purpose**: Allocates heights for question, options, optional notes, progress, spacers, and footer when options are present. It encodes the overlay's main priority rules under normal options-mode layout.

**Data flow**: Consumes `OptionsNormalArgs` and `OptionsHeights`. It starts with question height fixed, chooses an initial options height between the preferred and minimum values, computes remaining height, and if remaining space is too small to preserve progress/footer/spacers it shrinks options down toward the minimum. It then optionally reserves a one-line progress area. If notes are hidden, it prefers a spacer after options when footer fits, allocates footer lines, optionally adds a spacer after the question, and grows options back with any leftover room up to `options.full`. If notes are visible, it allocates footer first, then a spacer after the question if possible, then notes up to their preferred height, and finally gives any leftover rows to notes. It returns a `LayoutPlan` with all computed heights and spacer counts.

**Call relations**: Called only by `layout_with_options`; its output is later turned into rectangles by `build_layout_areas`.

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

**Purpose**: Chooses between tight and normal layout strategies for freeform-only questions. It truncates aggressively only when the question itself cannot fit.

**Data flow**: Takes available height, question height, preferred notes height, preferred footer height, and mutable `question_lines`. If `question_height` exceeds available height it delegates to `layout_without_options_tight`; otherwise it delegates to `layout_without_options_normal` and returns that plan.

**Call relations**: Used by `layout_sections` when the current question has no options.

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

**Purpose**: Builds the minimal layout for freeform-only questions when vertical space is too small even for the full question text. It truncates the question and drops notes, progress, and footer entirely.

**Data flow**: Takes available height, original question height, and mutable `question_lines`. It clamps question height to available height, truncates `question_lines` to that many rows, and returns a `LayoutPlan` with only `question_height` populated and all other heights/spacers set to zero.

**Call relations**: Selected by `layout_without_options` under severe height constraints.

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

**Purpose**: Allocates space for freeform-only questions when the question fits. It gives remaining space first to notes, then footer, then a progress line, and finally any leftover rows back to notes.

**Data flow**: Takes available height, question height, preferred notes height, and preferred footer height. It subtracts question height, allocates notes up to their preferred height, allocates footer lines from what remains, reserves a one-line progress area if any space is still left, then adds any final leftover rows to notes. It returns the resulting `LayoutPlan`.

**Call relations**: Chosen by `layout_without_options` when the question itself fits within the available height.

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

**Purpose**: Converts a height-only `LayoutPlan` into concrete `Rect` slices stacked vertically within the provided area. It is the final geometry materialization step.

**Data flow**: Takes the outer `area` and a `LayoutPlan`, walks a `cursor_y` downward from `area.y`, constructs `Rect`s for progress, question, options, and notes using the plan's heights and the full area width, advances the cursor by each section height plus configured spacers, and returns the four rectangles as a tuple.

**Call relations**: Called by `layout_sections` after one of the planning functions has decided the section heights.

*Call graph*: called by 1 (layout_sections).


### `tui/src/bottom_pane/unified_exec_footer.rs`

`domain_logic` · `footer/status rendering`

This file is a small rendering component for background terminal sessions created by unified exec. `UnifiedExecFooter` stores the current list of active process display strings in `processes: Vec<String>`, but its visible output intentionally does not enumerate them; instead it derives one canonical summary sentence from the count. That summary is reused elsewhere through `summary_text()` so the bottom pane and inline status surfaces stay grammatically consistent.

The state API is minimal. `new()` starts empty, `set_processes()` replaces the tracked process list and returns a boolean indicating whether anything changed, and `is_empty()` reports whether there is anything to show. `summary_text()` returns `None` when there are no processes; otherwise it pluralizes `terminal` based on the count and emits a fixed help string mentioning `/ps` and `/stop`.

Rendering is width-aware but intentionally shallow. `render_lines()` returns no lines for widths under 4 or when there is no summary. Otherwise it prefixes the summary with two spaces, truncates it to the available display width using `take_prefix_by_width`, dims the resulting text, and wraps it in a single `Line<'static>`. The `Renderable` implementation simply renders those lines in a `Paragraph`, and `desired_height()` is the number of generated lines, which is either 0 or 1.

#### Function details

##### `UnifiedExecFooter::new`  (lines 22–26)

```
fn new() -> Self
```

**Purpose**: Constructs an empty unified-exec footer state.

**Data flow**: Initializes `processes` to an empty `Vec<String>` and returns the new struct.

**Call relations**: Used when the bottom pane is initialized and in tests that verify empty and populated rendering.

*Call graph*: called by 4 (new, desired_height_empty, render_many_sessions, render_more_sessions); 1 external calls (new).


##### `UnifiedExecFooter::set_processes`  (lines 28–34)

```
fn set_processes(&mut self, processes: Vec<String>) -> bool
```

**Purpose**: Replaces the tracked background-process list and reports whether the visible state changed.

**Data flow**: Compares the incoming `Vec<String>` to `self.processes`; if identical it returns `false`, otherwise it stores the new vector and returns `true`.

**Call relations**: Higher-level unified-exec state updates call this so they can avoid unnecessary redraws when the process list is unchanged.

*Call graph*: called by 1 (set_unified_exec_processes).


##### `UnifiedExecFooter::is_empty`  (lines 36–38)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether there are any background processes to summarize.

**Data flow**: Returns `self.processes.is_empty()`.

**Call relations**: Layout/orchestration code uses this to decide whether to reserve footer space.

*Call graph*: called by 1 (as_renderable_with_composer_right_reserve).


##### `UnifiedExecFooter::summary_text`  (lines 45–55)

```
fn summary_text(&self) -> Option<String>
```

**Purpose**: Builds the canonical unindented summary sentence for the current background-process count.

**Data flow**: If `self.processes` is empty it returns `None`; otherwise it computes `count`, chooses a plural suffix, formats `"{count} background terminal{plural} running · /ps to view · /stop to close"`, and returns it in `Some(String)`.

**Call relations**: Both footer rendering and inline status-row reuse depend on this shared summary generator.

*Call graph*: called by 2 (sync_status_inline_message, render_lines); 1 external calls (format!).


##### `UnifiedExecFooter::render_lines`  (lines 57–67)

```
fn render_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Produces the footer’s visible line list for a given width, including indentation, truncation, and dim styling.

**Data flow**: Returns an empty vector when `width < 4` or `summary_text()` is `None`. Otherwise it prefixes the summary with two spaces, truncates it to display width with `take_prefix_by_width`, dims the truncated string, wraps it in `Line::from`, and returns a one-element vector.

**Call relations**: Both `render` and `desired_height` delegate here so they stay consistent about when the footer is visible.

*Call graph*: calls 2 internal fn (summary_text, take_prefix_by_width); called by 2 (desired_height, render); 3 external calls (new, format!, vec!).


##### `UnifiedExecFooter::render`  (lines 71–77)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the footer into the provided buffer area.

**Data flow**: Returns immediately if `area.is_empty()`. Otherwise it computes the line vector with `render_lines(area.width)` and renders it through `Paragraph::new(...).render(area, buf)`.

**Call relations**: Implements the `Renderable` trait’s drawing path for the footer row.

*Call graph*: calls 1 internal fn (render_lines); 2 external calls (new, is_empty).


##### `UnifiedExecFooter::desired_height`  (lines 79–81)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Reports how many rows the footer needs at a given width.

**Data flow**: Calls `render_lines(width)`, takes its length, and returns it as `u16`.

**Call relations**: Layout code uses this before rendering to decide whether to allocate a footer row.

*Call graph*: calls 1 internal fn (render_lines).


##### `tests::desired_height_empty`  (lines 91–94)

```
fn desired_height_empty()
```

**Purpose**: Verifies that an empty footer requests zero height.

**Data flow**: Constructs a new footer and asserts `desired_height(40) == 0`.

**Call relations**: Covers the empty-state branch shared by `summary_text` and `render_lines`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::render_more_sessions`  (lines 97–105)

```
fn render_more_sessions()
```

**Purpose**: Snapshots rendering for a single active background terminal.

**Data flow**: Creates a footer, sets one process, computes height, renders into a buffer, and snapshots the buffer debug output.

**Call relations**: Exercises the non-empty rendering path and truncation/styling behavior for a small count.

*Call graph*: calls 1 internal fn (new); 4 external calls (empty, new, assert_snapshot!, vec!).


##### `tests::render_many_sessions`  (lines 108–116)

```
fn render_many_sessions()
```

**Purpose**: Snapshots rendering for a large number of active background terminals.

**Data flow**: Creates a footer, sets 123 synthetic processes, renders at fixed width, and snapshots the buffer debug output.

**Call relations**: Covers pluralization and truncation behavior for larger counts.

*Call graph*: calls 1 internal fn (new); 3 external calls (empty, new, assert_snapshot!).


### `tui/src/status_indicator_widget.rs`

`domain_logic` · `main loop while tasks are running`

This widget owns both presentation state and a small amount of runtime timing state for the busy indicator above the composer. `StatusIndicatorWidget` stores the animated header text, optional details and inline message, interrupt-hint configuration, elapsed-running duration, pause/resume timestamps, and the `AppEventSender`/`FrameRequester` needed to interrupt work and schedule redraws. The default header is `Working`, the default interrupt binding is `Esc`, and details are capped at `STATUS_DETAILS_DEFAULT_MAX_LINES` unless callers override that.

The timer logic is explicit and pause-aware. `elapsed_running` accumulates only active time; `pause_timer_at` snapshots elapsed time and flips `is_paused`, while `resume_timer_at` restarts timing from a new `Instant` and requests a frame so the UI updates immediately. Rendering computes elapsed time with `fmt_elapsed_compact`, chooses a motion mode from `animations_enabled`, optionally prepends an activity indicator, applies `shimmer_text` to the header, and then appends either `(elapsed • key to interrupt)` or just `(elapsed)` if the hint is hidden. Any inline message is appended after a dim separator so the interrupt affordance stays in a stable position.

Detail text is wrapped separately beneath the header using `word_wrap_lines` with a dim `"  └ "` prefix on the first line and aligned indentation on continuation lines. If wrapping exceeds the configured line limit, the last visible span is manually truncated and suffixed with an ellipsis. Tests cover elapsed formatting, rendering with and without animation, remapped interrupt keys, timer pause/resume semantics, and detail wrapping/ellipsis behavior.

#### Function details

##### `fmt_elapsed_compact`  (lines 65–78)

```
fn fmt_elapsed_compact(elapsed_secs: u64) -> String
```

**Purpose**: Formats elapsed seconds into the compact status-line forms used by the busy indicator.

**Data flow**: It takes a `u64` second count, branches into seconds-only, minutes+seconds, or hours+minutes+seconds formatting, and returns the formatted string.

**Call relations**: It is called during widget rendering to produce the elapsed segment shown inside parentheses.

*Call graph*: called by 1 (render); 1 external calls (format!).


##### `StatusIndicatorWidget::new`  (lines 81–101)

```
fn new(
        app_event_tx: AppEventSender,
        frame_requester: FrameRequester,
        animations_enabled: bool,
    ) -> Self
```

**Purpose**: Constructs a status indicator with default header, interrupt hint, zero elapsed time, and the supplied event/frame handles.

**Data flow**: It takes an `AppEventSender`, `FrameRequester`, and `animations_enabled` flag, initializes all widget fields including `header = "Working"`, `interrupt_binding = Esc`, `elapsed_running = Duration::ZERO`, and `last_resume_at = Instant::now()`, then returns the widget.

**Call relations**: It is used by runtime setup code that ensures a status indicator exists, and by tests that render or manipulate the widget.

*Call graph*: calls 1 internal fn (plain); called by 10 (ensure_status_indicator, set_task_running, details_args_can_disable_capitalization_and_limit_lines, details_overflow_adds_ellipsis, renders_remapped_interrupt_hint, renders_truncated, renders_with_working_header, renders_without_spinner_when_animations_disabled, renders_wrapped_details_panama_two_lines, timer_pauses_when_requested); 2 external calls (now, from).


##### `StatusIndicatorWidget::interrupt`  (lines 103–106)

```
fn interrupt(&self)
```

**Purpose**: Sends the interrupt action through the app event channel, restoring the prompt if no output has appeared.

**Data flow**: It reads the stored `app_event_tx` and invokes `interrupt_and_restore_prompt_if_no_output`; it returns no value and mutates no widget-local state.

**Call relations**: This is the widget’s imperative action hook for user-triggered interruption.

*Call graph*: calls 1 internal fn (interrupt_and_restore_prompt_if_no_output).


##### `StatusIndicatorWidget::update_header`  (lines 109–111)

```
fn update_header(&mut self, header: String)
```

**Purpose**: Replaces the animated header text shown at the start of the status row.

**Data flow**: It takes an owned `String` and assigns it to `self.header`.

**Call relations**: Callers use this when the busy indicator should say something more specific than `Working`.


##### `StatusIndicatorWidget::update_details`  (lines 114–130)

```
fn update_details(
        &mut self,
        details: Option<String>,
        capitalization: StatusDetailsCapitalization,
        max_lines: usize,
    )
```

**Purpose**: Stores optional detail text, normalizing capitalization and enforcing a minimum visible line budget.

**Data flow**: It takes `Option<String>`, a `StatusDetailsCapitalization` mode, and `max_lines`; clamps `max_lines` to at least 1, drops empty strings, trims leading whitespace, optionally capitalizes the first character, and stores the resulting `Option<String>` in `self.details`.

**Call relations**: Callers use this to populate the wrapped secondary lines rendered by `wrapped_details_lines`.


##### `StatusIndicatorWidget::update_inline_message`  (lines 137–141)

```
fn update_inline_message(&mut self, message: Option<String>)
```

**Purpose**: Stores a short optional suffix message appended after the elapsed/interrupt segment.

**Data flow**: It takes `Option<String>`, trims whitespace, drops empty results, and stores the cleaned message in `self.inline_message`.

**Call relations**: This is intended for concise contextual add-ons such as background-process summaries; rendering appends it after the core status text.


##### `StatusIndicatorWidget::header`  (lines 144–146)

```
fn header(&self) -> &str
```

**Purpose**: Exposes the current header text for tests.

**Data flow**: It returns `&self.header`.

**Call relations**: This accessor is compiled only in tests and supports assertions about `update_header` behavior.


##### `StatusIndicatorWidget::details`  (lines 149–151)

```
fn details(&self) -> Option<&str>
```

**Purpose**: Exposes the current normalized details text for tests.

**Data flow**: It returns `self.details.as_deref()`.

**Call relations**: This test-only accessor is used to verify capitalization and trimming behavior.


##### `StatusIndicatorWidget::set_interrupt_hint_visible`  (lines 153–155)

```
fn set_interrupt_hint_visible(&mut self, visible: bool)
```

**Purpose**: Enables or disables rendering of the interrupt key hint.

**Data flow**: It takes a `bool` and assigns it to `self.show_interrupt_hint`.

**Call relations**: Rendering checks this flag before deciding whether to show `(elapsed • key to interrupt)` or just `(elapsed)`.


##### `StatusIndicatorWidget::set_interrupt_binding`  (lines 157–159)

```
fn set_interrupt_binding(&mut self, binding: Option<KeyBinding>)
```

**Purpose**: Overrides or clears the key binding displayed in the interrupt hint.

**Data flow**: It takes `Option<KeyBinding>` and stores it in `self.interrupt_binding`.

**Call relations**: This is used when the app remaps the interrupt key or wants to suppress the binding text entirely.


##### `StatusIndicatorWidget::pause_timer`  (lines 161–163)

```
fn pause_timer(&mut self)
```

**Purpose**: Pauses elapsed-time accumulation using the current instant.

**Data flow**: It reads `Instant::now()` and forwards that timestamp to `pause_timer_at`.

**Call relations**: This convenience wrapper is used by runtime code that does not need deterministic test timestamps.

*Call graph*: calls 1 internal fn (pause_timer_at); 1 external calls (now).


##### `StatusIndicatorWidget::resume_timer`  (lines 165–167)

```
fn resume_timer(&mut self)
```

**Purpose**: Resumes elapsed-time accumulation using the current instant.

**Data flow**: It reads `Instant::now()` and forwards that timestamp to `resume_timer_at`.

**Call relations**: Like `pause_timer`, this is the real-time convenience wrapper around the deterministic `_at` variant.

*Call graph*: calls 1 internal fn (resume_timer_at); 1 external calls (now).


##### `StatusIndicatorWidget::pause_timer_at`  (lines 169–175)

```
fn pause_timer_at(&mut self, now: Instant)
```

**Purpose**: Stops the running timer at a specific instant and accumulates elapsed active time.

**Data flow**: It takes `now: Instant`; if already paused it returns immediately, otherwise it adds `now.saturating_duration_since(self.last_resume_at)` into `self.elapsed_running` and sets `self.is_paused = true`.

**Call relations**: It is called by `pause_timer` and by tests that need deterministic pause/resume timing.

*Call graph*: called by 1 (pause_timer); 1 external calls (saturating_duration_since).


##### `StatusIndicatorWidget::resume_timer_at`  (lines 177–184)

```
fn resume_timer_at(&mut self, now: Instant)
```

**Purpose**: Restarts the running timer from a specific instant and requests a redraw.

**Data flow**: It takes `now: Instant`; if not paused it returns immediately, otherwise it sets `self.last_resume_at = now`, flips `self.is_paused = false`, and calls `self.frame_requester.schedule_frame()`.

**Call relations**: It is called by `resume_timer`; the scheduled frame ensures the elapsed display updates promptly after resuming.

*Call graph*: calls 1 internal fn (schedule_frame); called by 1 (resume_timer).


##### `StatusIndicatorWidget::elapsed_duration_at`  (lines 186–192)

```
fn elapsed_duration_at(&self, now: Instant) -> Duration
```

**Purpose**: Computes total active elapsed duration at an arbitrary instant, respecting paused state.

**Data flow**: It starts from `self.elapsed_running`, and if the widget is not paused it adds `now.saturating_duration_since(self.last_resume_at)`, then returns the resulting `Duration`.

**Call relations**: It is used by both `elapsed_seconds_at` and `render` so timing logic stays centralized.

*Call graph*: called by 2 (elapsed_seconds_at, render); 1 external calls (saturating_duration_since).


##### `StatusIndicatorWidget::elapsed_seconds_at`  (lines 194–196)

```
fn elapsed_seconds_at(&self, now: Instant) -> u64
```

**Purpose**: Returns the active elapsed time in whole seconds at a specific instant.

**Data flow**: It takes `now`, calls `elapsed_duration_at(now)`, converts the result with `.as_secs()`, and returns the `u64` count.

**Call relations**: It underpins the public `elapsed_seconds` accessor and timer tests.

*Call graph*: calls 1 internal fn (elapsed_duration_at); called by 1 (elapsed_seconds).


##### `StatusIndicatorWidget::elapsed_seconds`  (lines 198–200)

```
fn elapsed_seconds(&self) -> u64
```

**Purpose**: Returns the current active elapsed time in whole seconds.

**Data flow**: It reads `Instant::now()`, forwards to `elapsed_seconds_at`, and returns the result.

**Call relations**: This is the real-time public accessor for callers that need the current elapsed count.

*Call graph*: calls 1 internal fn (elapsed_seconds_at); 1 external calls (now).


##### `StatusIndicatorWidget::wrapped_details_lines`  (lines 203–232)

```
fn wrapped_details_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Wraps the optional details text into prefixed, dimmed lines and truncates overflow with an ellipsis.

**Data flow**: It reads `self.details`, `self.details_max_lines`, and the supplied width. It returns empty output for missing details or zero width; otherwise it computes the prefix width of `DETAILS_PREFIX`, builds `RtOptions` with initial and subsequent indents, wraps each source line through `word_wrap_lines`, truncates to `details_max_lines`, and if truncation occurred rewrites the last span content to fit plus `…`.

**Call relations**: Both `desired_height` and `render` call this helper so layout and painting agree on how many detail lines exist.

*Call graph*: calls 2 internal fn (new, word_wrap_lines); called by 2 (desired_height, render); 6 external calls (from, from, width, new, format!, from).


##### `StatusIndicatorWidget::desired_height`  (lines 236–238)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Reports how many terminal rows the widget wants at a given width.

**Data flow**: It takes a width, computes the wrapped detail lines for that width, adds one header row, converts the detail count to `u16`, and returns the total height.

**Call relations**: This implements the `Renderable` sizing contract and must stay consistent with `render`.

*Call graph*: calls 1 internal fn (wrapped_details_lines); 1 external calls (try_from).


##### `StatusIndicatorWidget::render`  (lines 240–299)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the animated status row and any wrapped detail lines into the provided buffer area.

**Data flow**: It takes a `Rect` and mutable `Buffer`, returns early for empty areas, optionally schedules the next animation frame, computes elapsed time and motion mode, builds a span list from `activity_indicator`, `shimmer_text`, elapsed text, optional interrupt binding, and optional inline message, truncates the header line to fit, appends wrapped detail lines up to available height, and renders the resulting `Paragraph` into the buffer.

**Call relations**: This is the widget’s main paint path. It delegates timing formatting to `fmt_elapsed_compact`, animation pieces to motion helpers, and width control to `truncate_line_with_ellipsis_if_overflow` and `wrapped_details_lines`.

*Call graph*: calls 8 internal fn (truncate_line_with_ellipsis_if_overflow, from_animations_enabled, activity_indicator, shimmer_text, elapsed_duration_at, wrapped_details_lines, fmt_elapsed_compact, schedule_frame_in); 11 external calls (from_millis, now, from, new, is_empty, from, new, with_capacity, format!, from (+1 more)).


##### `tests::fmt_elapsed_compact_formats_seconds_minutes_hours`  (lines 316–327)

```
fn fmt_elapsed_compact_formats_seconds_minutes_hours()
```

**Purpose**: Verifies compact elapsed formatting across second-, minute-, and hour-scale inputs.

**Data flow**: It calls `fmt_elapsed_compact` with representative values and asserts exact string outputs.

**Call relations**: This test locks down the textual contract used by the live status row.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::renders_with_working_header`  (lines 330–345)

```
fn renders_with_working_header()
```

**Purpose**: Snapshot-tests the default rendered widget with animations enabled and the default `Working` header.

**Data flow**: It constructs a widget with test event/frame handles, renders it into a fixed-size `TestBackend`, and snapshots the backend contents.

**Call relations**: This test covers the default visual baseline of the widget.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 3 external calls (new, assert_snapshot!, new).


##### `tests::renders_truncated`  (lines 348–363)

```
fn renders_truncated()
```

**Purpose**: Snapshot-tests rendering in a narrow width where the single-line header content must be truncated.

**Data flow**: It constructs the default widget, renders into a 20-column test terminal, and snapshots the backend.

**Call relations**: It exercises the truncation path in `render`.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 3 external calls (new, assert_snapshot!, new).


##### `tests::renders_wrapped_details_panama_two_lines`  (lines 366–392)

```
fn renders_wrapped_details_panama_two_lines()
```

**Purpose**: Snapshot-tests detail wrapping into exactly two lines with capitalization and no interrupt hint.

**Data flow**: It constructs a widget, sets details to `A man a plan a canal panama`, disables the interrupt hint, freezes timing state, renders into a 30x3 terminal, and snapshots the backend.

**Call relations**: This test targets `wrapped_details_lines` behavior under a width chosen to force one wrap without ellipsis.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 3 external calls (new, assert_snapshot!, new).


##### `tests::renders_without_spinner_when_animations_disabled`  (lines 395–416)

```
fn renders_without_spinner_when_animations_disabled()
```

**Purpose**: Checks that disabling animations removes the spinner while preserving the textual status line.

**Data flow**: It constructs a widget with `animations_enabled = false`, freezes elapsed time at zero, renders into a one-line terminal, extracts the visible text, and asserts it starts with `Working (0s • esc to interrupt)`.

**Call relations**: It validates the reduced-motion rendering branch in `render`.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 3 external calls (new, assert!, new).


##### `tests::renders_remapped_interrupt_hint`  (lines 419–436)

```
fn renders_remapped_interrupt_hint()
```

**Purpose**: Snapshot-tests rendering when the interrupt key binding is remapped from Esc to F12.

**Data flow**: It constructs a widget, sets the interrupt binding to `F12`, freezes timing, renders into a test terminal, and snapshots the backend.

**Call relations**: This test covers the configurable interrupt-binding display path.

*Call graph*: calls 4 internal fn (new, plain, new, test_dummy); 4 external calls (F, new, assert_snapshot!, new).


##### `tests::timer_pauses_when_requested`  (lines 439–461)

```
fn timer_pauses_when_requested()
```

**Purpose**: Verifies that pausing freezes elapsed time and resuming restarts accumulation from the resume instant.

**Data flow**: It constructs a widget, seeds `last_resume_at`, computes elapsed time before pause, pauses at +5s, checks elapsed remains unchanged at +10s, resumes at +10s, and checks elapsed reaches prior+3s at +13s.

**Call relations**: It directly exercises `pause_timer_at`, `resume_timer_at`, and `elapsed_seconds_at` semantics.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 3 external calls (from_secs, now, assert_eq!).


##### `tests::details_overflow_adds_ellipsis`  (lines 464–485)

```
fn details_overflow_adds_ellipsis()
```

**Purpose**: Checks that wrapped details exceeding the maximum line count end with an ellipsis on the last visible line.

**Data flow**: It constructs a widget, sets a repeating details string, computes wrapped lines at width 6, asserts the line count equals the default max, and checks the last content span ends with `…`.

**Call relations**: This test targets the manual overflow-truncation logic in `wrapped_details_lines`.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 2 external calls (assert!, assert_eq!).


##### `tests::details_args_can_disable_capitalization_and_limit_lines`  (lines 488–516)

```
fn details_args_can_disable_capitalization_and_limit_lines()
```

**Purpose**: Verifies that callers can preserve original capitalization and force details into a single ellipsized line.

**Data flow**: It constructs a widget, updates details with `Preserve` and `max_lines = 1`, asserts the stored details string is unchanged, computes wrapped lines at width 24, and checks the sole line contains an ellipsis.

**Call relations**: It covers both configurable capitalization behavior and caller-controlled line limits.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 2 external calls (assert!, assert_eq!).


### `tui/src/status/card.rs`

`domain_logic` · `request handling and history rendering for `/status` output`

This file contains the concrete status-card implementation shown in chat history when the user runs `/status`. It defines the internal data structures used to render that card: token/context-window summaries, mutable rate-limit state shared through `Arc<RwLock<_>>`, a `StatusHistoryHandle` for asynchronously updating rate-limit data after the card has been created, and the `StatusHistoryCell` itself, which implements `HistoryCell`.

Construction starts in `new_status_output*` helpers, which wrap a magenta `/status` command line together with a newly built `StatusHistoryCell` inside a `CompositeHistoryCell`. `StatusHistoryCell::new` derives display-ready strings from `Config` and runtime inputs: model/provider details, approval policy and reviewer labels, permission-profile summaries, workspace-root suffixes, account display, thread/fork identifiers, collaboration mode, token totals, optional context-window usage, and initial rate-limit rows. Several helper functions normalize permission labels into user-facing phrases such as `Read Only`, `Workspace`, `Full Access`, or `Profile <id>`, including special handling for network access and extra workspace roots.

Rendering in `display_lines` is careful and width-aware. It computes labels dynamically, aligns fields with `FieldFormatter`, conditionally shows the ChatGPT usage URL only for OpenAI-auth-backed providers, wraps remote connection and rate-limit reset/detail text, hides token usage for ChatGPT subscriber accounts, truncates final lines to the computed inner width, and finally adds a border. Hyperlink rendering scans the visible text to attach a terminal hyperlink range for the usage URL. The rate-limit handle updates shared state in place so an already-rendered status card can later reflect refreshed limits without rebuilding unrelated fields.

#### Function details

##### `StatusHistoryHandle::finish_rate_limit_refresh`  (lines 85–102)

```
fn finish_rate_limit_refresh(
        &self,
        rate_limits: &[RateLimitSnapshotDisplay],
        now: DateTime<Local>,
    )
```

**Purpose**: Applies freshly fetched rate-limit snapshots to the shared status-card state and marks the refresh as complete. It supports both single-snapshot and multi-snapshot aggregation.

**Data flow**: Takes `&self`, a slice of `RateLimitSnapshotDisplay`, and the current `DateTime<Local>`. It chooses `compose_rate_limit_data` for zero/one snapshot or `compose_rate_limit_data_many` for multiple snapshots, acquires a write lock on `self.rate_limit_state`, replaces `state.rate_limits`, sets `state.refreshing_rate_limits = false`, and returns `()`.

**Call relations**: This method is used after asynchronous rate-limit retrieval completes for an existing status card. It delegates snapshot shaping to the compose helpers and updates the `RwLock`-protected state that `StatusHistoryCell::display_lines` later reads.

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

**Purpose**: Convenience constructor for test-oriented status output when there is at most one rate-limit snapshot. It forwards to the more general constructor with `refreshing_rate_limits` set to false.

**Data flow**: Takes config, optional account/token info, total usage, session/thread metadata, an optional single rate-limit snapshot, plan type, current time, model name, collaboration mode, and reasoning-effort override. It converts the optional snapshot into a slice and calls `new_status_output_with_rate_limits`, returning the resulting `CompositeHistoryCell`.

**Call relations**: This helper is a thin wrapper over `new_status_output_with_rate_limits`, simplifying common test setup.

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

**Purpose**: Constructs a status output cell from an arbitrary slice of rate-limit snapshots, returning only the composite history cell. It is the intermediate convenience layer above the handle-returning constructor.

**Data flow**: Accepts the same core status inputs plus a slice of `RateLimitSnapshotDisplay` and a `refreshing_rate_limits` flag. It forwards all arguments to `new_status_output_with_rate_limits_handle` with default runtime provider URL, remote connection, and agents summary, then returns only the `.0` `CompositeHistoryCell` from that tuple.

**Call relations**: This function is called by `new_status_output` and delegates all real construction work to `new_status_output_with_rate_limits_handle`.

*Call graph*: calls 1 internal fn (new_status_output_with_rate_limits_handle); called by 1 (new_status_output).


##### `new_status_output_with_rate_limits_handle`  (lines 201–245)

```
fn new_status_output_with_rate_limits_handle(
    config: &Config,
    runtime_model_provider_base_url: Option<&str>,
    remote_connection: Option<&RemoteConnectionStatus>,
    account_display: Optio
```

**Purpose**: Builds the full `/status` history output and returns both the rendered composite cell and a handle for later rate-limit updates. It pairs the command echo line with the detailed status card.

**Data flow**: Takes config, optional runtime provider URL and remote connection, optional account/token info, usage/session metadata, rate-limit snapshots, plan type, current time, model/collaboration/reasoning settings, an agents summary string, and a refresh flag. It creates a `PlainHistoryCell` containing `/status`, calls `StatusHistoryCell::new(...)` to build the card and `StatusHistoryHandle`, wraps both cells in a `CompositeHistoryCell`, and returns `(CompositeHistoryCell, StatusHistoryHandle)`.

**Call relations**: This is the main constructor used by higher-level status flows. It delegates detailed field derivation to `StatusHistoryCell::new` and only handles composition of the command line plus card.

*Call graph*: calls 3 internal fn (new, new, new); called by 1 (new_status_output_with_rate_limits); 1 external calls (vec!).


##### `StatusHistoryCell::new`  (lines 249–374)

```
fn new(
        config: &Config,
        runtime_model_provider_base_url: Option<&str>,
        remote_connection: Option<&RemoteConnectionStatus>,
        account_display: Option<&StatusAccountDispla
```

**Purpose**: Derives all display-ready fields for the status card from config, runtime session data, token usage, and rate-limit snapshots. It also initializes the shared mutable state used for later rate-limit refreshes.

**Data flow**: Takes configuration plus optional runtime provider URL, remote connection, account/token info, usage totals, session/thread metadata, rate-limit snapshots, current time, model/collaboration/reasoning settings, an agents summary string, and a refresh flag. It reads approval policy and effective permission profile from config, computes workspace roots, assembles model/config entries, conditionally adds reasoning fields for `WireApi::Responses`, derives model display via `compose_model_display`, computes approval and sandbox summaries via `status_approval_label`, `status_permission_summary`, `workspace_root_suffix`, and `status_permissions_label`, formats provider/account/session/fork strings, computes token totals and optional context-window percentages, composes initial rate-limit data, stores rate-limit and agents-summary strings in `Arc<RwLock<_>>`, and returns `(StatusHistoryCell, StatusHistoryHandle)`.

**Call relations**: This constructor is called by `new_status_output_with_rate_limits_handle`. It delegates specialized formatting to helper functions in this file and sibling status modules, producing the immutable card fields plus the mutable handle state consumed later by rendering and refresh.

*Call graph*: calls 12 internal fn (from, blended_total, non_cached_input, format_model_provider, status_approval_label, status_permission_summary, status_permissions_label, workspace_root_suffix, compose_account_display, compose_model_display (+2 more)); called by 1 (new_status_output_with_rate_limits_handle); 7 external calls (new, new, effective_workspace_roots, default, first, len, vec!).


##### `StatusHistoryCell::token_usage_spans`  (lines 376–392)

```
fn token_usage_spans(&self) -> Vec<Span<'static>>
```

**Purpose**: Formats total, input, and output token counts into a styled span sequence for the status card. The total is emphasized while the breakdown is dimmed.

**Data flow**: Reads `self.token_usage.total`, `.input`, and `.output`, formats each with `format_tokens_compact`, assembles a `Vec<Span<'static>>` containing labels and punctuation with dim styling on the breakdown, and returns it.

**Call relations**: This helper is called by `StatusHistoryCell::display_lines` when token usage should be shown. It isolates the token-count presentation details from the broader card layout.

*Call graph*: calls 1 internal fn (format_tokens_compact); called by 1 (display_lines); 1 external calls (vec!).


##### `StatusHistoryCell::context_window_spans`  (lines 394–408)

```
fn context_window_spans(&self) -> Option<Vec<Span<'static>>>
```

**Purpose**: Formats context-window usage into a span sequence showing percent remaining and used/window token counts. It returns `None` when no context-window data is available.

**Data flow**: Reads `self.token_usage.context_window`; if absent, returns `None`. Otherwise it formats `percent_remaining`, `tokens_in_context`, and `window` with `format_tokens_compact`, builds a dimmed explanatory span vector, and returns `Some(Vec<Span<'static>>)`. No state is mutated.

**Call relations**: This helper is used by `StatusHistoryCell::display_lines` to optionally add a `Context window` row beneath token usage.

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

**Purpose**: Converts the current rate-limit state into one or more formatted status-card lines, including stale/missing warnings when appropriate. It handles all top-level `StatusRateLimitData` variants.

**Data flow**: Takes `&self`, a borrowed `StatusRateLimitState`, the available inner width, and a `FieldFormatter`. It matches on `state.rate_limits`: for `Available` it either emits a single 'not available' line for empty rows or delegates to `rate_limit_row_lines`; for `Stale` it appends a warning line after row rendering; for `Unavailable` and `Missing` it emits a single explanatory line whose text depends on `state.refreshing_rate_limits`. It returns `Vec<Line<'static>>`.

**Call relations**: This method is called by `StatusHistoryCell::display_lines` after the main metadata rows are assembled. It delegates detailed row formatting to `rate_limit_row_lines` and uses `FieldFormatter::line` for simple one-line cases.

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

**Purpose**: Formats individual rate-limit rows, including progress bars, percentage summaries, reset timestamps, and wrapped detail text. It adapts output to narrow widths by dropping the progress bar when necessary and wrapping continuation lines.

**Data flow**: Takes a slice of `StatusRateLimitRow`, available inner width, and a `FieldFormatter`. For each row, it matches on `row.value`: `Window` rows compute percent remaining, summary text, and a progress bar via `render_status_limit_progress_bar`; compare full-line width against `formatter.value_width(...)`; build either inline or wrapped reset-time continuation lines; and wrap optional detail text with `textwrap`. `Text` rows are rendered directly with `formatter.full_spans`. It accumulates and returns all resulting `Line<'static>` values.

**Call relations**: This helper is called by `rate_limit_lines` for `Available` and `Stale` data. It delegates width calculations to `line_display_width` and `FieldFormatter`, summary/progress rendering to rate-limit helpers, and wrapping to `textwrap`.

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

**Purpose**: Adds any labels needed by the current rate-limit state into the formatter label set, preserving uniqueness and order. This ensures later field alignment accounts for rate-limit rows and warnings.

**Data flow**: Takes `&self`, a borrowed `StatusRateLimitState`, a mutable `BTreeSet<String>` of seen labels, and a mutable `Vec<String>` of labels. It matches on `state.rate_limits` and pushes either `Limits`, each row label, and optionally `Warning` via `push_label`. It returns `()` and mutates the provided collections.

**Call relations**: This method is called by `StatusHistoryCell::display_lines` before constructing the `FieldFormatter`. It keeps formatter width calculation in sync with whichever rate-limit labels will actually be rendered.

*Call graph*: calls 1 internal fn (push_label); called by 1 (display_lines).


##### `status_permission_summary`  (lines 579–601)

```
fn status_permission_summary(
    permission_profile: &PermissionProfile,
    cwd: &AbsolutePathBuf,
    workspace_roots: &[AbsolutePathBuf],
) -> String
```

**Purpose**: Normalizes the low-level sandbox summary into shorter, user-facing permission phrases used in the status card. It collapses verbose variants like network-enabled read-only/workspace modes into stable labels.

**Data flow**: Takes a `PermissionProfile`, cwd, and workspace roots, calls `summarize_permission_profile`, then pattern-matches on the returned string. It rewrites `read-only ...` to either `read-only` or `read-only with network access`, rewrites `workspace-write ...` similarly, rewrites the exact custom-network string, and otherwise returns the original summary.

**Call relations**: This helper is called by `StatusHistoryCell::new` before building the final permissions label. It delegates the raw summary generation to `summarize_permission_profile` and then applies status-card-specific wording.

*Call graph*: called by 1 (new); 1 external calls (summarize_permission_profile).


##### `workspace_root_suffix`  (lines 603–617)

```
fn workspace_root_suffix(
    workspace_roots: &[AbsolutePathBuf],
    cwd: &AbsolutePathBuf,
) -> Option<String>
```

**Purpose**: Builds a bracketed suffix listing extra workspace roots beyond the current cwd. This lets workspace-based permission labels show additional allowed roots inline.

**Data flow**: Takes a slice of workspace roots and the cwd, filters out roots equal to cwd, converts remaining roots to lossy strings, collects them into a vector, and returns `None` if empty or `Some(format!(" [{}]", joined_roots))` otherwise.

**Call relations**: This helper is used by `StatusHistoryCell::new` and later fed into permission-label formatting. It is purely local string shaping.

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

**Purpose**: Produces the final human-readable permissions label shown in `/status`, combining active profile identity, sandbox summary, approval mode, and optional extra workspace roots. It contains the special-case logic that turns raw permission state into labels like `Read Only`, `Workspace`, `Full Access`, `Profile <id>`, or `Custom`.

**Data flow**: Takes an optional `ActivePermissionProfile`, the effective `PermissionProfile`, `AskForApproval`, sandbox summary text, approval label text, and optional workspace-root suffix. It inspects the active profile id and permission/approval combination, returning formatted strings for built-in read-only/workspace/full-access profiles, named custom profiles, or fallback custom labels. It may call `decorate_workspace_sandbox_label` when workspace-root suffixes should be appended to sandbox text.

**Call relations**: This helper is called by `StatusHistoryCell::new` after sandbox and approval labels have been computed. It centralizes the nuanced mapping from internal permission state to the exact status-card wording.

*Call graph*: calls 1 internal fn (decorate_workspace_sandbox_label); called by 1 (new); 1 external calls (format!).


##### `decorate_workspace_sandbox_label`  (lines 686–691)

```
fn decorate_workspace_sandbox_label(sandbox: &str, workspace_root_suffix: Option<&str>) -> String
```

**Purpose**: Appends the extra-workspace-root suffix only when the sandbox label starts with `workspace`. This avoids attaching workspace-root lists to unrelated sandbox descriptions.

**Data flow**: Takes `sandbox` and optional `workspace_root_suffix`. If a suffix exists and `sandbox.starts_with("workspace")`, it returns `format!("{sandbox}{suffix}")`; otherwise it returns `sandbox.to_string()`.

**Call relations**: This helper is used by `status_permissions_label` to keep workspace-root decoration logic small and reusable across multiple branches.

*Call graph*: called by 1 (status_permissions_label); 1 external calls (format!).


##### `status_approval_label`  (lines 693–706)

```
fn status_approval_label(
    approval_policy: AskForApproval,
    approvals_reviewer: ApprovalsReviewer,
    approval: &str,
) -> String
```

**Purpose**: Converts approval policy plus reviewer mode into the user-facing approval phrase shown in the permissions label. In on-request mode it distinguishes automatic review from explicit user approval.

**Data flow**: Takes `AskForApproval`, `ApprovalsReviewer`, and the raw approval string. If policy is `OnRequest`, it returns either `Approve for me` or `Ask for approval`; otherwise it returns `approval.to_string()`. It mutates no state.

**Call relations**: This helper is called by `StatusHistoryCell::new` before assembling the final permissions label. It isolates reviewer-specific wording from the broader permission formatting logic.

*Call graph*: called by 1 (new).


##### `StatusHistoryCell::display_lines`  (lines 709–874)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Renders the complete bordered `/status` card as ratatui lines, including header, optional usage note, remote connection, aligned metadata fields, token/context usage, and rate-limit rows. It is the main presentation function for the status card.

**Data flow**: Takes `&self` and a target width. It starts with the Codex/version header, computes `available_inner_width`, returns empty output if zero, derives optional account/thread/session labels, reads `rate_limit_state` and `agents_summary` through `RwLock` guards, builds the dynamic label set with `push_label` and `collect_rate_limit_labels`, constructs a `FieldFormatter`, optionally wraps and inserts the ChatGPT usage note and remote connection lines, formats model/provider/directory/permissions/account/thread/collaboration/session/fork rows, conditionally hides token usage for ChatGPT accounts, appends context-window and rate-limit lines, computes the maximum content width, truncates each line with `truncate_line_to_width`, and finally wraps the result with `with_border_with_inner_width`. It returns `Vec<Line<'static>>`.

**Call relations**: This method is called by `raw_lines` and `display_hyperlink_lines`, and is the core rendering path used whenever the status card is displayed. It delegates alignment to `FieldFormatter`, wrapping to `adaptive_wrap_lines`/`word_wrap_lines`, token/rate-limit formatting to sibling helpers, and final border rendering to `with_border_with_inner_width`.

*Call graph*: calls 10 internal fn (collect_rate_limit_labels, context_window_spans, rate_limit_lines, token_usage_spans, from_labels, push_label, format_directory_display, new, adaptive_wrap_lines, word_wrap_lines); called by 2 (display_hyperlink_lines, raw_lines); 8 external calls (from, from, new, new, with_border_with_inner_width, matches!, from, vec!).


##### `StatusHistoryCell::raw_lines`  (lines 876–878)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces a plain-text version of the status card lines suitable for raw transcript output. It strips richer formatting while preserving the rendered content.

**Data flow**: Calls `self.display_lines(u16::MAX)`, passes the result to `plain_lines`, and returns the resulting `Vec<Line<'static>>`. It reads card state but does not mutate it.

**Call relations**: This method is part of the `HistoryCell` implementation and is used when a plain, non-width-constrained representation is needed. It delegates all layout to `display_lines` and plainification to `plain_lines`.

*Call graph*: calls 2 internal fn (plain_lines, display_lines).


##### `StatusHistoryCell::display_hyperlink_lines`  (lines 880–903)

```
fn display_hyperlink_lines(
        &self,
        width: u16,
    ) -> Vec<crate::terminal_hyperlinks::HyperlinkLine>
```

**Purpose**: Builds hyperlink-aware status-card lines by scanning the rendered text for the ChatGPT usage URL and attaching a terminal hyperlink range to it. This preserves clickable links in terminals that support them.

**Data flow**: Takes `&self` and a width, calls `self.display_lines(width)`, converts those lines with `plain_hyperlink_lines`, then for each line concatenates visible span text, searches for `CHATGPT_USAGE_URL`, computes the starting display column using Unicode width, and pushes a `TerminalHyperlink` covering that column range with the URL as destination. It returns the modified hyperlink lines.

**Call relations**: This method is called by `transcript_hyperlink_lines` and serves the hyperlink-capable rendering path for the status card. It depends on `display_lines` for the visible content and augments it post hoc with hyperlink metadata.

*Call graph*: calls 2 internal fn (display_lines, plain_hyperlink_lines); called by 1 (transcript_hyperlink_lines).


##### `StatusHistoryCell::transcript_hyperlink_lines`  (lines 905–910)

```
fn transcript_hyperlink_lines(
        &self,
        width: u16,
    ) -> Vec<crate::terminal_hyperlinks::HyperlinkLine>
```

**Purpose**: Returns the hyperlink-aware transcript representation of the status card. It currently reuses the same hyperlink logic as on-screen display rendering.

**Data flow**: Takes `&self` and a width, delegates directly to `self.display_hyperlink_lines(width)`, and returns that value. It performs no additional transformation.

**Call relations**: This method is part of the `HistoryCell` implementation and simply forwards transcript hyperlink rendering to `display_hyperlink_lines`.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `format_model_provider`  (lines 913–931)

```
fn format_model_provider(config: &Config, runtime_base_url: Option<&str>) -> Option<String>
```

**Purpose**: Formats the model-provider line for the status card, optionally including a sanitized runtime base URL. It suppresses the line entirely for the default OpenAI provider with no custom base URL.

**Data flow**: Takes `&Config` and an optional runtime base URL string. It reads provider metadata, chooses either the trimmed provider name or `config.model_provider_id`, sanitizes the runtime URL with `sanitize_base_url`, checks whether the provider is default OpenAI with no custom URL, and returns `None` in that case or `Some(provider_name)` / `Some("provider - base_url")` otherwise.

**Call relations**: This helper is called by `StatusHistoryCell::new` while deriving display fields. It delegates URL cleanup to `sanitize_base_url`.

*Call graph*: called by 1 (new); 1 external calls (format!).


##### `sanitize_base_url`  (lines 933–947)

```
fn sanitize_base_url(raw: &str) -> Option<String>
```

**Purpose**: Parses and normalizes a provider base URL for safe display by stripping credentials, query parameters, fragments, and trailing slashes. Invalid or empty inputs are discarded.

**Data flow**: Takes `&str` raw, trims whitespace, returns `None` if empty, attempts `Url::parse`, and on success clears username, password, query, and fragment, converts back to string, trims any trailing slash, filters out an empty result, and returns `Option<String>`.

**Call relations**: This helper is used only by `format_model_provider` so the status card can show a runtime endpoint without leaking embedded credentials or noisy URL components.

*Call graph*: 1 external calls (parse).


### `tui/src/token_usage.rs`

`data_model` · `usage display`

This file is the TUI-facing token accounting model. `TokenUsage` stores raw counts for input, cached input, output, reasoning output, and total tokens, and derives several safer display metrics from them. The methods clamp negative values away where appropriate: `cached_input` never returns less than zero, `non_cached_input` subtracts cached input from total input but floors at zero, and `blended_total` combines non-cached input with non-negative output. These derived values are intended for user-facing summaries rather than exact protocol preservation.

A notable design choice is the `BASELINE_TOKENS` constant of 12000, used by `percent_of_context_window_remaining`. The method treats the first 12k tokens as baseline overhead and computes remaining percentage only over the window beyond that baseline. If the model context window is at or below the baseline, it returns 0 immediately. Otherwise it subtracts the baseline from both the window and the current `total_tokens`, clamps used and remaining values to non-negative ranges, and returns a rounded 0–100 percentage.

`tokens_in_context_window` intentionally returns raw `total_tokens`, with the comment clarifying that this means different things depending on whether the value came from `last_token_usage` or `total_token_usage`. `TokenUsageInfo` groups total usage, last usage, and optional model context window. Finally, the `Display` implementation formats a concise summary string using thousands separators and conditionally includes `(+ N cached)` and `(reasoning N)` suffixes only when those counts are positive.

#### Function details

##### `TokenUsage::is_zero`  (lines 21–23)

```
fn is_zero(&self) -> bool
```

**Purpose**: Reports whether the usage record represents zero total tokens. It uses `total_tokens` as the authoritative zero/non-zero indicator.

**Data flow**: Reads `self.total_tokens` and returns `true` if it equals 0, otherwise `false`.

**Call relations**: This is a simple predicate method used wherever callers need to suppress empty usage displays.


##### `TokenUsage::cached_input`  (lines 25–27)

```
fn cached_input(&self) -> i64
```

**Purpose**: Returns the cached-input token count clamped to a non-negative value. This prevents negative protocol values from leaking into display calculations.

**Data flow**: Reads `self.cached_input_tokens`, applies `.max(0)`, and returns the resulting `i64`.

**Call relations**: Used by `non_cached_input` and indirectly by display formatting to compute safe derived counts.

*Call graph*: called by 1 (non_cached_input).


##### `TokenUsage::non_cached_input`  (lines 29–31)

```
fn non_cached_input(&self) -> i64
```

**Purpose**: Computes the portion of input tokens that were not served from cache, clamped at zero. It subtracts the sanitized cached-input count from total input.

**Data flow**: Reads `self.input_tokens`, calls `self.cached_input()`, subtracts the cached amount, applies `.max(0)`, and returns the resulting `i64`.

**Call relations**: Called by `blended_total` and the `Display` implementation to present billable/non-cached input separately from cached input.

*Call graph*: calls 1 internal fn (cached_input); called by 1 (blended_total).


##### `TokenUsage::blended_total`  (lines 33–35)

```
fn blended_total(&self) -> i64
```

**Purpose**: Computes a display-oriented total consisting of non-cached input plus non-negative output tokens. It excludes cached input from the headline total.

**Data flow**: Calls `self.non_cached_input()`, reads `self.output_tokens.max(0)`, adds them, clamps the sum at zero, and returns the resulting `i64`.

**Call relations**: Used by the `Display` implementation as the `total=` figure shown to users.

*Call graph*: calls 1 internal fn (non_cached_input).


##### `TokenUsage::tokens_in_context_window`  (lines 39–41)

```
fn tokens_in_context_window(&self) -> i64
```

**Purpose**: Returns the raw `total_tokens` value for context-window calculations. The method exists mainly to document the semantic distinction between latest-context size and accumulated session total.

**Data flow**: Reads and returns `self.total_tokens` unchanged.

**Call relations**: Called by `percent_of_context_window_remaining` as the source of current context usage.

*Call graph*: called by 1 (percent_of_context_window_remaining).


##### `TokenUsage::percent_of_context_window_remaining`  (lines 43–53)

```
fn percent_of_context_window_remaining(&self, context_window: i64) -> i64
```

**Purpose**: Estimates the remaining percentage of a model’s context window after subtracting a fixed baseline token allowance. It returns an integer percentage rounded to the nearest whole number and clamped to 0–100.

**Data flow**: Takes `context_window: i64`; if it is `<= BASELINE_TOKENS`, returns 0. Otherwise it computes `effective_window = context_window - BASELINE_TOKENS`, `used = (self.tokens_in_context_window() - BASELINE_TOKENS).max(0)`, `remaining = (effective_window - used).max(0)`, converts the ratio to `f64`, clamps it between 0 and 100, rounds, and returns it as `i64`.

**Call relations**: This method is the file’s main derived metric for UI indicators that show remaining context capacity.

*Call graph*: calls 1 internal fn (tokens_in_context_window).


##### `TokenUsage::fmt`  (lines 64–88)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats token usage into a concise human-readable summary string with thousands separators and optional cached/reasoning annotations.

**Data flow**: Reads derived values from `self.blended_total()`, `self.non_cached_input()`, `self.cached_input()`, `self.output_tokens`, and `self.reasoning_output_tokens`, formats each with `format_with_separators`, conditionally builds cached and reasoning suffix strings, and writes the final sentence into the formatter.

**Call relations**: Used whenever `TokenUsage` is displayed as text. It depends on the helper methods in this impl to ensure negative raw values are sanitized before presentation.

*Call graph*: 1 external calls (write!).


### `tui/src/chatwidget/tokens/chart.rs`

`domain_logic` · `request handling`

This module is the presentation engine for token activity once a usage response has already been loaded. `TokenActivityView` selects among `Daily`, `Weekly`, and `Cumulative` modes, with `parse` accepting aliases like empty string, `day`, and `week`. The top-level `loaded_lines` function assembles the card: a title line, packed summary metrics from `response.summary`, a blank separator, and either an unavailable-history message or chart output from `chart_lines`.

The chart always spans a fixed 52-week by 7-day logical grid. `daily_values` normalizes backend `AccountTokenUsageDailyBucket` records into that window, ignoring malformed dates, future dates, and out-of-range entries, summing duplicates, and clamping negative token counts to zero. `levels_for_view` then derives either graded daily intensity levels or weekly/cumulative bar heights. `chart_lines` computes how many columns fit in the current width, emits month labels, renders each row with weekday/Y-axis labels and palette-selected glyphs/styles, and appends either a daily legend or a bar-chart caption plus a footer advertising alternate `/usage` views.

Summary formatting is width-aware: `pack_fields` greedily groups `Lifetime`, `Peak`, `Streak`, and `Longest task` fields into as few lines as fit, while `align_summary_line` keeps them left-aligned with a single-space indent. Styling is theme-sensitive through `foreground_style_for_scopes`, but falls back to dim labels and green numeric values when highlight scopes are unavailable.

#### Function details

##### `TokenActivityView::parse`  (lines 45–52)

```
fn parse(value: &str) -> Option<Self>
```

**Purpose**: Parses the optional `/usage` argument into one of the supported chart views. It treats no argument and daily aliases as `Daily`, recognizes weekly and cumulative names, and rejects anything else.

**Data flow**: Takes an input `&str`, trims it, lowercases it with ASCII rules, matches the normalized string, and returns `Some(TokenActivityView)` for supported values or `None` for unsupported ones.

**Call relations**: Called by slash-command dispatch code when interpreting `/usage` arguments. Its `None` result lets the caller surface an unsupported-argument error instead of silently choosing a default.

*Call graph*: called by 1 (dispatch_prepared_command_with_args).


##### `TokenActivityView::label`  (lines 54–60)

```
fn label(self) -> &'static str
```

**Purpose**: Returns the human-readable label for a chart view. The labels are used in command echoing and UI text.

**Data flow**: Consumes `self` by value and matches it to return one of the static strings `Daily`, `Weekly`, or `Cumulative`.

**Call relations**: Used by higher-level token-activity code when constructing the echoed `/usage <view>` command line and other view-specific text.


##### `loaded_lines`  (lines 63–86)

```
fn loaded_lines(
    view: TokenActivityView,
    response: &GetAccountTokenUsageResponse,
    today: NaiveDate,
    width: u16,
) -> Vec<Line<'static>>
```

**Purpose**: Builds the full rendered contents of a loaded token-activity card, including title, summary metrics, and either a chart or an unavailable-history message. It is the main pure rendering entry point for loaded usage responses.

**Data flow**: Accepts a `TokenActivityView`, a `GetAccountTokenUsageResponse`, a `today` anchor date, and a width. It starts a `Vec<Line>` with the title line, extends it with `summary_lines(response, graph_width(width))`, inserts a blank line, then either appends a dim unavailable-history line if `daily_usage_buckets` is `None` or delegates to `chart_lines(view, buckets, today, width)` and appends those lines. It returns the assembled vector.

**Call relations**: Called by `TokenActivityHistoryCell::display_lines` when the shared state is `Loaded`. It delegates width calculations and chart rendering to `graph_width`, `summary_lines`, and `chart_lines`.

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

**Purpose**: Renders the 52-week activity graph and its legend/caption/footer for the selected view. It handles width truncation, future-day suppression in daily mode, and palette-driven glyph/style selection.

**Data flow**: Takes a view, daily buckets slice, anchor date, and width. It computes normalized `values` with `daily_values`, visible column count with `shown_columns`, and returns an explanatory dim line if no columns fit. Otherwise it builds a `TokenActivityPalette`, derives per-cell levels with `levels_for_view`, computes the first visible column, emits month labels, then loops over 7 rows and visible columns to append weekday/Y-axis labels plus either blanks for future daily cells or styled glyphs from the palette. It adds a blank separator, then either `legend_line` for daily mode or `bar_caption` for weekly/cumulative mode, followed by `view_footer`, and returns all lines.

**Call relations**: Called only by `loaded_lines`. It is the central coordinator for the chart-rendering pipeline, delegating data normalization, level computation, labels, legend/caption, and footer generation to helper functions and the palette module.

*Call graph*: calls 9 internal fn (bar_caption, cell_date, daily_values, legend_line, levels_for_view, month_labels, current, shown_columns, view_footer); called by 1 (loaded_lines); 4 external calls (default, styled, new, vec!).


##### `shown_columns`  (lines 140–146)

```
fn shown_columns(width: u16) -> usize
```

**Purpose**: Computes how many weekly columns can fit in the available terminal width. The result is capped at the fixed 52-week chart width.

**Data flow**: Converts the `u16` width to `usize`, subtracts the left gutter width with saturation, adds one, divides by two because each chart column consumes two character cells except the last separator, and returns the minimum of that value and `WEEK_COUNT`.

**Call relations**: Used by both `chart_lines` and `graph_width` so summary width and chart width stay consistent with the same visible-column calculation.

*Call graph*: called by 2 (chart_lines, graph_width); 1 external calls (from).


##### `graph_width`  (lines 148–153)

```
fn graph_width(width: u16) -> u16
```

**Purpose**: Derives the effective width occupied by the chart area, preserving raw-output mode when width is `u16::MAX`. This width is reused for summary packing so the summary aligns with the graph below.

**Data flow**: Takes a `u16` width. If it equals `u16::MAX`, it returns that sentinel unchanged; otherwise it computes `CHART_LEFT_WIDTH + shown_columns(width) * 2 - 1` and returns it as `u16`.

**Call relations**: Called by `loaded_lines` before `summary_lines`, and tested independently for wide-terminal behavior. It depends on `shown_columns` for the visible chart span.

*Call graph*: calls 1 internal fn (shown_columns); called by 1 (loaded_lines).


##### `summary_lines`  (lines 155–173)

```
fn summary_lines(response: &GetAccountTokenUsageResponse, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Formats the usage summary metrics above the chart into one or more left-aligned lines that fit the graph width. It combines token counts, streak information, and longest-task duration into a compact headline block.

**Data flow**: Reads `response.summary`, builds four `(label, value)` pairs using `format_optional_tokens`, `format_streak`, and `format_optional_duration`, passes them to `pack_fields`, then maps each packed group through `summary_line` and `align_summary_line(width)` to produce the final `Vec<Line<'static>>`.

**Call relations**: Called by `loaded_lines` before chart rendering. It delegates field formatting and width-aware grouping to several helpers so the summary remains compact but readable.

*Call graph*: calls 4 internal fn (format_optional_duration, format_optional_tokens, format_streak, pack_fields); called by 1 (loaded_lines).


##### `pack_fields`  (lines 177–198)

```
fn pack_fields(fields: &[(&str, String)], width: u16) -> Vec<Vec<usize>>
```

**Purpose**: Greedily groups summary fields into as few lines as will fit the target width while preserving field order. In raw-output mode it forces all fields onto one line.

**Data flow**: Accepts a slice of `(label, String)` fields and a width. If width is `u16::MAX`, it returns a single group containing all field indexes. Otherwise it computes the maximum content width after indentation, iterates field indexes, tentatively appends each to the current group, measures the candidate with `summary_line(...).width()`, and either keeps it in the current group or starts a new group. It returns a `Vec<Vec<usize>>` of grouped field indexes.

**Call relations**: Used only by `summary_lines`. It relies on `summary_line` for width measurement so grouping matches actual rendered content.

*Call graph*: calls 1 internal fn (summary_line); called by 1 (summary_lines); 4 external calls (new, take, from, vec!).


##### `summary_line`  (lines 200–211)

```
fn summary_line(fields: &[(&str, String)], indexes: &[usize]) -> Line<'static>
```

**Purpose**: Builds one rendered summary line from a selected subset of summary fields. Labels are dimmed and values use the numeric style, with ` · ` separators between fields.

**Data flow**: Takes the full field slice and a slice of selected indexes. It iterates the indexes, appending separator spans after the first field, then appending a styled label span and a styled cloned value span for each field. It converts the accumulated spans into a `Line<'static>` and returns it.

**Call relations**: Called by `pack_fields` for width measurement and by `summary_lines` for final rendering. It depends on `label_style` and `numeric_style` for visual distinction.

*Call graph*: calls 2 internal fn (label_style, numeric_style); called by 1 (pack_fields); 3 external calls (styled, new, format!).


##### `align_summary_line`  (lines 213–219)

```
fn align_summary_line(mut line: Line<'static>, width: u16) -> Line<'static>
```

**Purpose**: Adds the fixed left indent used by summary lines, except in raw-output mode. This keeps summary text aligned with the chart body.

**Data flow**: Takes a mutable `Line<'static>` and a width. If width is `u16::MAX`, it returns the line unchanged; otherwise it inserts `SUMMARY_INDENT` as the first span and returns the modified line.

**Call relations**: Used only by `summary_lines` after `summary_line` has built the content spans.


##### `format_optional_tokens`  (lines 221–225)

```
fn format_optional_tokens(value: Option<i64>) -> String
```

**Purpose**: Formats an optional token count into compact human-readable text or `-` when absent. It is used for lifetime and peak token metrics.

**Data flow**: Accepts `Option<i64>`, maps `Some(value)` through `format_tokens_compact`, and returns `-` as a new `String` for `None`.

**Call relations**: Called by `summary_lines` when constructing the `Lifetime` and `Peak` fields.

*Call graph*: called by 1 (summary_lines).


##### `format_streak`  (lines 229–237)

```
fn format_streak(current: Option<i64>, longest: Option<i64>) -> String
```

**Purpose**: Formats current and longest streak values into a compact streak string. It collapses equal current/longest values to a single `Nd` form and otherwise includes the best streak in parentheses.

**Data flow**: Takes `Option<i64>` for current and longest streak days, matches the pair, and returns one of several formatted strings such as `54d`, `12d (best 54d)`, `- (best 54d)`, or `-`.

**Call relations**: Used only by `summary_lines` to build the `Streak` field.

*Call graph*: called by 1 (summary_lines); 1 external calls (format!).


##### `format_optional_duration`  (lines 239–254)

```
fn format_optional_duration(value: Option<i64>) -> String
```

**Purpose**: Formats an optional duration in seconds into a compact `s`, `m`, or `h m` string, clamping negative values to zero. Missing durations render as `-`.

**Data flow**: Accepts `Option<i64>`. For `None`, returns `-`. For `Some(seconds)`, clamps to nonnegative, derives hours and minutes, and returns one of `Xs`, `Ym`, `Zh`, or `Zh Ym` depending on which units are nonzero.

**Call relations**: Called by `summary_lines` to build the `Longest task` field.

*Call graph*: called by 1 (summary_lines).


##### `numeric_style`  (lines 256–259)

```
fn numeric_style() -> Style
```

**Purpose**: Chooses the style used for numeric summary values and active footer labels. It prefers theme-highlight scopes and falls back to green text.

**Data flow**: Calls `foreground_style_for_scopes(&["constant.numeric", "constant"])`; if a style is found it returns it, otherwise it returns `Style::default().green()`.

**Call relations**: Used by `summary_line` for metric values and by `view_footer` to emphasize the active view.

*Call graph*: calls 1 internal fn (foreground_style_for_scopes); called by 2 (summary_line, view_footer).


##### `label_style`  (lines 261–263)

```
fn label_style() -> Style
```

**Purpose**: Chooses the dim/comment-like style used for labels, legends, captions, and inactive footer text. It prefers theme-highlight scopes and falls back to a dim default style.

**Data flow**: Calls `foreground_style_for_scopes(&["comment"])`; if present it returns that style, otherwise it returns `Style::default().dim()`.

**Call relations**: Shared across many rendering helpers including `summary_line`, `weekday_label`, `legend_line`, `bar_caption`, and `view_footer`.

*Call graph*: calls 1 internal fn (foreground_style_for_scopes); called by 5 (bar_caption, legend_line, summary_line, view_footer, weekday_label).


##### `weekday_label`  (lines 265–291)

```
fn weekday_label(view: TokenActivityView, row: usize) -> Span<'static>
```

**Purpose**: Builds the left gutter label for one chart row. In daily mode it shows weekday abbreviations; in bar modes it doubles as a coarse Y-axis with `max` at the top and `0` at the bottom.

**Data flow**: Takes a `TokenActivityView` and row index. For non-daily views it returns styled spans `max `, `  0 `, or blank gutter text depending on row. For daily view it maps rows 0 through 6 to `Su`, `Mo`, `Tu`, `We`, `Th`, `Fr`, `Sa`, styles the chosen text with `label_style`, and returns it as a `Span<'static>`.

**Call relations**: Called by `chart_lines` once per rendered row before chart cells are appended.

*Call graph*: calls 1 internal fn (label_style); 1 external calls (styled).


##### `legend_line`  (lines 293–306)

```
fn legend_line(palette: &TokenActivityPalette) -> Line<'static>
```

**Purpose**: Builds the daily-view legend showing the progression from less to more activity across five intensity levels. It uses the palette’s glyph and per-level styles.

**Data flow**: Accepts a `TokenActivityPalette`, starts with a styled `Less` label, iterates levels 0 through 4 inserting spaces between entries, appends a styled glyph for each level using `palette.glyph(TokenActivityView::Daily, level)` and `palette.for_level(level)`, then appends a styled `More` label and returns the spans as a `Line<'static>`.

**Call relations**: Called by `chart_lines` only for `TokenActivityView::Daily`. It depends on the palette to reflect terminal color capability.

*Call graph*: calls 3 internal fn (label_style, for_level, glyph); called by 1 (chart_lines); 2 external calls (styled, vec!).


##### `bar_caption`  (lines 310–328)

```
fn bar_caption(view: TokenActivityView, values: &[i64]) -> Line<'static>
```

**Purpose**: Builds the explanatory caption for weekly and cumulative bar-chart modes, including the peak value used for scaling. If there is no activity, it emits a no-activity message instead.

**Data flow**: Takes a view and normalized daily values slice, computes weekly totals with `weekly_totals`, then chooses a lead string and peak value: max weekly total for `Weekly`, sum of weekly totals for `Cumulative`. If the peak is nonpositive it returns a dim `No token activity in the last 12 months` line; otherwise it returns a line combining the lead text in `label_style` and the compact peak value in `numeric_style`.

**Call relations**: Called by `chart_lines` for `Weekly` and `Cumulative` views instead of the daily legend.

*Call graph*: calls 2 internal fn (label_style, weekly_totals); called by 1 (chart_lines); 2 external calls (styled, vec!).


##### `view_footer`  (lines 332–351)

```
fn view_footer(active: TokenActivityView) -> Line<'static>
```

**Purpose**: Renders the footer listing all `/usage` views and highlighting the active one. This makes alternate views discoverable directly from the card.

**Data flow**: Takes the active `TokenActivityView`, starts with a styled indent span, iterates the three views in fixed order, inserts ` · ` separators between them, chooses `numeric_style().bold()` for the active view and `label_style()` for inactive ones, and returns the assembled spans as a `Line<'static>`.

**Call relations**: Always called by `chart_lines` after the legend or caption. It depends on `numeric_style` and `label_style` for emphasis.

*Call graph*: calls 2 internal fn (label_style, numeric_style); called by 1 (chart_lines); 2 external calls (styled, vec!).


##### `month_labels`  (lines 353–377)

```
fn month_labels(today: NaiveDate, first_column: usize, shown_columns: usize) -> Line<'static>
```

**Purpose**: Places abbreviated month labels above the visible chart columns without overlapping adjacent labels. Labels are only emitted near the start of a month.

**Data flow**: Takes `today`, `first_column`, and `shown_columns`. It allocates a character buffer sized to the visible chart width, computes the oldest chart date with `chart_start(today)`, then iterates visible columns. For each column it computes the column’s date, skips dates whose day-of-month is greater than 7, formats the month as `%b`, and writes it into the buffer only if it fits and does not overlap the previous label. It returns a line consisting of the left gutter and the styled month-label string.

**Call relations**: Called by `chart_lines` before row rendering. It depends on `chart_start` so labels align with the same fixed 52-week window as the chart cells.

*Call graph*: calls 1 internal fn (chart_start); called by 1 (chart_lines); 2 external calls (days, vec!).


##### `daily_values`  (lines 384–408)

```
fn daily_values(
    buckets: &[codex_app_server_protocol::AccountTokenUsageDailyBucket],
    today: NaiveDate,
) -> Vec<i64>
```

**Purpose**: Normalizes backend daily usage buckets into a fixed-length vector of per-day token totals covering the chart window. It filters invalid data and guarantees one nonnegative value per chart cell.

**Data flow**: Accepts a slice of backend daily buckets and `today`. It computes the chart window `[start, end)` from `chart_start(today)`, iterates buckets, parses each `start_date` as `%Y-%m-%d`, skips parse failures, out-of-window dates, and future dates, and accumulates `bucket.tokens.max(0)` into a `BTreeMap<NaiveDate, i64>`. It then maps every day offset in the 52-week window to the stored total or zero and returns the resulting `Vec<i64>` of length `CELL_COUNT`.

**Call relations**: Called by `chart_lines` before level computation. Its normalization rules are explicitly exercised by chart tests for duplicate dates and negative values.

*Call graph*: calls 1 internal fn (chart_start); called by 1 (chart_lines); 3 external calls (new, days, parse_from_str).


##### `levels_for_view`  (lines 410–425)

```
fn levels_for_view(values: &[i64], view: TokenActivityView) -> Vec<usize>
```

**Purpose**: Converts normalized daily token values into per-cell intensity levels appropriate for the selected chart view. Daily mode uses graded intensity; weekly and cumulative modes use full-height bar silhouettes.

**Data flow**: Takes a daily values slice and a `TokenActivityView`. For `Daily`, it returns `graded_levels(values)`. For `Weekly`, it computes `weekly_totals(values)` and passes them to `bar_levels`. For `Cumulative`, it computes weekly totals, folds them into a running sum vector with `scan`, then passes that cumulative vector to `bar_levels`.

**Call relations**: Called by `chart_lines` after `daily_values`. It delegates the actual scaling logic to `graded_levels`, `weekly_totals`, and `bar_levels`.

*Call graph*: calls 3 internal fn (bar_levels, graded_levels, weekly_totals); called by 1 (chart_lines).


##### `graded_levels`  (lines 427–439)

```
fn graded_levels(values: &[i64]) -> Vec<usize>
```

**Purpose**: Maps daily token counts onto five intensity levels from 0 to 4 relative to the maximum observed daily value. Zero activity always maps to level 0.

**Data flow**: Reads the maximum value in the input slice, defaulting to zero. It then maps each value: zero or all-zero datasets become level 0; values above 75% of max become 4; above 50% become 3; above 25% become 2; otherwise 1. It returns the resulting `Vec<usize>`.

**Call relations**: Used only by `levels_for_view` for daily charts.

*Call graph*: called by 1 (levels_for_view).


##### `weekly_totals`  (lines 441–446)

```
fn weekly_totals(values: &[i64]) -> Vec<i64>
```

**Purpose**: Aggregates normalized daily values into one total per week. The chart window is already aligned to Sundays, so each 7-day chunk corresponds to one displayed column.

**Data flow**: Takes a daily values slice, iterates it in `DAY_COUNT`-sized chunks, sums each chunk’s values, and returns the weekly totals as `Vec<i64>`.

**Call relations**: Called by both `levels_for_view` and `bar_caption`, ensuring bar scaling and caption text are based on the same weekly aggregation.

*Call graph*: called by 2 (bar_caption, levels_for_view).


##### `bar_levels`  (lines 448–461)

```
fn bar_levels(totals: &[i64]) -> Vec<usize>
```

**Purpose**: Converts weekly totals into a 7-row bar-chart occupancy grid. Each week becomes seven per-row levels, filled from the bottom upward and using level 4 for filled cells.

**Data flow**: Reads the maximum weekly total, then iterates each total. For nonpositive totals or all-zero datasets it assigns height 0; otherwise it computes a ceiling-scaled height from 1 to 7 using the ratio to the maximum. It then expands each week into seven row values, returning 4 for rows within the filled height and 0 for rows above it. The flattened result is a `Vec<usize>` aligned with chart cell indexing.

**Call relations**: Used by `levels_for_view` for weekly and cumulative charts. Its bottom-up fill behavior is covered by dedicated tests.

*Call graph*: called by 1 (levels_for_view).


##### `chart_start`  (lines 463–466)

```
fn chart_start(today: NaiveDate) -> NaiveDate
```

**Purpose**: Computes the oldest date represented by the fixed 52-week chart window. The start is always aligned to a Sunday so weekly columns line up consistently.

**Data flow**: Takes `today`, subtracts the number of days since Sunday from `today` to get the current week’s Sunday, then subtracts `WEEK_COUNT - 1` weeks to reach the oldest displayed Sunday, and returns that `NaiveDate`.

**Call relations**: Called by `month_labels`, `daily_values`, and `cell_date`. It is the shared anchor that keeps labels, normalization, and future-cell checks aligned.

*Call graph*: called by 3 (cell_date, daily_values, month_labels); 4 external calls (days, weeks, weekday, from).


##### `cell_date`  (lines 468–470)

```
fn cell_date(today: NaiveDate, index: usize) -> Option<NaiveDate>
```

**Purpose**: Maps a flattened chart cell index back to its corresponding calendar date. This is used to suppress future cells in daily mode.

**Data flow**: Takes `today` and a cell index, computes `chart_start(today)`, adds `index` days with checked arithmetic, and returns `Option<NaiveDate>`.

**Call relations**: Called by `chart_lines` only for daily charts when deciding whether a visible cell lies after `today` and should render as blank.

*Call graph*: calls 1 internal fn (chart_start); called by 1 (chart_lines); 1 external calls (days).


### External event adapters and backend feeds
These files adapt backend process, rate-limit, exec, and pull-stream events into the data that the TUI later projects into transcript and status UI.

### `codex-api/src/rate_limits.rs`

`domain_logic` · `response header parsing and streaming metadata handling`

This file translates several wire formats into `codex_protocol::protocol::RateLimitSnapshot` and related types. The header path starts with `parse_default_rate_limit`, which always targets the legacy `x-codex-*` family, and `parse_all_rate_limits`, which scans every header name to discover additional limit families such as `x-codex-secondary-*`. A `BTreeSet` is used so discovered limit IDs are deduplicated and emitted in stable sorted order. Importantly, `parse_all_rate_limits` always includes the default Codex snapshot even when it contains no data; additional snapshots are only appended if `has_rate_limit_data` says they contain at least one populated window or credits block.

`parse_rate_limit_for_limit` performs the actual assembly. It normalizes the requested limit name by trimming, lowercasing, and converting `_` to `-` for header lookup, then parses primary and secondary windows from three-header groups (`used-percent`, `window-minutes`, `reset-at`). It also reads credits from the fixed `x-codex-credits-*` headers and an optional human-readable limit name from `x-<limit>-limit-name`. The returned snapshot always has a normalized underscore-style `limit_id` and leaves unsupported fields like `individual_limit`, `plan_type`, and `rate_limit_reached_type` as `None`.

The event path deserializes JSON payloads into internal `RateLimitEvent*` structs, accepts only `type == "codex.rate_limits"`, maps optional windows and credits, and carries through `plan_type`. Parsing helpers are deliberately forgiving: malformed numbers, booleans, or non-UTF8 headers simply become `None`, and zero-valued windows are suppressed unless some nonzero or reset data is present.

#### Function details

##### `RateLimitError::fmt`  (lines 17–19)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats `RateLimitError` by emitting only its stored message string. The type is effectively a thin wrapper around a human-readable error message.

**Data flow**: Reads `self.message` and writes it into the provided formatter with `write!`. It returns the standard formatting result and does not mutate the error.

**Call relations**: This is the `Display` implementation for the file's error type, used whenever the error is rendered into logs or user-facing text.

*Call graph*: 1 external calls (write!).


##### `parse_default_rate_limit`  (lines 23–25)

```
fn parse_default_rate_limit(headers: &HeaderMap) -> Option<RateLimitSnapshot>
```

**Purpose**: Parses the legacy/default `x-codex-*` header family into a single `RateLimitSnapshot`. It is just the default-limit specialization of the more general parser.

**Data flow**: Takes a borrowed `HeaderMap`, passes it to `parse_rate_limit_for_limit` with `None` as the limit id, and returns that `Option<RateLimitSnapshot>` unchanged.

**Call relations**: This is called first by `parse_all_rate_limits` so the default Codex snapshot is always considered before scanning for additional limit families.

*Call graph*: calls 1 internal fn (parse_rate_limit_for_limit); called by 1 (parse_all_rate_limits).


##### `parse_all_rate_limits`  (lines 28–51)

```
fn parse_all_rate_limits(headers: &HeaderMap) -> Vec<RateLimitSnapshot>
```

**Purpose**: Collects every recognizable rate-limit snapshot from a response header set, including the default Codex family and any discovered named limit families. It preserves a deterministic output order.

**Data flow**: Starts with an empty `Vec<RateLimitSnapshot>`, optionally pushes the result of `parse_default_rate_limit`, then iterates `headers.keys()`, lowercases each header name, and uses `header_name_to_limit_id` to discover non-default limit ids. Those ids are inserted into a `BTreeSet<String>` for deduplication and sorting. It then parses each discovered limit via `parse_rate_limit_for_limit` and keeps only snapshots where `has_rate_limit_data` is true. The final vector is returned.

**Call relations**: Streaming setup code calls this from `spawn_response_stream` to emit initial rate-limit events from HTTP headers. Internally it depends on `parse_default_rate_limit` for the legacy family and `header_name_to_limit_id` to discover additional families.

*Call graph*: calls 2 internal fn (header_name_to_limit_id, parse_default_rate_limit); called by 3 (parse_all_rate_limits_includes_default_codex_snapshot, parse_all_rate_limits_reads_all_limit_families, spawn_response_stream); 3 external calls (new, keys, new).


##### `parse_rate_limit_for_limit`  (lines 57–100)

```
fn parse_rate_limit_for_limit(
    headers: &HeaderMap,
    limit_id: Option<&str>,
) -> Option<RateLimitSnapshot>
```

**Purpose**: Builds a `RateLimitSnapshot` for one logical metered limit by reading the corresponding header family. It supports both the default `codex` family and named variants like `codex_secondary`.

**Data flow**: Reads `limit_id`, trims and lowercases it, defaults empty input to `codex`, and converts underscores to hyphens for header naming. It constructs an `x-<limit>` prefix, parses `primary` and `secondary` windows via `parse_rate_limit_window`, parses credits via `parse_credits_snapshot`, reads an optional `x-<limit>-limit-name` string via `parse_header_str`, normalizes the limit id back to underscore form with `normalize_limit_id`, and returns `Some(RateLimitSnapshot { ... })` with unsupported fields set to `None`.

**Call relations**: This is the central header parser used by both `parse_default_rate_limit` and `parse_all_rate_limits`, and it is also exercised directly by unit tests covering default, secondary, and named-limit behavior.

*Call graph*: calls 4 internal fn (normalize_limit_id, parse_credits_snapshot, parse_header_str, parse_rate_limit_window); called by 4 (parse_default_rate_limit, parse_rate_limit_for_limit_defaults_to_codex_headers, parse_rate_limit_for_limit_prefers_limit_name_header, parse_rate_limit_for_limit_reads_secondary_headers); 1 external calls (format!).


##### `parse_rate_limit_event`  (lines 133–165)

```
fn parse_rate_limit_event(payload: &str) -> Option<RateLimitSnapshot>
```

**Purpose**: Parses a JSON event payload representing a live rate-limit update into a `RateLimitSnapshot`. It only accepts the specific event kind `codex.rate_limits`.

**Data flow**: Deserializes the `payload` string into `RateLimitEvent` with `serde_json::from_str`; parse failure returns `None`. If `event.kind` is not `codex.rate_limits`, it returns `None`. Otherwise it maps optional primary and secondary windows through `map_event_window`, converts optional credits into `CreditsSnapshot`, chooses a limit id from `metered_limit_name` or `limit_name`, normalizes it, defaults missing ids to `codex`, and returns a populated snapshot carrying through `plan_type`.

**Call relations**: WebSocket response-stream handling invokes this when it receives rate-limit event payloads. It delegates per-window conversion to `map_event_window`.

*Call graph*: calls 1 internal fn (map_event_window); called by 1 (run_websocket_response_stream); 1 external calls (from_str).


##### `map_event_window`  (lines 167–174)

```
fn map_event_window(window: Option<&RateLimitEventWindow>) -> Option<RateLimitWindow>
```

**Purpose**: Converts an optional deserialized event window into the protocol's `RateLimitWindow` shape. It is a straightforward field rename and copy.

**Data flow**: If the input `Option<&RateLimitEventWindow>` is `None`, it returns `None`. Otherwise it copies `used_percent`, `window_minutes`, and `reset_at` into a new `RateLimitWindow`, renaming `reset_at` to `resets_at`.

**Call relations**: This helper is only used by `parse_rate_limit_event` to keep event-to-protocol mapping concise.

*Call graph*: called by 1 (parse_rate_limit_event).


##### `parse_promo_message`  (lines 177–182)

```
fn parse_promo_message(headers: &HeaderMap) -> Option<String>
```

**Purpose**: Extracts the optional Codex promo message header as a trimmed owned string. Empty or whitespace-only values are discarded.

**Data flow**: Reads `x-codex-promo-message` via `parse_header_str`, trims the resulting `&str`, filters out empty strings, converts the remainder to `String`, and returns it as `Option<String>`.

**Call relations**: This is an independent header helper for callers that want promotional messaging alongside rate-limit metadata.

*Call graph*: calls 1 internal fn (parse_header_str).


##### `parse_rate_limit_reached_type`  (lines 184–189)

```
fn parse_rate_limit_reached_type(headers: &HeaderMap) -> Option<RateLimitReachedType>
```

**Purpose**: Parses the server's `x-codex-rate-limit-reached-type` header into the protocol enum `RateLimitReachedType`. Invalid or missing values are ignored.

**Data flow**: Reads the header string with `parse_header_str`, trims it, attempts `.parse()` into `RateLimitReachedType`, and returns `Some(enum)` on success or `None` on any failure.

**Call relations**: This helper is available to response-processing code that needs to classify why a rate limit was reached, separate from the broader snapshot parsing path.

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

**Purpose**: Parses one primary or secondary rate-limit window from three related headers and suppresses empty all-zero windows. It requires a valid `used_percent` header to consider the window present at all.

**Data flow**: Reads `used_percent` with `parse_header_f64`; if absent or invalid, returns `None`. Otherwise it reads optional `window_minutes` and `resets_at` with integer parsers, computes `has_data` as true when `used_percent != 0.0`, `window_minutes` is nonzero, or `resets_at` exists, and returns `Some(RateLimitWindow)` only when that predicate holds.

**Call relations**: This is called twice by `parse_rate_limit_for_limit`, once for the primary header trio and once for the secondary trio.

*Call graph*: calls 1 internal fn (parse_header_f64); called by 1 (parse_rate_limit_for_limit).


##### `parse_credits_snapshot`  (lines 215–227)

```
fn parse_credits_snapshot(headers: &HeaderMap) -> Option<CreditsSnapshot>
```

**Purpose**: Parses the fixed Codex credits header set into a `CreditsSnapshot`. It only succeeds when both required booleans are present and valid.

**Data flow**: Reads `x-codex-credits-has-credits` and `x-codex-credits-unlimited` via `parse_header_bool`; if either is missing or malformed, returns `None`. It then reads optional `x-codex-credits-balance` via `parse_header_str`, trims and filters empties, and returns `Some(CreditsSnapshot { has_credits, unlimited, balance })`.

**Call relations**: This helper is used by `parse_rate_limit_for_limit` to attach account-credit information to every parsed snapshot.

*Call graph*: calls 2 internal fn (parse_header_bool, parse_header_str); called by 1 (parse_rate_limit_for_limit).


##### `parse_header_f64`  (lines 229–234)

```
fn parse_header_f64(headers: &HeaderMap, name: &str) -> Option<f64>
```

**Purpose**: Reads a header as a finite floating-point number. NaN and infinities are explicitly rejected.

**Data flow**: Fetches the raw string with `parse_header_str`, parses it as `f64`, and filters the result with `is_finite()`. It returns `Option<f64>` and writes no state.

**Call relations**: This numeric helper is used by `parse_rate_limit_window` for percentage fields.

*Call graph*: calls 1 internal fn (parse_header_str); called by 1 (parse_rate_limit_window).


##### `parse_header_i64`  (lines 236–238)

```
fn parse_header_i64(headers: &HeaderMap, name: &str) -> Option<i64>
```

**Purpose**: Reads a header as a signed 64-bit integer. Invalid or missing values become `None`.

**Data flow**: Fetches the raw string with `parse_header_str`, parses it with `parse::<i64>()`, and returns the parsed integer on success.

**Call relations**: This helper supports `parse_rate_limit_window` when reading minute counts and reset timestamps.

*Call graph*: calls 1 internal fn (parse_header_str).


##### `parse_header_bool`  (lines 240–249)

```
fn parse_header_bool(headers: &HeaderMap, name: &str) -> Option<bool>
```

**Purpose**: Reads a header as a boolean using a permissive textual convention. It accepts `true`/`false` case-insensitively and `1`/`0` numerically.

**Data flow**: Gets the raw string via `parse_header_str`, compares it against accepted true and false spellings, and returns `Some(true)`, `Some(false)`, or `None` for any other token.

**Call relations**: This helper is used by `parse_credits_snapshot` for the credits flags.

*Call graph*: calls 1 internal fn (parse_header_str); called by 1 (parse_credits_snapshot).


##### `parse_header_str`  (lines 251–253)

```
fn parse_header_str(headers: &'a HeaderMap, name: &str) -> Option<&'a str>
```

**Purpose**: Fetches a header value by name and converts it to UTF-8 text. It is the common primitive for all header parsing in this file.

**Data flow**: Looks up `name` in the borrowed `HeaderMap` with `get`, then calls `to_str()` on the header value. It returns `Option<&str>` tied to the header map's lifetime.

**Call relations**: Most parsing helpers in this file build on this function so malformed or non-UTF8 headers are uniformly treated as absent.

*Call graph*: called by 7 (parse_credits_snapshot, parse_header_bool, parse_header_f64, parse_header_i64, parse_promo_message, parse_rate_limit_for_limit, parse_rate_limit_reached_type); 1 external calls (get).


##### `has_rate_limit_data`  (lines 255–257)

```
fn has_rate_limit_data(snapshot: &RateLimitSnapshot) -> bool
```

**Purpose**: Checks whether a parsed snapshot contains any substantive rate-limit information. It treats windows or credits as meaningful data and ignores empty shells.

**Data flow**: Reads `snapshot.primary`, `snapshot.secondary`, and `snapshot.credits` and returns true if any of them are `Some`.

**Call relations**: This predicate is used by `parse_all_rate_limits` to avoid emitting discovered non-default limit families that parsed into entirely empty snapshots.


##### `header_name_to_limit_id`  (lines 259–264)

```
fn header_name_to_limit_id(header_name: &str) -> Option<String>
```

**Purpose**: Infers a logical limit id from a header name by recognizing the `-primary-used-percent` suffix pattern. It converts the wire-format header family back into the normalized internal identifier.

**Data flow**: Strips the suffix `-primary-used-percent`, then strips the leading `x-`; if either step fails it returns `None`. The remaining family name is passed to `normalize_limit_id`, and the normalized string is returned.

**Call relations**: This discovery helper is used while scanning all response headers in `parse_all_rate_limits`.

*Call graph*: calls 1 internal fn (normalize_limit_id); called by 1 (parse_all_rate_limits).


##### `normalize_limit_id`  (lines 266–268)

```
fn normalize_limit_id(name: impl Into<String>) -> String
```

**Purpose**: Canonicalizes a limit identifier into the internal underscore-separated lowercase form. It accepts either owned or borrowed string-like input.

**Data flow**: Consumes `name` via `Into<String>`, trims surrounding whitespace, lowercases ASCII characters, replaces `-` with `_`, and returns the normalized `String`.

**Call relations**: Both header-family discovery and snapshot assembly rely on this helper so limit ids are stable regardless of whether they originated from headers, event payloads, or caller input.

*Call graph*: called by 2 (header_name_to_limit_id, parse_rate_limit_for_limit); 1 external calls (into).


##### `tests::parse_rate_limit_for_limit_defaults_to_codex_headers`  (lines 277–299)

```
fn parse_rate_limit_for_limit_defaults_to_codex_headers()
```

**Purpose**: Checks that omitting a limit id reads the legacy `x-codex-*` headers and produces a `codex` snapshot with a populated primary window. It verifies the default-family fallback.

**Data flow**: Constructs a `HeaderMap` with primary Codex headers, calls `parse_rate_limit_for_limit(&headers, None)`, unwraps the snapshot, and asserts the expected limit id and window fields.

**Call relations**: This test directly exercises the main parser's defaulting behavior rather than going through the multi-family scanner.

*Call graph*: calls 1 internal fn (parse_rate_limit_for_limit); 3 external calls (new, from_static, assert_eq!).


##### `tests::parse_rate_limit_for_limit_reads_secondary_headers`  (lines 302–326)

```
fn parse_rate_limit_for_limit_reads_secondary_headers()
```

**Purpose**: Verifies that a named limit id such as `codex_secondary` maps to the corresponding hyphenated header family and parses its primary window correctly. It also confirms that absent secondary-window headers remain `None`.

**Data flow**: Builds headers under `x-codex-secondary-*`, calls `parse_rate_limit_for_limit` with `Some("codex_secondary")`, and asserts the normalized limit id plus parsed numeric fields.

**Call relations**: This test covers the underscore-to-hyphen normalization path inside `parse_rate_limit_for_limit`.

*Call graph*: calls 1 internal fn (parse_rate_limit_for_limit); 3 external calls (new, from_static, assert_eq!).


##### `tests::parse_rate_limit_for_limit_prefers_limit_name_header`  (lines 329–344)

```
fn parse_rate_limit_for_limit_prefers_limit_name_header()
```

**Purpose**: Ensures that the optional `x-<limit>-limit-name` header is surfaced as `snapshot.limit_name`. This distinguishes the stable metered limit id from a human-readable model/limit label.

**Data flow**: Creates headers for a named limit family plus a `limit-name` header, parses them with `parse_rate_limit_for_limit`, and asserts both `limit_id` and `limit_name`.

**Call relations**: This test documents the parser's support for carrying through server-provided display names.

*Call graph*: calls 1 internal fn (parse_rate_limit_for_limit); 3 external calls (new, from_static, assert_eq!).


##### `tests::parse_all_rate_limits_reads_all_limit_families`  (lines 347–364)

```
fn parse_all_rate_limits_reads_all_limit_families()
```

**Purpose**: Checks that scanning all headers yields both the default Codex snapshot and an additional discovered named limit family. It validates family discovery from header names.

**Data flow**: Creates a header map containing one default-family and one secondary-family `primary-used-percent` header, calls `parse_all_rate_limits`, and asserts the vector length and ordered limit ids.

**Call relations**: This test exercises the full multi-family collection path, including `header_name_to_limit_id` and the stable ordering from `BTreeSet`.

*Call graph*: calls 1 internal fn (parse_all_rate_limits); 3 external calls (new, from_static, assert_eq!).


##### `tests::parse_all_rate_limits_includes_default_codex_snapshot`  (lines 367–377)

```
fn parse_all_rate_limits_includes_default_codex_snapshot()
```

**Purpose**: Verifies that `parse_all_rate_limits` always returns a default `codex` snapshot even when no rate-limit headers are present. This is an intentional API contract for downstream consumers.

**Data flow**: Passes an empty `HeaderMap` to `parse_all_rate_limits` and asserts that the returned vector contains exactly one snapshot with `codex` as the limit id and no populated windows or credits.

**Call relations**: This test captures the special-case behavior that distinguishes the default family from discovered non-default families.

*Call graph*: calls 1 internal fn (parse_all_rate_limits); 2 external calls (new, assert_eq!).


### `core/src/unified_exec/async_watcher.rs`

`io_transport` · `background process streaming and process-exit handling`

This file is the asynchronous output/exit plumbing for unified exec sessions. `start_streaming_output` clones the process’s broadcast receiver, cancellation token, and output-drained notifier, then spawns a Tokio task that loops over three conditions with `tokio::select!`: process cancellation starts a short trailing-output grace timer, grace expiry notifies that output is drained and exits, and incoming output chunks are consumed from the receiver. Lagged broadcast messages are silently skipped; a closed channel ends the task after notifying waiters.

Each received byte chunk is passed to `process_chunk`, which appends it to a `pending` byte buffer, repeatedly extracts the largest valid UTF-8 prefix up to `UNIFIED_EXEC_OUTPUT_DELTA_MAX_BYTES`, appends that prefix into the shared `HeadTailBuffer` transcript, and emits `EventMsg::ExecCommandOutputDelta` events until `MAX_EXEC_OUTPUT_DELTAS_PER_CALL` is reached. Even after the event cap, transcript retention continues so the final aggregated output remains complete within the head/tail truncation policy.

`spawn_exit_watcher` waits first for process cancellation and then for the streaming task’s drained notification before computing elapsed duration and emitting exactly one terminal tool event. Success uses `emit_exec_end_for_unified_exec`, which resolves transcript bytes or falls back to supplied text and packages them into `ExecToolCallOutput` with stdout and aggregated output identical and empty stderr. Failure uses `emit_failed_exec_end_for_unified_exec`, which prefers explicit fallback stdout when present, otherwise transcript output, and appends the failure message into `aggregated_output` while placing the message in stderr with exit code `-1`. The UTF-8 helpers are deliberately progress-guaranteed: if no valid prefix exists, they emit one raw byte so malformed streams cannot stall forever.

#### Function details

##### `start_streaming_output`  (lines 40–102)

```
fn start_streaming_output(
    process: &UnifiedExecProcess,
    context: &UnifiedExecContext,
    transcript: Arc<Mutex<HeadTailBuffer>>,
)
```

**Purpose**: Starts the background reader that consumes PTY output, updates the retained transcript, and emits incremental output-delta events. It also enforces a short grace period after process cancellation so trailing bytes can still be captured before the stream is declared drained.

**Data flow**: Takes a `UnifiedExecProcess`, `UnifiedExecContext`, and shared `Arc<Mutex<HeadTailBuffer>>`. It reads the process output receiver, drained notifier, and cancellation token; clones session, turn, and call id into a spawned async task; maintains mutable `pending` bytes, `emitted_deltas` count, and optional `Sleep`. Incoming `Vec<u8>` chunks are forwarded into `process_chunk`; on receiver close or grace expiry it notifies `output_drained` and exits without returning a value.

**Call relations**: It is invoked by `exec_command` when a unified exec process is started and needs live output streaming. Inside its spawned loop it delegates chunk decoding and event emission to `process_chunk`, while coordinating with `spawn_exit_watcher` through the shared `output_drained_notify` signal so the final end event waits until output flushing is complete.

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

**Purpose**: Launches the companion task that waits for process termination and then emits the single terminal success or failure tool event for unified exec. It ensures final output is emitted only after the streaming task has drained trailing bytes.

**Data flow**: Consumes an `Arc<UnifiedExecProcess>`, session and turn references, call metadata (`call_id`, `command`, `cwd`, `process_id`), the shared transcript, and the process `started_at` instant. In the spawned task it awaits `exit_token.cancelled()` and then `output_drained.notified()`, computes elapsed `Duration`, inspects `process.failure_message()` and `process.exit_code()`, and calls either `emit_failed_exec_end_for_unified_exec` or `emit_exec_end_for_unified_exec` with the assembled fields.

**Call relations**: This watcher is started by `store_process` after a process has been registered. It sits downstream of `start_streaming_output`: only once cancellation has happened and the streamer has signaled drained output does it delegate to one of the terminal emitters.

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

**Purpose**: Consumes raw output bytes, splits them into UTF-8-safe event chunks, appends each emitted prefix to the transcript, and sends `ExecCommandOutputDelta` events until the per-call event cap is reached. It preserves all bytes in the transcript even when event emission is throttled.

**Data flow**: Receives mutable `pending` bytes and `emitted_deltas`, shared transcript/session/turn references, the `call_id`, and a newly received `chunk: Vec<u8>`. It extends `pending`, repeatedly calls `split_valid_utf8_prefix`, locks the transcript to `push_chunk(prefix.to_vec())`, conditionally constructs `ExecCommandOutputDeltaEvent { call_id, stream: Stdout, chunk: prefix }`, sends it through `session_ref.send_event(...)`, and increments `emitted_deltas`. It returns `()` after draining all currently splittable prefixes.

**Call relations**: It is called only from the streaming loop in `start_streaming_output` for each received output chunk. It delegates UTF-8 boundary detection to `split_valid_utf8_prefix` and performs the actual event emission that downstream clients observe.

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

**Purpose**: Builds and emits the successful terminal tool event for a unified exec process using the retained transcript as the primary aggregated output. It packages command metadata, cwd, process id, duration, and stdout into the standard tool-event shape.

**Data flow**: Takes owned session/turn Arcs, call metadata, transcript, fallback output text, exit code, and duration. It awaits `resolve_aggregated_output`, constructs `ExecToolCallOutput` with `stdout` and `aggregated_output` both set to that text and empty stderr, creates a `ToolEventCtx`, creates a unified-exec `ToolEmitter`, and asynchronously emits `ToolEventStage::Success { output, applied_patch_delta: None }`.

**Call relations**: It is called by `spawn_exit_watcher` for normal process completion and also directly by `exec_command` in paths that need to synthesize a final event without the watcher. It depends on `resolve_aggregated_output` to choose transcript bytes over fallback text and then hands off delivery to `ToolEmitter`.

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

**Purpose**: Builds and emits the failure terminal tool event for a unified exec process, combining any captured stdout with a failure message. It standardizes failed-process reporting with exit code `-1` and stderr populated from the message.

**Data flow**: Consumes session/turn Arcs, call metadata, transcript, fallback output, failure `message`, and duration. It chooses `stdout` as `fallback_output` when non-empty, otherwise awaits `resolve_aggregated_output`; computes `aggregated_output` as either the message alone or `"{stdout}\n{message}"`; constructs `ExecToolCallOutput` with stderr set to the message and exit code `-1`; creates `ToolEventCtx` and a unified-exec `ToolEmitter`; and emits `ToolEventStage::Failure(ToolEventFailure::Output(output))`.

**Call relations**: It is used by `spawn_exit_watcher` when the process exposes a failure message and by `emit_failed_initial_exec_end_if_unstored` for startup-failure paths. It mirrors the success emitter but adjusts output composition and stage type for failure semantics.

*Call graph*: calls 4 internal fn (unified_exec, new, resolve_aggregated_output, new); called by 2 (spawn_exit_watcher, emit_failed_initial_exec_end_if_unstored); 3 external calls (Output, Failure, format!).


##### `split_valid_utf8_prefix`  (lines 290–292)

```
fn split_valid_utf8_prefix(buffer: &mut Vec<u8>) -> Option<Vec<u8>>
```

**Purpose**: Provides the default UTF-8-safe chunk splitter using the module’s fixed maximum delta size. It is a thin wrapper that centralizes the production byte limit.

**Data flow**: Accepts a mutable byte `buffer`, forwards it to `split_valid_utf8_prefix_with_max` with `UNIFIED_EXEC_OUTPUT_DELTA_MAX_BYTES`, and returns the resulting optional prefix while mutating the original buffer by draining emitted bytes.

**Call relations**: It is called by `process_chunk` on the pending output buffer. The wrapper exists so production code uses the standard max size while tests can target the configurable helper directly.

*Call graph*: calls 1 internal fn (split_valid_utf8_prefix_with_max); called by 1 (process_chunk).


##### `split_valid_utf8_prefix_with_max`  (lines 294–318)

```
fn split_valid_utf8_prefix_with_max(buffer: &mut Vec<u8>, max_bytes: usize) -> Option<Vec<u8>>
```

**Purpose**: Extracts the largest prefix from a byte buffer that is valid UTF-8 and no larger than a caller-specified maximum, while guaranteeing forward progress on malformed input. This prevents downstream event consumers from receiving oversized or codepoint-splitting chunks.

**Data flow**: Takes `&mut Vec<u8>` and `max_bytes`. If the buffer is empty it returns `None`. Otherwise it scans backward from `min(buffer.len(), max_bytes)` until `std::str::from_utf8(&buffer[..split])` succeeds, allowing at most four bytes of backoff to avoid splitting a multibyte codepoint; on success it clones that prefix, drains it from the buffer, and returns `Some(prefix)`. If no valid prefix is found, it drains and returns the first byte as a one-byte chunk.

**Call relations**: This helper is called by `split_valid_utf8_prefix`, which is in turn used by `process_chunk`. Its behavior is validated by `async_watcher_tests.rs`, especially the ASCII limit, multibyte UTF-8 boundary, and invalid-byte progress cases.

*Call graph*: called by 1 (split_valid_utf8_prefix); 1 external calls (from_utf8).


##### `resolve_aggregated_output`  (lines 320–330)

```
async fn resolve_aggregated_output(
    transcript: &Arc<Mutex<HeadTailBuffer>>,
    fallback: String,
) -> String
```

**Purpose**: Converts the retained transcript into a lossy UTF-8 string, falling back to caller-provided text when the transcript is empty. It is the final source-selection step for terminal exec events.

**Data flow**: Locks the shared `HeadTailBuffer`, checks `retained_bytes()`, and if zero returns the provided `fallback` string unchanged. Otherwise it obtains `guard.to_bytes()`, converts with `String::from_utf8_lossy`, and returns the resulting owned `String`.

**Call relations**: It is called by both `emit_exec_end_for_unified_exec` and `emit_failed_exec_end_for_unified_exec` to populate final stdout and aggregated output. It isolates transcript reading and fallback behavior from the event-emission code.

*Call graph*: called by 2 (emit_exec_end_for_unified_exec, emit_failed_exec_end_for_unified_exec); 1 external calls (from_utf8_lossy).


### `exec/src/event_processor_with_human_output.rs`

`domain_logic` · `request handling and shutdown rendering`

This file contains the stderr-oriented renderer used for interactive human output. `EventProcessorWithHumanOutput` stores precomputed `owo_colors::Style` values, booleans controlling whether reasoning summaries or raw reasoning should be shown, an optional `last_message_path`, and mutable run state: the latest final message, whether that message has already been rendered during streaming, whether shutdown should emit/persist it, and the latest aggregate token usage. `create_with_ansi` builds the renderer from config, selecting styled or plain `Style` values depending on terminal color policy.

Rendering is split between `render_item_started` and `render_item_completed`, which pattern-match `ThreadItem` variants and print concrete summaries for command execution, MCP calls, web search, patch application, collaboration tools, reasoning, and agent messages. The `EventProcessor` implementation handles higher-level `ServerNotification` variants: warnings/errors/deprecations, hook lifecycle, model reroutes, token usage updates, turn plans, diffs, and especially `TurnCompleted`. On successful turn completion it recovers the final message from turn items if available, preserving whether it was already streamed; on failed or interrupted turns it clears stale final-message state and suppresses last-message-file output. `print_final_output` then writes the last message file when appropriate, prints token totals using a blended non-cached-input-plus-output calculation, and decides whether to print the final message to stdout or stderr based on terminal detection and whether it was already rendered. Helper functions encapsulate config-summary assembly, reasoning text selection, final-message extraction, token blending, and the stdout/TTY emission predicates.

#### Function details

##### `EventProcessorWithHumanOutput::create_with_ansi`  (lines 42–65)

```
fn create_with_ansi(
        with_ansi: bool,
        config: &Config,
        last_message_path: Option<PathBuf>,
    ) -> Self
```

**Purpose**: Constructs a human-output processor with either ANSI-styled or plain text styles and initializes all runtime state from config. It also derives reasoning-visibility flags from the loaded configuration.

**Data flow**: It takes `with_ansi`, a `&Config`, and an optional `PathBuf` for the last-message file; builds styled or plain `Style` values via `Style::new()`, reads `config.hide_agent_reasoning` and `config.show_raw_agent_reasoning`, stores the provided path, and returns a fully initialized `EventProcessorWithHumanOutput` with empty final-message and token-usage state.

**Call relations**: This constructor is called by session-running orchestration before notifications begin flowing. It does not delegate to other local helpers beyond inline style selection.

*Call graph*: called by 1 (run_exec_session); 1 external calls (new).


##### `EventProcessorWithHumanOutput::render_item_started`  (lines 67–96)

```
fn render_item_started(&self, item: &ThreadItem)
```

**Purpose**: Prints a concise human-readable line when a long-running thread item begins. It covers command execution, MCP tool calls, web searches, patch application, and collaboration tool calls.

**Data flow**: It reads a borrowed `ThreadItem`, pattern-matches its variant, formats variant-specific fields such as command text, cwd, MCP server/tool names, or search query, and writes the rendered line(s) to stderr. It does not mutate processor state.

**Call relations**: This helper is invoked from `process_server_notification` only for `ServerNotification::ItemStarted`. It exists to keep start-of-item formatting separate from completion formatting.

*Call graph*: called by 1 (process_server_notification); 1 external calls (eprintln!).


##### `EventProcessorWithHumanOutput::render_item_completed`  (lines 98–208)

```
fn render_item_completed(&mut self, item: ThreadItem)
```

**Purpose**: Prints the completed form of a thread item and updates final-message state when the item is an agent message. It also conditionally emits reasoning text and detailed command/MCP/patch output.

**Data flow**: It takes ownership of a `ThreadItem`, matches on its variant, and writes formatted output to stderr. For `AgentMessage` it stores `text` into `self.final_message` and marks `self.final_message_rendered = true`; for `Reasoning` it calls `reasoning_text` using `self.show_agent_reasoning` and `self.show_raw_agent_reasoning`; for command execution it formats status, duration, exit code, and optional aggregated output; for file changes and MCP calls it prints status plus paths or errors. Other variants either print a short summary or are ignored.

**Call relations**: This helper is called from `process_server_notification` for `ServerNotification::ItemCompleted`. It delegates reasoning selection to `reasoning_text` and is the main place where streamed agent output becomes the tracked final message.

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

**Purpose**: Prints the startup banner, effective configuration summary, and initial user prompt for a human-facing exec session. It exposes the resolved model/provider/approval/sandbox/session settings before work begins.

**Data flow**: It reads `&Config`, the prompt string, and `&SessionConfiguredEvent`, obtains the package version via `env!("CARGO_PKG_VERSION")`, calls `config_summary_entries` to build key/value rows, and writes the banner, rows, separators, and prompt to stderr.

**Call relations**: This method is invoked through the `EventProcessor` trait at session startup. It delegates summary assembly to `config_summary_entries` so formatting and data selection remain separate.

*Call graph*: calls 1 internal fn (config_summary_entries); 2 external calls (env!, eprintln!).


##### `EventProcessorWithHumanOutput::process_server_notification`  (lines 227–367)

```
fn process_server_notification(&mut self, notification: ServerNotification) -> CodexStatus
```

**Purpose**: Consumes one typed server notification, renders the corresponding human output, updates internal final-message/token state, and tells the caller whether to continue or shut down. It is the central notification dispatcher for the human backend.

**Data flow**: It takes ownership of a `ServerNotification`, pattern-matches every relevant variant, prints warnings/errors/deprecations/hooks/model reroutes/diffs/plans to stderr, updates `self.last_total_token_usage` on token-usage notifications, delegates item rendering to `render_item_started` or `render_item_completed`, and on `TurnCompleted` updates or clears `self.final_message`, `self.final_message_rendered`, and `self.emit_final_message_on_shutdown` based on `TurnStatus`. It returns `CodexStatus::Running` for ongoing work or `CodexStatus::InitiateShutdown` when a turn completes, fails, or is interrupted.

**Call relations**: This method is called repeatedly by the exec session loop through the `EventProcessor` trait. It delegates warning formatting to `process_warning`, item formatting to the render helpers, and successful-turn final-message recovery to `final_message_from_turn_items`.

*Call graph*: calls 4 internal fn (process_warning, render_item_completed, render_item_started, final_message_from_turn_items); 1 external calls (eprintln!).


##### `EventProcessorWithHumanOutput::process_warning`  (lines 369–375)

```
fn process_warning(&mut self, message: String) -> CodexStatus
```

**Purpose**: Renders a local non-protocol warning in the same style as server warnings. It keeps warning presentation consistent regardless of source.

**Data flow**: It takes a warning `String`, prints it to stderr with yellow bold `warning:` prefix styling, and returns `CodexStatus::Running` without mutating other state.

**Call relations**: This is called from `process_server_notification` for `ServerNotification::Warning` and may also be invoked directly by orchestration code for local warnings outside the app-server protocol.

*Call graph*: called by 1 (process_server_notification); 1 external calls (eprintln!).


##### `EventProcessorWithHumanOutput::print_final_output`  (lines 377–417)

```
fn print_final_output(&mut self)
```

**Purpose**: Performs shutdown-time output: optionally writes the last message file, prints token totals, and emits the final message to stdout or stderr depending on terminal conditions and whether it was already streamed. It is the backend’s finalization step.

**Data flow**: It reads `self.emit_final_message_on_shutdown`, `self.last_message_path`, `self.final_message`, `self.final_message_rendered`, and `self.last_total_token_usage`. If configured, it calls `handle_last_message`; if usage exists, it prints a formatted token total using `blended_total` and `format_with_separators`; it then queries `stdout().is_terminal()` and `stderr().is_terminal()`, uses `should_print_final_message_to_stdout` and `should_print_final_message_to_tty` to choose an output stream, and prints the final message accordingly.

**Call relations**: This method is invoked through the `EventProcessor` trait during shutdown. It delegates file-writing semantics to `handle_last_message` and stream-selection policy to the two predicate helpers.

*Call graph*: calls 3 internal fn (handle_last_message, should_print_final_message_to_stdout, should_print_final_message_to_tty); 4 external calls (eprintln!, println!, stderr, stdout).


##### `config_summary_entries`  (lines 420–467)

```
fn config_summary_entries(
    config: &Config,
    session_configured_event: &SessionConfiguredEvent,
) -> Vec<(&'static str, String)>
```

**Purpose**: Builds the ordered list of key/value rows shown in the human config summary. It combines runtime config, session metadata, and sandbox summarization into display-ready strings.

**Data flow**: It reads `Config` fields such as `cwd`, permissions, workspace roots, provider wire API, reasoning settings, and the `SessionConfiguredEvent` model/provider/session id. It constructs a `Vec<(&'static str, String)>` containing workdir, model, provider, approval, sandbox, and session id, and conditionally inserts reasoning-effort and reasoning-summaries rows when the provider wire API is `WireApi::Responses`.

**Call relations**: This helper is called only by `print_config_summary`. It encapsulates the data-selection rules so the printing method only handles formatting.

*Call graph*: called by 1 (print_config_summary); 1 external calls (vec!).


##### `reasoning_text`  (lines 469–484)

```
fn reasoning_text(
    summary: &[String],
    content: &[String],
    show_raw_agent_reasoning: bool,
) -> Option<String>
```

**Purpose**: Chooses which reasoning text to display for a reasoning item: raw content when enabled and present, otherwise the summary. It suppresses output entirely when the chosen list is empty.

**Data flow**: It takes slices of summary strings and content strings plus a `show_raw_agent_reasoning` flag, selects either `content` or `summary`, and returns `None` if the selected slice is empty or `Some(entries.join("\n"))` otherwise.

**Call relations**: This helper is used by `render_item_completed` when processing `ThreadItem::Reasoning`. It isolates the policy for raw-vs-summary reasoning display.

*Call graph*: called by 1 (render_item_completed).


##### `final_message_from_turn_items`  (lines 486–500)

```
fn final_message_from_turn_items(items: &[ThreadItem]) -> Option<String>
```

**Purpose**: Extracts the best final textual answer from a completed turn’s items. It prefers the latest agent message and falls back to the latest plan if no agent message exists.

**Data flow**: It iterates the `ThreadItem` slice in reverse, first searching for `ThreadItem::AgentMessage` and cloning its `text`; if none is found, it performs a second reverse search for `ThreadItem::Plan` and clones that `text`; otherwise it returns `None`.

**Call relations**: This helper is called from `process_server_notification` when a turn completes successfully. It lets the processor recover a final answer even if streaming state is stale or incomplete.

*Call graph*: called by 1 (process_server_notification); 1 external calls (iter).


##### `blended_total`  (lines 502–506)

```
fn blended_total(usage: &ThreadTokenUsage) -> i64
```

**Purpose**: Computes the token total shown to humans by excluding cached input tokens from billable input and adding output tokens. Negative counters are clamped away.

**Data flow**: It reads `usage.total.cached_input_tokens`, `input_tokens`, and `output_tokens`, clamps cached input to at least zero, subtracts cached input from total input and clamps that result to zero, adds non-cached input and non-negative output, and returns the final `i64` total.

**Call relations**: This pure helper is used by `print_final_output` before formatting token usage. It does not interact with other state.


##### `should_print_final_message_to_stdout`  (lines 508–514)

```
fn should_print_final_message_to_stdout(
    final_message: Option<&str>,
    stdout_is_terminal: bool,
    stderr_is_terminal: bool,
) -> bool
```

**Purpose**: Determines whether the final message should be printed to stdout instead of stderr. The rule is to print when a final message exists and at least one of stdout/stderr is not a terminal.

**Data flow**: It takes `Option<&str>` plus two terminal booleans and returns `true` only if `final_message.is_some()` and not both streams are terminals.

**Call relations**: This predicate is called by `print_final_output` as part of shutdown stream selection. It keeps the stream-choice logic testable and explicit.

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

**Purpose**: Determines whether the final message should be echoed to the terminal on stderr at shutdown. It only does so when a final message exists, it was not already rendered, and both stdout and stderr are terminals.

**Data flow**: It takes the optional final message, a `final_message_rendered` flag, and terminal booleans for stdout/stderr, and returns the conjunction of those conditions.

**Call relations**: This helper is the fallback branch used by `print_final_output` when stdout emission is not appropriate. It prevents duplicate final-message rendering in interactive sessions.

*Call graph*: called by 1 (print_final_output).


### `ollama/src/parser.rs`

`domain_logic` · `stream event decoding during model pulls`

This module contains the semantic decoder that sits between raw JSON objects and the pull-progress reporting layer. Its single production function, `pull_events_from_value`, accepts a `serde_json::Value` representing one NDJSON object from Ollama's `/api/pull` stream and emits a `Vec<PullEvent>` because one input object can correspond to multiple logical events. If the object contains a string `status`, the function always emits `PullEvent::Status(status.to_string())`; if that status is exactly `"success"`, it additionally emits `PullEvent::Success`. Separately, it reads `digest` as an optional string, defaulting to the empty string when absent, and reads `total` and `completed` as optional `u64` values. If either numeric field is present, it emits a `PullEvent::ChunkProgress { digest, total, completed }`.

The design intentionally allows status and progress information from the same JSON object to produce multiple events in order, preserving both human-readable state transitions and byte-level progress updates. It does not interpret embedded `error` fields; that remains the responsibility of the streaming client loop, which can terminate the stream immediately. The tests validate the two main decoding shapes: plain status plus synthetic success, and partial progress updates where only one of `total` or `completed` is present.

#### Function details

##### `pull_events_from_value`  (lines 6–29)

```
fn pull_events_from_value(value: &JsonValue) -> Vec<PullEvent>
```

**Purpose**: Converts one JSON pull-update object into the corresponding sequence of `PullEvent` values. It preserves both textual status and numeric layer-progress information when present.

**Data flow**: Reads fields from `value: &JsonValue`: `status` as `&str`, `digest` as `&str` defaulting to `""`, and `total`/`completed` as optional `u64`. It builds a `Vec<PullEvent>`, pushing `PullEvent::Status` when `status` exists, additionally pushing `PullEvent::Success` when `status == "success"`, and pushing `PullEvent::ChunkProgress { digest, total, completed }` when either numeric field is present. It returns the accumulated vector without mutating external state.

**Call relations**: This decoder is called by the streaming pull loop in `OllamaClient::pull_model_stream`, which handles transport framing and stream termination. The tests in this file invoke it directly to validate event-shape semantics independently of HTTP streaming.

*Call graph*: called by 2 (test_pull_events_decoder_progress, test_pull_events_decoder_status_and_success); 3 external calls (get, new, Status).


##### `tests::test_pull_events_decoder_status_and_success`  (lines 38–48)

```
fn test_pull_events_decoder_status_and_success()
```

**Purpose**: Checks that ordinary status messages decode to a single `Status` event and that the special `success` status produces both `Status` and `Success`. This pins down the multi-event behavior for terminal success objects.

**Data flow**: Builds two JSON values with `serde_json::json!`, passes each to `pull_events_from_value`, and asserts the resulting vectors have the expected lengths and event variants using `assert_matches!` and `assert_eq!`.

**Call relations**: This test isolates the status-decoding branch of `pull_events_from_value` from any streaming or buffering concerns.

*Call graph*: calls 1 internal fn (pull_events_from_value); 3 external calls (assert_eq!, assert_matches!, json!).


##### `tests::test_pull_events_decoder_progress`  (lines 51–74)

```
fn test_pull_events_decoder_progress()
```

**Purpose**: Verifies that progress objects decode into `ChunkProgress` even when only `total` or only `completed` is present. It also checks that the digest string is preserved.

**Data flow**: Constructs two JSON values, one with `digest` and `total`, the other with `digest` and `completed`, feeds them into `pull_events_from_value`, and asserts each result is a single `PullEvent::ChunkProgress` with the expected optional fields.

**Call relations**: This test covers the numeric-progress branch of the decoder and complements the status-focused test above.

*Call graph*: calls 1 internal fn (pull_events_from_value); 3 external calls (assert_eq!, assert_matches!, json!).
