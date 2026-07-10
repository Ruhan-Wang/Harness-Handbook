# TUI presentation models, styling, and lightweight view helpers  `stage-22.2.4`

This stage is shared presentation support for the text-based interface. It sits above the low-level text layout layer and below the bigger screens and widgets. Think of it as the kit of labels, colors, spacing rules, and small view models that help many TUI parts look consistent and behave the same.

Some files define the visual language. color.rs and style.rs choose readable colors and surface styles based on the terminal’s palette. ui_consts.rs keeps common indentation aligned. renderable.rs gives the main building block for anything that can be drawn, plus simple ways to place items in rows, columns, and inset boxes.

Other files shape user-facing text and interaction. key_hint.rs formats shortcut hints safely across keyboard quirks. footer.rs, action_required_title.rs, and popup_consts.rs build the bottom area’s status text, titles, and popup instructions. scroll_state.rs, selection_popup_common.rs, selection_tabs.rs, and selection_list.rs provide reusable menu behavior and drawing.

The remaining helpers turn raw data into compact display text: warnings suppression, import-item labels, goal summaries, skill labels, status formatting, remote connection summaries, token-chart palettes, and reusable history-cell pieces. Together, these pieces make many screens feel like one coherent interface.

## Files in this stage

### Styling and layout primitives
These files define the shared color, style, layout, and renderable foundations that higher-level TUI presentation helpers build on.

### `tui/src/color.rs`

`util` · `cross-cutting during theme/style computation`

This file contains three pure helpers over RGB tuples. `is_light` computes a luminance-like brightness score using the standard weighted sum `0.299*r + 0.587*g + 0.114*b` and compares it against `128.0`, giving callers a simple dark-vs-light background classification. `blend` performs straightforward alpha compositing between foreground and background tuples by linearly interpolating each channel with the supplied `alpha` and truncating back to `u8`.

The most substantial function is `perceptual_distance`, which approximates perceptual color difference by converting both colors from sRGB into CIE Lab-like coordinates and then taking Euclidean distance there (CIE76). It nests three local helpers to keep the conversion pipeline self-contained: `srgb_to_linear` applies the standard gamma correction threshold at `0.04045`; `rgb_to_xyz` multiplies the linearized channels by fixed coefficients for an XYZ transform; and `xyz_to_lab` normalizes against D65 reference white and applies the piecewise Lab transfer function threshold at `0.008856`. After converting both input colors, the function subtracts their `L`, `a`, and `b` components and returns the square root of the sum of squared deltas.

There is no mutable state or I/O here; the file exists purely to support adaptive theme and style calculations elsewhere in the TUI.

#### Function details

##### `is_light`  (lines 1–5)

```
fn is_light(bg: (u8, u8, u8)) -> bool
```

**Purpose**: Classifies an RGB background as light or dark using a weighted luminance heuristic. It gives theme code a simple boolean for contrast decisions.

**Data flow**: It destructures `bg` into `(r, g, b)`, computes `y = 0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32`, and returns `true` when `y > 128.0`.

**Call relations**: This helper is called by theme-construction and style-selection code such as adaptive theme selection and message background styling. It is a leaf utility with no further delegation.

*Call graph*: called by 6 (from_parts, diff_theme_for_bg, adaptive_default_theme_selection, dense_row_background_style, transcript_loading_overlay_style, user_message_bg).


##### `blend`  (lines 7–12)

```
fn blend(fg: (u8, u8, u8), bg: (u8, u8, u8), alpha: f32) -> (u8, u8, u8)
```

**Purpose**: Blends a foreground RGB color over a background RGB color using a scalar alpha. It is used to derive intermediate shades for overlays, separators, and shimmer effects.

**Data flow**: It takes `fg`, `bg`, and `alpha`, computes each output channel as `fg_channel * alpha + bg_channel * (1.0 - alpha)`, casts the results to `u8`, and returns the blended `(r, g, b)` tuple.

**Call relations**: This helper is used by multiple style builders that need deterministic channel-wise interpolation. It is pure and does not call other local functions.

*Call graph*: called by 6 (from_parts, dense_row_background_style, transcript_loading_overlay_style, shimmer_spans, table_separator_style_for, user_message_bg).


##### `perceptual_distance`  (lines 16–75)

```
fn perceptual_distance(a: (u8, u8, u8), b: (u8, u8, u8)) -> f32
```

**Purpose**: Computes an approximate perceptual distance between two RGB colors by converting them into Lab space and taking Euclidean distance. It is more visually meaningful than raw RGB distance for comparing theme colors.

**Data flow**: It accepts two RGB tuples `a` and `b`, converts each channel from sRGB to linear RGB with the nested `srgb_to_linear`, transforms linear RGB to XYZ with `rgb_to_xyz`, converts XYZ to Lab with `xyz_to_lab`, then subtracts the resulting `L`, `a`, and `b` components and returns `(dl*dl + da*da + db*db).sqrt()` as `f32`.

**Call relations**: This function stands alone as the most advanced color metric in the file. It is available to callers that need perceptual comparison rather than simple brightness or blending.


### `tui/src/style.rs`

`util` · `cross-cutting rendering`

This module is a focused styling utility layer over `ratatui::style::Style`. It exposes public helpers for user-message and proposed-plan backgrounds, plus crate-visible helpers for shared accent styling and low-contrast markdown table separators. The implementation is palette-aware: it consults terminal default foreground/background colors from `terminal_palette`, uses `is_light` to distinguish light versus dark themes, and quantizes RGB through `best_color` or `rgb_color` depending on the terminal's color capability.

The user-message and proposed-plan styles are intentionally parallel. `user_message_style` and `proposed_plan_style` fetch the terminal background via `default_bg()` and delegate to `_for` variants that either apply a computed background color or fall back to `Style::default()` when the terminal background is unknown. `user_message_bg` computes a subtle overlay by blending black at 4% on light terminals or white at 12% on dark terminals, then mapping that RGB to the best displayable color. `proposed_plan_bg` currently aliases the same background logic.

Accent styling is bolder and foreground-based: on light backgrounds it uses a darker cyan-like RGB constant `(0, 95, 135)` to preserve contrast, otherwise plain `Color::Cyan`. Table separators are deliberately subdued; when both terminal fg/bg are known, the separator color is a 20% blend of foreground toward background, emitted as truecolor or ANSI-256 approximation when possible, and downgraded to `.dim()` for ANSI-16 or unknown palettes. Tests pin these contrast and fallback choices.

#### Function details

##### `user_message_style`  (lines 17–19)

```
fn user_message_style() -> Style
```

**Purpose**: Builds the standard style for user-authored transcript messages using the terminal's detected default background. It is the convenience entry point used by renderers that do not already have palette data.

**Data flow**: It reads `default_bg()` from terminal palette state, passes that `Option<(u8,u8,u8)>` into `user_message_style_for`, and returns the resulting `Style`.

**Call relations**: Multiple transcript and surface renderers call this directly during paint. It delegates all actual style computation to `user_message_style_for` so palette lookup and style derivation stay separated.

*Call graph*: calls 2 internal fn (user_message_style_for, default_bg); called by 7 (render, render_with_mask_and_textarea_right_reserve, render, render, render, render_menu_surface, render).


##### `proposed_plan_style`  (lines 21–23)

```
fn proposed_plan_style() -> Style
```

**Purpose**: Builds the standard style for proposed-plan transcript regions using the terminal's default background. It mirrors `user_message_style` but for plan output.

**Data flow**: It fetches `default_bg()`, forwards that optional RGB tuple to `proposed_plan_style_for`, and returns the resulting `Style`.

**Call relations**: Plan-display rendering calls this when styling plan lines. Like the user-message helper, it is a thin wrapper around the `_for` variant.

*Call graph*: calls 2 internal fn (proposed_plan_style_for, default_bg); called by 1 (render_display_lines).


##### `table_separator_style`  (lines 26–28)

```
fn table_separator_style() -> Style
```

**Purpose**: Returns the shared style for decorative separators inside rendered markdown tables. The style is intentionally low-contrast so rules remain visible without competing with cell text.

**Data flow**: It reads `default_fg()`, `default_bg()`, and `stdout_color_level()`, passes them to `table_separator_style_for`, and returns the resulting `Style`.

**Call relations**: Markdown table rendering uses this when drawing internal rule characters. It delegates the actual blend and fallback logic to `table_separator_style_for`.

*Call graph*: calls 4 internal fn (table_separator_style_for, default_bg, default_fg, stdout_color_level); called by 1 (render_table_lines).


##### `accent_style`  (lines 31–33)

```
fn accent_style() -> Style
```

**Purpose**: Returns the shared accent style for selected or active TUI controls using the terminal's default background. It centralizes the app's highlighted-control appearance.

**Data flow**: It reads `default_bg()`, forwards that optional RGB tuple to `accent_style_for`, and returns the resulting `Style`.

**Call relations**: Selection and hint renderers call this for rows, tabs, and keymap affordances. It is the palette-aware wrapper around `accent_style_for`.

*Call graph*: calls 2 internal fn (accent_style_for, default_bg); called by 7 (event_table_lines, selected_event_rows_use_the_shared_accent_style, selected_rows_use_the_shared_accent_style, tab_unit, keymap_debug_hint_line, keymap_picker_hint_line, keymap_row_prefix).


##### `user_message_style_for`  (lines 36–41)

```
fn user_message_style_for(terminal_bg: Option<(u8, u8, u8)>) -> Style
```

**Purpose**: Computes the user-message style for a specific terminal background, applying a subtle background fill only when that background is known. Unknown backgrounds leave the style untouched.

**Data flow**: It takes `terminal_bg: Option<(u8,u8,u8)>`; when `Some(bg)`, it returns `Style::default().bg(user_message_bg(bg))`, otherwise `Style::default()`.

**Call relations**: This is called by `user_message_style` and can also be used by tests or callers with explicit palette knowledge. It delegates color derivation to `user_message_bg`.

*Call graph*: calls 1 internal fn (user_message_bg); called by 1 (user_message_style); 1 external calls (default).


##### `proposed_plan_style_for`  (lines 43–48)

```
fn proposed_plan_style_for(terminal_bg: Option<(u8, u8, u8)>) -> Style
```

**Purpose**: Computes the proposed-plan style for a specific terminal background. Its current behavior matches the user-message background treatment exactly.

**Data flow**: It takes `terminal_bg: Option<(u8,u8,u8)>`; when present it returns `Style::default().bg(proposed_plan_bg(bg))`, otherwise `Style::default()`.

**Call relations**: Called by `proposed_plan_style`; it delegates the actual background color choice to `proposed_plan_bg`, preserving a separate semantic entry point even though the current implementation is shared.

*Call graph*: calls 1 internal fn (proposed_plan_bg); called by 1 (proposed_plan_style); 1 external calls (default).


##### `accent_style_for`  (lines 51–57)

```
fn accent_style_for(terminal_bg: Option<(u8, u8, u8)>) -> Style
```

**Purpose**: Computes the foreground accent style for active controls against a known or unknown terminal background. It chooses a darker cyan on light backgrounds and plain cyan otherwise, always with bold emphasis.

**Data flow**: It takes `terminal_bg: Option<(u8,u8,u8)>`; if `terminal_bg.is_some_and(is_light)` it returns `Style::default().fg(best_color(LIGHT_BG_ACCENT_RGB)).bold()`, else `Style::default().fg(Color::Cyan).bold()`.

**Call relations**: The shared accent wrapper and tests call this directly. It delegates palette quantization only in the light-background branch because the hard-coded darker accent must still fit the terminal's supported color space.

*Call graph*: calls 1 internal fn (best_color); called by 2 (accent_style, accent_style_uses_darker_cyan_on_light_backgrounds); 1 external calls (default).


##### `table_separator_style_for`  (lines 59–73)

```
fn table_separator_style_for(
    terminal_fg: Option<(u8, u8, u8)>,
    terminal_bg: Option<(u8, u8, u8)>,
    color_level: StdoutColorLevel,
) -> Style
```

**Purpose**: Computes a separator style from explicit terminal foreground/background colors and a known stdout color level. It blends the separator toward the background and degrades gracefully when palette-aware color output is unavailable.

**Data flow**: Inputs are `terminal_fg`, `terminal_bg`, and `color_level`. If either color is `None`, it returns `Style::default().dim()`. Otherwise it computes `separator_rgb = blend(fg, bg, TABLE_SEPARATOR_FG_ALPHA)` and returns a foreground style using `rgb_color(separator_rgb)` for `TrueColor`, `best_color(separator_rgb)` for `Ansi256`, or `.dim()` for `Ansi16` and `Unknown`.

**Call relations**: The public separator helper and tests use this function. It encapsulates the policy that separators should be palette-aware when possible but should never become visually dominant on low-color terminals.

*Call graph*: calls 3 internal fn (blend, best_color, rgb_color); called by 3 (table_separator_style, table_separator_blends_toward_dark_background, table_separator_blends_toward_light_background); 1 external calls (default).


##### `user_message_bg`  (lines 76–83)

```
fn user_message_bg(terminal_bg: (u8, u8, u8)) -> Color
```

**Purpose**: Derives the background color used behind user messages from the terminal's default background. The result is a subtle contrast overlay rather than a fixed theme color.

**Data flow**: It takes `terminal_bg: (u8,u8,u8)`, chooses `(top, alpha)` as black/0.04 for light backgrounds or white/0.12 for dark backgrounds using `is_light`, blends `top` over `terminal_bg`, maps the blended RGB through `best_color`, and returns the resulting `Color`.

**Call relations**: Both user-message styling and proposed-plan background derivation rely on this function. It centralizes the light-vs-dark overlay rule so related surfaces stay visually consistent.

*Call graph*: calls 3 internal fn (blend, is_light, best_color); called by 2 (proposed_plan_bg, user_message_style_for).


##### `proposed_plan_bg`  (lines 86–88)

```
fn proposed_plan_bg(terminal_bg: (u8, u8, u8)) -> Color
```

**Purpose**: Returns the background color for proposed-plan regions. At present it intentionally reuses the exact same background computation as user messages.

**Data flow**: It takes `terminal_bg: (u8,u8,u8)`, forwards it to `user_message_bg`, and returns that `Color` unchanged.

**Call relations**: Called only by `proposed_plan_style_for`. Keeping this as a separate function preserves a semantic hook for future divergence without changing callers.

*Call graph*: calls 1 internal fn (user_message_bg); called by 1 (proposed_plan_style_for).


##### `tests::accent_style_uses_darker_cyan_on_light_backgrounds`  (lines 97–102)

```
fn accent_style_uses_darker_cyan_on_light_backgrounds()
```

**Purpose**: Checks that accent styling switches away from plain cyan on light terminals and keeps bold emphasis. It protects the contrast rule for light backgrounds.

**Data flow**: The test calls `accent_style_for(Some((255,255,255)))`, then asserts that the foreground equals `best_color(LIGHT_BG_ACCENT_RGB)` and that the bold modifier is present.

**Call relations**: This test exercises the light-background branch of `accent_style_for`, ensuring the palette-aware accent choice remains stable.

*Call graph*: calls 1 internal fn (accent_style_for); 2 external calls (assert!, assert_eq!).


##### `tests::accent_style_uses_cyan_on_dark_or_unknown_backgrounds`  (lines 105–110)

```
fn accent_style_uses_cyan_on_dark_or_unknown_backgrounds()
```

**Purpose**: Verifies that dark or unknown backgrounds use the default cyan bold accent style. It covers both the explicit dark branch and the no-palette fallback.

**Data flow**: It constructs the expected `Style::default().fg(Color::Cyan).bold()`, then asserts equality against `accent_style_for(Some((0,0,0)))` and `accent_style_for(None)`.

**Call relations**: This test complements the light-background test by pinning the fallback behavior of `accent_style_for`.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::table_separator_blends_toward_dark_background`  (lines 113–121)

```
fn table_separator_blends_toward_dark_background()
```

**Purpose**: Confirms that separator color blending produces a dark gray when white foreground is blended toward a black background in truecolor mode. It validates the blend ratio numerically.

**Data flow**: The test calls `table_separator_style_for(Some((255,255,255)), Some((0,0,0)), StdoutColorLevel::TrueColor)` and asserts that the resulting foreground is `rgb_color((51,51,51))`.

**Call relations**: This test exercises the truecolor branch of separator styling on a dark theme.

*Call graph*: calls 1 internal fn (table_separator_style_for); 1 external calls (assert_eq!).


##### `tests::table_separator_blends_toward_light_background`  (lines 124–132)

```
fn table_separator_blends_toward_light_background()
```

**Purpose**: Confirms that separator color blending produces a light gray when black foreground is blended toward a white background in truecolor mode. It validates the same alpha rule in the opposite direction.

**Data flow**: It calls `table_separator_style_for(Some((0,0,0)), Some((255,255,255)), StdoutColorLevel::TrueColor)` and asserts that the foreground is `rgb_color((204,204,204))`.

**Call relations**: This test covers the light-theme truecolor branch of separator styling.

*Call graph*: calls 1 internal fn (table_separator_style_for); 1 external calls (assert_eq!).


##### `tests::table_separator_dims_when_palette_aware_color_is_unavailable`  (lines 135–154)

```
fn table_separator_dims_when_palette_aware_color_is_unavailable()
```

**Purpose**: Verifies that separator styling falls back to a dim default style when either palette colors are missing or the terminal only supports ANSI-16 colors. It protects the low-fidelity fallback path.

**Data flow**: It builds `Style::default().dim()` as the expected value, then asserts equality for an `Ansi16` call with known colors and for a `TrueColor` call with missing foreground color.

**Call relations**: This test locks in the conservative fallback behavior of `table_separator_style_for` when palette-aware blending cannot be represented.

*Call graph*: 2 external calls (default, assert_eq!).


### `tui/src/ui_consts.rs`

`config` · `cross-cutting`

This file centralizes a small but important piece of UI geometry: how many terminal columns are reserved for the left-side prefix area. `LIVE_PREFIX_COLS` is defined as `2` and documented as the width consumed by the chat composer’s left border and padding, the leading spaces on status indicator lines, and the prefix budget for wrapped user history lines such as a `▌ ` marker. `FOOTER_INDENT_COLS` is then derived from that same value as a `usize`, avoiding repeated casts in code that indexes or pads string content rather than working in terminal-coordinate types. The main design choice is consistency through a single source of truth. By deriving footer indentation from `LIVE_PREFIX_COLS`, the file prevents subtle drift where different widgets might otherwise hard-code slightly different left margins. Although these are just constants, they influence wrapping, alignment, and visual rhythm across the interface, so keeping them together with explicit semantic comments helps maintainers understand that changing the value affects several independent rendering paths at once.


### `tui/src/render/renderable.rs`

`domain_logic` · `cross-cutting`

This file is the backbone of the TUI's lightweight rendering composition system. The central trait, `Renderable`, abstracts three concerns: drawing into a `Buffer`, reporting desired height for a given width, and optionally exposing cursor position/style. Default cursor methods return no cursor and `DefaultUserShape`, letting most renderables ignore cursor management.

To make heterogeneous composition ergonomic, the file defines `RenderableItem<'a>` as either an owned boxed renderable or a borrowed trait object, plus conversion impls from `Box<dyn Renderable>` and from any concrete `Renderable` into a boxed trait object. It also implements `Renderable` for common leaf types—`()`, `&str`, `String`, `Span`, `Line`, `Paragraph`, `Option<R>`, and `Arc<R>`—so plain text and wrapped widgets can be inserted directly into layout containers.

The layout containers are all vertical/horizontal combinators. `ColumnRenderable` stacks children top-to-bottom using each child's desired height and clips each child area with `intersection(area)`. `RowRenderable` lays out fixed-width children left-to-right and computes height as the maximum child height over the available widths. `FlexRenderable` is a more sophisticated vertical allocator: non-flex children reserve their desired heights first, then positive-flex children share remaining height proportionally, with a redistribution pass that satisfies short flex children early so unused space can be reallocated. The final flex child absorbs rounding slack.

`InsetRenderable` wraps any child with `Insets`, shrinking render/cursor areas and expanding desired height by top/bottom padding. Finally, `RenderableExt::inset` offers a fluent way to wrap any renderable in an inset wrapper. Across all containers, cursor queries mirror render layout so the first child reporting a cursor determines the composite cursor position and style.

#### Function details

##### `Renderable::cursor_pos`  (lines 17–19)

```
fn cursor_pos(&self, _area: Rect) -> Option<(u16, u16)>
```

**Purpose**: Provides the default cursor-position behavior for renderables that do not manage a cursor.

**Data flow**: It takes an area argument but ignores it and returns `None`.

**Call relations**: Concrete renderables inherit this default unless they need to expose a cursor location to the terminal UI.


##### `Renderable::cursor_style`  (lines 20–22)

```
fn cursor_style(&self, _area: Rect) -> SetCursorStyle
```

**Purpose**: Provides the default cursor-style behavior for renderables that do not customize cursor appearance.

**Data flow**: It takes an area argument but ignores it and returns `SetCursorStyle::DefaultUserShape`.

**Call relations**: Composite renderables call this when a child with a cursor is found; leaf renderables can override it if they need a different cursor shape.


##### `RenderableItem::render`  (lines 31–36)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Dispatches rendering to either the owned or borrowed child renderable stored in the enum.

**Data flow**: It takes a target `Rect` and mutable `Buffer`, matches on `self`, and forwards the render call to the contained child. It writes into the provided buffer and returns no value.

**Call relations**: This enum-level dispatcher is used by composite containers like columns, rows, flex layouts, and inset wrappers whenever they render heterogeneous children.

*Call graph*: called by 1 (render).


##### `RenderableItem::desired_height`  (lines 38–43)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Delegates desired-height calculation to the contained owned or borrowed child.

**Data flow**: It takes a width, matches on `self`, calls the child's `desired_height(width)`, and returns the resulting `u16`.

**Call relations**: Composite layout containers rely on this method when sizing `RenderableItem` children without caring whether they are owned or borrowed.

*Call graph*: called by 1 (desired_height).


##### `RenderableItem::cursor_pos`  (lines 45–50)

```
fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)>
```

**Purpose**: Delegates cursor-position lookup to the contained child renderable.

**Data flow**: It takes an area, matches on `self`, forwards `cursor_pos(area)`, and returns the child's `Option<(u16, u16)>`.

**Call relations**: This dispatcher is used by composite renderables when searching children for the active cursor location.

*Call graph*: called by 1 (cursor_pos).


##### `RenderableItem::cursor_style`  (lines 52–57)

```
fn cursor_style(&self, area: Rect) -> SetCursorStyle
```

**Purpose**: Delegates cursor-style lookup to the contained child renderable.

**Data flow**: It takes an area, matches on `self`, forwards `cursor_style(area)`, and returns the resulting `SetCursorStyle`.

**Call relations**: Composite renderables use this after identifying which child owns the cursor.

*Call graph*: called by 1 (cursor_style).


##### `RenderableItem::from`  (lines 61–63)

```
fn from(value: Box<dyn Renderable + 'a>) -> Self
```

**Purpose**: Wraps an owned boxed renderable into the `RenderableItem::Owned` variant.

**Data flow**: It takes `Box<dyn Renderable + 'a>` and returns `RenderableItem::Owned(value)`.

**Call relations**: This conversion supports ergonomic insertion of boxed renderables into container APIs that accept `Into<RenderableItem<'a>>`.

*Call graph*: 1 external calls (Owned).


##### `Box::from`  (lines 70–72)

```
fn from(value: R) -> Self
```

**Purpose**: Boxes any concrete renderable as a `Box<dyn Renderable>` trait object.

**Data flow**: It takes a concrete `R: Renderable + 'a`, allocates it with `Box::new`, and returns `Box<dyn Renderable + 'a>`.

**Call relations**: This conversion underlies APIs like `ColumnRenderable::push` and `RowRenderable::push`, allowing callers to pass concrete renderables directly.

*Call graph*: 1 external calls (new).


##### `str::render`  (lines 83–85)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders a string slice by delegating to ratatui's widget-ref rendering support.

**Data flow**: It takes an area and mutable buffer and calls `self.render_ref(area, buf)`. It writes text into the buffer and returns no value.

**Call relations**: This blanket implementation lets plain `&str` values participate directly in the `Renderable` ecosystem as leaf nodes.


##### `str::desired_height`  (lines 86–88)

```
fn desired_height(&self, _width: u16) -> u16
```

**Purpose**: Reports that a string slice occupies one row when treated as a renderable leaf.

**Data flow**: It ignores width and returns `1`.

**Call relations**: This sizing behavior is used by composite containers when laying out `&str` children.


##### `String::render`  (lines 92–94)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders an owned string by delegating to ratatui's widget-ref rendering support.

**Data flow**: It takes an area and mutable buffer and calls `self.render_ref(area, buf)`. It writes into the buffer and returns no value.

**Call relations**: This implementation allows owned `String` values to be inserted directly into renderable containers.


##### `String::desired_height`  (lines 95–97)

```
fn desired_height(&self, _width: u16) -> u16
```

**Purpose**: Reports that an owned string occupies one row as a renderable leaf.

**Data flow**: It ignores width and returns `1`.

**Call relations**: Composite layouts use this when sizing `String` children.


##### `Span::render`  (lines 101–103)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders a ratatui `Span` directly into the target buffer.

**Data flow**: It takes an area and mutable buffer and calls `self.render_ref(area, buf)`. It writes styled text into the buffer.

**Call relations**: This implementation lets individual spans be used as standalone renderables in composed layouts.


##### `Span::desired_height`  (lines 104–106)

```
fn desired_height(&self, _width: u16) -> u16
```

**Purpose**: Reports that a single span occupies one row.

**Data flow**: It ignores width and returns `1`.

**Call relations**: This is the sizing counterpart to `Span::render` for layout containers.


##### `Line::render`  (lines 110–112)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders a ratatui `Line` using `WidgetRef` support.

**Data flow**: It takes an area and mutable buffer and calls `WidgetRef::render_ref(self, area, buf)`. It writes the line into the buffer.

**Call relations**: This implementation allows complete ratatui lines to be embedded directly in renderable compositions.

*Call graph*: 1 external calls (render_ref).


##### `Line::desired_height`  (lines 113–115)

```
fn desired_height(&self, _width: u16) -> u16
```

**Purpose**: Reports that a single `Line` occupies one row.

**Data flow**: It ignores width and returns `1`.

**Call relations**: Composite layouts use this fixed height when stacking or arranging line renderables.


##### `Paragraph::render`  (lines 119–121)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders a ratatui `Paragraph` directly into the target buffer.

**Data flow**: It takes an area and mutable buffer and calls `self.render_ref(area, buf)`. It writes paragraph content into the buffer.

**Call relations**: This implementation lets richer wrapped text widgets participate in the same `Renderable` trait as simpler leaf types.


##### `Paragraph::desired_height`  (lines 122–124)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Computes a paragraph's desired height by asking ratatui how many wrapped lines it would occupy at the given width.

**Data flow**: It takes a width, calls `self.line_count(width)`, casts the result to `u16`, and returns it.

**Call relations**: This sizing logic is used by composite containers to allocate enough vertical space for wrapped paragraphs.


##### `Option::render`  (lines 128–132)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders an optional child only when it is present.

**Data flow**: It takes an area and mutable buffer, checks `self`, and if `Some(renderable)` forwards `render(area, buf)`; otherwise it does nothing.

**Call relations**: This blanket implementation allows optional UI fragments to be inserted into layouts without separate branching at call sites.


##### `Option::desired_height`  (lines 134–140)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Reports the contained child's desired height or zero when the option is empty.

**Data flow**: It takes a width, returns `renderable.desired_height(width)` for `Some`, and `0` for `None`.

**Call relations**: Composite layouts use this to naturally collapse absent optional children.


##### `Option::cursor_pos`  (lines 142–145)

```
fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)>
```

**Purpose**: Returns the contained child's cursor position when present.

**Data flow**: It takes an area, converts `self` to `Option<&R>`, calls `cursor_pos(area)` on the child if present, and returns the resulting option.

**Call relations**: This lets optional renderables participate in cursor propagation without extra branching.


##### `Option::cursor_style`  (lines 147–152)

```
fn cursor_style(&self, area: Rect) -> SetCursorStyle
```

**Purpose**: Returns the contained child's cursor style when present, otherwise the default cursor shape.

**Data flow**: It takes an area, maps `Some(renderable)` to `renderable.cursor_style(area)`, and returns `DefaultUserShape` for `None`.

**Call relations**: This complements `Option::cursor_pos` in composite cursor handling.


##### `Arc::render`  (lines 156–158)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders an `Arc`-wrapped renderable by delegating to the inner value.

**Data flow**: It takes an area and mutable buffer, dereferences the `Arc`, and calls the inner renderable's `render` method.

**Call relations**: This blanket implementation allows shared renderables to be inserted into layouts without manual dereferencing.


##### `Arc::desired_height`  (lines 159–161)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Delegates desired-height calculation through an `Arc` wrapper.

**Data flow**: It takes a width, dereferences the `Arc`, and returns the inner renderable's desired height.

**Call relations**: This is the sizing counterpart to `Arc::render`.


##### `Arc::cursor_pos`  (lines 162–164)

```
fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)>
```

**Purpose**: Delegates cursor-position lookup through an `Arc` wrapper.

**Data flow**: It takes an area, dereferences the `Arc`, and returns the inner renderable's cursor position.

**Call relations**: This supports shared renderables that expose cursor state.


##### `Arc::cursor_style`  (lines 165–167)

```
fn cursor_style(&self, area: Rect) -> SetCursorStyle
```

**Purpose**: Delegates cursor-style lookup through an `Arc` wrapper.

**Data flow**: It takes an area, dereferences the `Arc`, and returns the inner renderable's cursor style.

**Call relations**: This complements `Arc::cursor_pos` for shared cursor-owning widgets.


##### `ColumnRenderable::render`  (lines 175–185)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders children stacked vertically, clipping each child to the available parent area.

**Data flow**: It takes a parent `Rect` and mutable `Buffer`, initializes `y` to `area.y`, then for each child computes a child rectangle with the full width and the child's desired height, intersects it with the parent area, renders the child if the resulting area is non-empty, and advances `y` by the rendered height.

**Call relations**: This is the main vertical composition routine for `ColumnRenderable`. It relies on each child's `desired_height` and `render` methods to lay out and draw the stack.

*Call graph*: 1 external calls (new).


##### `ColumnRenderable::desired_height`  (lines 187–192)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Computes the total height of a vertical stack by summing child desired heights.

**Data flow**: It takes a width, iterates all children, sums `child.desired_height(width)`, and returns the total `u16`.

**Call relations**: This sizing method is used by parent layouts when a column itself is nested inside another renderable.


##### `ColumnRenderable::cursor_pos`  (lines 198–211)

```
fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)>
```

**Purpose**: Finds the first child in the vertical stack that reports a cursor position and returns it in parent coordinates.

**Data flow**: It takes a parent area, walks children in render order while computing each child's rectangle exactly as `render` does, skips empty intersections, queries `child.cursor_pos(child_area)`, and returns the first non-`None` position found; otherwise `None`.

**Call relations**: This mirrors `ColumnRenderable::render` so cursor lookup stays aligned with actual child placement.

*Call graph*: 1 external calls (new).


##### `ColumnRenderable::cursor_style`  (lines 213–224)

```
fn cursor_style(&self, area: Rect) -> SetCursorStyle
```

**Purpose**: Returns the cursor style of the first vertically stacked child that owns the cursor.

**Data flow**: It takes a parent area, computes each child area as in `render`, checks whether `child.cursor_pos(child_area)` is `Some`, and if so returns `child.cursor_style(child_area)`; otherwise it falls back to `DefaultUserShape`.

**Call relations**: This method pairs with `ColumnRenderable::cursor_pos`, ensuring the style comes from the same child that supplies the cursor.

*Call graph*: 1 external calls (new).


##### `ColumnRenderable::new`  (lines 228–230)

```
fn new() -> Self
```

**Purpose**: Constructs an empty vertical renderable container.

**Data flow**: It allocates an empty `Vec<RenderableItem<'a>>` and returns `ColumnRenderable { children }`.

**Call relations**: This constructor is widely used across the UI wherever a vertical stack is built incrementally.

*Call graph*: called by 31 (new, reset_confirmation_header, settings_header, build, new, connectors_loading_popup_params, connectors_popup_params, model_menu_header, open_reasoning_popup, marketplace_add_error_popup_params (+15 more)); 1 external calls (vec!).


##### `ColumnRenderable::with`  (lines 232–240)

```
fn with(children: I) -> Self
```

**Purpose**: Constructs a vertical renderable container from an iterable of children.

**Data flow**: It takes any `IntoIterator` of items convertible into `RenderableItem<'a>`, converts and collects them into the `children` vector, and returns the populated `ColumnRenderable`.

**Call relations**: This constructor is used when a column's children are known up front rather than pushed incrementally.

*Call graph*: called by 7 (build_options, build_header, feedback_upload_consent_params, new, open_full_access_confirmation, open_world_writable_warning_confirmation, from); 1 external calls (into_iter).


##### `ColumnRenderable::push`  (lines 242–244)

```
fn push(&mut self, child: impl Into<Box<dyn Renderable + 'a>>)
```

**Purpose**: Appends a new owned child renderable to the end of the vertical stack.

**Data flow**: It takes any value convertible into `Box<dyn Renderable + 'a>`, boxes/converts it, wraps it as `RenderableItem::Owned`, pushes it into `self.children`, and returns no value.

**Call relations**: This mutating builder method is used by higher-level renderers that assemble columns step by step.

*Call graph*: called by 3 (render_lines, render_markdown_content, render_menu); 2 external calls (into, Owned).


##### `FlexRenderable::new`  (lines 261–263)

```
fn new() -> Self
```

**Purpose**: Constructs an empty flex-based vertical layout container.

**Data flow**: It allocates an empty `Vec<FlexChild<'a>>` and returns `FlexRenderable { children }`.

**Call relations**: This constructor is used where vertical space must be shared proportionally among children rather than simply stacked at desired heights.

*Call graph*: called by 4 (as_renderable_with_composer_right_reserve, as_renderable, flex_redistributes_space_unused_by_short_children, flex_reserves_non_flex_space_before_flexible_children); 1 external calls (vec!).


##### `FlexRenderable::push`  (lines 265–270)

```
fn push(&mut self, flex: i32, child: impl Into<RenderableItem<'a>>)
```

**Purpose**: Adds a child to the flex layout with an associated flex factor.

**Data flow**: It takes an `i32` flex value and a child convertible into `RenderableItem<'a>`, converts the child, wraps both into `FlexChild { flex, child }`, pushes it into `self.children`, and returns no value.

**Call relations**: This builder method feeds the allocation algorithm in `FlexRenderable::allocate`.

*Call graph*: 1 external calls (into).


##### `FlexRenderable::allocate`  (lines 275–338)

```
fn allocate(&self, area: Rect) -> Vec<Rect>
```

**Purpose**: Computes the vertical rectangles assigned to each flex child, reserving fixed children first and distributing remaining space among positive-flex children.

**Data flow**: It takes a parent `Rect`, initializes per-child sizes, allocates non-flex children their desired heights capped by remaining space, computes free space, repeatedly satisfies flex children whose desired height is less than or equal to their proportional share so unused space can be redistributed, then divides the remaining space proportionally among the remaining flex children with the last flex child absorbing rounding slack. Finally it converts the computed heights into stacked `Rect`s and returns `Vec<Rect>`.

**Call relations**: This is the core layout algorithm used by all `FlexRenderable` trait methods (`render`, `desired_height`, `cursor_pos`, `cursor_style`).

*Call graph*: called by 4 (cursor_pos, cursor_style, desired_height, render); 5 external calls (new, new, with_capacity, from, vec!).


##### `FlexRenderable::render`  (lines 342–349)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders each flex child into the rectangle assigned by the allocation algorithm.

**Data flow**: It takes a parent area and mutable buffer, computes child rectangles with `allocate(area)`, zips them with `self.children`, and calls each child's `render` with its assigned rectangle.

**Call relations**: This method is the drawing phase for `FlexRenderable`, directly consuming the geometry produced by `allocate`.

*Call graph*: calls 1 internal fn (allocate).


##### `FlexRenderable::desired_height`  (lines 351–356)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Computes the total height a flex layout would occupy at a given width by allocating against an effectively unbounded height.

**Data flow**: It constructs a synthetic `Rect::new(0, 0, width, u16::MAX)`, runs `allocate`, takes the last allocated rectangle if any, and returns its bottom coordinate or 0 when there are no children.

**Call relations**: This sizing method reuses the same allocation logic as rendering so desired-height calculations stay consistent with actual layout.

*Call graph*: calls 1 internal fn (allocate); 1 external calls (new).


##### `FlexRenderable::cursor_pos`  (lines 358–363)

```
fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)>
```

**Purpose**: Finds the first flex child that reports a cursor position within its allocated rectangle.

**Data flow**: It takes a parent area, computes child rectangles with `allocate(area)`, zips them with children, queries each child's `cursor_pos(rect)`, and returns the first non-`None` result.

**Call relations**: This mirrors flex rendering order and geometry so cursor lookup matches actual child placement.

*Call graph*: calls 1 internal fn (allocate).


##### `FlexRenderable::cursor_style`  (lines 365–376)

```
fn cursor_style(&self, area: Rect) -> SetCursorStyle
```

**Purpose**: Returns the cursor style of the first flex child whose allocated rectangle contains that child's cursor.

**Data flow**: It takes a parent area, computes allocations, zips them with children, finds the first child whose `cursor_pos(rect)` is `Some`, maps that to `child.cursor_style(rect)`, and falls back to `DefaultUserShape` if none qualify.

**Call relations**: This method complements `FlexRenderable::cursor_pos`, using the same allocation results to identify the cursor-owning child.

*Call graph*: calls 1 internal fn (allocate).


##### `RowRenderable::render`  (lines 384–395)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders fixed-width children left-to-right across a single row area until no width remains.

**Data flow**: It takes a parent `Rect` and mutable `Buffer`, tracks the current `x`, computes each child area using the configured width capped by remaining width, stops if the child area is empty, renders the child, and advances `x` by the configured width using saturation.

**Call relations**: This is the horizontal composition routine for `RowRenderable`, used when children have explicit widths.

*Call graph*: 1 external calls (new).


##### `RowRenderable::desired_height`  (lines 396–411)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Computes the row's height as the maximum desired height among children over the widths they will actually receive.

**Data flow**: It takes total available width, iterates children left-to-right, caps each configured width by remaining width, stops when width reaches zero, queries each child's `desired_height(w)`, tracks the maximum, subtracts consumed width, and returns the max height.

**Call relations**: This sizing method lets a row participate in larger layouts while respecting each child's fixed-width allocation.


##### `RowRenderable::cursor_pos`  (lines 413–426)

```
fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)>
```

**Purpose**: Finds the first horizontally arranged child that reports a cursor position within its assigned rectangle.

**Data flow**: It takes a parent area, computes each child area exactly as `render` does, skips empty areas, queries `child.cursor_pos(child_area)`, and returns the first non-`None` position found.

**Call relations**: This mirrors row rendering geometry so cursor lookup stays consistent with actual horizontal placement.

*Call graph*: 1 external calls (new).


##### `RowRenderable::cursor_style`  (lines 428–439)

```
fn cursor_style(&self, area: Rect) -> SetCursorStyle
```

**Purpose**: Returns the cursor style of the first row child that owns the cursor.

**Data flow**: It takes a parent area, computes child areas as in `render`, checks whether each child reports a cursor position, and returns that child's `cursor_style(child_area)` for the first match; otherwise `DefaultUserShape`.

**Call relations**: This method pairs with `RowRenderable::cursor_pos` to propagate cursor appearance from the active horizontal child.

*Call graph*: 1 external calls (new).


##### `RowRenderable::new`  (lines 443–445)

```
fn new() -> Self
```

**Purpose**: Constructs an empty horizontal renderable container.

**Data flow**: It allocates an empty `Vec<(u16, RenderableItem<'a>)>` and returns `RowRenderable { children }`.

**Call relations**: This constructor is used where fixed-width horizontal composition is needed.

*Call graph*: called by 1 (selection_option_row_with_dim); 1 external calls (vec!).


##### `RowRenderable::push`  (lines 447–450)

```
fn push(&mut self, width: u16, child: impl Into<Box<dyn Renderable>>)
```

**Purpose**: Appends a fixed-width owned child to the horizontal row.

**Data flow**: It takes a width and a child convertible into `Box<dyn Renderable>`, boxes/converts the child, wraps it as `RenderableItem::Owned`, pushes `(width, child)` into `self.children`, and returns no value.

**Call relations**: This mutating builder method is used to assemble rows incrementally.

*Call graph*: 2 external calls (into, Owned).


##### `InsetRenderable::render`  (lines 459–461)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the wrapped child inside the parent area reduced by the configured insets.

**Data flow**: It takes a parent area and mutable buffer, computes `area.inset(self.insets)`, and forwards rendering to the child with that inset rectangle.

**Call relations**: This wrapper is used whenever a renderable should draw inside padded bounds rather than flush to its assigned rectangle.

*Call graph*: calls 1 internal fn (render); 1 external calls (inset).


##### `InsetRenderable::desired_height`  (lines 462–467)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Reports the wrapped child's desired height plus vertical padding, using reduced width for the child calculation.

**Data flow**: It takes a width, subtracts left and right inset values from it, asks the child for `desired_height` at that inner width, adds top and bottom inset values, and returns the total.

**Call relations**: This sizing method ensures parent layouts reserve enough space for both the child content and its padding.

*Call graph*: calls 1 internal fn (desired_height).


##### `InsetRenderable::cursor_pos`  (lines 468–470)

```
fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)>
```

**Purpose**: Queries the wrapped child's cursor position within the inset inner rectangle.

**Data flow**: It takes a parent area, computes `area.inset(self.insets)`, forwards `cursor_pos` to the child, and returns the result.

**Call relations**: This keeps cursor lookup aligned with the padded render area used by `InsetRenderable::render`.

*Call graph*: calls 1 internal fn (cursor_pos); 1 external calls (inset).


##### `InsetRenderable::cursor_style`  (lines 472–474)

```
fn cursor_style(&self, area: Rect) -> SetCursorStyle
```

**Purpose**: Queries the wrapped child's cursor style within the inset inner rectangle.

**Data flow**: It takes a parent area, computes `area.inset(self.insets)`, forwards `cursor_style` to the child, and returns the result.

**Call relations**: This complements `InsetRenderable::cursor_pos` for padded cursor propagation.

*Call graph*: calls 1 internal fn (cursor_style); 1 external calls (inset).


##### `InsetRenderable::new`  (lines 478–483)

```
fn new(child: impl Into<RenderableItem<'a>>, insets: Insets) -> Self
```

**Purpose**: Constructs an inset wrapper around a child renderable.

**Data flow**: It takes a child convertible into `RenderableItem<'a>` and an `Insets`, converts the child, stores both fields, and returns `InsetRenderable { child, insets }`.

**Call relations**: This constructor is used directly in a few call sites and indirectly by the fluent `RenderableExt::inset` helper.

*Call graph*: called by 3 (from, insert_cell, live_tail_renderable); 1 external calls (into).


##### `R::inset`  (lines 494–498)

```
fn inset(self, insets: Insets) -> RenderableItem<'a>
```

**Purpose**: Fluently wraps any concrete renderable in an owned `InsetRenderable` and returns it as a `RenderableItem`.

**Data flow**: It takes ownership of `self` plus an `Insets`, boxes `self` as a `Renderable`, wraps that boxed child in `InsetRenderable { child, insets }`, boxes the wrapper, and returns `RenderableItem::Owned(...)`.

**Call relations**: This extension method is the ergonomic entrypoint for callers that want to add padding around any renderable without manually constructing `InsetRenderable`.

*Call graph*: 2 external calls (new, Owned).


### Key hints and footer presentation
This group covers keybinding display logic and the footer/title builders that turn bottom-pane state into compact user-facing guidance.

### `tui/src/key_hint.rs`

`util` · `cross-cutting`

This module provides the small but important abstraction layer between raw `crossterm::event::KeyEvent` values and the rest of the TUI. `KeyBinding` stores a `KeyCode` plus `KeyModifiers` and exposes constructors for common combinations (`plain`, `alt`, `shift`, `ctrl`, `ctrl_alt`). The core logic is `normalize_key_parts`, which smooths over terminal inconsistencies: uppercase ASCII letters are normalized to lowercase plus `SHIFT`, and raw C0 control characters such as LF or `\u{0012}` are mapped back to `ctrl-j` or `ctrl-r` when no modifiers are reported. `KeyBinding::is_press` compares normalized binding parts against normalized event parts and accepts both `Press` and `Repeat` kinds while rejecting `Release`. `KeyBindingListExt` extends slices of bindings with `is_pressed`, treating them as alternatives for one action. `is_plain_text_key_event` draws the boundary used by searchable pickers: printable characters without Ctrl or Alt count as text input even if some views also bind those letters for navigation. For UI display, `display_label` converts bindings into human-readable strings with platform-sensitive Alt prefixes (`⌥ + ` on macOS/tests, `alt + ` elsewhere), and `From<KeyBinding> for Span` renders them dimmed via `key_hint_style`. `has_ctrl_or_alt` and `is_altgr` help callers distinguish real command modifiers from Windows AltGr input. The tests focus on normalization correctness and matching behavior across uppercase and raw-control-character edge cases.

#### Function details

##### `KeyBinding::new`  (lines 50–52)

```
fn new(key: KeyCode, modifiers: KeyModifiers) -> Self
```

**Purpose**: Constructs a `KeyBinding` from an explicit key code and modifier set without applying normalization.

**Data flow**: Accepts a `KeyCode` and `KeyModifiers`, stores them directly in `Self`, and returns the new binding.

**Call relations**: Used by the convenience constructors, config parsing, and one test that needs a custom modifier combination.

*Call graph*: called by 7 (alt, ctrl, ctrl_alt, plain, shift, shift_letter_binding_preserves_other_modifiers_with_uppercase_compat, parse_keybinding).


##### `KeyBinding::from_event`  (lines 54–57)

```
fn from_event(event: KeyEvent) -> Self
```

**Purpose**: Builds a normalized `KeyBinding` from a raw `KeyEvent`.

**Data flow**: Reads `event.code` and `event.modifiers`, normalizes them with `normalize_key_parts`, and returns a `KeyBinding` containing the normalized pair.

**Call relations**: Called when converting runtime key events into binding-like values for matching or config serialization.

*Call graph*: calls 1 internal fn (normalize_key_parts); called by 2 (handle_key_event, key_event_to_config_key_spec).


##### `KeyBinding::is_press`  (lines 59–63)

```
fn is_press(&self, event: KeyEvent) -> bool
```

**Purpose**: Checks whether a raw key event should trigger this binding, including compatibility normalization and repeat acceptance.

**Data flow**: Normalizes both the binding’s stored `(key, modifiers)` and the incoming event’s `(code, modifiers)` with `normalize_key_parts`, compares them for equality, and additionally requires `event.kind` to be `Press` or `Repeat`. Returns `bool`.

**Call relations**: Used directly by slice matching and tests. It is the core runtime matcher for one binding.

*Call graph*: calls 1 internal fn (normalize_key_parts).


##### `KeyBinding::parts`  (lines 65–67)

```
fn parts(&self) -> (KeyCode, KeyModifiers)
```

**Purpose**: Returns the binding’s stored key code and modifiers as a tuple.

**Data flow**: Reads `self.key` and `self.modifiers` and returns `(KeyCode, KeyModifiers)`.

**Call relations**: Used by config serialization code that needs to inspect a binding’s raw components.

*Call graph*: called by 1 (binding_to_config_key_spec).


##### `KeyBinding::display_label`  (lines 69–83)

```
fn display_label(&self) -> String
```

**Purpose**: Formats a binding into a human-readable label for footer hints and picker UI.

**Data flow**: Converts modifiers to a prefix string with `modifiers_to_string`, maps special keys like Enter, arrows, PageUp/PageDown, and space to friendly labels, lowercases other key strings, concatenates prefix and key, and returns the resulting `String`.

**Call relations**: Used by the `Span` conversion impl when rendering key hints in the UI.

*Call graph*: calls 1 internal fn (modifiers_to_string); called by 1 (from); 2 external calls (to_string, format!).


##### `normalize_key_parts`  (lines 86–103)

```
fn normalize_key_parts(
    key: KeyCode,
    mut modifiers: KeyModifiers,
) -> (KeyCode, KeyModifiers)
```

**Purpose**: Normalizes key code/modifier pairs so bindings match across terminal reporting quirks.

**Data flow**: Accepts a `KeyCode` and mutable `KeyModifiers`. Non-character keys are returned unchanged. For character keys, if modifiers are empty and the char is a supported C0 control character, it returns the corresponding printable char plus `CONTROL`. If the char is uppercase ASCII, it inserts `SHIFT` and lowercases the char. Otherwise it returns the original pair.

**Call relations**: Called by both `KeyBinding::from_event` and `KeyBinding::is_press`, making it the shared normalization rule for matching and serialization.

*Call graph*: calls 1 internal fn (c0_control_char_to_ctrl_char); called by 3 (from_event, is_press, key_parts_to_config_key_spec); 3 external calls (Char, insert, is_empty).


##### `c0_control_char_to_ctrl_char`  (lines 105–113)

```
fn c0_control_char_to_ctrl_char(ch: char) -> Option<char>
```

**Purpose**: Maps raw C0 control characters to the printable character used in `ctrl-<char>` bindings.

**Data flow**: Converts the input `char` to `u32`, matches ranges for NUL (`ctrl-space`), `0x01..=0x1a` (`ctrl-a` through `ctrl-z`), and `0x1c..=0x1f` (`ctrl-4` through `ctrl-7`), and returns `Option<char>`.

**Call relations**: Used only by `normalize_key_parts` to support terminals that report Ctrl chords as raw control bytes.

*Call graph*: called by 1 (normalize_key_parts); 2 external calls (from_u32, from).


##### `KeyBinding::is_pressed`  (lines 126–128)

```
fn is_pressed(&self, event: KeyEvent) -> bool
```

**Purpose**: Checks whether any binding in a slice matches a given key event.

**Data flow**: Borrows a slice of `KeyBinding` and a `KeyEvent`, iterates the slice, calls `binding.is_press(event)` for each, and returns true on the first match.

**Call relations**: Used by higher-level key-dispatch helpers that treat a binding list as one action’s alternatives.

*Call graph*: called by 2 (is_history_search_forward_key, is_history_search_key).


##### `is_plain_text_key_event`  (lines 139–150)

```
fn is_plain_text_key_event(event: KeyEvent) -> bool
```

**Purpose**: Determines whether a key event should be treated as literal text input rather than a command/navigation chord.

**Data flow**: Pattern-matches the event and returns true only for `KeyCode::Char(ch)` where `ch` is not an ASCII control character and modifiers contain neither `CONTROL` nor `ALT`.

**Call relations**: Called by input-handling code and searchable pickers to avoid stealing printable characters for navigation.

*Call graph*: called by 4 (handle_key_event, handle_key_event, handle_key_event, handle_key); 1 external calls (matches!).


##### `plain`  (lines 152–154)

```
fn plain(key: KeyCode) -> KeyBinding
```

**Purpose**: Convenience constructor for an unmodified key binding.

**Data flow**: Accepts a `KeyCode`, calls `KeyBinding::new(key, KeyModifiers::NONE)`, and returns the binding.

**Call relations**: Widely used by default keymap and footer-hint code for plain keys.

*Call graph*: calls 1 internal fn (new); called by 14 (footer_props, new_with_config, footer_insert_newline_key, history_search_action_key_span, default_bindings, esc_hint_line, new, render_one_pending_steer_with_remapped_interrupt_binding, footer_tips, skills_toggle_hint_line (+4 more)).


##### `alt`  (lines 156–158)

```
fn alt(key: KeyCode) -> KeyBinding
```

**Purpose**: Convenience constructor for an Alt-modified key binding.

**Data flow**: Accepts a `KeyCode`, calls `KeyBinding::new(key, KeyModifiers::ALT)`, and returns the binding.

**Call relations**: Used by default bindings and terminal-specific shortcut selection.

*Call graph*: calls 1 internal fn (new); called by 6 (default_bindings, new, queued_message_edit_binding_for_terminal, alt_up_edits_most_recent_queued_message, next_agent_shortcut, previous_agent_shortcut).


##### `shift`  (lines 160–162)

```
fn shift(key: KeyCode) -> KeyBinding
```

**Purpose**: Convenience constructor for a Shift-modified key binding.

**Data flow**: Accepts a `KeyCode`, calls `KeyBinding::new(key, KeyModifiers::SHIFT)`, and returns the binding.

**Call relations**: Used by footer hints, shortcut definitions, and tests covering uppercase compatibility.

*Call graph*: calls 1 internal fn (new); called by 6 (footer_insert_newline_key, footer_snapshots, render_one_message_with_shift_left_binding, queued_message_edit_binding_for_terminal, shift_letter_binding_does_not_match_plain_lowercase_or_other_uppercase, shifted_letter_binding_matches_uppercase_char_events).


##### `ctrl`  (lines 164–166)

```
fn ctrl(key: KeyCode) -> KeyBinding
```

**Purpose**: Convenience constructor for a Control-modified key binding.

**Data flow**: Accepts a `KeyCode`, calls `KeyBinding::new(key, KeyModifiers::CONTROL)`, and returns the binding.

**Call relations**: Used heavily throughout input handling and tests for Ctrl-key normalization.

*Call graph*: calls 1 internal fn (new); called by 16 (on_ctrl_c, new_with_config, base_footer_mode_tracks_empty_state_after_quit_hint_expires, default_bindings, footer_snapshots, footer_status_line_truncates_to_keep_mode_indicator, paste_image_shortcut_prefers_ctrl_alt_v_under_wsl, handle_key_event, on_ctrl_c, on_ctrl_d (+6 more)).


##### `ctrl_alt`  (lines 168–170)

```
fn ctrl_alt(key: KeyCode) -> KeyBinding
```

**Purpose**: Convenience constructor for a Control+Alt-modified key binding.

**Data flow**: Accepts a `KeyCode`, calls `KeyBinding::new(key, KeyModifiers::CONTROL.union(KeyModifiers::ALT))`, and returns the binding.

**Call relations**: Used where the TUI needs an explicit Ctrl+Alt shortcut, such as paste-image handling under WSL.

*Call graph*: calls 1 internal fn (new); called by 1 (paste_image_shortcut_prefers_ctrl_alt_v_under_wsl).


##### `modifiers_to_string`  (lines 172–184)

```
fn modifiers_to_string(modifiers: KeyModifiers) -> String
```

**Purpose**: Formats a modifier set into the ordered textual prefix used by key-hint labels.

**Data flow**: Builds a `String`, appends `CTRL_PREFIX` if control is present, `SHIFT_PREFIX` if shift is present, and `ALT_PREFIX` if alt is present, then returns the result.

**Call relations**: Used only by `KeyBinding::display_label`.

*Call graph*: called by 1 (display_label); 2 external calls (contains, new).


##### `Span::from`  (lines 192–194)

```
fn from(binding: &KeyBinding) -> Self
```

**Purpose**: Converts a `KeyBinding` reference into a dimmed `ratatui::text::Span` suitable for footer and hint rendering.

**Data flow**: Calls `binding.display_label()` to get the text, `key_hint_style()` to get the style, and returns `Span::styled(...)`.

**Call relations**: Used implicitly wherever key bindings are rendered into UI spans.

*Call graph*: calls 2 internal fn (display_label, key_hint_style); 1 external calls (styled).


##### `key_hint_style`  (lines 197–199)

```
fn key_hint_style() -> Style
```

**Purpose**: Defines the shared visual style for rendered key-hint spans.

**Data flow**: Returns `Style::default().dim()`.

**Call relations**: Used by the `Span` conversion impl so all key hints share the same subdued appearance.

*Call graph*: called by 1 (from); 1 external calls (default).


##### `has_ctrl_or_alt`  (lines 201–203)

```
fn has_ctrl_or_alt(mods: KeyModifiers) -> bool
```

**Purpose**: Reports whether a modifier set contains a real Ctrl or Alt command modifier, excluding AltGr on Windows.

**Data flow**: Checks whether modifiers contain `CONTROL` or `ALT`, then suppresses the result if `is_altgr(mods)` is true. Returns `bool`.

**Call relations**: Used by input-handling code to distinguish command chords from plain text entry.

*Call graph*: calls 1 internal fn (is_altgr); called by 4 (handle_key_event, handle_input_basic_with_time, handle_history_search_key, handle_key_event_at); 1 external calls (contains).


##### `is_altgr`  (lines 213–215)

```
fn is_altgr(_mods: KeyModifiers) -> bool
```

**Purpose**: Detects the AltGr modifier combination on Windows and always returns false elsewhere.

**Data flow**: On Windows, returns true when both `ALT` and `CONTROL` are present; on non-Windows, ignores the input and returns false.

**Call relations**: Called by `has_ctrl_or_alt` and some input code to avoid misclassifying AltGr text entry as a command chord.

*Call graph*: called by 2 (input_with_keymap, has_ctrl_or_alt); 1 external calls (contains).


##### `tests::is_press_accepts_press_and_repeat_but_rejects_release`  (lines 222–239)

```
fn is_press_accepts_press_and_repeat_but_rejects_release()
```

**Purpose**: Verifies that binding matching accepts `Press` and `Repeat` events but rejects `Release` and wrong modifiers.

**Data flow**: Builds a `ctrl-k` binding and several `KeyEvent` variants, calls `is_press` on each, and asserts the expected booleans.

**Call relations**: Direct unit test of `KeyBinding::is_press` event-kind filtering.

*Call graph*: calls 1 internal fn (ctrl); 3 external calls (Char, new, assert!).


##### `tests::keybinding_list_ext_matches_any_binding`  (lines 242–248)

```
fn keybinding_list_ext_matches_any_binding()
```

**Purpose**: Checks that slice matching succeeds when any one binding matches and fails otherwise.

**Data flow**: Builds a two-binding array, calls `.is_pressed(...)` with matching and non-matching events, and asserts the expected results.

**Call relations**: Tests the `KeyBindingListExt` implementation over slices.

*Call graph*: calls 2 internal fn (ctrl, plain); 2 external calls (Char, assert!).


##### `tests::shifted_letter_binding_matches_uppercase_char_events`  (lines 251–257)

```
fn shifted_letter_binding_matches_uppercase_char_events()
```

**Purpose**: Verifies uppercase compatibility for shifted letter bindings.

**Data flow**: Builds `shift-a`, tests it against `Shift+a`, plain uppercase `A`, and uppercase `A` with explicit shift, and asserts all match.

**Call relations**: Exercises the uppercase normalization branch in `normalize_key_parts`.

*Call graph*: calls 1 internal fn (shift); 2 external calls (Char, assert!).


##### `tests::shift_letter_binding_preserves_other_modifiers_with_uppercase_compat`  (lines 260–267)

```
fn shift_letter_binding_preserves_other_modifiers_with_uppercase_compat()
```

**Purpose**: Checks that uppercase normalization preserves non-shift modifiers such as Control.

**Data flow**: Builds a binding for `Ctrl+Shift+i`, tests it against an event reporting uppercase `I` with only `CONTROL`, and asserts it matches.

**Call relations**: Covers the interaction between uppercase normalization and additional modifiers.

*Call graph*: calls 1 internal fn (new); 2 external calls (Char, assert!).


##### `tests::shift_letter_binding_does_not_match_plain_lowercase_or_other_uppercase`  (lines 270–275)

```
fn shift_letter_binding_does_not_match_plain_lowercase_or_other_uppercase()
```

**Purpose**: Verifies that shifted-letter compatibility does not over-match unrelated events.

**Data flow**: Builds `shift-o`, tests it against plain lowercase `o` and uppercase `P`, and asserts both fail.

**Call relations**: Complements the uppercase-compatibility tests with negative cases.

*Call graph*: calls 1 internal fn (shift); 2 external calls (Char, assert!).


##### `tests::ctrl_letter_binding_matches_c0_control_char_events`  (lines 278–283)

```
fn ctrl_letter_binding_matches_c0_control_char_events()
```

**Purpose**: Checks that a Ctrl-letter binding matches the corresponding raw C0 control character only when no extra modifiers are present.

**Data flow**: Builds `ctrl-p`, tests it against raw `\u{0010}` with no modifiers and with `ALT`, and asserts only the unmodified event matches.

**Call relations**: Exercises the C0-control normalization path and its modifier guard.

*Call graph*: calls 1 internal fn (ctrl); 2 external calls (Char, assert!).


##### `tests::ctrl_bindings_match_all_supported_c0_control_char_events`  (lines 286–333)

```
fn ctrl_bindings_match_all_supported_c0_control_char_events()
```

**Purpose**: Exhaustively verifies the supported raw C0-to-Ctrl mappings for letters, space, and digits 4–7.

**Data flow**: Iterates a table of `(ctrl_char, c0_char)` pairs, asserts `ctrl(ctrl_char)` matches a no-modifier event carrying `c0_char`, and asserts the same raw char with `ALT` does not match.

**Call relations**: Broad regression coverage for `c0_control_char_to_ctrl_char` and `normalize_key_parts`.

*Call graph*: 1 external calls (assert!).


##### `tests::ctrl_binding_does_not_match_ambiguous_c0_escape_or_delete`  (lines 336–345)

```
fn ctrl_binding_does_not_match_ambiguous_c0_escape_or_delete()
```

**Purpose**: Verifies that ambiguous raw ESC and DEL characters are not normalized into Ctrl bindings.

**Data flow**: Tests `ctrl('[')` against raw ESC and `ctrl('?')` against raw DEL, asserting both fail.

**Call relations**: Covers intentionally unsupported control-character cases.

*Call graph*: 1 external calls (assert!).


##### `tests::history_search_ctrl_bindings_match_c0_control_char_events`  (lines 348–357)

```
fn history_search_ctrl_bindings_match_c0_control_char_events()
```

**Purpose**: Checks the specific Ctrl-R and Ctrl-S bindings used by history search against raw C0 events.

**Data flow**: Tests `ctrl('r')` against `\u{0012}` and `ctrl('s')` against `\u{0013}`, asserting both match.

**Call relations**: A focused regression test for history-search shortcuts built on the general C0 normalization logic.

*Call graph*: 1 external calls (assert!).


##### `tests::ctrl_alt_sets_both_modifiers`  (lines 360–368)

```
fn ctrl_alt_sets_both_modifiers()
```

**Purpose**: Verifies that the `ctrl_alt` constructor produces a binding with both modifier bits set.

**Data flow**: Constructs `ctrl_alt('v')`, calls `.parts()`, and asserts the tuple equals `(Char('v'), CONTROL | ALT)`.

**Call relations**: Direct unit test of the convenience constructor.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::has_ctrl_or_alt_checks_supported_modifier_combinations`  (lines 371–380)

```
fn has_ctrl_or_alt_checks_supported_modifier_combinations()
```

**Purpose**: Checks `has_ctrl_or_alt` across none, Ctrl, Alt, and Ctrl+Alt combinations, including the Windows AltGr exception.

**Data flow**: Calls `has_ctrl_or_alt` with several modifier sets and asserts expected booleans, with platform-conditional expectations for `CONTROL | ALT`.

**Call relations**: Tests the helper used by input handling to distinguish command modifiers from text-entry modifiers.

*Call graph*: 1 external calls (assert!).


### `tui/src/bottom_pane/action_required_title.rs`

`util` · `cross-cutting UI title rendering`

This file contains one constant prefix and one generic formatter function for terminal title text. `ACTION_REQUIRED_PREVIEW_PREFIX` provides the standard leading label, and `build_action_required_title_text` assembles the final title from a caller-supplied prefix plus a sequence of `TerminalTitleItem` values. The function starts with the prefix as the first segment, then iterates the provided items in order. It deliberately skips the spinner item and any item present in the `excluded_items` slice, so transient activity indicators or caller-suppressed fields never appear in the action-required title. For each remaining item, it invokes the `value_for` callback; only `Some(String)` results are appended, which lets callers omit items whose current value is unavailable or empty without special-casing the loop. The final output is `parts.join(" | ")`, preserving item order and producing a stable, human-readable title line. The function is generic over both the item source and the value lookup closure, so it can be reused by different title-building paths without owning the source collection type.

#### Function details

##### `build_action_required_title_text`  (lines 5–25)

```
fn build_action_required_title_text(
    prefix: &str,
    items: I,
    excluded_items: &[TerminalTitleItem],
    mut value_for: F,
) -> String
```

**Purpose**: Constructs a pipe-separated terminal title string from a prefix and a sequence of `TerminalTitleItem` values. It omits the spinner and any explicitly excluded items, and only includes items whose callback returns a string.

**Data flow**: Takes a `prefix: &str`, an `IntoIterator<Item = TerminalTitleItem>`, an exclusion slice, and a mutable `FnMut` that maps each item to `Option<String>` → seeds a `Vec<String>` with `prefix.to_string()` → filters out `TerminalTitleItem::Spinner` and excluded items via `contains` → pushes callback-produced strings for remaining items → returns the joined string with `" | "` separators.

**Call relations**: This helper is called by higher-level terminal-title composition code when the UI needs an action-required title. It does not delegate to project-local functions; its main role is to centralize the filtering and formatting policy so callers only provide item order and value lookup.

*Call graph*: 2 external calls (contains, vec!).


### `tui/src/bottom_pane/footer.rs`

`domain_logic` · `cross-cutting rendering during composer display`

This module is the footer formatting engine for the bottom pane. Its central input is `FooterProps`, which carries the current `FooterMode`, hint flags, task-running state, status-line content, active agent label, and a `FooterKeyHints` bundle of resolved key bindings. The file deliberately separates policy from rendering: higher-level widgets choose the mode, while this module computes lines, widths, and fallback layouts.

The most important logic is `single_line_footer_layout`. It decides whether the left-side instructional hint and right-side contextual indicator can coexist, and if not, which pieces to drop first. Queue hints are preserved more aggressively than shortcut hints; collaboration mode labels may keep or lose the `(shift+tab to cycle)` suffix depending on width; and when the cycle hint cannot fit, the right-side context may also be suppressed to avoid unstable transitions. Supporting helpers such as `right_aligned_x`, `max_left_width_for_right`, and `can_show_left_with_context` compute exact geometry.

Rendering is split between `render_footer_line` for a precomputed single line and `render_footer_from_props` for the canonical mode-to-lines mapping from `footer_from_props_lines`. That mapping covers passive contextual rows, quit reminders, reverse-i-search, shortcut overlays, Esc hints, and draft/empty composer states. The module also defines the shortcut overlay data model (`ShortcutDescriptor`, `ShortcutBinding`, `DisplayCondition`) and the static `SHORTCUTS` table, which adapts entries based on WSL, collaboration modes, shift-enter behavior, and task-running state. Extensive tests snapshot width-collapse behavior, status-line truncation, and shortcut selection.

#### Function details

##### `FooterKeyHints::default_bindings`  (lines 126–138)

```
fn default_bindings() -> Self
```

**Purpose**: Provides a test-only bundle of standard footer key bindings.

**Data flow**: Constructs a `FooterKeyHints` with concrete `KeyBinding` values for shortcuts toggle, queue, newline, external editor, edit previous, transcript, history search, and reasoning controls → returns the struct.

**Call relations**: Used only in tests to build realistic `FooterProps` without depending on runtime keymap loading.

*Call graph*: calls 3 internal fn (alt, ctrl, plain); called by 3 (footer_snapshots, footer_status_line_truncates_to_keep_mode_indicator, paste_image_shortcut_prefers_ctrl_alt_v_under_wsl); 1 external calls (Char).


##### `CollaborationModeIndicator::label`  (lines 142–155)

```
fn label(self, show_cycle_hint: bool) -> String
```

**Purpose**: Builds the plain-text label for a collaboration mode, optionally appending the cycle hint suffix.

**Data flow**: Consumes `self` and `show_cycle_hint` → computes `suffix` as either empty or `" (shift+tab to cycle)"`, matches the enum variant, and returns the formatted `String`.

**Call relations**: Called by `styled_span` so styling and text generation stay coupled.

*Call graph*: called by 1 (styled_span); 2 external calls (new, format!).


##### `CollaborationModeIndicator::styled_span`  (lines 157–164)

```
fn styled_span(self, show_cycle_hint: bool) -> Span<'static>
```

**Purpose**: Converts a collaboration mode indicator into a colored/styled span suitable for footer rendering.

**Data flow**: Consumes `self` and `show_cycle_hint`, gets the label string from `label`, wraps it in `Span::from`, and applies variant-specific styling (`magenta`, `cyan`, or `dim`) → returns `Span<'static>`.

**Call relations**: Used anywhere the mode indicator is inserted into a footer line, including left-side summary lines and right-side status indicators.

*Call graph*: calls 1 internal fn (label); 1 external calls (from).


##### `toggle_shortcut_mode`  (lines 190–209)

```
fn toggle_shortcut_mode(
    current: FooterMode,
    ctrl_c_hint: bool,
    is_empty: bool,
) -> FooterMode
```

**Purpose**: Toggles between the shortcut overlay and the appropriate base footer mode, while preserving the quit reminder if that transient hint is active.

**Data flow**: Consumes `current`, `ctrl_c_hint`, and `is_empty` → if `ctrl_c_hint` is true and the current mode is `QuitShortcutReminder`, returns the current mode unchanged; otherwise computes the base mode (`ComposerEmpty` or `ComposerHasDraft`) and toggles between that base mode and `ShortcutOverlay`.

**Call relations**: Called by higher-level key handling when the user presses the shortcuts toggle key.

*Call graph*: called by 1 (handle_shortcut_overlay_key); 1 external calls (matches!).


##### `esc_hint_mode`  (lines 211–217)

```
fn esc_hint_mode(current: FooterMode, is_task_running: bool) -> FooterMode
```

**Purpose**: Chooses whether pressing Esc should switch the footer into the Esc hint state. Running tasks suppress this transition.

**Data flow**: Consumes `current` and `is_task_running` → returns `current` unchanged when a task is running, otherwise returns `FooterMode::EscHint`.

**Call relations**: Used by composer key handling paths that prime or show the Esc hint.

*Call graph*: called by 4 (handle_key_event_with_file_popup, handle_key_event_without_popup, set_esc_backtrack_hint, handle_key_event_with_slash_popup).


##### `reset_mode_after_activity`  (lines 219–228)

```
fn reset_mode_after_activity(current: FooterMode) -> FooterMode
```

**Purpose**: Collapses transient footer modes back to the normal idle base mode after user activity. Draft mode also resets to empty mode here.

**Data flow**: Consumes `current` → maps `EscHint`, `ShortcutOverlay`, `QuitShortcutReminder`, `HistorySearch`, and `ComposerHasDraft` to `ComposerEmpty`; leaves other modes unchanged.

**Call relations**: Called by multiple higher-level activity handlers to clear transient instructional states.

*Call graph*: called by 11 (clear_quit_shortcut_hint, handle_input_basic_with_time, handle_key_event_with_file_popup, handle_key_event_with_mentions_v2_popup, handle_key_event_with_skill_popup, handle_key_event_without_popup, set_esc_backtrack_hint, set_vim_enabled, cancel_history_search, handle_history_search_key (+1 more)).


##### `footer_height`  (lines 230–255)

```
fn footer_height(props: &FooterProps) -> u16
```

**Purpose**: Computes how many lines the footer needs for the current props, including multi-line shortcut overlays.

**Data flow**: Reads `props.mode` and `props.is_task_running` to derive `show_shortcuts_hint` and `show_queue_hint`, then calls `footer_from_props_lines(...)` and returns the resulting line count as `u16`.

**Call relations**: Used by rendering/layout code and tests before allocating footer space.

*Call graph*: calls 1 internal fn (footer_from_props_lines); called by 4 (snapshot_composer_state_with_width, render_footer_with_mode_indicator_and_context, snapshot_footer_with_indicators, snapshot_footer_with_mode_indicator_and_context).


##### `render_footer_line`  (lines 258–265)

```
fn render_footer_line(area: Rect, buf: &mut Buffer, line: Line<'static>)
```

**Purpose**: Renders a single already-chosen footer line with the standard left indentation applied.

**Data flow**: Consumes `area`, `buf`, and `line` → prefixes the line using `prefix_lines` with `FOOTER_INDENT_COLS` spaces on both first and subsequent lines, wraps it in a `Paragraph`, and renders it into `buf`.

**Call relations**: Used when width-collapse logic has already selected a specific single-line footer variant.

*Call graph*: calls 1 internal fn (prefix_lines); called by 1 (render_with_mask_and_textarea_right_reserve); 2 external calls (new, vec!).


##### `render_footer_from_props`  (lines 274–295)

```
fn render_footer_from_props(
    area: Rect,
    buf: &mut Buffer,
    props: &FooterProps,
    collaboration_mode_indicator: Option<CollaborationModeIndicator>,
    show_cycle_hint: bool,
    show_sh
```

**Purpose**: Renders footer content directly from `FooterProps` and explicit hint flags, without applying single-line collapse decisions.

**Data flow**: Consumes `area`, `buf`, `props`, optional collaboration mode indicator, and booleans controlling cycle/shortcut/queue hints → builds the footer lines via `footer_from_props_lines`, prefixes them with the standard indentation, wraps them in a `Paragraph`, and renders them.

**Call relations**: Used by callers when they want the canonical mode-to-lines mapping, or when `single_line_footer_layout` returns `SummaryLeft::Default`.

*Call graph*: calls 2 internal fn (footer_from_props_lines, prefix_lines); called by 1 (render_with_mask_and_textarea_right_reserve); 1 external calls (new).


##### `left_fits`  (lines 297–300)

```
fn left_fits(area: Rect, left_width: u16) -> bool
```

**Purpose**: Checks whether a left-side footer fragment can fit within the footer area when rendered alone.

**Data flow**: Consumes `area` and `left_width` → subtracts the standard footer indent from `area.width` and returns whether `left_width <= max_width`.

**Call relations**: Used by `single_line_footer_layout` during fallback selection.

*Call graph*: called by 1 (single_line_footer_layout).


##### `left_side_line`  (lines 316–352)

```
fn left_side_line(
    collaboration_mode_indicator: Option<CollaborationModeIndicator>,
    state: LeftSideState,
    key_hints: FooterKeyHints,
) -> Line<'static>
```

**Purpose**: Builds the left-side single-line footer content from a summary hint state and optional collaboration mode indicator.

**Data flow**: Consumes optional `collaboration_mode_indicator`, `LeftSideState`, and `FooterKeyHints` → starts with an empty `Line`, appends shortcut or queue hint spans depending on `state.hint`, inserts a dim separator when both hint and mode are present, and appends the styled mode span when requested → returns the composed line.

**Call relations**: This is the primitive line builder used heavily by `single_line_footer_layout` and indirectly by `footer_from_props_lines` for base composer states.

*Call graph*: called by 1 (single_line_footer_layout); 2 external calls (from, matches!).


##### `single_line_footer_layout`  (lines 362–531)

```
fn single_line_footer_layout(
    area: Rect,
    context_width: u16,
    collaboration_mode_indicator: Option<CollaborationModeIndicator>,
    show_cycle_hint: bool,
    show_shortcuts_hint: bool,
```

**Purpose**: Chooses the best-fitting single-line footer variant and whether the right-side context can remain visible. It encodes the module’s width-collapse policy.

**Data flow**: Consumes `area`, `context_width`, optional collaboration mode indicator, booleans for cycle/shortcut/queue hints, and `key_hints` → builds the default left-side line and width, checks whether it fits with context, then explores fallback states in a priority order: queue variants first when queueing is active, cycle-hint and mode-only variants when collaboration mode is present, and finally no-left-content fallback → returns `(SummaryLeft, show_context)`.

**Call relations**: Called by higher-level footer rendering code before deciding whether to use `render_footer_line`, `render_footer_from_props`, and `render_context_right`.

*Call graph*: calls 3 internal fn (can_show_left_with_context, left_fits, left_side_line); called by 1 (render_with_mask_and_textarea_right_reserve); 1 external calls (Custom).


##### `mode_indicator_line`  (lines 533–538)

```
fn mode_indicator_line(
    indicator: Option<CollaborationModeIndicator>,
    show_cycle_hint: bool,
) -> Option<Line<'static>>
```

**Purpose**: Wraps an optional collaboration mode indicator into a one-line footer line.

**Data flow**: Consumes `indicator` and `show_cycle_hint` → maps the indicator to `Line::from(vec![indicator.styled_span(show_cycle_hint)])` or returns `None`.

**Call relations**: Used by `status_line_right_indicator_line` when building the right-side contextual indicator.

*Call graph*: called by 1 (status_line_right_indicator_line).


##### `goal_status_indicator_line`  (lines 540–572)

```
fn goal_status_indicator_line(
    indicator: Option<&GoalStatusIndicator>,
) -> Option<Line<'static>>
```

**Purpose**: Formats a goal-status indicator into a magenta footer line, including optional usage text where applicable.

**Data flow**: Consumes `Option<&GoalStatusIndicator>` → returns `None` if absent; otherwise matches the variant, builds the exact label string, wraps it in a magenta `Span`, and returns `Some(Line)`.

**Call relations**: Used by `status_line_right_indicator_line` as a fallback when no collaboration mode indicator is present.

*Call graph*: 3 external calls (from, format!, vec!).


##### `status_line_right_indicator_line`  (lines 574–600)

```
fn status_line_right_indicator_line(
    collaboration_mode_indicator: Option<CollaborationModeIndicator>,
    goal_status_indicator: Option<&GoalStatusIndicator>,
    ide_context_active: bool,
    sh
```

**Purpose**: Builds the right-side contextual indicator line shown alongside a passive status line. It can combine a primary indicator and an IDE-context marker with a separator.

**Data flow**: Consumes optional collaboration mode indicator, optional goal status, `ide_context_active`, and `show_cycle_hint` → chooses a primary line from `mode_indicator_line(...).or_else(goal_status_indicator_line)`, optionally creates an `IDE context` cyan line, then merges the present indicators into one `Line` separated by dim ` · ` spans → returns `Option<Line<'static>>`.

**Call relations**: Used by higher-level footer rendering when the passive status-line layout is active.

*Call graph*: calls 1 internal fn (mode_indicator_line); called by 1 (mode_indicator_line).


##### `side_conversation_context_line`  (lines 602–608)

```
fn side_conversation_context_line(label: &str) -> Line<'static>
```

**Purpose**: Formats the active side-conversation label for contextual footer display, with special styling for labels beginning with `Side `.

**Data flow**: Consumes `label: &str` → if it starts with `Side `, splits the prefix and rest so `Side` can be bold magenta and the remainder magenta; otherwise returns the whole label as a magenta line.

**Call relations**: Used by higher-level footer rendering when showing side-conversation context.

*Call graph*: called by 1 (render_with_mask_and_textarea_right_reserve); 2 external calls (from, vec!).


##### `right_aligned_x`  (lines 610–631)

```
fn right_aligned_x(area: Rect, content_width: u16) -> Option<u16>
```

**Purpose**: Computes the x-coordinate where right-aligned footer content should start, respecting the standard right padding.

**Data flow**: Consumes `area` and `content_width` → returns `None` for empty areas or zero-width content; otherwise subtracts `FOOTER_INDENT_COLS` right padding and either pins to the padded left edge when content is too wide or computes the right-aligned start position.

**Call relations**: Shared geometry helper used by `max_left_width_for_right`, `can_show_left_with_context`, and `render_context_right`.

*Call graph*: called by 3 (can_show_left_with_context, max_left_width_for_right, render_context_right); 1 external calls (is_empty).


##### `max_left_width_for_right`  (lines 633–645)

```
fn max_left_width_for_right(area: Rect, right_width: u16) -> Option<u16>
```

**Purpose**: Calculates the maximum left-side width that can coexist with a right-side indicator while preserving the minimum gap.

**Data flow**: Consumes `area` and `right_width` → computes the right indicator’s start x via `right_aligned_x`, derives the left start from the footer indent, subtracts the mandatory one-column gap, and returns the remaining width or zero when the right side crowds the left edge.

**Call relations**: Used by higher-level rendering to truncate passive status lines so the right-side indicator remains visible.

*Call graph*: calls 1 internal fn (right_aligned_x); called by 1 (render_with_mask_and_textarea_right_reserve).


##### `can_show_left_with_context`  (lines 647–656)

```
fn can_show_left_with_context(area: Rect, left_width: u16, context_width: u16) -> bool
```

**Purpose**: Checks whether left-side content of a given width can be shown alongside right-side context without overlap.

**Data flow**: Consumes `area`, `left_width`, and `context_width` → if the right side cannot be positioned, returns true; if `left_width` is zero, returns true; otherwise computes the left extent including indent and gap and compares it to the right-side start position.

**Call relations**: Core fit predicate used by both `single_line_footer_layout` and higher-level rendering/truncation logic.

*Call graph*: calls 1 internal fn (right_aligned_x); called by 2 (render_with_mask_and_textarea_right_reserve, single_line_footer_layout).


##### `render_context_right`  (lines 658–683)

```
fn render_context_right(area: Rect, buf: &mut Buffer, line: &Line<'static>)
```

**Purpose**: Draws a right-aligned footer line directly into the buffer span-by-span.

**Data flow**: Consumes `area`, `buf`, and `line` → early-returns on empty area or missing alignment position; computes the bottom-row y coordinate, then iterates spans, clipping each span to the remaining width and writing it with `buf.set_span` → mutates the buffer only.

**Call relations**: Used by higher-level footer rendering after the left-side content has been chosen.

*Call graph*: calls 1 internal fn (right_aligned_x); called by 1 (render_with_mask_and_textarea_right_reserve); 3 external calls (set_span, width, is_empty).


##### `inset_footer_hint_area`  (lines 685–691)

```
fn inset_footer_hint_area(mut area: Rect) -> Rect
```

**Purpose**: Applies the standard two-column left inset used for footer hint items.

**Data flow**: Consumes `area`, and if `area.width > 2`, increments `x` by 2 and shrinks `width` by 2 → returns the adjusted `Rect`.

**Call relations**: Used by `render_footer_hint_items` and by higher-level rendering code that places footer hint rows.

*Call graph*: called by 2 (render_with_mask_and_textarea_right_reserve, render_footer_hint_items).


##### `render_footer_hint_items`  (lines 693–699)

```
fn render_footer_hint_items(area: Rect, buf: &mut Buffer, items: &[(String, String)])
```

**Purpose**: Renders a compact key/label hint row when there are footer hint items to show.

**Data flow**: Consumes `area`, `buf`, and `items` → returns immediately if `items` is empty; otherwise builds a line with `footer_hint_items_line(items)`, insets the area with `inset_footer_hint_area`, and renders the line into the buffer.

**Call relations**: Used by higher-level footer rendering for auxiliary hint rows.

*Call graph*: calls 2 internal fn (footer_hint_items_line, inset_footer_hint_area); called by 1 (render_with_mask_and_textarea_right_reserve).


##### `footer_from_props_lines`  (lines 709–773)

```
fn footer_from_props_lines(
    props: &FooterProps,
    collaboration_mode_indicator: Option<CollaborationModeIndicator>,
    show_cycle_hint: bool,
    show_shortcuts_hint: bool,
    show_queue_hint
```

**Purpose**: Maps `FooterProps` and explicit hint flags to the canonical footer lines, without width-based collapse. It is the authoritative mode-to-text formatter.

**Data flow**: Consumes `props`, optional collaboration mode indicator, and booleans for cycle/shortcut/queue hints → first returns `passive_footer_status_line(props)` when contextual footer content should replace instructions; otherwise matches `props.mode` and returns the appropriate line vector: quit reminder, reverse-i-search prompt, left-side summary line, shortcut overlay lines, Esc hint, or draft-state summary line.

**Call relations**: Called by `footer_height`, `footer_line_width`, and `render_footer_from_props`. It is the central formatting function for footer content.

*Call graph*: calls 2 internal fn (passive_footer_status_line, shortcut_overlay_lines); called by 3 (footer_height, footer_line_width, render_footer_from_props); 1 external calls (vec!).


##### `passive_footer_status_line`  (lines 780–801)

```
fn passive_footer_status_line(props: &FooterProps) -> Option<Line<'static>>
```

**Purpose**: Builds the contextual footer row shown when the footer is not occupied by an instructional hint. It can combine the configured status line and active agent label.

**Data flow**: Consumes `props` → returns `None` unless `shows_passive_footer_line(props)` is true; otherwise starts from `props.status_line_value` when enabled, then appends ` · ` and the dimmed `active_agent_label` if present, or uses the agent label alone when no status line exists → returns `Option<Line<'static>>`.

**Call relations**: Used by `footer_from_props_lines` and by higher-level rendering code that reserves a dedicated passive status-line layout.

*Call graph*: calls 1 internal fn (shows_passive_footer_line); called by 2 (render_with_mask_and_textarea_right_reserve, footer_from_props_lines); 1 external calls (from).


##### `shows_passive_footer_line`  (lines 807–816)

```
fn shows_passive_footer_line(props: &FooterProps) -> bool
```

**Purpose**: Determines whether the current footer mode allows contextual information to replace instructional hints.

**Data flow**: Consumes `props` → returns true for `ComposerEmpty`, true for `ComposerHasDraft` only when no task is running, and false for all transient instructional modes.

**Call relations**: Used by `passive_footer_status_line` and `uses_passive_footer_status_layout`.

*Call graph*: called by 2 (passive_footer_status_line, uses_passive_footer_status_layout).


##### `uses_passive_footer_status_layout`  (lines 823–825)

```
fn uses_passive_footer_status_layout(props: &FooterProps) -> bool
```

**Purpose**: Determines whether callers should use the dedicated passive status-line layout path.

**Data flow**: Consumes `props` → returns `props.status_line_enabled && shows_passive_footer_line(props)`.

**Call relations**: Used by higher-level footer rendering to decide whether to reserve/truncate a passive status line separately from the normal summary footer flow.

*Call graph*: calls 1 internal fn (shows_passive_footer_line); called by 1 (render_with_mask_and_textarea_right_reserve).


##### `footer_line_width`  (lines 827–844)

```
fn footer_line_width(
    props: &FooterProps,
    collaboration_mode_indicator: Option<CollaborationModeIndicator>,
    show_cycle_hint: bool,
    show_shortcuts_hint: bool,
    show_queue_hint: bool
```

**Purpose**: Measures the width of the last line produced by the canonical footer formatter.

**Data flow**: Consumes `props`, optional collaboration mode indicator, and hint flags → calls `footer_from_props_lines`, takes the last line if any, and returns its width as `u16`, defaulting to 0.

**Call relations**: Used by higher-level rendering to decide whether left and right footer content can coexist.

*Call graph*: calls 1 internal fn (footer_from_props_lines); called by 1 (render_with_mask_and_textarea_right_reserve).


##### `footer_hint_items_width`  (lines 846–851)

```
fn footer_hint_items_width(items: &[(String, String)]) -> u16
```

**Purpose**: Measures the width of a footer hint-items row.

**Data flow**: Consumes `items` → returns 0 when empty, otherwise builds the line with `footer_hint_items_line(items)` and returns its width as `u16`.

**Call relations**: Used by higher-level layout code before rendering footer hint items.

*Call graph*: calls 1 internal fn (footer_hint_items_line); called by 1 (render_with_mask_and_textarea_right_reserve).


##### `footer_hint_items_line`  (lines 853–864)

```
fn footer_hint_items_line(items: &[(String, String)]) -> Line<'static>
```

**Purpose**: Formats a sequence of `(key, label)` pairs into a single footer hint line with bold keys and spacing between items.

**Data flow**: Consumes `items` → allocates a spans vector sized for the expected pattern, then for each item pushes a leading space, bold key, plain label, and triple-space separator except after the last item → returns `Line::from(spans)`.

**Call relations**: Used by both `footer_hint_items_width` and `render_footer_hint_items`.

*Call graph*: called by 2 (footer_hint_items_width, render_footer_hint_items); 3 external calls (from, with_capacity, format!).


##### `quit_shortcut_reminder_line`  (lines 877–879)

```
fn quit_shortcut_reminder_line(key: KeyBinding) -> Line<'static>
```

**Purpose**: Builds the dimmed `key again to quit` reminder line.

**Data flow**: Consumes `key: KeyBinding` → creates `Line::from(vec![key.into(), " again to quit".into()]).dim()`.

**Call relations**: Used by `footer_from_props_lines` for `FooterMode::QuitShortcutReminder`.

*Call graph*: 2 external calls (from, vec!).


##### `esc_hint_line`  (lines 881–894)

```
fn esc_hint_line(esc_backtrack_hint: bool) -> Line<'static>
```

**Purpose**: Builds the Esc hint line, with different wording depending on whether the first Esc has already primed backtracking.

**Data flow**: Consumes `esc_backtrack_hint` → creates a plain Esc key binding and returns either `Esc again to edit previous message` or `Esc Esc to edit previous message`, dimmed.

**Call relations**: Used by `footer_from_props_lines` for `FooterMode::EscHint`.

*Call graph*: calls 1 internal fn (plain); 2 external calls (from, vec!).


##### `shortcut_overlay_lines`  (lines 896–959)

```
fn shortcut_overlay_lines(state: ShortcutsState) -> Vec<Line<'static>>
```

**Purpose**: Builds the multi-line shortcut overlay shown after pressing the shortcuts toggle key.

**Data flow**: Consumes `ShortcutsState` → initializes one `Line` slot per shortcut category, iterates the static `SHORTCUTS` descriptors, asks each for an optional overlay entry, stores each returned line in the slot matching its `ShortcutId`, orders the populated lines into a fixed sequence, optionally appends the change-mode line, always appends the transcript line, passes the list to `build_columns`, then adds a blank line and a final `/keymap` customization hint → returns `Vec<Line<'static>>`.

**Call relations**: Called by `footer_from_props_lines` when `FooterMode::ShortcutOverlay` is active.

*Call graph*: calls 1 internal fn (build_columns); called by 1 (footer_from_props_lines); 2 external calls (from, vec!).


##### `build_columns`  (lines 961–1006)

```
fn build_columns(entries: Vec<Line<'static>>) -> Vec<Line<'static>>
```

**Purpose**: Lays out shortcut overlay entries into two padded columns and dims the resulting lines.

**Data flow**: Consumes `entries: Vec<Line<'static>>` → returns empty when there are no entries; otherwise computes the number of rows needed for two columns, pads the entries vector with blank lines to a full rectangle, measures max width per column, adds per-column padding, then emits one combined line per row with inter-column spacing and dim styling.

**Call relations**: Used only by `shortcut_overlay_lines` to format the overlay body.

*Call graph*: called by 1 (shortcut_overlay_lines); 3 external calls (from, new, repeat_n).


##### `context_window_line`  (lines 1008–1020)

```
fn context_window_line(percent: Option<i64>, used_tokens: Option<i64>) -> Line<'static>
```

**Purpose**: Formats the right-side context usage indicator from either remaining-percent or used-token information.

**Data flow**: Consumes `percent: Option<i64>` and `used_tokens: Option<i64>` → if percent is present, clamps it to `0..=100` and returns `"{percent}% context left"`; else if used tokens are present, formats them compactly with `format_tokens_compact` and returns `"{used_fmt} used"`; otherwise defaults to `"100% context left"`, always dimmed.

**Call relations**: Used by higher-level footer rendering and many tests as the canonical right-side context line.

*Call graph*: called by 6 (right_footer_line_with_context, footer_snapshots, footer_status_line_truncates_to_keep_mode_indicator, snapshot_footer_with_context, snapshot_footer_with_indicators, snapshot_footer_with_mode_indicator); 3 external calls (from, format_tokens_compact, vec!).


##### `ShortcutBinding::matches`  (lines 1047–1049)

```
fn matches(&self, state: ShortcutsState) -> bool
```

**Purpose**: Checks whether a shortcut binding should be active under the current shortcut-overlay state.

**Data flow**: Consumes `self` and `state: ShortcutsState` → delegates to `self.condition.matches(state)` and returns the boolean.

**Call relations**: Used by `ShortcutDescriptor::binding_for` when selecting the appropriate binding variant.

*Call graph*: calls 1 internal fn (matches).


##### `DisplayCondition::matches`  (lines 1062–1070)

```
fn matches(self, state: ShortcutsState) -> bool
```

**Purpose**: Evaluates a display condition against the current shortcut-overlay state.

**Data flow**: Consumes `self` and `state` → returns true or false based on the condition variant and the corresponding state flags (`use_shift_enter_hint`, `is_wsl`, `collaboration_modes_enabled`).

**Call relations**: Called through `ShortcutBinding::matches` during shortcut binding selection.

*Call graph*: called by 1 (matches).


##### `ShortcutDescriptor::binding_for`  (lines 1081–1083)

```
fn binding_for(&self, state: ShortcutsState) -> Option<&'static ShortcutBinding>
```

**Purpose**: Finds the first binding variant for a shortcut descriptor whose display condition matches the current state.

**Data flow**: Consumes `self` and `state` → iterates `self.bindings`, returns the first `ShortcutBinding` whose `matches(state)` is true, or `None` if none apply.

**Call relations**: Used by `overlay_entry` for descriptors whose key comes from the static binding table rather than `FooterKeyHints`.

*Call graph*: called by 1 (overlay_entry); 1 external calls (iter).


##### `ShortcutDescriptor::overlay_entry`  (lines 1085–1132)

```
fn overlay_entry(&self, state: ShortcutsState) -> Option<Line<'static>>
```

**Purpose**: Builds one shortcut-overlay line for this descriptor if an applicable key binding exists in the current state.

**Data flow**: Consumes `self` and `state` → resolves the key either from `state.key_hints` or `binding_for(state)`, returns `None` if unavailable, otherwise builds a `Line` from `self.prefix` and the key, then appends descriptor-specific wording: queue text depends on running/queue state, edit-previous wording depends on `esc_backtrack_hint`, quit wording depends on `is_task_running`, and all other descriptors use `self.label` → returns `Some(Line)`.

**Call relations**: Called by `shortcut_overlay_lines` while populating the overlay entries.

*Call graph*: calls 1 internal fn (binding_for); 2 external calls (from, vec!).


##### `tests::snapshot_footer`  (lines 1289–1293)

```
fn snapshot_footer(name: &str, props: FooterProps)
```

**Purpose**: Test helper that snapshots a footer at width 80 with no collaboration mode indicator.

**Data flow**: Consumes `name` and `props` → forwards to `snapshot_footer_with_mode_indicator` with width 80 and `None` indicator.

**Call relations**: Used by the large footer snapshot test to reduce repetition.

*Call graph*: 1 external calls (snapshot_footer_with_mode_indicator).


##### `tests::snapshot_footer_with_context`  (lines 1295–1308)

```
fn snapshot_footer_with_context(
        name: &str,
        props: FooterProps,
        percent: Option<i64>,
        used_tokens: Option<i64>,
    )
```

**Purpose**: Test helper that snapshots a footer with a computed context-window line.

**Data flow**: Consumes `name`, `props`, `percent`, and `used_tokens` → builds the context line with `context_window_line` and forwards to `snapshot_footer_with_mode_indicator_and_context`.

**Call relations**: Used by tests that verify right-side context rendering.

*Call graph*: calls 1 internal fn (context_window_line); 1 external calls (snapshot_footer_with_mode_indicator_and_context).


##### `tests::draw_footer_frame`  (lines 1310–1479)

```
fn draw_footer_frame(
        terminal: &mut Terminal<B>,
        height: u16,
        props: &FooterProps,
        collaboration_mode_indicator: Option<CollaborationModeIndicator>,
        ide_contex
```

**Purpose**: Central test renderer that reproduces the production footer layout decisions inside a terminal frame.

**Data flow**: Consumes a terminal, height, footer props, optional collaboration mode indicator, IDE-context flag, and context line → inside `terminal.draw`, computes hint flags, passive status-line state, left/right widths, truncates passive status lines when needed, chooses between passive-status and summary-footer rendering paths, invokes `single_line_footer_layout`, `render_footer_line`, `render_footer_from_props`, and `render_context_right` as appropriate → writes the footer into the terminal buffer.

**Call relations**: Shared by all footer snapshot and rendering tests; it exercises the same helper functions that production code uses.

*Call graph*: calls 1 internal fn (draw).


##### `tests::snapshot_footer_with_mode_indicator`  (lines 1481–1494)

```
fn snapshot_footer_with_mode_indicator(
        name: &str,
        width: u16,
        props: &FooterProps,
        collaboration_mode_indicator: Option<CollaborationModeIndicator>,
    )
```

**Purpose**: Test helper that snapshots a footer with an optional collaboration mode indicator and default context line.

**Data flow**: Consumes `name`, `width`, `props`, and `collaboration_mode_indicator` → builds the default context line with `context_window_line(None, None)` and forwards to `snapshot_footer_with_mode_indicator_and_context`.

**Call relations**: Used by tests focused on mode-indicator width behavior.

*Call graph*: calls 1 internal fn (context_window_line); 1 external calls (snapshot_footer_with_mode_indicator_and_context).


##### `tests::snapshot_footer_with_mode_indicator_and_context`  (lines 1496–1514)

```
fn snapshot_footer_with_mode_indicator_and_context(
        name: &str,
        width: u16,
        props: &FooterProps,
        collaboration_mode_indicator: Option<CollaborationModeIndicator>,
```

**Purpose**: Renders a footer into a `TestBackend` terminal and snapshots the result.

**Data flow**: Consumes `name`, `width`, `props`, optional mode indicator, and `context_line` → computes height from `footer_height`, creates a `Terminal<TestBackend>`, calls `draw_footer_frame`, and snapshot-asserts the backend contents.

**Call relations**: Core snapshot helper for most footer rendering tests.

*Call graph*: calls 1 internal fn (footer_height); 4 external calls (new, assert_snapshot!, draw_footer_frame, new).


##### `tests::render_footer_with_mode_indicator_and_context`  (lines 1516–1533)

```
fn render_footer_with_mode_indicator_and_context(
        width: u16,
        props: &FooterProps,
        collaboration_mode_indicator: Option<CollaborationModeIndicator>,
        context_line: Line<
```

**Purpose**: Renders a footer into a VT100-backed terminal and returns the screen contents as a string.

**Data flow**: Consumes `width`, `props`, optional mode indicator, and `context_line` → computes height, creates a `Terminal<VT100Backend>`, calls `draw_footer_frame`, and returns the terminal screen contents.

**Call relations**: Used by tests that need string inspection rather than snapshots.

*Call graph*: calls 2 internal fn (footer_height, new); 2 external calls (draw_footer_frame, new).


##### `tests::snapshot_footer_with_indicators`  (lines 1535–1553)

```
fn snapshot_footer_with_indicators(
        name: &str,
        width: u16,
        props: &FooterProps,
        collaboration_mode_indicator: Option<CollaborationModeIndicator>,
        ide_context_a
```

**Purpose**: Snapshots a footer with collaboration-mode and IDE-context indicators enabled as requested.

**Data flow**: Consumes `name`, `width`, `props`, optional mode indicator, and `ide_context_active` → computes height, renders via `draw_footer_frame`, and snapshot-asserts the backend.

**Call relations**: Used by tests covering right-side indicator combinations.

*Call graph*: calls 2 internal fn (context_window_line, footer_height); 4 external calls (new, assert_snapshot!, draw_footer_frame, new).


##### `tests::footer_snapshots`  (lines 1556–2000)

```
fn footer_snapshots()
```

**Purpose**: Comprehensive snapshot suite covering the major footer modes, width behaviors, status-line interactions, and contextual combinations.

**Data flow**: Constructs many `FooterProps` variants using `FooterKeyHints::default_bindings`, helper context lines, and optional mode indicators, then snapshots each rendered footer state.

**Call relations**: Acts as the broad regression suite for this module’s rendering policy.

*Call graph*: calls 4 internal fn (default_bindings, context_window_line, ctrl, shift); 7 external calls (Char, from, snapshot_footer, snapshot_footer_with_context, snapshot_footer_with_indicators, snapshot_footer_with_mode_indicator, snapshot_footer_with_mode_indicator_and_context).


##### `tests::footer_status_line_truncates_to_keep_mode_indicator`  (lines 2003–2041)

```
fn footer_status_line_truncates_to_keep_mode_indicator()
```

**Purpose**: Verifies that a long passive status line is truncated with an ellipsis so the collaboration mode indicator remains visible.

**Data flow**: Builds props with a long status line and a mode indicator, renders the footer to a string, normalizes whitespace, and asserts that `Plan mode` remains visible, the cycle hint is dropped, and an ellipsis appears.

**Call relations**: Regression-tests the interaction between passive status-line truncation and right-side indicator preservation.

*Call graph*: calls 3 internal fn (default_bindings, context_window_line, ctrl); 4 external calls (Char, from, assert!, render_footer_with_mode_indicator_and_context).


##### `tests::paste_image_shortcut_prefers_ctrl_alt_v_under_wsl`  (lines 2044–2081)

```
fn paste_image_shortcut_prefers_ctrl_alt_v_under_wsl()
```

**Purpose**: Verifies that the paste-image shortcut chooses Ctrl+Alt+V under WSL and Ctrl+V otherwise.

**Data flow**: Finds the `PasteImage` descriptor in `SHORTCUTS`, determines whether the current platform is probably WSL, computes the expected key, resolves the actual binding via `binding_for`, and asserts equality.

**Call relations**: Tests the `DisplayCondition::WhenUnderWSL` branch and binding selection logic.

*Call graph*: calls 4 internal fn (default_bindings, is_probably_wsl, ctrl, ctrl_alt); 2 external calls (Char, assert_eq!).


### Popup and selection view helpers
These files provide the reusable state, constants, row models, tabs, and numbered-row helpers used by lightweight selection-style bottom-pane views.

### `tui/src/bottom_pane/popup_consts.rs`

`util` · `rendering`

This small utility module defines one shared constant and three helper functions used across popup-style bottom-pane views. `MAX_POPUP_ROWS` is the global cap on how many rows a popup should try to display, giving different popups a uniform visual footprint. The remaining functions all build `ratatui::text::Line<'static>` values for footer hints.

`standard_popup_hint_line` hardcodes the default Enter/Esc wording by composing spans from `key_hint::plain(KeyCode::Enter)` and `key_hint::plain(KeyCode::Esc)`. `standard_popup_hint_line_for_keymap` adapts that same idea to a caller-provided `ListKeymap`: it extracts the primary accept and cancel bindings with `primary_binding` and forwards them to the generic formatter. `accept_cancel_hint_line` is the underlying formatter; it accepts optional `KeyBinding` values and caller-supplied labels for the accept and cancel actions, then chooses among four output shapes: both bindings present, only accept present, only cancel present, or neither present (empty line). The design keeps popup widgets from duplicating string assembly logic and ensures remapped keybindings appear consistently in footer text.

#### Function details

##### `standard_popup_hint_line`  (lines 16–24)

```
fn standard_popup_hint_line() -> Line<'static>
```

**Purpose**: Builds the default popup footer hint using Enter to confirm and Esc to go back. It is the fixed-key convenience helper for popups that do not need runtime keymap awareness.

**Data flow**: Creates a `Line<'static>` from a vector of spans containing literal text plus `key_hint::plain(KeyCode::Enter)` and `key_hint::plain(KeyCode::Esc)` converted into spans, then returns that line.

**Call relations**: Used directly by many popup renderers and setup helpers that want the standard fixed Enter/Esc wording.

*Call graph*: called by 18 (show_replace_thread_goal_confirmation, apply_standard_popup_hint, render, render, feedback_disabled_params, feedback_upload_consent_params, make_selection_view, renders_search_query_line_when_enabled, snapshot_footer_note_wraps, footer_hint (+8 more)); 2 external calls (from, vec!).


##### `standard_popup_hint_line_for_keymap`  (lines 26–33)

```
fn standard_popup_hint_line_for_keymap(list_keymap: &ListKeymap) -> Line<'static>
```

**Purpose**: Builds the standard confirm/cancel footer hint using the primary bindings from a supplied `ListKeymap`. It adapts popup hints to remapped runtime controls.

**Data flow**: Takes `list_keymap`, extracts `primary_binding(&list_keymap.accept)` and `primary_binding(&list_keymap.cancel)`, passes those options plus labels `to confirm` and `to go back` into `accept_cancel_hint_line`, and returns the resulting line.

**Call relations**: Used by popup code that wants the standard wording but with keymap-derived bindings instead of hardcoded Enter/Esc.

*Call graph*: calls 2 internal fn (accept_cancel_hint_line, primary_binding); called by 2 (standard_popup_hint_line, selection_view_params).


##### `accept_cancel_hint_line`  (lines 35–61)

```
fn accept_cancel_hint_line(
    accept: Option<KeyBinding>,
    accept_label: &'static str,
    cancel: Option<KeyBinding>,
    cancel_label: &'static str,
) -> Line<'static>
```

**Purpose**: Formats a footer hint line for arbitrary optional accept and cancel bindings and labels. It is the generic helper underlying the standard popup hint variants.

**Data flow**: Takes optional `accept` and `cancel` bindings plus their labels. It pattern-matches on the `(accept, cancel)` pair and returns a `Line<'static>` containing either both bindings with `Press ... or ...`, only the accept clause, only the cancel clause, or an empty line when neither binding is available.

**Call relations**: Called by `standard_popup_hint_line_for_keymap` and other popup-specific footer builders that need custom labels.

*Call graph*: called by 2 (approval_footer_hint, standard_popup_hint_line_for_keymap); 2 external calls (from, vec!).


### `tui/src/bottom_pane/scroll_state.rs`

`util` · `cross-cutting`

This file provides the `ScrollState` data structure used across many bottom-pane list and popup views. The struct is intentionally minimal—just `selected_idx: Option<usize>` and `scroll_top: usize`—and all mutation methods take the current list length and visible row count as arguments instead of caching them. That design keeps the state reusable across filtered and dynamically sized lists, but it also means callers must immediately re-clamp after changing the visible row set.

The movement API covers single-step wraparound navigation (`move_up_wrap`, `move_down_wrap`), non-wrapping page movement (`page_up_clamped`, `page_down_clamped`), and direct jumps to top or bottom. `clamp_selection` repairs stale selections after filtering, while `ensure_visible` adjusts `scroll_top` so the selected row remains inside the viewport. The private `clear_if_empty` helper is the common guard that resets both selection and scroll when the list becomes empty.

The implementation is careful about edge cases: empty lists clear state instead of leaving invalid indices behind; page size is clamped to at least one row; `ensure_visible` resets scroll when there is no selection or no visible rows; and all index math uses saturating operations or explicit bounds checks. The included tests verify wraparound behavior, page movement, and scroll-window updates.

#### Function details

##### `ScrollState::new`  (lines 21–26)

```
fn new() -> Self
```

**Purpose**: Constructs a fresh scroll state with no selection and the viewport positioned at the top.

**Data flow**: Takes no arguments and returns `ScrollState { selected_idx: None, scroll_top: 0 }`.

**Call relations**: This constructor is used broadly by popup and list views when they initialize their local navigation state before any rows are available or selected.

*Call graph*: called by 17 (action_state, new, new, new, from_entry, open_selected_event, return_to_events, new, new, open_reset_confirmation (+7 more)).


##### `ScrollState::reset`  (lines 29–32)

```
fn reset(&mut self)
```

**Purpose**: Clears both selection and scroll position back to the initial state.

**Data flow**: Mutates `self` in place, setting `selected_idx` to `None` and `scroll_top` to `0`; it returns no value.

**Call relations**: Callers use this when a view’s contents or mode changes enough that preserving selection would be misleading, such as after prompt or tab changes.

*Call graph*: called by 3 (on_composer_text_change, set_empty_prompt, switch_tab).


##### `ScrollState::clamp_selection`  (lines 35–40)

```
fn clamp_selection(&mut self, len: usize)
```

**Purpose**: Repairs the current selection so it points at a valid row index for the current list length, defaulting to the first row when needed.

**Data flow**: Reads `len` and current `selected_idx`. If `clear_if_empty(len)` resets the state, it returns immediately; otherwise it writes `selected_idx = Some(min(current_or_0, len - 1))` and leaves `scroll_top` unchanged.

**Call relations**: This is typically called right after filtering or replacing a row set. It depends on `clear_if_empty` for the empty-list case, and callers often follow it with `ensure_visible` to synchronize scrolling.

*Call graph*: calls 1 internal fn (clear_if_empty); called by 7 (on_composer_text_change, set_matches, apply_filter, clamp_selection, apply_filter, clamp_selection, apply_filter).


##### `ScrollState::move_up_wrap`  (lines 43–52)

```
fn move_up_wrap(&mut self, len: usize)
```

**Purpose**: Moves selection one row upward, wrapping from the first row to the last row.

**Data flow**: Reads `len` and current `selected_idx`. If the list is empty, `clear_if_empty` resets state and the function returns. Otherwise it writes a new `selected_idx`: decrement when above zero, wrap to `len - 1` from zero, or choose `0` when there was no prior selection.

**Call relations**: List-style views call this for Up-key navigation. It only changes selection; callers usually invoke `ensure_visible` afterward so the scroll window follows the new selection.

*Call graph*: calls 1 internal fn (clear_if_empty); called by 10 (move_up, move_up, move_up, move_up, move_up, skip_disabled_up, move_up, move_up, move_up, move_up).


##### `ScrollState::move_down_wrap`  (lines 55–63)

```
fn move_down_wrap(&mut self, len: usize)
```

**Purpose**: Moves selection one row downward, wrapping from the last row back to the first row.

**Data flow**: Reads `len` and current `selected_idx`. If empty, `clear_if_empty` resets state. Otherwise it writes `selected_idx` to the next index when possible, or `0` when at the end or when no selection existed.

**Call relations**: This is the Down-key counterpart to `move_up_wrap`. Like the upward version, it is usually paired by callers with `ensure_visible` to update `scroll_top`.

*Call graph*: calls 1 internal fn (clear_if_empty); called by 10 (move_down, move_down, move_down, move_down, move_down, skip_disabled_down, move_down, move_down, move_down, move_down).


##### `ScrollState::page_up_clamped`  (lines 70–78)

```
fn page_up_clamped(&mut self, len: usize, visible_rows: usize)
```

**Purpose**: Moves selection upward by one viewport-sized page without wrapping past the top.

**Data flow**: Reads `len`, `visible_rows`, and current selection. After `clear_if_empty`, it computes `step = max(visible_rows, 1)`, clamps the current selection into range, subtracts `step` with saturation, writes the new `selected_idx`, and then updates `scroll_top` via `ensure_visible(len, visible_rows)`.

**Call relations**: Views call this for PageUp-style navigation. Unlike single-step movement, it internally invokes `ensure_visible` because page movement semantics are defined together with viewport adjustment.

*Call graph*: calls 2 internal fn (clear_if_empty, ensure_visible); called by 5 (page_up, page_up, page_up, page_up, page_up).


##### `ScrollState::page_down_clamped`  (lines 85–93)

```
fn page_down_clamped(&mut self, len: usize, visible_rows: usize)
```

**Purpose**: Moves selection downward by one viewport-sized page without wrapping past the bottom.

**Data flow**: Reads `len`, `visible_rows`, and current selection. After the empty-list guard, it computes a page step of at least one row, adds it to the current selection, clamps at `len - 1`, writes `selected_idx`, and calls `ensure_visible` to move the scroll window if needed.

**Call relations**: This is the PageDown counterpart to `page_up_clamped`, used by list views that support page navigation.

*Call graph*: calls 2 internal fn (clear_if_empty, ensure_visible); called by 5 (page_down, page_down, page_down, page_down, page_down).


##### `ScrollState::jump_top`  (lines 96–102)

```
fn jump_top(&mut self, len: usize, visible_rows: usize)
```

**Purpose**: Selects the first row and scrolls so it is visible.

**Data flow**: Reads `len` and `visible_rows`; if the list is empty it resets via `clear_if_empty`. Otherwise it writes `selected_idx = Some(0)` and then calls `ensure_visible(len, visible_rows)` to normalize `scroll_top`.

**Call relations**: Views use this for Home-like navigation or explicit jump-to-top commands.

*Call graph*: calls 2 internal fn (clear_if_empty, ensure_visible); called by 5 (jump_top, jump_top, jump_top, jump_top, jump_top).


##### `ScrollState::jump_bottom`  (lines 105–111)

```
fn jump_bottom(&mut self, len: usize, visible_rows: usize)
```

**Purpose**: Selects the last row and scrolls so it is visible.

**Data flow**: Reads `len` and `visible_rows`; if empty it resets via `clear_if_empty`. Otherwise it writes `selected_idx = Some(len - 1)` and then calls `ensure_visible(len, visible_rows)`.

**Call relations**: Views use this for End-like navigation or explicit jump-to-bottom commands.

*Call graph*: calls 2 internal fn (clear_if_empty, ensure_visible); called by 5 (jump_bottom, jump_bottom, jump_bottom, jump_bottom, jump_bottom).


##### `ScrollState::clear_if_empty`  (lines 113–120)

```
fn clear_if_empty(&mut self, len: usize) -> bool
```

**Purpose**: Shared guard that resets selection and scroll when the current list length is zero.

**Data flow**: Reads `len`; when `len == 0` it mutates `self.selected_idx` to `None` and `self.scroll_top` to `0`, then returns `true`. Otherwise it leaves state unchanged and returns `false`.

**Call relations**: This private helper is the first branch in all selection-mutating methods so they all agree on empty-list behavior.

*Call graph*: called by 7 (clamp_selection, jump_bottom, jump_top, move_down_wrap, move_up_wrap, page_down_clamped, page_up_clamped).


##### `ScrollState::ensure_visible`  (lines 124–141)

```
fn ensure_visible(&mut self, len: usize, visible_rows: usize)
```

**Purpose**: Adjusts `scroll_top` so the selected row lies within the current viewport window.

**Data flow**: Reads `len`, `visible_rows`, `selected_idx`, and current `scroll_top`. If there are no rows or no visible rows, it resets `scroll_top` to `0`. If a selection exists above the current window it moves `scroll_top` up to the selection; if the selection is below the bottom edge it shifts `scroll_top` down just enough to include it; if there is no selection it resets `scroll_top` to `0`.

**Call relations**: Many views call this after movement, filtering, or selection repair. It is also invoked internally by the page and jump methods so those operations leave the viewport consistent.

*Call graph*: called by 33 (move_down, move_up, on_composer_text_change, move_down, move_up, move_down, move_up, set_matches, move_down, move_up (+15 more)).


##### `tests::wrap_navigation_and_visibility`  (lines 149–171)

```
fn wrap_navigation_and_visibility()
```

**Purpose**: Verifies that wraparound single-step navigation updates selection correctly and that `ensure_visible` keeps the selected row inside the viewport.

**Data flow**: Creates a new `ScrollState`, mutates it through clamp, wrap-up, wrap-down, and visibility updates, and asserts expected `selected_idx` and `scroll_top` values.

**Call relations**: This test exercises the interaction between `new`, `clamp_selection`, `move_up_wrap`, `move_down_wrap`, and `ensure_visible`.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, assert_eq!, panic!).


##### `tests::page_and_jump_navigation_clamps`  (lines 174–203)

```
fn page_and_jump_navigation_clamps()
```

**Purpose**: Checks that page movement and top/bottom jumps clamp at list edges and produce the expected scroll offsets.

**Data flow**: Builds a fresh state, applies page-down, page-up, jump-top, and jump-bottom operations with a fixed list length and viewport size, and asserts the resulting selection and scroll positions after each step.

**Call relations**: This test covers the non-wrapping navigation methods and confirms their built-in `ensure_visible` behavior.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


### `tui/src/bottom_pane/selection_popup_common.rs`

`util` · `cross-cutting`

This file is the common rendering core for list-like bottom-pane UIs. Its central data model is `GenericDisplayRow`, a presentation-oriented struct containing the row label, optional prefix spans, fuzzy-match indices, optional shortcut, description, category tag, disabled state, and optional wrap indent. Around that, it defines `ColumnWidthMode` and `ColumnWidthConfig` so callers can choose whether the split between name and description columns is derived from visible rows, all rows, or a fixed 30/70 layout.

The file also standardizes the popup surface itself: `render_menu_surface` paints a `Block` with `user_message_style`, and `menu_surface_inset` / `menu_surface_padding_height` define the shared inner padding used by overlays. For row content, it can build a single styled line with fuzzy-match bolding and disabled annotations, or wrap rows either through a special two-column path for plain wrapped labels or a general styled-line wrapper that preserves spans and indentation.

Rendering logic is careful to keep selection visible even when rows wrap to multiple terminal lines. It first computes an item window from `ScrollState`, then may advance the start index until the selected item actually fits in the line-based viewport. Selected rows are recolored with `accent_style`, disabled rows are dimmed, empty lists render a dim italic placeholder, and single-line mode truncates overflow with an ellipsis. Matching measurement helpers mirror the same wrapping and column-width rules so callers can reserve the correct height.

#### Function details

##### `ColumnWidthConfig::new`  (lines 65–70)

```
fn new(mode: ColumnWidthMode, name_column_width: Option<usize>) -> Self
```

**Purpose**: Constructs an explicit column-width configuration from a mode and optional shared name-column width override.

**Data flow**: Takes a `ColumnWidthMode` and `Option<usize>` width override and returns a `ColumnWidthConfig` containing those exact values.

**Call relations**: Callers use this when they need rendering and measurement to share a non-default column policy instead of relying on `Default`.

*Call graph*: called by 2 (desired_height, render).


##### `menu_surface_inset`  (lines 85–87)

```
fn menu_surface_inset(area: Rect) -> Rect
```

**Purpose**: Applies the standard vertical and horizontal padding used inside bottom-pane menu surfaces.

**Data flow**: Takes an outer `Rect`, constructs `Insets::vh(MENU_SURFACE_INSET_V, MENU_SURFACE_INSET_H)`, applies `area.inset(...)`, and returns the inner content rectangle.

**Call relations**: This helper is used by popup renderers and height calculators so they all agree on the same content box inside the shared menu surface.

*Call graph*: calls 1 internal fn (vh); called by 7 (cursor_pos, desired_height, cursor_pos_impl, desired_height, unanswered_confirmation_height, desired_height_keeps_spacers_and_preferred_options_visible, render_menu_surface); 1 external calls (inset).


##### `menu_surface_padding_height`  (lines 90–92)

```
fn menu_surface_padding_height() -> u16
```

**Purpose**: Returns the total vertical padding contributed by the shared menu surface treatment.

**Data flow**: Computes and returns `MENU_SURFACE_INSET_V * 2` as a `u16` constant.

**Call relations**: Height calculators call this to add top and bottom padding without duplicating the inset constants.

*Call graph*: called by 3 (desired_height, desired_height, unanswered_confirmation_height).


##### `render_menu_surface`  (lines 99–107)

```
fn render_menu_surface(area: Rect, buf: &mut Buffer) -> Rect
```

**Purpose**: Paints the shared popup background style and returns the inset rectangle where inner content should be rendered.

**Data flow**: Receives an outer area and mutable buffer. If `area.is_empty()` it returns the original area unchanged; otherwise it renders a default `Block` styled with `user_message_style()` into the buffer and returns `menu_surface_inset(area)`.

**Call relations**: Overlay renderers call this first so all selection-style popups share the same background and padding before they draw their own content.

*Call graph*: calls 2 internal fn (menu_surface_inset, user_message_style); called by 5 (render, render, render, render_ui_at, render_unanswered_confirmation); 2 external calls (default, is_empty).


##### `wrap_styled_line`  (lines 113–122)

```
fn wrap_styled_line(line: &'a Line<'a>, width: u16) -> Vec<Line<'a>>
```

**Purpose**: Wraps a styled `Line` to a target width while preserving span styling and guaranteeing a minimum width of one cell.

**Data flow**: Takes a borrowed `Line` and `width`, clamps width to at least 1, builds `RtOptions` with empty initial and subsequent indents, passes both to `word_wrap_line`, and returns the resulting wrapped lines.

**Call relations**: This helper is used by higher-level overlays when they need wrapped text that preserves styling, such as popup headers and prompts.

*Call graph*: calls 1 internal fn (new); called by 2 (desired_height, unanswered_confirmation_layout); 1 external calls (from).


##### `line_to_owned`  (lines 124–137)

```
fn line_to_owned(line: Line<'_>) -> Line<'static>
```

**Purpose**: Converts a borrowed wrapped line into an owned `'static` line while preserving style and alignment.

**Data flow**: Consumes a `Line<'_>`, clones style/alignment metadata, converts each span’s content into owned text, and returns a `Line<'static>`.

**Call relations**: This private helper supports wrapping paths that need to store or return owned lines after using borrowed wrapping utilities.


##### `compute_desc_col`  (lines 139–203)

```
fn compute_desc_col(
    rows_all: &[GenericDisplayRow],
    start_idx: usize,
    visible_items: usize,
    content_width: u16,
    column_width: ColumnWidthConfig,
) -> usize
```

**Purpose**: Determines the column where descriptions should begin for a row list, based on content width and the configured column-width policy.

**Data flow**: Reads all rows, the current item window start, visible item count, content width, and `ColumnWidthConfig`. It computes the maximum legal description column, then either returns a fixed 30% split or measures the widest visible/all-row name block—including prefix spans and disabled marker text—applies any explicit width override, adds two spaces of gap, caps the result to preserve at least 30% for descriptions, and returns the chosen column index.

**Call relations**: This is a core layout primitive used by wrapped rendering, single-line rendering, wrapped-viewport visibility checks, and height measurement so all those paths align descriptions consistently.

*Call graph*: called by 4 (adjust_start_for_wrapped_selection_visibility, measure_rows_height_inner, render_rows_inner, render_rows_single_line_with_col_width_mode); 1 external calls (iter).


##### `wrap_indent`  (lines 206–216)

```
fn wrap_indent(row: &GenericDisplayRow, desc_col: usize, max_width: u16) -> usize
```

**Purpose**: Computes the indentation to use for continuation lines when a row wraps.

**Data flow**: Reads the row, description column, and maximum width. It prefers `row.wrap_indent` when present; otherwise it uses `desc_col` when the row has a description or disabled reason, or `0` for plain rows. The result is clamped to at most `max_width - 1`.

**Call relations**: This helper is used by `wrap_standard_row` to keep wrapped continuation lines visually aligned under the intended column.

*Call graph*: called by 1 (wrap_standard_row).


##### `should_wrap_name_in_column`  (lines 218–228)

```
fn should_wrap_name_in_column(row: &GenericDisplayRow) -> bool
```

**Purpose**: Detects the narrow special case where a row should use the dedicated two-column wrapping path instead of the general styled-line wrapper.

**Data flow**: Inspects a `GenericDisplayRow` and returns `true` only when it has an explicit wrap indent, has a description, has no disabled reason, no fuzzy-match indices, no shortcut, no category tag, and no prefix spans.

**Call relations**: This predicate is consulted by `wrap_row_lines` to decide whether `wrap_two_column_row` can safely preserve a cleaner left/right column layout.

*Call graph*: called by 1 (wrap_row_lines).


##### `wrap_two_column_row`  (lines 230–288)

```
fn wrap_two_column_row(row: &GenericDisplayRow, desc_col: usize, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Wraps a plain name/description row into multiple lines while keeping the name in a left column and the description in a right column.

**Data flow**: Takes a row, description column, and width. If there is no description or no usable description column, it returns an empty vector. Otherwise it computes left and right column widths, wraps the name with optional subsequent indentation using `textwrap`, wraps the description separately, then merges corresponding wrapped lines into `Line<'static>` values with enough spaces inserted so description text starts at `desc_col`, dimming the description spans.

**Call relations**: This specialized wrapper is attempted first by `wrap_row_lines` for simple two-column rows; tests also call it directly to verify narrow-width fallback behavior.

*Call graph*: called by 2 (one_cell_width_falls_back_without_panic_for_wrapped_two_column_rows, wrap_row_lines); 5 external calls (from, new, with_capacity, new, wrap).


##### `wrap_standard_row`  (lines 290–303)

```
fn wrap_standard_row(row: &GenericDisplayRow, desc_col: usize, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Wraps a fully styled row line using the generic styled-line wrapping path and a computed continuation indent.

**Data flow**: Builds the complete styled line with `build_full_line`, computes continuation indentation with `wrap_indent`, constructs wrapping options with empty initial indent and a space-filled subsequent indent, wraps via `word_wrap_line`, converts each wrapped line to owned form, and returns the vector.

**Call relations**: This is the fallback wrapping path used by `wrap_row_lines` whenever the specialized two-column path is not applicable or produces no output.

*Call graph*: calls 3 internal fn (build_full_line, wrap_indent, new); called by 1 (wrap_row_lines); 1 external calls (from).


##### `wrap_row_lines`  (lines 305–314)

```
fn wrap_row_lines(row: &GenericDisplayRow, desc_col: usize, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Chooses the appropriate wrapping strategy for a row and returns the rendered lines it would occupy.

**Data flow**: Reads the row, description column, and width. It first checks `should_wrap_name_in_column`; if true it tries `wrap_two_column_row` and returns that result when non-empty. Otherwise it falls back to `wrap_standard_row`.

**Call relations**: This helper is the common row-to-lines transformation used by wrapped rendering, wrapped viewport visibility checks, and height measurement.

*Call graph*: calls 3 internal fn (should_wrap_name_in_column, wrap_standard_row, wrap_two_column_row); called by 3 (is_selected_visible_in_wrapped_viewport, measure_rows_height_inner, render_rows_inner).


##### `apply_row_state_style`  (lines 316–331)

```
fn apply_row_state_style(lines: &mut [Line<'static>], selected: bool, is_disabled: bool)
```

**Purpose**: Applies selection and disabled-state styling to already wrapped row lines.

**Data flow**: Mutably iterates over a slice of `Line<'static>`. If `selected` is true, it replaces every span style with `accent_style()`. If `is_disabled` is true, it dims each span’s current style. It mutates the lines in place and returns nothing.

**Call relations**: Wrapped rendering calls this after line wrapping so selection and disabled styling affect every visual line of a multi-line row.

*Call graph*: called by 1 (render_rows_inner); 1 external calls (iter_mut).


##### `compute_item_window_start`  (lines 333–354)

```
fn compute_item_window_start(
    rows_all: &[GenericDisplayRow],
    state: &ScrollState,
    max_items: usize,
) -> usize
```

**Purpose**: Computes the initial item-based scroll window start index from `ScrollState` and the maximum number of items to consider.

**Data flow**: Reads the full row slice, `state.scroll_top`, optional `state.selected_idx`, and `max_items`. It returns `0` for empty inputs; otherwise it clamps `scroll_top` into range and adjusts it upward or downward so the selected item lies within the item-count window `[start_idx, start_idx + max_items - 1]`.

**Call relations**: This is the first-stage viewport calculation used by `adjust_start_for_wrapped_selection_visibility` before wrapped line heights are considered.

*Call graph*: called by 1 (adjust_start_for_wrapped_selection_visibility); 2 external calls (is_empty, len).


##### `is_selected_visible_in_wrapped_viewport`  (lines 356–387)

```
fn is_selected_visible_in_wrapped_viewport(
    rows_all: &[GenericDisplayRow],
    start_idx: usize,
    max_items: usize,
    selected_idx: usize,
    desc_col: usize,
    width: u16,
    viewport_h
```

**Purpose**: Checks whether the selected item would actually appear inside a line-based viewport once row wrapping is taken into account.

**Data flow**: Reads the row list, item window start, max items, selected index, description column, width, and viewport height. It simulates rendering from `start_idx`, summing `wrap_row_lines(...).len().max(1)` for each row, always allowing the first row even if it overflows, and returns `true` if it encounters `selected_idx` before the simulated viewport fills.

**Call relations**: This helper is used by `adjust_start_for_wrapped_selection_visibility` to detect when an item-based scroll window still hides the selected row because earlier rows wrapped taller than one line.

*Call graph*: calls 1 internal fn (wrap_row_lines); called by 1 (adjust_start_for_wrapped_selection_visibility); 1 external calls (iter).


##### `adjust_start_for_wrapped_selection_visibility`  (lines 389–425)

```
fn adjust_start_for_wrapped_selection_visibility(
    rows_all: &[GenericDisplayRow],
    state: &ScrollState,
    max_items: usize,
    desc_measure_items: usize,
    width: u16,
    viewport_height:
```

**Purpose**: Advances the item window start until the selected row is visible in the wrapped line viewport.

**Data flow**: Starts from `compute_item_window_start`, reads `state.selected_idx`, viewport dimensions, and column-width config, and while the selected row remains below the visible wrapped viewport it recomputes `desc_col` for the current start and increments `start_idx`. It returns the corrected start index.

**Call relations**: Wrapped rendering uses this instead of raw `scroll_top` semantics so selection visibility remains correct even when rows consume multiple terminal lines.

*Call graph*: calls 3 internal fn (compute_desc_col, compute_item_window_start, is_selected_visible_in_wrapped_viewport); called by 1 (render_rows_inner).


##### `build_full_line`  (lines 430–511)

```
fn build_full_line(row: &GenericDisplayRow, desc_col: usize) -> Line<'static>
```

**Purpose**: Builds the complete styled single-line representation of a row, including prefix spans, fuzzy-match bolding, optional shortcut, padded description, category tag, and disabled annotations.

**Data flow**: Reads all presentation fields from a `GenericDisplayRow` plus `desc_col`. It synthesizes a combined description string from `description` and `disabled_reason`, computes how much width the name may occupy before the description column, walks the name character-by-character applying bold style to fuzzy-match indices and truncating with an ellipsis when needed, appends a dim ` (disabled)` marker when applicable, then assembles prefix spans, name spans, optional shortcut spans, gap spaces up to `desc_col`, dimmed description text, and optional dimmed category tag into a final `Line<'static>`.

**Call relations**: This is the core row formatter used by both `wrap_standard_row` and `render_rows_single_line_with_col_width_mode`, ensuring wrapped and single-line modes share the same textual content and styling rules.

*Call graph*: called by 2 (render_rows_single_line_with_col_width_mode, wrap_standard_row); 4 external calls (from, width, with_capacity, format!).


##### `render_rows_inner`  (lines 517–596)

```
fn render_rows_inner(
    area: Rect,
    buf: &mut Buffer,
    rows_all: &[GenericDisplayRow],
    state: &ScrollState,
    max_results: usize,
    empty_message: &str,
    column_width: ColumnWidthC
```

**Purpose**: Renders wrapped selection rows into a buffer using shared selection, disabled, scrolling, and empty-state behavior.

**Data flow**: Receives the target area, buffer, all rows, scroll state, max results, empty-message text, and column-width config. It renders a dim italic placeholder when there are no rows, otherwise computes the visible item count, corrects the start index with `adjust_start_for_wrapped_selection_visibility`, computes `desc_col`, wraps each visible row with `wrap_row_lines`, applies selection/disabled styling with `apply_row_state_style`, renders each wrapped line into successive buffer rows until vertical space runs out, and returns the number of terminal lines drawn.

**Call relations**: This is the shared implementation behind `render_rows` and `render_rows_with_col_width_mode`. Higher-level popups call those wrappers rather than this internal function directly.

*Call graph*: calls 4 internal fn (adjust_start_for_wrapped_selection_visibility, apply_row_state_style, compute_desc_col, wrap_row_lines); called by 2 (render_rows, render_rows_with_col_width_mode); 5 external calls (from, is_empty, iter, len, from).


##### `render_rows`  (lines 606–623)

```
fn render_rows(
    area: Rect,
    buf: &mut Buffer,
    rows_all: &[GenericDisplayRow],
    state: &ScrollState,
    max_results: usize,
    empty_message: &str,
) -> u16
```

**Purpose**: Public wrapped-row renderer using the default `ColumnWidthConfig` (`AutoVisible`).

**Data flow**: Passes its area, buffer, rows, state, max-results limit, and empty-message text into `render_rows_inner` together with `ColumnWidthConfig::default()`, then returns the rendered line count.

**Call relations**: This is the common entry point used by many overlays and popups that want adaptive visible-row-based description alignment.

*Call graph*: calls 1 internal fn (render_rows_inner); called by 8 (render, render, render_ref, render_input, render, render_unanswered_confirmation, render_rows_bottom_aligned, selected_rows_use_the_shared_accent_style); 1 external calls (default).


##### `render_rows_with_col_width_mode`  (lines 631–649)

```
fn render_rows_with_col_width_mode(
    area: Rect,
    buf: &mut Buffer,
    rows_all: &[GenericDisplayRow],
    state: &ScrollState,
    max_results: usize,
    empty_message: &str,
    column_width
```

**Purpose**: Public wrapped-row renderer that accepts an explicit column-width configuration.

**Data flow**: Forwards all rendering inputs plus the caller-supplied `ColumnWidthConfig` to `render_rows_inner` and returns the rendered line count.

**Call relations**: Callers use this lower-level variant when they need stable all-row or fixed column alignment instead of the default adaptive mode.

*Call graph*: calls 1 internal fn (render_rows_inner); called by 2 (render_ref, render).


##### `render_rows_single_line`  (lines 656–673)

```
fn render_rows_single_line(
    area: Rect,
    buf: &mut Buffer,
    rows_all: &[GenericDisplayRow],
    state: &ScrollState,
    max_results: usize,
    empty_message: &str,
) -> u16
```

**Purpose**: Renders rows as exactly one terminal line each, truncating overflow with an ellipsis and using the default column-width policy.

**Data flow**: Delegates to `render_rows_single_line_with_col_width_mode` with `ColumnWidthConfig::default()` and returns the number of lines rendered.

**Call relations**: Dense popups such as mention or skill lists use this wrapper when multi-line row wrapping would create too much vertical churn.

*Call graph*: calls 1 internal fn (render_rows_single_line_with_col_width_mode); called by 3 (render, render_ref, render); 1 external calls (default).


##### `render_rows_single_line_with_col_width_mode`  (lines 677–751)

```
fn render_rows_single_line_with_col_width_mode(
    area: Rect,
    buf: &mut Buffer,
    rows_all: &[GenericDisplayRow],
    state: &ScrollState,
    max_results: usize,
    empty_message: &str,
```

**Purpose**: Renders a single-line-per-row list with configurable column-width behavior, selection styling, disabled styling, and ellipsis truncation.

**Data flow**: If there are no rows, it renders a dim italic placeholder when space exists and returns 1 or 0 accordingly. Otherwise it computes the visible item count from `max_results`, row count, and area height; derives a start index from `scroll_top` and selection; computes `desc_col`; builds each row line with `build_full_line`; applies accent styling for the selected non-disabled row and dimming for disabled rows; truncates overflow with `truncate_line_with_ellipsis_if_overflow`; renders each line into the buffer; and returns the number of rows drawn.

**Call relations**: This is the implementation behind `render_rows_single_line` and is used by compact list UIs that want stable one-row-per-item rendering.

*Call graph*: calls 3 internal fn (build_full_line, compute_desc_col, truncate_line_with_ellipsis_if_overflow); called by 2 (render, render_rows_single_line); 5 external calls (from, is_empty, iter, len, from).


##### `measure_rows_height`  (lines 761–774)

```
fn measure_rows_height(
    rows_all: &[GenericDisplayRow],
    state: &ScrollState,
    max_results: usize,
    width: u16,
) -> u16
```

**Purpose**: Measures how many terminal lines wrapped row rendering would require under the default adaptive column-width policy.

**Data flow**: Forwards the row slice, scroll state, max-results limit, width, and `ColumnWidthConfig::default()` to `measure_rows_height_inner` and returns the resulting height.

**Call relations**: Popup height calculators call this when they intend to render with `render_rows`, so reserved space matches wrapped rendering semantics.

*Call graph*: calls 1 internal fn (measure_rows_height_inner); called by 9 (action_rows_height, desired_height, render, options_required_height, desired_height, render, options_preferred_height, options_required_height, unanswered_confirmation_height); 1 external calls (default).


##### `measure_rows_height_with_col_width_mode`  (lines 779–787)

```
fn measure_rows_height_with_col_width_mode(
    rows_all: &[GenericDisplayRow],
    state: &ScrollState,
    max_results: usize,
    width: u16,
    column_width: ColumnWidthConfig,
) -> u16
```

**Purpose**: Measures wrapped row height using an explicit column-width configuration.

**Data flow**: Passes rows, state, max-results limit, width, and the caller’s `ColumnWidthConfig` into `measure_rows_height_inner` and returns the computed line count.

**Call relations**: This is the measurement companion to `render_rows_with_col_width_mode` for callers that need non-default alignment behavior.

*Call graph*: calls 1 internal fn (measure_rows_height_inner); called by 3 (calculate_required_height, desired_height, render).


##### `measure_rows_height_inner`  (lines 789–835)

```
fn measure_rows_height_inner(
    rows_all: &[GenericDisplayRow],
    state: &ScrollState,
    max_results: usize,
    width: u16,
    column_width: ColumnWidthConfig,
) -> u16
```

**Purpose**: Internal implementation that computes the wrapped line count for the visible row window without rendering.

**Data flow**: Returns 1 for an empty row set to account for the placeholder line. Otherwise it reduces width by one cell for content safety, computes visible item count and start index from scroll state, derives `desc_col` with `compute_desc_col`, sums `wrap_row_lines(...).len()` for each visible row, and returns at least 1.

**Call relations**: This internal helper underpins both public measurement functions and mirrors the same wrapping and column calculations used by wrapped rendering.

*Call graph*: calls 2 internal fn (compute_desc_col, wrap_row_lines); called by 2 (measure_rows_height, measure_rows_height_with_col_width_mode); 3 external calls (is_empty, iter, len).


##### `tests::one_cell_width_falls_back_without_panic_for_wrapped_two_column_rows`  (lines 846–856)

```
fn one_cell_width_falls_back_without_panic_for_wrapped_two_column_rows()
```

**Purpose**: Ensures the specialized two-column wrapping path safely returns no lines instead of panicking when width is too narrow to support a description column.

**Data flow**: Builds a `GenericDisplayRow` with a long name and description, calls `wrap_two_column_row` with width 1 and `desc_col` 0, and asserts that the returned vector is empty.

**Call relations**: This test directly exercises the narrow-width guard in `wrap_two_column_row`.

*Call graph*: calls 1 internal fn (wrap_two_column_row); 2 external calls (default, assert_eq!).


##### `tests::selected_rows_use_the_shared_accent_style`  (lines 859–879)

```
fn selected_rows_use_the_shared_accent_style()
```

**Purpose**: Verifies that selected rows rendered through the shared row renderer use the common accent styling.

**Data flow**: Creates a one-row list and a `ScrollState` selecting that row, renders into a `Buffer` with `render_rows`, reads the style of the first cell, and compares it against `accent_style()`.

**Call relations**: This test validates the selection styling path applied during wrapped row rendering.

*Call graph*: calls 2 internal fn (render_rows, accent_style); 6 external calls (empty, default, new, assert!, assert_eq!, vec!).


### `tui/src/bottom_pane/selection_tabs.rs`

`util` · `request handling`

This file defines the `SelectionTab` struct and the small set of helpers needed to render a tab strip above selection content. Each tab carries an `id`, a visible `label`, a `header` renderable, and its associated `items`, but this file’s logic is focused specifically on the tab bar itself rather than tab content.

The core behavior is in `tab_bar_lines`, which converts the tab list into one or more `Line<'static>` values that fit within the available width. It builds each tab as a span sequence from `tab_unit`, measures its display width, inserts a fixed two-space gap between adjacent tabs, and wraps to a new output line whenever adding the next tab would exceed the current row width. Active tabs are rendered as `[label]` using the shared `accent_style`, while inactive tabs are shown as dim plain text without brackets.

`tab_bar_height` simply asks how many wrapped lines would be produced, and `render_tab_bar` renders those lines into the provided area, clipping to the area height. Empty tab lists are treated as a zero-height, no-op case. The implementation is intentionally simple and deterministic: wrapping happens only between whole tabs, never inside a label, so tab labels remain visually intact.

#### Function details

##### `tab_bar_height`  (lines 23–31)

```
fn tab_bar_height(tabs: &[SelectionTab], active_idx: usize, width: u16) -> u16
```

**Purpose**: Computes how many terminal rows the tab bar will occupy at a given width.

**Data flow**: Takes the tab slice, active tab index, and width. It returns `0` immediately for an empty tab list; otherwise it builds wrapped lines with `tab_bar_lines`, converts the line count to `u16`, and saturates to `u16::MAX` on conversion failure.

**Call relations**: Views call this during layout before rendering so they can reserve enough vertical space for the wrapped tab strip.

*Call graph*: calls 1 internal fn (tab_bar_lines); called by 2 (desired_height, render); 1 external calls (is_empty).


##### `render_tab_bar`  (lines 33–54)

```
fn render_tab_bar(
    tabs: &[SelectionTab],
    active_idx: usize,
    area: Rect,
    buf: &mut Buffer,
)
```

**Purpose**: Draws the wrapped tab bar lines into the target buffer area.

**Data flow**: Receives the tabs, active index, destination `Rect`, and mutable `Buffer`. It computes the wrapped lines with `tab_bar_lines`, clips them to `area.height`, and renders each line into a one-row rectangle at successive `y` offsets.

**Call relations**: This is the rendering counterpart to `tab_bar_height`; callers typically use both so measurement and drawing share the same wrapping logic.

*Call graph*: calls 1 internal fn (tab_bar_lines); called by 1 (render).


##### `tab_bar_lines`  (lines 56–93)

```
fn tab_bar_lines(tabs: &[SelectionTab], active_idx: usize, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the tab bar as one or more styled lines, wrapping only between complete tab units.

**Data flow**: Reads the tab slice, active index, and width. For each tab it builds a span vector with `tab_unit`, measures its width, computes whether a two-space gap is needed, starts a new output line if appending the tab would exceed `max_width`, otherwise appends the gap and spans to the current line, and finally returns the accumulated `Vec<Line<'static>>`.

**Call relations**: Both `tab_bar_height` and `render_tab_bar` depend on this helper so they stay consistent about wrapping and spacing.

*Call graph*: calls 1 internal fn (tab_unit); called by 2 (render_tab_bar, tab_bar_height); 4 external calls (from, new, is_empty, iter).


##### `tab_unit`  (lines 95–106)

```
fn tab_unit(label: &str, active: bool) -> Vec<Span<'static>>
```

**Purpose**: Creates the styled span sequence for a single tab label in active or inactive form.

**Data flow**: Takes a label string and `active` flag. If active, it fetches `accent_style()` and returns spans for `[`, the label, and `]` all in that style; otherwise it returns a single dimmed label span.

**Call relations**: This helper is called by `tab_bar_lines` for each tab before width measurement and line assembly.

*Call graph*: calls 1 internal fn (accent_style); called by 1 (tab_bar_lines); 1 external calls (vec!).


### `tui/src/selection_list.rs`

`util` · `rendering`

This file is a compact rendering helper for menu-like lists. It exposes two constructors that return boxed `dyn Renderable` rows built from the render subsystem’s `RowRenderable`. Each row consists of a fixed-width prefix column and a wrapping label column. The prefix is formatted as either `› N. ` for the selected item or `  N. ` for unselected items, where numbering is one-based even though the API accepts a zero-based `index`.

`selection_option_row` is the simple entrypoint and always renders non-selected rows at normal intensity. `selection_option_row_with_dim` adds a `dim` flag so callers can intentionally de-emphasize unselected options. Styling is straightforward but concrete: selected rows use `Style::default().cyan()`, dim rows use `Style::default().dim()`, and ordinary rows use the default style. The helper measures the prefix width with `UnicodeWidthStr` so the label column starts at the correct visual offset even with non-ASCII glyphs like `›`. The label itself is rendered with a `Paragraph` configured with `Wrap { trim: false }`, preserving internal spacing and allowing long labels to wrap within the remaining width. The result is converted into a boxed renderable for insertion into larger composed layouts.

#### Function details

##### `selection_option_row`  (lines 10–16)

```
fn selection_option_row(
    index: usize,
    label: String,
    is_selected: bool,
) -> Box<dyn Renderable>
```

**Purpose**: Builds a standard selection row without dimming unselected entries.

**Data flow**: Takes an index, label string, and selection flag, forwards them to `selection_option_row_with_dim` with `dim = false`, and returns the boxed `Renderable` it produces.

**Call relations**: Menu and prompt renderers call this when they want the default selected/unselected styling without extra de-emphasis.

*Call graph*: calls 1 internal fn (selection_option_row_with_dim); called by 4 (render_ref, render_menu, render_ref, render_ref).


##### `selection_option_row_with_dim`  (lines 18–46)

```
fn selection_option_row_with_dim(
    index: usize,
    label: String,
    is_selected: bool,
    dim: bool,
) -> Box<dyn Renderable>
```

**Purpose**: Builds a numbered row renderable with selected, normal, or dim styling and a wrapping label column.

**Data flow**: Accepts zero-based `index`, owned `label`, `is_selected`, and `dim`. It formats the prefix string using one-based numbering, chooses a `Style` (`cyan`, `dim`, or default), measures prefix display width, creates a `RowRenderable`, pushes the styled prefix as a fixed-width cell, pushes a `Paragraph::new(label).style(style).wrap(Wrap { trim: false })` as the flexible cell, and returns the row boxed as `dyn Renderable`.

**Call relations**: This is the underlying implementation used directly by some callers and indirectly through `selection_option_row`.

*Call graph*: calls 1 internal fn (new); called by 2 (render_ref, selection_option_row); 4 external calls (new, default, width, format!).


### Compact display-model shaping
This group gathers small formatting and labeling helpers that convert raw domain/configuration data into concise TUI-facing display text and models.

### `tui/src/chatwidget/warnings.rs`

`util` · `cross-cutting`

This file defines `WarningDisplayState`, a minimal state holder with one `HashSet<String>` tracking model slugs for which the fallback-model-metadata warning has already been shown. The warning text pattern is encoded by two string constants: a fixed prefix and suffix surrounding the model slug. Rather than deduplicating all warnings globally, the logic is intentionally narrow and only special-cases this one noisy warning family.

`should_display` delegates parsing to `fallback_model_metadata_warning_slug`. If the message does not match the known fallback-model-metadata pattern, the function returns `true` so unrelated warnings are always shown. If the message does match, it inserts the extracted slug into the set and returns whether that insertion was new. That means the first warning for a given model slug is displayed, while subsequent identical-pattern warnings for the same slug are suppressed. Different slugs are tracked independently.

The helper parser itself is deliberately simple: it strips the known prefix and suffix and returns the substring between them as the slug. This design keeps the deduplication rule transparent and avoids accidental suppression of warnings whose text merely resembles the fallback-model-metadata message.

#### Function details

##### `WarningDisplayState::should_display`  (lines 13–16)

```
fn should_display(&mut self, message: &str) -> bool
```

**Purpose**: Determines whether a warning message should be shown, suppressing duplicate fallback-model-metadata warnings for the same model slug. All other warnings pass through unchanged.

**Data flow**: Takes `&mut self` and `&str message`, parses an optional slug with `fallback_model_metadata_warning_slug`, and returns true when no slug is found or when inserting the slug into `fallback_model_metadata_slugs` succeeds for the first time. It mutates the slug set only for matching fallback-model-metadata warnings.

**Call relations**: Called by higher-level warning rendering code before appending warning history cells. It delegates pattern extraction to `fallback_model_metadata_warning_slug`.

*Call graph*: calls 1 internal fn (fallback_model_metadata_warning_slug).


##### `fallback_model_metadata_warning_slug`  (lines 19–23)

```
fn fallback_model_metadata_warning_slug(message: &str) -> Option<&str>
```

**Purpose**: Extracts the model slug from the specific fallback-model-metadata warning format. It returns `None` for any message that does not exactly match the expected prefix and suffix.

**Data flow**: Takes `&str message`, strips the fixed prefix, then strips the fixed suffix from the remainder, and returns the substring between them as `Option<&str>`. It does not mutate state.

**Call relations**: Used only by `WarningDisplayState::should_display` as the parser that identifies which warnings are eligible for slug-based deduplication.

*Call graph*: called by 1 (should_display).


### `tui/src/external_agent_config_migration_model.rs`

`domain_logic` · `prompt model construction`

This file contains the presentation-oriented model helpers for migration items. `ExternalAgentConfigMigrationGroupModel` stores a group `label`, a static `description`, and the `item_indices` from the original detection list that belong to that group. The grouping function partitions items into three buckets based on `cwd` presence and `ExternalAgentConfigMigrationItemType`: global tools/setup items (`cwd.is_none()` and not sessions), project items (`cwd.is_some()` and not sessions), and chat sessions (`item_type == Sessions`). Empty buckets are omitted entirely.

Group labels are computed from the data rather than hard-coded counts. Project groups count distinct `cwd` values with a `BTreeSet`, yielding either `Current project` or `Projects (N)`. Session groups sum `details.sessions.len()` across all session items and label the group `Chat sessions (N)`. Item labels are a direct mapping from protocol enum variants to migration-specific copy such as `Settings (settings.json -> config.toml)`.

Optional detail strings are generated only for item types where listing names is useful. MCP servers, subagents, hooks, commands, and sessions all use `format_counted_details`, which pluralizes the noun and includes up to four names when available. Plugins and simpler one-off item types intentionally return `None`, keeping the UI concise.

#### Function details

##### `external_agent_config_migration_groups`  (lines 12–76)

```
fn external_agent_config_migration_groups(
    items: &[ExternalAgentConfigMigrationItem],
) -> Vec<ExternalAgentConfigMigrationGroupModel>
```

**Purpose**: Partitions detected migration items into user-facing groups for tools/setup, projects, and chat sessions. It also computes count-sensitive group labels and descriptions.

**Data flow**: It takes a slice of `ExternalAgentConfigMigrationItem`, iterates with indices three times to collect matching item indexes into `tools_and_setup`, `projects`, and `chat_sessions`, then builds a `Vec<ExternalAgentConfigMigrationGroupModel>` containing only non-empty groups. For projects it reads `item.cwd` values to count distinct directories via `BTreeSet`; for sessions it reads `item.details.sessions.len()` and sums them. It returns the assembled group vector without mutating external state.

**Call relations**: This helper is called from the migration screen/model construction path when the UI needs grouped rows rather than a flat item list. It feeds later rendering code by preserving original item indexes inside each group.

*Call graph*: called by 1 (new); 3 external calls (new, iter, format!).


##### `external_agent_config_migration_item_label`  (lines 78–92)

```
fn external_agent_config_migration_item_label(
    item: &ExternalAgentConfigMigrationItem,
) -> &'static str
```

**Purpose**: Maps each migration item type to the exact short label shown in the UI. The labels include migration-specific rename hints where relevant.

**Data flow**: It takes a single `ExternalAgentConfigMigrationItem`, matches on `item.item_type`, and returns a static string literal such as `Instructions (CLAUDE.md -> AGENTS.md)` or `Recent chat sessions`. It reads only the enum variant and has no side effects.

**Call relations**: This is a pure lookup helper used by higher-level render-line builders when they need a stable display name for an item.


##### `external_agent_config_migration_item_detail`  (lines 94–135)

```
fn external_agent_config_migration_item_detail(
    item: &ExternalAgentConfigMigrationItem,
) -> Option<String>
```

**Purpose**: Builds optional secondary detail text for migration items that contain named sub-entities, such as MCP servers or chat sessions. It suppresses details for item types where extra text would be redundant or noisy.

**Data flow**: It takes an `ExternalAgentConfigMigrationItem`, first reads `item.details.as_ref()?` and returns `None` immediately if details are absent. It then matches on `item.item_type`: for MCP servers, subagents, hooks, commands, and sessions it passes the appropriate noun, count, and iterator of names/titles into `format_counted_details`; for plugins, agents markdown, config, and skills it returns `None`. The result is `Option<String>` with no external writes.

**Call relations**: This function is called by `build_customize_render_lines`, where item rows need optional descriptive subtext. It delegates the common count-plus-name formatting pattern to `format_counted_details`.

*Call graph*: calls 1 internal fn (format_counted_details); called by 1 (build_customize_render_lines).


##### `format_counted_details`  (lines 137–147)

```
fn format_counted_details(
    noun: &str,
    count: usize,
    names: impl Iterator<Item = &'a str>,
) -> String
```

**Purpose**: Formats a count summary with optional example names, producing strings like `3 hooks: a, b, c`. It limits the listed names to the first four entries.

**Data flow**: It accepts a singular noun, a numeric count, and an iterator of names. It computes a plural suffix from `count`, collects up to four names with `take(4)`, and returns either `"{count} {noun}{suffix}"` when no names are present or `"{count} {noun}{suffix}: ..."` when names exist. It is pure and returns a `String`.

**Call relations**: This helper is used exclusively by `external_agent_config_migration_item_detail` to keep all count/detail formatting consistent across item types.

*Call graph*: called by 1 (external_agent_config_migration_item_detail); 3 external calls (is_empty, take, format!).


### `tui/src/goal_display.rs`

`util` · `request handling`

This file is a small presentation helper layer around `codex_app_server_protocol::ThreadGoal` and `ThreadGoalStatus`. It defines the `/goal` command usage string and three formatting helpers that normalize protocol data into concise text. `format_goal_elapsed_seconds` is the core duration formatter: it clamps negative input to zero, then emits seconds under a minute, minutes under an hour, hours with optional remaining minutes under a day, and day/hour/minute triples for multi-day durations. The output is intentionally compact rather than sentence-like, which matters because these strings are embedded in narrow status areas. `goal_status_label` maps each `ThreadGoalStatus` enum variant to the exact lowercase phrase shown to users, including special wording for usage and budget limits. `goal_usage_summary` assembles a sentence-like summary from a `ThreadGoal`, always including the objective and conditionally appending time and token usage only when those values are meaningful. Token counts are delegated to `format_tokens_compact`, so large values render as abbreviated quantities like `63.9K`. The tests lock down the compact formatting boundaries—59s vs 1m, exact-hour suppression of `0m`, and day formatting—as well as the combined summary string for a budget-limited goal.

#### Function details

##### `format_goal_elapsed_seconds`  (lines 7–31)

```
fn format_goal_elapsed_seconds(seconds: i64) -> String
```

**Purpose**: Formats an elapsed-second count into a compact duration string such as `59s`, `30m`, `2h`, or `2d 23h 42m`. It deliberately suppresses unnecessary units except in the multi-day case, where days, hours, and minutes are always shown together.

**Data flow**: Takes an `i64` second count, clamps it to a non-negative value, converts to `u64`, then branches by magnitude: under 60 returns seconds, under 60 minutes returns minutes, under 24 hours returns hours with optional remaining minutes, and 24 hours or more returns days plus remaining hours and minutes. It returns a newly allocated `String` and does not mutate external state.

**Call relations**: This helper is used by higher-level goal usage renderers when they need a compact elapsed-time fragment. It is called from active and completed goal usage displays so those callers can embed a stable, width-conscious duration string without duplicating threshold logic.

*Call graph*: called by 2 (active_goal_usage, completed_goal_usage); 1 external calls (format!).


##### `goal_status_label`  (lines 33–42)

```
fn goal_status_label(status: ThreadGoalStatus) -> &'static str
```

**Purpose**: Maps a `ThreadGoalStatus` enum value to the exact human-readable label shown in the TUI. The mapping is fixed and intentionally lowercase except for phrase wording.

**Data flow**: Consumes a `ThreadGoalStatus` by value, matches each variant, and returns a `'static` string slice such as `active`, `paused`, `usage limited`, or `limited by budget`. It performs no allocation and writes no state.

**Call relations**: This is a pure label lookup used wherever goal status text must be rendered consistently. It sits at the presentation boundary between protocol enums and user-visible wording.


##### `goal_usage_summary`  (lines 44–60)

```
fn goal_usage_summary(goal: &ThreadGoal) -> String
```

**Purpose**: Builds a one-line summary of a goal’s objective and any recorded time or token consumption. It omits empty usage sections so the result stays concise when a goal has not yet consumed resources.

**Data flow**: Reads a borrowed `&ThreadGoal`, starts a `Vec<String>` with `Objective: ...`, conditionally appends a `Time: ...` sentence when `time_used_seconds > 0`, and conditionally appends a `Tokens: used/budget.` sentence when `token_budget` is `Some`. It formats elapsed time via `format_goal_elapsed_seconds` and token counts via `format_tokens_compact`, then joins the parts with spaces into a single `String`.

**Call relations**: This summary is used during goal draft and status updates so callers can show the current objective plus resource usage in one compact message. It centralizes the conditional inclusion rules so both draft-setting and status-setting flows present the same wording.

*Call graph*: called by 2 (set_thread_goal_draft, set_thread_goal_status); 2 external calls (format!, vec!).


##### `tests::format_goal_elapsed_seconds_is_compact`  (lines 70–85)

```
fn format_goal_elapsed_seconds_is_compact()
```

**Purpose**: Verifies the duration formatter’s boundary behavior and compact output choices across seconds, minutes, hours, and days. The assertions document the intended user-visible format.

**Data flow**: Calls `format_goal_elapsed_seconds` with representative values including exact thresholds and near-threshold cases, then compares each returned `String` to the expected literal with `assert_eq!`. It only reads local test constants and produces no side effects beyond test pass/fail.

**Call relations**: This test exercises the main formatting helper directly to prevent regressions in status-line text. It is run in the test suite rather than production flow.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::test_thread_goal`  (lines 87–99)

```
fn test_thread_goal(token_budget: Option<i64>, tokens_used: i64) -> ThreadGoal
```

**Purpose**: Constructs a reusable `ThreadGoal` fixture with a long objective and configurable token budget fields. It keeps the summary-formatting test focused on output rather than setup noise.

**Data flow**: Accepts `token_budget: Option<i64>` and `tokens_used: i64`, fills a `ThreadGoal` struct with fixed `thread_id`, `objective`, `status`, `time_used_seconds`, and timestamps, and returns the populated value. It does not touch external state.

**Call relations**: This helper is only used by the summary-formatting test to supply realistic protocol data with controlled token values.


##### `tests::goal_usage_summary_formats_time_and_budgeted_tokens`  (lines 102–110)

```
fn goal_usage_summary_formats_time_and_budgeted_tokens()
```

**Purpose**: Checks that `goal_usage_summary` includes the objective, compact time, and compact token usage with the expected punctuation. It specifically covers the budgeted-token branch.

**Data flow**: Builds a fixture `ThreadGoal` via `test_thread_goal`, passes it to `goal_usage_summary`, and asserts that the returned `String` exactly matches the expected sentence. It has no side effects outside test evaluation.

**Call relations**: This test validates the integration of objective text, elapsed-time formatting, and compact token formatting in the summary helper.

*Call graph*: 1 external calls (assert_eq!).


### `tui/src/skills_helpers.rs`

`util` · `request handling and popup rendering for skill selection`

This file contains focused utility functions for turning `codex_core_skills::model::SkillMetadata` into user-facing text and for matching skills against a typed filter. The helpers encode several display conventions that would otherwise be duplicated across widgets. `skill_display_name` prefers an explicit interface-level `display_name`; if absent, it recognizes names in `plugin:skill` form and rewrites them as `skill (plugin)` for readability; otherwise it falls back to the raw `skill.name`. `skill_description` similarly prefers the interface’s `short_description`, then the top-level `short_description`, and finally the full `description`.

For constrained layouts, `truncate_skill_name` applies a shared maximum width constant (`SKILL_NAME_TRUNCATE_LEN = 21`) through the generic `truncate_text` formatter. Filtering is handled by `match_skill`, which first fuzzy-matches the user’s filter against the display name and returns both highlight indices and score when that succeeds. If the display name differs from the canonical skill name, it performs a second fuzzy match against the canonical name; in that fallback case it returns only the score and suppresses indices because the visible text does not correspond to the matched string. This distinction lets callers rank hidden-name matches without drawing misleading highlight positions.

#### Function details

##### `skill_display_name`  (lines 8–25)

```
fn skill_display_name(skill: &SkillMetadata) -> String
```

**Purpose**: Computes the user-visible name for a skill, preferring explicit interface metadata and otherwise prettifying plugin-qualified names. It ensures popup lists show concise, readable labels instead of raw internal identifiers when possible.

**Data flow**: Takes `&SkillMetadata`, reads `skill.interface.display_name`, then `skill.name`. If an interface display name exists, it returns that as an owned `String`. Otherwise it checks whether `skill.name` splits into non-empty `plugin_name` and `skill_name` around `:`, formats `"{skill_name} ({plugin_name})"` when it does, and falls back to cloning `skill.name`.

**Call relations**: This helper is used by `mention_items` and `skill_candidate` while constructing visible skill entries. It performs all naming decisions locally and does not delegate to other project code beyond standard formatting.

*Call graph*: called by 2 (mention_items, skill_candidate); 1 external calls (format!).


##### `skill_description`  (lines 27–34)

```
fn skill_description(skill: &SkillMetadata) -> &str
```

**Purpose**: Selects the best short description text to show for a skill, preferring interface-specific metadata over broader fallback fields. It returns a borrowed string slice rather than allocating.

**Data flow**: Takes `&SkillMetadata`, reads `skill.interface.short_description`, then `skill.short_description`, then `skill.description`. It returns `&str` pointing into the chosen field and does not mutate any state.

**Call relations**: This function is called by `optional_skill_description` when a UI surface wants explanatory text for a skill. It is a pure selector with no downstream delegation.

*Call graph*: called by 1 (optional_skill_description).


##### `truncate_skill_name`  (lines 36–38)

```
fn truncate_skill_name(name: &str) -> String
```

**Purpose**: Applies the shared skill-name truncation policy used in narrow UI layouts. It centralizes the fixed maximum length so callers stay consistent.

**Data flow**: Takes `&str` name, passes it with `SKILL_NAME_TRUNCATE_LEN` to `truncate_text`, and returns the resulting `String`. It reads only the module constant and writes no state.

**Call relations**: This helper is a leaf wrapper around `truncate_text`. It exists so skill-related callers can use a domain-specific truncation rule without repeating the constant.

*Call graph*: calls 1 internal fn (truncate_text).


##### `match_skill`  (lines 40–54)

```
fn match_skill(
    filter: &str,
    display_name: &str,
    skill_name: &str,
) -> Option<(Option<Vec<usize>>, i32)>
```

**Purpose**: Fuzzy-matches a typed filter against both the visible display name and the canonical skill name, returning ranking information and optional highlight indices. It prefers display-name matches so highlighting aligns with what the user sees.

**Data flow**: Takes `filter`, `display_name`, and `skill_name` as `&str`. It first calls `fuzzy_match(display_name, filter)` and, on success, returns `Some((Some(indices), score))`. If that fails and `display_name != skill_name`, it tries `fuzzy_match(skill_name, filter)` and returns `Some((None, score))` so callers can rank the item without using mismatched highlight positions. If neither match succeeds, it returns `None`.

**Call relations**: This function is called by `apply_filter` during skill list filtering. It delegates matching to the shared fuzzy matcher and encodes the two-stage search policy that distinguishes visible-text matches from hidden canonical-name matches.

*Call graph*: called by 1 (apply_filter); 1 external calls (fuzzy_match).


### `tui/src/status/format.rs`

`util` · `cross-cutting during status-card layout and rendering`

This file contains the reusable formatting primitives that the status-card renderer relies on to produce aligned, width-aware terminal output. The central type, `FieldFormatter`, computes a consistent label column from a set of candidate labels using Unicode display widths rather than byte counts, then exposes helpers to build full field lines and continuation lines. Its internal `value_offset` and precomputed `value_indent` ensure wrapped or follow-on lines begin exactly under the value column, regardless of label length.

`from_labels` scans all labels to determine the widest one and derives the spacing budget from the fixed indent plus `":   "` separator. `line` and `full_spans` prepend a dimmed label span to caller-supplied value spans, while `continuation` emits a dimmed indentation span followed by continuation content. Outside the struct, `push_label` maintains an insertion-ordered unique label list backed by a `BTreeSet`, which lets renderers gather optional fields before computing alignment. `line_display_width` sums Unicode widths across spans for layout decisions. `truncate_line_to_width` performs style-preserving truncation at display-column boundaries: it walks spans in order, keeps zero-width spans, stops once the maximum width is reached, and if a span must be cut mid-string it truncates by Unicode scalar width rather than bytes. That behavior is important for terminal correctness with wide characters and mixed styling.

#### Function details

##### `FieldFormatter::from_labels`  (lines 18–36)

```
fn from_labels(labels: impl IntoIterator<Item = S>) -> Self
```

**Purpose**: Constructs a formatter whose label column is wide enough for the longest provided label. It precomputes the indentation and value offset used by all later field rendering.

**Data flow**: Takes any iterable of label-like values, converts each to `&str`, measures Unicode display width, finds the maximum, computes indent width from `Self::INDENT`, derives `value_offset = indent + label_width + 1 + 3`, builds a matching `value_indent` string of spaces, and returns `FieldFormatter`.

**Call relations**: This constructor is called by `display_lines` after all possible labels have been collected. It provides the alignment parameters consumed by `line`, `continuation`, `value_width`, and `full_spans`.

*Call graph*: called by 1 (display_lines); 2 external calls (into_iter, width).


##### `FieldFormatter::line`  (lines 38–44)

```
fn line(
        &self,
        label: &'static str,
        value_spans: Vec<Span<'static>>,
    ) -> Line<'static>
```

**Purpose**: Builds a complete formatted field line from a label and already-prepared value spans. It is the common one-call path for aligned status rows.

**Data flow**: Takes `&self`, a static label, and a `Vec<Span<'static>>` for the value. It calls `self.full_spans(label, value_spans)`, wraps the result in `Line::from`, and returns the `Line<'static>`.

**Call relations**: This helper is used by `rate_limit_lines` and other status rendering code whenever a single aligned row is needed. It delegates the actual span assembly to `full_spans`.

*Call graph*: calls 1 internal fn (full_spans); called by 1 (rate_limit_lines); 1 external calls (from).


##### `FieldFormatter::continuation`  (lines 46–51)

```
fn continuation(&self, mut spans: Vec<Span<'static>>) -> Line<'static>
```

**Purpose**: Formats a continuation line that aligns under the value column rather than repeating the label. It is used for wrapped reset timestamps, details, and other multi-line values.

**Data flow**: Takes `&self` and mutable value spans, allocates a new span vector with capacity for one extra span, prepends a dimmed span containing `self.value_indent.clone()`, appends the provided spans, wraps them in `Line::from`, and returns the line.

**Call relations**: This helper is used by status rendering code when a field's value wraps onto additional lines. It depends on the offsets computed by `from_labels`.

*Call graph*: 3 external calls (from, from, with_capacity).


##### `FieldFormatter::value_width`  (lines 53–55)

```
fn value_width(&self, available_inner_width: usize) -> usize
```

**Purpose**: Computes how many display columns remain for a field's value inside a given inner width after accounting for indent and label column. This is the width budget used for wrapping and truncation decisions.

**Data flow**: Takes `&self` and `available_inner_width`, subtracts `self.value_offset` with saturation, and returns the resulting `usize`. It reads formatter state and writes nothing.

**Call relations**: This method is called by `rate_limit_row_lines` and other layout code to decide whether content fits inline or needs wrapping.

*Call graph*: called by 1 (rate_limit_row_lines).


##### `FieldFormatter::full_spans`  (lines 57–66)

```
fn full_spans(
        &self,
        label: &str,
        mut value_spans: Vec<Span<'static>>,
    ) -> Vec<Span<'static>>
```

**Purpose**: Prepends the formatted label span to a value span list without wrapping it into a `Line`. It is useful when callers need to inspect or extend the combined spans before final line creation.

**Data flow**: Takes `&self`, a label string, and mutable value spans. It allocates a vector with room for the label plus values, pushes `self.label_span(label)`, appends the value spans, and returns the combined `Vec<Span<'static>>`.

**Call relations**: This helper is used by both `FieldFormatter::line` and `rate_limit_row_lines`. It delegates label formatting to `label_span`.

*Call graph*: calls 1 internal fn (label_span); called by 2 (rate_limit_row_lines, line); 1 external calls (with_capacity).


##### `FieldFormatter::label_span`  (lines 68–82)

```
fn label_span(&self, label: &str) -> Span<'static>
```

**Purpose**: Formats the dimmed label prefix for a field, including indent, colon, and padding up to the shared value column. It ensures all values start in the same column regardless of label length.

**Data flow**: Takes `&self` and a label string, allocates a `String` sized to `self.value_offset`, appends the indent, label, colon, and enough spaces to reach the configured width based on Unicode display width, converts it to a dimmed `Span<'static>`, and returns it.

**Call relations**: This private helper is called by `full_spans` whenever a field line or inline span set is built. It encapsulates the exact label-column formatting policy.

*Call graph*: called by 1 (full_spans); 3 external calls (from, with_capacity, width).


##### `push_label`  (lines 85–93)

```
fn push_label(labels: &mut Vec<String>, seen: &mut BTreeSet<String>, label: &str)
```

**Purpose**: Adds a label to an ordered label list only if it has not already been seen. This lets renderers gather optional fields while preserving first-seen order and avoiding duplicates.

**Data flow**: Takes mutable `labels: Vec<String>`, mutable `seen: BTreeSet<String>`, and `&str` label. It checks `seen.contains(label)` and returns early if present; otherwise it allocates `label.to_string()`, inserts a clone into `seen`, pushes the owned string into `labels`, and returns `()`.

**Call relations**: This helper is called by `collect_rate_limit_labels` and `display_lines` while assembling the complete label set before formatter construction.

*Call graph*: called by 2 (collect_rate_limit_labels, display_lines); 2 external calls (contains, insert).


##### `line_display_width`  (lines 95–99)

```
fn line_display_width(line: &Line<'static>) -> usize
```

**Purpose**: Measures the total Unicode display width of a rendered line by summing the widths of all span contents. It is used for fit checks that must respect terminal column width rather than byte length.

**Data flow**: Takes `&Line<'static>`, iterates its spans, measures each span's content with `UnicodeWidthStr::width`, sums the widths, and returns the total `usize`. It reads only the line contents.

**Call relations**: This helper is used by `rate_limit_row_lines` to decide whether progress bars and reset timestamps fit inline or need to be simplified/wrapped.

*Call graph*: called by 1 (rate_limit_row_lines); 1 external calls (iter).


##### `truncate_line_to_width`  (lines 101–147)

```
fn truncate_line_to_width(line: Line<'static>, max_width: usize) -> Line<'static>
```

**Purpose**: Truncates a styled line to a maximum display width while preserving span styles and respecting Unicode character widths. It avoids splitting by bytes and keeps zero-width spans intact.

**Data flow**: Takes ownership of a `Line<'static>` and a `max_width`. If `max_width` is zero it returns an empty line. Otherwise it walks the input spans in order, converting each span's content to owned text and measuring its display width. Zero-width spans are copied through unchanged. Fully fitting spans are copied whole and advance the used-width counter. For the first partially fitting span, it builds a truncated string character by character using `UnicodeWidthChar::width`, pushes the styled truncated span if non-empty, then stops. It returns a new `Line<'static>` containing the retained spans.

**Call relations**: This helper is used by status rendering after content width has been chosen, ensuring final bordered output does not exceed the computed inner width.

*Call graph*: 7 external calls (from, styled, new, width, width, new, new).


### `tui/src/status/helpers.rs`

`util` · `cross-cutting status rendering`

This file is a collection of pure-ish helper functions that normalize status-facing text before higher-level status composition renders it. The path helpers are the most nuanced: `compose_agents_summary` walks a list of `AbsolutePathBuf` agent files and tries to present each path relative to `config.cwd` when possible, falling back to simplified absolute paths. It special-cases files directly inside the cwd, computes `../` prefixes when the parent directory is an ancestor reached by walking upward, and otherwise uses `dunce::simplified` to remove Windows path oddities. `format_directory_display` separately formats arbitrary directories relative to the user’s home directory via `relativize_to_home`, and optionally truncates over-wide paths with `text_formatting::center_truncate_path` using Unicode display width rather than byte length.

The remaining helpers shape compact labels for status cards: `compose_model_display` extracts specific model metadata keys (`reasoning effort`, `reasoning summaries`) into normalized detail strings; `plan_type_display_name` remaps protocol `PlanType` variants to product-facing labels such as Business, Enterprise, and Pro Lite; `format_tokens_compact` emits K/M/B/T suffixes with adaptive decimal precision and trims trailing zeroes; and `format_reset_timestamp` shows either `HH:MM` or `HH:MM on D Mon` depending on whether the reset crosses a date boundary relative to the capture time. Tests focus on plan label remapping and agent-path display behavior, especially global-vs-project ordering and absolute-path fallback.

#### Function details

##### `normalize_agents_display_path`  (lines 12–14)

```
fn normalize_agents_display_path(path: &Path) -> String
```

**Purpose**: Converts a filesystem path into a simplified display string using `dunce::simplified` before formatting it for the status UI.

**Data flow**: It takes a `&Path`, reads no external state, simplifies platform-specific path syntax, then returns the path’s display form as an owned `String`.

**Call relations**: It is only used as a fallback inside `compose_agents_summary` when a path cannot be shown as a simple cwd-relative filename or upward `../` path.

*Call graph*: called by 1 (compose_agents_summary); 1 external calls (simplified).


##### `compose_model_display`  (lines 16–34)

```
fn compose_model_display(
    model_name: &str,
    entries: &[(&str, String)],
) -> (String, Vec<String>)
```

**Purpose**: Builds the model name plus a list of human-readable reasoning-related detail strings from key/value metadata entries.

**Data flow**: It accepts a `model_name` and a slice of `(&str, String)` entries, scans for the exact keys `reasoning effort` and `reasoning summaries`, lowercases and normalizes those values, and returns `(model_name.to_string(), details_vec)`.

**Call relations**: It is invoked by higher-level status construction when assembling the model section, and it does not delegate beyond basic formatting.

*Call graph*: called by 1 (new); 2 external calls (new, format!).


##### `compose_agents_summary`  (lines 36–80)

```
fn compose_agents_summary(config: &Config, paths: &[AbsolutePathBuf]) -> String
```

**Purpose**: Formats a comma-separated summary of agent file paths, preferring cwd-relative names when possible and readable absolute paths otherwise.

**Data flow**: It reads `config.cwd` plus a slice of `AbsolutePathBuf`. For each path it extracts the filename, compares the parent against the cwd, optionally computes repeated `..{sep}` prefixes by walking cwd ancestors, otherwise tries `strip_prefix(&config.cwd)`, and finally falls back to normalized absolute display. It returns `"<none>"` for an empty input or a joined string of all rendered paths.

**Call relations**: This helper is exercised directly by tests in this file and is consumed by status composition code that wants a single agents summary string. Internally it delegates path cleanup to `normalize_agents_display_path`.

*Call graph*: calls 1 internal fn (normalize_agents_display_path); called by 1 (compose_agents_summary_orders_global_before_project_agents); 2 external calls (new, format!).


##### `compose_account_display`  (lines 82–86)

```
fn compose_account_display(
    account_display: Option<&StatusAccountDisplay>,
) -> Option<StatusAccountDisplay>
```

**Purpose**: Passes through an optional `StatusAccountDisplay` by cloning it into owned form.

**Data flow**: It takes `Option<&StatusAccountDisplay>`, clones the inner value when present, and returns `Option<StatusAccountDisplay>` without modifying any shared state.

**Call relations**: It is called from status assembly code that needs an owned account-display payload rather than a borrowed reference.

*Call graph*: called by 1 (new).


##### `plan_type_display_name`  (lines 88–98)

```
fn plan_type_display_name(plan_type: PlanType) -> String
```

**Purpose**: Maps protocol `PlanType` values to the product labels shown in status output, including several explicit remappings.

**Data flow**: It takes a `PlanType`, checks `is_team_like`, `is_business_like`, and equality with `PlanType::ProLite`, then returns either a hard-coded label or a title-cased debug-name string.

**Call relations**: This is a leaf formatter used wherever plan names are rendered; it delegates unknown-case prettification to `title_case`.

*Call graph*: calls 1 internal fn (title_case); 3 external calls (is_business_like, is_team_like, format!).


##### `format_tokens_compact`  (lines 100–139)

```
fn format_tokens_compact(value: i64) -> String
```

**Purpose**: Formats a non-negative token count into a compact K/M/B/T string with adaptive precision.

**Data flow**: It accepts an `i64`, clamps negatives to zero, chooses a suffix bucket based on magnitude, computes a scaled `f64`, selects 2/1/0 decimals depending on scale, trims trailing zeroes and a trailing decimal point, and returns the compact string.

**Call relations**: It is used by token-usage and context-window span builders so those callers can display large counts in narrow status layouts.

*Call graph*: called by 2 (context_window_spans, token_usage_spans); 1 external calls (format!).


##### `format_directory_display`  (lines 141–162)

```
fn format_directory_display(directory: &Path, max_width: Option<usize>) -> String
```

**Purpose**: Formats a directory path for display, optionally home-relativizing it and truncating it to a maximum visual width.

**Data flow**: It takes a `&Path` and optional width. It first asks `relativize_to_home` for a home-relative path, converting an empty relative path to `~` and non-empty ones to `~/{rel}`; otherwise it uses the raw display string. If `max_width` is present, it returns an empty string for zero width or center-truncates over-wide paths using Unicode width measurement.

**Call relations**: It is called by status line rendering code when producing directory rows. It delegates home shortening to `relativize_to_home` and width-aware truncation to `text_formatting::center_truncate_path`.

*Call graph*: calls 2 internal fn (relativize_to_home, center_truncate_path); called by 1 (display_lines); 4 external calls (display, new, width, format!).


##### `format_reset_timestamp`  (lines 164–171)

```
fn format_reset_timestamp(dt: DateTime<Local>, captured_at: DateTime<Local>) -> String
```

**Purpose**: Formats a reset time relative to the snapshot capture date so same-day resets stay compact while later resets include a date.

**Data flow**: It takes `dt` and `captured_at` as `DateTime<Local>`, formats the time as `%H:%M`, compares `date_naive()` values, and returns either just the time or `"{time} on {day month}"`.

**Call relations**: This helper is reused by rate-limit display shaping so all reset labels in a draw cycle use the same date-relative convention.

*Call graph*: 3 external calls (date_naive, format, format!).


##### `title_case`  (lines 173–183)

```
fn title_case(s: &str) -> String
```

**Purpose**: Uppercases the first character of a string and lowercases the remaining ASCII characters.

**Data flow**: It takes `&str`, returns an empty string for empty input, otherwise splits off the first `char`, lowercases the remainder with ASCII rules, and concatenates the transformed pieces into a new `String`.

**Call relations**: It is only used by `plan_type_display_name` to prettify fallback enum debug names.

*Call graph*: called by 1 (plan_type_display_name); 1 external calls (new).


##### `tests::test_config`  (lines 193–200)

```
async fn test_config(codex_home: &TempDir, cwd: &TempDir) -> Config
```

**Purpose**: Builds a test `Config` with a temporary codex home and cwd for path-formatting tests.

**Data flow**: It takes two `TempDir` references, feeds their paths into `ConfigBuilder`, awaits `build()`, and returns the resulting `Config` or panics on failure.

**Call relations**: It is a shared async fixture for the agent-summary tests in this module.

*Call graph*: 2 external calls (path, default).


##### `tests::plan_type_display_name_remaps_display_labels`  (lines 203–222)

```
fn plan_type_display_name_remaps_display_labels()
```

**Purpose**: Verifies that each relevant `PlanType` variant renders to the expected user-facing label.

**Data flow**: It constructs a table of `(PlanType, expected_str)` pairs, iterates through them, and asserts that `plan_type_display_name` matches each expected string.

**Call relations**: This test directly exercises the remapping logic, especially the Business/Enterprise/Pro Lite special cases.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::compose_agents_summary_includes_global_agents_path`  (lines 225–235)

```
async fn compose_agents_summary_includes_global_agents_path()
```

**Purpose**: Checks that a global agents file outside the cwd is displayed using the same formatting as a standalone directory/path formatter.

**Data flow**: It creates temporary codex-home and cwd directories, builds a config, constructs a global path under codex-home, calls `compose_agents_summary`, and compares the result to `format_directory_display` on that path.

**Call relations**: This test validates the absolute-path fallback branch of `compose_agents_summary`.

*Call graph*: 3 external calls (new, assert_eq!, test_config).


##### `tests::compose_agents_summary_names_global_agents_override`  (lines 238–248)

```
async fn compose_agents_summary_names_global_agents_override()
```

**Purpose**: Confirms that a global override file path is rendered by name/path rather than omitted or rewritten incorrectly.

**Data flow**: It creates temp directories and a config, builds an override path under codex-home, runs `compose_agents_summary`, and asserts equality with `format_directory_display` for that path.

**Call relations**: Like the previous test, it covers non-cwd agent paths, specifically the override naming case.

*Call graph*: 3 external calls (new, assert_eq!, test_config).


##### `tests::compose_agents_summary_orders_global_before_project_agents`  (lines 251–273)

```
async fn compose_agents_summary_orders_global_before_project_agents()
```

**Purpose**: Ensures the summary preserves input ordering so global agent paths appear before project-local ones when passed in that order.

**Data flow**: It creates one global and one project path, calls `compose_agents_summary` with both, splits the comma-separated output, and asserts the first entry matches the global path while the second ends with the project filename.

**Call relations**: This test exercises the full summary join behavior and confirms no internal sorting reorders the caller-provided path list.

*Call graph*: calls 1 internal fn (compose_agents_summary); 4 external calls (new, assert!, assert_eq!, test_config).


### `tui/src/status/remote_connection.rs`

`util` · `status snapshot assembly`

This module is narrowly focused on the remote-connection section of status output. Its data model is `RemoteConnectionStatus`, a simple pair of `address` and `version` strings. The main function, `remote_connection_status_value`, inspects the current `AppServerTarget` and returns `None` for `Embedded`, because there is no remote endpoint to display. For `LocalDaemon` and `Remote`, it extracts the shared endpoint and formats it according to transport type.

WebSocket endpoints are sanitized before display: `sanitized_websocket_display_address` parses the raw URL with `url::Url`, clears the username and password, and strips query and fragment components. That removes embedded credentials and tokens from status output while preserving the scheme, host, port, and path. If parsing fails, the caller substitutes the explicit placeholder `<invalid websocket URL>`. Unix-socket endpoints are rendered as `unix://{socket_path}` using the path’s display form.

Version formatting is intentionally simple and user-facing: a provided version becomes `v{version}`, while absence becomes `unknown`. The included test covers all three important branches: embedded targets returning `None`, WebSocket sanitization removing secrets and query parameters, and Unix-socket formatting with an unknown version fallback.

#### Function details

##### `remote_connection_status_value`  (lines 11–34)

```
fn remote_connection_status_value(
    app_server_target: &AppServerTarget,
    server_version: Option<&str>,
) -> Option<RemoteConnectionStatus>
```

**Purpose**: Converts the current app-server target and optional server version into an optional `RemoteConnectionStatus` for display.

**Data flow**: It takes `&AppServerTarget` and `Option<&str>`. It pattern-matches the target, returning `None` for `Embedded`; otherwise it formats either a sanitized WebSocket URL or a `unix://` socket path, prefixes the version with `v` when present, substitutes `unknown` when absent, and returns `Some(RemoteConnectionStatus)`.

**Call relations**: It is called from the status run path when building the remote-connection section. For WebSocket endpoints it delegates sanitization to `sanitized_websocket_display_address`.

*Call graph*: calls 1 internal fn (sanitized_websocket_display_address); called by 1 (run); 1 external calls (format!).


##### `sanitized_websocket_display_address`  (lines 36–43)

```
fn sanitized_websocket_display_address(raw: &str) -> Option<String>
```

**Purpose**: Parses a WebSocket URL and removes credentials, query parameters, and fragments before display.

**Data flow**: It takes a raw URL string, parses it with `Url::parse`, clears username and password, sets query and fragment to `None`, and returns the sanitized URL string or `None` if parsing fails.

**Call relations**: It is only used by `remote_connection_status_value` to avoid leaking auth material in status output.

*Call graph*: called by 1 (remote_connection_status_value); 1 external calls (parse).


##### `tests::remote_connection_status_value_formats_display_value`  (lines 51–85)

```
fn remote_connection_status_value_formats_display_value() -> color_eyre::Result<()>
```

**Purpose**: Validates embedded omission, WebSocket sanitization, Unix-socket formatting, and version fallback behavior.

**Data flow**: It constructs representative `AppServerTarget` values, calls `remote_connection_status_value` for each, and asserts exact equality with the expected `Option<RemoteConnectionStatus>` values.

**Call relations**: This test covers the module’s full public behavior, especially the sanitization contract for remote URLs.

*Call graph*: calls 1 internal fn (relative_to_current_dir); 1 external calls (assert_eq!).


### Specialized visual components
These files provide focused presentation helpers for chart palettes and reusable history-cell composition used elsewhere in the TUI.

### `tui/src/chatwidget/tokens/chart/palette.rs`

`util` · `request handling`

This module encapsulates all style and glyph decisions for token-activity charts. `TokenActivityPalette` stores five per-level styles for daily heatmap cells, one shared bar style for weekly/cumulative charts, and a `uses_color` flag that determines whether intensity is encoded primarily by color or by glyph choice. `current()` gathers runtime terminal information—default foreground/background RGB values, stdout color level, and a theme-derived activity accent—and passes them into `from_parts()`.

`from_parts()` is the core constructor. If terminal colors are missing, the theme accent is not RGB, or the terminal only supports `Ansi16`/unknown color levels, it falls back to `fallback()`: empty cells are dim, active cells all share the accent style, and `uses_color` is false. Otherwise it computes a blended gradient. Empty-cell intensity is blended from terminal foreground toward background using a slightly different alpha for light versus dark backgrounds, while active levels blend the accent color toward the background across fixed alpha steps. A separate bar style uses a stronger accent blend. All RGB colors are quantized through `best_color_for_level()` to match terminal capability.

`for_level()` and `for_bar_level()` expose the chosen styles, while `glyph()` selects between hollow/filled squares for daily charts and spaces/full blocks for bar charts. The design intentionally keeps low-color terminals readable by using glyph differences when color alone would be insufficient.

#### Function details

##### `TokenActivityPalette::current`  (lines 40–47)

```
fn current() -> Self
```

**Purpose**: Builds a palette from the live terminal environment and current theme accent. It is the runtime entry point used by chart rendering.

**Data flow**: Reads terminal foreground and background RGB values via `default_fg()` and `default_bg()`, reads terminal color capability via `stdout_color_level()`, computes the theme accent style with `theme_activity_style()`, and passes all four inputs into `Self::from_parts(...)`, returning the resulting palette.

**Call relations**: Called by `chart_lines` before rendering chart cells. It delegates all decision-making to `from_parts`, serving mainly as environment collection glue.

*Call graph*: calls 4 internal fn (theme_activity_style, default_bg, default_fg, stdout_color_level); called by 1 (chart_lines); 1 external calls (from_parts).


##### `TokenActivityPalette::from_parts`  (lines 49–91)

```
fn from_parts(
        default_fg: Option<(u8, u8, u8)>,
        default_bg: Option<(u8, u8, u8)>,
        color_level: StdoutColorLevel,
        active_style: Style,
    ) -> Self
```

**Purpose**: Constructs either a blended truecolor/extended-color palette or a fallback accent-only palette from explicit terminal and theme inputs. This is the core palette-selection algorithm.

**Data flow**: Accepts optional default foreground/background RGB tuples, a `StdoutColorLevel`, and an active accent `Style`. It first extracts an RGB anchor from the accent with `activity_anchor_rgb`; if any required RGB input is missing, or if the color level is `Ansi16` or `Unknown`, it returns `fallback(active_style)`. Otherwise it chooses an empty-cell alpha based on whether the background is light, defines fixed alpha steps, builds five styles with `std::array::from_fn` by blending either foreground or accent against background and quantizing with `best_color_for_level`, computes a separate blended `bar_style`, and returns `TokenActivityPalette { styles, bar_style, uses_color: true }`.

**Call relations**: Used by `current` in production and directly by palette tests with controlled inputs. It delegates fallback construction to `fallback` and RGB extraction to `activity_anchor_rgb`.

*Call graph*: calls 4 internal fn (activity_anchor_rgb, blend, is_light, best_color_for_level); called by 5 (ansi16_palette_uses_theme_accent_without_green_fallback, missing_terminal_colors_use_theme_accent_fallback, non_rgb_theme_accent_remains_active_fallback, truecolor_palette_blends_empty_cell_for_light_background, truecolor_palette_blends_theme_accent_against_dark_background); 3 external calls (default, matches!, from_fn).


##### `TokenActivityPalette::fallback`  (lines 93–106)

```
fn fallback(active_style: Style) -> Self
```

**Purpose**: Builds the low-information palette used when terminal/theme RGB data is insufficient or color capability is too limited. In this mode glyph differences carry most of the chart semantics.

**Data flow**: Takes an active accent `Style`, creates `empty_style = Style::default().dim()`, and returns a palette whose level 0 style is dim, levels 1 through 4 all reuse `active_style`, `bar_style` is also `active_style`, and `uses_color` is `false`.

**Call relations**: Called internally by `from_parts` whenever blended color gradients are not viable.

*Call graph*: 1 external calls (default).


##### `TokenActivityPalette::for_level`  (lines 108–110)

```
fn for_level(&self, level: usize) -> Style
```

**Purpose**: Returns the style for a daily heatmap intensity level, clamping out-of-range requests to the highest defined level. This keeps callers simple and safe.

**Data flow**: Takes `&self` and a `usize` level, clamps it with `min(4)`, indexes `self.styles`, and returns the selected `Style` by copy.

**Call relations**: Used by `legend_line` and by `for_bar_level` when bar cells are empty.

*Call graph*: called by 2 (legend_line, for_bar_level).


##### `TokenActivityPalette::for_bar_level`  (lines 112–118)

```
fn for_bar_level(&self, level: usize) -> Style
```

**Purpose**: Returns the style for a weekly/cumulative bar-chart cell. Empty bar cells reuse level-0 styling, while any filled bar cell uses the shared bar style.

**Data flow**: Takes `&self` and a level. If the level is zero it delegates to `self.for_level(0)`; otherwise it returns `self.bar_style`.

**Call relations**: Called by chart rendering for non-daily views. It reuses `for_level` for empty cells so empty bars visually match empty daily cells.

*Call graph*: calls 1 internal fn (for_level).


##### `TokenActivityPalette::glyph`  (lines 125–134)

```
fn glyph(&self, view: TokenActivityView, level: usize) -> &'static str
```

**Purpose**: Chooses the glyph string for one chart cell based on view, level, and whether the palette can rely on color gradients. Daily charts may use hollow vs filled squares; bar charts use spaces vs full blocks.

**Data flow**: Takes `&self`, a `TokenActivityView`, and a level. For non-daily views it returns a space for level 0 and `BAR_CELL_GLYPH` for nonzero levels. For daily view it returns `ACTIVE_CELL_GLYPH` if `uses_color` is true or the level is nonzero; otherwise it returns `EMPTY_CELL_GLYPH`.

**Call relations**: Used by chart rendering and the daily legend. Its behavior is tightly coupled to `uses_color`, which is set by `from_parts`.

*Call graph*: called by 1 (legend_line).


##### `theme_activity_style`  (lines 137–141)

```
fn theme_activity_style() -> Style
```

**Purpose**: Derives the base accent style for token-activity charts from syntax-highlight scopes, with a fallback to the application accent style. The result is always bolded.

**Data flow**: Calls `foreground_style_for_scopes(&["entity.name.type", "support.type", "variable"])`; if a style is found it uses that, otherwise it falls back to `accent_style()`, then applies `.bold()` and returns the resulting `Style`.

**Call relations**: Called only by `TokenActivityPalette::current` to seed palette construction with a theme-aware accent.

*Call graph*: calls 1 internal fn (foreground_style_for_scopes); called by 1 (current).


##### `activity_anchor_rgb`  (lines 143–148)

```
fn activity_anchor_rgb(style: Style) -> Option<(u8, u8, u8)>
```

**Purpose**: Extracts an RGB tuple from a style’s foreground color when possible. Non-RGB colors intentionally return `None` so palette construction can fall back.

**Data flow**: Takes a `Style`, reads `style.fg`, and matches it: `Color::Rgb(r, g, b)` becomes `Some((r, g, b))`; any other foreground color or missing foreground becomes `None`.

**Call relations**: Used by `from_parts` as the gate for blended palette generation. If it returns `None`, `from_parts` chooses the fallback palette.

*Call graph*: called by 1 (from_parts).


### `tui/src/history_cell/base.rs`

`util` · `cross-cutting`

This file is the foundation of the TUI transcript rendering model. `PlainHistoryCell` is the simplest implementation: it stores a `Vec<Line<'static>>` and returns clones for display, while `raw_lines` strips styling and hyperlinks through `plain_lines`. `WebHyperlinkHistoryCell` is similar but overrides hyperlink-oriented methods so web URLs are annotated via `crate::terminal_hyperlinks::annotate_web_urls`; transcript hyperlink rendering is intentionally identical to viewport hyperlink rendering. `PrefixedWrappedHistoryCell` stores a `Text<'static>` plus separate initial and subsequent prefixes, then wraps the text at render time using `adaptive_wrap_lines` and `RtOptions`. It explicitly returns no lines for width 0, avoiding invalid wrapping behavior in tiny layouts. `CompositeHistoryCell` is the vertical concatenation primitive: it owns boxed child `HistoryCell`s and, for display, hyperlink display, transcript hyperlink output, and raw output alike, iterates children in order, inserts a blank separator only between non-empty parts, and appends each child’s lines. This means empty children disappear cleanly without producing stray blank lines. Together these types let higher-level modules focus on domain wording while reusing consistent wrapping, hyperlink annotation, and multi-part layout behavior.

#### Function details

##### `PlainHistoryCell::new`  (lines 11–13)

```
fn new(lines: Vec<Line<'static>>) -> Self
```

**Purpose**: Constructs a plain history cell from already prepared terminal lines. It is the standard container for static, non-wrapping transcript content.

**Data flow**: Consumes a `Vec<Line<'static>>` and stores it directly in a new `PlainHistoryCell`. It returns the cell by value and does not transform the lines.

**Call relations**: This constructor is widely used across the TUI wherever callers already have final lines and do not need special hyperlink or wrapping behavior.

*Call graph*: called by 16 (plain_line_cell, handle_permissions_decision, add_plain_history_lines, rename_confirmation_cell, emit_forked_thread_event, completed_token_activity_refresh_waits_for_active_history_cell, pending_token_activity_refresh_keeps_composer_visible_in_short_viewport, startup_reset_hint_waits_for_active_output_snapshot, new_token_activity_output, new_debug_config_output (+6 more)).


##### `PlainHistoryCell::display_lines`  (lines 17–19)

```
fn display_lines(&self, _width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns the stored lines exactly as they were provided. Width is ignored because this cell does not perform wrapping or reflow.

**Data flow**: Reads `self.lines`, clones the vector, and returns it. It does not mutate state or inspect the `_width` argument.

**Call relations**: This method is used by generic history rendering paths such as text extraction, relying on `PlainHistoryCell` to be a transparent container.

*Call graph*: called by 1 (cell_to_text).


##### `PlainHistoryCell::raw_lines`  (lines 21–23)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces an unstyled/plain-text version of the stored lines. It is used for transcript export or comparisons where terminal styling should be removed.

**Data flow**: Clones `self.lines`, passes them to `plain_lines`, and returns the resulting `Vec<Line<'static>>`. No state is modified.

**Call relations**: This is the raw-output counterpart to `display_lines`, used by generic transcript consumers that want plain content.


##### `WebHyperlinkHistoryCell::new`  (lines 32–34)

```
fn new(lines: Vec<Line<'static>>) -> Self
```

**Purpose**: Constructs a history cell whose stored lines should be scanned for web URLs and exposed as hyperlink metadata. It is a convenience wrapper around plain line storage with hyperlink-aware rendering.

**Data flow**: Consumes a `Vec<Line<'static>>`, stores it in the `lines` field, and returns the new cell. It performs no transformation at construction time.

**Call relations**: This constructor is used by callers that already have final lines but want automatic URL hyperlink annotation during rendering.

*Call graph*: called by 1 (feedback_success_cell).


##### `WebHyperlinkHistoryCell::display_lines`  (lines 38–40)

```
fn display_lines(&self, _width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns the stored visible lines without hyperlink metadata. Width is ignored because the cell stores final lines directly.

**Data flow**: Clones and returns `self.lines`. It does not mutate state or use the `_width` parameter.

**Call relations**: This method serves plain viewport rendering, while hyperlink-aware consumers use the specialized hyperlink methods on the same cell.


##### `WebHyperlinkHistoryCell::display_hyperlink_lines`  (lines 42–44)

```
fn display_hyperlink_lines(&self, _width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Annotates the stored lines with hyperlink metadata for visible rendering. It turns plain URL text into `HyperlinkLine` structures understood by the terminal layer.

**Data flow**: Clones `self.lines`, passes them to `crate::terminal_hyperlinks::annotate_web_urls`, and returns the resulting `Vec<HyperlinkLine>`. It does not modify internal state.

**Call relations**: This method is the hyperlink-aware rendering path for the cell and is reused directly by `transcript_hyperlink_lines` so transcript and viewport hyperlink behavior stay aligned.

*Call graph*: calls 1 internal fn (annotate_web_urls); called by 1 (transcript_hyperlink_lines).


##### `WebHyperlinkHistoryCell::transcript_hyperlink_lines`  (lines 46–48)

```
fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Returns hyperlink-annotated lines for transcript rendering using the same logic as viewport rendering. There is intentionally no separate transcript-specific transformation.

**Data flow**: Accepts a width argument, forwards it to `display_hyperlink_lines`, and returns that result. No state changes occur.

**Call relations**: This method simply delegates to `display_hyperlink_lines`, ensuring one hyperlink annotation path for both transcript and on-screen display.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `WebHyperlinkHistoryCell::raw_lines`  (lines 50–52)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces plain, unannotated raw lines from the stored content. It strips hyperlink metadata and styling for raw transcript output.

**Data flow**: Clones `self.lines`, passes them through `plain_lines`, and returns the resulting vector. It does not mutate the cell.

**Call relations**: This is the raw-output companion to the cell’s visible and hyperlink-aware rendering methods.


##### `PrefixedWrappedHistoryCell::new`  (lines 62–72)

```
fn new(
        text: impl Into<Text<'static>>,
        initial_prefix: impl Into<Line<'static>>,
        subsequent_prefix: impl Into<Line<'static>>,
    ) -> Self
```

**Purpose**: Constructs a wrapped text cell with distinct prefixes for the first and subsequent visual lines. It is the standard primitive for bullet-like transcript rows that need width-aware wrapping.

**Data flow**: Accepts any values convertible into `Text<'static>` and `Line<'static>` for the body and prefixes, converts them with `Into`, stores them in the struct, and returns the new cell.

**Call relations**: This constructor is used by many higher-level history-cell factories—approval rows, warnings, and similar one-block messages—so they can share consistent wrapping and indentation behavior.

*Call graph*: called by 11 (new_approval_decision_cell, new_guardian_approved_action_request, new_guardian_denied_action_request, new_guardian_denied_patch_request, new_guardian_timed_out_action_request, new_guardian_timed_out_patch_request, new_warning_event, display_lines, prefixed_wrapped_history_cell_does_not_split_url_like_token, prefixed_wrapped_history_cell_height_matches_wrapped_rendering (+1 more)); 1 external calls (into).


##### `PrefixedWrappedHistoryCell::display_lines`  (lines 76–84)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Wraps the stored text to the requested width while applying the configured first-line and continuation prefixes. It gracefully returns no output for zero-width layouts.

**Data flow**: Reads `self.text`, `self.initial_prefix`, and `self.subsequent_prefix`. If `width == 0`, it returns an empty vector. Otherwise it builds `RtOptions` with the width and cloned prefixes, passes them to `adaptive_wrap_lines`, and returns the wrapped `Vec<Line<'static>>`.

**Call relations**: This is the core rendering behavior that callers rely on after constructing the cell with `new`; it encapsulates all width-sensitive wrapping and indentation.

*Call graph*: calls 1 internal fn (new); 2 external calls (clone, new).


##### `PrefixedWrappedHistoryCell::raw_lines`  (lines 86–88)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns the underlying text content as plain raw lines without wrapping prefixes. This preserves semantic content while dropping viewport-specific indentation.

**Data flow**: Clones `self.text.lines`, passes them to `plain_lines`, and returns the result. It does not inspect width or mutate state.

**Call relations**: This raw-output path complements `display_lines`, allowing transcript export to avoid embedding visual wrap prefixes.

*Call graph*: 1 external calls (clone).


##### `CompositeHistoryCell::new`  (lines 96–98)

```
fn new(parts: Vec<Box<dyn HistoryCell>>) -> Self
```

**Purpose**: Constructs a history cell that vertically concatenates multiple child cells. It is used when one transcript artifact is naturally composed of several independently rendered parts.

**Data flow**: Consumes a `Vec<Box<dyn HistoryCell>>`, stores it in `parts`, and returns the new composite cell. It performs no rendering at construction time.

**Call relations**: This constructor is used by higher-level modules that want to combine command lines, summaries, and other subcells into one logical transcript entry.

*Call graph*: called by 4 (new_token_activity_output, new_unified_exec_processes_output, composite_cell_preserves_child_web_links, new_status_output_with_rate_limits_handle).


##### `CompositeHistoryCell::display_lines`  (lines 102–116)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Renders each child cell’s visible lines and concatenates them with blank separators between non-empty parts. Empty children are skipped without introducing extra spacing.

**Data flow**: Reads `self.parts`, iterates in order, calls each child’s `display_lines(width)`, and appends non-empty results into an output vector. Before every non-first non-empty child it inserts `Line::from("")`. It returns the assembled `Vec<Line<'static>>`.

**Call relations**: This method is the visible-rendering composition path for composite cells, mirroring the same separator policy used by the hyperlink and raw variants.

*Call graph*: 2 external calls (from, new).


##### `CompositeHistoryCell::display_hyperlink_lines`  (lines 118–132)

```
fn display_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Concatenates child hyperlink-rendered lines with blank hyperlink separators between non-empty parts. It preserves each child’s own hyperlink metadata.

**Data flow**: Iterates `self.parts`, calls `display_hyperlink_lines(width)` on each child, inserts `HyperlinkLine::from("")` between non-empty child outputs, and returns the combined vector.

**Call relations**: This is the hyperlink-aware counterpart to `display_lines`, used when transcript rendering needs clickable links across a multi-part cell.

*Call graph*: calls 1 internal fn (from); 1 external calls (new).


##### `CompositeHistoryCell::transcript_hyperlink_lines`  (lines 134–148)

```
fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Builds transcript hyperlink output by concatenating each child’s transcript hyperlink lines with blank separators. It preserves transcript-specific hyperlink behavior of each child.

**Data flow**: Iterates over `self.parts`, calls `transcript_hyperlink_lines(width)` on each child, inserts blank `HyperlinkLine`s between non-empty sections, and returns the assembled vector.

**Call relations**: This method mirrors `display_hyperlink_lines` but respects any child-specific distinction between viewport and transcript hyperlink rendering.

*Call graph*: calls 1 internal fn (from); 1 external calls (new).


##### `CompositeHistoryCell::raw_lines`  (lines 150–164)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Concatenates each child’s raw lines with blank separators between non-empty parts. It produces a plain-text composite transcript representation.

**Data flow**: Iterates `self.parts`, calls `raw_lines()` on each child, inserts `Line::from("")` between non-empty child outputs, and returns the combined `Vec<Line<'static>>`.

**Call relations**: This raw composition path parallels the visible and hyperlink variants so all output modes preserve the same section boundaries.

*Call graph*: 2 external calls (from, new).
