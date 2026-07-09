# TUI text layout, wrapping, and text-rendering primitives  `stage-22.2.3`

This stage is cross-cutting rendering infrastructure for the TUI’s main drawing path. It sits underneath higher-level widgets and views, turning styled text, markdown, ANSI output, and diff content into terminal-width-aware rows that can be measured, wrapped, truncated, scrolled, and finally emitted without breaking styling or hyperlinks.

At the geometry layer, tui/src/render/mod.rs supplies Insets and safe rectangle-shrinking helpers, while tui/src/render/line_utils.rs standardizes line ownership conversion and prefix composition used by many renderers. tui/src/width.rs adds guard checks so wrapping code can bail out when prefixes leave no usable columns. ansi-escape/src/lib.rs converts ANSI-colored strings into ratatui text with project-specific tab handling. tui/src/line_truncation.rs measures and cuts Line values at display-cell boundaries without losing style or alignment.

For richer text, tui/src/markdown_text_merge.rs coalesces fragmented markdown text events so visible runs such as URLs stay recognizable. tui/src/terminal_hyperlinks.rs then tracks hyperlinks separately from visible text and cooperates with tui/src/wrapping.rs, whose standard and hyperlink-preserving wrappers produce layout-safe lines and byte-range mappings. tui/src/live_wrap.rs supports incremental streamed wrapping, and cloud-tasks/src/scrollable_diff.rs builds on these primitives to provide cached, width-aware, vertically scrollable wrapped diff views.

## Files in this stage

### Shared render geometry
These small primitives define common rectangle and line composition helpers that other text-layout code builds on.

### `tui/src/render/mod.rs`

`util` · `cross-cutting`

This module is the lightweight root of the rendering subsystem. Beyond declaring the `highlight`, `line_utils`, and `renderable` submodules, it defines a compact `Insets` value type and a `RectExt` extension trait implemented for ratatui's `Rect`.

`Insets` stores four unsigned margins—`left`, `top`, `right`, and `bottom`—and offers two constructors tailored to common layout patterns. `Insets::tlbr` accepts explicit top/left/bottom/right values, while `Insets::vh` creates symmetric vertical and horizontal padding by assigning the same `v` to top and bottom and the same `h` to left and right. The fields are private, so these constructors are the intended way to build instances outside the module.

`RectExt::inset` applies an `Insets` to a `Rect` using saturating arithmetic. It computes total horizontal and vertical padding with `saturating_add`, shifts `x` and `y` inward with `saturating_add`, and shrinks `width` and `height` with `saturating_sub`. That means oversized insets never underflow into huge dimensions; instead they collapse the rectangle toward zero size. This behavior is important for terminal layouts where widgets may be asked to render into very small areas and should degrade safely rather than panic or wrap arithmetic.

#### Function details

##### `Insets::tlbr`  (lines 16–23)

```
fn tlbr(top: u16, left: u16, bottom: u16, right: u16) -> Self
```

**Purpose**: Constructs an `Insets` value from explicit top, left, bottom, and right margins.

**Data flow**: It takes four `u16` arguments, assigns them to the corresponding private fields of `Insets`, and returns the new struct.

**Call relations**: This constructor is used throughout rendering code wherever asymmetric padding is needed around a widget or sub-rectangle.

*Call graph*: called by 15 (layout_areas_with_textarea_right_reserve, render_ref, render_ref, render_popup, render_ref, as_renderable, render_ref, from, render_lines, render_markdown_content (+5 more)).


##### `Insets::vh`  (lines 25–32)

```
fn vh(v: u16, h: u16) -> Self
```

**Purpose**: Constructs symmetric insets using one vertical value and one horizontal value.

**Data flow**: It takes `v` and `h`, assigns `top = bottom = v` and `left = right = h`, and returns the resulting `Insets`.

**Call relations**: This constructor is used by renderers that want uniform vertical and horizontal padding without specifying all four sides separately.

*Call graph*: called by 7 (render, render, render, render, menu_surface_inset, render, render_ref).


##### `Rect::inset`  (lines 40–49)

```
fn inset(&self, insets: Insets) -> Rect
```

**Purpose**: Returns a new rectangle reduced by the supplied insets using saturating arithmetic to avoid underflow.

**Data flow**: It takes `&self` and an `Insets`, computes total horizontal and vertical padding, adds left/top to `x` and `y`, subtracts total padding from `width` and `height` with saturation, and returns the new `Rect`.

**Call relations**: This extension method is consumed by inset-aware renderables and layout code whenever a child should render inside padded bounds.


### `tui/src/render/line_utils.rs`

`util` · `cross-cutting`

This file contains a compact set of text-line utilities used by multiple renderers. The main concern is ownership: many ratatui APIs produce borrowed `Line<'_>` values, but downstream rendering pipelines often need owned `Line<'static>` values that can be stored, combined, or returned without lifetime coupling. `line_to_static` performs that conversion by preserving the line's `style` and `alignment` while cloning each `Span`'s style and converting its content into an owned `Cow::Owned(String)`.

`push_owned_lines` is a convenience wrapper that appends a slice of borrowed lines into an output `Vec<Line<'static>>` by repeatedly calling `line_to_static`. This avoids repeated boilerplate in transcript, markdown, command, and wrapping code.

The file also includes two formatting helpers. `prefix_lines` prepends one `Span` to the first line and another to all subsequent lines, preserving each original line's spans and reapplying the original line style to the reconstructed `Line`. This is used for bullets, gutters, and continuation prefixes. In tests, `is_blank_line_spaces_only` defines a narrow notion of blankness: a line is blank if it has no spans or every span is empty or consists only of literal spaces. Tabs and newlines are intentionally not treated as blank, which matters for line-buffering logic that distinguishes visually empty lines from other whitespace.

#### Function details

##### `line_to_static`  (lines 5–18)

```
fn line_to_static(line: &Line<'_>) -> Line<'static>
```

**Purpose**: Clones a borrowed ratatui `Line` into an owned `Line<'static>` while preserving styling and alignment.

**Data flow**: It takes `&Line<'_>`, copies the line's `style` and `alignment`, iterates its spans, clones each span's `style`, converts each span's content to an owned `String`, wraps that in `Cow::Owned`, collects the new spans, and returns the reconstructed `Line<'static>`.

**Call relations**: This is the core ownership-conversion helper used by `push_owned_lines` whenever borrowed lines need to be retained beyond their original lifetime.

*Call graph*: called by 1 (push_owned_lines).


##### `push_owned_lines`  (lines 21–25)

```
fn push_owned_lines(src: &[Line<'a>], out: &mut Vec<Line<'static>>)
```

**Purpose**: Appends owned copies of borrowed lines into an existing output vector.

**Data flow**: It takes a slice of borrowed `Line`s and a mutable `Vec<Line<'static>>`, iterates the source slice, converts each line with `line_to_static`, and pushes the result into `out`. It returns no value and mutates the destination vector.

**Call relations**: This helper is used by many higher-level renderers that accumulate output lines from borrowed sources. It delegates the actual cloning work to `line_to_static`.

*Call graph*: calls 1 internal fn (line_to_static); called by 9 (command_display_lines, exploring_display_lines, transcript_lines, user_shell_output_is_limited_by_screen_lines, append_markdown, append_markdown_agent, render_stacked_field, adaptive_wrap_lines, word_wrap_lines).


##### `is_blank_line_spaces_only`  (lines 30–37)

```
fn is_blank_line_spaces_only(line: &Line<'_>) -> bool
```

**Purpose**: Determines whether a line is visually blank under a strict spaces-only definition used in tests.

**Data flow**: It takes `&Line<'_>`, returns `true` immediately if the line has no spans, otherwise checks that every span is either empty or consists entirely of `' '` characters. It returns a boolean and does not mutate state.

**Call relations**: This test-only helper is used by `commit_complete_lines` tests to reason about blank-line handling with a narrower definition than generic whitespace.

*Call graph*: called by 1 (commit_complete_lines).


##### `prefix_lines`  (lines 41–60)

```
fn prefix_lines(
    lines: Vec<Line<'static>>,
    initial_prefix: Span<'static>,
    subsequent_prefix: Span<'static>,
) -> Vec<Line<'static>>
```

**Purpose**: Prepends one prefix span to the first line and another prefix span to all following lines, returning a new owned line vector.

**Data flow**: It takes owned `Vec<Line<'static>>` plus `initial_prefix` and `subsequent_prefix` spans. It enumerates the lines, allocates a new span vector for each line, clones and inserts the appropriate prefix based on index, extends with the original line's spans, rebuilds the line with `Line::from(spans)`, reapplies the original line style via `.style(l.style)`, and collects the results into a new `Vec<Line<'static>>`.

**Call relations**: This helper is used by multiple renderers that need hanging prefixes such as bullets, gutters, or continuation markers. It is a pure transformation over already-owned lines.

*Call graph*: called by 7 (render_footer_from_props, render_footer_line, render_changes_block, command_display_lines, exploring_display_lines, user_shell_output_is_limited_by_screen_lines, collab_event).


### Width and line shaping helpers
These utilities handle width guards, ANSI-to-text conversion, line truncation, and markdown text coalescing before higher-level wrapping logic runs.

### `tui/src/width.rs`

`util` · `cross-cutting during rendering`

This utility module centralizes a subtle rendering invariant used by transcript and hyperlink layout code: after subtracting fixed prefix columns such as bullets, gutters, or labels, the remaining content width must be strictly positive. Returning `0` and continuing with wrapping logic tends to produce empty lines or unstable formatting in very narrow terminals, so these helpers encode a stronger contract.

`usable_content_width` performs the core arithmetic on `usize`. It uses `checked_sub` to avoid underflow when reserved columns exceed total width, then filters out `0`, returning `Some(n)` only when `n > 0`. Any exhausted or overdrawn width becomes `None`, which callers interpret as a signal to render only the prefix or otherwise fall back to a non-wrapping path.

`usable_content_width_u16` is a convenience wrapper for call sites that receive terminal dimensions as `u16`, converting both arguments to `usize` before delegating to the main helper. The tests cover the edge cases that matter most for layout stability: exact exhaustion, over-reservation, and parity between the `usize` and `u16` variants.

#### Function details

##### `usable_content_width`  (lines 22–26)

```
fn usable_content_width(total_width: usize, reserved_cols: usize) -> Option<usize>
```

**Purpose**: Computes remaining content width after reserving fixed columns and rejects zero or negative effective widths.

**Data flow**: It takes `total_width` and `reserved_cols` as `usize`, performs `checked_sub`, and then filters the result so only values greater than zero survive. It returns `Option<usize>` with `Some(remaining)` for usable widths and `None` when subtraction underflows or yields zero.

**Call relations**: This is the core helper wrapped by `usable_content_width_u16`; callers use its `None` contract to choose prefix-only rendering fallbacks.

*Call graph*: called by 1 (usable_content_width_u16).


##### `usable_content_width_u16`  (lines 32–34)

```
fn usable_content_width_u16(total_width: u16, reserved_cols: u16) -> Option<usize>
```

**Purpose**: Adapts the strict-positive width calculation to `u16` terminal dimensions.

**Data flow**: It takes `u16` widths, converts both to `usize` with `usize::from`, calls `usable_content_width`, and returns the resulting `Option<usize>` unchanged.

**Call relations**: Rendering code such as `display_hyperlink_lines` and `lines` calls this wrapper because terminal APIs commonly expose dimensions as `u16`.

*Call graph*: calls 1 internal fn (usable_content_width); called by 2 (display_hyperlink_lines, lines); 1 external calls (from).


##### `tests::usable_content_width_returns_none_when_reserved_exhausts_width`  (lines 42–59)

```
fn usable_content_width_returns_none_when_reserved_exhausts_width()
```

**Purpose**: Checks the core helper's behavior at exhaustion, over-reservation, and the smallest positive remainder.

**Data flow**: It calls `usable_content_width` with several width/reservation pairs and asserts `None` for zero or exhausted space and `Some(1)` when one content column remains.

**Call relations**: This test documents the strict-positive invariant that downstream rendering code relies on.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::usable_content_width_u16_matches_usize_variant`  (lines 62–71)

```
fn usable_content_width_u16_matches_usize_variant()
```

**Purpose**: Verifies that the `u16` wrapper preserves the same semantics as the `usize` implementation.

**Data flow**: It calls `usable_content_width_u16` on representative exhausted and positive cases and asserts the expected `Option<usize>` results.

**Call relations**: This test protects the wrapper used by terminal-dimension call sites from diverging from the core helper.

*Call graph*: 1 external calls (assert_eq!).


### `ansi-escape/src/lib.rs`

`util` · `rendering time for TUI/CLI transcript text`

This file wraps `ansi_to_tui` so callers can safely render ANSI-decorated output in `ratatui` widgets. The first concern it addresses is tabs: transcript and guttered views can render tab characters awkwardly, especially when upstream tools like `nl` use tabs between line numbers and content. `expand_tabs` therefore performs a best-effort normalization, replacing each tab with four spaces while leaving tab-free strings borrowed to avoid allocation.

`ansi_escape_line` is the single-line convenience API. It first normalizes tabs, then delegates full ANSI parsing to `ansi_escape`. Because the parser returns a `Text` that may contain multiple lines, this helper explicitly inspects `text.lines`: it returns an empty line for no output, clones the only line when exactly one exists, and logs a warning before returning just the first line if multiple lines were produced. That behavior preserves the caller contract without silently hiding the mismatch.

`ansi_escape` performs the actual ANSI-to-`Text<'static>` conversion using `IntoText`. The implementation intentionally chooses the simpler conversion path over the crate’s faster `to_text()` API to avoid lifetime complexity. Parsing failures are treated as unrecoverable programmer or upstream-data errors: both `NomError` and `Utf8Error` are logged with `tracing::error!` and then cause an immediate panic.

#### Function details

##### `expand_tabs`  (lines 11–21)

```
fn expand_tabs(s: &str) -> std::borrow::Cow<'_, str>
```

**Purpose**: Normalizes tab characters to spaces for more predictable transcript rendering while avoiding allocation when no tabs are present.

**Data flow**: Reads a string slice, checks for `\t`, and returns `Cow::Owned` with tabs replaced by four spaces when needed or `Cow::Borrowed` of the original string otherwise.

**Call relations**: Used only by `ansi_escape_line` as a preprocessing step before ANSI parsing.

*Call graph*: called by 1 (ansi_escape_line); 2 external calls (Borrowed, Owned).


##### `ansi_escape_line`  (lines 26–38)

```
fn ansi_escape_line(s: &str) -> Line<'static>
```

**Purpose**: Parses ANSI text expected to represent a single line and returns a `ratatui::text::Line`, warning if the parsed result spans multiple lines.

**Data flow**: Consumes a string slice, normalizes tabs with `expand_tabs`, parses ANSI markup with `ansi_escape`, inspects the resulting `Text.lines`, and returns an empty line, the sole line clone, or the first line clone after logging a warning.

**Call relations**: This is the single-line convenience wrapper over `ansi_escape`; it is the likely API used by callers rendering one transcript row at a time.

*Call graph*: calls 2 internal fn (ansi_escape, expand_tabs); 1 external calls (warn!).


##### `ansi_escape`  (lines 40–58)

```
fn ansi_escape(s: &str) -> Text<'static>
```

**Purpose**: Converts an ANSI-decorated string into `ratatui::text::Text<'static>` using `ansi_to_tui`.

**Data flow**: Consumes a string slice and calls `IntoText::into_text()`. On success it returns the parsed `Text`; on `NomError` or `Utf8Error` it logs the error details and panics.

**Call relations**: Called by `ansi_escape_line` and serves as the core ANSI parsing primitive for this crate.

*Call graph*: called by 1 (ansi_escape_line); 2 external calls (panic!, error!).


### `tui/src/line_truncation.rs`

`util` · `cross-cutting during UI rendering`

This utility file contains three focused helpers for width-aware line truncation. `line_width` computes the visible width of a `Line` by summing the Unicode display widths of each span’s content using `unicode_width`. `truncate_line_to_width` performs the actual truncation: it preserves the original line’s `style` and `alignment`, walks spans in order, copies zero-width spans through unchanged, stops once the requested width is filled, and when a span would overflow it cuts that span at a character boundary using `UnicodeWidthChar` so wide characters are never split mid-scalar. The truncated prefix of the overflowing span is rebuilt with the original span style.

`truncate_line_with_ellipsis_if_overflow` adds a UI-oriented overflow marker. It first handles the zero-width case, then uses `line_width` as a fast no-overflow precheck so unchanged lines can be returned without rebuilding. If overflow occurs, it truncates to `max_width - 1`, appends a styled `…`, and chooses the ellipsis style from the last surviving span so the marker visually matches the truncated content. These helpers are intended for short UI rows such as footers, list rows, and compact detail lines rather than large-scale text processing loops.

#### Function details

##### `line_width`  (lines 6–10)

```
fn line_width(line: &Line<'_>) -> usize
```

**Purpose**: Computes the visible terminal-cell width of a styled `Line`.

**Data flow**: Iterates over the line’s spans, measures each span’s content with `UnicodeWidthStr::width`, sums the widths, and returns the total `usize`.

**Call relations**: Used by the ellipsis helper as a fast precheck before rebuilding a line.

*Call graph*: called by 1 (truncate_line_with_ellipsis_if_overflow); 1 external calls (iter).


##### `truncate_line_to_width`  (lines 12–67)

```
fn truncate_line_to_width(line: Line<'static>, max_width: usize) -> Line<'static>
```

**Purpose**: Truncates a styled line to a maximum display width without adding any overflow marker. It preserves line-level style/alignment and span-level styling for retained content.

**Data flow**: Consumes an owned `Line<'static>` and `max_width`; returns an empty line immediately for width 0; otherwise destructures the line, iterates spans while tracking used width, copies fully fitting spans, skips zero-width spans through unchanged, and when a span would overflow scans its characters with `UnicodeWidthChar::width` to find the largest fitting prefix, pushes that prefix as a styled span if non-empty, then returns a rebuilt `Line` with the original style/alignment and truncated spans.

**Call relations**: Used by `truncate_line_with_ellipsis_if_overflow` and by rendering code that needs hard truncation without an ellipsis.

*Call graph*: called by 1 (truncate_line_with_ellipsis_if_overflow); 6 external calls (from, styled, width, width, new, with_capacity).


##### `truncate_line_with_ellipsis_if_overflow`  (lines 75–100)

```
fn truncate_line_with_ellipsis_if_overflow(
    line: Line<'static>,
    max_width: usize,
) -> Line<'static>
```

**Purpose**: Truncates a styled line and appends an ellipsis only when the original content exceeds the available width.

**Data flow**: Consumes an owned `Line<'static>` and `max_width`; returns an empty line for width 0; computes `line_width(&line)` and returns the original line unchanged if it already fits; otherwise truncates to `max_width.saturating_sub(1)` with `truncate_line_to_width`, derives the ellipsis style from the last surviving span or default style, appends `Span::styled("…", ellipsis_style)`, and returns the rebuilt line.

**Call relations**: Used by multiple renderers for compact UI rows where overflow should be visibly indicated.

*Call graph*: calls 2 internal fn (line_width, truncate_line_to_width); called by 8 (render_with_mask_and_textarea_right_reserve, detail_wrapped_lines, render_footer, build_line, render, render_rows_single_line_with_col_width_mode, render_items, render); 3 external calls (from, styled, new).


### `tui/src/markdown_text_merge.rs`

`util` · `markdown parse pipeline`

This file defines one utility type, `DecodedTextMerge<I>`, parameterized over an iterator of `(pulldown_cmark::Event<'a>, Range<usize>)`. The adapter wraps the input iterator in `Peekable` so it can look ahead for consecutive `Event::Text` items. Its purpose is subtle but important: pulldown-cmark and markdown extensions can split visually contiguous text around delimiters or entity boundaries, which makes downstream token recognition harder if consumers see each fragment separately. By merging adjacent already-decoded text events, the renderer can detect whole URLs and other tokens without reconstructing text from the original markdown source.

The implementation is intentionally narrow. Non-text events pass through unchanged with their original source range. When the current event is `Event::Text`, `next` checks whether the following event is also text; if not, it returns the original text event unchanged. If adjacent text continues, it converts the first text fragment into an owned `String`, repeatedly consumes following `Event::Text` items, appends their decoded contents, and extends the current range’s `end` to the last merged event’s end offset. The returned event is a single merged `Event::Text` paired with the combined source range. This preserves offset-aware rendering while giving later stages a contiguous decoded string.

#### Function details

##### `DecodedTextMerge::new`  (lines 18–22)

```
fn new(iter: I) -> Self
```

**Purpose**: Wraps an event iterator in the text-merging adapter.

**Data flow**: It takes an iterator `I`, converts it to `Peekable` with `peekable()`, stores it in `DecodedTextMerge`, and returns the new adapter.

**Call relations**: Constructed by `render_markdown_lines_with_width_and_cwd` before events are fed into the markdown `Writer`.

*Call graph*: called by 1 (render_markdown_lines_with_width_and_cwd); 1 external calls (peekable).


##### `DecodedTextMerge::next`  (lines 31–49)

```
fn next(&mut self) -> Option<Self::Item>
```

**Purpose**: Returns the next event, merging any run of adjacent `Event::Text` items into one decoded text event with a combined source range.

**Data flow**: It pulls the next `(event, range)` from the inner iterator. Non-text events are returned unchanged. For a text event, it peeks ahead; if the next event is not text, it returns the original text and range. Otherwise it converts the first text fragment into a mutable string, repeatedly consumes following text events, appends their contents, updates `range.end` to the latest end offset, and returns one merged `Event::Text` with the expanded range.

**Call relations**: Used implicitly by the markdown rendering pipeline whenever the writer iterates parser events. Its merged output improves downstream URL and token recognition without changing non-text event flow.

*Call graph*: 3 external calls (next, matches!, Text).


### Wrapping and hyperlink-preserving layout
This core layout path wraps text while preserving semantic hyperlink boundaries and reconstructable ranges for downstream rendering.

### `tui/src/terminal_hyperlinks.rs`

`io_transport` · `rendering and terminal output`

This module introduces `TerminalHyperlink`, a column range plus destination URL, and `HyperlinkLine`, a `Line<'static>` paired with zero or more hyperlink annotations. The core design choice is separation of concerns: visible text is laid out and wrapped as ordinary ratatui content, while hyperlink metadata is tracked in display-column coordinates and only converted into OSC 8 escape sequences at the last possible moment. That prevents invisible escape bytes from affecting width calculations, wrapping, or buffer geometry.

The file covers the full hyperlink lifecycle. Construction helpers create plain or annotated lines, `push_span` appends visible spans while optionally attaching a validated web destination over the span's column range, and `annotate_web_urls_in_line` discovers bare `http`/`https` URLs in rendered text using punctuation trimming and balanced-delimiter handling. When wrapping occurs, `remap_wrapped_line` maps source hyperlink ranges onto wrapped output fragments by matching rendered text against the remaining source text in display order, skipping boundary whitespace differences and merging adjacent ranges with the same destination. Prefix insertion similarly shifts hyperlink columns to stay aligned with visible text.

For output, `decorate_spans` injects OSC 8 open/close sequences into cloned spans while preserving style runs, and `mark_buffer_hyperlinks` post-processes a rendered `Buffer` by re-wrapping each logical line exactly as ratatui did, remapping hyperlinks onto those wrapped rows, and replacing matching cell symbols with OSC 8-decorated versions. Additional helpers mark already-underlined or cyan-underlined cells as hyperlinks, validate destinations with `url::Url`, and strip OSC 8 sequences in tests. The implementation is careful about Unicode display width, contiguous-range merging, and rejecting non-web schemes or control characters in destinations.

#### Function details

##### `HyperlinkLine::new`  (lines 39–44)

```
fn new(line: Line<'static>) -> Self
```

**Purpose**: Creates a `HyperlinkLine` from a visible ratatui `Line` with no hyperlink annotations yet. It is the basic constructor used throughout rendering and wrapping code.

**Data flow**: It takes `line: Line<'static>`, stores it in `HyperlinkLine { line, hyperlinks: Vec::new() }`, and returns the new value.

**Call relations**: Many rendering and transcript-building paths call this when starting a line before optional hyperlink annotation is added later.

*Call graph*: called by 23 (display_lines_for_history_insert, render_transcript_lines_for_reflow, display_hyperlink_lines, ensure_line, hard_break, pop_link, push_blank_line, push_line, push_text_spans, push_text_spans_to_table_cell (+13 more)); 1 external calls (new).


##### `HyperlinkLine::width`  (lines 46–48)

```
fn width(&self) -> usize
```

**Purpose**: Returns the display width of the visible line content. Hyperlink metadata does not affect this measurement.

**Data flow**: It reads `self.line.width()` and returns the resulting `usize`.

**Call relations**: Span-appending and history-writing code use this to compute column offsets before adding more visible content.

*Call graph*: called by 2 (write_history_line, push_span); 1 external calls (width).


##### `HyperlinkLine::push_span`  (lines 50–62)

```
fn push_span(&mut self, span: Span<'static>, destination: Option<&str>)
```

**Purpose**: Appends a visible span to the line and, when given a valid web destination, records a hyperlink covering exactly that span's display columns. Zero-width spans do not create links.

**Data flow**: It takes `&mut self`, a `Span<'static>`, and `destination: Option<&str>`. It computes `start` from the current line width and `end` by adding the span content width, pushes the span into `self.line`, validates the optional destination through `web_destination`, and if the span has positive width and the destination is valid, pushes a `TerminalHyperlink { columns: start..end, destination }` into `self.hyperlinks`.

**Call relations**: This is used by line-building code that already knows semantic link destinations. It combines visible-text mutation with synchronized hyperlink-range bookkeeping.

*Call graph*: calls 1 internal fn (width); 1 external calls (push_span).


##### `HyperlinkLine::style`  (lines 64–67)

```
fn style(mut self, style: ratatui::style::Style) -> Self
```

**Purpose**: Applies a ratatui style to the visible line while leaving hyperlink metadata unchanged. It supports fluent styling of already-constructed hyperlink lines.

**Data flow**: It takes ownership of `self`, applies `self.line.style(style)`, stores the styled line back, and returns the modified `HyperlinkLine`.

**Call relations**: Prewrapped-line insertion code uses this when styling a line after its hyperlink structure has already been established.

*Call graph*: called by 1 (push_prewrapped_line); 1 external calls (style).


##### `HyperlinkLine::from`  (lines 83–85)

```
fn from(text: String) -> Self
```

**Purpose**: Converts a `Line<'static>` into a plain `HyperlinkLine`. It is the `From<Line<'static>>` implementation backing ergonomic conversions.

**Data flow**: It takes a `Line<'static>`, forwards it to `HyperlinkLine::new`, and returns the resulting `HyperlinkLine`.

**Call relations**: Transcript and display helpers rely on this conversion when they have visible lines but no hyperlink metadata yet.

*Call graph*: called by 3 (active_cell_transcript_hyperlink_lines, display_hyperlink_lines, transcript_hyperlink_lines); 2 external calls (from, new).


##### `visible_lines`  (lines 88–90)

```
fn visible_lines(lines: Vec<HyperlinkLine>) -> Vec<Line<'static>>
```

**Purpose**: Drops hyperlink metadata and returns only the visible ratatui lines. It is the escape hatch back to plain text rendering.

**Data flow**: It consumes `Vec<HyperlinkLine>`, maps each element to its `.line`, collects those into `Vec<Line<'static>>`, and returns the vector.

**Call relations**: Renderers and height calculators call this when they need geometry or display text only and hyperlink semantics are not needed at that stage.

*Call graph*: called by 9 (render, desired_transcript_height, display_lines_for_mode, render_markdown_text_with_width_and_cwd, render, desired_height, render, controller_live_view_matches_render_during_interleaved_table_streaming, hyperlink_lines_to_plain_strings).


##### `plain_hyperlink_lines`  (lines 92–94)

```
fn plain_hyperlink_lines(lines: Vec<Line<'static>>) -> Vec<HyperlinkLine>
```

**Purpose**: Wraps plain visible lines into `HyperlinkLine` values with empty hyperlink lists. It is the inverse of `visible_lines` for non-linked content.

**Data flow**: It consumes `Vec<Line<'static>>`, maps each line through `HyperlinkLine::new`, collects the results, and returns `Vec<HyperlinkLine>`.

**Call relations**: Display and transcript assembly code uses this when starting from plain rendered lines before optional annotation or remapping.

*Call graph*: called by 8 (display_hyperlink_lines, display_hyperlink_lines_for_mode, transcript_hyperlink_lines, insert_history_lines_with_mode_and_wrap_policy, display_hyperlink_lines, render_source, remap_wrapped_line, insert_history_lines_with_wrap_policy).


##### `prefix_hyperlink_lines`  (lines 96–121)

```
fn prefix_hyperlink_lines(
    lines: Vec<HyperlinkLine>,
    initial_prefix: Span<'static>,
    subsequent_prefix: Span<'static>,
) -> Vec<HyperlinkLine>
```

**Purpose**: Prepends one prefix span to the first line and another to subsequent lines, shifting all existing hyperlink column ranges accordingly. It preserves semantic links after visible indentation or bullets are inserted.

**Data flow**: It consumes a vector of `HyperlinkLine`s plus `initial_prefix` and `subsequent_prefix` spans. For each line it chooses the appropriate prefix by index, computes the prefix display width, rebuilds the line's span list with the prefix inserted at the front while preserving the original line style, increments every hyperlink range by that width, and returns the transformed vector.

**Call relations**: Display-line rendering uses this when adding prefixes such as bullets or labels after hyperlink annotation already exists.

*Call graph*: called by 1 (render_display_lines).


##### `adaptive_wrap_hyperlink_lines`  (lines 123–145)

```
fn adaptive_wrap_hyperlink_lines(
    lines: &[HyperlinkLine],
    options: RtOptions<'static>,
) -> Vec<HyperlinkLine>
```

**Purpose**: Wraps hyperlink lines with adaptive indentation while preserving hyperlink destinations on the wrapped fragments. It mirrors visible wrapping but reattaches semantic ranges afterward.

**Data flow**: It takes a slice of `HyperlinkLine` and `RtOptions<'static>`. For each source line it clones the wrap options, using the original initial indent only for the first line and replacing later lines' initial indent with the subsequent indent, wraps the visible `Line` via `adaptive_wrap_line`, converts wrapped lines to `'static`, remaps hyperlinks with `remap_wrapped_line`, extends an output vector with the remapped fragments, and returns the accumulated `Vec<HyperlinkLine>`.

**Call relations**: Higher-level display code calls this when width-constrained transcript output must wrap while retaining semantic links. It delegates visible wrapping to the wrapping subsystem and hyperlink preservation to `remap_wrapped_line`.

*Call graph*: calls 2 internal fn (remap_wrapped_line, adaptive_wrap_line); called by 1 (display_hyperlink_lines); 3 external calls (new, iter, clone).


##### `annotate_web_urls`  (lines 147–149)

```
fn annotate_web_urls(lines: Vec<Line<'static>>) -> Vec<HyperlinkLine>
```

**Purpose**: Scans a batch of visible lines for bare web URLs and returns hyperlink-annotated equivalents. It is the bulk convenience wrapper around per-line URL discovery.

**Data flow**: It consumes `Vec<Line<'static>>`, maps each line through `annotate_web_urls_in_line`, collects the resulting `Vec<HyperlinkLine>`, and returns it.

**Call relations**: Display pipelines call this when they want automatic semantic links for visible URL text without manually attaching destinations.

*Call graph*: called by 3 (display_hyperlink_lines, display_hyperlink_lines, display_hyperlink_lines).


##### `annotate_web_urls_in_line`  (lines 151–160)

```
fn annotate_web_urls_in_line(line: Line<'static>) -> HyperlinkLine
```

**Purpose**: Discovers bare `http`/`https` URLs in one visible line and records them as hyperlink ranges over the existing text. The visible line content itself is unchanged.

**Data flow**: It concatenates the line's span contents into a `String`, constructs `HyperlinkLine::new(line)`, computes `web_links_in_text(&text)`, assigns that vector to `out.hyperlinks`, and returns `out`.

**Call relations**: Text-span builders and tests call this when converting already-rendered text into semantic hyperlink lines. It delegates URL tokenization and validation to `web_links_in_text`.

*Call graph*: calls 2 internal fn (new, web_links_in_text); called by 3 (writes_semantic_web_link_without_changing_visible_text, push_text_spans, push_text_spans_to_table_cell).


##### `remap_wrapped_line`  (lines 167–209)

```
fn remap_wrapped_line(
    source: &HyperlinkLine,
    wrapped: Vec<Line<'static>>,
) -> Vec<HyperlinkLine>
```

**Purpose**: Transfers hyperlink ranges from an unwrapped source line onto a set of wrapped visible lines by matching output text back to source text in display order. It is the key preservation step that keeps links correct after wrapping or table layout changes.

**Data flow**: Inputs are a source `HyperlinkLine` and wrapped visible `Vec<Line<'static>>`. The function first converts wrapped lines to plain `HyperlinkLine`s, concatenates source visible text with `line_text`, and tracks both source byte and source display-column positions. For each wrapped line after the first, it trims leading whitespace from the remaining source slice and advances source positions accordingly. It then finds the earliest suffix of the rendered line that matches the remaining source prefix via `longest_suffix_matching_prefix`; for each mapped character, it computes display width, finds any source hyperlink whose range contains the current source column, and adds the corresponding output-column range to the wrapped line with `push_link_range`. It returns the wrapped lines with reconstructed hyperlink metadata.

**Call relations**: Wrapping, table-cell layout, history insertion, and buffer hyperlink marking all rely on this function after visible wrapping has already happened. It delegates text extraction and contiguous-range merging to small helpers.

*Call graph*: calls 4 internal fn (line_text, longest_suffix_matching_prefix, plain_hyperlink_lines, push_link_range); called by 7 (insert_history_hyperlink_lines_with_mode_and_wrap_policy, flush_current_line, wrap_cell, wrap_cell, adaptive_wrap_hyperlink_lines, mark_buffer_hyperlinks, wrapping_maps_repeated_link_labels_by_source_position).


##### `line_text`  (lines 211–216)

```
fn line_text(line: &Line<'_>) -> String
```

**Purpose**: Concatenates all span contents in a ratatui line into one plain string. It ignores style and hyperlink metadata.

**Data flow**: It takes `&Line`, iterates over `line.spans`, collects each span's content into a `String`, and returns that string.

**Call relations**: Only `remap_wrapped_line` uses this helper to compare visible source and wrapped text.

*Call graph*: called by 1 (remap_wrapped_line).


##### `longest_suffix_matching_prefix`  (lines 218–224)

```
fn longest_suffix_matching_prefix(rendered: &str, source: &str) -> Option<usize>
```

**Purpose**: Finds the earliest byte index in a rendered string such that the suffix starting there matches the prefix of the remaining source string. This lets remapping ignore inserted leading whitespace or indentation in wrapped output.

**Data flow**: It iterates over all character boundary indices in `rendered` plus the end index, and returns the first index where `source.starts_with(&rendered[index..])` and the index is not the full rendered length. The result is `Option<usize>`.

**Call relations**: This helper is used only by `remap_wrapped_line` to align wrapped fragments with the remaining source text.

*Call graph*: called by 1 (remap_wrapped_line); 1 external calls (once).


##### `push_link_range`  (lines 226–241)

```
fn push_link_range(line: &mut HyperlinkLine, range: Range<usize>, destination: &str)
```

**Purpose**: Adds a hyperlink range to a line, merging it with the previous range when the destination matches and the ranges are contiguous. This keeps per-line hyperlink metadata compact.

**Data flow**: It takes `&mut HyperlinkLine`, a `Range<usize>`, and `destination: &str`. Empty ranges are ignored. If the last existing hyperlink has the same destination and ends exactly where the new range starts, its end is extended; otherwise a new `TerminalHyperlink` with an owned destination string is pushed.

**Call relations**: Only `remap_wrapped_line` calls this while reconstructing wrapped hyperlink fragments character by character.

*Call graph*: called by 1 (remap_wrapped_line); 1 external calls (is_empty).


##### `web_links_in_text`  (lines 243–271)

```
fn web_links_in_text(text: &str) -> Vec<TerminalHyperlink>
```

**Purpose**: Scans plain text for whitespace-delimited web URL tokens, trims surrounding punctuation, validates them, and returns hyperlink column ranges for each discovered URL. It is the bare-URL detector used for automatic annotation.

**Data flow**: It takes `text: &str`, iterates over `split_ascii_whitespace()` tokens while tracking a `search_from` byte offset to locate each token in the original string, trims leading punctuation with `is_leading_punctuation`, trims trailing punctuation with `trailing_url_end`, validates the candidate via `web_destination`, computes start and end display columns using Unicode width on the original prefix and candidate, pushes `TerminalHyperlink { columns, destination }` for each valid URL, and returns the collected vector.

**Call relations**: Automatic line annotation calls this after flattening spans into plain text. It delegates punctuation handling and destination validation to dedicated helpers.

*Call graph*: calls 2 internal fn (trailing_url_end, web_destination); called by 1 (annotate_web_urls_in_line); 1 external calls (new).


##### `is_leading_punctuation`  (lines 273–278)

```
fn is_leading_punctuation(ch: char) -> bool
```

**Purpose**: Classifies punctuation characters that should be stripped from the front of a token before URL validation. This avoids linking surrounding delimiters instead of the URL itself.

**Data flow**: It takes `ch: char` and returns whether it matches one of the configured leading punctuation characters such as parentheses, brackets, braces, angle brackets, commas, periods, semicolons, exclamation marks, or quotes.

**Call relations**: Only `web_links_in_text` uses this helper during token trimming.

*Call graph*: 1 external calls (matches!).


##### `trailing_url_end`  (lines 280–296)

```
fn trailing_url_end(candidate: &str) -> usize
```

**Purpose**: Finds the byte index where a candidate URL should end after trimming trailing punctuation, while preserving balanced closing delimiters that are legitimately part of the URL. It prevents common punctuation-adjacent false positives.

**Data flow**: It starts from `candidate.len()`, repeatedly inspects the last character of the remaining prefix, trims commas/periods/semicolons/exclamation marks/quotes unconditionally, trims closing delimiters only when `has_unmatched_closing_delimiter` says they are unmatched, and returns the final end index.

**Call relations**: This helper is called by `web_links_in_text` to sanitize token tails before URL parsing.

*Call graph*: calls 1 internal fn (has_unmatched_closing_delimiter); called by 1 (web_links_in_text); 1 external calls (matches!).


##### `has_unmatched_closing_delimiter`  (lines 298–308)

```
fn has_unmatched_closing_delimiter(candidate: &str, closing: char) -> bool
```

**Purpose**: Determines whether a closing delimiter at the end of a candidate appears more times than its matching opening delimiter. This is used to decide whether a trailing `)`, `]`, `}`, or `>` is punctuation or part of the URL.

**Data flow**: It maps the provided closing delimiter to its opening counterpart, counts occurrences of both characters in `candidate`, and returns whether closings outnumber openings.

**Call relations**: Only `trailing_url_end` uses this helper to preserve balanced delimiters in URLs such as Wikipedia links with parentheses.

*Call graph*: called by 1 (trailing_url_end).


##### `web_destination`  (lines 310–320)

```
fn web_destination(destination: &str) -> Option<String>
```

**Purpose**: Validates and sanitizes a hyperlink destination string for terminal use, accepting only `http` and `https` URLs with a host. Control characters are stripped before parsing.

**Data flow**: It takes `destination: &str`, filters out control characters into `safe_destination`, parses that string with `Url::parse`, rejects parse failures, rejects schemes other than `http` or `https`, rejects URLs without `host_str()`, and returns `Some(safe_destination)` or `None`.

**Call relations**: Span attachment, bare-URL discovery, OSC 8 emission, and buffer marking all rely on this validator to ensure only safe web links become terminal hyperlinks.

*Call graph*: called by 4 (pop_link, mark_matching_cells, osc8_hyperlink, web_links_in_text); 2 external calls (parse, matches!).


##### `osc8_hyperlink`  (lines 322–327)

```
fn osc8_hyperlink(destination: &str, text: &str) -> String
```

**Purpose**: Wraps visible text in an OSC 8 hyperlink sequence when the destination is a valid web URL. Invalid destinations leave the visible text unchanged.

**Data flow**: It takes `destination` and `text`, validates the destination with `web_destination`, returns `text.to_string()` on failure, or formats `"\x1b]8;;{destination}\x07{text}\x1b]8;;\x07"` on success.

**Call relations**: Buffer and cell-marking code call this at the final output stage when converting semantic links into terminal escape sequences.

*Call graph*: calls 1 internal fn (web_destination); called by 2 (mark_buffer_hyperlinks, mark_matching_cells); 1 external calls (format!).


##### `strip_osc8`  (lines 330–360)

```
fn strip_osc8(text: &str) -> String
```

**Purpose**: Removes OSC 8 hyperlink sequences from a string while preserving visible text. It is a test-only helper for asserting that hyperlink decoration does not alter visible output.

**Data flow**: It scans the input bytes, detects OSC 8 open/close prefixes beginning with `ESC ] 8 ;;`, skips payload bytes until BEL or ST terminators, otherwise decodes and appends the current Unicode character to an output `String`, and returns the stripped string.

**Call relations**: Tests use this to verify that OSC 8 wrapping preserves visible text exactly.

*Call graph*: 1 external calls (with_capacity).


##### `decorate_spans`  (lines 362–409)

```
fn decorate_spans(line: &HyperlinkLine) -> Vec<Span<'static>>
```

**Purpose**: Converts a `HyperlinkLine` into visible spans that include OSC 8 open/close sequences at hyperlink boundaries while preserving ratatui styles. It is the span-level emission path for history or scrollback writers.

**Data flow**: If the line has no hyperlinks, it clones and returns the original spans. Otherwise it iterates character by character through each span, tracks current display column and active hyperlink index, closes the previous OSC 8 sequence when leaving a link, opens a new one when entering a link using a validated destination, appends each visible character with `push_styled_content`, and appends a final close sequence if a link remains active. The result is `Vec<Span<'static>>` containing visible text plus OSC control bytes embedded in span content.

**Call relations**: History-writing code calls this when serializing styled lines with semantic hyperlinks. It delegates span coalescing and close-sequence appending to small helpers.

*Call graph*: calls 2 internal fn (append_to_last_span, push_styled_content); called by 1 (write_history_line); 2 external calls (new, format!).


##### `push_styled_content`  (lines 411–419)

```
fn push_styled_content(out: &mut Vec<Span<'static>>, content: &str, style: ratatui::style::Style)
```

**Purpose**: Appends text to the output span list, merging with the previous span when the style matches. This avoids unnecessary span fragmentation during OSC decoration.

**Data flow**: It takes `out: &mut Vec<Span<'static>>`, `content: &str`, and a `Style`. If the last span has the same style, it mutates that span's content to append the new text; otherwise it pushes a new styled span containing an owned string.

**Call relations**: Only `decorate_spans` uses this helper while rebuilding styled output around hyperlink boundaries.

*Call graph*: called by 1 (decorate_spans); 1 external calls (styled).


##### `append_to_last_span`  (lines 421–425)

```
fn append_to_last_span(out: &mut [Span<'static>], content: &str)
```

**Purpose**: Appends raw text to the content of the last span in place. It is used for OSC close markers that should inherit the style of the preceding visible content.

**Data flow**: It takes a mutable slice of spans and `content: &str`; if a last span exists, it mutates its content to append the provided string.

**Call relations**: This helper is called only by `decorate_spans` when closing an active hyperlink sequence.

*Call graph*: called by 1 (decorate_spans); 1 external calls (last_mut).


##### `mark_buffer_hyperlinks`  (lines 427–484)

```
fn mark_buffer_hyperlinks(
    buf: &mut Buffer,
    area: Rect,
    lines: &[HyperlinkLine],
    scroll_rows: usize,
)
```

**Purpose**: Post-processes a rendered ratatui `Buffer` to inject OSC 8 hyperlinks into the exact cells corresponding to semantic hyperlink ranges, even after ratatui word wrapping. It is the buffer-level emission path used during terminal rendering.

**Data flow**: Inputs are a mutable `Buffer`, target `Rect`, a slice of logical `HyperlinkLine`s, and `scroll_rows`. The function returns early for zero-width areas. For each logical line it constructs a `Paragraph` from the visible line, computes its wrapped height at `area.width`, skips hyperlink-free lines except for advancing the logical row counter, otherwise renders the paragraph into a temporary off-screen `Buffer`, reconstructs each wrapped visible row as a trimmed `Line<String>`, remaps source hyperlinks onto those wrapped rows with `remap_wrapped_line`, and for every linked output cell within the visible scroll window replaces the cell symbol with `osc8_hyperlink(destination, symbol)` unless the cell is skipped or blank. It updates `logical_row` by the rendered height after each logical line.

**Call relations**: Render paths call this after visible content has already been painted into the terminal buffer. It delegates wrapping alignment to ratatui itself and hyperlink reconstruction to `remap_wrapped_line` so OSC bytes are inserted only after geometry is fixed.

*Call graph*: calls 2 internal fn (osc8_hyperlink, remap_wrapped_line); called by 4 (render, render, render, buffer_hyperlinks_follow_word_wrapping); 6 external calls (empty, new, new, from, try_from, from).


##### `mark_url_hyperlink`  (lines 486–490)

```
fn mark_url_hyperlink(buf: &mut Buffer, area: Rect, destination: &str)
```

**Purpose**: Marks matching cells in a buffer as hyperlinks when they already look like URL-styled text, specifically cyan and underlined. It is a heuristic post-processor for rendered URL text.

**Data flow**: It takes a mutable buffer, area, and destination string, then calls `mark_matching_cells` with a predicate requiring `cell.fg == Color::Cyan` and the underlined modifier.

**Call relations**: Renderers use this when visible styling already identifies URL text and they want to attach a semantic destination afterward.

*Call graph*: calls 1 internal fn (mark_matching_cells); called by 3 (render, render, mark_url_hyperlink).


##### `mark_underlined_hyperlink`  (lines 492–496)

```
fn mark_underlined_hyperlink(buf: &mut Buffer, area: Rect, destination: &str)
```

**Purpose**: Marks matching underlined cells in a buffer as hyperlinks regardless of foreground color. It is a broader heuristic than `mark_url_hyperlink`.

**Data flow**: It forwards the buffer, area, and destination to `mark_matching_cells` with a predicate that checks only for the underlined modifier.

**Call relations**: Reference rendering and related paths call this when underlining alone identifies clickable text.

*Call graph*: calls 1 internal fn (mark_matching_cells); called by 2 (mark_underlined_hyperlink, render_ref).


##### `mark_matching_cells`  (lines 498–514)

```
fn mark_matching_cells(
    buf: &mut Buffer,
    area: Rect,
    destination: &str,
    matches: impl Fn(&ratatui::buffer::Cell) -> bool,
)
```

**Purpose**: Scans a rectangular buffer region and wraps every nonblank, non-skipped cell satisfying a caller-provided predicate in an OSC 8 hyperlink sequence. It is the generic cell-marking primitive behind style-based hyperlink attachment.

**Data flow**: It takes a mutable buffer, area, destination, and predicate. If `web_destination(destination)` is `None`, it returns immediately. Otherwise it iterates over `area.positions()`, and for each cell that is not skipped, not blank after trimming, and satisfies `matches`, it replaces the cell symbol with `osc8_hyperlink(destination, cell.symbol())`.

**Call relations**: Both style-based marking helpers delegate to this function. It centralizes destination validation and per-cell OSC insertion.

*Call graph*: calls 2 internal fn (osc8_hyperlink, web_destination); called by 2 (mark_underlined_hyperlink, mark_url_hyperlink); 1 external calls (positions).


##### `tests::only_web_destinations_receive_osc8`  (lines 522–533)

```
fn only_web_destinations_receive_osc8()
```

**Purpose**: Verifies that OSC 8 wrapping is emitted only for valid web URLs, strips control characters from destinations, and preserves visible text. It protects the destination-validation boundary.

**Data flow**: The test calls `osc8_hyperlink` with valid and invalid schemes, compares outputs, and uses `strip_osc8` to assert that visible text remains unchanged after wrapping.

**Call relations**: This test exercises `web_destination`, `osc8_hyperlink`, and `strip_osc8` together as the final-output safety path.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::discovers_punctuated_web_url_columns`  (lines 536–544)

```
fn discovers_punctuated_web_url_columns()
```

**Purpose**: Checks that URL discovery trims surrounding punctuation and computes the correct display-column range. It validates token trimming around bare URLs.

**Data flow**: It calls `web_links_in_text("See (https://example.com/a).")` and asserts a single `TerminalHyperlink` with the expected columns and destination.

**Call relations**: This test covers punctuation handling in `web_links_in_text`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::preserves_balanced_parentheses_in_bare_web_urls`  (lines 547–556)

```
fn preserves_balanced_parentheses_in_bare_web_urls()
```

**Purpose**: Ensures balanced parentheses that are part of a URL are preserved rather than trimmed as punctuation. This protects common URLs such as Wikipedia article links.

**Data flow**: It constructs a URL containing parentheses, embeds it in surrounding punctuation, calls `web_links_in_text`, and asserts that the discovered hyperlink spans the full destination width.

**Call relations**: This test specifically validates `trailing_url_end` and `has_unmatched_closing_delimiter` behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::decorates_a_contiguous_web_link_with_one_osc8_pair`  (lines 559–577)

```
fn decorates_a_contiguous_web_link_with_one_osc8_pair()
```

**Purpose**: Verifies that a single contiguous hyperlink range becomes one OSC 8 open/close pair and that non-linked lines are returned unchanged. It protects span decoration compactness.

**Data flow**: It constructs a `HyperlinkLine` whose entire visible text is one hyperlink, calls `decorate_spans`, and asserts the result is a single span containing `osc8_hyperlink(destination, destination)`. It also checks that a plain line decorates to its original span.

**Call relations**: This test exercises the span-level emission path in `decorate_spans`.

*Call graph*: 3 external calls (from, assert_eq!, vec!).


##### `tests::wrapping_maps_repeated_link_labels_by_source_position`  (lines 580–596)

```
fn wrapping_maps_repeated_link_labels_by_source_position()
```

**Purpose**: Ensures hyperlink remapping uses source position rather than repeated visible text labels when reconstructing wrapped links. This avoids attaching a link to the wrong repeated substring.

**Data flow**: It builds a source line `"here here"` with a hyperlink only on the second word, calls `remap_wrapped_line` with an unchanged wrapped line, and asserts that the resulting hyperlink range still covers only columns `5..9`.

**Call relations**: This test targets the source-position tracking logic inside `remap_wrapped_line`.

*Call graph*: calls 2 internal fn (new, remap_wrapped_line); 3 external calls (from, assert_eq!, vec!).


##### `tests::buffer_hyperlinks_follow_word_wrapping`  (lines 599–626)

```
fn buffer_hyperlinks_follow_word_wrapping()
```

**Purpose**: Verifies that buffer-level hyperlink marking follows ratatui word wrapping and decorates exactly the wrapped cells corresponding to the URL text. It protects the final render-stage integration.

**Data flow**: The test constructs a logical line containing a URL hyperlink, renders the visible text into a `Buffer` with a narrow width, calls `mark_buffer_hyperlinks`, then scans buffer cells for OSC 8-decorated symbols, strips OSC 8, concatenates the linked visible text, and asserts it equals the destination URL.

**Call relations**: This test exercises the full buffer-marking path, including temporary paragraph layout and `remap_wrapped_line`.

*Call graph*: calls 2 internal fn (new, mark_buffer_hyperlinks); 7 external calls (empty, from, new, new, from, assert_eq!, format!).


### `tui/src/wrapping.rs`

`domain_logic` · `render-time text layout and cursor/range calculations across many TUI views`

This module is the TUI’s concrete wrapping engine for `ratatui::text::Line` values. It has two major responsibilities. First, it wraps styled lines while preserving span boundaries and styles: `flatten_line` concatenates span text and records byte ranges, `wrap_ranges_trim` computes wrapped byte slices against the flattened string, and `slice_line_spans` maps each wrapped range back into borrowed `Span` fragments patched with the parent line style. `RtOptions` mirrors the subset of `textwrap::Options` the TUI needs, but uses `Line` values for `initial_indent` and `subsequent_indent` so prefixes can themselves be styled.

Second, it detects URL-like tokens and changes wrapping behavior to avoid splitting them on `/` or `-`. The heuristic strips surrounding punctuation, recognizes absolute URLs with schemes, bare domains with path/query/fragment, `localhost`, and IPv4 hosts, while intentionally rejecting path-like strings such as `src/main.rs`. `adaptive_wrap_line` chooses among three paths: ordinary wrapping for non-URL lines, URL-preserving `textwrap` options for URL-only lines, and a custom mixed-token wrapper for prose-plus-URL lines. That mixed wrapper tokenizes on ASCII spaces, keeps URL tokens atomic even if overlong, but still breaks oversized non-URL tokens using `textwrap::core::Word::break_apart`.

A subtle part of the file is reconstructing source byte ranges from `textwrap` output when `textwrap` returns `Cow::Owned` lines due to inserted hyphenation penalties or synthetic indent prefixes. `map_owned_wrapped_line_to_range` walks the owned output against the source text, strips synthetic prefixes, tolerates trailing penalty `-`, preserves leading spaces on the first line, and logs a warning instead of panicking if only a partial mapping is possible. The extensive tests exercise Unicode width, indent interactions, style preservation, URL heuristics, and several regressions around owned-line range mapping.

#### Function details

##### `wrap_ranges`  (lines 42–80)

```
fn wrap_ranges(text: &str, width_or_options: O) -> Vec<Range<usize>>
```

**Purpose**: Computes source byte ranges for each wrapped line, preserving trailing spaces and adding a one-byte sentinel used by textarea cursor-position logic. It is the low-level range-oriented counterpart to visible line wrapping.

**Data flow**: Accepts `text: &str` and anything convertible into `textwrap::Options`, wraps the text with `textwrap::wrap`, then for each wrapped `Cow<str>` maps it back to a `Range<usize>` in the original source. Borrowed slices are mapped by pointer arithmetic when possible; owned slices fall back to synthetic-prefix-aware reconstruction. After each mapped range it counts trailing spaces in the source, extends the range by those spaces plus one sentinel byte, advances a running cursor, and returns `Vec<Range<usize>>`.

**Call relations**: Used by cursor/range consumers and exercised directly by regression tests. Internally it delegates to `borrowed_slice_range` for cheap exact mapping and to `map_owned_wrapped_line_to_range` when `textwrap` materializes owned output.

*Call graph*: calls 2 internal fn (borrowed_slice_range, map_owned_wrapped_line_to_range); called by 3 (wrapped_lines, wrap_ranges_indent_prefix_coincides_with_source_char, wrap_ranges_recovers_with_non_space_indents); 3 external calls (into, new, wrap).


##### `wrap_ranges_trim`  (lines 85–119)

```
fn wrap_ranges_trim(text: &str, width_or_options: O) -> Vec<Range<usize>>
```

**Purpose**: Computes wrapped source byte ranges without preserving trailing spaces and without the extra sentinel byte. This is the range form used by visible line wrapping where trailing whitespace should not be carried forward.

**Data flow**: Takes source text and `textwrap::Options`, wraps with `textwrap::wrap`, maps each borrowed or owned wrapped slice back into source byte ranges, advances a cursor to the end of each mapped segment, and returns the resulting `Vec<Range<usize>>` unchanged by trailing-space expansion.

**Call relations**: Called by `word_wrap_line` to determine which source bytes belong on each visual line, and by tests that validate reconstruction when `textwrap` emits owned lines with penalty characters.

*Call graph*: calls 2 internal fn (borrowed_slice_range, map_owned_wrapped_line_to_range); called by 2 (wrap_ranges_trim_handles_owned_lines_with_penalty_char, word_wrap_line); 3 external calls (into, new, wrap).


##### `borrowed_slice_range`  (lines 121–132)

```
fn borrowed_slice_range(text: &str, slice: &str) -> Option<Range<usize>>
```

**Purpose**: Attempts to recover the byte range of a wrapped slice by checking whether the slice points directly into the original source string. It is a fast path for `Cow::Borrowed` output from `textwrap`.

**Data flow**: Reads raw pointers and lengths from `text` and `slice`, verifies that the slice lies within the source allocation bounds, and if so returns the offset range `start..end`; otherwise returns `None`.

**Call relations**: Used by both `wrap_ranges` and `wrap_ranges_trim` before falling back to owned-line reconstruction.

*Call graph*: called by 2 (wrap_ranges, wrap_ranges_trim).


##### `map_owned_wrapped_line_to_range`  (lines 141–203)

```
fn map_owned_wrapped_line_to_range(
    text: &str,
    cursor: usize,
    wrapped: &str,
    synthetic_prefix: &str,
) -> Range<usize>
```

**Purpose**: Best-effort maps a materialized wrapped line back to source bytes when `textwrap` inserted synthetic characters such as indent prefixes or trailing hyphenation penalties. It is designed to recover useful ranges without crashing on imperfect matches.

**Data flow**: Accepts the original `text`, a starting `cursor`, the owned `wrapped` line, and the `synthetic_prefix` that may have been prepended by wrapping. It strips the synthetic prefix if present, skips leading source spaces when the wrapped line does not begin with a space, then walks wrapped characters against source characters from `cursor`, advancing `end` on exact matches. A trailing synthesized `-` at end-of-line is ignored; unmatched synthetic chars before any source match are skipped; after partial matching, a mismatch triggers a warning and returns the partial `start..end` range.

**Call relations**: This is the fallback path used by `wrap_ranges` and `wrap_ranges_trim` whenever pointer-based mapping is impossible. Multiple regression tests call it directly to lock down edge cases involving indent prefixes, repeated prefix patterns, and partial mismatches.

*Call graph*: called by 6 (borrowed_slice_range_rejects_slices_outside_source_text, map_owned_wrapped_line_to_range_indent_coincides_with_source, map_owned_wrapped_line_to_range_recovers_on_non_prefix_mismatch, map_owned_wrapped_line_to_range_repro_overconsumes_repeated_prefix_patterns, wrap_ranges, wrap_ranges_trim); 2 external calls (warn!, unreachable!).


##### `line_contains_url_like`  (lines 208–215)

```
fn line_contains_url_like(line: &Line<'_>) -> bool
```

**Purpose**: Checks whether any token across all spans in a `Line` looks URL-like. It flattens styled content before applying the text-level heuristic.

**Data flow**: Concatenates `line.spans[*].content` into a `String`, passes that string to `text_contains_url_like`, and returns the resulting boolean.

**Call relations**: Used by adaptive wrapping and hyperlink insertion logic as the first branch point for deciding whether URL-preserving behavior is needed.

*Call graph*: calls 1 internal fn (text_contains_url_like); called by 2 (insert_history_hyperlink_lines_with_mode_and_wrap_policy, adaptive_wrap_line).


##### `line_has_mixed_url_and_non_url_tokens`  (lines 222–229)

```
fn line_has_mixed_url_and_non_url_tokens(line: &Line<'_>) -> bool
```

**Purpose**: Determines whether a line contains both a URL-like token and substantive non-URL prose. Decorative markers such as bullets and ordered-list prefixes do not count as the non-URL side.

**Data flow**: Flattens all span contents into a `String`, delegates to `text_has_mixed_url_and_non_url_tokens`, and returns `true` only when both categories are present.

**Call relations**: Called after URL detection by adaptive wrapping and hyperlink rendering to decide whether to use the custom mixed-token wrapper instead of all-or-nothing URL-preserving options.

*Call graph*: calls 1 internal fn (text_has_mixed_url_and_non_url_tokens); called by 2 (insert_history_hyperlink_lines_with_mode_and_wrap_policy, adaptive_wrap_line).


##### `text_contains_url_like`  (lines 242–244)

```
fn text_contains_url_like(text: &str) -> bool
```

**Purpose**: Scans plain text for any whitespace-delimited token that matches the module’s URL heuristic. It is the simplest public URL detector in the file.

**Data flow**: Splits `text` on ASCII whitespace, applies `is_url_like_token` to each token, and returns whether any token matched.

**Call relations**: Used by `line_contains_url_like`; it is the text-level primitive behind adaptive URL-aware wrapping.

*Call graph*: called by 1 (line_contains_url_like).


##### `text_has_mixed_url_and_non_url_tokens`  (lines 248–265)

```
fn text_has_mixed_url_and_non_url_tokens(text: &str) -> bool
```

**Purpose**: Checks whether text contains at least one URL-like token and at least one substantive non-URL token. It short-circuits as soon as both conditions are satisfied.

**Data flow**: Iterates over ASCII-whitespace-delimited tokens, classifies each token with `is_url_like_token` and `is_substantive_non_url_token`, tracks `saw_url` and `saw_non_url`, and returns `true` once both flags are set or `false` after the scan completes.

**Call relations**: Used only by `line_has_mixed_url_and_non_url_tokens` to support the mixed URL/prose wrapping branch.

*Call graph*: calls 2 internal fn (is_substantive_non_url_token, is_url_like_token); called by 1 (line_has_mixed_url_and_non_url_tokens).


##### `is_url_like_token`  (lines 271–274)

```
fn is_url_like_token(raw_token: &str) -> bool
```

**Purpose**: Classifies a single token as URL-like after stripping surrounding punctuation. It accepts either absolute URLs with schemes or bare-host forms that satisfy stricter host validation.

**Data flow**: Trims punctuation with `trim_url_token`, rejects empty results, then returns whether either `is_absolute_url_like` or `is_bare_url_like` succeeds on the trimmed token.

**Call relations**: This is the central token classifier used by text-level URL detection and by mixed-token wrapping when tagging words as URL or non-URL.

*Call graph*: calls 3 internal fn (is_absolute_url_like, is_bare_url_like, trim_url_token); called by 2 (mixed_url_wrap_ranges, text_has_mixed_url_and_non_url_tokens).


##### `is_substantive_non_url_token`  (lines 276–283)

```
fn is_substantive_non_url_token(raw_token: &str) -> bool
```

**Purpose**: Determines whether a token should count as meaningful non-URL prose for mixed-content detection. It filters out empty tokens and decorative markers.

**Data flow**: Trims punctuation with `trim_url_token`, returns `false` if the trimmed token is empty or `is_decorative_marker_token` says it is structural markup, otherwise returns whether any character in the trimmed token is alphanumeric.

**Call relations**: Used only by `text_has_mixed_url_and_non_url_tokens` to avoid treating bullets, pipes, and list markers as prose.

*Call graph*: calls 2 internal fn (is_decorative_marker_token, trim_url_token); called by 1 (text_has_mixed_url_and_non_url_tokens).


##### `is_decorative_marker_token`  (lines 285–305)

```
fn is_decorative_marker_token(raw_token: &str, token: &str) -> bool
```

**Purpose**: Recognizes tokens that are visual structure rather than prose, such as bullets, quote markers, box-drawing prefixes, and ordered-list markers. These tokens are ignored when deciding whether a line mixes URL and prose.

**Data flow**: Trims the raw token, compares it against a fixed set of marker strings, and if none match, asks `is_ordered_list_marker` whether the token is a numeric list prefix.

**Call relations**: Called by `is_substantive_non_url_token` as a filter before counting a token as meaningful prose.

*Call graph*: calls 1 internal fn (is_ordered_list_marker); called by 1 (is_substantive_non_url_token); 1 external calls (matches!).


##### `is_ordered_list_marker`  (lines 307–310)

```
fn is_ordered_list_marker(raw_token: &str, token: &str) -> bool
```

**Purpose**: Detects numeric ordered-list prefixes like `1.` or `2)`. It treats only all-digit tokens with a trailing list punctuation marker as decorative.

**Data flow**: Checks that `token` consists entirely of ASCII digits and that the original raw token ends with `.` or `)`, then returns the boolean result.

**Call relations**: Used by `is_decorative_marker_token` to classify ordered-list prefixes.

*Call graph*: called by 1 (is_decorative_marker_token).


##### `trim_url_token`  (lines 312–332)

```
fn trim_url_token(token: &str) -> &str
```

**Purpose**: Removes punctuation commonly surrounding URLs in prose before heuristic classification. This prevents wrappers like parentheses or trailing commas from breaking URL detection.

**Data flow**: Returns a borrowed subslice of `token` with leading and trailing characters trimmed when they match the module’s punctuation set: brackets, braces, angle brackets, commas, periods, semicolons, colons, exclamation marks, and quotes.

**Call relations**: Used by both URL and non-URL token classifiers as the normalization step before further checks.

*Call graph*: called by 2 (is_substantive_non_url_token, is_url_like_token).


##### `is_absolute_url_like`  (lines 337–354)

```
fn is_absolute_url_like(token: &str) -> bool
```

**Purpose**: Recognizes `scheme://...` tokens as URL-like, using `url::Url::parse` for standard schemes and a fallback syntax check for custom schemes. It is intentionally permissive for nonstandard schemes once the prefix is valid.

**Data flow**: Rejects tokens lacking `://`, then tries `url::Url::parse`. For parsed URLs with schemes `http`, `https`, `ftp`, `ftps`, `ws`, or `wss`, it requires `host_str().is_some()`; for other parsed schemes it accepts them directly. If parsing fails, it falls back to `has_valid_scheme_prefix` and returns that result.

**Call relations**: Called by `is_url_like_token` as one half of URL classification, complementing bare-host detection.

*Call graph*: calls 1 internal fn (has_valid_scheme_prefix); called by 1 (is_url_like_token); 2 external calls (matches!, parse).


##### `has_valid_scheme_prefix`  (lines 356–370)

```
fn has_valid_scheme_prefix(token: &str) -> bool
```

**Purpose**: Validates the syntax of a custom URL scheme prefix when full URL parsing fails. It ensures the token still looks like `scheme://rest` rather than arbitrary punctuation.

**Data flow**: Splits the token once on `://`, rejects empty scheme or rest, checks that the first scheme character is ASCII alphabetic and all remaining scheme characters are ASCII alphanumeric or one of `+`, `-`, `.`, then returns the boolean result.

**Call relations**: Used only by `is_absolute_url_like` as a fallback for custom schemes rejected by the `url` crate.

*Call graph*: called by 1 (is_absolute_url_like).


##### `is_bare_url_like`  (lines 380–402)

```
fn is_bare_url_like(token: &str) -> bool
```

**Purpose**: Recognizes URL-like tokens without a scheme, such as `www.example.com/path`, `localhost:3000/api`, or `127.0.0.1:8080/health`. It deliberately rejects path-like strings and bare domains without a URL-ish trailer unless they start with `www.`.

**Data flow**: Splits the token into `host_port` and a trailer-presence flag with `split_host_port_and_trailer`, rejects empty hosts and bare hosts lacking both trailer and `www.` prefix, then separates host and optional port via `split_host_and_port`. If a port exists it must satisfy `is_valid_port`; finally the host must equal `localhost`, satisfy `is_ipv4`, or satisfy `is_domain_name`.

**Call relations**: Called by `is_url_like_token` as the second URL-classification path for scheme-less tokens.

*Call graph*: calls 5 internal fn (is_domain_name, is_ipv4, is_valid_port, split_host_and_port, split_host_port_and_trailer); called by 1 (is_url_like_token).


##### `split_host_port_and_trailer`  (lines 404–410)

```
fn split_host_port_and_trailer(token: &str) -> (&str, bool)
```

**Purpose**: Separates the host/port prefix of a bare URL candidate from any path, query, or fragment trailer. It also reports whether such a trailer existed.

**Data flow**: Searches `token` for the first `/`, `?`, or `#`; if found returns `(&token[..idx], true)`, otherwise returns `(token, false)`.

**Call relations**: Used by `is_bare_url_like` to enforce the rule that most bare hosts need a URL-ish trailer.

*Call graph*: called by 1 (is_bare_url_like).


##### `split_host_and_port`  (lines 412–427)

```
fn split_host_and_port(host_port: &str) -> (&str, Option<&str>)
```

**Purpose**: Splits a host-and-port candidate into host and optional numeric port, while intentionally declining to parse bracketed IPv6 notation. This keeps the first-pass heuristic simple and conservative.

**Data flow**: If `host_port` starts with `[`, returns the whole string as host with no port. Otherwise it tries `rsplit_once(':')`; when both sides are non-empty and the suffix is all ASCII digits, it returns `(host, Some(port))`, else `(host_port, None)`.

**Call relations**: Called by `is_bare_url_like` before host and port validation.

*Call graph*: called by 1 (is_bare_url_like).


##### `is_valid_port`  (lines 429–435)

```
fn is_valid_port(port: &str) -> bool
```

**Purpose**: Validates that a port string is numeric and within the `u16` range. It rejects empty, too-long, and non-digit ports.

**Data flow**: Checks length and digit-only constraints, then parses the string as `u16` and returns whether parsing succeeded.

**Call relations**: Used by `is_bare_url_like` when a bare URL candidate includes `:port`.

*Call graph*: called by 1 (is_bare_url_like).


##### `is_ipv4`  (lines 437–446)

```
fn is_ipv4(host: &str) -> bool
```

**Purpose**: Checks whether a host string is a valid dotted-quad IPv4 address. Each octet must parse as `u8`.

**Data flow**: Splits the host on `.`, requires exactly four parts, and returns whether every non-empty part parses successfully as `u8`.

**Call relations**: Used by `is_bare_url_like` as one accepted host form.

*Call graph*: called by 1 (is_bare_url_like).


##### `is_domain_name`  (lines 448–463)

```
fn is_domain_name(host: &str) -> bool
```

**Purpose**: Validates a hostname as a domain name with a recognized top-level-label shape. It requires at least one dot and validates all labels conservatively.

**Data flow**: Lowercases the host, rejects strings without `.`, splits on `.`, takes the last label as the TLD and validates it with `is_tld`, then requires all preceding labels to satisfy `is_domain_label`; returns the combined boolean result.

**Call relations**: Used by `is_bare_url_like` for bare-domain URL detection.

*Call graph*: calls 1 internal fn (is_tld); called by 1 (is_bare_url_like).


##### `is_tld`  (lines 465–467)

```
fn is_tld(label: &str) -> bool
```

**Purpose**: Checks whether a top-level domain label has a plausible shape. The heuristic accepts only alphabetic labels of length 2 through 63.

**Data flow**: Reads `label.len()` and its characters, returning `true` only if the length is in range and every character is ASCII alphabetic.

**Call relations**: Called by `is_domain_name` when validating the final hostname label.

*Call graph*: called by 1 (is_domain_name).


##### `is_domain_label`  (lines 469–485)

```
fn is_domain_label(label: &str) -> bool
```

**Purpose**: Validates a non-TLD domain label. Labels must be non-empty, at most 63 characters, start and end alphanumeric, and contain only alphanumerics or hyphens internally.

**Data flow**: Checks length bounds, extracts first and last characters, and returns whether boundary and per-character constraints all hold.

**Call relations**: Used by `is_domain_name` for each hostname label before the TLD.


##### `url_preserving_wrap_options`  (lines 493–497)

```
fn url_preserving_wrap_options(opts: RtOptions<'a>) -> RtOptions<'a>
```

**Purpose**: Transforms wrapping options so URL-like tokens are never split by punctuation or hyphenation. It switches to ASCII-space tokenization, disables hyphenation, and forbids breaking words.

**Data flow**: Consumes `RtOptions`, replaces `word_separator` with `WordSeparator::AsciiSpace`, `word_splitter` with `WordSplitter::NoHyphenation`, sets `break_words(false)`, and returns the modified options.

**Call relations**: Used by `adaptive_wrap_line` for URL-only lines where preserving the entire token is more important than fitting within width.

*Call graph*: calls 1 internal fn (word_separator); called by 1 (adaptive_wrap_line).


##### `adaptive_wrap_line`  (lines 508–518)

```
fn adaptive_wrap_line(line: &'a Line<'a>, base: RtOptions<'a>) -> Vec<Line<'a>>
```

**Purpose**: Wraps a single `Line` using URL-aware heuristics. It preserves default wrapping for ordinary prose, preserves whole URL tokens on URL-only lines, and uses a custom mixed-token algorithm when prose and URLs coexist.

**Data flow**: Reads the input `Line` and base `RtOptions`, first checks `line_contains_url_like`; if false it returns `word_wrap_line(line, base)`. If true, it checks `line_has_mixed_url_and_non_url_tokens`; mixed lines go to `mixed_url_wrap_line`, otherwise it calls `word_wrap_line` with `url_preserving_wrap_options(base)`.

**Call relations**: This is the main adaptive entry point used by many rendering paths. It dispatches between the standard wrapper and the custom mixed-token wrapper based on the URL heuristics.

*Call graph*: calls 5 internal fn (line_contains_url_like, line_has_mixed_url_and_non_url_tokens, mixed_url_wrap_line, url_preserving_wrap_options, word_wrap_line); called by 14 (command_display_lines, exploring_display_lines, transcript_lines, user_shell_output_is_limited_by_screen_lines, insert_history_hyperlink_lines_with_mode_and_wrap_policy, flush_current_line, adaptive_wrap_hyperlink_lines, adaptive_wrap_lines, adaptive_wrap_line_keeps_long_url_like_token_intact, adaptive_wrap_line_mixed_line_counts_leading_spaces_before_first_word (+4 more)).


##### `adaptive_wrap_lines`  (lines 528–554)

```
fn adaptive_wrap_lines(
    lines: I,
    width_or_options: RtOptions<'a>,
) -> Vec<Line<'static>>
```

**Purpose**: Applies adaptive wrapping across multiple input lines while using `initial_indent` only for the first output line and `subsequent_indent` thereafter. Each source line is analyzed independently for URL content.

**Data flow**: Consumes an iterable of values implementing the private `IntoLineInput` trait plus base `RtOptions`. For each input line it converts to `LineInput`, chooses options that preserve the original initial indent only for the first overall line and substitute `subsequent_indent` on later lines, calls `adaptive_wrap_line`, then copies the wrapped results into an owned `Vec<Line<'static>>` via `push_owned_lines`.

**Call relations**: Used by higher-level renderers that need URL-aware wrapping over multi-line content. It orchestrates repeated calls to `adaptive_wrap_line` and normalizes ownership for downstream storage.

*Call graph*: calls 2 internal fn (push_owned_lines, adaptive_wrap_line); called by 7 (install_confirmation_lines, as_renderable, push_section_header, as_renderable, transcript_lines, render_transcript_content_lines, display_lines); 2 external calls (into_iter, new).


##### `RtOptions::from`  (lines 584–586)

```
fn from(width: usize) -> Self
```

**Purpose**: Provides a shorthand conversion from a plain width into default wrapping options. This lets callers pass `usize` widths directly to wrapping functions.

**Data flow**: Accepts a `usize` width, calls `RtOptions::new(width)`, and returns the resulting options struct.

**Call relations**: Used implicitly by generic wrapping APIs whenever callers supply a width instead of a full `RtOptions` value.

*Call graph*: calls 1 internal fn (new).


##### `RtOptions::new`  (lines 591–602)

```
fn new(width: usize) -> Self
```

**Purpose**: Constructs default wrapping options for ratatui lines. The defaults mirror ordinary `textwrap` behavior while keeping indent prefixes as `Line` values.

**Data flow**: Creates and returns `RtOptions` with the provided `width`, `LineEnding::LF`, default empty `initial_indent` and `subsequent_indent`, `break_words = true`, `WordSeparator::new()`, `WrapAlgorithm::FirstFit`, and `WordSplitter::HyphenSplitter`.

**Call relations**: This is the base constructor used throughout rendering code and tests before callers selectively override individual wrapping behaviors.

*Call graph*: called by 43 (install_confirmation_lines, as_renderable, push_section_header, as_renderable, wrap_standard_row, wrap_styled_line, command_display_lines, exploring_display_lines, transcript_lines, user_shell_output_is_limited_by_screen_lines (+15 more)); 2 external calls (default, new).


##### `RtOptions::line_ending`  (lines 604–609)

```
fn line_ending(self, line_ending: textwrap::LineEnding) -> Self
```

**Purpose**: Returns a copy of the options with a different line-ending policy. It is a standard builder-style setter.

**Data flow**: Consumes `self`, replaces `line_ending`, preserves all other fields via struct update syntax, and returns the new `RtOptions`.

**Call relations**: Used by callers customizing wrapping behavior before passing options into wrapping functions.


##### `RtOptions::width`  (lines 611–613)

```
fn width(self, width: usize) -> Self
```

**Purpose**: Returns a copy of the options with a different target width. This is useful when deriving per-line widths after accounting for indent prefixes.

**Data flow**: Consumes `self`, writes the new `width`, and returns the updated options.

**Call relations**: Used internally by wrapping code when computing reduced widths for initial and subsequent lines.


##### `RtOptions::initial_indent`  (lines 615–620)

```
fn initial_indent(self, initial_indent: Line<'a>) -> Self
```

**Purpose**: Sets the styled prefix to prepend to the first wrapped output line. The indent itself is represented as a `Line`, not plain text.

**Data flow**: Consumes `self`, replaces `initial_indent`, and returns the updated options.

**Call relations**: Used by callers and by multi-line wrappers when shifting from initial to subsequent indentation semantics.


##### `RtOptions::subsequent_indent`  (lines 622–627)

```
fn subsequent_indent(self, subsequent_indent: Line<'a>) -> Self
```

**Purpose**: Sets the styled prefix for continuation lines after the first wrapped output line. This supports hanging indents and list formatting.

**Data flow**: Consumes `self`, replaces `subsequent_indent`, and returns the updated options.

**Call relations**: Used by callers configuring wrapped layout and by adaptive/standard multi-line wrappers.


##### `RtOptions::break_words`  (lines 629–634)

```
fn break_words(self, break_words: bool) -> Self
```

**Purpose**: Controls whether overlong words may be split to fit the width. Disabling it allows lines to overflow rather than breaking tokens.

**Data flow**: Consumes `self`, replaces `break_words`, and returns the updated options.

**Call relations**: Used directly by callers and indirectly by `url_preserving_wrap_options` to prevent URL splitting.


##### `RtOptions::word_separator`  (lines 636–641)

```
fn word_separator(self, word_separator: textwrap::WordSeparator) -> RtOptions<'a>
```

**Purpose**: Sets the tokenization strategy used by `textwrap` when finding wrap opportunities. This is how the module switches between default and ASCII-space-only behavior.

**Data flow**: Consumes `self`, replaces `word_separator`, and returns the updated options.

**Call relations**: Called by `url_preserving_wrap_options` and available to callers that need explicit separator control.

*Call graph*: called by 1 (url_preserving_wrap_options).


##### `RtOptions::wrap_algorithm`  (lines 643–648)

```
fn wrap_algorithm(self, wrap_algorithm: textwrap::WrapAlgorithm) -> RtOptions<'a>
```

**Purpose**: Sets the `textwrap` wrap algorithm. It is a builder-style passthrough for callers that need non-default line-fitting behavior.

**Data flow**: Consumes `self`, replaces `wrap_algorithm`, and returns the updated options.

**Call relations**: Used during option construction before wrapping; `word_wrap_line` later transfers the field into `textwrap::Options`.


##### `RtOptions::word_splitter`  (lines 650–655)

```
fn word_splitter(self, word_splitter: textwrap::WordSplitter) -> RtOptions<'a>
```

**Purpose**: Sets the per-word splitting strategy, such as hyphen splitting or no hyphenation. This controls how long tokens may be broken once selected for wrapping.

**Data flow**: Consumes `self`, replaces `word_splitter`, and returns the updated options.

**Call relations**: Used by callers and by `url_preserving_wrap_options`; `word_wrap_line` copies it into `textwrap::Options`.


##### `word_wrap_line`  (lines 659–730)

```
fn word_wrap_line(line: &'a Line<'a>, width_or_options: O) -> Vec<Line<'a>>
```

**Purpose**: Wraps a single styled `Line` using standard `textwrap` behavior while preserving span styles and applying styled initial/subsequent indents. It is the core non-URL-aware wrapper.

**Data flow**: Flattens the input line into a `String` plus span byte bounds via `flatten_line`, converts `RtOptions` into `textwrap::Options`, computes the first wrapped range with width reduced by `initial_indent.width()`, and if empty returns a clone of the initial indent. Otherwise it slices the original spans for the first range with `slice_line_spans`, patches each span with the parent line style, prepends the initial indent, and pushes that line. It then skips leading spaces after the first range, computes remaining wrapped ranges using width reduced by `subsequent_indent.width()`, slices and styles each continuation range, prepends the subsequent indent, and returns `Vec<Line<'a>>`.

**Call relations**: This is the standard wrapping primitive used directly by many renderers and indirectly by `adaptive_wrap_line` for non-URL and URL-only cases. It depends on `wrap_ranges_trim` for source-range reconstruction and on span flatten/slice helpers for style preservation.

*Call graph*: calls 3 internal fn (flatten_line, slice_line_spans, wrap_ranges_trim); called by 20 (wrap_cell, render_stacked_field, wrap_cell, adaptive_wrap_line, ascii_space_separator_with_no_hyphenation_keeps_url_intact, break_words_false_allows_overflow_for_long_word, empty_initial_indent_subsequent_spaces, empty_input_yields_single_empty_line, hyphen_splitter_breaks_at_hyphen, indent_consumes_width_leaving_one_char_space (+10 more)); 4 external calls (into, new, new, vec!).


##### `MixedUrlWord::width`  (lines 739–741)

```
fn width(&self, text: &str) -> usize
```

**Purpose**: Computes the display width of a token slice represented by a `MixedUrlWord`. Width is measured in terminal columns, not bytes.

**Data flow**: Clones the stored `range`, indexes into the provided source `text`, passes the substring to `display_width`, and returns the resulting `usize`.

**Call relations**: Used by `split_mixed_url_word` and the mixed-token wrapping algorithm when deciding whether a piece fits on the current line.

*Call graph*: called by 1 (split_mixed_url_word); 2 external calls (display_width, clone).


##### `mixed_url_wrap_line`  (lines 744–781)

```
fn mixed_url_wrap_line(line: &'a Line<'a>, rt_opts: RtOptions<'a>) -> Vec<Line<'a>>
```

**Purpose**: Wraps a line containing both URL and non-URL tokens using the custom mixed-token algorithm. It preserves URL tokens intact while still allowing oversized non-URL tokens to split.

**Data flow**: Flattens the input line and span bounds, computes available widths after subtracting initial and subsequent indent widths, obtains wrapped source ranges from `mixed_url_wrap_ranges`, then for each range builds either an initial- or subsequent-indented output `Line`, slices the original spans with `slice_line_spans`, patches span styles with the parent line style, and collects the results. If no ranges were produced, it returns a single clone of the initial indent.

**Call relations**: Reached only from `adaptive_wrap_line` when URL and substantive prose coexist on the same line. It delegates the actual token-fitting logic to `mixed_url_wrap_ranges`.

*Call graph*: calls 3 internal fn (flatten_line, mixed_url_wrap_ranges, slice_line_spans); called by 1 (adaptive_wrap_line); 2 external calls (new, vec!).


##### `mixed_url_wrap_ranges`  (lines 783–877)

```
fn mixed_url_wrap_ranges(
    text: &str,
    initial_width: usize,
    subsequent_width: usize,
) -> Vec<Range<usize>>
```

**Purpose**: Computes source byte ranges for mixed URL/prose wrapping. It tokenizes on ASCII spaces, keeps URL tokens atomic, and greedily fills lines while resplitting oversized non-URL tokens as needed.

**Data flow**: Accepts flattened `text` plus separate widths for the first and continuation lines. It records leading-space width, tokenizes with `WordSeparator::AsciiSpace.find_words`, converts each non-empty token into `MixedUrlWord { range, is_url }`, then iterates through words while maintaining current line start/end, current line width, and current width limit. Each word may be expanded into smaller pieces by `split_mixed_url_word`; pieces are either appended to the current line if they fit, or cause the current line range to be finalized and a new line to begin. The function returns the accumulated `Vec<Range<usize>>`.

**Call relations**: Used exclusively by `mixed_url_wrap_line`. It is the heart of the adaptive mixed-content path and relies on `is_url_like_token` for classification and `split_mixed_url_word` for breaking long non-URL tokens.

*Call graph*: calls 2 internal fn (is_url_like_token, split_mixed_url_word); called by 1 (mixed_url_wrap_line); 1 external calls (new).


##### `split_mixed_url_word`  (lines 879–896)

```
fn split_mixed_url_word(text: &str, word: MixedUrlWord, line_limit: usize) -> Vec<MixedUrlWord>
```

**Purpose**: Breaks an oversized non-URL token into smaller pieces that fit within a line limit, while leaving URL tokens untouched. It uses `textwrap`’s low-level word-breaking logic for the split points.

**Data flow**: Takes source `text`, a `MixedUrlWord`, and `line_limit`. If the word is a URL or already fits, it returns a one-element vector containing the original word. Otherwise it constructs `textwrap::core::Word` from the source substring, iterates over `break_apart(line_limit.max(1))`, converts each piece back into a `MixedUrlWord` with adjusted byte ranges and `is_url = false`, and returns the pieces.

**Call relations**: Called by `mixed_url_wrap_ranges` whenever a non-URL token may need to be split to fit either the initial or continuation width.

*Call graph*: calls 1 internal fn (width); called by 1 (mixed_url_wrap_ranges); 3 external calls (new, from, vec!).


##### `flatten_line`  (lines 898–910)

```
fn flatten_line(line: &Line<'_>) -> (String, Vec<(Range<usize>, ratatui::style::Style)>)
```

**Purpose**: Converts a styled `Line` into a flat string plus byte ranges and styles for each original span. This creates the mapping needed to wrap text as plain content and then reconstruct styled slices.

**Data flow**: Iterates over `line.spans`, appends each span’s text to a `String`, tracks cumulative byte offsets, records `(start..end, span.style)` for each span, and returns `(flat, span_bounds)`.

**Call relations**: Used by both `word_wrap_line` and `mixed_url_wrap_line` before they compute wrapped ranges and slice the original spans back out.

*Call graph*: called by 2 (mixed_url_wrap_line, word_wrap_line); 2 external calls (new, new).


##### `LineInput::as_ref`  (lines 920–925)

```
fn as_ref(&self) -> &Line<'a>
```

**Purpose**: Provides a shared borrowed `&Line` view over either a borrowed or owned `LineInput`. It hides the ownership distinction from wrapping loops.

**Data flow**: Matches on `self` and returns a reference to the contained `Line` in either variant.

**Call relations**: Used by `adaptive_wrap_lines` and `word_wrap_lines` after converting heterogeneous inputs through `IntoLineInput`.


##### `Line::into_line_input`  (lines 946–948)

```
fn into_line_input(self) -> LineInput<'a>
```

**Purpose**: Converts line-like inputs into the internal `LineInput` enum so wrapping APIs can accept borrowed or owned values uniformly. The implementation covers `&Line`, `&mut Line`, and owned `Line` forms.

**Data flow**: Depending on the concrete impl, wraps the input as either `LineInput::Borrowed` or `LineInput::Owned` and returns it.

**Call relations**: Invoked implicitly by generic multi-line wrappers when iterating over line inputs of various ownership forms.

*Call graph*: 2 external calls (Borrowed, Owned).


##### `String::into_line_input`  (lines 952–954)

```
fn into_line_input(self) -> LineInput<'a>
```

**Purpose**: Allows owned `String` values to be passed directly into multi-line wrapping APIs. The string is converted into a ratatui `Line` first.

**Data flow**: Consumes the `String`, constructs `Line::from(self)`, wraps it as `LineInput::Owned`, and returns it.

**Call relations**: Used implicitly by `word_wrap_lines` and `adaptive_wrap_lines` when callers provide string collections.

*Call graph*: 2 external calls (from, Owned).


##### `str::into_line_input`  (lines 958–960)

```
fn into_line_input(self) -> LineInput<'a>
```

**Purpose**: Allows borrowed `&str` values to be passed directly into multi-line wrapping APIs. Each string slice becomes an owned `Line` wrapper.

**Data flow**: Converts the `&str` into `Line::from(self)`, wraps it as `LineInput::Owned`, and returns it.

**Call relations**: Used implicitly by generic wrapping loops for string-slice inputs.

*Call graph*: 2 external calls (from, Owned).


##### `Cow::into_line_input`  (lines 964–966)

```
fn into_line_input(self) -> LineInput<'a>
```

**Purpose**: Allows `Cow<str>` values to be wrapped through the same generic line-input path. This avoids forcing callers to normalize ownership first.

**Data flow**: Consumes the `Cow<str>`, converts it into `Line::from(self)`, wraps it as `LineInput::Owned`, and returns it.

**Call relations**: Participates in the generic input conversion used by multi-line wrappers.

*Call graph*: 2 external calls (from, Owned).


##### `Span::into_line_input`  (lines 970–972)

```
fn into_line_input(self) -> LineInput<'a>
```

**Purpose**: Allows a single styled `Span` to be treated as a one-line input to the wrapping APIs. The span is promoted into a `Line`.

**Data flow**: Consumes the `Span`, converts it into `Line::from(self)`, wraps it as `LineInput::Owned`, and returns it.

**Call relations**: Used implicitly when callers pass spans directly into generic wrapping functions.

*Call graph*: 2 external calls (from, Owned).


##### `Vec::into_line_input`  (lines 976–978)

```
fn into_line_input(self) -> LineInput<'a>
```

**Purpose**: Allows a vector of spans to be treated as one styled line for wrapping. This is convenient for callers assembling line content piecemeal.

**Data flow**: Consumes `Vec<Span<'a>>`, converts it into `Line::from(self)`, wraps it as `LineInput::Owned`, and returns it.

**Call relations**: Used by generic multi-line wrappers when callers provide span vectors instead of prebuilt `Line` values.

*Call graph*: 2 external calls (from, Owned).


##### `word_wrap_lines`  (lines 984–1008)

```
fn word_wrap_lines(lines: I, width_or_options: O) -> Vec<Line<'static>>
```

**Purpose**: Wraps a sequence of inputs using standard wrapping, applying the initial indent only once across the entire output and the subsequent indent everywhere after that. It returns owned `'static` lines suitable for storage and rendering.

**Data flow**: Converts `width_or_options` into `RtOptions`, iterates over the input sequence converting each item through `IntoLineInput`, chooses options that preserve the original initial indent only for the first overall line and replace it with `subsequent_indent` for later source lines, calls `word_wrap_line` for each, and appends owned copies into `Vec<Line<'static>>` via `push_owned_lines`.

**Call relations**: Used by higher-level renderers that need standard wrapping over multiple lines. It orchestrates repeated calls to `word_wrap_line` and ownership normalization.

*Call graph*: calls 2 internal fn (push_owned_lines, word_wrap_line); called by 8 (agent_markdown_cell_survives_insert_history_rewrap, e2e_stream_blockquote_wrap_preserves_green_style, display_lines, wrapped_details_lines, wrap_lines_accepts_borrowed_iterators, wrap_lines_accepts_str_slices, wrap_lines_applies_initial_indent_only_once, wrap_lines_without_indents_is_concat_of_single_wraps); 3 external calls (into_iter, into, new).


##### `word_wrap_lines_borrowed`  (lines 1011–1031)

```
fn word_wrap_lines_borrowed(lines: I, width_or_options: O) -> Vec<Line<'a>>
```

**Purpose**: Borrowing variant of multi-line standard wrapping that returns `Vec<Line<'a>>` instead of owning `'static` copies. It is mainly useful in tests and contexts where borrowed output is sufficient.

**Data flow**: Converts options into `RtOptions`, iterates over borrowed `&Line` inputs, applies the original initial indent only to the first overall line and substitutes `subsequent_indent` thereafter, extends an output vector with each `word_wrap_line` result, and returns the borrowed lines.

**Call relations**: Used by tests and any internal callers that can keep the original line storage alive while consuming wrapped output.

*Call graph*: calls 1 internal fn (word_wrap_line); called by 3 (word_wrap_does_not_split_words_simple_english, wrap_lines_borrowed_applies_initial_indent_only_once, wrap_lines_borrowed_without_indents_is_concat_of_single_wraps); 3 external calls (into_iter, into, new).


##### `slice_line_spans`  (lines 1033–1071)

```
fn slice_line_spans(
    original: &'a Line<'a>,
    span_bounds: &[(Range<usize>, ratatui::style::Style)],
    range: &Range<usize>,
) -> Line<'a>
```

**Purpose**: Extracts a byte-range slice from an original styled `Line`, preserving the styles of the intersecting source spans. It is the inverse mapping step after wrapping on flattened text.

**Data flow**: Accepts the original line, precomputed `span_bounds`, and a target byte `range`. It iterates over span bounds, skips spans entirely before the range, stops after spans entirely beyond it, computes overlap segments for intersecting spans, slices the corresponding substring from `original.spans[i].content`, wraps each slice as a borrowed `Span` with the original span style, and returns a new `Line` carrying the original line style and alignment.

**Call relations**: Used by both `word_wrap_line` and `mixed_url_wrap_line` to reconstruct styled wrapped lines from source byte ranges.

*Call graph*: called by 2 (mixed_url_wrap_line, word_wrap_line); 3 external calls (new, Borrowed, iter).


##### `tests::concat_line`  (lines 1082–1087)

```
fn concat_line(line: &Line) -> String
```

**Purpose**: Test helper that concatenates all span contents in a `Line` into a plain `String`. It makes assertions compare rendered text without caring about span boundaries.

**Data flow**: Iterates over `line.spans`, collects each span’s content into a single `String`, and returns it.

**Call relations**: Used throughout the module’s tests to simplify expected-output assertions.


##### `tests::trivial_unstyled_no_indents_wide_width`  (lines 1090–1095)

```
fn trivial_unstyled_no_indents_wide_width()
```

**Purpose**: Verifies that a short unstyled line remains a single line when the width is ample. It checks the simplest no-wrap case.

**Data flow**: Builds `Line::from("hello")`, wraps it with width 10, and asserts that the output length is 1 and the concatenated content is unchanged.

**Call relations**: Exercises `word_wrap_line` in the baseline path with no indents or style complications.

*Call graph*: calls 1 internal fn (word_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::simple_unstyled_wrap_narrow_width`  (lines 1098–1104)

```
fn simple_unstyled_wrap_narrow_width()
```

**Purpose**: Checks that ordinary prose wraps at spaces when the width is narrow. It confirms standard word-boundary behavior.

**Data flow**: Creates `"hello world"` as a `Line`, wraps at width 5, and asserts two output lines containing `hello` and `world`.

**Call relations**: Directly validates `word_wrap_line`’s standard wrapping behavior.

*Call graph*: calls 1 internal fn (word_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::simple_styled_wrap_preserves_styles`  (lines 1107–1119)

```
fn simple_styled_wrap_preserves_styles()
```

**Purpose**: Ensures wrapping preserves span styles across line boundaries. It specifically checks that a styled first span remains styled after wrapping.

**Data flow**: Builds a line from a red `"hello "` span plus an unstyled `"world"` span, wraps at width 6, and asserts both text segmentation and foreground-color preservation on the resulting spans.

**Call relations**: Exercises `word_wrap_line` together with `flatten_line` and `slice_line_spans` style reconstruction.

*Call graph*: calls 1 internal fn (word_wrap_line); 3 external calls (from, assert_eq!, vec!).


##### `tests::with_initial_and_subsequent_indents`  (lines 1122–1136)

```
fn with_initial_and_subsequent_indents()
```

**Purpose**: Verifies that initial and continuation indents are applied correctly and consume width as expected. It checks hanging-indent behavior over multiple wrapped lines.

**Data flow**: Constructs `RtOptions` with `- ` initial indent and two-space subsequent indent, wraps `"hello world foo"`, and asserts the prefixes and segmented content of all three output lines.

**Call relations**: Tests `word_wrap_line`’s indent-aware width calculations and line assembly.

*Call graph*: calls 2 internal fn (new, word_wrap_line); 3 external calls (from, assert!, assert_eq!).


##### `tests::empty_initial_indent_subsequent_spaces`  (lines 1139–1149)

```
fn empty_initial_indent_subsequent_spaces()
```

**Purpose**: Checks that an empty initial indent and non-empty subsequent indent behave sensibly. Continuation lines should still receive the configured prefix.

**Data flow**: Builds options with empty initial indent and four-space subsequent indent, wraps `"hello world foobar"`, and asserts that only continuation lines start with the spaces.

**Call relations**: Exercises `word_wrap_line`’s distinction between first-line and continuation indentation.

*Call graph*: calls 2 internal fn (new, word_wrap_line); 2 external calls (from, assert!).


##### `tests::empty_input_yields_single_empty_line`  (lines 1152–1157)

```
fn empty_input_yields_single_empty_line()
```

**Purpose**: Confirms that wrapping an empty line still yields one output line rather than zero. This preserves rendering invariants for empty content.

**Data flow**: Wraps `Line::from("")` at width 10 and asserts a single empty output line.

**Call relations**: Validates the empty-input branch in `word_wrap_line`.

*Call graph*: calls 1 internal fn (word_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::leading_spaces_preserved_on_first_line`  (lines 1160–1165)

```
fn leading_spaces_preserved_on_first_line()
```

**Purpose**: Ensures leading spaces in the source are preserved on the first wrapped line. This matters for indentation-sensitive display text.

**Data flow**: Wraps `"   hello"` at width 8 and asserts the single output line still begins with three spaces.

**Call relations**: Exercises the source-range mapping and first-line handling in `word_wrap_line`.

*Call graph*: calls 1 internal fn (word_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::multiple_spaces_between_words_dont_start_next_line_with_spaces`  (lines 1168–1174)

```
fn multiple_spaces_between_words_dont_start_next_line_with_spaces()
```

**Purpose**: Checks that extra spaces between words do not become leading spaces on the next wrapped line. Wrapping should skip inter-word padding at line starts.

**Data flow**: Wraps `"hello   world"` at width 8 and asserts the two output lines are `hello` and `world` without leading spaces on the second line.

**Call relations**: Validates the `skip_leading_spaces` logic in `word_wrap_line`.

*Call graph*: calls 1 internal fn (word_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::break_words_false_allows_overflow_for_long_word`  (lines 1177–1183)

```
fn break_words_false_allows_overflow_for_long_word()
```

**Purpose**: Confirms that disabling `break_words` leaves an overlong token intact even when it exceeds the width. Overflow is preferred to splitting in this mode.

**Data flow**: Builds options with width 5 and `break_words(false)`, wraps a long single token, and asserts the output is one unchanged line.

**Call relations**: Tests `word_wrap_line` with non-default `RtOptions` propagated into `textwrap`.

*Call graph*: calls 2 internal fn (new, word_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::hyphen_splitter_breaks_at_hyphen`  (lines 1186–1192)

```
fn hyphen_splitter_breaks_at_hyphen()
```

**Purpose**: Verifies that the default hyphen splitter allows wrapping at hyphens. This documents standard `textwrap` behavior for hyphenated words.

**Data flow**: Wraps `"hello-world"` at width 7 and asserts the output lines are `hello-` and `world`.

**Call relations**: Exercises `word_wrap_line` under default `WordSplitter::HyphenSplitter` behavior.

*Call graph*: calls 1 internal fn (word_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::indent_consumes_width_leaving_one_char_space`  (lines 1195–1205)

```
fn indent_consumes_width_leaving_one_char_space()
```

**Purpose**: Checks that very wide indents reduce available content width but still leave at least one column for text. This guards the `.max(1)` width floor.

**Data flow**: Builds options with width 4, initial indent `>>>>`, subsequent indent `--`, wraps `"hello"`, and asserts the resulting lines are `>>>>h`, `--el`, and `--lo`.

**Call relations**: Validates `word_wrap_line`’s saturating width subtraction and minimum-width logic.

*Call graph*: calls 2 internal fn (new, word_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::wide_unicode_wraps_by_display_width`  (lines 1208–1214)

```
fn wide_unicode_wraps_by_display_width()
```

**Purpose**: Ensures wrapping uses terminal display width rather than byte count or scalar count. Double-width emoji should consume two columns each.

**Data flow**: Wraps three emoji at width 4 and asserts they occupy two output lines with two emoji on the first line and one on the second.

**Call relations**: Exercises `word_wrap_line` through `textwrap`’s display-width handling.

*Call graph*: calls 1 internal fn (word_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::styled_split_within_span_preserves_style`  (lines 1217–1228)

```
fn styled_split_within_span_preserves_style()
```

**Purpose**: Verifies that splitting inside a single styled span preserves that style on both resulting fragments. It guards against style loss when slicing spans mid-span.

**Data flow**: Creates a red `"abcd"` span, wraps at width 2, and asserts both output spans remain red and contain `ab` and `cd` respectively.

**Call relations**: Tests `slice_line_spans` and style patching as used by `word_wrap_line`.

*Call graph*: calls 1 internal fn (word_wrap_line); 3 external calls (from, assert_eq!, vec!).


##### `tests::wrap_lines_applies_initial_indent_only_once`  (lines 1231–1246)

```
fn wrap_lines_applies_initial_indent_only_once()
```

**Purpose**: Checks that multi-line wrapping applies the initial indent only to the very first output line across all inputs. Later wrapped pieces should use the subsequent indent.

**Data flow**: Builds indented options, wraps two input lines with `word_wrap_lines`, collects rendered strings, and asserts only the first output starts with `- ` while all later outputs start with two spaces.

**Call relations**: Exercises `word_wrap_lines`’s cross-line indent orchestration.

*Call graph*: calls 2 internal fn (new, word_wrap_lines); 3 external calls (from, assert!, vec!).


##### `tests::wrap_lines_without_indents_is_concat_of_single_wraps`  (lines 1249–1254)

```
fn wrap_lines_without_indents_is_concat_of_single_wraps()
```

**Purpose**: Verifies that multi-line wrapping without indents behaves like concatenating individually wrapped lines. It checks the simplest aggregate case.

**Data flow**: Wraps two short lines with `word_wrap_lines` at width 10 and asserts the output strings are exactly `hello` and `world!`.

**Call relations**: Tests `word_wrap_lines` in the no-indent path.

*Call graph*: calls 1 internal fn (word_wrap_lines); 2 external calls (assert_eq!, vec!).


##### `tests::wrap_lines_borrowed_applies_initial_indent_only_once`  (lines 1257–1270)

```
fn wrap_lines_borrowed_applies_initial_indent_only_once()
```

**Purpose**: Checks the borrowed multi-line wrapper’s indent semantics. It should mirror the owned variant’s one-time initial indent behavior.

**Data flow**: Builds indented options, wraps an array iterator with `word_wrap_lines_borrowed`, collects rendered strings, and asserts only the first output line uses the initial indent.

**Call relations**: Exercises `word_wrap_lines_borrowed` specifically.

*Call graph*: calls 2 internal fn (new, word_wrap_lines_borrowed); 2 external calls (from, assert!).


##### `tests::wrap_lines_borrowed_without_indents_is_concat_of_single_wraps`  (lines 1273–1278)

```
fn wrap_lines_borrowed_without_indents_is_concat_of_single_wraps()
```

**Purpose**: Verifies the borrowed multi-line wrapper’s basic no-indent behavior. It should preserve each short line unchanged.

**Data flow**: Wraps two borrowed lines at width 10 and asserts the rendered outputs are `hello` and `world!`.

**Call relations**: Tests `word_wrap_lines_borrowed` in the simplest path.

*Call graph*: calls 1 internal fn (word_wrap_lines_borrowed); 2 external calls (from, assert_eq!).


##### `tests::wrap_lines_accepts_borrowed_iterators`  (lines 1281–1286)

```
fn wrap_lines_accepts_borrowed_iterators()
```

**Purpose**: Confirms that the generic owned-output wrapper accepts iterators of borrowed `Line` values. This validates the `IntoLineInput` abstraction.

**Data flow**: Passes an array of `Line` values into `word_wrap_lines`, collects rendered strings, and asserts the expected wrapped output sequence.

**Call relations**: Exercises the `IntoLineInput` implementations together with `word_wrap_lines`.

*Call graph*: calls 1 internal fn (word_wrap_lines); 2 external calls (from, assert_eq!).


##### `tests::wrap_lines_accepts_str_slices`  (lines 1289–1294)

```
fn wrap_lines_accepts_str_slices()
```

**Purpose**: Confirms that `&str` inputs can be wrapped directly through the generic multi-line API. This is another `IntoLineInput` coverage test.

**Data flow**: Wraps an array of string slices with `word_wrap_lines` at width 12 and asserts the expected rendered strings.

**Call relations**: Validates the `str::into_line_input` implementation in the context of `word_wrap_lines`.

*Call graph*: calls 1 internal fn (word_wrap_lines); 1 external calls (assert_eq!).


##### `tests::line_height_counts_double_width_emoji`  (lines 1297–1302)

```
fn line_height_counts_double_width_emoji()
```

**Purpose**: Checks that line count changes appropriately with widths when content contains double-width emoji. It is a compact regression test for display-width accounting.

**Data flow**: Creates a line from three emoji and asserts the number of wrapped lines at widths 4, 2, and 6.

**Call relations**: Indirectly exercises `word_wrap_line`’s width handling.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::word_wrap_does_not_split_words_simple_english`  (lines 1305–1321)

```
fn word_wrap_does_not_split_words_simple_english()
```

**Purpose**: Verifies that ordinary English prose wraps at spaces rather than splitting words mid-token. It uses a longer paragraph to exercise repeated wrapping.

**Data flow**: Wraps a sample paragraph with `word_wrap_lines_borrowed` at width 40, joins the output with newlines, and asserts the exact expected wrapped text.

**Call relations**: Tests standard prose behavior through the borrowed multi-line wrapper.

*Call graph*: calls 1 internal fn (word_wrap_lines_borrowed); 2 external calls (from, assert_eq!).


##### `tests::ascii_space_separator_with_no_hyphenation_keeps_url_intact`  (lines 1324–1340)

```
fn ascii_space_separator_with_no_hyphenation_keeps_url_intact()
```

**Purpose**: Demonstrates that ASCII-space tokenization plus no hyphenation and `break_words(false)` keeps a long URL on one line. This is the behavior adaptive wrapping relies on for URL-only lines.

**Data flow**: Builds explicit URL-preserving options, wraps a long URL at width 24, and asserts a single unchanged output line.

**Call relations**: Exercises `word_wrap_line` under the same option pattern produced by `url_preserving_wrap_options`.

*Call graph*: calls 2 internal fn (new, word_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::text_contains_url_like_matches_expected_tokens`  (lines 1343–1360)

```
fn text_contains_url_like_matches_expected_tokens()
```

**Purpose**: Checks that the URL heuristic accepts representative positive examples, including schemes, bare domains, localhost, IPv4, and punctuation-wrapped URLs.

**Data flow**: Iterates over a fixed array of positive strings and asserts `text_contains_url_like(text)` for each.

**Call relations**: Directly validates the text-level URL detector and, transitively, the token heuristics beneath it.

*Call graph*: 1 external calls (assert!).


##### `tests::text_contains_url_like_rejects_non_urls`  (lines 1363–1378)

```
fn text_contains_url_like_rejects_non_urls()
```

**Purpose**: Checks that the URL heuristic rejects representative false positives such as file paths, key-value strings, and plain dotted words. This keeps adaptive wrapping conservative.

**Data flow**: Iterates over a fixed array of negative strings and asserts `!text_contains_url_like(text)` for each.

**Call relations**: Directly validates the rejection side of the URL heuristic.

*Call graph*: 1 external calls (assert!).


##### `tests::line_contains_url_like_checks_across_spans`  (lines 1381–1389)

```
fn line_contains_url_like_checks_across_spans()
```

**Purpose**: Ensures URL detection works when the URL is embedded across styled spans in a `Line`. Flattening should not lose the token.

**Data flow**: Builds a multi-span line containing prose, a cyan URL span, and trailing prose, then asserts `line_contains_url_like(&line)`.

**Call relations**: Exercises `line_contains_url_like`’s span concatenation behavior.

*Call graph*: 3 external calls (from, assert!, vec!).


##### `tests::line_has_mixed_url_and_non_url_tokens_detects_prose_plus_url`  (lines 1392–1395)

```
fn line_has_mixed_url_and_non_url_tokens_detects_prose_plus_url()
```

**Purpose**: Checks that mixed-content detection recognizes a line containing both prose and a URL. This is the branch condition for the custom mixed wrapper.

**Data flow**: Creates a plain line with prose plus URL and asserts `line_has_mixed_url_and_non_url_tokens(&line)`.

**Call relations**: Directly validates the mixed-content detector used by `adaptive_wrap_line`.

*Call graph*: 2 external calls (from, assert!).


##### `tests::line_has_mixed_url_and_non_url_tokens_ignores_pipe_prefix`  (lines 1398–1401)

```
fn line_has_mixed_url_and_non_url_tokens_ignores_pipe_prefix()
```

**Purpose**: Ensures decorative pipe prefixes do not count as substantive non-URL tokens. A line containing only a pipe marker and a URL should not be treated as mixed prose.

**Data flow**: Builds a line from a pipe-prefix span and a URL span, then asserts the mixed-content detector returns false.

**Call relations**: Exercises `is_decorative_marker_token` through `line_has_mixed_url_and_non_url_tokens`.

*Call graph*: 3 external calls (from, assert!, vec!).


##### `tests::line_has_mixed_url_and_non_url_tokens_ignores_ordered_list_marker`  (lines 1404–1407)

```
fn line_has_mixed_url_and_non_url_tokens_ignores_ordered_list_marker()
```

**Purpose**: Ensures ordered-list markers like `1.` are ignored when deciding whether a line mixes URL and prose. This avoids unnecessary mixed-token wrapping for list items that are just a URL.

**Data flow**: Creates `"1. https://example.com/path"` and asserts the mixed-content detector returns false.

**Call relations**: Validates the ordered-list-marker branch in the non-URL token heuristic.

*Call graph*: 2 external calls (from, assert!).


##### `tests::text_contains_url_like_accepts_custom_scheme_with_separator`  (lines 1410–1412)

```
fn text_contains_url_like_accepts_custom_scheme_with_separator()
```

**Purpose**: Checks that custom schemes with `://` are accepted even if the `url` crate would reject them. This covers the fallback scheme-prefix validator.

**Data flow**: Asserts `text_contains_url_like("myapp://open/some/path")`.

**Call relations**: Exercises `has_valid_scheme_prefix` through the public detector.

*Call graph*: 1 external calls (assert!).


##### `tests::text_contains_url_like_rejects_invalid_ports`  (lines 1415–1418)

```
fn text_contains_url_like_rejects_invalid_ports()
```

**Purpose**: Ensures bare URL detection rejects malformed ports. This prevents strings like `localhost:99999/path` from being treated as URLs.

**Data flow**: Asserts that `text_contains_url_like` returns false for examples with out-of-range and non-numeric ports.

**Call relations**: Validates `is_valid_port` through the public detector.

*Call graph*: 1 external calls (assert!).


##### `tests::adaptive_wrap_line_keeps_long_url_like_token_intact`  (lines 1421–1429)

```
fn adaptive_wrap_line_keeps_long_url_like_token_intact()
```

**Purpose**: Verifies that adaptive wrapping leaves a long URL-like token unsplit even when it exceeds the width. This is the core user-visible URL-preservation behavior.

**Data flow**: Wraps a long bare-domain URL-like string with `adaptive_wrap_line` at width 20 and asserts a single unchanged output line.

**Call relations**: Exercises the URL-only branch of `adaptive_wrap_line`.

*Call graph*: calls 2 internal fn (new, adaptive_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::adaptive_wrap_line_preserves_default_behavior_for_non_url_tokens`  (lines 1432–1439)

```
fn adaptive_wrap_line_preserves_default_behavior_for_non_url_tokens()
```

**Purpose**: Checks that adaptive wrapping does not disable ordinary splitting for long non-URL tokens. Non-URL content should still wrap using default behavior.

**Data flow**: Wraps a long underscore-delimited non-URL token with `adaptive_wrap_line` at width 20 and asserts that multiple output lines are produced.

**Call relations**: Exercises the non-URL branch of `adaptive_wrap_line`, which delegates to `word_wrap_line` unchanged.

*Call graph*: calls 2 internal fn (new, adaptive_wrap_line); 2 external calls (from, assert!).


##### `tests::adaptive_wrap_line_mixed_line_keeps_regular_words_intact`  (lines 1442–1453)

```
fn adaptive_wrap_line_mixed_line_keeps_regular_words_intact()
```

**Purpose**: Verifies the mixed-content wrapper keeps the URL intact while still wrapping surrounding prose at word boundaries. It checks the custom mixed-token algorithm’s main success case.

**Data flow**: Wraps a prose-plus-URL sentence with `adaptive_wrap_line` at width 36, joins the output with newlines, and asserts the exact expected wrapped text.

**Call relations**: Exercises the mixed-content branch of `adaptive_wrap_line` and `mixed_url_wrap_line`.

*Call graph*: calls 2 internal fn (new, adaptive_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::adaptive_wrap_line_mixed_line_wraps_long_non_url_token`  (lines 1456–1471)

```
fn adaptive_wrap_line_mixed_line_wraps_long_non_url_token()
```

**Purpose**: Checks that on mixed URL/prose lines, an oversized non-URL token can still be split while the URL remains present intact. This distinguishes the mixed wrapper from the URL-only path.

**Data flow**: Builds a line containing prose, a short URL, and a long non-URL token, wraps it adaptively at width 24, and asserts some output line still contains the URL while no output line contains the entire long token unsplit.

**Call relations**: Exercises `mixed_url_wrap_ranges` and `split_mixed_url_word` through `adaptive_wrap_line`.

*Call graph*: calls 2 internal fn (new, adaptive_wrap_line); 3 external calls (from, assert!, format!).


##### `tests::adaptive_wrap_line_mixed_line_counts_leading_spaces_before_first_word`  (lines 1474–1486)

```
fn adaptive_wrap_line_mixed_line_counts_leading_spaces_before_first_word()
```

**Purpose**: Ensures the mixed-content wrapper accounts for leading spaces on the first output line when splitting long non-URL tokens. This guards a subtle width-calculation edge case.

**Data flow**: Wraps a line with six leading spaces, a long non-URL token, and a URL using adaptive wrapping with a matching subsequent indent, then asserts the first two rendered lines match the expected split positions.

**Call relations**: Exercises the leading-space accounting logic inside `mixed_url_wrap_ranges`.

*Call graph*: calls 2 internal fn (new, adaptive_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::adaptive_wrap_line_mixed_line_resplits_long_token_for_continuation_width`  (lines 1489–1505)

```
fn adaptive_wrap_line_mixed_line_resplits_long_token_for_continuation_width()
```

**Purpose**: Checks that a long non-URL token may need to be split differently once continuation lines have a narrower effective width due to indent. The mixed wrapper should resplit for the new limit.

**Data flow**: Wraps a long token followed by a URL with adaptive wrapping at width 10 and a four-space subsequent indent, then asserts the first three rendered lines match the expected continuation-width splits.

**Call relations**: Exercises the branch in `mixed_url_wrap_ranges` that resplits pending non-URL pieces for continuation widths.

*Call graph*: calls 2 internal fn (new, adaptive_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::map_owned_wrapped_line_to_range_recovers_on_non_prefix_mismatch`  (lines 1508–1513)

```
fn map_owned_wrapped_line_to_range_recovers_on_non_prefix_mismatch()
```

**Purpose**: Verifies that owned-line range mapping returns the matched prefix rather than failing catastrophically when a later character mismatches. This protects against partial synthetic output mismatches.

**Data flow**: Calls `map_owned_wrapped_line_to_range("hello world", 0, "helloX", "")` and asserts the returned range is `0..5`.

**Call relations**: Directly tests the mismatch-recovery behavior of the owned-line mapper.

*Call graph*: calls 1 internal fn (map_owned_wrapped_line_to_range); 1 external calls (assert_eq!).


##### `tests::borrowed_slice_range_rejects_slices_outside_source_text`  (lines 1516–1524)

```
fn borrowed_slice_range_rejects_slices_outside_source_text()
```

**Purpose**: Checks that pointer-based range recovery rejects slices from unrelated allocations and that the owned-line fallback can still recover a sensible range. This guards against unsafe assumptions about borrowed slices.

**Data flow**: Creates an external `String`, asserts `borrowed_slice_range(text, &external)` is `None`, then maps the same content with `map_owned_wrapped_line_to_range` and asserts `0..4`.

**Call relations**: Exercises both the rejection path in `borrowed_slice_range` and the fallback path in `map_owned_wrapped_line_to_range`.

*Call graph*: calls 1 internal fn (map_owned_wrapped_line_to_range); 2 external calls (from, assert_eq!).


##### `tests::map_owned_wrapped_line_to_range_indent_coincides_with_source`  (lines 1527–1542)

```
fn map_owned_wrapped_line_to_range_indent_coincides_with_source()
```

**Purpose**: Verifies that synthetic indent prefixes are stripped before source matching even when the source begins with the same characters. This prevents overconsuming source bytes.

**Data flow**: Simulates a wrapped line with synthetic `- ` indent against source text beginning with `-`, maps it back to source bytes, and asserts the full expected range `0..10`.

**Call relations**: Directly tests a regression in `map_owned_wrapped_line_to_range` around indent-prefix ambiguity.

*Call graph*: calls 1 internal fn (map_owned_wrapped_line_to_range); 1 external calls (assert_eq!).


##### `tests::wrap_ranges_indent_prefix_coincides_with_source_char`  (lines 1545–1568)

```
fn wrap_ranges_indent_prefix_coincides_with_source_char()
```

**Purpose**: End-to-end regression test ensuring `wrap_ranges` reconstructs the full source text when indent prefixes share characters with the source. It validates the mapper in realistic wrapped output.

**Data flow**: Wraps a list-item string with matching initial and subsequent indents, rebuilds the source text by walking the returned ranges with cursor progression, and asserts the rebuilt text equals the original.

**Call relations**: Exercises `wrap_ranges` together with owned-line mapping under an indent-prefix collision scenario.

*Call graph*: calls 1 internal fn (wrap_ranges); 3 external calls (new, assert!, assert_eq!).


##### `tests::map_owned_wrapped_line_to_range_repro_overconsumes_repeated_prefix_patterns`  (lines 1571–1594)

```
fn map_owned_wrapped_line_to_range_repro_overconsumes_repeated_prefix_patterns()
```

**Purpose**: Checks that the owned-line mapper does not overconsume source bytes when repeated prefix patterns appear in both source and synthetic indent. It guards against a subtle repeated-pattern bug.

**Data flow**: Uses `textwrap` to produce a wrapped line from `"- - foo"` with `- ` indents, maps the first wrapped line back to source, computes the expected maximum mapped length after stripping the synthetic prefix, and asserts the mapped length does not exceed that maximum.

**Call relations**: Directly validates a regression scenario for `map_owned_wrapped_line_to_range`.

*Call graph*: calls 1 internal fn (map_owned_wrapped_line_to_range); 4 external calls (assert!, panic!, new, wrap).


##### `tests::wrap_ranges_recovers_with_non_space_indents`  (lines 1597–1634)

```
fn wrap_ranges_recovers_with_non_space_indents()
```

**Purpose**: Ensures `wrap_ranges` can reconstruct the full source text even when `textwrap` emits owned lines due to non-space indent prefixes. This covers another realistic owned-output case.

**Data flow**: Wraps a sentence with `* ` initial indent and two-space subsequent indent, asserts that some wrapped lines are owned, rebuilds the source text from the returned ranges using cursor progression, and asserts exact equality with the original text.

**Call relations**: Exercises `wrap_ranges` and the owned-line mapper under non-space indent conditions.

*Call graph*: calls 1 internal fn (wrap_ranges); 5 external calls (new, assert!, assert_eq!, new, wrap).


##### `tests::wrap_ranges_trim_handles_owned_lines_with_penalty_char`  (lines 1637–1656)

```
fn wrap_ranges_trim_handles_owned_lines_with_penalty_char()
```

**Purpose**: Verifies that trimmed range reconstruction works when owned wrapped lines include inserted penalty characters from custom splitting. The reconstructed source should still be exact.

**Data flow**: Defines a custom splitter that allows breaks at every character, wraps a long token with `wrap_ranges_trim`, rebuilds the source by concatenating the returned ranges, and asserts both exact reconstruction and that multiple ranges were produced.

**Call relations**: Directly tests `wrap_ranges_trim`’s handling of owned lines with synthesized penalty characters.

*Call graph*: calls 1 internal fn (wrap_ranges_trim); 4 external calls (new, assert!, assert_eq!, Custom).


### Streaming and scrollable wrapped views
These components apply wrapping incrementally or cache wrapped lines into a scroll model for long text and diff displays.

### `tui/src/live_wrap.rs`

`util` · `cross-cutting during streamed text rendering`

This file defines a minimal streaming wrapper around Unicode display width. `Row` is the output unit: a `String` plus an `explicit_break` flag indicating whether the row ended because of an actual newline rather than a hard wrap. `RowBuilder` maintains three pieces of mutable state: `target_width`, a `current_line` buffer for the still-open logical line, and a `rows` vector containing completed wrapped rows from previous fragments and explicit breaks.

The core ingestion path is `push_fragment`. It scans the incoming fragment for `\n`, appends non-newline slices into `current_line`, flushes on each newline via `flush_current_line(true)`, and after the final slice calls `wrap_current_line` so overlong buffered content is split into width-bounded rows. `wrap_current_line` repeatedly calls `take_prefix_by_width` to peel off the largest fitting prefix; fully fitting trailing content stays buffered so later fragments can continue the same logical line. `flush_current_line` finalizes the current logical line and has a subtle boundary case: if a newline arrives exactly at a width boundary, it emits an empty explicit-break row so fragmentation remains invariant.

`set_width` rewraps all accumulated content by reconstructing the logical text from committed rows plus the current buffer and feeding it back through `push_fragment`. `display_rows` includes the current partial line for rendering, while `drain_commit_ready` removes the oldest committed rows once the visible row count exceeds a caller-specified retention limit. Width calculations use `unicode_width`, so emoji and CJK characters consume the correct number of terminal cells.

#### Function details

##### `Row::width`  (lines 13–15)

```
fn width(&self) -> usize
```

**Purpose**: Returns the display width of a wrapped row’s text.

**Data flow**: Measures `self.text` with `UnicodeWidthStr::width` and returns the resulting `usize`.

**Call relations**: Used by tests and any caller that needs to verify wrapped rows fit the target width.


##### `RowBuilder::new`  (lines 30–36)

```
fn new(target_width: usize) -> Self
```

**Purpose**: Creates a new incremental wrapper with a minimum width of one cell.

**Data flow**: Takes `target_width`, clamps it with `max(1)`, initializes `current_line` to an empty `String` and `rows` to an empty `Vec<Row>`, and returns the new builder.

**Call relations**: Used by rendering code and tests to start a fresh wrapping session.

*Call graph*: called by 6 (fragmentation_invariance_long_token, newline_splits_rows, rewrap_on_width_change, rows_do_not_exceed_width_ascii, rows_do_not_exceed_width_emoji_cjk, live_001_commit_on_overflow); 2 external calls (new, new).


##### `RowBuilder::width`  (lines 38–40)

```
fn width(&self) -> usize
```

**Purpose**: Returns the current target wrap width.

**Data flow**: Reads and returns `self.target_width`.

**Call relations**: Simple accessor for callers tracking current wrap settings.


##### `RowBuilder::set_width`  (lines 42–55)

```
fn set_width(&mut self, width: usize)
```

**Purpose**: Changes the target width and rewraps all accumulated content to match the new width.

**Data flow**: Clamps the new width to at least one, drains all committed rows while reconstructing their text and explicit newlines into a temporary string, appends the current partial line, clears `current_line`, then feeds the reconstructed text back through `push_fragment` to rebuild `rows` and `current_line` under the new width.

**Call relations**: Used when terminal width changes after content has already been accumulated.

*Call graph*: calls 1 internal fn (push_fragment); 1 external calls (new).


##### `RowBuilder::push_fragment`  (lines 58–77)

```
fn push_fragment(&mut self, fragment: &str)
```

**Purpose**: Appends a streamed text fragment, which may contain embedded newlines, into the wrapper state.

**Data flow**: Returns immediately for an empty fragment; otherwise scans `fragment.char_indices()`, appends non-newline slices into `current_line`, calls `flush_current_line(true)` on each newline, then appends any trailing slice and calls `wrap_current_line()` so overlong buffered content is split into committed rows.

**Call relations**: This is the main ingestion method used by streaming renderers and by `set_width` during rewrap.

*Call graph*: calls 2 internal fn (flush_current_line, wrap_current_line); called by 1 (set_width).


##### `RowBuilder::end_line`  (lines 80–82)

```
fn end_line(&mut self)
```

**Purpose**: Explicitly terminates the current logical line as if a newline had been received.

**Data flow**: Calls `flush_current_line(true)` with no return value.

**Call relations**: Used by callers that want to finalize a line boundary without embedding `\n` in the fragment stream.

*Call graph*: calls 1 internal fn (flush_current_line).


##### `RowBuilder::rows`  (lines 85–87)

```
fn rows(&self) -> &[Row]
```

**Purpose**: Returns the committed wrapped rows accumulated so far, excluding any still-buffered partial line.

**Data flow**: Returns a shared slice reference to `self.rows`.

**Call relations**: Used by callers and tests that only want finalized rows.


##### `RowBuilder::display_rows`  (lines 90–99)

```
fn display_rows(&self) -> Vec<Row>
```

**Purpose**: Returns the rows suitable for immediate display, including the current partial line if one exists.

**Data flow**: Clones `self.rows` into a new vector, appends a synthetic non-explicit `Row` built from `current_line` when that buffer is non-empty, and returns the vector.

**Call relations**: Used by renderers that need to show both committed and in-progress content.


##### `RowBuilder::drain_commit_ready`  (lines 103–115)

```
fn drain_commit_ready(&mut self, max_keep: usize) -> Vec<Row>
```

**Purpose**: Drains the oldest committed rows once the total display row count exceeds a retention limit.

**Data flow**: Computes `display_count` as committed rows plus one if `current_line` is non-empty; if that count is within `max_keep`, returns an empty vector; otherwise computes how many committed rows can be removed, removes that many from the front of `self.rows`, collects them into a new vector, and returns the drained rows.

**Call relations**: Used by scrolling/streaming consumers that want to commit old rows while keeping only a bounded visible tail.

*Call graph*: 2 external calls (new, with_capacity).


##### `RowBuilder::flush_current_line`  (lines 117–141)

```
fn flush_current_line(&mut self, explicit_break: bool)
```

**Purpose**: Finalizes the current logical line, wrapping any buffered content first and then recording an explicit line break when requested.

**Data flow**: Calls `wrap_current_line()` to emit any full-width wrapped rows; if `explicit_break` is true and `current_line` is empty, pushes an empty `Row { text: "", explicit_break: true }` to preserve boundary semantics; otherwise swaps out the remaining `current_line` into a new explicit-break row; finally clears `current_line`.

**Call relations**: Called by `push_fragment` on newline boundaries and by `end_line`.

*Call graph*: calls 1 internal fn (wrap_current_line); called by 2 (end_line, push_fragment); 2 external calls (new, swap).


##### `RowBuilder::wrap_current_line`  (lines 143–177)

```
fn wrap_current_line(&mut self)
```

**Purpose**: Moves as much buffered content as necessary from `current_line` into committed wrapped rows while leaving any final fitting suffix buffered for future fragments.

**Data flow**: Loops until `current_line` is empty or fully fits; each iteration calls `take_prefix_by_width(&current_line, target_width)`, handles the pathological `taken == 0` case by forcing one scalar into a row to avoid infinite loops, breaks when the suffix is empty because the whole line fits, or otherwise pushes the fitting prefix as a non-explicit row and replaces `current_line` with the suffix.

**Call relations**: Used internally after fragment ingestion and before explicit line flushes.

*Call graph*: calls 1 internal fn (take_prefix_by_width); called by 2 (flush_current_line, push_fragment).


##### `take_prefix_by_width`  (lines 182–202)

```
fn take_prefix_by_width(text: &str, max_cols: usize) -> (String, &str, usize)
```

**Purpose**: Splits a string into the largest prefix whose visible width does not exceed a maximum number of columns.

**Data flow**: Returns `(String::new(), text, 0)` for zero width or empty input; otherwise scans `text.char_indices()`, accumulates Unicode character widths with `UnicodeWidthChar::width`, stops before overflow or exactly at `max_cols`, then returns `(prefix_string, suffix_str, prefix_width)`.

**Call relations**: Used by `RowBuilder::wrap_current_line` and by other rendering code that needs width-bounded string prefixes.

*Call graph*: called by 2 (render_lines, wrap_current_line); 2 external calls (new, width).


##### `tests::rows_do_not_exceed_width_ascii`  (lines 210–227)

```
fn rows_do_not_exceed_width_ascii()
```

**Purpose**: Checks that ASCII input is wrapped into committed rows that do not exceed the target width.

**Data flow**: Creates a `RowBuilder` of width 10, pushes a long ASCII fragment, clones committed rows, and compares them to the expected wrapped rows.

**Call relations**: Basic wrapping correctness test.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::rows_do_not_exceed_width_emoji_cjk`  (lines 230–245)

```
fn rows_do_not_exceed_width_emoji_cjk()
```

**Purpose**: Checks that wrapping respects double-width emoji and CJK characters.

**Data flow**: Creates a width-6 builder, pushes a fragment containing emoji and CJK text, clones committed rows, and compares them to the expected first wrapped row.

**Call relations**: Unicode-width correctness test.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::fragmentation_invariance_long_token`  (lines 248–262)

```
fn fragmentation_invariance_long_token()
```

**Purpose**: Verifies that wrapping the same text in one chunk or many smaller chunks produces identical committed rows.

**Data flow**: Wraps a long token once as a whole and once in 3-character chunks using separate builders, clones both row vectors, and compares them for equality.

**Call relations**: Regression test for incremental-stream invariance.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::newline_splits_rows`  (lines 265–273)

```
fn newline_splits_rows()
```

**Purpose**: Checks that embedded newlines create explicit-break rows and start a new logical line.

**Data flow**: Creates a builder, pushes `hello\nworld`, gets `display_rows`, and asserts at least one row has `explicit_break`, the first row text is `hello`, and some row starts with `world`.

**Call relations**: Covers newline handling and explicit-break semantics.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, assert_eq!).


##### `tests::rewrap_on_width_change`  (lines 276–284)

```
fn rewrap_on_width_change()
```

**Purpose**: Checks that changing the target width rewraps existing content so all committed rows fit the new width.

**Data flow**: Creates a width-10 builder, pushes text, asserts some rows exist, calls `set_width(5)`, then asserts every committed row’s width is at most 5.

**Call relations**: Covers the rewrap path in `set_width`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


### `cloud-tasks/src/scrollable_diff.rs`

`domain_logic` · `request handling`

This file defines two tightly coupled types: `ScrollViewState`, which stores the current vertical offset and known geometry (`scroll`, `viewport_h`, `content_h`), and `ScrollableDiff`, which owns both the original text lines and a cached wrapped representation. The wrapped cache is rebuilt only when width changes or content is replaced, so callers are expected to call `set_content` and then `set_width` when the display area changes.

The key behavior lives in `rewrap`. It iterates raw lines, normalizes tabs to four spaces, preserves empty lines, and wraps by display width using `unicode_width` so wide Unicode characters count correctly. It prefers soft breaks at whitespace and selected punctuation, tracked via `last_soft_idx`; if no soft break exists, it hard-wraps the current accumulated line. It also treats embedded `\n` characters inside a raw string as explicit line breaks. Alongside each wrapped output line, it records the originating raw line index in `wrapped_src_idx`, which lets higher-level rendering recover semantic context from wrapped display rows.

Scroll state is always clamped against `content_h - viewport_h`, using saturating arithmetic so shrinking content or viewport never underflows. Width `0` is a special case: wrapping is disabled and raw lines are copied directly. `percent_scrolled` reports the visible bottom edge as a percentage of total content, but intentionally returns `None` when geometry is incomplete or scrolling is unnecessary.

#### Function details

##### `ScrollViewState::clamp`  (lines 13–18)

```
fn clamp(&mut self)
```

**Purpose**: Constrains the current scroll offset so it never points past the last valid top row for the known content and viewport heights. This is the invariant keeper used whenever geometry changes.

**Data flow**: Reads `self.content_h`, `self.viewport_h`, and `self.scroll`; computes `max_scroll` with `saturating_sub`; if `scroll` exceeds that maximum, rewrites `self.scroll` in place. It returns no value and only mutates the struct.

**Call relations**: This is invoked after viewport or wrap geometry changes so stale scroll positions are corrected immediately. `ScrollableDiff::set_width` uses it after rebuilding wrapped content, and `ScrollableDiff::set_viewport` uses it after changing visible height.

*Call graph*: called by 2 (set_viewport, set_width).


##### `ScrollableDiff::new`  (lines 35–37)

```
fn new() -> Self
```

**Purpose**: Constructs an empty scrollable text buffer with no content, no cached wrapping, and default scroll geometry. It is just the explicit constructor for the type.

**Data flow**: Takes no arguments and delegates to `Default` to produce a `ScrollableDiff` whose vectors are empty, `wrap_cols` is `None`, and `state` is zeroed. It returns that new instance.

**Call relations**: Used by callers that need a fresh local diff/message viewer before content is loaded. It does not perform wrapping itself; later calls to `set_content` and `set_width` establish usable state.

*Call graph*: called by 1 (new); 1 external calls (default).


##### `ScrollableDiff::set_content`  (lines 40–47)

```
fn set_content(&mut self, lines: Vec<String>)
```

**Purpose**: Replaces the underlying raw text lines and invalidates all cached wrapping derived from the previous content. It deliberately postpones rewrapping until width is supplied again.

**Data flow**: Consumes a `Vec<String>` of new raw lines, stores it into `self.raw`, clears `self.wrapped` and `self.wrapped_src_idx`, resets `self.state.content_h` to `0`, and sets `self.wrap_cols` to `None` to force a future rebuild. It returns no value.

**Call relations**: Called when higher-level UI logic swaps in a different diff or conversation body. Because it clears `wrap_cols`, even reusing the same width later will trigger `set_width` to rebuild the cache.

*Call graph*: called by 1 (apply_selection_to_fields).


##### `ScrollableDiff::set_width`  (lines 50–57)

```
fn set_width(&mut self, width: u16)
```

**Purpose**: Updates the active wrap width and rebuilds the wrapped-line cache only when the width actually changed. It also re-clamps scroll afterward so the current offset remains valid for the new content height.

**Data flow**: Reads the requested `width` and compares it to `self.wrap_cols`; if unchanged, it exits early. Otherwise it stores the new width, calls `rewrap(width)` to regenerate `wrapped`, `wrapped_src_idx`, and `state.content_h`, then mutates `state.scroll` via `state.clamp()`.

**Call relations**: This is the normal entry point after layout changes. It delegates all wrapping logic to `ScrollableDiff::rewrap` and then to `ScrollViewState::clamp` to preserve scroll invariants.

*Call graph*: calls 2 internal fn (clamp, rewrap).


##### `ScrollableDiff::set_viewport`  (lines 60–63)

```
fn set_viewport(&mut self, height: u16)
```

**Purpose**: Records the visible height of the scroll view and immediately adjusts scroll if the viewport shrink would otherwise leave the offset out of range.

**Data flow**: Takes a `height`, writes it into `self.state.viewport_h`, then mutates `self.state.scroll` indirectly through `self.state.clamp()`. It returns no value.

**Call relations**: Used by rendering code whenever the on-screen rectangle changes height. Unlike `set_width`, it does not rebuild wrapping because only vertical geometry changed.

*Call graph*: calls 1 internal fn (clamp).


##### `ScrollableDiff::wrapped_lines`  (lines 66–68)

```
fn wrapped_lines(&self) -> &[String]
```

**Purpose**: Exposes the cached wrapped display lines as an immutable slice for rendering. It assumes the caller has already synchronized width with `set_width`.

**Data flow**: Reads `self.wrapped` and returns `&[String]` referencing the internal cache without mutation.

**Call relations**: Rendering code consumes this slice to build styled output rows. It is paired with `wrapped_src_indices` when the renderer needs to map display rows back to original raw lines.

*Call graph*: called by 1 (style_conversation_lines).


##### `ScrollableDiff::wrapped_src_indices`  (lines 70–72)

```
fn wrapped_src_indices(&self) -> &[usize]
```

**Purpose**: Returns the per-display-line mapping back to the originating raw line index. This preserves semantic grouping after wrapping.

**Data flow**: Reads `self.wrapped_src_idx` and returns it as `&[usize]` without modifying state.

**Call relations**: Used alongside `wrapped_lines` by conversation rendering so wrapped continuations can still inspect the original unwrapped source line and detect headers, bullets, or code fences.

*Call graph*: called by 1 (style_conversation_lines).


##### `ScrollableDiff::raw_line_at`  (lines 74–76)

```
fn raw_line_at(&self, idx: usize) -> &str
```

**Purpose**: Fetches a raw source line by index, returning an empty string for out-of-range access instead of panicking. This gives renderers a forgiving lookup API.

**Data flow**: Takes `idx`, reads `self.raw.get(idx)`, converts the `String` to `&str` when present, and otherwise returns `""`. It does not mutate state.

**Call relations**: Conversation styling uses this to recover the original line corresponding to a wrapped display row. The empty-string fallback avoids defensive bounds checks in callers.

*Call graph*: called by 1 (style_conversation_lines).


##### `ScrollableDiff::scroll_by`  (lines 79–82)

```
fn scroll_by(&mut self, delta: i16)
```

**Purpose**: Moves the scroll position by a signed row delta while enforcing top and bottom bounds. Negative deltas scroll upward; positive deltas scroll downward.

**Data flow**: Reads `delta`, converts current `state.scroll` and `delta` to `i32`, adds them, clamps the result between `0` and `self.max_scroll()`, then writes the clamped value back to `self.state.scroll` as `u16`. It returns no value.

**Call relations**: This is the primitive scrolling operation. `page_by` delegates directly to it, and it relies on `max_scroll` for the lower geometry bound.

*Call graph*: calls 1 internal fn (max_scroll); called by 1 (page_by).


##### `ScrollableDiff::page_by`  (lines 85–87)

```
fn page_by(&mut self, delta: i16)
```

**Purpose**: Provides a semantic alias for larger scroll jumps, typically one viewport minus one row. Its behavior is intentionally identical to `scroll_by`.

**Data flow**: Accepts a signed `delta` and forwards it unchanged to `scroll_by`; state mutation occurs there. It returns no value.

**Call relations**: Higher-level input handling can call this for page-up/page-down style movement without duplicating scroll logic. It exists mainly to express intent in the call flow.

*Call graph*: calls 1 internal fn (scroll_by).


##### `ScrollableDiff::scroll_to_top`  (lines 89–91)

```
fn scroll_to_top(&mut self)
```

**Purpose**: Jumps the view to the first row of content. It is the absolute reset operation for vertical position.

**Data flow**: Writes `0` directly into `self.state.scroll` and returns no value.

**Call relations**: Used when callers want deterministic positioning at the beginning of content. It does not need `max_scroll` because the top bound is always zero.


##### `ScrollableDiff::scroll_to_bottom`  (lines 93–95)

```
fn scroll_to_bottom(&mut self)
```

**Purpose**: Jumps the view to the last valid top row so the bottom of content is visible. It respects current viewport and content heights.

**Data flow**: Reads `self.max_scroll()` and writes that value into `self.state.scroll`. It returns no value.

**Call relations**: Used for end-of-content navigation. It delegates the geometry calculation to `max_scroll` rather than recomputing the subtraction inline.

*Call graph*: calls 1 internal fn (max_scroll).


##### `ScrollableDiff::percent_scrolled`  (lines 98–108)

```
fn percent_scrolled(&self) -> Option<u8>
```

**Purpose**: Computes an approximate scroll percentage based on the visible bottom edge of the viewport, not just the top offset. It intentionally suppresses percentages when geometry is incomplete or scrolling is irrelevant.

**Data flow**: Reads `state.content_h`, `state.viewport_h`, and `state.scroll`; returns `None` if content or viewport height is zero or if content fits entirely in the viewport. Otherwise it computes `(scroll + viewport_h) / content_h * 100`, rounds it, clamps to `0..=100`, and returns `Some(u8)`.

**Call relations**: Overlay title rendering uses this to show progress through long diff or conversation content. It is read-only and depends on prior calls that established wrapping and viewport geometry.


##### `ScrollableDiff::max_scroll`  (lines 110–112)

```
fn max_scroll(&self) -> u16
```

**Purpose**: Calculates the greatest legal top-row offset for the current content and viewport heights. It centralizes the saturating subtraction used by scrolling operations.

**Data flow**: Reads `self.state.content_h` and `self.state.viewport_h`, computes `content_h.saturating_sub(viewport_h)`, and returns the resulting `u16` without mutation.

**Call relations**: This helper is used by relative and absolute bottom scrolling paths. `scroll_by` uses it for clamping, and `scroll_to_bottom` uses it for direct positioning.

*Call graph*: called by 2 (scroll_by, scroll_to_bottom).


##### `ScrollableDiff::rewrap`  (lines 114–175)

```
fn rewrap(&mut self, width: u16)
```

**Purpose**: Rebuilds the wrapped display cache from raw lines for a specific column width, preserving a mapping from each wrapped row back to its source line. It is the core text-layout routine for this viewer.

**Data flow**: Takes `width`; if zero, clones `self.raw` into `self.wrapped` and updates `state.content_h`. Otherwise it iterates `self.raw` with indices, replaces tabs with four spaces, emits empty wrapped lines for empty inputs, and then scans characters while tracking display width with `UnicodeWidthChar` and `UnicodeWidthStr`. It splits on explicit `\n`, prefers soft wraps at whitespace/punctuation via `last_soft_idx`, hard-wraps when necessary, pushes each emitted segment into `out`, records the corresponding raw index in `out_idx`, then stores both vectors into `self.wrapped` and `self.wrapped_src_idx` and updates `self.state.content_h`.

**Call relations**: Only `set_width` invokes this, making width changes the sole trigger for cache regeneration. The renderer later consumes both outputs to style wrapped rows while still reasoning about original raw-line structure.

*Call graph*: called by 1 (set_width); 6 external calls (new, width, width, new, matches!, take).
