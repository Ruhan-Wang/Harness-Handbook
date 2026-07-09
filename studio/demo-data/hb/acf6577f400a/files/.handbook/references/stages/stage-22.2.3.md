# TUI text layout, wrapping, and text-rendering primitives  `stage-22.2.3`

This stage is shared behind-the-scenes support for drawing text in the terminal interface. It is used whenever the app needs to show output, Markdown, diffs, links, or styled lines inside a limited screen area.

The geometry helper in render/mod.rs lets drawing code add padding inside a rectangle, like leaving margins in a page. line_utils.rs prepares display lines so they can be safely stored, copied, and given prefixes. width.rs checks whether there is any usable space left after those prefixes. ansi-escape/src/lib.rs converts colored terminal output into drawable text and expands tabs so columns line up.

Several files then shape text to fit. line_truncation.rs measures and cuts styled text without splitting wide characters such as emoji. wrapping.rs wraps rich terminal text while preserving styling, indentation, byte positions, and whole clickable URLs. live_wrap.rs does similar wrapping for incoming plain text. markdown_text_merge.rs joins adjacent Markdown text pieces after parsing so rendering sees smoother text. terminal_hyperlinks.rs keeps link targets separate from visible words until the final drawing step. scrollable_diff.rs uses these pieces to show wrapped diffs and messages with a valid scroll position.

## Files in this stage

### Shared render geometry
These small primitives define common rectangle and line composition helpers that other text-layout code builds on.

### `tui/src/render/mod.rs`

`util` · `cross-cutting during terminal rendering`

Terminal screens are drawn by giving each widget a rectangle: an x and y position, plus a width and height. Many parts of the interface need the same simple operation: take a rectangle and carve out some inside space so text, borders, popups, or menus do not touch the edges. This file provides that shared language.

The main type is `Insets`, which means “how much space to remove from each side.” It stores separate values for the left, top, right, and bottom sides. There are two convenient ways to create one: `tlbr` when each side may be different, and `vh` when the vertical sides share one value and the horizontal sides share another.

The file also adds an `inset` method to `ratatui`'s `Rect` type. `ratatui` is the terminal user-interface library used by this project. Calling `inset` returns a smaller rectangle moved inward by the requested amounts. It uses saturating arithmetic, which means subtraction never goes below zero and addition never overflows. In plain terms: if someone asks for more padding than the rectangle can fit, the result becomes safely tiny instead of crashing or wrapping into nonsense sizes.

It also names the rendering submodules that live under this folder, but its own real job is this reusable rectangle-padding helper.

#### Function details

##### `Insets::tlbr`  (lines 16–23)

```
fn tlbr(top: u16, left: u16, bottom: u16, right: u16) -> Self
```

**Purpose**: Creates an `Insets` value when the caller wants to give the top, left, bottom, and right padding separately. This is useful for layouts where one side needs extra room, such as reserving space beside a text area or inside a popup.

**Data flow**: The caller provides four numbers: top, left, bottom, and right. The function stores those numbers in an `Insets` object with the matching side names. The output is that ready-to-use padding description; it does not change anything else.

**Call relations**: Rendering and layout code call this when they need uneven spacing around a rectangle. Those callers later pass the returned `Insets` to rectangle-shrinking code so the final drawing area is moved inward by the requested side-specific amounts.

*Call graph*: called by 15 (layout_areas_with_textarea_right_reserve, render_ref, render_ref, render_popup, render_ref, as_renderable, render_ref, from, render_lines, render_markdown_content (+5 more)).


##### `Insets::vh`  (lines 25–32)

```
fn vh(v: u16, h: u16) -> Self
```

**Purpose**: Creates an `Insets` value from just two numbers: one vertical amount for both top and bottom, and one horizontal amount for both left and right. This is the quick path for ordinary padding where opposite sides match.

**Data flow**: The caller provides a vertical value and a horizontal value. The function copies the vertical value into both `top` and `bottom`, and copies the horizontal value into both `left` and `right`. It returns the completed `Insets` value without touching any outside state.

**Call relations**: Rendering code calls this during common drawing tasks where a widget or menu needs even padding. The returned spacing is then used to shrink a `Rect`, giving later drawing code a cleaner inner area to paint into.

*Call graph*: called by 7 (render, render, render, render, menu_surface_inset, render, render_ref).


##### `Rect::inset`  (lines 40–49)

```
fn inset(&self, insets: Insets) -> Rect
```

**Purpose**: Returns a smaller rectangle inside the original one, based on the requested `Insets`. It is used to turn an outer area, such as a bordered box, into the inner area where content should actually be drawn.

**Data flow**: The function reads the original rectangle's position and size, plus the padding amounts from `Insets`. It moves the rectangle's starting x position right by the left inset and its y position down by the top inset. It then reduces the width by the left and right insets together, and the height by the top and bottom insets together. The result is a new `Rect`; the original rectangle is left unchanged. If the insets are too large, the math safely stops at zero-sized dimensions instead of producing invalid values.

**Call relations**: This method is the workhorse that uses the `Insets` created by `Insets::tlbr` or `Insets::vh`. Rendering code can ask for an inner rectangle and then hand that rectangle to lower-level drawing routines, so borders, margins, and reserved spaces stay consistent across the terminal interface.


### `tui/src/render/line_utils.rs`

`util` · `cross-cutting during terminal rendering and tests`

The terminal UI uses ratatui `Line` and `Span` values to describe styled text. A `Span` is a piece of text with styling, and a `Line` is a row made from spans. Some lines borrow their text from elsewhere, which is efficient but can be awkward when the program needs to keep those lines after the original text might disappear. This file solves that by turning borrowed lines into fully owned lines, a bit like photocopying a note instead of holding a pointer to someone else’s notebook.

The helpers here are deliberately small. One function clones a single line into a `'static` line, meaning the new line owns its text and is not tied to the lifetime of the source. Another appends many such owned copies into an output list. A separate helper adds a prefix span to each line, using one prefix for the first line and another for later lines. That is useful for things like bullets, indentation, prompts, or continuation markers in wrapped text.

There is also a test-only blank-line checker that treats a line as blank only when it has no spans or only space characters. Together, these utilities keep rendering code elsewhere simpler and safer by centralizing common line-copying and line-shaping tasks.

#### Function details

##### `line_to_static`  (lines 5–18)

```
fn line_to_static(line: &Line<'_>) -> Line<'static>
```

**Purpose**: This function makes an owned copy of a ratatui text line. Someone uses it when they have a line that borrows text from somewhere else but need a version that can safely live on its own.

**Data flow**: It receives a reference to a `Line` whose text may be borrowed. It copies the line’s style, alignment, and each styled text span, turning every span’s text into an owned string. It returns a new `Line<'static>` that no longer depends on the original text source.

**Call relations**: This is the basic copying tool used by `push_owned_lines`. Other rendering code usually does not call it directly; instead, it asks `push_owned_lines` to copy several lines, and that helper calls `line_to_static` once for each line.

*Call graph*: called by 1 (push_owned_lines).


##### `push_owned_lines`  (lines 21–25)

```
fn push_owned_lines(src: &[Line<'a>], out: &mut Vec<Line<'static>>)
```

**Purpose**: This function copies a group of borrowed UI lines into an output list as fully owned lines. It is useful when render-building code wants to collect lines from different places without worrying about how long the original text will remain valid.

**Data flow**: It receives a slice of source lines and a mutable output vector. For each source line, it calls `line_to_static` to make an owned copy, then pushes that copy into the output vector. The source is unchanged, and the output list grows by the number of copied lines.

**Call relations**: This helper is used by several rendering paths, including command display, exploring display, transcript building, markdown appending, stacked field rendering, adaptive wrapping, and screen-limit tests. In those flows, higher-level code gathers text to show, then calls this function when it needs to add safe, owned copies to the final display list.

*Call graph*: calls 1 internal fn (line_to_static); called by 9 (command_display_lines, exploring_display_lines, transcript_lines, user_shell_output_is_limited_by_screen_lines, append_markdown, append_markdown_agent, render_stacked_field, adaptive_wrap_lines, word_wrap_lines).


##### `is_blank_line_spaces_only`  (lines 30–37)

```
fn is_blank_line_spaces_only(line: &Line<'_>) -> bool
```

**Purpose**: This test-only function checks whether a UI line is blank in a very strict sense: it must be empty or contain only ordinary space characters. It exists to support tests that need predictable blank-line behavior.

**Data flow**: It receives a reference to a line. If the line has no spans, it returns `true`. Otherwise, it examines every span and returns `true` only if each span is empty or made entirely of space characters; tabs, newlines, or other characters make the result `false`.

**Call relations**: The function is compiled only for tests. It is called by `commit_complete_lines` in test-related checking, where the code needs to tell whether a rendered line should count as blank without accidentally treating tabs or other whitespace as spaces.

*Call graph*: called by 1 (commit_complete_lines).


##### `prefix_lines`  (lines 41–60)

```
fn prefix_lines(
    lines: Vec<Line<'static>>,
    initial_prefix: Span<'static>,
    subsequent_prefix: Span<'static>,
) -> Vec<Line<'static>>
```

**Purpose**: This function adds a styled prefix to every line in a list. It uses one prefix for the first line and a different prefix for all following lines, which is helpful for things like labels, bullets, wrapped command output, or indented continuation lines.

**Data flow**: It takes ownership of a vector of owned lines, plus two owned prefix spans. For each line, it creates a new span list, puts the right prefix at the front, then appends the original spans after it. It returns a new vector of lines with the prefixes added and preserves each line’s style.

**Call relations**: Higher-level renderers call this when they have already built some display lines and need to decorate them before showing them. It is used in footer rendering, changes blocks, command and exploring displays, screen-limit tests, and collaboration event rendering, where consistent first-line versus following-line prefixes make the output easier to read.

*Call graph*: called by 7 (render_footer_from_props, render_footer_line, render_changes_block, command_display_lines, exploring_display_lines, user_shell_output_is_limited_by_screen_lines, collab_event).


### Width and line shaping helpers
These utilities handle width guards, ANSI-to-text conversion, line truncation, and markdown text coalescing before higher-level wrapping logic runs.

### `tui/src/width.rs`

`util` · `cross-cutting`

Terminal output often has a fixed prefix before the main text: a bullet, gutter, label, or other marker. Those prefix columns are useful, but on a very narrow terminal they can take up all the available width. If the program then tries to wrap or draw the remaining content at width zero, the result can be blank, jumpy, or otherwise unreliable.

This file centralizes that width calculation. Instead of every renderer subtracting widths in its own way, callers use these helpers. The helpers subtract the reserved prefix width from the total terminal width and only return a value when at least one column remains for content. If no usable space is left, they return `None`, meaning “do not try normal content rendering; use a prefix-only fallback instead.”

A simple analogy is seating at a table: if the name cards take up the whole table, there is no room left for plates. This file tells the rest of the program whether there is real table space left, rather than pretending there is a zero-width place setting.

There are two versions because terminal dimensions may arrive as different number types. The `u16` version converts those numbers and reuses the main calculation, so the rule stays consistent everywhere.

#### Function details

##### `usable_content_width`  (lines 22–26)

```
fn usable_content_width(total_width: usize, reserved_cols: usize) -> Option<usize>
```

**Purpose**: Calculates how much width is left for content after fixed prefix columns are reserved. It returns a usable positive number, or `None` when there is no room left.

**Data flow**: It receives the total available width and the number of columns already reserved. It safely subtracts the reserved columns from the total, avoiding underflow when the reserved amount is larger. If the result is greater than zero, it returns that number; otherwise it returns `None` and changes nothing else.

**Call relations**: This is the core rule used by the file. `usable_content_width_u16` calls it after converting terminal-style `u16` widths into ordinary `usize` numbers, so both helper paths make the same decision about whether content can be rendered.

*Call graph*: called by 1 (usable_content_width_u16).


##### `usable_content_width_u16`  (lines 32–34)

```
fn usable_content_width_u16(total_width: u16, reserved_cols: u16) -> Option<usize>
```

**Purpose**: Provides the same width check for callers that receive terminal widths as `u16` values. It exists so rendering code can use the helper without doing its own conversions.

**Data flow**: It receives total width and reserved columns as `u16` values. It converts both to `usize`, passes them to `usable_content_width`, and returns that function’s result unchanged: either a positive content width or `None`.

**Call relations**: This is the convenience doorway used by rendering code such as `display_hyperlink_lines` and `lines`. When those callers need to lay out text in a terminal, this function hands the real calculation off to `usable_content_width` so narrow-screen fallback behavior stays consistent.

*Call graph*: calls 1 internal fn (usable_content_width); called by 2 (display_hyperlink_lines, lines); 1 external calls (from).


##### `tests::usable_content_width_returns_none_when_reserved_exhausts_width`  (lines 42–59)

```
fn usable_content_width_returns_none_when_reserved_exhausts_width()
```

**Purpose**: Checks that the main width helper refuses to return zero-width or negative-space results. It also confirms that a single remaining column is considered usable.

**Data flow**: The test feeds several total-width and reserved-column pairs into `usable_content_width`. It compares each returned value with the expected result: `None` when the reserved space uses everything or more, and `Some(1)` when exactly one column remains.

**Call relations**: This test protects the core promise of `usable_content_width`. It uses assertion checks to make sure future changes do not accidentally let callers try normal rendering when no content space is available.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::usable_content_width_u16_matches_usize_variant`  (lines 62–71)

```
fn usable_content_width_u16_matches_usize_variant()
```

**Purpose**: Checks that the `u16` wrapper follows the same behavior as the main helper. This matters because terminal dimensions commonly arrive as `u16` values.

**Data flow**: The test calls `usable_content_width_u16` with sample widths and compares the results against the expected outcomes. It verifies both the no-space case and the one-column-remaining case.

**Call relations**: This test guards the convenience wrapper used by rendering paths. By checking the wrapper directly, it helps ensure callers like `display_hyperlink_lines` and `lines` get the same safe fallback signal as they would from the main helper.

*Call graph*: 1 external calls (assert_eq!).


### `ansi-escape/src/lib.rs`

`io_transport` · `cross-cutting display rendering`

Terminal programs often decorate their output with ANSI escape codes. These are hidden character sequences that mean things like “make this text red” or “reset the style.” A user should see the styled text, not the raw codes. This file is the small conversion layer that translates those strings into Ratatui text, which is the text format used by the terminal user interface library.

Before converting a single-line value, it replaces tab characters with four spaces. This is a practical display fix: tabs can line up badly when the app adds a left-side gutter, such as line numbers in transcript views. Think of it like replacing a stretchy spacer with a fixed-width spacer so the layout does not jump around.

The main public functions are split by expected shape. `ansi_escape` converts a whole string into styled multi-line text. `ansi_escape_line` is for places that expect exactly one line; if the converted result contains more than one line, it logs a warning and keeps only the first. Parsing errors are treated as serious internal surprises: the file logs the problem and panics, meaning it stops execution rather than trying to display uncertain output.

#### Function details

##### `expand_tabs`  (lines 11–21)

```
fn expand_tabs(s: &str) -> std::borrow::Cow<'_, str>
```

**Purpose**: This helper replaces tab characters with four spaces so text lines display more predictably in transcript and terminal views. If there are no tabs, it avoids making a new copy and simply reuses the original text.

**Data flow**: It receives a string slice. It checks whether the string contains a tab. If it does, it creates a new owned string where every tab is replaced by four spaces; if it does not, it returns a borrowed view of the original string unchanged.

**Call relations**: This is used by `ansi_escape_line` before style conversion happens. Its job is to clean up spacing first, so the later rendering step does not inherit tab-related alignment problems.

*Call graph*: called by 1 (ansi_escape_line); 2 external calls (Borrowed, Owned).


##### `ansi_escape_line`  (lines 26–38)

```
fn ansi_escape_line(s: &str) -> Line<'static>
```

**Purpose**: This function converts ANSI-styled text that is expected to be one line into a single Ratatui `Line`. It is useful when a caller knows it needs one display row, not a block of text.

**Data flow**: It receives a raw string, first replaces tabs with spaces through `expand_tabs`, then passes the cleaned text into `ansi_escape` to convert ANSI escape codes into styled text. If the result has no lines, it returns an empty line. If it has one line, it returns that line. If it has several lines, it logs a warning and returns only the first line.

**Call relations**: This function sits on top of the lower-level `ansi_escape` converter. Callers use it when they need a safe single-line result; it delegates the actual ANSI parsing to `ansi_escape` and adds the one-line check around it.

*Call graph*: calls 2 internal fn (ansi_escape, expand_tabs); 1 external calls (warn!).


##### `ansi_escape`  (lines 40–58)

```
fn ansi_escape(s: &str) -> Text<'static>
```

**Purpose**: This function converts a string containing ANSI terminal escape codes into Ratatui `Text`, preserving styles such as colors in the form the user interface can draw. It is the core conversion function in this file.

**Data flow**: It receives a raw string and asks the `ansi_to_tui` library to parse it into styled text. If parsing succeeds, it returns that styled text. If parsing fails because of an unexpected parser error or UTF-8 text error, it logs the error and panics, stopping execution because the code treats those failures as impossible or unrecoverable in normal use.

**Call relations**: `ansi_escape_line` calls this when it needs styled text before selecting a single line. This function hands off the detailed ANSI parsing to the external `ansi_to_tui` library, then either returns the converted Ratatui text or records a serious error and stops.

*Call graph*: called by 1 (ansi_escape_line); 2 external calls (panic!, error!).


### `tui/src/line_truncation.rs`

`util` · `UI rendering`

Terminal screens are measured in columns, not just in letters. Some characters take one column, some take two, and some take none. This file solves the problem of making a styled line fit into a limited number of columns without cutting a character in half or losing its styling. That matters for rows, footers, wrapped details, and other parts of the text user interface where overflowing text would spill into neighboring UI areas.

The main idea is simple: a line is made of styled pieces called spans. The code first knows how to measure the full visible width of those spans. Then it can build a new line by copying whole spans while there is room, and trimming the final span character by character when only part of it fits. It preserves the line’s overall style and alignment, and it keeps each copied or shortened piece styled like the original.

There is also a user-friendly version that adds an ellipsis, “…”, when text has been shortened. It first checks whether the line already fits; if so, it returns the original line unchanged. This is like checking whether a label fits on a shelf before cutting it down and adding “…” to show there was more.

#### Function details

##### `line_width`  (lines 6–10)

```
fn line_width(line: &Line<'_>) -> usize
```

**Purpose**: This function measures how many terminal columns a styled line will occupy. It is used when the program needs to know whether a line already fits before deciding to shorten it.

**Data flow**: It receives a reference to a styled line. It looks at each span in the line, measures the visible width of that span’s text using Unicode-aware width rules, and adds those widths together. It returns the total column width and does not change the line.

**Call relations**: The ellipsis helper calls this first as a quick check. If the measured width is small enough, the caller can keep the original line exactly as it is instead of doing extra truncation work.

*Call graph*: called by 1 (truncate_line_with_ellipsis_if_overflow); 1 external calls (iter).


##### `truncate_line_to_width`  (lines 12–67)

```
fn truncate_line_to_width(line: Line<'static>, max_width: usize) -> Line<'static>
```

**Purpose**: This function cuts a styled line down so it fits within a given terminal width. It preserves the line’s style and alignment, and keeps as much text as can safely fit.

**Data flow**: It receives an owned styled line and a maximum width. If the width is zero, it returns an empty line. Otherwise, it walks through the line’s spans from left to right, copying spans that fully fit. When a span would overflow, it checks that span character by character, measuring each character’s terminal width, and keeps only the prefix that fits. It returns a new line containing the kept spans and any shortened final span.

**Call relations**: The ellipsis helper calls this when it already knows the line is too wide. This function does the careful cutting work, while its caller decides whether to add a visible overflow marker afterward.

*Call graph*: called by 1 (truncate_line_with_ellipsis_if_overflow); 6 external calls (from, styled, width, width, new, with_capacity).


##### `truncate_line_with_ellipsis_if_overflow`  (lines 75–100)

```
fn truncate_line_with_ellipsis_if_overflow(
    line: Line<'static>,
    max_width: usize,
) -> Line<'static>
```

**Purpose**: This function shortens a styled line only if needed, and adds an ellipsis to show that text was omitted. It is intended for compact UI rows where users need a clear sign that the original text continued.

**Data flow**: It receives an owned styled line and a maximum width. If the width is zero, it returns an empty line. Otherwise, it measures the line; if it already fits, it returns the original line unchanged. If it is too wide, it truncates the line to one column less than the maximum, then appends a styled ellipsis using the style of the last remaining span when possible. The result is a line that fits the requested width and visibly signals overflow.

**Call relations**: Many UI rendering paths call this when drawing constrained text, including footer rendering, item rendering, row rendering, wrapped detail lines, line building, and masked text area rendering. It coordinates the two lower-level helpers: first measuring with line_width, then cutting with truncate_line_to_width when overflow is present.

*Call graph*: calls 2 internal fn (line_width, truncate_line_to_width); called by 8 (render_with_mask_and_textarea_right_reserve, detail_wrapped_lines, render_footer, build_line, render, render_rows_single_line_with_col_width_mode, render_items, render); 3 external calls (from, styled, new).


### `tui/src/markdown_text_merge.rs`

`util` · `markdown rendering`

Markdown parsers do not always produce one text event for what a person sees as one run of text. For example, parser extensions or delimiter rules can split text around special characters, even when the final visible text should be read as continuous. That can be a problem for later code that looks for words, tokens, or spans that cross those invisible parser boundaries.

This file solves that by adding `DecodedTextMerge`, a wrapper around another iterator. An iterator is simply something that gives items one at a time. The wrapped iterator produces Markdown events together with their source byte ranges. `DecodedTextMerge` watches those events as they pass through. If it sees a text event followed immediately by more text events, it joins their already-decoded text into one larger text event. At the same time, it expands the source range so it still covers the full original stretch of Markdown.

The important detail is that it does not rebuild the text from the raw Markdown source. It uses the parser-decoded text, so things like escaped characters or Markdown-specific decoding stay correct. Non-text events are passed through unchanged. You can think of it like taping together adjacent slips of paper that belong to the same sentence, while keeping the label that says where the whole sentence came from.

#### Function details

##### `DecodedTextMerge::new`  (lines 18–22)

```
fn new(iter: I) -> Self
```

**Purpose**: Creates a `DecodedTextMerge` wrapper around an existing stream of parsed Markdown events. It prepares the stream so the wrapper can look one item ahead and decide whether nearby text events should be joined.

**Data flow**: It receives an iterator of Markdown events with source ranges. It turns that iterator into a peekable iterator, meaning the code can briefly look at the next item without consuming it. It returns a new `DecodedTextMerge` value ready to be used like any other iterator.

**Call relations**: The Markdown rendering path calls this from `render_markdown_lines_with_width_and_cwd` after parsing Markdown. From that point on, later rendering code reads from the wrapper instead of directly from the parser stream, so adjacent decoded text can be combined before layout and display decisions are made.

*Call graph*: called by 1 (render_markdown_lines_with_width_and_cwd); 1 external calls (peekable).


##### `DecodedTextMerge::next`  (lines 31–49)

```
fn next(&mut self) -> Option<Self::Item>
```

**Purpose**: Produces the next Markdown event, joining consecutive text events into one when possible. This keeps visible text together for downstream rendering or token recognition, while preserving the combined source range.

**Data flow**: It asks the wrapped iterator for the next event and its source range. If the event is not text, it returns it unchanged. If it is text, it checks whether the following events are also text. For each neighboring text event, it appends the decoded text to a growing string and extends the range end to cover the later source text. It returns one merged text event with the full range, or the original text event if there was nothing to merge.

**Call relations**: After `DecodedTextMerge::new` installs this wrapper in the Markdown rendering flow, normal iteration calls this method whenever the renderer wants the next event. Internally it uses the underlying iterator’s `next` and look-ahead behavior to collect adjacent text events, then hands the cleaned-up event stream onward to the rest of the renderer.

*Call graph*: 3 external calls (next, matches!, Text).


### Wrapping and hyperlink-preserving layout
This core layout path wraps text while preserving semantic hyperlink boundaries and reconstructable ranges for downstream rendering.

### `tui/src/terminal_hyperlinks.rs`

`domain_logic` · `rendering and scrollback output`

Terminal hyperlinks use OSC 8 escape codes, which are invisible bytes that tell supporting terminals “this text points to this URL.” If those bytes were mixed into the text too early, the layout engine might count them as characters and wrap or measure lines incorrectly. This file avoids that by treating hyperlinks like sticky notes attached to column ranges: the visible line stays clean, while separate annotations say which visible columns should link where.

The main type, `HyperlinkLine`, pairs a normal Ratatui `Line` with a list of hyperlink ranges. Helper functions can turn plain lines into hyperlink-aware lines, add prefixes while shifting link positions, detect web URLs in text, and preserve links when lines are wrapped. The wrapping logic is careful because a link may be split across visual rows; each fragment still needs the same destination.

At output time, the file finally inserts OSC 8 terminal codes around the right characters or buffer cells. It also validates destinations so only safe `http` and `https` URLs become clickable. In everyday terms, this file is like keeping mailing labels separate from packages until shipping time: the package size stays accurate, and the label is applied only when it is ready to leave.

#### Function details

##### `HyperlinkLine::new`  (lines 39–44)

```
fn new(line: Line<'static>) -> Self
```

**Purpose**: Creates a hyperlink-aware line from ordinary visible text, starting with no links attached. Code uses this when it wants text that may later gain clickable ranges.

**Data flow**: It receives a Ratatui line as input. It stores that line unchanged and creates an empty list for hyperlink annotations. The result is a `HyperlinkLine` that looks the same on screen but can carry link metadata.

**Call relations**: Many rendering and transcript-building paths call this as the first step when they need a line that can participate in hyperlink-aware wrapping, history insertion, or display.

*Call graph*: called by 23 (display_lines_for_history_insert, render_transcript_lines_for_reflow, display_hyperlink_lines, ensure_line, hard_break, pop_link, push_blank_line, push_line, push_text_spans, push_text_spans_to_table_cell (+13 more)); 1 external calls (new).


##### `HyperlinkLine::width`  (lines 46–48)

```
fn width(&self) -> usize
```

**Purpose**: Returns the visible width of the line in terminal columns. This matters because hyperlink ranges are stored by what the user sees, not by byte position in memory.

**Data flow**: It reads the stored visible line and asks Ratatui how wide it is. It returns that column count and changes nothing.

**Call relations**: It is used when adding spans or writing history so callers can place new text and link ranges after the existing visible content.

*Call graph*: called by 2 (write_history_line, push_span); 1 external calls (width).


##### `HyperlinkLine::push_span`  (lines 50–62)

```
fn push_span(&mut self, span: Span<'static>, destination: Option<&str>)
```

**Purpose**: Adds a styled piece of text to the line and, if given a valid web URL, marks that new text as clickable. This is useful when building a line piece by piece.

**Data flow**: It takes a span of visible text and an optional destination string. It measures where the span will land, appends the span to the line, validates the destination as a web URL, and adds a hyperlink range for the span if appropriate. The line is changed in place.

**Call relations**: This builds on `HyperlinkLine::width` to find the start column, then relies on `web_destination` to reject unsafe or non-web links before storing the annotation.

*Call graph*: calls 1 internal fn (width); 1 external calls (push_span).


##### `HyperlinkLine::style`  (lines 64–67)

```
fn style(mut self, style: ratatui::style::Style) -> Self
```

**Purpose**: Applies a visual style, such as color or emphasis, to the whole visible line while keeping hyperlink annotations intact. It is used when already-built hyperlink lines need consistent styling.

**Data flow**: It receives a style and a `HyperlinkLine`. It replaces the line’s visible style with the new one and returns the updated `HyperlinkLine`; the link ranges are preserved.

**Call relations**: Callers that prepare prewrapped display lines use this after the text and link information already exist.

*Call graph*: called by 1 (push_prewrapped_line); 1 external calls (style).


##### `HyperlinkLine::from`  (lines 83–85)

```
fn from(text: String) -> Self
```

**Purpose**: Provides a convenient conversion from plain text-like inputs into a `HyperlinkLine`. It makes hyperlink-aware APIs easier to call even when there are no links yet.

**Data flow**: It receives plain line content in one supported form, converts it to a Ratatui line if needed, and wraps it in a new `HyperlinkLine` with an empty hyperlink list.

**Call relations**: Transcript and display code use this conversion when they want to pass ordinary visible text into flows that expect hyperlink-aware lines.

*Call graph*: called by 3 (active_cell_transcript_hyperlink_lines, display_hyperlink_lines, transcript_hyperlink_lines); 2 external calls (from, new).


##### `visible_lines`  (lines 88–90)

```
fn visible_lines(lines: Vec<HyperlinkLine>) -> Vec<Line<'static>>
```

**Purpose**: Strips away hyperlink metadata and returns only the visible Ratatui lines. This is useful for layout or rendering steps that only care about what text looks like.

**Data flow**: It receives a list of `HyperlinkLine` values. For each one, it takes the visible `line` field and discards the separate hyperlink list. The output is a list of plain visible lines.

**Call relations**: Render and height-calculation code call this when they need to measure or display text without considering clickable annotations.

*Call graph*: called by 9 (render, desired_transcript_height, display_lines_for_mode, render_markdown_text_with_width_and_cwd, render, desired_height, render, controller_live_view_matches_render_during_interleaved_table_streaming, hyperlink_lines_to_plain_strings).


##### `plain_hyperlink_lines`  (lines 92–94)

```
fn plain_hyperlink_lines(lines: Vec<Line<'static>>) -> Vec<HyperlinkLine>
```

**Purpose**: Wraps ordinary visible lines in `HyperlinkLine` containers without adding any links. It is a bridge from plain text rendering into hyperlink-aware rendering.

**Data flow**: It receives a list of Ratatui lines. It turns each one into a `HyperlinkLine` whose visible text is the same and whose hyperlink list starts empty. The output keeps the same line order.

**Call relations**: Several display, transcript, and wrapping paths use this when they need the hyperlink-aware shape even though the source text has no known link annotations yet.

*Call graph*: called by 8 (display_hyperlink_lines, display_hyperlink_lines_for_mode, transcript_hyperlink_lines, insert_history_lines_with_mode_and_wrap_policy, display_hyperlink_lines, render_source, remap_wrapped_line, insert_history_lines_with_wrap_policy).


##### `prefix_hyperlink_lines`  (lines 96–121)

```
fn prefix_hyperlink_lines(
    lines: Vec<HyperlinkLine>,
    initial_prefix: Span<'static>,
    subsequent_prefix: Span<'static>,
) -> Vec<HyperlinkLine>
```

**Purpose**: Adds a prefix span to each line, using one prefix for the first line and another for later lines. It also shifts every hyperlink range so links still point to the same visible text after the prefix is inserted.

**Data flow**: It receives hyperlink-aware lines plus two prefix spans. For each line, it inserts the right prefix at the front, measures the prefix width, and moves all hyperlink column ranges to the right by that amount. It returns the updated list.

**Call relations**: Display rendering uses this when adding visual markers or indentation before lines; the function protects existing links from becoming misaligned.

*Call graph*: called by 1 (render_display_lines).


##### `adaptive_wrap_hyperlink_lines`  (lines 123–145)

```
fn adaptive_wrap_hyperlink_lines(
    lines: &[HyperlinkLine],
    options: RtOptions<'static>,
) -> Vec<HyperlinkLine>
```

**Purpose**: Wraps hyperlink-aware lines to fit a target width while preserving their clickable regions. This matters when long text must be split across terminal rows without losing link destinations.

**Data flow**: It receives source `HyperlinkLine` values and wrapping options. It wraps each visible line with the regular wrapping engine, converts wrapped output to owned lines, then remaps the original hyperlink annotations onto the wrapped fragments. It returns new hyperlink-aware wrapped lines.

**Call relations**: Display code calls this when preparing text for the terminal. It delegates visible wrapping to `adaptive_wrap_line` and then calls `remap_wrapped_line` so the link metadata follows the text.

*Call graph*: calls 2 internal fn (remap_wrapped_line, adaptive_wrap_line); called by 1 (display_hyperlink_lines); 3 external calls (new, iter, clone).


##### `annotate_web_urls`  (lines 147–149)

```
fn annotate_web_urls(lines: Vec<Line<'static>>) -> Vec<HyperlinkLine>
```

**Purpose**: Scans plain visible lines and marks any web URLs inside them as clickable. It lets ordinary text automatically gain terminal hyperlinks.

**Data flow**: It receives plain Ratatui lines. Each line is passed through `annotate_web_urls_in_line`, which keeps the visible text unchanged and adds hyperlink ranges for detected URLs. The output is a list of `HyperlinkLine` values.

**Call relations**: Display-building paths call this when they have text that may contain bare `http` or `https` links.

*Call graph*: called by 3 (display_hyperlink_lines, display_hyperlink_lines, display_hyperlink_lines).


##### `annotate_web_urls_in_line`  (lines 151–160)

```
fn annotate_web_urls_in_line(line: Line<'static>) -> HyperlinkLine
```

**Purpose**: Finds web URLs inside one visible line and attaches hyperlink annotations for them. The text itself is not rewritten.

**Data flow**: It receives one Ratatui line. It joins the span text into a single string for scanning, creates a new `HyperlinkLine` around the original line, and fills its hyperlink list with ranges found by `web_links_in_text`. The result is the same visible line plus link metadata.

**Call relations**: It is the per-line worker behind `annotate_web_urls`, and table or markdown rendering code can also call it directly when adding text spans.

*Call graph*: calls 2 internal fn (new, web_links_in_text); called by 3 (writes_semantic_web_link_without_changing_visible_text, push_text_spans, push_text_spans_to_table_cell).


##### `remap_wrapped_line`  (lines 167–209)

```
fn remap_wrapped_line(
    source: &HyperlinkLine,
    wrapped: Vec<Line<'static>>,
) -> Vec<HyperlinkLine>
```

**Purpose**: Reattaches original hyperlink ranges after a visible line has been wrapped into multiple display lines. Without this, links could disappear or point at the wrong columns after wrapping.

**Data flow**: It receives one source `HyperlinkLine` and the wrapped visible lines produced from it. It compares the wrapped text fragments with the original text in display order, skips whitespace that wrapping may add or remove at row edges, and copies the correct destination onto each matching output column. It returns wrapped `HyperlinkLine` values with fresh hyperlink ranges.

**Call relations**: Wrapping, table-cell layout, history insertion, and buffer-marking code call this after text has been split. It uses `line_text`, `longest_suffix_matching_prefix`, and `push_link_range` to perform the mapping.

*Call graph*: calls 4 internal fn (line_text, longest_suffix_matching_prefix, plain_hyperlink_lines, push_link_range); called by 7 (insert_history_hyperlink_lines_with_mode_and_wrap_policy, flush_current_line, wrap_cell, wrap_cell, adaptive_wrap_hyperlink_lines, mark_buffer_hyperlinks, wrapping_maps_repeated_link_labels_by_source_position).


##### `line_text`  (lines 211–216)

```
fn line_text(line: &Line<'_>) -> String
```

**Purpose**: Extracts the plain visible string from a Ratatui line by joining all its spans. It gives other functions a simple text view for matching and scanning.

**Data flow**: It reads each span’s content from a line, concatenates those pieces in order, and returns the resulting string. It does not keep style information or change the line.

**Call relations**: `remap_wrapped_line` calls this to compare source text with wrapped output text.

*Call graph*: called by 1 (remap_wrapped_line).


##### `longest_suffix_matching_prefix`  (lines 218–224)

```
fn longest_suffix_matching_prefix(rendered: &str, source: &str) -> Option<usize>
```

**Purpose**: Finds where a rendered line fragment begins matching the remaining source text. This helps account for indentation or other leading text that may appear in wrapped output.

**Data flow**: It receives a rendered string and a source string. It tries possible character boundaries in the rendered string and finds a suffix that is also the start of the source string. It returns the byte index where that suffix begins, or no result if there is no usable match.

**Call relations**: `remap_wrapped_line` uses this to line up wrapped display text with the original unwrapped text before copying hyperlink ranges.

*Call graph*: called by 1 (remap_wrapped_line); 1 external calls (once).


##### `push_link_range`  (lines 226–241)

```
fn push_link_range(line: &mut HyperlinkLine, range: Range<usize>, destination: &str)
```

**Purpose**: Adds a hyperlink range to a line, merging it with the previous range when they touch and point to the same destination. This keeps hyperlink annotations compact and continuous.

**Data flow**: It receives a mutable `HyperlinkLine`, a column range, and a destination. Empty ranges are ignored. If the new range directly follows the previous same-destination link, that previous range is extended; otherwise a new hyperlink entry is appended.

**Call relations**: `remap_wrapped_line` calls this repeatedly while rebuilding link ranges character by character on wrapped output.

*Call graph*: called by 1 (remap_wrapped_line); 1 external calls (is_empty).


##### `web_links_in_text`  (lines 243–271)

```
fn web_links_in_text(text: &str) -> Vec<TerminalHyperlink>
```

**Purpose**: Detects bare web URLs in a plain string and returns their visible column ranges. It is careful with punctuation around links, such as parentheses or a period at the end of a sentence.

**Data flow**: It receives text, splits it by ASCII whitespace into tokens, trims likely leading and trailing punctuation, validates each candidate as an `http` or `https` URL, and measures where it appears in terminal columns. It returns a list of hyperlink annotations.

**Call relations**: `annotate_web_urls_in_line` calls this to turn ordinary text into link-aware text. It relies on `trailing_url_end` and `web_destination` to avoid marking punctuation or unsafe destinations.

*Call graph*: calls 2 internal fn (trailing_url_end, web_destination); called by 1 (annotate_web_urls_in_line); 1 external calls (new).


##### `is_leading_punctuation`  (lines 273–278)

```
fn is_leading_punctuation(ch: char) -> bool
```

**Purpose**: Decides whether a character at the front of a token is punctuation that should not be part of a detected URL. This prevents text like `(https://example.com` from including the opening parenthesis in the link.

**Data flow**: It receives one character and checks it against a small set of punctuation marks. It returns true if that character should be skipped before URL parsing.

**Call relations**: It is used inside URL detection while trimming the start of candidate tokens.

*Call graph*: 1 external calls (matches!).


##### `trailing_url_end`  (lines 280–296)

```
fn trailing_url_end(candidate: &str) -> usize
```

**Purpose**: Finds where a URL candidate should end after removing sentence punctuation that follows it. It preserves balanced delimiters that genuinely belong in the URL, such as parentheses in Wikipedia links.

**Data flow**: It receives a candidate string. Starting from the end, it trims commas, periods, and similar punctuation, and trims closing brackets only when they are unmatched. It returns the byte position where the usable URL ends.

**Call relations**: `web_links_in_text` calls this before validating a token as a web destination. It asks `has_unmatched_closing_delimiter` whether a closing bracket is extra punctuation or part of the URL.

*Call graph*: calls 1 internal fn (has_unmatched_closing_delimiter); called by 1 (web_links_in_text); 1 external calls (matches!).


##### `has_unmatched_closing_delimiter`  (lines 298–308)

```
fn has_unmatched_closing_delimiter(candidate: &str, closing: char) -> bool
```

**Purpose**: Checks whether a closing delimiter, such as `)` or `]`, has more closings than openings in a candidate URL. This helps decide whether the final delimiter should be trimmed.

**Data flow**: It receives the candidate text and a closing delimiter. It chooses the matching opening delimiter, counts openings and closings in the text, and returns true if the closing delimiter appears unmatched.

**Call relations**: `trailing_url_end` uses this while trimming the right edge of a possible URL.

*Call graph*: called by 1 (trailing_url_end).


##### `web_destination`  (lines 310–320)

```
fn web_destination(destination: &str) -> Option<String>
```

**Purpose**: Validates and cleans a hyperlink destination so only real web URLs are used. It accepts only `http` and `https` URLs with a host, and removes control characters.

**Data flow**: It receives a destination string. It filters out control characters, parses the result as a URL, checks that the scheme is `http` or `https`, and confirms there is a host name. It returns the cleaned URL string if valid, otherwise nothing.

**Call relations**: This is the safety gate used before creating OSC 8 hyperlinks, detecting URLs, adding span links, or marking buffer cells.

*Call graph*: called by 4 (pop_link, mark_matching_cells, osc8_hyperlink, web_links_in_text); 2 external calls (parse, matches!).


##### `osc8_hyperlink`  (lines 322–327)

```
fn osc8_hyperlink(destination: &str, text: &str) -> String
```

**Purpose**: Wraps visible text in OSC 8 terminal hyperlink codes when the destination is a safe web URL. OSC 8 is the terminal escape-code format for clickable links.

**Data flow**: It receives a destination and visible text. It validates the destination with `web_destination`; if valid, it returns the text surrounded by hyperlink start and end escape sequences. If invalid, it returns the original text unchanged.

**Call relations**: Buffer-marking functions call this at the final output stage when invisible terminal hyperlink codes are allowed to be inserted.

*Call graph*: calls 1 internal fn (web_destination); called by 2 (mark_buffer_hyperlinks, mark_matching_cells); 1 external calls (format!).


##### `strip_osc8`  (lines 330–360)

```
fn strip_osc8(text: &str) -> String
```

**Purpose**: Removes OSC 8 hyperlink escape codes from text while leaving the visible characters. It exists for tests that need to check what a user would actually see.

**Data flow**: It receives a string that may contain OSC 8 start or end sequences. It walks through the bytes, skips those escape sequences, copies normal characters into a new string, and returns the stripped visible text.

**Call relations**: Test code uses this to prove that hyperlink decoration does not change the readable text.

*Call graph*: 1 external calls (with_capacity).


##### `decorate_spans`  (lines 362–409)

```
fn decorate_spans(line: &HyperlinkLine) -> Vec<Span<'static>>
```

**Purpose**: Adds OSC 8 hyperlink codes into a line’s spans while preserving the original styling as much as possible. This is used for output paths that write spans rather than directly marking buffer cells.

**Data flow**: It receives a `HyperlinkLine`. If there are no links, it returns the original spans. Otherwise it walks through visible characters, opens a hyperlink when entering a linked range, closes it when leaving, and groups adjacent content with the same style. The output is a new span list containing both visible text and invisible hyperlink codes.

**Call relations**: History-writing code calls this when it is ready to serialize or display linked text. It uses `push_styled_content` and `append_to_last_span` to keep the span list tidy.

*Call graph*: calls 2 internal fn (append_to_last_span, push_styled_content); called by 1 (write_history_line); 2 external calls (new, format!).


##### `push_styled_content`  (lines 411–419)

```
fn push_styled_content(out: &mut Vec<Span<'static>>, content: &str, style: ratatui::style::Style)
```

**Purpose**: Appends text to a span list, reusing the previous span when the style is the same. This avoids creating many tiny spans unnecessarily.

**Data flow**: It receives an output span list, content, and a style. If the last output span has the same style, it appends the content there; otherwise it creates a new styled span. The span list is changed in place.

**Call relations**: `decorate_spans` uses this while inserting both visible characters and hyperlink opening codes.

*Call graph*: called by 1 (decorate_spans); 1 external calls (styled).


##### `append_to_last_span`  (lines 421–425)

```
fn append_to_last_span(out: &mut [Span<'static>], content: &str)
```

**Purpose**: Adds raw text to the end of the last span in a span list. It is mainly used to attach a hyperlink closing code without changing styling boundaries.

**Data flow**: It receives a mutable slice of spans and content to append. If there is a last span, it extends that span’s content; if the list is empty, it does nothing.

**Call relations**: `decorate_spans` calls this when closing an active OSC 8 hyperlink.

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

**Purpose**: Adds terminal hyperlink codes directly to the already-rendered terminal buffer cells for annotated lines. This is the final step that makes visible characters clickable on screen.

**Data flow**: It receives a mutable Ratatui buffer, the screen area, hyperlink-aware lines, and a scroll offset. For each linked line, it reproduces Ratatui’s wrapping in a temporary buffer, remaps link ranges onto the wrapped rows, skips off-screen rows, and replaces each linked nonblank cell’s symbol with an OSC 8-wrapped symbol. The visible glyph stays the same, but the terminal can treat it as a link.

**Call relations**: Render paths call this after normal text rendering. It calls `remap_wrapped_line` so wrapping is respected and `osc8_hyperlink` to create the actual terminal escape sequence.

*Call graph*: calls 2 internal fn (osc8_hyperlink, remap_wrapped_line); called by 4 (render, render, render, buffer_hyperlinks_follow_word_wrapping); 6 external calls (empty, new, new, from, try_from, from).


##### `mark_url_hyperlink`  (lines 486–490)

```
fn mark_url_hyperlink(buf: &mut Buffer, area: Rect, destination: &str)
```

**Purpose**: Marks cells in an area as one hyperlink when they look like the UI’s URL style: cyan and underlined. It is a convenience wrapper for a specific visual convention.

**Data flow**: It receives a buffer, a rectangular area, and a destination URL. It asks `mark_matching_cells` to decorate only cells whose foreground color is cyan and whose modifier includes underline. Matching cells are changed to contain OSC 8-wrapped symbols.

**Call relations**: Render code calls this when it has already drawn a URL-looking region and wants those styled cells to become clickable.

*Call graph*: calls 1 internal fn (mark_matching_cells); called by 3 (render, render, mark_url_hyperlink).


##### `mark_underlined_hyperlink`  (lines 492–496)

```
fn mark_underlined_hyperlink(buf: &mut Buffer, area: Rect, destination: &str)
```

**Purpose**: Marks every underlined nonblank cell in an area as pointing to one destination. It is useful when underline alone signals a clickable reference.

**Data flow**: It receives a buffer, area, and destination. It delegates to `mark_matching_cells` with a rule that selects cells containing the underline modifier. Matching cells are rewritten with hyperlink escape codes.

**Call relations**: Reference rendering code calls this after drawing underlined text that should behave as a hyperlink.

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

**Purpose**: Decorates buffer cells that pass a caller-provided test with OSC 8 hyperlink codes. It is the shared worker behind the style-specific marking helpers.

**Data flow**: It receives a buffer, area, destination, and a matching rule. It first validates the destination; if invalid, it changes nothing. Then it walks every cell in the area, skips blank or hidden cells, applies the matching rule, and wraps matching cell symbols with `osc8_hyperlink`.

**Call relations**: `mark_url_hyperlink` and `mark_underlined_hyperlink` call this with different visual matching rules.

*Call graph*: calls 2 internal fn (osc8_hyperlink, web_destination); called by 2 (mark_underlined_hyperlink, mark_url_hyperlink); 1 external calls (positions).


##### `tests::only_web_destinations_receive_osc8`  (lines 522–533)

```
fn only_web_destinations_receive_osc8()
```

**Purpose**: Checks that only safe web destinations get OSC 8 hyperlink codes. It also verifies that control characters are removed and that stripping OSC 8 leaves the visible text.

**Data flow**: The test feeds valid and invalid destinations into `osc8_hyperlink`, compares the output with expected strings, and uses `strip_osc8` to confirm the readable text remains unchanged.

**Call relations**: This protects the safety behavior shared by all final hyperlink output paths.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::discovers_punctuated_web_url_columns`  (lines 536–544)

```
fn discovers_punctuated_web_url_columns()
```

**Purpose**: Checks that URL detection ignores surrounding punctuation when recording link columns. This covers common text like a link inside parentheses followed by a period.

**Data flow**: The test passes a sentence containing `(https://example.com/a).` into `web_links_in_text`. It expects one hyperlink whose range covers only the URL characters and whose destination excludes punctuation.

**Call relations**: This verifies the trimming logic used by automatic URL annotation.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::preserves_balanced_parentheses_in_bare_web_urls`  (lines 547–556)

```
fn preserves_balanced_parentheses_in_bare_web_urls()
```

**Purpose**: Checks that balanced parentheses inside a URL are kept as part of the link. This prevents legitimate URLs, such as Wikipedia article links, from being shortened incorrectly.

**Data flow**: The test builds a sentence around a URL ending in balanced parentheses and scans it with `web_links_in_text`. It expects the full URL, including the balanced parentheses, to be linked.

**Call relations**: This guards the delimiter-counting behavior used by `trailing_url_end`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::decorates_a_contiguous_web_link_with_one_osc8_pair`  (lines 559–577)

```
fn decorates_a_contiguous_web_link_with_one_osc8_pair()
```

**Purpose**: Checks that one continuous linked range becomes one OSC 8 hyperlink wrapper, not many separate wrappers. It also confirms that lines with no links are left alone.

**Data flow**: The test creates a `HyperlinkLine` whose whole visible text is linked, runs `decorate_spans`, and compares the result with a single OSC 8-wrapped span. It then checks that an unlinked line returns its original span.

**Call relations**: This verifies the span decoration path used when writing hyperlink-aware history lines.

*Call graph*: 3 external calls (from, assert_eq!, vec!).


##### `tests::wrapping_maps_repeated_link_labels_by_source_position`  (lines 580–596)

```
fn wrapping_maps_repeated_link_labels_by_source_position()
```

**Purpose**: Checks that remapping links after wrapping uses the original source position, not just matching text. This matters when the same word appears more than once but only one occurrence is linked.

**Data flow**: The test creates a line reading `here here`, marks only the second `here` as linked, and passes it through `remap_wrapped_line`. It expects the link to stay on the second occurrence.

**Call relations**: This protects `remap_wrapped_line` from a subtle bug where repeated text could cause links to move to the wrong copy.

*Call graph*: calls 2 internal fn (new, remap_wrapped_line); 3 external calls (from, assert_eq!, vec!).


##### `tests::buffer_hyperlinks_follow_word_wrapping`  (lines 599–626)

```
fn buffer_hyperlinks_follow_word_wrapping()
```

**Purpose**: Checks that buffer-cell hyperlink marking follows Ratatui word wrapping correctly. A URL split across rows should still have every visible URL character linked.

**Data flow**: The test renders a line containing a URL into a narrow buffer, calls `mark_buffer_hyperlinks`, then collects cells that contain the OSC 8 link and strips the escape codes. It expects the collected visible text to equal the full destination URL.

**Call relations**: This verifies the full on-screen path: normal paragraph rendering, wrapped link remapping, and final buffer-cell OSC 8 decoration.

*Call graph*: calls 2 internal fn (new, mark_buffer_hyperlinks); 7 external calls (empty, from, new, new, from, assert_eq!, format!).


### `tui/src/wrapping.rs`

`domain_logic` · `text rendering`

Terminal screens are narrow, so messages, command output, markdown, and tool results must be split into display lines. A normal word wrapper often treats slashes and hyphens as safe break points. That is fine for prose, but bad for URLs: if `https://example.com/a-b` is split in the middle, many terminal emulators no longer recognize it as one clickable link. This file solves that problem.

It has two wrapping paths. The standard path uses the `textwrap` library much like a regular paragraph wrapper. The adaptive path first checks whether a line contains something that looks like a URL. If not, it uses the standard path. If it does, it changes the wrapping rules so URL-like tokens stay whole. For lines that mix prose and URLs, it uses a custom token-by-token wrapper: ordinary words still wrap neatly, but the URL is treated like a fragile label that should not be cut.

The file also understands Ratatui `Line` and `Span` values, which are pieces of terminal text with style such as color. It flattens styled text to wrap it, then maps the chosen byte ranges back onto the original spans so colors survive. Several helper functions detect URL-like tokens, validate hosts and ports, and convert wrapped output back into source ranges for cursor positioning.

#### Function details

##### `wrap_ranges`  (lines 42–80)

```
fn wrap_ranges(text: &str, width_or_options: O) -> Vec<Range<usize>>
```

**Purpose**: Finds the byte ranges in the original text that correspond to each wrapped display line. It keeps trailing spaces and adds a one-byte sentinel so textarea cursor code can reason about line ends.

**Data flow**: It receives source text and either a width or wrapping options. It asks `textwrap` to wrap the text, maps each wrapped slice back to byte positions in the original string, includes trailing spaces, and returns a list of source ranges.

**Call relations**: Cursor-oriented wrapping code calls this when it needs positions rather than styled display lines. It relies on `borrowed_slice_range` when `textwrap` returns a borrowed slice, and falls back to `map_owned_wrapped_line_to_range` when `textwrap` has created a new string with indentation or hyphenation characters.

*Call graph*: calls 2 internal fn (borrowed_slice_range, map_owned_wrapped_line_to_range); called by 3 (wrapped_lines, wrap_ranges_indent_prefix_coincides_with_source_char, wrap_ranges_recovers_with_non_space_indents); 3 external calls (into, new, wrap).


##### `wrap_ranges_trim`  (lines 85–119)

```
fn wrap_ranges_trim(text: &str, width_or_options: O) -> Vec<Range<usize>>
```

**Purpose**: Finds byte ranges for wrapped lines without preserving trailing spaces or adding the cursor sentinel. This is the general-purpose range helper used by normal line wrapping.

**Data flow**: It receives text plus wrapping options, runs `textwrap`, maps each output line back to the original text, and returns clean byte ranges for the visible content.

**Call relations**: `word_wrap_line` uses this to decide which parts of the flattened line belong on each rendered row. Like `wrap_ranges`, it uses direct pointer mapping when possible and the owned-line mapper when `textwrap` produced synthetic output.

*Call graph*: calls 2 internal fn (borrowed_slice_range, map_owned_wrapped_line_to_range); called by 2 (wrap_ranges_trim_handles_owned_lines_with_penalty_char, word_wrap_line); 3 external calls (into, new, wrap).


##### `borrowed_slice_range`  (lines 121–132)

```
fn borrowed_slice_range(text: &str, slice: &str) -> Option<Range<usize>>
```

**Purpose**: Checks whether a string slice really points inside the original source text and, if so, returns its byte range. This is a fast and exact way to map borrowed wrapped text back to the input.

**Data flow**: It receives the original text and a slice. It compares their memory addresses, and if the slice lies inside the original text, it converts that address difference into a start and end byte range.

**Call relations**: `wrap_ranges` and `wrap_ranges_trim` try this first for borrowed `textwrap` output. If it cannot prove the slice came from the source, those callers switch to the safer character-by-character mapper.

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

**Purpose**: Maps a wrapped line that `textwrap` built as a new string back to the original source text. This matters when `textwrap` adds indentation or a hyphen that does not exist in the source.

**Data flow**: It receives the original text, the current source cursor, the wrapped string, and any synthetic indent prefix. It strips the prefix, skips source spaces as needed, walks matching characters, ignores a trailing inserted hyphen, and returns the best matching source byte range.

**Call relations**: `wrap_ranges` and `wrap_ranges_trim` call this whenever direct slice mapping is not available. If it sees an unexpected mismatch after matching real source characters, it logs a warning and returns the safe partial range instead of crashing.

*Call graph*: called by 6 (borrowed_slice_range_rejects_slices_outside_source_text, map_owned_wrapped_line_to_range_indent_coincides_with_source, map_owned_wrapped_line_to_range_recovers_on_non_prefix_mismatch, map_owned_wrapped_line_to_range_repro_overconsumes_repeated_prefix_patterns, wrap_ranges, wrap_ranges_trim); 2 external calls (warn!, unreachable!).


##### `line_contains_url_like`  (lines 208–215)

```
fn line_contains_url_like(line: &Line<'_>) -> bool
```

**Purpose**: Checks whether a styled terminal line contains any token that looks like a URL. It lets wrapping code choose URL-safe behavior without caring how the line is split into styled spans.

**Data flow**: It receives a Ratatui `Line`, concatenates all span text into one plain string, then asks `text_contains_url_like` whether any whitespace-separated token resembles a URL.

**Call relations**: `adaptive_wrap_line` uses this as its first decision point. Other rendering code also calls it when deciding how to treat hyperlink-like history text.

*Call graph*: calls 1 internal fn (text_contains_url_like); called by 2 (insert_history_hyperlink_lines_with_mode_and_wrap_policy, adaptive_wrap_line).


##### `line_has_mixed_url_and_non_url_tokens`  (lines 222–229)

```
fn line_has_mixed_url_and_non_url_tokens(line: &Line<'_>) -> bool
```

**Purpose**: Checks whether a line has both a URL-like token and real non-URL words. This separates URL-only lines from prose that merely contains a URL.

**Data flow**: It receives a styled line, joins its span text into one string, then delegates to the plain-text mixed-token checker. Decorative markers such as list bullets do not count as real prose.

**Call relations**: `adaptive_wrap_line` uses this after detecting a URL. If the line is mixed, wrapping switches to the custom mixed URL wrapper; otherwise it can use simpler URL-preserving options.

*Call graph*: calls 1 internal fn (text_has_mixed_url_and_non_url_tokens); called by 2 (insert_history_hyperlink_lines_with_mode_and_wrap_policy, adaptive_wrap_line).


##### `text_contains_url_like`  (lines 242–244)

```
fn text_contains_url_like(text: &str) -> bool
```

**Purpose**: Checks plain text for any whitespace-separated token that looks like a URL. It is the main URL detector for unstyled text.

**Data flow**: It receives text, splits it on ASCII whitespace, tests each token, and returns true as soon as one token is URL-like.

**Call relations**: `line_contains_url_like` builds plain text from styled spans and then calls this. The result controls whether wrapping should protect URLs from being split.

*Call graph*: called by 1 (line_contains_url_like).


##### `text_has_mixed_url_and_non_url_tokens`  (lines 248–265)

```
fn text_has_mixed_url_and_non_url_tokens(text: &str) -> bool
```

**Purpose**: Decides whether text contains at least one URL-like token and at least one meaningful non-URL token. It ignores visual markers that are not content words.

**Data flow**: It receives text, scans each whitespace-separated token, records whether it has seen a URL and whether it has seen real non-URL content, and returns true once both are present.

**Call relations**: `line_has_mixed_url_and_non_url_tokens` calls this after flattening a styled line. It uses `is_url_like_token` and `is_substantive_non_url_token` to classify each token.

*Call graph*: calls 2 internal fn (is_substantive_non_url_token, is_url_like_token); called by 1 (line_has_mixed_url_and_non_url_tokens).


##### `is_url_like_token`  (lines 271–274)

```
fn is_url_like_token(raw_token: &str) -> bool
```

**Purpose**: Decides whether one token, such as `example.com/path`, should be treated as a URL. This is intentionally cautious so ordinary file paths are not mistaken for links.

**Data flow**: It receives a raw token, strips surrounding punctuation, then checks whether the cleaned token is either an absolute URL with `://` or a bare host-style URL.

**Call relations**: Mixed-line detection and mixed wrapping both call this to mark fragile URL tokens. It hands the detailed checks to `is_absolute_url_like` and `is_bare_url_like`.

*Call graph*: calls 3 internal fn (is_absolute_url_like, is_bare_url_like, trim_url_token); called by 2 (mixed_url_wrap_ranges, text_has_mixed_url_and_non_url_tokens).


##### `is_substantive_non_url_token`  (lines 276–283)

```
fn is_substantive_non_url_token(raw_token: &str) -> bool
```

**Purpose**: Decides whether a token is real non-URL content rather than punctuation, a bullet, or a list marker. This prevents a line like `1. https://...` from being treated as mixed prose.

**Data flow**: It receives a raw token, trims URL-style surrounding punctuation, rejects empty or decorative tokens, and then checks whether any alphanumeric character remains.

**Call relations**: `text_has_mixed_url_and_non_url_tokens` calls this for tokens that are not URLs. It uses `is_decorative_marker_token` to filter layout symbols.

*Call graph*: calls 2 internal fn (is_decorative_marker_token, trim_url_token); called by 1 (text_has_mixed_url_and_non_url_tokens).


##### `is_decorative_marker_token`  (lines 285–305)

```
fn is_decorative_marker_token(raw_token: &str, token: &str) -> bool
```

**Purpose**: Recognizes small tokens that are visual structure, such as bullets, pipes, tree-drawing characters, or ordered-list markers. These should not count as prose.

**Data flow**: It receives the raw token and its trimmed form, compares the raw text against known marker symbols, and also checks for numeric list markers like `1.` or `2)`.

**Call relations**: `is_substantive_non_url_token` calls this while deciding whether non-URL text is meaningful. It delegates numeric marker recognition to `is_ordered_list_marker`.

*Call graph*: calls 1 internal fn (is_ordered_list_marker); called by 1 (is_substantive_non_url_token); 1 external calls (matches!).


##### `is_ordered_list_marker`  (lines 307–310)

```
fn is_ordered_list_marker(raw_token: &str, token: &str) -> bool
```

**Purpose**: Recognizes ordered-list markers such as `1.` or `23)`. These are layout labels, not substantive words.

**Data flow**: It receives the raw token and trimmed token, checks that the trimmed part is all digits, and verifies that the raw token ended with `.` or `)`.

**Call relations**: `is_decorative_marker_token` calls this when it needs to decide whether a token is a numbered list prefix.

*Call graph*: called by 1 (is_decorative_marker_token).


##### `trim_url_token`  (lines 312–332)

```
fn trim_url_token(token: &str) -> &str
```

**Purpose**: Removes punctuation that commonly surrounds URLs in prose, such as parentheses, commas, periods, and quotes. This lets `(https://example.com)` still be detected as a URL.

**Data flow**: It receives a token and returns a borrowed slice with matching surrounding punctuation removed from both ends.

**Call relations**: Both URL detection and non-URL token detection call this before classifying a token. It is the shared cleanup step for token-based wrapping decisions.

*Call graph*: called by 2 (is_substantive_non_url_token, is_url_like_token).


##### `is_absolute_url_like`  (lines 337–354)

```
fn is_absolute_url_like(token: &str) -> bool
```

**Purpose**: Checks for full URLs that include a scheme, such as `https://`, `ftp://`, or a custom app scheme. A scheme is the prefix before `://` that says what kind of link it is.

**Data flow**: It receives a cleaned token, rejects it if it lacks `://`, tries to parse it as a URL, verifies hosts for common network schemes, and falls back to a custom scheme-prefix check if parsing fails.

**Call relations**: `is_url_like_token` calls this before trying bare-domain URL rules. It uses the URL parser for standard cases and `has_valid_scheme_prefix` for custom schemes.

*Call graph*: calls 1 internal fn (has_valid_scheme_prefix); called by 1 (is_url_like_token); 2 external calls (matches!, parse).


##### `has_valid_scheme_prefix`  (lines 356–370)

```
fn has_valid_scheme_prefix(token: &str) -> bool
```

**Purpose**: Checks whether the part before `://` looks like a valid custom URL scheme. This catches links such as `myapp://open` even if the URL parser does not accept them.

**Data flow**: It receives a token, splits it at `://`, ensures both sides are present, and checks that the scheme starts with a letter and contains only allowed scheme characters.

**Call relations**: `is_absolute_url_like` calls this as a fallback when normal URL parsing fails.

*Call graph*: called by 1 (is_absolute_url_like).


##### `is_bare_url_like`  (lines 380–402)

```
fn is_bare_url_like(token: &str) -> bool
```

**Purpose**: Checks for URL-like text without a scheme, such as `www.example.com`, `localhost:3000/api`, or `127.0.0.1/health`. It avoids treating ordinary paths as URLs.

**Data flow**: It receives a cleaned token, separates the host and optional URL trailer, splits out an optional port, validates the port if present, and accepts only localhost, IPv4 addresses, or valid domain names.

**Call relations**: `is_url_like_token` calls this after checking absolute URLs. It uses small helpers to split host, port, and trailer and to validate each kind of host.

*Call graph*: calls 5 internal fn (is_domain_name, is_ipv4, is_valid_port, split_host_and_port, split_host_port_and_trailer); called by 1 (is_url_like_token).


##### `split_host_port_and_trailer`  (lines 404–410)

```
fn split_host_port_and_trailer(token: &str) -> (&str, bool)
```

**Purpose**: Separates the host-and-port part of a bare URL from the path, query, or fragment that follows it. The trailer is what makes `example.com/path` look URL-like.

**Data flow**: It receives a token and looks for `/`, `?`, or `#`. If found, it returns the part before that marker and says a trailer exists; otherwise it returns the whole token and says there is no trailer.

**Call relations**: `is_bare_url_like` calls this before host and port validation.

*Call graph*: called by 1 (is_bare_url_like).


##### `split_host_and_port`  (lines 412–427)

```
fn split_host_and_port(host_port: &str) -> (&str, Option<&str>)
```

**Purpose**: Splits a host from a numeric port suffix like `localhost:3000`. It intentionally does not try to understand bracketed IPv6 addresses.

**Data flow**: It receives a host-port string, rejects bracketed forms for special handling, and if the final colon is followed by digits, returns the host plus that port. Otherwise it returns the whole string as the host.

**Call relations**: `is_bare_url_like` calls this after separating any path or query trailer.

*Call graph*: called by 1 (is_bare_url_like).


##### `is_valid_port`  (lines 429–435)

```
fn is_valid_port(port: &str) -> bool
```

**Purpose**: Checks whether a port string is a valid network port number. Ports must be digits and fit in the normal 0 to 65535 range.

**Data flow**: It receives the port text, rejects empty, too-long, or non-digit values, then parses it as a 16-bit unsigned number and returns whether that worked.

**Call relations**: `is_bare_url_like` calls this when a bare URL token includes a port.

*Call graph*: called by 1 (is_bare_url_like).


##### `is_ipv4`  (lines 437–446)

```
fn is_ipv4(host: &str) -> bool
```

**Purpose**: Checks whether a host looks like an IPv4 address, such as `192.168.1.1`. IPv4 is the familiar four-number internet address format.

**Data flow**: It receives host text, splits it by dots, requires exactly four parts, and checks each part can be parsed as a byte-sized number.

**Call relations**: `is_bare_url_like` uses this as one of the accepted host forms.

*Call graph*: called by 1 (is_bare_url_like).


##### `is_domain_name`  (lines 448–463)

```
fn is_domain_name(host: &str) -> bool
```

**Purpose**: Checks whether a host looks like a normal domain name with a real-looking top-level ending, such as `example.com`. This helps reject file paths like `src/main.rs`.

**Data flow**: It lowercases the host, requires at least one dot, checks the last label as a top-level domain, and checks each earlier label for domain-name rules.

**Call relations**: `is_bare_url_like` uses this after localhost and IPv4 checks. It relies on `is_tld` and the label rules to decide whether the host is plausible.

*Call graph*: calls 1 internal fn (is_tld); called by 1 (is_bare_url_like).


##### `is_tld`  (lines 465–467)

```
fn is_tld(label: &str) -> bool
```

**Purpose**: Checks whether the final part of a domain, such as `com` or `org`, is a plausible top-level domain. It must be alphabetic and reasonably sized.

**Data flow**: It receives one domain label and returns true only if it is 2 to 63 characters long and all letters.

**Call relations**: `is_domain_name` calls this for the final domain segment before accepting a bare host.

*Call graph*: called by 1 (is_domain_name).


##### `is_domain_label`  (lines 469–485)

```
fn is_domain_label(label: &str) -> bool
```

**Purpose**: Checks whether one non-final piece of a domain name follows common domain label rules. Labels may contain letters, digits, and hyphens, but cannot start or end with a hyphen.

**Data flow**: It receives a label, rejects empty or too-long labels, reads the first and last characters, and confirms every character is allowed.

**Call relations**: This is the label-level rule used by the domain-name validation path. It supports the URL detector’s goal of accepting domains while rejecting ordinary path-like text.


##### `url_preserving_wrap_options`  (lines 493–497)

```
fn url_preserving_wrap_options(opts: RtOptions<'a>) -> RtOptions<'a>
```

**Purpose**: Changes wrapping options so URL-like tokens are not split at slashes, hyphens, or arbitrary character boundaries. It is the simple protection mode for URL-only lines.

**Data flow**: It receives runtime wrapping options, changes word separation to spaces only, disables hyphen-based splitting, disables long-word breaking, and returns the adjusted options.

**Call relations**: `adaptive_wrap_line` calls this when a line contains a URL but not meaningful surrounding prose.

*Call graph*: calls 1 internal fn (word_separator); called by 1 (adaptive_wrap_line).


##### `adaptive_wrap_line`  (lines 508–518)

```
fn adaptive_wrap_line(line: &'a Line<'a>, base: RtOptions<'a>) -> Vec<Line<'a>>
```

**Purpose**: Wraps one styled terminal line and automatically chooses the safest wrapping strategy for URLs. Callers use it when text might contain clickable links.

**Data flow**: It receives a line and wrapping options. It first checks for URL-like text; if none is found, it uses normal wrapping. If URLs are present, it either uses mixed URL-aware wrapping for prose plus URLs or URL-preserving options for URL-only text.

**Call relations**: Many rendering paths call this while building transcript, command, and history display lines. It is the main decision point that routes work to `word_wrap_line`, `mixed_url_wrap_line`, or URL-preserving options.

*Call graph*: calls 5 internal fn (line_contains_url_like, line_has_mixed_url_and_non_url_tokens, mixed_url_wrap_line, url_preserving_wrap_options, word_wrap_line); called by 14 (command_display_lines, exploring_display_lines, transcript_lines, user_shell_output_is_limited_by_screen_lines, insert_history_hyperlink_lines_with_mode_and_wrap_policy, flush_current_line, adaptive_wrap_hyperlink_lines, adaptive_wrap_lines, adaptive_wrap_line_keeps_long_url_like_token_intact, adaptive_wrap_line_mixed_line_counts_leading_spaces_before_first_word (+4 more)).


##### `adaptive_wrap_lines`  (lines 528–554)

```
fn adaptive_wrap_lines(
    lines: I,
    width_or_options: RtOptions<'a>,
) -> Vec<Line<'static>>
```

**Purpose**: Wraps a sequence of lines with the same URL-aware rules as `adaptive_wrap_line`. It applies the initial indent only to the first input line and continuation indent afterward.

**Data flow**: It receives any iterable of line-like inputs plus wrapping options. For each input line, it chooses the right indent, calls `adaptive_wrap_line`, converts the result into owned output lines, and appends them to the output list.

**Call relations**: Higher-level renderers call this for transcript and history sections. It repeatedly uses `adaptive_wrap_line` and then `push_owned_lines` so the final lines can outlive the borrowed inputs.

*Call graph*: calls 2 internal fn (push_owned_lines, adaptive_wrap_line); called by 7 (install_confirmation_lines, as_renderable, push_section_header, as_renderable, transcript_lines, render_transcript_content_lines, display_lines); 2 external calls (into_iter, new).


##### `RtOptions::from`  (lines 584–586)

```
fn from(width: usize) -> Self
```

**Purpose**: Lets a plain width number be used wherever runtime wrapping options are expected. This keeps simple call sites short.

**Data flow**: It receives a width and returns a new `RtOptions` value with that width and default wrapping behavior.

**Call relations**: Generic wrapping functions accept values that can turn into `RtOptions`; this conversion is what makes calls like `word_wrap_line(line, 80)` work.

*Call graph*: calls 1 internal fn (new).


##### `RtOptions::new`  (lines 591–602)

```
fn new(width: usize) -> Self
```

**Purpose**: Creates the default runtime wrapping configuration for Ratatui lines. It sets width, no indentation, normal word breaking, and the default `textwrap` behavior.

**Data flow**: It receives a target width and builds an `RtOptions` struct with default line ending, empty first and subsequent indents, word breaking enabled, and standard separator, splitter, and algorithm settings.

**Call relations**: Rendering code and tests call this whenever they need to customize wrapping options. Builder-style methods then adjust individual fields.

*Call graph*: called by 43 (install_confirmation_lines, as_renderable, push_section_header, as_renderable, wrap_standard_row, wrap_styled_line, command_display_lines, exploring_display_lines, transcript_lines, user_shell_output_is_limited_by_screen_lines (+15 more)); 2 external calls (default, new).


##### `RtOptions::line_ending`  (lines 604–609)

```
fn line_ending(self, line_ending: textwrap::LineEnding) -> Self
```

**Purpose**: Returns a copy of the options with a different line-ending setting. Line endings describe how wrapped lines would be separated in plain text.

**Data flow**: It receives existing options and a line-ending value, replaces that field, and returns the updated options.

**Call relations**: This is one of the builder-style methods used when callers need more than just a width.


##### `RtOptions::width`  (lines 611–613)

```
fn width(self, width: usize) -> Self
```

**Purpose**: Returns a copy of the options with a different target width. This is useful when indentation has reduced the available content space.

**Data flow**: It receives existing options and a new width, replaces the width field, and returns the updated options.

**Call relations**: Wrapping code uses this style of option adjustment when it asks `textwrap` to wrap first and subsequent lines at different available widths.


##### `RtOptions::initial_indent`  (lines 615–620)

```
fn initial_indent(self, initial_indent: Line<'a>) -> Self
```

**Purpose**: Returns a copy of the options with a new prefix for the first wrapped output line. The prefix is itself a styled Ratatui line.

**Data flow**: It receives existing options and a styled line to use as the first-line indent, stores it, and returns the updated options.

**Call relations**: Multi-line wrappers use this to ensure only the very first output line receives the initial indent; later input lines are switched to the subsequent indent.


##### `RtOptions::subsequent_indent`  (lines 622–627)

```
fn subsequent_indent(self, subsequent_indent: Line<'a>) -> Self
```

**Purpose**: Returns a copy of the options with a new prefix for continuation lines. This lets wrapped text align under bullets, quotes, or other UI decorations.

**Data flow**: It receives existing options and a styled line to use after the first wrapped line, stores it, and returns the updated options.

**Call relations**: Renderers set this before calling the wrapping functions when they need wrapped lines to line up visually.


##### `RtOptions::break_words`  (lines 629–634)

```
fn break_words(self, break_words: bool) -> Self
```

**Purpose**: Returns a copy of the options with word-breaking turned on or off. Turning it off allows a long token to overflow instead of being split.

**Data flow**: It receives existing options and a boolean, stores that choice, and returns the updated options.

**Call relations**: URL-preserving wrapping turns this off so long URLs remain one token. Tests also use it to verify overflow behavior.


##### `RtOptions::word_separator`  (lines 636–641)

```
fn word_separator(self, word_separator: textwrap::WordSeparator) -> RtOptions<'a>
```

**Purpose**: Returns a copy of the options with a different rule for finding word boundaries. A word boundary is a place where wrapping may consider a break.

**Data flow**: It receives existing options and a `textwrap` word separator, stores it, and returns the updated options.

**Call relations**: `url_preserving_wrap_options` calls this to switch to space-only separation so slashes and hyphens inside URLs are not treated as break points.

*Call graph*: called by 1 (url_preserving_wrap_options).


##### `RtOptions::wrap_algorithm`  (lines 643–648)

```
fn wrap_algorithm(self, wrap_algorithm: textwrap::WrapAlgorithm) -> RtOptions<'a>
```

**Purpose**: Returns a copy of the options with a different wrapping algorithm. The algorithm decides how to choose line breaks once possible break points are known.

**Data flow**: It receives existing options and an algorithm value, replaces the field, and returns the updated options.

**Call relations**: This builder method is available for callers that need a different `textwrap` strategy while still using Ratatui-aware wrapping.


##### `RtOptions::word_splitter`  (lines 650–655)

```
fn word_splitter(self, word_splitter: textwrap::WordSplitter) -> RtOptions<'a>
```

**Purpose**: Returns a copy of the options with a different rule for splitting inside words. This controls behavior such as breaking at hyphens.

**Data flow**: It receives existing options and a splitter value, stores it, and returns the updated options.

**Call relations**: URL-preserving setup uses this kind of option to disable hyphen splitting, while ordinary wrapping keeps the default splitter.


##### `word_wrap_line`  (lines 659–730)

```
fn word_wrap_line(line: &'a Line<'a>, width_or_options: O) -> Vec<Line<'a>>
```

**Purpose**: Wraps one styled Ratatui line using the standard wrapping path while preserving styles and indentation. It is the core non-adaptive wrapper.

**Data flow**: It receives a styled line and width/options, flattens all spans into plain text, computes wrapped byte ranges, slices the original spans back into those ranges, adds the proper first or continuation indent, and returns styled output lines.

**Call relations**: General rendering code calls this when URL protection is not needed, and `adaptive_wrap_line` falls back to it for non-URL lines. It depends on `flatten_line`, `wrap_ranges_trim`, and `slice_line_spans` to move between styled text and byte ranges.

*Call graph*: calls 3 internal fn (flatten_line, slice_line_spans, wrap_ranges_trim); called by 20 (wrap_cell, render_stacked_field, wrap_cell, adaptive_wrap_line, ascii_space_separator_with_no_hyphenation_keeps_url_intact, break_words_false_allows_overflow_for_long_word, empty_initial_indent_subsequent_spaces, empty_input_yields_single_empty_line, hyphen_splitter_breaks_at_hyphen, indent_consumes_width_leaving_one_char_space (+10 more)); 4 external calls (into, new, new, vec!).


##### `MixedUrlWord::width`  (lines 739–741)

```
fn width(&self, text: &str) -> usize
```

**Purpose**: Measures how wide one mixed-wrapper word appears on screen. This matters because some characters, such as emoji, take more than one terminal column.

**Data flow**: It receives a `MixedUrlWord` and the full source text, slices the word’s byte range, measures its display width, and returns that width.

**Call relations**: `split_mixed_url_word` uses this to decide whether a non-URL token must be broken into smaller pieces.

*Call graph*: called by 1 (split_mixed_url_word); 2 external calls (display_width, clone).


##### `mixed_url_wrap_line`  (lines 744–781)

```
fn mixed_url_wrap_line(line: &'a Line<'a>, rt_opts: RtOptions<'a>) -> Vec<Line<'a>>
```

**Purpose**: Wraps a styled line that contains both prose and URLs. It keeps URL tokens whole while still allowing normal prose and very long non-URL words to wrap.

**Data flow**: It receives a styled line and options, flattens the line, computes URL-aware source ranges, slices the original styled spans for each range, adds first or continuation indentation, and returns styled wrapped lines.

**Call relations**: `adaptive_wrap_line` calls this only for mixed URL/prose lines. It uses `mixed_url_wrap_ranges` for the custom line-break decisions and `slice_line_spans` to preserve styles.

*Call graph*: calls 3 internal fn (flatten_line, mixed_url_wrap_ranges, slice_line_spans); called by 1 (adaptive_wrap_line); 2 external calls (new, vec!).


##### `mixed_url_wrap_ranges`  (lines 783–877)

```
fn mixed_url_wrap_ranges(
    text: &str,
    initial_width: usize,
    subsequent_width: usize,
) -> Vec<Range<usize>>
```

**Purpose**: Computes byte ranges for wrapping mixed prose and URL text. Think of it as packing words into rows while treating URLs as unbreakable fragile items.

**Data flow**: It receives text plus available widths for the first and later lines. It splits text by spaces, marks each word as URL or non-URL, splits overlong non-URL words when needed, then builds source ranges that fit the current line width.

**Call relations**: `mixed_url_wrap_line` calls this to get the ranges it will render. It uses `is_url_like_token` to protect URLs and `split_mixed_url_word` to break only non-URL words.

*Call graph*: calls 2 internal fn (is_url_like_token, split_mixed_url_word); called by 1 (mixed_url_wrap_line); 1 external calls (new).


##### `split_mixed_url_word`  (lines 879–896)

```
fn split_mixed_url_word(text: &str, word: MixedUrlWord, line_limit: usize) -> Vec<MixedUrlWord>
```

**Purpose**: Breaks a non-URL word into smaller pieces if it is too wide for the available line. URL words are deliberately never split here.

**Data flow**: It receives the full text, a word range, and a line width. If the word is a URL or already fits, it returns it unchanged; otherwise it asks `textwrap` to break it apart and returns smaller word ranges.

**Call relations**: `mixed_url_wrap_ranges` calls this before placing words on lines, and may call it again when continuation indentation leaves less room.

*Call graph*: calls 1 internal fn (width); called by 1 (mixed_url_wrap_ranges); 3 external calls (new, from, vec!).


##### `flatten_line`  (lines 898–910)

```
fn flatten_line(line: &Line<'_>) -> (String, Vec<(Range<usize>, ratatui::style::Style)>)
```

**Purpose**: Turns a styled Ratatui line into plain text plus a map of which byte ranges came from which styled spans. This makes wrapping possible without losing color or style information.

**Data flow**: It receives a line, appends each span’s text into one string, records the start and end bytes for each span along with its style, and returns both the flat string and the bounds map.

**Call relations**: `word_wrap_line` and `mixed_url_wrap_line` call this before wrapping. Later, `slice_line_spans` uses the recorded bounds to rebuild styled pieces.

*Call graph*: called by 2 (mixed_url_wrap_line, word_wrap_line); 2 external calls (new, new).


##### `LineInput::as_ref`  (lines 920–925)

```
fn as_ref(&self) -> &Line<'a>
```

**Purpose**: Provides a borrowed view of a line input whether it was originally borrowed or owned. This lets wrapper loops treat all input forms the same.

**Data flow**: It receives a `LineInput` enum value and returns a reference to the contained `Line` in either case.

**Call relations**: Multi-line wrapping functions call this after converting flexible inputs into `LineInput` values.


##### `Line::into_line_input`  (lines 946–948)

```
fn into_line_input(self) -> LineInput<'a>
```

**Purpose**: Converts a Ratatui line reference into the internal line-input wrapper. This avoids copying when the caller already has a line.

**Data flow**: It receives a borrowed line and returns a `LineInput::Borrowed` variant pointing at it.

**Call relations**: `word_wrap_lines` and `adaptive_wrap_lines` use the `IntoLineInput` trait so callers can pass borrowed lines, owned lines, strings, spans, or span lists.

*Call graph*: 2 external calls (Borrowed, Owned).


##### `String::into_line_input`  (lines 952–954)

```
fn into_line_input(self) -> LineInput<'a>
```

**Purpose**: Converts an owned string into a styled line input for wrapping. This makes plain strings acceptable to the multi-line wrapper.

**Data flow**: It receives a `String`, turns it into a Ratatui `Line`, wraps that as an owned `LineInput`, and returns it.

**Call relations**: The generic multi-line wrappers call this through the `IntoLineInput` trait when their input iterator yields owned strings.

*Call graph*: 2 external calls (from, Owned).


##### `str::into_line_input`  (lines 958–960)

```
fn into_line_input(self) -> LineInput<'a>
```

**Purpose**: Converts a string slice into an owned Ratatui line for wrapping. This lets callers pass plain `&str` values directly.

**Data flow**: It receives a borrowed string slice, builds a `Line` from it, stores that line as owned input, and returns the wrapper value.

**Call relations**: `word_wrap_lines` and `adaptive_wrap_lines` use this through the trait when wrapping arrays or iterators of string slices.

*Call graph*: 2 external calls (from, Owned).


##### `Cow::into_line_input`  (lines 964–966)

```
fn into_line_input(self) -> LineInput<'a>
```

**Purpose**: Converts a copy-on-write string into an owned Ratatui line input. A copy-on-write string may be borrowed or owned, but the wrapper stores it as a line.

**Data flow**: It receives a `Cow<str>`, builds a `Line` from it, wraps the line as owned input, and returns it.

**Call relations**: The flexible input trait uses this so callers with `Cow` text do not need to convert it manually before wrapping.

*Call graph*: 2 external calls (from, Owned).


##### `Span::into_line_input`  (lines 970–972)

```
fn into_line_input(self) -> LineInput<'a>
```

**Purpose**: Converts a single styled span into a line input. This lets callers wrap one styled fragment without first putting it in a line themselves.

**Data flow**: It receives a `Span`, turns it into a `Line`, wraps that line as owned input, and returns it.

**Call relations**: The multi-line wrappers accept this through the shared input-conversion trait.

*Call graph*: 2 external calls (from, Owned).


##### `Vec::into_line_input`  (lines 976–978)

```
fn into_line_input(self) -> LineInput<'a>
```

**Purpose**: Converts a vector of styled spans into a line input. This is useful when a caller has already built styled pieces but not a Ratatui `Line`.

**Data flow**: It receives a vector of spans, builds a `Line` from the vector, wraps the line as owned input, and returns it.

**Call relations**: `word_wrap_lines` and `adaptive_wrap_lines` can use this conversion when an input iterator yields span vectors.

*Call graph*: 2 external calls (from, Owned).


##### `word_wrap_lines`  (lines 984–1008)

```
fn word_wrap_lines(lines: I, width_or_options: O) -> Vec<Line<'static>>
```

**Purpose**: Wraps a sequence of line-like inputs using the standard, non-adaptive wrapper. It applies the special initial indent only once across the whole sequence.

**Data flow**: It receives an iterator of inputs and width/options. Each input is converted to `LineInput`, wrapped with `word_wrap_line`, then copied into an owned output vector; after the first input, the subsequent indent becomes the initial indent.

**Call relations**: Renderers and tests call this when text is known to be ordinary prose or when URL-aware behavior is not desired. It uses `push_owned_lines` so the returned lines are independent of temporary input data.

*Call graph*: calls 2 internal fn (push_owned_lines, word_wrap_line); called by 8 (agent_markdown_cell_survives_insert_history_rewrap, e2e_stream_blockquote_wrap_preserves_green_style, display_lines, wrapped_details_lines, wrap_lines_accepts_borrowed_iterators, wrap_lines_accepts_str_slices, wrap_lines_applies_initial_indent_only_once, wrap_lines_without_indents_is_concat_of_single_wraps); 3 external calls (into_iter, into, new).


##### `word_wrap_lines_borrowed`  (lines 1011–1031)

```
fn word_wrap_lines_borrowed(lines: I, width_or_options: O) -> Vec<Line<'a>>
```

**Purpose**: Wraps a sequence of borrowed Ratatui lines without converting the output to static ownership. It is a borrowed-output variant of the standard multi-line wrapper.

**Data flow**: It receives borrowed lines and options, wraps each with `word_wrap_line`, switches to continuation indentation after the first line, and extends a borrowed-output vector.

**Call relations**: Tests and any borrowed-line callers use this when the input lines live long enough for the output to borrow from them.

*Call graph*: calls 1 internal fn (word_wrap_line); called by 3 (word_wrap_does_not_split_words_simple_english, wrap_lines_borrowed_applies_initial_indent_only_once, wrap_lines_borrowed_without_indents_is_concat_of_single_wraps); 3 external calls (into_iter, into, new).


##### `slice_line_spans`  (lines 1033–1071)

```
fn slice_line_spans(
    original: &'a Line<'a>,
    span_bounds: &[(Range<usize>, ratatui::style::Style)],
    range: &Range<usize>,
) -> Line<'a>
```

**Purpose**: Rebuilds a styled line for a chosen byte range of the original line. It is what keeps colors and other styles attached after wrapping.

**Data flow**: It receives the original line, recorded span bounds, and a byte range. It finds overlapping spans, slices their text to the requested range, keeps their styles, and returns a new line made from those borrowed slices.

**Call relations**: `word_wrap_line` and `mixed_url_wrap_line` call this for every output row after deciding the source byte ranges.

*Call graph*: called by 2 (mixed_url_wrap_line, word_wrap_line); 3 external calls (new, Borrowed, iter).


##### `tests::concat_line`  (lines 1082–1087)

```
fn concat_line(line: &Line) -> String
```

**Purpose**: Joins the text of a Ratatui line’s spans into one plain string for test comparisons. It ignores styling so tests can check visible text easily.

**Data flow**: It receives a line, reads each span’s content, concatenates the strings, and returns the combined text.

**Call relations**: Most wrapping tests use this helper to compare rendered output without repeating span-joining code.


##### `tests::trivial_unstyled_no_indents_wide_width`  (lines 1090–1095)

```
fn trivial_unstyled_no_indents_wide_width()
```

**Purpose**: Verifies that a short unstyled line stays unchanged when the width is wide enough.

**Data flow**: It builds `hello`, wraps it at width 10, and checks that one output line contains the same text.

**Call relations**: This is a baseline test for `word_wrap_line` before narrower widths, styles, or indentation are introduced.

*Call graph*: calls 1 internal fn (word_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::simple_unstyled_wrap_narrow_width`  (lines 1098–1104)

```
fn simple_unstyled_wrap_narrow_width()
```

**Purpose**: Verifies that ordinary text wraps at a space when the width is narrow.

**Data flow**: It wraps `hello world` at width 5 and checks that the output lines are `hello` and `world`.

**Call relations**: This tests the basic standard wrapping path through `word_wrap_line`.

*Call graph*: calls 1 internal fn (word_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::simple_styled_wrap_preserves_styles`  (lines 1107–1119)

```
fn simple_styled_wrap_preserves_styles()
```

**Purpose**: Checks that wrapping a styled line does not lose the style attached to each span.

**Data flow**: It creates a line where `hello` is red and `world` is unstyled, wraps it, and checks both the text and foreground colors.

**Call relations**: This exercises `word_wrap_line`, `flatten_line`, and `slice_line_spans` together.

*Call graph*: calls 1 internal fn (word_wrap_line); 3 external calls (from, assert_eq!, vec!).


##### `tests::with_initial_and_subsequent_indents`  (lines 1122–1136)

```
fn with_initial_and_subsequent_indents()
```

**Purpose**: Verifies that first-line and continuation-line indents are applied correctly.

**Data flow**: It builds options with `- ` for the first line and two spaces for later lines, wraps a sentence, and checks the rendered prefixes and text.

**Call relations**: This confirms the indentation logic inside `word_wrap_line` and `RtOptions` builder methods.

*Call graph*: calls 2 internal fn (new, word_wrap_line); 3 external calls (from, assert!, assert_eq!).


##### `tests::empty_initial_indent_subsequent_spaces`  (lines 1139–1149)

```
fn empty_initial_indent_subsequent_spaces()
```

**Purpose**: Checks that continuation indentation works even when the first line has no indent.

**Data flow**: It wraps text with an empty initial indent and four-space subsequent indent, then verifies only later output lines start with spaces.

**Call relations**: This protects a common layout case for `word_wrap_line`.

*Call graph*: calls 2 internal fn (new, word_wrap_line); 2 external calls (from, assert!).


##### `tests::empty_input_yields_single_empty_line`  (lines 1152–1157)

```
fn empty_input_yields_single_empty_line()
```

**Purpose**: Verifies that wrapping an empty line still produces one empty output line. This avoids disappearing rows in the UI.

**Data flow**: It wraps an empty line at width 10 and checks that the output length is one and the text is empty.

**Call relations**: This tests the empty-input branch in `word_wrap_line`.

*Call graph*: calls 1 internal fn (word_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::leading_spaces_preserved_on_first_line`  (lines 1160–1165)

```
fn leading_spaces_preserved_on_first_line()
```

**Purpose**: Checks that leading spaces at the start of a line are preserved on the first wrapped output line.

**Data flow**: It wraps text beginning with three spaces and checks the output still includes them.

**Call relations**: This guards behavior in the range-mapping and first-line wrapping path.

*Call graph*: calls 1 internal fn (word_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::multiple_spaces_between_words_dont_start_next_line_with_spaces`  (lines 1168–1174)

```
fn multiple_spaces_between_words_dont_start_next_line_with_spaces()
```

**Purpose**: Verifies that extra spaces between words do not become leading spaces on the next wrapped line.

**Data flow**: It wraps `hello   world` and checks that the second line starts directly with `world`.

**Call relations**: This checks the cleanup step in `word_wrap_line` after the first wrapped range.

*Call graph*: calls 1 internal fn (word_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::break_words_false_allows_overflow_for_long_word`  (lines 1177–1183)

```
fn break_words_false_allows_overflow_for_long_word()
```

**Purpose**: Checks that disabling word breaking lets an overlong word stay on one line.

**Data flow**: It creates options with `break_words` false, wraps a very long word at width 5, and verifies no split occurs.

**Call relations**: This confirms that `RtOptions::break_words` reaches the `textwrap` configuration used by `word_wrap_line`.

*Call graph*: calls 2 internal fn (new, word_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::hyphen_splitter_breaks_at_hyphen`  (lines 1186–1192)

```
fn hyphen_splitter_breaks_at_hyphen()
```

**Purpose**: Verifies the default standard wrapper can split a hyphenated word at the hyphen.

**Data flow**: It wraps `hello-world` at width 7 and checks that the first output line is `hello-`.

**Call relations**: This documents the normal behavior that URL-preserving mode intentionally changes.

*Call graph*: calls 1 internal fn (word_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::indent_consumes_width_leaving_one_char_space`  (lines 1195–1205)

```
fn indent_consumes_width_leaving_one_char_space()
```

**Purpose**: Checks that indentation reduces the available wrapping width but still leaves at least one character of content space.

**Data flow**: It uses an indent as wide as the target width, wraps `hello`, and verifies the word is split across indented lines.

**Call relations**: This protects the width calculations in `word_wrap_line`.

*Call graph*: calls 2 internal fn (new, word_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::wide_unicode_wraps_by_display_width`  (lines 1208–1214)

```
fn wide_unicode_wraps_by_display_width()
```

**Purpose**: Verifies that wide Unicode characters, such as emoji, wrap by terminal display width rather than byte count.

**Data flow**: It wraps three emoji at width 4 and checks the first line contains two emoji and the second contains one.

**Call relations**: This confirms `textwrap` display-width behavior is preserved through `word_wrap_line`.

*Call graph*: calls 1 internal fn (word_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::styled_split_within_span_preserves_style`  (lines 1217–1228)

```
fn styled_split_within_span_preserves_style()
```

**Purpose**: Checks that if one styled span is split across lines, both pieces keep the original style.

**Data flow**: It wraps a red `abcd` span at width 2 and verifies both output spans are red with text `ab` and `cd`.

**Call relations**: This directly exercises `slice_line_spans` after `word_wrap_line` splits inside a span.

*Call graph*: calls 1 internal fn (word_wrap_line); 3 external calls (from, assert_eq!, vec!).


##### `tests::wrap_lines_applies_initial_indent_only_once`  (lines 1231–1246)

```
fn wrap_lines_applies_initial_indent_only_once()
```

**Purpose**: Verifies that multi-line wrapping applies the special initial indent only to the very first output line.

**Data flow**: It wraps two input lines with first and continuation indents, then checks that only the first rendered line starts with the initial prefix.

**Call relations**: This tests the indentation flow in `word_wrap_lines`.

*Call graph*: calls 2 internal fn (new, word_wrap_lines); 3 external calls (from, assert!, vec!).


##### `tests::wrap_lines_without_indents_is_concat_of_single_wraps`  (lines 1249–1254)

```
fn wrap_lines_without_indents_is_concat_of_single_wraps()
```

**Purpose**: Checks that wrapping multiple short lines without indents simply returns those lines unchanged.

**Data flow**: It wraps `hello` and `world!` at a wide width and compares the output text list.

**Call relations**: This is a simple behavior check for `word_wrap_lines`.

*Call graph*: calls 1 internal fn (word_wrap_lines); 2 external calls (assert_eq!, vec!).


##### `tests::wrap_lines_borrowed_applies_initial_indent_only_once`  (lines 1257–1270)

```
fn wrap_lines_borrowed_applies_initial_indent_only_once()
```

**Purpose**: Verifies the borrowed multi-line wrapper follows the same one-time initial indent rule.

**Data flow**: It wraps borrowed lines with first and continuation indents and checks the prefixes in the rendered output.

**Call relations**: This mirrors the owned-output test for `word_wrap_lines_borrowed`.

*Call graph*: calls 2 internal fn (new, word_wrap_lines_borrowed); 2 external calls (from, assert!).


##### `tests::wrap_lines_borrowed_without_indents_is_concat_of_single_wraps`  (lines 1273–1278)

```
fn wrap_lines_borrowed_without_indents_is_concat_of_single_wraps()
```

**Purpose**: Checks that the borrowed multi-line wrapper leaves short unindented lines unchanged.

**Data flow**: It wraps two borrowed lines at a wide width and compares the resulting text strings.

**Call relations**: This is a baseline test for `word_wrap_lines_borrowed`.

*Call graph*: calls 1 internal fn (word_wrap_lines_borrowed); 2 external calls (from, assert_eq!).


##### `tests::wrap_lines_accepts_borrowed_iterators`  (lines 1281–1286)

```
fn wrap_lines_accepts_borrowed_iterators()
```

**Purpose**: Verifies that the flexible multi-line wrapper accepts line values from an iterator and wraps them correctly.

**Data flow**: It passes an array of lines to `word_wrap_lines`, wraps at width 10, and checks the resulting line texts.

**Call relations**: This tests the `IntoLineInput` conversion path used by `word_wrap_lines`.

*Call graph*: calls 1 internal fn (word_wrap_lines); 2 external calls (from, assert_eq!).


##### `tests::wrap_lines_accepts_str_slices`  (lines 1289–1294)

```
fn wrap_lines_accepts_str_slices()
```

**Purpose**: Verifies that plain string slices can be passed directly to the multi-line wrapper.

**Data flow**: It wraps an array of `&str` values and checks the output lines.

**Call relations**: This covers the `str::into_line_input` conversion used by `word_wrap_lines`.

*Call graph*: calls 1 internal fn (word_wrap_lines); 1 external calls (assert_eq!).


##### `tests::line_height_counts_double_width_emoji`  (lines 1297–1302)

```
fn line_height_counts_double_width_emoji()
```

**Purpose**: Checks that line count changes correctly for emoji that occupy two terminal columns.

**Data flow**: It wraps the same emoji string at widths 4, 2, and 6, and checks the number of output lines for each width.

**Call relations**: This reinforces display-width behavior in the standard wrapping path.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::word_wrap_does_not_split_words_simple_english`  (lines 1305–1321)

```
fn word_wrap_does_not_split_words_simple_english()
```

**Purpose**: Verifies that normal English prose wraps at word boundaries into the expected lines.

**Data flow**: It wraps a sample paragraph at width 40, joins the output with newlines, and compares against the expected paragraph layout.

**Call relations**: This is an end-to-end check of `word_wrap_lines_borrowed` for ordinary prose.

*Call graph*: calls 1 internal fn (word_wrap_lines_borrowed); 2 external calls (from, assert_eq!).


##### `tests::ascii_space_separator_with_no_hyphenation_keeps_url_intact`  (lines 1324–1340)

```
fn ascii_space_separator_with_no_hyphenation_keeps_url_intact()
```

**Purpose**: Checks that space-only separation, no hyphenation, and no word breaking keep a long URL on one line.

**Data flow**: It builds URL-preserving-like options, wraps a long URL at a narrow width, and verifies the output is still a single unbroken URL.

**Call relations**: This documents the key behavior behind `url_preserving_wrap_options` and `adaptive_wrap_line`.

*Call graph*: calls 2 internal fn (new, word_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::text_contains_url_like_matches_expected_tokens`  (lines 1343–1360)

```
fn text_contains_url_like_matches_expected_tokens()
```

**Purpose**: Verifies that the URL detector accepts common URL-like forms.

**Data flow**: It loops over examples with schemes, bare domains, localhost, IPv4 addresses, and surrounding punctuation, and asserts each is detected.

**Call relations**: This tests the plain-text URL detection path used by `line_contains_url_like`.

*Call graph*: 1 external calls (assert!).


##### `tests::text_contains_url_like_rejects_non_urls`  (lines 1363–1378)

```
fn text_contains_url_like_rejects_non_urls()
```

**Purpose**: Verifies that the URL detector rejects ordinary paths and non-link tokens.

**Data flow**: It loops over examples such as `src/main.rs`, `foo/bar`, and `hello.world`, and asserts none are detected as URLs.

**Call relations**: This guards the conservative heuristics in the URL detection helpers.

*Call graph*: 1 external calls (assert!).


##### `tests::line_contains_url_like_checks_across_spans`  (lines 1381–1389)

```
fn line_contains_url_like_checks_across_spans()
```

**Purpose**: Checks that URL detection works even when a line is made of multiple styled spans.

**Data flow**: It builds a line with prose, a cyan URL span, and more prose, then asserts the line-level detector sees the URL.

**Call relations**: This tests `line_contains_url_like`, including its span-concatenation step.

*Call graph*: 3 external calls (from, assert!, vec!).


##### `tests::line_has_mixed_url_and_non_url_tokens_detects_prose_plus_url`  (lines 1392–1395)

```
fn line_has_mixed_url_and_non_url_tokens_detects_prose_plus_url()
```

**Purpose**: Verifies that a sentence containing a URL is recognized as mixed URL and non-URL text.

**Data flow**: It builds a line with words before and after a URL and asserts the mixed-token detector returns true.

**Call relations**: This tests the branch condition that sends `adaptive_wrap_line` to mixed URL wrapping.

*Call graph*: 2 external calls (from, assert!).


##### `tests::line_has_mixed_url_and_non_url_tokens_ignores_pipe_prefix`  (lines 1398–1401)

```
fn line_has_mixed_url_and_non_url_tokens_ignores_pipe_prefix()
```

**Purpose**: Checks that a decorative pipe prefix beside a URL does not count as prose.

**Data flow**: It builds a line with a pipe-style prefix and a URL, then asserts it is not treated as mixed content.

**Call relations**: This tests decorative-marker filtering in the mixed-token detector.

*Call graph*: 3 external calls (from, assert!, vec!).


##### `tests::line_has_mixed_url_and_non_url_tokens_ignores_ordered_list_marker`  (lines 1404–1407)

```
fn line_has_mixed_url_and_non_url_tokens_ignores_ordered_list_marker()
```

**Purpose**: Checks that a numbered list marker beside a URL does not count as prose.

**Data flow**: It builds `1. https://example.com/path` and asserts the mixed detector returns false.

**Call relations**: This covers `is_ordered_list_marker` through the line-level mixed-token path.

*Call graph*: 2 external calls (from, assert!).


##### `tests::text_contains_url_like_accepts_custom_scheme_with_separator`  (lines 1410–1412)

```
fn text_contains_url_like_accepts_custom_scheme_with_separator()
```

**Purpose**: Verifies that custom scheme URLs such as `myapp://...` are detected.

**Data flow**: It passes a custom-scheme token to the URL detector and asserts it returns true.

**Call relations**: This tests the fallback scheme-prefix logic used by `is_absolute_url_like`.

*Call graph*: 1 external calls (assert!).


##### `tests::text_contains_url_like_rejects_invalid_ports`  (lines 1415–1418)

```
fn text_contains_url_like_rejects_invalid_ports()
```

**Purpose**: Checks that bare URLs with invalid ports are not accepted.

**Data flow**: It tests a port that is too large and a non-numeric port, asserting both are rejected.

**Call relations**: This covers `is_valid_port` through the plain URL detection flow.

*Call graph*: 1 external calls (assert!).


##### `tests::adaptive_wrap_line_keeps_long_url_like_token_intact`  (lines 1421–1429)

```
fn adaptive_wrap_line_keeps_long_url_like_token_intact()
```

**Purpose**: Verifies that adaptive wrapping keeps a long URL-like token whole even when it exceeds the width.

**Data flow**: It wraps a long bare-domain URL at width 20 and checks the output is one unchanged line.

**Call relations**: This tests the URL-only branch of `adaptive_wrap_line`.

*Call graph*: calls 2 internal fn (new, adaptive_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::adaptive_wrap_line_preserves_default_behavior_for_non_url_tokens`  (lines 1432–1439)

```
fn adaptive_wrap_line_preserves_default_behavior_for_non_url_tokens()
```

**Purpose**: Checks that adaptive wrapping does not change behavior for text with no URL.

**Data flow**: It wraps a long non-URL token at width 20 and asserts it splits into more than one line.

**Call relations**: This confirms `adaptive_wrap_line` falls back to `word_wrap_line` when URL detection is false.

*Call graph*: calls 2 internal fn (new, adaptive_wrap_line); 2 external calls (from, assert!).


##### `tests::adaptive_wrap_line_mixed_line_keeps_regular_words_intact`  (lines 1442–1453)

```
fn adaptive_wrap_line_mixed_line_keeps_regular_words_intact()
```

**Purpose**: Verifies that a mixed prose-and-URL line wraps neatly while keeping the URL intact.

**Data flow**: It wraps a sentence containing a URL at width 36, joins the output with newlines, and compares the expected layout.

**Call relations**: This exercises `adaptive_wrap_line` through `mixed_url_wrap_line` and `mixed_url_wrap_ranges`.

*Call graph*: calls 2 internal fn (new, adaptive_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::adaptive_wrap_line_mixed_line_wraps_long_non_url_token`  (lines 1456–1471)

```
fn adaptive_wrap_line_mixed_line_wraps_long_non_url_token()
```

**Purpose**: Checks that mixed URL wrapping can still split a very long non-URL token. The URL stays protected, but ordinary oversized tokens do not force huge lines.

**Data flow**: It builds text with a URL plus a long non-URL token, wraps it narrowly, then asserts the URL appears intact and the long token does not appear as one unbroken string.

**Call relations**: This tests `split_mixed_url_word` through the adaptive mixed-line path.

*Call graph*: calls 2 internal fn (new, adaptive_wrap_line); 3 external calls (from, assert!, format!).


##### `tests::adaptive_wrap_line_mixed_line_counts_leading_spaces_before_first_word`  (lines 1474–1486)

```
fn adaptive_wrap_line_mixed_line_counts_leading_spaces_before_first_word()
```

**Purpose**: Verifies that leading spaces on the first mixed line count against the available width.

**Data flow**: It wraps an indented mixed line with a continuation indent and checks the first pieces of the long word are split according to the real visible width.

**Call relations**: This protects leading-space accounting in `mixed_url_wrap_ranges`.

*Call graph*: calls 2 internal fn (new, adaptive_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::adaptive_wrap_line_mixed_line_resplits_long_token_for_continuation_width`  (lines 1489–1505)

```
fn adaptive_wrap_line_mixed_line_resplits_long_token_for_continuation_width()
```

**Purpose**: Checks that a long non-URL token is re-split when continuation lines have less room because of indentation.

**Data flow**: It wraps a long word followed by a URL with a four-space continuation indent and checks the first continuation pieces fit the smaller width.

**Call relations**: This tests the loop in `mixed_url_wrap_ranges` that reprocesses pieces after the line limit changes.

*Call graph*: calls 2 internal fn (new, adaptive_wrap_line); 2 external calls (from, assert_eq!).


##### `tests::map_owned_wrapped_line_to_range_recovers_on_non_prefix_mismatch`  (lines 1508–1513)

```
fn map_owned_wrapped_line_to_range_recovers_on_non_prefix_mismatch()
```

**Purpose**: Verifies that owned-line range mapping returns the matched prefix instead of failing on an unexpected mismatch.

**Data flow**: It maps `helloX` against source `hello world` and checks the returned range covers only `hello`.

**Call relations**: This tests the recovery behavior in `map_owned_wrapped_line_to_range`.

*Call graph*: calls 1 internal fn (map_owned_wrapped_line_to_range); 1 external calls (assert_eq!).


##### `tests::borrowed_slice_range_rejects_slices_outside_source_text`  (lines 1516–1524)

```
fn borrowed_slice_range_rejects_slices_outside_source_text()
```

**Purpose**: Checks that pointer-based slice mapping rejects a slice from a different string, even if the text looks similar.

**Data flow**: It creates a source string and a separate external string, verifies direct borrowed mapping fails, then checks the fallback mapper can still map the text.

**Call relations**: This covers both `borrowed_slice_range` and `map_owned_wrapped_line_to_range`.

*Call graph*: calls 1 internal fn (map_owned_wrapped_line_to_range); 2 external calls (from, assert_eq!).


##### `tests::map_owned_wrapped_line_to_range_indent_coincides_with_source`  (lines 1527–1542)

```
fn map_owned_wrapped_line_to_range_indent_coincides_with_source()
```

**Purpose**: Verifies that synthetic indentation is not mistaken for matching source text when both start with the same character.

**Data flow**: It maps a wrapped string with `- ` indentation against source text that also starts with `-`, and checks the returned range covers the intended source words.

**Call relations**: This protects the prefix-stripping logic in `map_owned_wrapped_line_to_range`.

*Call graph*: calls 1 internal fn (map_owned_wrapped_line_to_range); 1 external calls (assert_eq!).


##### `tests::wrap_ranges_indent_prefix_coincides_with_source_char`  (lines 1545–1568)

```
fn wrap_ranges_indent_prefix_coincides_with_source_char()
```

**Purpose**: Checks the full range-wrapping path when an indent prefix begins with the same character as the source text.

**Data flow**: It wraps text starting with `-` using `- ` indents, rebuilds the source from returned ranges, and verifies the rebuilt text equals the original.

**Call relations**: This is an end-to-end test for `wrap_ranges` and its owned-line mapping fallback.

*Call graph*: calls 1 internal fn (wrap_ranges); 3 external calls (new, assert!, assert_eq!).


##### `tests::map_owned_wrapped_line_to_range_repro_overconsumes_repeated_prefix_patterns`  (lines 1571–1594)

```
fn map_owned_wrapped_line_to_range_repro_overconsumes_repeated_prefix_patterns()
```

**Purpose**: Guards against a bug where repeated prefix-like text could make the mapper consume too much source.

**Data flow**: It wraps `- - foo` with `- ` indentation, maps the first wrapped line, and asserts the mapped length is not longer than the non-prefix wrapped content.

**Call relations**: This focuses on `map_owned_wrapped_line_to_range` in a tricky repeated-pattern case.

*Call graph*: calls 1 internal fn (map_owned_wrapped_line_to_range); 4 external calls (assert!, panic!, new, wrap).


##### `tests::wrap_ranges_recovers_with_non_space_indents`  (lines 1597–1634)

```
fn wrap_ranges_recovers_with_non_space_indents()
```

**Purpose**: Verifies that range wrapping can reconstruct the original text when `textwrap` creates owned lines because of non-space indentation.

**Data flow**: It wraps a sentence with `* ` and space indents, confirms owned lines occur, gets ranges from `wrap_ranges`, rebuilds the text from those ranges, and checks it matches the source.

**Call relations**: This tests `wrap_ranges` and `map_owned_wrapped_line_to_range` together under realistic indentation.

*Call graph*: calls 1 internal fn (wrap_ranges); 5 external calls (new, assert!, assert_eq!, new, wrap).


##### `tests::wrap_ranges_trim_handles_owned_lines_with_penalty_char`  (lines 1637–1656)

```
fn wrap_ranges_trim_handles_owned_lines_with_penalty_char()
```

**Purpose**: Checks that trimmed range mapping works when `textwrap` inserts a penalty character such as a hyphen during word splitting.

**Data flow**: It configures a custom splitter, wraps a long token, gets trimmed ranges, rebuilds the source from those ranges, and verifies the result matches the original text.

**Call relations**: This tests `wrap_ranges_trim` and its fallback mapping for owned `textwrap` output.

*Call graph*: calls 1 internal fn (wrap_ranges_trim); 4 external calls (new, assert!, assert_eq!, Custom).


### Streaming and scrollable wrapped views
These components apply wrapping incrementally or cache wrapped lines into a scroll model for long text and diff displays.

### `tui/src/live_wrap.rs`

`domain_logic` · `main loop / live terminal rendering`

A terminal is not measured in letters. It is measured in columns, and some visible characters use two columns while others use none. This file solves the problem of showing live, growing text in a terminal without letting it spill past the right edge.

The main piece is `RowBuilder`. Think of it like a small text wrapping machine. Text fragments arrive over time, maybe a few characters at once, maybe with newline characters inside. `RowBuilder` collects the unfinished part of the current logical line, cuts off completed display rows whenever they become too wide, and saves those rows as `Row` values. A `Row` stores the text for one visual line and whether that line ended because the input had a real newline, rather than because the screen width forced a wrap.

The file is careful about Unicode width. For example, an emoji may count as two terminal columns, so simple byte or character counts would be wrong. The helper `take_prefix_by_width` chooses the largest safe prefix that fits in a given number of columns.

There is also support for changing the width. When the width changes, the builder reconstructs the text it has already seen and wraps it again. This is simple but important for terminal resize behavior. The tests check normal ASCII text, wide Unicode characters, input arriving in chunks, newline handling, and rewrapping after width changes.

#### Function details

##### `Row::width`  (lines 13–15)

```
fn width(&self) -> usize
```

**Purpose**: Returns how many terminal columns this row's text will occupy. This is different from counting characters because some characters, such as emoji or CJK characters, are wider on screen.

**Data flow**: It reads the row's `text` string, asks the Unicode width library to measure its visible terminal width, and returns that number. It does not change the row.

**Call relations**: This is a small convenience used when code needs to check whether a `Row` fits within a terminal width. In this file's tests, it helps confirm that rows produced after a width change are not too wide.


##### `RowBuilder::new`  (lines 30–36)

```
fn new(target_width: usize) -> Self
```

**Purpose**: Creates a fresh row-wrapping builder for a chosen terminal width. It makes sure the width is never less than one column, because wrapping to zero columns would not make sense.

**Data flow**: It receives a requested width, changes it to at least `1` if needed, starts with an empty current line, and starts with no completed rows. The result is a ready-to-use `RowBuilder`.

**Call relations**: This is the starting point for anyone who wants to wrap live text. The tests and live overflow behavior create builders through this function before feeding text into them.

*Call graph*: called by 6 (fragmentation_invariance_long_token, newline_splits_rows, rewrap_on_width_change, rows_do_not_exceed_width_ascii, rows_do_not_exceed_width_emoji_cjk, live_001_commit_on_overflow); 2 external calls (new, new).


##### `RowBuilder::width`  (lines 38–40)

```
fn width(&self) -> usize
```

**Purpose**: Reports the current target width used for wrapping. Someone would use this to ask, "How many terminal columns is this builder currently wrapping to?"

**Data flow**: It reads the builder's stored `target_width` and returns it. Nothing is changed.

**Call relations**: This is an information-only helper. It fits beside `set_width`, which changes the width, by letting other code inspect the width currently in effect.


##### `RowBuilder::set_width`  (lines 42–55)

```
fn set_width(&mut self, width: usize)
```

**Purpose**: Changes the wrap width and rebuilds the stored rows so they match the new size. This matters when the terminal is resized.

**Data flow**: It receives a new width, clamps it to at least one column, then gathers all already-produced row text plus any unfinished current line back into one string. It preserves explicit line breaks by inserting newline characters where needed. Then it clears the old state and feeds the reconstructed text back through `push_fragment`, producing rows for the new width.

**Call relations**: This function uses `push_fragment` as the normal doorway back into the wrapping process, rather than duplicating the wrapping rules. It is exercised by the resize-focused test, which checks that rows are rewrapped after the width shrinks.

*Call graph*: calls 1 internal fn (push_fragment); 1 external calls (new).


##### `RowBuilder::push_fragment`  (lines 58–77)

```
fn push_fragment(&mut self, fragment: &str)
```

**Purpose**: Adds a new piece of incoming text to the builder. The text may be a whole message, a tiny chunk, or include newline characters.

**Data flow**: It receives a string slice. If it is empty, it does nothing. Otherwise it scans for newline characters. Text before a newline is added to the current line, then that line is flushed as an explicit break. Text after the final newline is added to the current line and wrapped as far as possible. Completed visual rows are stored in the builder, while any still-fitting tail remains buffered.

**Call relations**: This is the main input path for live text. It calls `flush_current_line` when it sees real newlines and `wrap_current_line` after appending ordinary text. `set_width` also uses it to reprocess saved text after a width change.

*Call graph*: calls 2 internal fn (flush_current_line, wrap_current_line); called by 1 (set_width).


##### `RowBuilder::end_line`  (lines 80–82)

```
fn end_line(&mut self)
```

**Purpose**: Finishes the current logical line as if a newline had just arrived. It is useful when the caller knows a line is complete even without passing a `\n` character.

**Data flow**: It takes no extra input. It tells the builder to flush the current line with `explicit_break` set to true, which may create one final row marked as ending at a real line break.

**Call relations**: This is a small public shortcut around `flush_current_line`. It uses the same internal path as `push_fragment` uses when it encounters a newline.

*Call graph*: calls 1 internal fn (flush_current_line).


##### `RowBuilder::rows`  (lines 85–87)

```
fn rows(&self) -> &[Row]
```

**Purpose**: Returns the completed rows produced so far, without removing them. These are rows that have already been wrapped or explicitly finished.

**Data flow**: It reads the builder's stored `rows` list and returns a borrowed view of it. The unfinished current line is not included, and nothing is changed.

**Call relations**: This is for callers that want to inspect or render only committed rows. Several tests use it to verify exactly what rows have been produced after pushing text.


##### `RowBuilder::display_rows`  (lines 90–99)

```
fn display_rows(&self) -> Vec<Row>
```

**Purpose**: Builds a display-ready list of rows, including the unfinished current line if there is one. This is useful for drawing the current live state on screen.

**Data flow**: It clones the completed rows into a new list. If the current line buffer is not empty, it appends that buffer as a final row marked as not ending in an explicit break. It returns this new list without changing the builder.

**Call relations**: This sits between internal buffering and user-visible output. The newline test uses it because the most recent text after a newline may still be a partial line that should appear on screen.


##### `RowBuilder::drain_commit_ready`  (lines 103–115)

```
fn drain_commit_ready(&mut self, max_keep: usize) -> Vec<Row>
```

**Purpose**: Removes and returns old rows when the builder has more display rows than a caller wants to keep. This helps a live interface keep only a limited recent window while committing older rows elsewhere.

**Data flow**: It receives `max_keep`, counts completed rows plus the unfinished current line if present, and decides how many old completed rows exceed that limit. It removes that many rows from the front of the stored list and returns them in their original order. It never drains the current partial line.

**Call relations**: This is used when live output grows beyond a retention limit. It acts after wrapping has produced rows, handing older completed rows off to whatever part of the program stores or finalizes them.

*Call graph*: 2 external calls (new, with_capacity).


##### `RowBuilder::flush_current_line`  (lines 117–141)

```
fn flush_current_line(&mut self, explicit_break: bool)
```

**Purpose**: Finalizes the current logical line, usually because a real newline was seen or requested. It records whether the line ended explicitly rather than only because it wrapped.

**Data flow**: It first wraps any over-wide content in the current line. If an explicit break is requested, it either pushes the leftover current text as a row marked with `explicit_break: true`, or, if the line already ended exactly at a wrap boundary, it pushes an empty explicit row to remember that the newline happened. Then it clears the current line buffer.

**Call relations**: This is an internal helper used by `push_fragment` and `end_line`. It relies on `wrap_current_line` first so that only the final leftover part gets the explicit line-break marker.

*Call graph*: calls 1 internal fn (wrap_current_line); called by 2 (end_line, push_fragment); 2 external calls (new, swap).


##### `RowBuilder::wrap_current_line`  (lines 143–177)

```
fn wrap_current_line(&mut self)
```

**Purpose**: Cuts the current line into completed visual rows whenever it grows beyond the target width. It leaves any still-fitting tail in the current buffer so more text can be appended later.

**Data flow**: It repeatedly looks at `current_line` and asks `take_prefix_by_width` for the largest prefix that fits. If there is extra text after that prefix, it stores the prefix as a non-explicit wrapped row and keeps processing the suffix. If the whole current line fits, it stops and leaves it buffered. It also has a safety fallback to consume one Unicode scalar value if no width can be taken.

**Call relations**: This is the core wrapping engine. `push_fragment` calls it after ordinary text arrives, and `flush_current_line` calls it before marking a logical line as finished. It delegates the exact Unicode column counting to `take_prefix_by_width`.

*Call graph*: calls 1 internal fn (take_prefix_by_width); called by 2 (flush_current_line, push_fragment).


##### `take_prefix_by_width`  (lines 182–202)

```
fn take_prefix_by_width(text: &str, max_cols: usize) -> (String, &str, usize)
```

**Purpose**: Finds the longest beginning part of a string that fits within a given number of terminal columns. This is the low-level Unicode-aware measuring tool used by the wrapper.

**Data flow**: It receives text and a maximum column count. It walks through the text character by character, adds each character's terminal width, and stops before adding one that would overflow. It returns three things: the fitting prefix as a new string, the remaining suffix as a slice of the original text, and the width of the prefix.

**Call relations**: Inside this file, `wrap_current_line` uses it to decide where to cut rows. It is also available to other rendering code, such as `render_lines`, when that code needs the same safe terminal-width split.

*Call graph*: called by 2 (render_lines, wrap_current_line); 2 external calls (new, width).


##### `tests::rows_do_not_exceed_width_ascii`  (lines 210–227)

```
fn rows_do_not_exceed_width_ascii()
```

**Purpose**: Checks the basic wrapping behavior for ordinary one-column ASCII text. It proves that long plain text is split into rows of the requested width.

**Data flow**: The test creates a builder with width 10, pushes a longer sentence into it, then reads the completed rows. It compares them with the exact rows expected after wrapping.

**Call relations**: This test starts with `RowBuilder::new` and drives the normal input path. It protects the simple case that all other wrapping behavior builds on.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::rows_do_not_exceed_width_emoji_cjk`  (lines 230–245)

```
fn rows_do_not_exceed_width_emoji_cjk()
```

**Purpose**: Checks that wide Unicode characters are counted by screen width, not by byte count or simple character count. This matters for emoji and East Asian text in a terminal.

**Data flow**: The test creates a builder with width 6, pushes text containing emoji and Chinese characters, then checks that only the portion that safely fits is emitted as a completed row. The remaining text stays buffered.

**Call relations**: This test exercises the path from `RowBuilder::new` through live wrapping and indirectly validates the Unicode width logic used by `take_prefix_by_width`.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::fragmentation_invariance_long_token`  (lines 248–262)

```
fn fragmentation_invariance_long_token()
```

**Purpose**: Checks that wrapping gives the same completed rows whether text arrives all at once or in small chunks. This is important for live streams, where input often arrives piece by piece.

**Data flow**: The test wraps the alphabet once as a single string and once as repeated three-character fragments. It then compares the completed rows from both builders and expects them to match.

**Call relations**: This test creates two builders with `RowBuilder::new` and feeds them through the public input method. It guards against bugs where chunk boundaries accidentally affect wrapping results.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::newline_splits_rows`  (lines 265–273)

```
fn newline_splits_rows()
```

**Purpose**: Checks that newline characters create explicit line breaks and separate later text onto a following display row.

**Data flow**: The test creates a builder, pushes `hello\nworld`, then asks for display rows. It verifies that at least one row is marked as an explicit break, that the first row contains `hello`, and that another row starts with `world`.

**Call relations**: This test drives the newline path in `push_fragment`, which calls the internal flush logic. It uses `display_rows` so the partial `world` line is visible even if it has not been finalized.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, assert_eq!).


##### `tests::rewrap_on_width_change`  (lines 276–284)

```
fn rewrap_on_width_change()
```

**Purpose**: Checks that changing the target width rebuilds existing rows to fit the new width. This protects terminal resize behavior.

**Data flow**: The test creates a builder at width 10, pushes text long enough to produce rows, then changes the width to 5. It reads the rows afterward and asserts that every completed row is no wider than 5 columns.

**Call relations**: This test exercises `set_width`, which reconstructs prior text and sends it back through `push_fragment`. It also uses `Row::width` to verify the resulting rows fit.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


### `cloud-tasks/src/scrollable_diff.rs`

`domain_logic` · `during terminal UI rendering and input handling`

A terminal screen has a fixed width and height, but diffs and messages can be much longer and wider than the space available. This file solves that by turning raw text lines into wrapped display lines, then tracking which part of those display lines should currently be visible. Think of it like a paper document behind a small window: the document can be taller than the window, and this code decides which slice of it is showing.

There are two main pieces. `ScrollViewState` stores the basic geometry: how far down the view is scrolled, how tall the visible window is, and how tall the wrapped content is. Its job is to make sure the scroll position never points past the end.

`ScrollableDiff` owns the original lines and a cached wrapped version. The cache matters because wrapping text can be repeated often during drawing, especially in a terminal user interface. When new content arrives, the cache is cleared. When the width is set, the file rebuilds the wrapped lines for that width and remembers which original raw line each wrapped line came from. That source-line map lets later drawing code style wrapped lines while still knowing their original meaning.

The wrapping is careful about character display width, including wider Unicode characters, and it prefers to break at spaces or punctuation when possible. It also exposes simple scrolling actions: move by a delta, page up or down, jump to top or bottom, and report a rough percentage scrolled.

#### Function details

##### `ScrollViewState::clamp`  (lines 13–18)

```
fn clamp(&mut self)
```

**Purpose**: This keeps the saved scroll position inside the part of the content that can actually be shown. It prevents the view from being scrolled below the end after the content or window size changes.

**Data flow**: It reads the current content height and viewport height, computes the largest allowed scroll value, and compares the current scroll against it. If the scroll is too large, it lowers it to the maximum safe value; otherwise it leaves it alone.

**Call relations**: When `ScrollableDiff::set_width` rebuilds the wrapped content, the content height may change, so it calls this to repair the scroll position. `ScrollableDiff::set_viewport` also calls it when the visible window height changes.

*Call graph*: called by 2 (set_viewport, set_width).


##### `ScrollableDiff::new`  (lines 35–37)

```
fn new() -> Self
```

**Purpose**: This creates an empty scrollable text view ready to receive content. It is the simple starting point for code that needs a fresh `ScrollableDiff`.

**Data flow**: It takes no content or settings from the caller. It uses the type's default values to create empty raw lines, empty wrapped lines, no remembered wrap width, and a zeroed scroll state, then returns that new object.

**Call relations**: This constructor is used when a new scrollable diff view is needed. Internally it hands the work to the standard default creation behavior, so the rest of the file can rely on a consistent empty starting state.

*Call graph*: called by 1 (new); 1 external calls (default).


##### `ScrollableDiff::set_content`  (lines 40–47)

```
fn set_content(&mut self, lines: Vec<String>)
```

**Purpose**: This replaces the text that the scrollable view will show. It deliberately does not wrap the text right away, because wrapping depends on the current display width.

**Data flow**: It receives a list of raw strings. It stores them as the new original content, clears any old wrapped lines and source-line mapping, resets the recorded content height to zero, and forgets the previous wrap width so the next width update will rebuild the cache.

**Call relations**: Higher-level UI code such as `apply_selection_to_fields` calls this when the selected diff or message changes. After this, the normal flow is for layout code to call `set_width`, which rebuilds the display-ready wrapped lines.

*Call graph*: called by 1 (apply_selection_to_fields).


##### `ScrollableDiff::set_width`  (lines 50–57)

```
fn set_width(&mut self, width: u16)
```

**Purpose**: This tells the view how many terminal columns it has available and refreshes wrapping if that width changed. Without this, long lines would not fit the current screen area correctly.

**Data flow**: It receives a width in columns. If the width is the same as the cached width, it does nothing. If it changed, it records the new width, rebuilds the wrapped line cache for that width, and then clamps the scroll position so it still points to a valid place.

**Call relations**: Layout or drawing code calls this when the terminal area changes or after new content is set. It hands the detailed wrapping work to `ScrollableDiff::rewrap`, then uses `ScrollViewState::clamp` to keep scrolling safe.

*Call graph*: calls 2 internal fn (clamp, rewrap).


##### `ScrollableDiff::set_viewport`  (lines 60–63)

```
fn set_viewport(&mut self, height: u16)
```

**Purpose**: This records how many rows are visible in the scrollable area. It also fixes the scroll position if the visible window has become too small or too large for the old scroll value.

**Data flow**: It receives a height in rows, stores it in the scroll state, then checks whether the current scroll is still allowed. If not, it pulls the scroll back to the nearest valid value.

**Call relations**: UI layout code calls this when it knows the height of the viewing area. It relies on `ScrollViewState::clamp` to enforce the same safety rule used after wrapping changes.

*Call graph*: calls 1 internal fn (clamp).


##### `ScrollableDiff::wrapped_lines`  (lines 66–68)

```
fn wrapped_lines(&self) -> &[String]
```

**Purpose**: This gives drawing code the already-wrapped lines that should be displayed. It avoids making the renderer repeat the wrapping work every time it paints the screen.

**Data flow**: It reads the internal wrapped-line cache and returns a shared view of it. It does not change the content, the cache, or the scroll state.

**Call relations**: `style_conversation_lines` calls this when it is ready to turn the wrapped text into styled terminal output. The expectation is that `set_width` has already been called so the cache matches the current screen width.

*Call graph*: called by 1 (style_conversation_lines).


##### `ScrollableDiff::wrapped_src_indices`  (lines 70–72)

```
fn wrapped_src_indices(&self) -> &[usize]
```

**Purpose**: This tells callers which original raw line each wrapped display line came from. That is useful when a single long source line becomes several visible lines but still needs to be styled or interpreted as one original line.

**Data flow**: It reads the stored source-index list and returns a shared view of it. Each entry corresponds to a wrapped line and points back to the matching raw line number.

**Call relations**: `style_conversation_lines` uses this alongside `wrapped_lines` so it can style visible lines while still knowing their original source. The mapping is rebuilt by `rewrap` whenever the width changes.

*Call graph*: called by 1 (style_conversation_lines).


##### `ScrollableDiff::raw_line_at`  (lines 74–76)

```
fn raw_line_at(&self, idx: usize) -> &str
```

**Purpose**: This returns one original, unwrapped line by index. It gives callers a safe way to ask for raw content without crashing if the index is out of range.

**Data flow**: It receives a raw line index. If that line exists, it returns it as text; if not, it returns an empty string instead of failing.

**Call relations**: `style_conversation_lines` calls this when it needs to look back from a wrapped line to the original line. This works together with `wrapped_src_indices`, which supplies the raw-line index to look up.

*Call graph*: called by 1 (style_conversation_lines).


##### `ScrollableDiff::scroll_by`  (lines 79–82)

```
fn scroll_by(&mut self, delta: i16)
```

**Purpose**: This moves the view up or down by a signed amount while preventing it from going before the start or after the end. It is the basic scroll action used for small movements and by paging.

**Data flow**: It receives a positive or negative delta. It adds that delta to the current scroll value, then clamps the result between zero and the maximum possible scroll, and stores the safe result back into the state.

**Call relations**: Direct input handling can use this for line-by-line scrolling. `ScrollableDiff::page_by` also calls it, so both small scrolling and page scrolling share the same boundary checks. It asks `ScrollableDiff::max_scroll` for the lower end of the valid range.

*Call graph*: calls 1 internal fn (max_scroll); called by 1 (page_by).


##### `ScrollableDiff::page_by`  (lines 85–87)

```
fn page_by(&mut self, delta: i16)
```

**Purpose**: This scrolls by a larger amount, usually close to one screenful. It exists as a clear page-up or page-down operation while reusing the same safety checks as normal scrolling.

**Data flow**: It receives a positive or negative page delta and passes it directly to `scroll_by`. The current scroll state is updated there, with limits applied.

**Call relations**: Keyboard handling can call this for page-style movement. It delegates to `ScrollableDiff::scroll_by` so page movement cannot overshoot the content any more than normal movement can.

*Call graph*: calls 1 internal fn (scroll_by).


##### `ScrollableDiff::scroll_to_top`  (lines 89–91)

```
fn scroll_to_top(&mut self)
```

**Purpose**: This jumps the view straight to the beginning of the content. It is useful for Home-key style navigation or resetting the view.

**Data flow**: It takes no input beyond the current object. It sets the scroll position to zero and leaves the content and wrapping cache unchanged.

**Call relations**: This is a direct navigation helper. Unlike incremental scrolling, it does not need to ask other functions for boundaries because the top is always scroll position zero.


##### `ScrollableDiff::scroll_to_bottom`  (lines 93–95)

```
fn scroll_to_bottom(&mut self)
```

**Purpose**: This jumps the view to the lowest valid scroll position, so the bottom of the content is visible. It is useful for End-key style navigation or following newly loaded content.

**Data flow**: It computes the largest allowed scroll value from the content height and viewport height, then stores that value as the current scroll position.

**Call relations**: This navigation helper calls `ScrollableDiff::max_scroll` to find the correct bottom position. That keeps its behavior consistent with `scroll_by`, which uses the same limit.

*Call graph*: calls 1 internal fn (max_scroll).


##### `ScrollableDiff::percent_scrolled`  (lines 98–108)

```
fn percent_scrolled(&self) -> Option<u8>
```

**Purpose**: This reports roughly how far through the content the visible window has reached. It returns no percentage when there is not enough information or when all content already fits on screen.

**Data flow**: It reads the content height, viewport height, and current scroll. If there is no content, no viewport, or no need to scroll, it returns `None`. Otherwise it calculates where the bottom of the visible window falls as a percentage of the total content height, rounds it, limits it to 0 through 100, and returns it.

**Call relations**: This can be used by UI code to show a scroll indicator, such as "73%". It does not call other local helpers and does not change state; it simply summarizes the current geometry.


##### `ScrollableDiff::max_scroll`  (lines 110–112)

```
fn max_scroll(&self) -> u16
```

**Purpose**: This calculates the furthest down the view is allowed to scroll. It is the shared rule that keeps scrolling from moving past the bottom.

**Data flow**: It reads the wrapped content height and the viewport height. If the content is taller than the viewport, it returns the difference; if not, it returns zero.

**Call relations**: `ScrollableDiff::scroll_by` calls this when limiting incremental movement, and `ScrollableDiff::scroll_to_bottom` calls it when jumping to the end. Keeping this calculation in one place makes those actions agree.

*Call graph*: called by 2 (scroll_by, scroll_to_bottom).


##### `ScrollableDiff::rewrap`  (lines 114–175)

```
fn rewrap(&mut self, width: u16)
```

**Purpose**: This rebuilds the display-ready version of the raw text for a given terminal width. It is what turns long source lines into shorter lines that fit on screen.

**Data flow**: It receives a width in columns and reads all raw lines. If the width is zero, it copies the raw lines as-is and records their count as the content height. Otherwise it expands tabs into spaces, walks through each character, measures how wide it appears in the terminal, and starts a new wrapped line when the current one would become too wide. It prefers breaking at spaces or punctuation when possible, records which raw line produced each wrapped line, then replaces the cached wrapped lines, replaces the source-index map, and updates the content height.

**Call relations**: `ScrollableDiff::set_width` calls this whenever the available width changes. After this function rebuilds the cache, drawing code can use `wrapped_lines`, `wrapped_src_indices`, and `raw_line_at` to render and style the text without doing its own wrapping.

*Call graph*: called by 1 (set_width); 6 external calls (new, width, width, new, matches!, take).
