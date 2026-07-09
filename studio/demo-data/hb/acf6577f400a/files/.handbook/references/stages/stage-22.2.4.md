# TUI presentation models, styling, and lightweight view helpers  `stage-22.2.4`

This stage is shared behind-the-scenes support for the terminal user interface. It sits above the low-level text drawing code and prepares what the user will see: colors, labels, rows, popups, footers, and status text. The color, style, chart palette, and spacing files choose readable colors, symbols, and margins so screens stay consistent on different terminals. The renderable building blocks let text and containers report their size and draw themselves.

Several files shape common controls. Key hints make shortcuts display consistently. Scroll state, selection rows, selection popups, and selection tabs keep lists, tabs, highlights, wrapping, and disabled choices predictable. The footer, action-required title, and popup constants build the bottom-pane messages that guide the user.

Other helpers turn internal data into friendly display models. Warning logic avoids repeated chat warnings. Migration, goal, skill, status, and remote-connection helpers convert raw settings, paths, counts, times, server details, and skill metadata into short readable text. History cells provide reusable transcript pieces, including wrapped text and links.

## Files in this stage

### Styling and layout primitives
These files define the shared color, style, layout, and renderable foundations that higher-level TUI presentation helpers build on.

### `tui/src/color.rs`

`util` · `cross-cutting`

A terminal interface often has to adapt to many backgrounds and themes. A color that looks good on a dark background may be hard to read on a light one. This file is a small toolbox for making those choices more safely.

It works with RGB colors, meaning colors described as three numbers: red, green, and blue, each from 0 to 255. The `is_light` helper answers a basic question: is this background closer to light or dark? That lets other parts of the UI pick contrasting text or highlight colors.

The `blend` helper mixes one color over another, like putting a partly transparent sheet of colored plastic on top of a background. This is useful for subtle row backgrounds, overlays, separators, shimmer effects, and message bubbles without needing a completely separate hard-coded color for every theme.

The `perceptual_distance` helper estimates how far apart two colors appear to people. It converts ordinary screen RGB colors into a color space designed to better match human vision, then measures the distance there. This matters because two RGB values can be numerically different but visually similar, or the other way around.

#### Function details

##### `is_light`  (lines 1–5)

```
fn is_light(bg: (u8, u8, u8)) -> bool
```

**Purpose**: Decides whether an RGB color should be treated as a light background. Other UI code can use this to choose colors that remain readable instead of accidentally placing pale text on a pale background.

**Data flow**: It receives a background color as three numbers: red, green, and blue. It combines them using weights that reflect how bright each color appears to human eyes, with green counting the most and blue the least. It returns `true` if the calculated brightness is above the midpoint threshold, and `false` otherwise.

**Call relations**: Theme-building and styling code calls this when it needs to adapt to a background color. It is used during theme creation, automatic theme selection, dense row styling, loading overlay styling, and user message background styling so those places can branch between light-background and dark-background choices.

*Call graph*: called by 6 (from_parts, diff_theme_for_bg, adaptive_default_theme_selection, dense_row_background_style, transcript_loading_overlay_style, user_message_bg).


##### `blend`  (lines 7–12)

```
fn blend(fg: (u8, u8, u8), bg: (u8, u8, u8), alpha: f32) -> (u8, u8, u8)
```

**Purpose**: Mixes two RGB colors using an opacity value. It is used when the UI wants a color that feels layered or softened, rather than a hard switch from one color to another.

**Data flow**: It receives a foreground color, a background color, and an `alpha` value, which means how strongly the foreground should show through. For each red, green, and blue channel, it takes some of the foreground and the remaining amount from the background. It returns the newly mixed RGB color.

**Call relations**: Styling code calls this while building theme pieces and visual effects. It supplies blended colors for dense rows, transcript loading overlays, shimmer spans, table separators, and user message backgrounds, letting those features create subtle contrast from the colors they already have.

*Call graph*: called by 6 (from_parts, dense_row_background_style, transcript_loading_overlay_style, shimmer_spans, table_separator_style_for, user_message_bg).


##### `perceptual_distance`  (lines 16–75)

```
fn perceptual_distance(a: (u8, u8, u8), b: (u8, u8, u8)) -> f32
```

**Purpose**: Estimates how different two colors look to a person, not just how different their raw RGB numbers are. This is useful when the UI needs to avoid colors that are too visually close together.

**Data flow**: It receives two RGB colors. It first converts each color from standard screen RGB into a linear form, then into XYZ, and then into Lab, a color space meant to line up more closely with human perception. It then measures the straight-line distance between the two Lab colors and returns that distance as a floating-point number.

**Call relations**: This is a standalone helper in this file. The provided call graph does not show any current callers, but it is available to other UI code that needs a human-oriented color difference score.


### `tui/src/style.rs`

`domain_logic` · `cross-cutting during TUI rendering`

A terminal app cannot assume everyone has the same background color or the same color support. A pale highlight that looks good on a black terminal may disappear on a white one. This file solves that by choosing colors based on what the terminal reports about its foreground, background, and color capability.

The main idea is to provide a few reusable style recipes. User messages and proposed plans get a subtle background tint, made by blending a small amount of white or black into the current terminal background. Active or selected controls get a bold cyan-like accent; on light backgrounds, the cyan is darkened so it remains visible. Markdown table separators get an intentionally low-contrast color, so table rules are visible but do not compete with the text inside the table.

The file uses Ratatui styles, which are instructions for how terminal text should look: foreground color, background color, boldness, dimness, and so on. It also adapts to terminal color support. If true color is available, it can use the exact blended color. If only a 256-color palette is available, it chooses the nearest available color. If it cannot safely choose a palette-aware color, it falls back to a simple dim style.

#### Function details

##### `user_message_style`  (lines 17–19)

```
fn user_message_style() -> Style
```

**Purpose**: Returns the standard style for a message written by the user. It uses the current terminal background so the message can be lightly highlighted without becoming hard to read.

**Data flow**: It asks the terminal helper for the default background color, then passes that information to user_message_style_for. The result is a Ratatui Style with a subtle background color if the terminal background is known, or a plain default style if it is not.

**Call relations**: Rendering code calls this whenever it draws user-authored content. This function is the convenient public entry point; it gathers the live terminal background and hands the real color decision to user_message_style_for.

*Call graph*: calls 2 internal fn (user_message_style_for, default_bg); called by 7 (render, render_with_mask_and_textarea_right_reserve, render, render, render, render_menu_surface, render).


##### `proposed_plan_style`  (lines 21–23)

```
fn proposed_plan_style() -> Style
```

**Purpose**: Returns the standard style for a proposed plan shown in the interface. It currently uses the same kind of subtle background treatment as a user message.

**Data flow**: It reads the default terminal background and gives it to proposed_plan_style_for. The returned Style either contains a background tint or stays plain if the background is unknown.

**Call relations**: The display-line renderer calls this when it needs to draw proposed plan text. This wrapper supplies the current terminal background, while proposed_plan_style_for decides the exact style.

*Call graph*: calls 2 internal fn (proposed_plan_style_for, default_bg); called by 1 (render_display_lines).


##### `table_separator_style`  (lines 26–28)

```
fn table_separator_style() -> Style
```

**Purpose**: Returns a quiet, low-contrast style for the lines that separate cells in markdown tables. The goal is to keep table structure visible without letting the separator marks dominate the content.

**Data flow**: It reads the terminal's default foreground color, default background color, and color support level. It passes those three pieces of information to table_separator_style_for, which returns the best separator style for that environment.

**Call relations**: The table rendering code calls this when drawing markdown table rules. This function acts as the live-terminal wrapper around table_separator_style_for.

*Call graph*: calls 4 internal fn (table_separator_style_for, default_bg, default_fg, stdout_color_level); called by 1 (render_table_lines).


##### `accent_style`  (lines 31–33)

```
fn accent_style() -> Style
```

**Purpose**: Returns the shared accent style used for active or selected controls in the terminal interface. It makes selected things stand out consistently across different screens.

**Data flow**: It reads the terminal background and passes it to accent_style_for. The output is a bold foreground style, using regular cyan on dark or unknown backgrounds and a darker cyan-like color on light backgrounds.

**Call relations**: Selection rows, tabs, debug hints, picker hints, and keymap prefixes call this when they need the common highlight color. It centralizes that choice so selected UI pieces look consistent.

*Call graph*: calls 2 internal fn (accent_style_for, default_bg); called by 7 (event_table_lines, selected_event_rows_use_the_shared_accent_style, selected_rows_use_the_shared_accent_style, tab_unit, keymap_debug_hint_line, keymap_picker_hint_line, keymap_row_prefix).


##### `user_message_style_for`  (lines 36–41)

```
fn user_message_style_for(terminal_bg: Option<(u8, u8, u8)>) -> Style
```

**Purpose**: Builds the user-message style for a specific terminal background. This is useful when the caller already knows the background color, and it also makes the color logic easy to test.

**Data flow**: It receives an optional RGB background color. If a color is present, it computes a suitable message background with user_message_bg and returns a Style using that background. If no background is known, it returns a default Style with no special coloring.

**Call relations**: user_message_style calls this after reading the real terminal background. The function delegates the actual color calculation to user_message_bg.

*Call graph*: calls 1 internal fn (user_message_bg); called by 1 (user_message_style); 1 external calls (default).


##### `proposed_plan_style_for`  (lines 43–48)

```
fn proposed_plan_style_for(terminal_bg: Option<(u8, u8, u8)>) -> Style
```

**Purpose**: Builds the proposed-plan style for a specific terminal background. It gives proposed plans the same subtle background treatment used for user messages.

**Data flow**: It receives an optional RGB background color. When present, it calculates the background through proposed_plan_bg and returns a Style with that color. When absent, it returns an unmodified default Style.

**Call relations**: proposed_plan_style calls this after checking the terminal background. This function passes the color choice down to proposed_plan_bg.

*Call graph*: calls 1 internal fn (proposed_plan_bg); called by 1 (proposed_plan_style); 1 external calls (default).


##### `accent_style_for`  (lines 51–57)

```
fn accent_style_for(terminal_bg: Option<(u8, u8, u8)>) -> Style
```

**Purpose**: Chooses the accent color for a known or unknown terminal background. It exists so highlights remain visible whether the terminal is light, dark, or unable to report its background.

**Data flow**: It receives an optional RGB background color. If the background exists and is light, it picks a darker cyan-like color and makes it bold. Otherwise, it uses standard cyan and makes it bold. The result is a Ratatui Style.

**Call relations**: accent_style calls this during normal rendering after reading the terminal background. A test also calls it directly to confirm that light backgrounds get the darker accent.

*Call graph*: calls 1 internal fn (best_color); called by 2 (accent_style, accent_style_uses_darker_cyan_on_light_backgrounds); 1 external calls (default).


##### `table_separator_style_for`  (lines 59–73)

```
fn table_separator_style_for(
    terminal_fg: Option<(u8, u8, u8)>,
    terminal_bg: Option<(u8, u8, u8)>,
    color_level: StdoutColorLevel,
) -> Style
```

**Purpose**: Chooses the table separator style from explicit terminal colors and color capability. It keeps separators subtle by blending the foreground toward the background.

**Data flow**: It receives optional foreground and background RGB colors plus a color support level. If either color is missing, it returns a dim default style. If both are known, it blends the foreground with the background at low strength, then uses the exact RGB color for true-color terminals, the nearest palette color for 256-color terminals, or a dim fallback for basic or unknown color support.

**Call relations**: table_separator_style calls this with live terminal information when rendering tables. The table separator tests call it directly with fixed colors to prove the blend works on dark and light backgrounds.

*Call graph*: calls 3 internal fn (blend, best_color, rgb_color); called by 3 (table_separator_style, table_separator_blends_toward_dark_background, table_separator_blends_toward_light_background); 1 external calls (default).


##### `user_message_bg`  (lines 76–83)

```
fn user_message_bg(terminal_bg: (u8, u8, u8)) -> Color
```

**Purpose**: Calculates the actual background color used behind a user message. It creates a gentle tint that differs from the terminal background just enough to mark the message area.

**Data flow**: It receives the terminal background as an RGB color. If that background is light, it blends in a small amount of black; if it is dark, it blends in a small amount of white. It then chooses the best terminal color for that blended result and returns it.

**Call relations**: user_message_style_for calls this when it needs a background color. proposed_plan_bg also reuses it so proposed plans and user messages share the same visual treatment.

*Call graph*: calls 3 internal fn (blend, is_light, best_color); called by 2 (proposed_plan_bg, user_message_style_for).


##### `proposed_plan_bg`  (lines 86–88)

```
fn proposed_plan_bg(terminal_bg: (u8, u8, u8)) -> Color
```

**Purpose**: Returns the background color for proposed plan blocks. At the moment, it deliberately matches the user-message background.

**Data flow**: It receives the terminal background as an RGB color and passes it directly to user_message_bg. It returns whatever color user_message_bg chooses.

**Call relations**: proposed_plan_style_for calls this when building the proposed-plan Style. This small wrapper keeps the proposed-plan concept separate, even though it currently shares the user-message color.

*Call graph*: calls 1 internal fn (user_message_bg); called by 1 (proposed_plan_style_for).


##### `tests::accent_style_uses_darker_cyan_on_light_backgrounds`  (lines 97–102)

```
fn accent_style_uses_darker_cyan_on_light_backgrounds()
```

**Purpose**: Checks that the accent style stays readable on light terminal backgrounds. It confirms that the file does not use bright cyan on white, where it could be hard to see.

**Data flow**: The test gives accent_style_for a white background. It then checks that the foreground is the darker cyan-like accent color and that the style is bold.

**Call relations**: This test calls accent_style_for directly with a controlled background. It protects the behavior used indirectly by accent_style during real rendering.

*Call graph*: calls 1 internal fn (accent_style_for); 2 external calls (assert!, assert_eq!).


##### `tests::accent_style_uses_cyan_on_dark_or_unknown_backgrounds`  (lines 105–110)

```
fn accent_style_uses_cyan_on_dark_or_unknown_backgrounds()
```

**Purpose**: Checks that the normal accent style is bold cyan when the background is dark or unknown. This covers the common fallback path.

**Data flow**: The test builds the expected bold cyan Style. It compares that with accent_style_for on a black background and with accent_style_for when no background is available.

**Call relations**: This test exercises the same decision path that accent_style relies on when the terminal background is dark or cannot be detected.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::table_separator_blends_toward_dark_background`  (lines 113–121)

```
fn table_separator_blends_toward_dark_background()
```

**Purpose**: Checks that table separators become a faint gray on a dark background. This ensures separator lines are visible but not too bright.

**Data flow**: The test gives table_separator_style_for a white foreground, black background, and true-color support. It expects the resulting foreground color to be a dark gray RGB value.

**Call relations**: This test calls table_separator_style_for directly with fixed terminal colors. It verifies the color-blending behavior used by table_separator_style during table rendering.

*Call graph*: calls 1 internal fn (table_separator_style_for); 1 external calls (assert_eq!).


##### `tests::table_separator_blends_toward_light_background`  (lines 124–132)

```
fn table_separator_blends_toward_light_background()
```

**Purpose**: Checks that table separators become a faint gray on a light background. This protects readability for users with light terminal themes.

**Data flow**: The test gives table_separator_style_for a black foreground, white background, and true-color support. It expects the resulting foreground color to be a light gray RGB value.

**Call relations**: This test directly verifies table_separator_style_for for light backgrounds, complementing the dark-background test and covering the same logic used by rendered markdown tables.

*Call graph*: calls 1 internal fn (table_separator_style_for); 1 external calls (assert_eq!).


##### `tests::table_separator_dims_when_palette_aware_color_is_unavailable`  (lines 135–154)

```
fn table_separator_dims_when_palette_aware_color_is_unavailable()
```

**Purpose**: Checks the safe fallback for table separators when the code cannot choose a precise color. In those cases, dim text is used instead of risking a poor color choice.

**Data flow**: The test builds the expected dim Style. It then checks two fallback cases: a basic 16-color terminal, and a case where the terminal foreground color is missing. Both should return the dim style.

**Call relations**: This test calls table_separator_style_for directly to protect the fallback behavior used by table_separator_style when terminal color information or color support is limited.

*Call graph*: 2 external calls (default, assert_eq!).


### `tui/src/ui_consts.rs`

`config` · `cross-cutting UI rendering`

This file is a small but important source of truth for terminal layout. In a text-based interface, everything is measured in columns, like spaces on a fixed-width grid. If the chat composer, status lines, and history wrapping each guessed their own left padding, the interface could look slightly crooked or wrap text at the wrong place.

The main constant, `LIVE_PREFIX_COLS`, says that two terminal columns are reserved at the left side for a live cell prefix, such as a border and a space. Other UI pieces use the same value so they align with that live content. For example, status indicator lines can start with the same amount of blank space, and user history lines can wrap while accounting for the same prefix width.

`FOOTER_INDENT_COLS` reuses that same value, but as a `usize`, which is the number type Rust commonly uses for sizes and indexing. This avoids repeated conversions elsewhere. The file is like marking the margin on a shared ruler: once the margin is set here, every part of the terminal UI can measure from the same place.


### `tui/src/render/renderable.rs`

`domain_logic` · `main loop rendering`

A terminal screen is just a grid of character cells, so every visible part of the app needs to answer a few practical questions: “Where should I draw?”, “How tall do I want to be?”, and sometimes “Where should the cursor go?” This file gives the app one common language for those questions through the Renderable trait. Anything that implements it can be placed into a larger screen layout.

The file also provides adapters for common things. Plain strings, styled spans, lines, and paragraphs can all act as renderable items. Option means “draw this only if it exists.” Arc, a shared reference-counted pointer, lets the same renderable value be reused safely. RenderableItem wraps either an owned widget or a borrowed one, so layout code can store both kinds in one list.

The layout structs work like simple packing boxes. ColumnRenderable stacks children from top to bottom. RowRenderable places children from left to right with fixed widths. FlexRenderable is a smarter vertical stack: fixed children get space first, then flexible children share the remaining height. InsetRenderable adds padding around a child, like putting a picture inside a mat frame. Together, these pieces let the rest of the TUI compose screens from small parts without each screen reinventing layout math.

#### Function details

##### `Renderable::cursor_pos`  (lines 17–19)

```
fn cursor_pos(&self, _area: Rect) -> Option<(u16, u16)>
```

**Purpose**: This is the default answer for a renderable item that does not need to place the terminal cursor anywhere special. It says “no cursor position.”

**Data flow**: It receives the screen rectangle where the item would draw, ignores it, and returns no position. Nothing on the screen buffer is changed.

**Call relations**: Layout containers ask their children for cursor positions while arranging the screen. If a child has not provided its own cursor logic, this default keeps it from claiming the cursor.


##### `Renderable::cursor_style`  (lines 20–22)

```
fn cursor_style(&self, _area: Rect) -> SetCursorStyle
```

**Purpose**: This is the default cursor appearance for renderable items. It uses the terminal’s normal user cursor shape unless a specific widget asks for something else.

**Data flow**: It receives the drawing rectangle, ignores it, and returns the default cursor style. It does not draw or change data.

**Call relations**: Containers use this after finding which child owns the cursor. If that child has no custom style, this default is the style handed back.


##### `RenderableItem::render`  (lines 31–36)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: This draws a wrapped renderable item, whether the wrapper owns the item or only borrows it. It hides that ownership difference from layout code.

**Data flow**: It receives a target area and a mutable terminal buffer, looks inside the wrapper, and forwards the drawing request to the actual child. The buffer is changed by whatever the child draws.

**Call relations**: When a container draws its children, it calls this wrapper method so it does not have to care whether each child is stored by value or by reference.

*Call graph*: called by 1 (render).


##### `RenderableItem::desired_height`  (lines 38–43)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: This asks the wrapped child how many rows it would like for a given width. It gives layout containers a uniform way to size owned and borrowed children.

**Data flow**: It receives an available width, forwards that width to the inner child, and returns the child’s requested height.

**Call relations**: Column, row, inset, and flex layout code use height requests to divide the available screen space before drawing.

*Call graph*: called by 1 (desired_height).


##### `RenderableItem::cursor_pos`  (lines 45–50)

```
fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)>
```

**Purpose**: This asks the wrapped child whether it wants to place the terminal cursor somewhere. It works the same for owned and borrowed children.

**Data flow**: It receives the child’s screen area, forwards it to the inner child, and returns either a cursor coordinate or nothing.

**Call relations**: Parent layouts call this while searching through their children for the widget that owns the cursor.

*Call graph*: called by 1 (cursor_pos).


##### `RenderableItem::cursor_style`  (lines 52–57)

```
fn cursor_style(&self, area: Rect) -> SetCursorStyle
```

**Purpose**: This asks the wrapped child what the cursor should look like. It keeps cursor styling independent of whether the child is owned or borrowed.

**Data flow**: It receives the child’s screen area, forwards it to the inner child, and returns the child’s chosen cursor style.

**Call relations**: Once a layout finds the child with a cursor position, it uses this method to forward that child’s cursor appearance to the terminal layer.

*Call graph*: called by 1 (cursor_style).


##### `RenderableItem::from`  (lines 61–63)

```
fn from(value: Box<dyn Renderable + 'a>) -> Self
```

**Purpose**: This converts a boxed renderable object into a RenderableItem that owns it. It is a convenience step used when building lists of renderable children.

**Data flow**: It receives a boxed child and wraps it in the owned variant. The output is a RenderableItem ready to be stored in a container.

**Call relations**: Container builders and helper methods rely on this conversion so callers can pass boxed renderable pieces without manually naming the wrapper.

*Call graph*: 1 external calls (Owned).


##### `Box::from`  (lines 70–72)

```
fn from(value: R) -> Self
```

**Purpose**: This boxes any concrete renderable value so it can be stored as a general renderable object. Boxing means putting the value behind a pointer so different renderable types can live in the same collection.

**Data flow**: It receives a concrete renderable value, allocates a box for it, and returns that boxed renderable trait object.

**Call relations**: Push methods use this kind of conversion when they accept any renderable child and need to store it in a uniform owned form.

*Call graph*: 1 external calls (new).


##### `str::render`  (lines 83–85)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: This lets a string slice draw itself as one line of terminal text. It makes simple text usable anywhere a renderable item is expected.

**Data flow**: It receives a screen area and buffer, then asks the underlying text widget code to draw the string into that area. The buffer gains the string’s characters.

**Call relations**: Higher-level layouts can include plain borrowed text directly because this method supplies the required drawing behavior.


##### `str::desired_height`  (lines 86–88)

```
fn desired_height(&self, _width: u16) -> u16
```

**Purpose**: This says a string slice needs one terminal row. It treats plain borrowed text as a single-line item.

**Data flow**: It receives an available width, ignores it, and returns 1 row.

**Call relations**: Containers use this answer when stacking or measuring plain text items.


##### `String::render`  (lines 92–94)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: This lets an owned String draw itself as terminal text. It gives owned text the same renderable behavior as borrowed text.

**Data flow**: It receives a screen area and buffer, then delegates to the text drawing code to write the string into the buffer.

**Call relations**: Screens can pass owned strings into render containers without wrapping them in a separate widget first.


##### `String::desired_height`  (lines 95–97)

```
fn desired_height(&self, _width: u16) -> u16
```

**Purpose**: This says an owned String is treated as one line high. It keeps simple owned text easy to lay out.

**Data flow**: It receives a width, does not need it, and returns 1 row.

**Call relations**: Layout containers call this when deciding how much vertical space to reserve for owned text.


##### `Span::render`  (lines 101–103)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: This draws a styled piece of text, such as colored or bold text. A span is still treated as one renderable line fragment.

**Data flow**: It receives a screen area and buffer, then uses the terminal text renderer to write the styled span into the buffer.

**Call relations**: This lets styled text participate directly in the same layout system as larger UI components.


##### `Span::desired_height`  (lines 104–106)

```
fn desired_height(&self, _width: u16) -> u16
```

**Purpose**: This says a styled span needs one row. Styling changes appearance, not the amount of vertical space requested here.

**Data flow**: It receives a width, ignores it, and returns 1 row.

**Call relations**: Parent layouts use this when measuring styled text.


##### `Line::render`  (lines 110–112)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: This draws a full styled line of text. It bridges ratatui’s line type into this project’s renderable interface.

**Data flow**: It receives an area and buffer, then calls the line’s reference-rendering method to write into the buffer.

**Call relations**: Any layout container can include a Line as a child because this method connects it to the common Renderable behavior.

*Call graph*: 1 external calls (render_ref).


##### `Line::desired_height`  (lines 113–115)

```
fn desired_height(&self, _width: u16) -> u16
```

**Purpose**: This says a line of text needs one row. It matches the natural shape of a terminal line.

**Data flow**: It receives the available width, ignores it, and returns 1 row.

**Call relations**: Containers use this value when placing Line children beside or above other renderable content.


##### `Paragraph::render`  (lines 119–121)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: This draws a paragraph widget into the terminal buffer. A paragraph can wrap over multiple rows depending on its width.

**Data flow**: It receives an area and buffer, then lets the paragraph widget render itself into that rectangle.

**Call relations**: This allows multi-line text blocks from ratatui to be used directly inside this project’s custom layout containers.


##### `Paragraph::desired_height`  (lines 122–124)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: This estimates how many rows a paragraph needs at a given width. It matters because wrapped text takes more lines when the available space is narrow.

**Data flow**: It receives a width, asks the paragraph how many wrapped lines it would produce, and returns that count as the desired height.

**Call relations**: Column and flex layouts use this to give paragraphs enough vertical room before they are drawn.


##### `Option::render`  (lines 128–132)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: This lets optional UI content be renderable. If the value exists, it is drawn; if it is absent, nothing appears.

**Data flow**: It receives an optional renderable, an area, and a buffer. When the option is Some, it forwards drawing to the child; when None, it leaves the buffer unchanged.

**Call relations**: Callers can include optional sections in a layout without writing separate if-statements around every render call.


##### `Option::desired_height`  (lines 134–140)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: This reports the height of optional content. Missing content asks for zero rows.

**Data flow**: It receives a width. If a child exists, it returns that child’s desired height; otherwise it returns 0.

**Call relations**: Layouts can naturally collapse absent UI sections because this method says they take no space.


##### `Option::cursor_pos`  (lines 142–145)

```
fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)>
```

**Purpose**: This forwards cursor-position requests only when optional content exists. Missing content cannot own the cursor.

**Data flow**: It receives an area. If a child is present, it asks that child for a cursor position; otherwise it returns no position.

**Call relations**: Parent containers use this while searching for the active cursor, and optional sections simply disappear from that search when absent.


##### `Option::cursor_style`  (lines 147–152)

```
fn cursor_style(&self, area: Rect) -> SetCursorStyle
```

**Purpose**: This forwards cursor style from optional content when present, or falls back to the default cursor shape when absent.

**Data flow**: It receives an area. Some content returns its own cursor style; no content returns the default style.

**Call relations**: This keeps cursor styling safe even when a UI section is conditionally hidden.


##### `Arc::render`  (lines 156–158)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: This lets a shared renderable value draw itself through an Arc. Arc is a shared pointer that lets several owners refer to the same data.

**Data flow**: It receives an area and buffer, looks through the shared pointer to the real child, and forwards the render call. The child changes the buffer.

**Call relations**: Shared UI pieces can be passed into layouts without losing the common Renderable interface.


##### `Arc::desired_height`  (lines 159–161)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: This asks a shared renderable value how tall it wants to be. The Arc itself adds no layout behavior.

**Data flow**: It receives a width, forwards it to the value inside the Arc, and returns the resulting height.

**Call relations**: Containers can measure shared renderable objects just like ordinary owned objects.


##### `Arc::cursor_pos`  (lines 162–164)

```
fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)>
```

**Purpose**: This forwards cursor-position requests through a shared pointer. It lets shared widgets still participate in cursor placement.

**Data flow**: It receives an area, asks the inner renderable for a cursor position, and returns that answer.

**Call relations**: Parent layouts do not need special logic for Arc-wrapped children when looking for cursor ownership.


##### `Arc::cursor_style`  (lines 165–167)

```
fn cursor_style(&self, area: Rect) -> SetCursorStyle
```

**Purpose**: This forwards cursor-style requests through a shared pointer. The shared pointer does not change the cursor choice.

**Data flow**: It receives an area, asks the inner renderable for its cursor style, and returns that style.

**Call relations**: After a shared child is found to own the cursor, this passes its style back up to the layout.


##### `ColumnRenderable::render`  (lines 175–185)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: This draws children one under another, like stacking blocks vertically. Each child gets the height it asked for, limited to the available area.

**Data flow**: It receives a column area and buffer, walks through the children from top to bottom, creates a rectangle for each child, clips it to the column’s bounds, and asks visible children to draw. The buffer is filled by those children.

**Call relations**: Screen-building code creates columns for vertical sections, and this method is the point where those sections are turned into actual terminal cells.

*Call graph*: 1 external calls (new).


##### `ColumnRenderable::desired_height`  (lines 187–192)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: This reports the total height needed by a vertical stack. It adds up the requested heights of all children.

**Data flow**: It receives an available width, asks each child how tall it wants to be at that width, sums the answers, and returns the total.

**Call relations**: Parent layouts use this when a whole column is itself placed inside another layout.


##### `ColumnRenderable::cursor_pos`  (lines 198–211)

```
fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)>
```

**Purpose**: This finds the cursor position inside a vertical stack. It returns the first child cursor it finds, using that child’s actual area in the column.

**Data flow**: It receives the column’s area, walks children from top to bottom, computes each child’s rectangle, and asks visible children for a cursor position. It returns the first position found or nothing.

**Call relations**: The rest of the renderer can ask a column where the cursor belongs without knowing which child inside the column is interactive.

*Call graph*: 1 external calls (new).


##### `ColumnRenderable::cursor_style`  (lines 213–224)

```
fn cursor_style(&self, area: Rect) -> SetCursorStyle
```

**Purpose**: This finds the cursor style for the child in a column that owns the cursor. If no child has a cursor, it uses the default style.

**Data flow**: It receives the column area, checks each child’s computed rectangle, and when it finds a child with a cursor position, returns that child’s style. If none is found, it returns the default cursor shape.

**Call relations**: This pairs with ColumnRenderable::cursor_pos so cursor position and appearance both come from the same child.

*Call graph*: 1 external calls (new).


##### `ColumnRenderable::new`  (lines 228–230)

```
fn new() -> Self
```

**Purpose**: This creates an empty vertical layout. Callers use it when they want to add children step by step.

**Data flow**: It takes no input, creates an empty child list, and returns a new ColumnRenderable.

**Call relations**: Many screen builders start with this empty column, then add headers, menus, popups, or other sections before rendering.

*Call graph*: called by 31 (new, reset_confirmation_header, settings_header, build, new, connectors_loading_popup_params, connectors_popup_params, model_menu_header, open_reasoning_popup, marketplace_add_error_popup_params (+15 more)); 1 external calls (vec!).


##### `ColumnRenderable::with`  (lines 232–240)

```
fn with(children: I) -> Self
```

**Purpose**: This creates a vertical layout from an existing list of children. It is a convenient way to build a complete column in one call.

**Data flow**: It receives something that can be iterated over, converts each item into a RenderableItem, stores them in order, and returns the column.

**Call relations**: Header, options, confirmation, and popup builders use this when their child list is known up front.

*Call graph*: called by 7 (build_options, build_header, feedback_upload_consent_params, new, open_full_access_confirmation, open_world_writable_warning_confirmation, from); 1 external calls (into_iter).


##### `ColumnRenderable::push`  (lines 242–244)

```
fn push(&mut self, child: impl Into<Box<dyn Renderable + 'a>>)
```

**Purpose**: This appends one child to the bottom of a column. It is used when content is produced gradually.

**Data flow**: It receives a renderable child, converts it into a boxed owned renderable item, and adds it to the column’s child list.

**Call relations**: Markdown, menu, and line-rendering helpers use this while building vertical output one piece at a time.

*Call graph*: called by 3 (render_lines, render_markdown_content, render_menu); 2 external calls (into, Owned).


##### `FlexRenderable::new`  (lines 261–263)

```
fn new() -> Self
```

**Purpose**: This creates an empty flexible vertical layout. A flexible layout can mix fixed-height children with children that share leftover space.

**Data flow**: It takes no input, creates an empty list of flexible children, and returns the layout.

**Call relations**: Composer and test code create this layout before pushing children with chosen flex values.

*Call graph*: called by 4 (as_renderable_with_composer_right_reserve, as_renderable, flex_redistributes_space_unused_by_short_children, flex_reserves_non_flex_space_before_flexible_children); 1 external calls (vec!).


##### `FlexRenderable::push`  (lines 265–270)

```
fn push(&mut self, flex: i32, child: impl Into<RenderableItem<'a>>)
```

**Purpose**: This adds a child to a flexible vertical layout with a flex factor. A positive flex factor means the child can receive a share of leftover height.

**Data flow**: It receives a flex number and a child, converts the child into a RenderableItem, wraps both together, and appends them to the child list.

**Call relations**: Callers build up a flex layout by repeating this method for fixed and flexible sections before the layout is measured or rendered.

*Call graph*: 1 external calls (into).


##### `FlexRenderable::allocate`  (lines 275–338)

```
fn allocate(&self, area: Rect) -> Vec<Rect>
```

**Purpose**: This is the space-sharing calculator for FlexRenderable. It decides the exact rectangle each child gets inside the available area.

**Data flow**: It receives the parent rectangle, measures fixed children first, finds remaining height, gives short flexible children only what they need, redistributes unused space, then divides what remains among the other flexible children. It returns a list of rectangles, one per child.

**Call relations**: FlexRenderable::render, desired_height, cursor_pos, and cursor_style all call this so drawing, measuring, and cursor lookup agree on the same layout.

*Call graph*: called by 4 (cursor_pos, cursor_style, desired_height, render); 5 external calls (new, new, with_capacity, from, vec!).


##### `FlexRenderable::render`  (lines 342–349)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: This draws all children in their allocated flexible positions. It uses the same allocation rules that measurement and cursor lookup use.

**Data flow**: It receives an area and buffer, asks allocate for child rectangles, pairs each rectangle with its child, and tells each child to draw into its rectangle.

**Call relations**: This is the rendering stage for flexible vertical layouts after callers have built them with new and push.

*Call graph*: calls 1 internal fn (allocate).


##### `FlexRenderable::desired_height`  (lines 351–356)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: This reports how tall the flexible layout would like to be for a given width. It computes that by laying the children out in an extremely tall imaginary area.

**Data flow**: It receives a width, runs allocate with a rectangle whose height is the maximum u16 value, and returns the bottom edge of the last child rectangle, or 0 if there are no children.

**Call relations**: Parent layouts call this when a FlexRenderable is nested inside another renderable structure.

*Call graph*: calls 1 internal fn (allocate); 1 external calls (new).


##### `FlexRenderable::cursor_pos`  (lines 358–363)

```
fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)>
```

**Purpose**: This finds the cursor position inside a flexible vertical layout. It checks children using the same rectangles used for drawing.

**Data flow**: It receives the parent area, allocates child rectangles, asks each child for a cursor position in its rectangle, and returns the first one found.

**Call relations**: The top-level renderer can ask the flex layout for cursor placement without knowing which flexible child is currently interactive.

*Call graph*: calls 1 internal fn (allocate).


##### `FlexRenderable::cursor_style`  (lines 365–376)

```
fn cursor_style(&self, area: Rect) -> SetCursorStyle
```

**Purpose**: This finds the cursor style belonging to the child that owns the cursor in a flexible layout. If no child owns the cursor, it returns the default style.

**Data flow**: It receives the parent area, allocates rectangles, finds the first child that reports a cursor position, asks that child for its style, and returns it. If none is found, it returns the default cursor shape.

**Call relations**: This keeps cursor appearance aligned with FlexRenderable::cursor_pos because both use the same allocation calculation.

*Call graph*: calls 1 internal fn (allocate).


##### `RowRenderable::render`  (lines 384–395)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: This draws children from left to right with fixed requested widths. It stops when there is no horizontal space left.

**Data flow**: It receives a row area and buffer, tracks the current x-position, gives each child the smaller of its requested width and remaining width, and asks non-empty children to draw. The buffer is changed by those children.

**Call relations**: UI code uses rows for side-by-side pieces such as labels and values, and this method turns that horizontal arrangement into terminal cells.

*Call graph*: 1 external calls (new).


##### `RowRenderable::desired_height`  (lines 396–411)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: This reports how tall a row needs to be. Since children sit side by side, the row needs the height of its tallest visible child.

**Data flow**: It receives total available width, walks children left to right, gives each child its usable width, asks for its height, and keeps the maximum. It returns that maximum height.

**Call relations**: Parent layouts use this to reserve enough vertical space for a horizontal group.


##### `RowRenderable::cursor_pos`  (lines 413–426)

```
fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)>
```

**Purpose**: This finds a cursor position inside a horizontal row. It checks children from left to right using each child’s actual rectangle.

**Data flow**: It receives the row area, computes each child’s rectangle within the remaining width, asks visible children for a cursor position, and returns the first one found.

**Call relations**: This lets an interactive item inside a row report the cursor through the row to the wider rendering system.

*Call graph*: 1 external calls (new).


##### `RowRenderable::cursor_style`  (lines 428–439)

```
fn cursor_style(&self, area: Rect) -> SetCursorStyle
```

**Purpose**: This finds the cursor style for the child in a row that owns the cursor. If no child reports a cursor, it returns the default style.

**Data flow**: It receives the row area, computes child rectangles from left to right, and returns the style of the first child that has a cursor position. Otherwise it returns the default cursor shape.

**Call relations**: This mirrors RowRenderable::cursor_pos so both cursor location and cursor shape come from the same side-by-side child.

*Call graph*: 1 external calls (new).


##### `RowRenderable::new`  (lines 443–445)

```
fn new() -> Self
```

**Purpose**: This creates an empty horizontal layout. Callers use it before adding fixed-width children.

**Data flow**: It takes no input, creates an empty child list, and returns a RowRenderable.

**Call relations**: Selection-option UI code creates rows this way before filling them with the pieces that should appear side by side.

*Call graph*: called by 1 (selection_option_row_with_dim); 1 external calls (vec!).


##### `RowRenderable::push`  (lines 447–450)

```
fn push(&mut self, width: u16, child: impl Into<Box<dyn Renderable>>)
```

**Purpose**: This appends a fixed-width child to the right side of a row. The width says how much horizontal space the child should be offered.

**Data flow**: It receives a width and renderable child, boxes and owns the child, and stores the pair in the row’s child list.

**Call relations**: After RowRenderable::new, callers use this repeatedly to assemble the row before it is measured or drawn.

*Call graph*: 2 external calls (into, Owned).


##### `InsetRenderable::render`  (lines 459–461)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: This draws a child inside a padded area. The padding keeps the child away from the outer edges.

**Data flow**: It receives an outer area and buffer, shrinks the area by the stored insets, and tells the child to draw inside the smaller rectangle.

**Call relations**: When code wraps content in InsetRenderable or uses the inset helper, this method applies the padding during the actual draw.

*Call graph*: calls 1 internal fn (render); 1 external calls (inset).


##### `InsetRenderable::desired_height`  (lines 462–467)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: This reports the height needed for a padded child. It includes both the child’s height and the top and bottom padding.

**Data flow**: It receives an outer width, subtracts left and right padding before asking the child for height, then adds top and bottom padding to the result.

**Call relations**: Parent layouts use this so padded content gets enough room for both its contents and its surrounding blank space.

*Call graph*: calls 1 internal fn (desired_height).


##### `InsetRenderable::cursor_pos`  (lines 468–470)

```
fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)>
```

**Purpose**: This asks the padded child for its cursor position inside the inner padded area. Padding affects where the child is allowed to place the cursor.

**Data flow**: It receives the outer area, shrinks it by the insets, asks the child for a cursor position in that inner area, and returns the child’s answer.

**Call relations**: This keeps cursor lookup consistent with rendering, because both use the same inset rectangle.

*Call graph*: calls 1 internal fn (cursor_pos); 1 external calls (inset).


##### `InsetRenderable::cursor_style`  (lines 472–474)

```
fn cursor_style(&self, area: Rect) -> SetCursorStyle
```

**Purpose**: This forwards cursor-style lookup to the padded child using the same inner area used for drawing. The padding wrapper does not choose its own cursor style.

**Data flow**: It receives the outer area, shrinks it by the insets, asks the child for a cursor style in that inner area, and returns that style.

**Call relations**: When an inset child owns the cursor, this passes the child’s cursor appearance back through the padding wrapper.

*Call graph*: calls 1 internal fn (cursor_style); 1 external calls (inset).


##### `InsetRenderable::new`  (lines 478–483)

```
fn new(child: impl Into<RenderableItem<'a>>, insets: Insets) -> Self
```

**Purpose**: This creates a padded wrapper around a renderable child. It is useful when a caller wants explicit control over the padding values.

**Data flow**: It receives a child and an Insets value, converts the child into a RenderableItem, stores both, and returns the wrapper.

**Call relations**: Popup, table-cell, and live-tail rendering code call this when they need content drawn with margins around it.

*Call graph*: called by 3 (from, insert_cell, live_tail_renderable); 1 external calls (into).


##### `R::inset`  (lines 494–498)

```
fn inset(self, insets: Insets) -> RenderableItem<'a>
```

**Purpose**: This is a convenience helper that turns any renderable value into a padded renderable item. It lets callers write layout code in a fluent style.

**Data flow**: It receives a renderable value and insets, boxes the value as a child, wraps it in an InsetRenderable, boxes that wrapper, and returns it as an owned RenderableItem.

**Call relations**: Code that already has a renderable can call this helper instead of manually constructing InsetRenderable and RenderableItem layers.

*Call graph*: 2 external calls (new, Owned).


### Key hints and footer presentation
This group covers keybinding display logic and the footer/title builders that turn bottom-pane state into compact user-facing guidance.

### `tui/src/key_hint.rs`

`domain_logic` · `cross-cutting during TUI input handling and hint rendering`

A terminal app cannot always trust that every terminal reports keys in the same shape. For example, one terminal may report Shift+A as “A with no shift flag,” while another reports “a with shift.” Some Ctrl key presses arrive as old-style invisible control characters instead of as “Ctrl plus a letter.” This file is the shared translator for those cases.

Its main type, `KeyBinding`, stores one shortcut as a key plus modifier keys such as Ctrl, Shift, or Alt. When a real key event arrives, the matching code first normalizes both sides into a common form, like putting two differently written addresses into the same format before comparing them. That lets features such as lists, pickers, history search, and text input use one consistent shortcut system instead of each inventing its own fragile comparisons.

The file also draws shortcut labels for the UI, such as `ctrl + k`, `shift + a`, or arrow symbols, using a dim style so they look like hints rather than main content. Finally, it separates ordinary printable typing from command shortcuts, which matters for searchable lists: pressing `j` should type into the search box, while Ctrl+J can still mean “move down.”

#### Function details

##### `KeyBinding::new`  (lines 50–52)

```
fn new(key: KeyCode, modifiers: KeyModifiers) -> Self
```

**Purpose**: Creates a `KeyBinding` from a key and its modifier keys. Other code uses this when it wants to define a shortcut such as plain Enter, Ctrl+K, or Alt+Up.

**Data flow**: A key code and a set of modifier keys go in. The function stores them together without changing them. A new `KeyBinding` value comes out.

**Call relations**: This is the small constructor underneath the convenience helpers `plain`, `alt`, `shift`, `ctrl`, and `ctrl_alt`. Configuration parsing and some tests also call it directly when they need an exact custom combination.

*Call graph*: called by 7 (alt, ctrl, ctrl_alt, plain, shift, shift_letter_binding_preserves_other_modifiers_with_uppercase_compat, parse_keybinding).


##### `KeyBinding::from_event`  (lines 54–57)

```
fn from_event(event: KeyEvent) -> Self
```

**Purpose**: Turns a raw terminal key event into this file’s normalized shortcut form. This is useful when the program wants to record or compare what the user actually pressed.

**Data flow**: A terminal `KeyEvent` goes in. Its key and modifier parts are passed through `normalize_key_parts`, which fixes common reporting differences. A `KeyBinding` containing the normalized key and modifiers comes out.

**Call relations**: Input-handling code calls this after receiving a key event, and configuration code uses it when converting a key event into a config-friendly key description. It relies on `normalize_key_parts` so callers do not need to know terminal compatibility details.

*Call graph*: calls 1 internal fn (normalize_key_parts); called by 2 (handle_key_event, key_event_to_config_key_spec).


##### `KeyBinding::is_press`  (lines 59–63)

```
fn is_press(&self, event: KeyEvent) -> bool
```

**Purpose**: Checks whether a real key event activates this shortcut. It accepts normal key presses and held-key repeats, but rejects key releases.

**Data flow**: The stored binding and an incoming terminal event go in. Both are normalized so equivalent forms, such as uppercase letters and Shift+letter, compare the same. The function returns true only if the normalized key parts match and the event is a press or repeat.

**Call relations**: This is the core matching check used by shortcut sets through `KeyBinding::is_pressed`. It hands the messy comparison work to `normalize_key_parts` before making the final yes-or-no decision.

*Call graph*: calls 1 internal fn (normalize_key_parts).


##### `KeyBinding::parts`  (lines 65–67)

```
fn parts(&self) -> (KeyCode, KeyModifiers)
```

**Purpose**: Returns the raw key and modifier pieces stored inside a binding. Code that needs to serialize or inspect a binding can use this instead of reaching into its private fields.

**Data flow**: A `KeyBinding` goes in as `self`. The function reads its key and modifier fields. It returns those two values as a pair and changes nothing.

**Call relations**: Configuration-writing code calls this when turning a binding back into a config key specification. It is a simple doorway from the compact binding object back to its two ingredients.

*Call graph*: called by 1 (binding_to_config_key_spec).


##### `KeyBinding::display_label`  (lines 69–83)

```
fn display_label(&self) -> String
```

**Purpose**: Builds the human-readable label shown in the TUI for a shortcut. It turns internal key names into friendly labels like `enter`, `space`, `↑`, or `ctrl + k`.

**Data flow**: A binding goes in. The modifier keys are converted to text with `modifiers_to_string`, then the key itself is converted to a friendly word, symbol, or lowercase string. The final label string comes out.

**Call relations**: The `Span::from` conversion calls this when a key binding needs to be displayed as styled UI text. It is the text-making half of the hint-rendering path.

*Call graph*: calls 1 internal fn (modifiers_to_string); called by 1 (from); 2 external calls (to_string, format!).


##### `normalize_key_parts`  (lines 86–103)

```
fn normalize_key_parts(
    key: KeyCode,
    mut modifiers: KeyModifiers,
) -> (KeyCode, KeyModifiers)
```

**Purpose**: Converts key reports into one standard shape before comparison. This hides differences between terminals, especially for shifted letters and Ctrl key combinations.

**Data flow**: A key code and modifier set go in. If the key is not a character, they come back unchanged. If it is an old-style control character with no modifiers, `c0_control_char_to_ctrl_char` maps it to the matching Ctrl shortcut. If it is an uppercase ASCII letter, the function adds Shift and stores the lowercase letter. The normalized pair comes out.

**Call relations**: `KeyBinding::from_event`, `KeyBinding::is_press`, and configuration key conversion all call this so they speak the same key language. It delegates the special old control-character mapping to `c0_control_char_to_ctrl_char`.

*Call graph*: calls 1 internal fn (c0_control_char_to_ctrl_char); called by 3 (from_event, is_press, key_parts_to_config_key_spec); 3 external calls (Char, insert, is_empty).


##### `c0_control_char_to_ctrl_char`  (lines 105–113)

```
fn c0_control_char_to_ctrl_char(ch: char) -> Option<char>
```

**Purpose**: Recognizes old terminal control characters and translates them into the visible key that Ctrl was probably pressed with. For example, a raw line-feed character can mean Ctrl+J.

**Data flow**: One character goes in. The function looks at its numeric code and, for supported control-code ranges, calculates the matching printable character such as a letter, space, or digit. It returns that character if recognized, or nothing if the character is not one of the supported control codes.

**Call relations**: `normalize_key_parts` calls this only when a character arrives with no modifiers. That keeps Ctrl compatibility in one narrow helper instead of spreading old terminal rules across the TUI.

*Call graph*: called by 1 (normalize_key_parts); 2 external calls (from_u32, from).


##### `KeyBinding::is_pressed`  (lines 126–128)

```
fn is_pressed(&self, event: KeyEvent) -> bool
```

**Purpose**: Checks whether any shortcut in a group matches one incoming key event. This lets one action have several alternative keys.

**Data flow**: A slice of bindings and a terminal key event go in. The function asks each binding whether it matches the event using `is_press`. It returns true as soon as one matches, or false if none do.

**Call relations**: History search helpers call this when deciding whether a key should trigger backward or forward history search. It is the group-level wrapper around the single-binding matcher.

*Call graph*: called by 2 (is_history_search_forward_key, is_history_search_key).


##### `is_plain_text_key_event`  (lines 139–150)

```
fn is_plain_text_key_event(event: KeyEvent) -> bool
```

**Purpose**: Decides whether a key event should be treated as ordinary typed text instead of as a command shortcut. This protects search boxes and text inputs from accidentally swallowing printable characters.

**Data flow**: A terminal key event goes in. The function checks that it is a character, that the character is not an invisible control character, and that Ctrl and Alt are not pressed. It returns true for plain text typing and false for command-like input.

**Call relations**: Several key handlers call this before applying navigation shortcuts. It gives them a shared rule: plain printable keys can update text, while modified keys remain available for commands.

*Call graph*: called by 4 (handle_key_event, handle_key_event, handle_key_event, handle_key); 1 external calls (matches!).


##### `plain`  (lines 152–154)

```
fn plain(key: KeyCode) -> KeyBinding
```

**Purpose**: Creates a shortcut with no modifier keys. It is a readable way to say “this action is triggered by this key alone.”

**Data flow**: A key code goes in. The function pairs it with the empty modifier set by calling `KeyBinding::new`. A plain `KeyBinding` comes out.

**Call relations**: Many UI and default-binding builders call this when defining normal keys such as Enter, Escape, arrows, or single letters. It exists so those definitions are easy to read.

*Call graph*: calls 1 internal fn (new); called by 14 (footer_props, new_with_config, footer_insert_newline_key, history_search_action_key_span, default_bindings, esc_hint_line, new, render_one_pending_steer_with_remapped_interrupt_binding, footer_tips, skills_toggle_hint_line (+4 more)).


##### `alt`  (lines 156–158)

```
fn alt(key: KeyCode) -> KeyBinding
```

**Purpose**: Creates an Alt-key shortcut. On macOS the UI label later shows this using the Option symbol, because that is the key users recognize.

**Data flow**: A key code goes in. The function calls `KeyBinding::new` with the Alt modifier added. An Alt-based `KeyBinding` comes out.

**Call relations**: Default bindings and shortcut helpers call this for actions reached through Alt combinations, such as agent shortcuts or editing recent queued messages.

*Call graph*: calls 1 internal fn (new); called by 6 (default_bindings, new, queued_message_edit_binding_for_terminal, alt_up_edits_most_recent_queued_message, next_agent_shortcut, previous_agent_shortcut).


##### `shift`  (lines 160–162)

```
fn shift(key: KeyCode) -> KeyBinding
```

**Purpose**: Creates a Shift-key shortcut. It is used for shortcuts that depend on holding Shift with a key.

**Data flow**: A key code goes in. The function calls `KeyBinding::new` with the Shift modifier. A Shift-based `KeyBinding` comes out.

**Call relations**: Footer rendering, queued-message editing shortcuts, and tests call this. Matching later goes through normalization, so Shift+letter can also match terminals that report an uppercase letter instead.

*Call graph*: calls 1 internal fn (new); called by 6 (footer_insert_newline_key, footer_snapshots, render_one_message_with_shift_left_binding, queued_message_edit_binding_for_terminal, shift_letter_binding_does_not_match_plain_lowercase_or_other_uppercase, shifted_letter_binding_matches_uppercase_char_events).


##### `ctrl`  (lines 164–166)

```
fn ctrl(key: KeyCode) -> KeyBinding
```

**Purpose**: Creates a Ctrl-key shortcut. This is used for many command-style keys in the terminal UI.

**Data flow**: A key code goes in. The function calls `KeyBinding::new` with the Control modifier. A Ctrl-based `KeyBinding` comes out.

**Call relations**: Input handlers, default binding setup, footer display, and tests call this often. The resulting bindings benefit from the control-character compatibility built into `is_press` and `normalize_key_parts`.

*Call graph*: calls 1 internal fn (new); called by 16 (on_ctrl_c, new_with_config, base_footer_mode_tracks_empty_state_after_quit_hint_expires, default_bindings, footer_snapshots, footer_status_line_truncates_to_keep_mode_indicator, paste_image_shortcut_prefers_ctrl_alt_v_under_wsl, handle_key_event, on_ctrl_c, on_ctrl_d (+6 more)).


##### `ctrl_alt`  (lines 168–170)

```
fn ctrl_alt(key: KeyCode) -> KeyBinding
```

**Purpose**: Creates a shortcut that requires both Ctrl and Alt. This is useful for combinations that should be distinct from plain Ctrl or plain Alt.

**Data flow**: A key code goes in. The function combines the Control and Alt modifier flags and passes them to `KeyBinding::new`. A binding requiring both modifiers comes out.

**Call relations**: The paste-image shortcut tests call this, especially for environments where Ctrl+Alt+V is preferred. It is the two-modifier version of the simpler helper constructors.

*Call graph*: calls 1 internal fn (new); called by 1 (paste_image_shortcut_prefers_ctrl_alt_v_under_wsl).


##### `modifiers_to_string`  (lines 172–184)

```
fn modifiers_to_string(modifiers: KeyModifiers) -> String
```

**Purpose**: Turns modifier keys into the text prefix used in shortcut labels. For example, it can produce `ctrl + shift + ` before the main key name.

**Data flow**: A modifier set goes in. The function checks for Control, Shift, and Alt in that order and appends the matching text prefixes. It returns the completed prefix string.

**Call relations**: `KeyBinding::display_label` calls this before adding the main key name. It centralizes label wording, including the platform-specific Alt or Option prefix.

*Call graph*: called by 1 (display_label); 2 external calls (contains, new).


##### `Span::from`  (lines 192–194)

```
fn from(binding: &KeyBinding) -> Self
```

**Purpose**: Converts a key binding into styled text that can be drawn by the TUI. A `Span` is a small piece of terminal text with a style attached.

**Data flow**: A reference to a `KeyBinding` goes in. The function asks the binding for its display label, gets the standard key-hint style from `key_hint_style`, and combines them into a styled `Span`. The styled span comes out.

**Call relations**: UI rendering code can rely on this conversion when it needs to show a shortcut hint. It connects the label-making function `display_label` with the visual style from `key_hint_style`.

*Call graph*: calls 2 internal fn (display_label, key_hint_style); 1 external calls (styled).


##### `key_hint_style`  (lines 197–199)

```
fn key_hint_style() -> Style
```

**Purpose**: Defines the visual style used for keyboard shortcut hints. It makes them dim so they read as helpful hints rather than primary content.

**Data flow**: No input is needed. The function starts from the default terminal style and applies a dim effect. The resulting style comes out.

**Call relations**: `Span::from` calls this whenever it turns a binding into display text. Keeping the style here makes shortcut hints look consistent across the TUI.

*Call graph*: called by 1 (from); 1 external calls (default).


##### `has_ctrl_or_alt`  (lines 201–203)

```
fn has_ctrl_or_alt(mods: KeyModifiers) -> bool
```

**Purpose**: Checks whether a modifier set includes Ctrl or Alt in a way that should count as a command modifier. On Windows it avoids treating AltGr as a command shortcut.

**Data flow**: A modifier set goes in. The function checks whether Control or Alt is present, then excludes the special AltGr case by calling `is_altgr`. It returns true when the modifiers should be treated as Ctrl/Alt command input.

**Call relations**: Text and history input handlers call this while deciding whether a key is normal typing or a command. It relies on `is_altgr` so international keyboard input is not mistaken for shortcuts on Windows.

*Call graph*: calls 1 internal fn (is_altgr); called by 4 (handle_key_event, handle_input_basic_with_time, handle_history_search_key, handle_key_event_at); 1 external calls (contains).


##### `is_altgr`  (lines 213–215)

```
fn is_altgr(_mods: KeyModifiers) -> bool
```

**Purpose**: Detects the AltGr key combination where supported. AltGr is used on many keyboard layouts to type characters such as `@`, `€`, or accented letters, so it should not always behave like a command shortcut.

**Data flow**: A modifier set goes in. On Windows, the function returns true when both Alt and Control are present, which is how AltGr is commonly reported. On non-Windows systems, it always returns false. It does not change anything.

**Call relations**: `has_ctrl_or_alt` calls this to avoid misclassifying AltGr typing as a Ctrl+Alt command. Other input keymap code may also call it when interpreting keyboard layout behavior.

*Call graph*: called by 2 (input_with_keymap, has_ctrl_or_alt); 1 external calls (contains).


##### `tests::is_press_accepts_press_and_repeat_but_rejects_release`  (lines 222–239)

```
fn is_press_accepts_press_and_repeat_but_rejects_release()
```

**Purpose**: Tests that shortcut matching accepts key presses and held-key repeats, but not key releases. It also checks that the wrong modifiers do not match.

**Data flow**: The test builds a Ctrl+K binding and several key events: press, repeat, release, and plain K. It runs `is_press` on each event. The expected before-and-after result is true for press and repeat, false for release and wrong modifiers.

**Call relations**: This test exercises the core behavior of `KeyBinding::is_press` through a binding made with `ctrl`. It protects input handlers from triggering actions when the terminal reports key releases.

*Call graph*: calls 1 internal fn (ctrl); 3 external calls (Char, new, assert!).


##### `tests::keybinding_list_ext_matches_any_binding`  (lines 242–248)

```
fn keybinding_list_ext_matches_any_binding()
```

**Purpose**: Tests that a list of alternative shortcuts matches when any one shortcut is pressed. This confirms that one action can have multiple accepted keys.

**Data flow**: The test creates two bindings, plain A and Ctrl+B. It sends matching A and Ctrl+B events, then a non-matching C event. It expects the first two checks to return true and the last to return false.

**Call relations**: This test covers the slice-level `is_pressed` helper built from `plain` and `ctrl`. It supports callers such as history search that treat several bindings as alternatives for one action.

*Call graph*: calls 2 internal fn (ctrl, plain); 2 external calls (Char, assert!).


##### `tests::shifted_letter_binding_matches_uppercase_char_events`  (lines 251–257)

```
fn shifted_letter_binding_matches_uppercase_char_events()
```

**Purpose**: Tests that Shift-letter shortcuts still work when a terminal reports the key as an uppercase character. This protects compatibility across terminal programs.

**Data flow**: The test creates a Shift+A binding. It checks events reported as Shift+a, plain uppercase A, and uppercase A with Shift. Each should match after normalization.

**Call relations**: This test verifies the uppercase-letter path in `normalize_key_parts` through the public `is_press` behavior. It ensures callers do not need their own Shift compatibility checks.

*Call graph*: calls 1 internal fn (shift); 2 external calls (Char, assert!).


##### `tests::shift_letter_binding_preserves_other_modifiers_with_uppercase_compat`  (lines 260–267)

```
fn shift_letter_binding_preserves_other_modifiers_with_uppercase_compat()
```

**Purpose**: Tests that uppercase-letter normalization does not lose other modifier keys. For example, Ctrl+Shift+I should still match a terminal report of Ctrl plus uppercase I.

**Data flow**: The test creates a binding for Ctrl+Shift+I. It sends an event reported as Ctrl with uppercase I. The expected result is a match, showing that normalization adds Shift while keeping Ctrl.

**Call relations**: This test calls `KeyBinding::new` directly to build the exact combination. It protects the part of `normalize_key_parts` that adds Shift without wiping out existing modifiers.

*Call graph*: calls 1 internal fn (new); 2 external calls (Char, assert!).


##### `tests::shift_letter_binding_does_not_match_plain_lowercase_or_other_uppercase`  (lines 270–275)

```
fn shift_letter_binding_does_not_match_plain_lowercase_or_other_uppercase()
```

**Purpose**: Tests that Shift-letter matching is not too loose. A Shift+O binding should not match plain lowercase o or a different uppercase letter.

**Data flow**: The test creates a Shift+O binding. It checks a plain lowercase o event and an uppercase P event. Both should fail.

**Call relations**: This test uses the `shift` helper and then exercises `is_press`. It guards against normalization accidentally turning nearby or unmodified keys into false matches.

*Call graph*: calls 1 internal fn (shift); 2 external calls (Char, assert!).


##### `tests::ctrl_letter_binding_matches_c0_control_char_events`  (lines 278–283)

```
fn ctrl_letter_binding_matches_c0_control_char_events()
```

**Purpose**: Tests that a Ctrl-letter binding matches the old-style control character some terminals send. It also checks that adding Alt prevents that fallback match.

**Data flow**: The test creates a Ctrl+P binding. It sends the raw control character for Ctrl+P with no modifiers, expecting a match, then sends the same character with Alt, expecting no match.

**Call relations**: This test verifies the `c0_control_char_to_ctrl_char` path through `normalize_key_parts` and `is_press`. It keeps Ctrl compatibility useful without over-matching modified control characters.

*Call graph*: calls 1 internal fn (ctrl); 2 external calls (Char, assert!).


##### `tests::ctrl_bindings_match_all_supported_c0_control_char_events`  (lines 286–333)

```
fn ctrl_bindings_match_all_supported_c0_control_char_events()
```

**Purpose**: Tests the full supported table of old-style Ctrl control characters. It confirms that each recognized raw control code maps to the intended Ctrl shortcut.

**Data flow**: The test walks through pairs such as Ctrl+A to raw code 0x01 and Ctrl+J to line feed. For each pair, it expects the unmodified raw control character to match and the Alt-modified version not to match.

**Call relations**: This test gives broad coverage to `c0_control_char_to_ctrl_char` as used by shortcut matching. It acts like a checklist for the terminal compatibility map.

*Call graph*: 1 external calls (assert!).


##### `tests::ctrl_binding_does_not_match_ambiguous_c0_escape_or_delete`  (lines 336–345)

```
fn ctrl_binding_does_not_match_ambiguous_c0_escape_or_delete()
```

**Purpose**: Tests that ambiguous control characters are deliberately not treated as Ctrl shortcuts. Escape and Delete-like codes can mean other things in terminals, so matching them as Ctrl+[ or Ctrl+? would be risky.

**Data flow**: The test checks Ctrl+[ against the raw Escape character and Ctrl+? against the Delete character. Both comparisons should return false.

**Call relations**: This test protects the exclusions in `c0_control_char_to_ctrl_char`. It ensures the compatibility layer stays cautious where terminal meanings are unclear.

*Call graph*: 1 external calls (assert!).


##### `tests::history_search_ctrl_bindings_match_c0_control_char_events`  (lines 348–357)

```
fn history_search_ctrl_bindings_match_c0_control_char_events()
```

**Purpose**: Tests specific Ctrl shortcuts used by history search. It makes sure Ctrl+R and Ctrl+S still work when terminals send raw control characters.

**Data flow**: The test sends raw control characters corresponding to Ctrl+R and Ctrl+S. It checks them against Ctrl+R and Ctrl+S bindings. Both should match.

**Call relations**: This test connects the general Ctrl compatibility behavior to an important user-facing feature: history search. It helps prevent regressions in common terminal shortcuts.

*Call graph*: 1 external calls (assert!).


##### `tests::ctrl_alt_sets_both_modifiers`  (lines 360–368)

```
fn ctrl_alt_sets_both_modifiers()
```

**Purpose**: Tests that the `ctrl_alt` helper really creates a binding with both Control and Alt. This keeps shortcut definitions honest and readable.

**Data flow**: The test creates Ctrl+Alt+V and asks for its stored parts. It compares the result with the expected key V and the combined Control-plus-Alt modifier set.

**Call relations**: This test checks the helper constructor rather than matching behavior. It supports code paths that define special Ctrl+Alt shortcuts, such as paste-image handling.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::has_ctrl_or_alt_checks_supported_modifier_combinations`  (lines 371–380)

```
fn has_ctrl_or_alt_checks_supported_modifier_combinations()
```

**Purpose**: Tests the rule for detecting Ctrl or Alt command modifiers. It also verifies the Windows-specific AltGr exception.

**Data flow**: The test checks no modifiers, Control alone, Alt alone, and Control+Alt together. It expects no modifiers to be false, Control and Alt to be true, and Control+Alt to depend on the platform because Windows treats that combination as possible AltGr.

**Call relations**: This test covers `has_ctrl_or_alt` and, through it, `is_altgr`. It protects text input code from confusing command shortcuts with normal character entry on international keyboards.

*Call graph*: 1 external calls (assert!).


### `tui/src/bottom_pane/action_required_title.rs`

`domain_logic` · `terminal UI rendering`

This file is a small helper for the bottom area of the terminal interface. Its job is to create a clear title like an alert banner: it starts with a phrase such as "[ ! ] Action Required", then adds extra pieces of information separated by vertical bars. Think of it like making a short sign for a notice board: the sign always starts with the main warning, then only includes the details that are useful right now.

The important behavior is that it deliberately leaves out some title items. It always skips the spinner item, because a spinning progress marker does not belong in this attention-needed title. It also skips any items the caller says should be excluded. For every remaining item, it asks a caller-provided function to turn that item into display text. If that function says there is no text for an item, the item is ignored.

Without this helper, different parts of the terminal UI might build this title inconsistently, include noisy details, or forget to remove the spinner. This keeps the action-required title compact, predictable, and easy to scan.

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

**Purpose**: Builds one display string for an “action required” title. It starts with a prefix, adds text for allowed title items, skips unwanted items, and joins everything with " | " so the result is easy to read.

**Data flow**: It receives a prefix, a sequence of possible title items, a list of items to leave out, and a function that can turn each item into text. It starts a list with the prefix, walks through the items, skips the spinner and anything in the excluded list, asks for text for the remaining items, and appends any text it gets. It returns the final title string made by joining all kept parts with separators.

**Call relations**: When terminal UI code needs the action-required title, this helper is the place that assembles it. Inside, it uses a fresh list to collect the title pieces, checks the excluded-items list to decide what not to show, and then hands back a finished string ready for display.

*Call graph*: 2 external calls (contains, vec!).


### `tui/src/bottom_pane/footer.rs`

`domain_logic` · `main loop / UI rendering`

The footer is the chat UI’s “bottom signpost.” It tells the user what keys are useful right now, whether they are in a special mode, how much context remains, or whether they need to press a key again to quit. Without this file, the app could still run, but users would lose many of the small prompts that make the terminal interface understandable.

The file takes a bundle of inputs called `FooterProps`. These inputs are chosen elsewhere by the chat composer and higher-level widgets. This file does not decide whether a task is running or whether quitting is allowed; it trusts the values it is given and focuses on drawing the right text.

A key part of the file is fitting information into one terminal row. Terminal windows can be narrow, so the footer tries the fullest version first, then drops less important pieces. For example, it may keep “Tab to queue message” but hide the right-side context label if space is tight. This is like packing a small suitcase: essentials stay, extras go first.

The file also builds the multi-line shortcut overlay shown after pressing `?`, formats collaboration mode labels, renders passive status lines, and right-aligns contextual indicators. Tests at the bottom use snapshots to make sure the footer looks correct across many states and widths.

#### Function details

##### `FooterKeyHints::default_bindings`  (lines 126–138)

```
fn default_bindings() -> Self
```

**Purpose**: Creates the standard set of keyboard hints used in tests. It gives each footer action, such as opening shortcuts or searching history, its usual key combination.

**Data flow**: It starts with no inputs. It builds a `FooterKeyHints` value filled with key bindings like `?`, `Tab`, `Ctrl+J`, and `Alt+.`. The result is returned to tests as a ready-made footer key setup.

**Call relations**: Snapshot and shortcut tests call this when they need realistic default keys. It relies on small key-building helpers such as `plain`, `ctrl`, and `alt` to describe the keys in the same format the real UI uses.

*Call graph*: calls 3 internal fn (alt, ctrl, plain); called by 3 (footer_snapshots, footer_status_line_truncates_to_keep_mode_indicator, paste_image_shortcut_prefers_ctrl_alt_v_under_wsl); 1 external calls (Char).


##### `CollaborationModeIndicator::label`  (lines 142–155)

```
fn label(self, show_cycle_hint: bool) -> String
```

**Purpose**: Turns a collaboration mode, such as Plan mode, into the text shown to the user. It can also add the “shift+tab to cycle” hint when that reminder should be visible.

**Data flow**: It receives a mode and a yes-or-no flag for the cycle hint. It builds the matching label string, optionally with the hint in parentheses. It returns plain text, not styled terminal output.

**Call relations**: `styled_span` calls this first so it can get the human-readable label before applying color. This keeps the wording and the styling as two separate steps.

*Call graph*: called by 1 (styled_span); 2 external calls (new, format!).


##### `CollaborationModeIndicator::styled_span`  (lines 157–164)

```
fn styled_span(self, show_cycle_hint: bool) -> Span<'static>
```

**Purpose**: Creates the colored piece of terminal text for a collaboration mode label. Different modes get different colors so users can recognize them quickly.

**Data flow**: It receives a collaboration mode and whether to include the cycle hint. It asks `label` for the text, wraps that text in a terminal span, and applies the mode’s color. The result is a styled span ready to be placed in a footer line.

**Call relations**: Footer-building helpers use this when adding the collaboration mode to either the left footer summary or the right-side status indicator.

*Call graph*: calls 1 internal fn (label); 1 external calls (from).


##### `toggle_shortcut_mode`  (lines 190–209)

```
fn toggle_shortcut_mode(
    current: FooterMode,
    ctrl_c_hint: bool,
    is_empty: bool,
) -> FooterMode
```

**Purpose**: Switches the footer between normal mode and the shortcut help overlay. It also avoids hiding the quit reminder when that reminder is currently active.

**Data flow**: It receives the current footer mode, whether a quit reminder is active, and whether the composer is empty. It decides the appropriate normal base mode, then either opens the shortcut overlay or closes it back to the base mode. The returned mode is what the composer should show next.

**Call relations**: The shortcut-overlay key handler calls this when the user presses the shortcut-help key. It is part of the small state machine that decides which footer message should appear.

*Call graph*: called by 1 (handle_shortcut_overlay_key); 1 external calls (matches!).


##### `esc_hint_mode`  (lines 211–217)

```
fn esc_hint_mode(current: FooterMode, is_task_running: bool) -> FooterMode
```

**Purpose**: Chooses whether pressing Escape should show the “press Esc again” hint. It does not show that hint while a task is running, because Escape may have a different meaning then.

**Data flow**: It receives the current footer mode and whether a task is running. If a task is running, it returns the current mode unchanged. Otherwise, it returns `EscHint` so the footer can prompt the user.

**Call relations**: Several keyboard-event handlers call this when Escape is pressed in different UI situations, such as with file, slash-command, or normal input handling.

*Call graph*: called by 4 (handle_key_event_with_file_popup, handle_key_event_without_popup, set_esc_backtrack_hint, handle_key_event_with_slash_popup).


##### `reset_mode_after_activity`  (lines 219–228)

```
fn reset_mode_after_activity(current: FooterMode) -> FooterMode
```

**Purpose**: Returns the footer to its normal empty-composer state after user activity makes a temporary hint stale. This prevents old prompts from lingering after the user has moved on.

**Data flow**: It receives the current footer mode. If the mode is temporary, such as the shortcut overlay, quit reminder, history search, Esc hint, or draft mode, it returns `ComposerEmpty`. Otherwise, it leaves the mode alone.

**Call relations**: Input handlers and cleanup routines call this after typing, changing settings, clearing quit hints, or similar activity. It keeps the footer synchronized with the current interaction.

*Call graph*: called by 11 (clear_quit_shortcut_hint, handle_input_basic_with_time, handle_key_event_with_file_popup, handle_key_event_with_mentions_v2_popup, handle_key_event_with_skill_popup, handle_key_event_without_popup, set_esc_backtrack_hint, set_vim_enabled, cancel_history_search, handle_history_search_key (+1 more)).


##### `footer_height`  (lines 230–255)

```
fn footer_height(props: &FooterProps) -> u16
```

**Purpose**: Calculates how many terminal rows the footer needs for the current state. Most states need one row, while the shortcut overlay needs several.

**Data flow**: It receives `FooterProps`. It decides which hints would be visible, asks `footer_from_props_lines` to build the actual lines, and returns the number of lines as a height.

**Call relations**: Rendering and snapshot-test helpers call this before drawing so they can allocate enough space. It delegates the real text construction to `footer_from_props_lines`.

*Call graph*: calls 1 internal fn (footer_from_props_lines); called by 4 (snapshot_composer_state_with_width, render_footer_with_mode_indicator_and_context, snapshot_footer_with_indicators, snapshot_footer_with_mode_indicator_and_context).


##### `render_footer_line`  (lines 258–265)

```
fn render_footer_line(area: Rect, buf: &mut Buffer, line: Line<'static>)
```

**Purpose**: Draws one already-chosen footer line into the terminal buffer. It is used when layout code has already decided exactly what should appear.

**Data flow**: It receives a screen area, a mutable terminal buffer, and one line of styled text. It adds the standard left indentation, wraps the line in a paragraph widget, and writes it into the buffer. The buffer is changed; nothing meaningful is returned.

**Call relations**: The main bottom-pane renderer calls this after single-line collapse logic has selected a custom line. It uses `prefix_lines` to apply the same indentation as other footer rendering.

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

**Purpose**: Draws footer content directly from `FooterProps`. This is used when the caller wants the normal mapping from footer mode to text, without extra width-based simplification.

**Data flow**: It receives the drawing area, buffer, footer properties, optional mode indicator, and flags for which hints to show. It builds footer lines with `footer_from_props_lines`, indents them, and writes them into the buffer. The terminal buffer is updated.

**Call relations**: The bottom-pane renderer calls this for straightforward footer states, especially temporary instruction states like shortcut help, Esc hints, and quit reminders.

*Call graph*: calls 2 internal fn (footer_from_props_lines, prefix_lines); called by 1 (render_with_mask_and_textarea_right_reserve); 1 external calls (new).


##### `left_fits`  (lines 297–300)

```
fn left_fits(area: Rect, left_width: u16) -> bool
```

**Purpose**: Checks whether a left-side footer message can fit in the available width after indentation. It is a small guard used before drawing text that might be too wide.

**Data flow**: It receives a screen area and the width of the left-side content. It subtracts the footer indent from the area width and compares the content width to the remaining space. It returns true if the content fits.

**Call relations**: `single_line_footer_layout` calls this while trying narrower fallback versions of the footer. It helps avoid drawing text that would collide or overflow.

*Call graph*: called by 1 (single_line_footer_layout).


##### `left_side_line`  (lines 316–352)

```
fn left_side_line(
    collaboration_mode_indicator: Option<CollaborationModeIndicator>,
    state: LeftSideState,
    key_hints: FooterKeyHints,
) -> Line<'static>
```

**Purpose**: Builds the left part of the one-line footer, such as “? for shortcuts,” “Tab to queue message,” and the collaboration mode label. It combines the most immediate action hint with optional mode context.

**Data flow**: It receives an optional collaboration mode, a small state describing which hint to show, and the available key hints. It creates a styled line, adding separators when both a hint and a mode label are present. It returns the completed line.

**Call relations**: `single_line_footer_layout` uses this repeatedly while testing possible footer versions. `footer_from_props_lines` also uses the same helper so normal rendering and collapsed rendering speak the same visual language.

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

**Purpose**: Chooses the best one-line footer layout for the available terminal width. It decides what to keep, shorten, or hide so important guidance remains visible.

**Data flow**: It receives the screen area, right-side context width, optional mode label, hint flags, and key hints. It tries the full left footer with right context, then falls back through shorter versions such as dropping shortcut help, shortening queue text, hiding the cycle hint, or hiding the right context. It returns what the left side should be and whether the right context should still be drawn.

**Call relations**: The bottom-pane renderer calls this for base composer states. It uses `left_side_line`, `can_show_left_with_context`, and `left_fits` as measuring tools while it searches for the best fit.

*Call graph*: calls 3 internal fn (can_show_left_with_context, left_fits, left_side_line); called by 1 (render_with_mask_and_textarea_right_reserve); 1 external calls (Custom).


##### `mode_indicator_line`  (lines 533–538)

```
fn mode_indicator_line(
    indicator: Option<CollaborationModeIndicator>,
    show_cycle_hint: bool,
) -> Option<Line<'static>>
```

**Purpose**: Converts an optional collaboration mode into a full footer line. If there is no mode, it returns nothing.

**Data flow**: It receives an optional mode and a flag for the cycle hint. When a mode is present, it creates a one-span line using that mode’s styled label. When absent, it returns `None`.

**Call relations**: `status_line_right_indicator_line` uses this as the first choice for the right-side status indicator. It is a small adapter between mode labels and line-based rendering.

*Call graph*: called by 1 (status_line_right_indicator_line).


##### `goal_status_indicator_line`  (lines 540–572)

```
fn goal_status_indicator_line(
    indicator: Option<&GoalStatusIndicator>,
) -> Option<Line<'static>>
```

**Purpose**: Formats the current goal state as a short status message. It tells the user whether a goal is being pursued, paused, blocked, limited, completed, or abandoned.

**Data flow**: It receives an optional goal-status indicator. If none is provided, it returns nothing. If one is present, it chooses the right wording, includes usage text when available, colors it, and returns a footer line.

**Call relations**: `status_line_right_indicator_line` uses this when there is no collaboration mode to show. It provides a fallback primary indicator for the right side of the status line.

*Call graph*: 3 external calls (from, format!, vec!).


##### `status_line_right_indicator_line`  (lines 574–600)

```
fn status_line_right_indicator_line(
    collaboration_mode_indicator: Option<CollaborationModeIndicator>,
    goal_status_indicator: Option<&GoalStatusIndicator>,
    ide_context_active: bool,
    sh
```

**Purpose**: Builds the right-side indicator shown beside a passive status line. It can combine a mode or goal label with an “IDE context” label.

**Data flow**: It receives optional collaboration mode information, optional goal status, whether IDE context is active, and whether to show the cycle hint. It creates a primary indicator from the mode or goal, optionally creates an IDE context indicator, joins available pieces with a dot separator, and returns the combined line if there is anything to show.

**Call relations**: The footer layout code uses this when a configurable status line is active. It calls `mode_indicator_line` and, when needed, goal-status formatting so the right side summarizes the current environment.

*Call graph*: calls 1 internal fn (mode_indicator_line); called by 1 (mode_indicator_line).


##### `side_conversation_context_line`  (lines 602–608)

```
fn side_conversation_context_line(label: &str) -> Line<'static>
```

**Purpose**: Formats the label for a side conversation so it can appear as contextual footer text. Labels beginning with “Side ” get special emphasis on the word “Side.”

**Data flow**: It receives a label string. If the label starts with `Side `, it splits the prefix from the rest and styles them in magenta, making the prefix bold. Otherwise, it styles the whole label in magenta. It returns a line ready to draw.

**Call relations**: The bottom-pane renderer calls this when it needs to show side-conversation context in the footer.

*Call graph*: called by 1 (render_with_mask_and_textarea_right_reserve); 2 external calls (from, vec!).


##### `right_aligned_x`  (lines 610–631)

```
fn right_aligned_x(area: Rect, content_width: u16) -> Option<u16>
```

**Purpose**: Finds the x-position where right-aligned footer content should start. It keeps a standard padding from the terminal’s right edge.

**Data flow**: It receives a screen area and the width of the content to draw. If the area or content is empty, it returns nothing. Otherwise, it calculates the starting column, using the left padded edge if the content is too wide. It returns that column.

**Call relations**: `can_show_left_with_context`, `max_left_width_for_right`, and `render_context_right` all use this shared positioning rule so measuring and drawing agree.

*Call graph*: called by 3 (can_show_left_with_context, max_left_width_for_right, render_context_right); 1 external calls (is_empty).


##### `max_left_width_for_right`  (lines 633–645)

```
fn max_left_width_for_right(area: Rect, right_width: u16) -> Option<u16>
```

**Purpose**: Calculates how wide the left footer text may be while still leaving room for right-aligned context. This is used when the left status line may need truncation.

**Data flow**: It receives a screen area and the width of the right-side content. It asks `right_aligned_x` where the right content would begin, then subtracts the left indent and required gap. It returns the maximum safe left width, or nothing if the right side cannot be positioned.

**Call relations**: The bottom-pane renderer uses this when a passive status line and right-side indicator must share one row. It helps preserve a visible gap between them.

*Call graph*: calls 1 internal fn (right_aligned_x); called by 1 (render_with_mask_and_textarea_right_reserve).


##### `can_show_left_with_context`  (lines 647–656)

```
fn can_show_left_with_context(area: Rect, left_width: u16, context_width: u16) -> bool
```

**Purpose**: Checks whether left footer text and right footer context can appear on the same row without touching. It protects the UI from visual overlap.

**Data flow**: It receives the area, left text width, and right context width. It computes where the right content would start and compares that with the left text’s end plus a small gap. It returns true when both sides can coexist.

**Call relations**: The renderer and `single_line_footer_layout` call this before deciding to draw both sides. It shares the same right-alignment helper used by actual drawing.

*Call graph*: calls 1 internal fn (right_aligned_x); called by 2 (render_with_mask_and_textarea_right_reserve, single_line_footer_layout).


##### `render_context_right`  (lines 658–683)

```
fn render_context_right(area: Rect, buf: &mut Buffer, line: &Line<'static>)
```

**Purpose**: Draws a footer context line aligned to the right edge of the terminal area. This is used for context usage, mode labels, IDE context, and similar ambient information.

**Data flow**: It receives a screen area, a mutable buffer, and a styled line. It computes the right-aligned start column, then writes each span into the last row of the area, stopping if it reaches the edge. The buffer is updated in place.

**Call relations**: The bottom-pane renderer calls this after deciding that right-side context should be visible. It relies on `right_aligned_x` so the drawn position matches the earlier fit checks.

*Call graph*: calls 1 internal fn (right_aligned_x); called by 1 (render_with_mask_and_textarea_right_reserve); 3 external calls (set_span, width, is_empty).


##### `inset_footer_hint_area`  (lines 685–691)

```
fn inset_footer_hint_area(mut area: Rect) -> Rect
```

**Purpose**: Moves the footer hint drawing area slightly to the right. This gives separate hint items a bit of breathing room from the edge.

**Data flow**: It receives a rectangle. If the rectangle is wider than two columns, it increases its x-position by two and shrinks its width by two. It returns the adjusted rectangle.

**Call relations**: The main renderer and `render_footer_hint_items` use this before drawing compact hint-item rows.

*Call graph*: called by 2 (render_with_mask_and_textarea_right_reserve, render_footer_hint_items).


##### `render_footer_hint_items`  (lines 693–699)

```
fn render_footer_hint_items(area: Rect, buf: &mut Buffer, items: &[(String, String)])
```

**Purpose**: Draws a row of small key-and-label hint items, such as compact footer controls. If there are no items, it draws nothing.

**Data flow**: It receives a screen area, buffer, and a list of key/label pairs. It turns the pairs into one styled line with `footer_hint_items_line`, adjusts the drawing area with `inset_footer_hint_area`, and renders the line into the buffer.

**Call relations**: The bottom-pane renderer calls this for footer hint rows outside the main `FooterProps` flow. It shares formatting with `footer_hint_items_width` through `footer_hint_items_line`.

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

**Purpose**: Maps the current footer properties to the actual footer text lines. This is the central wording table for footer modes.

**Data flow**: It receives `FooterProps`, optional mode information, and hint flags. It first checks whether passive status text should replace instructional hints. If not, it matches the footer mode and builds the right line or lines, such as quit reminders, history search prompt, shortcut overlay, Esc hint, queue hint, or empty-composer shortcut hint. It returns a list of styled lines.

**Call relations**: `footer_height`, `footer_line_width`, and `render_footer_from_props` all call this. It hands off shortcut-overlay construction to `shortcut_overlay_lines` and passive context construction to `passive_footer_status_line`.

*Call graph*: calls 2 internal fn (passive_footer_status_line, shortcut_overlay_lines); called by 3 (footer_height, footer_line_width, render_footer_from_props); 1 external calls (vec!).


##### `passive_footer_status_line`  (lines 780–801)

```
fn passive_footer_status_line(props: &FooterProps) -> Option<Line<'static>>
```

**Purpose**: Builds the calm, contextual footer row shown when no urgent instruction is needed. It can show the configured status line, the active agent label, or both.

**Data flow**: It receives `FooterProps`. It first asks `shows_passive_footer_line` whether this mode is allowed to show passive context. If allowed, it starts with the configured status line when enabled, appends the active agent label with a separator when present, and returns the combined line. If not allowed, it returns nothing.

**Call relations**: The renderer and `footer_from_props_lines` call this when deciding whether ambient context should replace normal hints. It keeps passive information from hiding important action prompts.

*Call graph*: calls 1 internal fn (shows_passive_footer_line); called by 2 (render_with_mask_and_textarea_right_reserve, footer_from_props_lines); 1 external calls (from).


##### `shows_passive_footer_line`  (lines 807–816)

```
fn shows_passive_footer_line(props: &FooterProps) -> bool
```

**Purpose**: Decides whether the footer is allowed to show ambient context instead of instructions. It permits this only when the composer is idle enough that no urgent hint is needed.

**Data flow**: It receives `FooterProps`. It returns true for an empty composer, and true for a draft only when no task is running. It returns false for active instructional modes such as history search, quit reminder, shortcut overlay, and Esc hint.

**Call relations**: `passive_footer_status_line` and `uses_passive_footer_status_layout` call this as their basic permission check.

*Call graph*: called by 2 (passive_footer_status_line, uses_passive_footer_status_layout).


##### `uses_passive_footer_status_layout`  (lines 823–825)

```
fn uses_passive_footer_status_layout(props: &FooterProps) -> bool
```

**Purpose**: Says whether the special status-line layout should be used. That layout is only needed when the configurable status line is enabled and passive context is allowed.

**Data flow**: It receives `FooterProps`. It checks the status-line feature flag and calls `shows_passive_footer_line`. It returns true only when both conditions are true.

**Call relations**: The bottom-pane renderer calls this before choosing the layout path that reserves room for a left status line and right-side indicators.

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

**Purpose**: Measures the width of the footer line that would be produced from the current properties. This lets layout code check fit before drawing.

**Data flow**: It receives footer properties, optional mode information, and hint flags. It builds the footer lines with `footer_from_props_lines`, looks at the last line, measures its width, and returns that width. If there is no line, it returns zero.

**Call relations**: The bottom-pane renderer calls this when deciding whether the left footer content can share a row with right-side context.

*Call graph*: calls 1 internal fn (footer_from_props_lines); called by 1 (render_with_mask_and_textarea_right_reserve).


##### `footer_hint_items_width`  (lines 846–851)

```
fn footer_hint_items_width(items: &[(String, String)]) -> u16
```

**Purpose**: Measures how wide a compact footer hint-items row will be. This supports layout decisions before the row is rendered.

**Data flow**: It receives a list of key/label pairs. If the list is empty, it returns zero. Otherwise, it formats the row with `footer_hint_items_line`, measures it, and returns the width.

**Call relations**: The bottom-pane renderer calls this alongside `render_footer_hint_items`, and both use the same line-building helper so measuring matches drawing.

*Call graph*: calls 1 internal fn (footer_hint_items_line); called by 1 (render_with_mask_and_textarea_right_reserve).


##### `footer_hint_items_line`  (lines 853–864)

```
fn footer_hint_items_line(items: &[(String, String)]) -> Line<'static>
```

**Purpose**: Formats compact key-and-label footer items into one styled line. Keys are bold so they stand out from their descriptions.

**Data flow**: It receives key/label pairs. For each pair, it adds spacing, a bold key, and the label text, with wider spacing between items. It returns the completed line.

**Call relations**: `footer_hint_items_width` uses this for measuring, and `render_footer_hint_items` uses it for drawing. That shared path prevents layout and rendering from disagreeing.

*Call graph*: called by 2 (footer_hint_items_width, render_footer_hint_items); 3 external calls (from, with_capacity, format!).


##### `quit_shortcut_reminder_line`  (lines 877–879)

```
fn quit_shortcut_reminder_line(key: KeyBinding) -> Line<'static>
```

**Purpose**: Creates the temporary “press this key again to quit” message. This helps prevent accidental exits.

**Data flow**: It receives the quit key binding. It builds a dim footer line containing the key followed by “again to quit.” The line is returned for rendering.

**Call relations**: `footer_from_props_lines` uses this when the footer mode is `QuitShortcutReminder`.

*Call graph*: 2 external calls (from, vec!).


##### `esc_hint_line`  (lines 881–894)

```
fn esc_hint_line(esc_backtrack_hint: bool) -> Line<'static>
```

**Purpose**: Creates the temporary Escape-key hint for editing the previous message. It supports both the first prompt and the “press again” version.

**Data flow**: It receives whether the Escape backtrack hint is already primed. It builds a dim line using the Escape key. If primed, it says to press Esc again; otherwise, it shows the two-Escape sequence. The line is returned.

**Call relations**: `footer_from_props_lines` uses this when the footer mode is `EscHint`.

*Call graph*: calls 1 internal fn (plain); 2 external calls (from, vec!).


##### `shortcut_overlay_lines`  (lines 896–959)

```
fn shortcut_overlay_lines(state: ShortcutsState) -> Vec<Line<'static>>
```

**Purpose**: Builds the multi-line shortcut help overlay shown after the user asks for help. It lists available keys and adapts some labels to the current environment.

**Data flow**: It receives a `ShortcutsState` containing platform, task, collaboration-mode, and key-binding details. It walks through the shortcut descriptors, asks each for its display entry, places entries in a fixed order, lays them out in columns, and adds a note about customizing shortcuts with `/keymap`. It returns all overlay lines.

**Call relations**: `footer_from_props_lines` calls this for `ShortcutOverlay` mode. It delegates the column layout to `build_columns` and each shortcut’s wording to `ShortcutDescriptor::overlay_entry`.

*Call graph*: calls 1 internal fn (build_columns); called by 1 (footer_from_props_lines); 2 external calls (from, vec!).


##### `build_columns`  (lines 961–1006)

```
fn build_columns(entries: Vec<Line<'static>>) -> Vec<Line<'static>>
```

**Purpose**: Arranges shortcut help entries into two readable columns. This keeps the overlay compact while still easy to scan.

**Data flow**: It receives a list of lines. It pads the list so the columns are even, measures the widest entry in each column, then builds row lines with enough spaces between columns. It returns dimmed rows ready for the overlay.

**Call relations**: `shortcut_overlay_lines` calls this after it has collected and ordered all shortcut entries.

*Call graph*: called by 1 (shortcut_overlay_lines); 3 external calls (from, new, repeat_n).


##### `context_window_line`  (lines 1008–1020)

```
fn context_window_line(percent: Option<i64>, used_tokens: Option<i64>) -> Line<'static>
```

**Purpose**: Formats the context-window usage shown in the footer. The context window is the amount of conversation the model can still consider.

**Data flow**: It receives either a percent remaining or a token count already used. If percent is present, it clamps it to 0–100 and returns “N% context left.” If token usage is present, it formats the number compactly and returns “N used.” If neither is present, it returns “100% context left.”

**Call relations**: Rendering helpers and tests call this when they need a standard right-side context line. It uses `format_tokens_compact` for readable large token counts.

*Call graph*: called by 6 (right_footer_line_with_context, footer_snapshots, footer_status_line_truncates_to_keep_mode_indicator, snapshot_footer_with_context, snapshot_footer_with_indicators, snapshot_footer_with_mode_indicator); 3 external calls (from, format_tokens_compact, vec!).


##### `ShortcutBinding::matches`  (lines 1047–1049)

```
fn matches(&self, state: ShortcutsState) -> bool
```

**Purpose**: Checks whether a shortcut binding should be shown for the current shortcut overlay state. It is a thin wrapper around the binding’s display condition.

**Data flow**: It receives the current shortcut state. It asks its `DisplayCondition` whether that state qualifies and returns the yes-or-no answer.

**Call relations**: `ShortcutDescriptor::binding_for` uses this while scanning possible bindings for one shortcut.

*Call graph*: calls 1 internal fn (matches).


##### `DisplayCondition::matches`  (lines 1062–1070)

```
fn matches(self, state: ShortcutsState) -> bool
```

**Purpose**: Evaluates a rule for when a shortcut should appear. Examples include always showing it, showing it only under WSL, or showing it only when collaboration modes are enabled.

**Data flow**: It receives a display condition and the current shortcut state. It checks the relevant flag in the state, or returns true for `Always`. The result says whether the shortcut binding is currently valid.

**Call relations**: `ShortcutBinding::matches` calls this, and shortcut descriptors depend on it to choose platform- and mode-specific keys.

*Call graph*: called by 1 (matches).


##### `ShortcutDescriptor::binding_for`  (lines 1081–1083)

```
fn binding_for(&self, state: ShortcutsState) -> Option<&'static ShortcutBinding>
```

**Purpose**: Chooses the first key binding for a shortcut that applies in the current state. Some shortcuts have different keys depending on platform or settings.

**Data flow**: It receives a shortcut descriptor and the current shortcut state. It scans the descriptor’s list of bindings and returns the first one whose condition matches. If none match, it returns nothing.

**Call relations**: `ShortcutDescriptor::overlay_entry` calls this for shortcuts whose key is defined directly by the descriptor rather than supplied through customizable key hints.

*Call graph*: called by 1 (overlay_entry); 1 external calls (iter).


##### `ShortcutDescriptor::overlay_entry`  (lines 1085–1132)

```
fn overlay_entry(&self, state: ShortcutsState) -> Option<Line<'static>>
```

**Purpose**: Builds one visible row for the shortcut overlay. It combines the right key with the right explanatory text for the current state.

**Data flow**: It receives a shortcut descriptor and shortcut state. It chooses the key either from customizable key hints or from `binding_for`. It then builds a line with special wording for queueing/submitting, editing previous messages, and quitting/interruption. If no key applies, it returns nothing.

**Call relations**: `shortcut_overlay_lines` calls this for every descriptor in the shortcut list. This function is where each shortcut becomes user-facing help text.

*Call graph*: calls 1 internal fn (binding_for); 2 external calls (from, vec!).


##### `tests::snapshot_footer`  (lines 1289–1293)

```
fn snapshot_footer(name: &str, props: FooterProps)
```

**Purpose**: Small test helper that snapshots a normal footer at the standard width. It reduces repeated setup in the footer snapshot tests.

**Data flow**: It receives a snapshot name and footer properties. It forwards them to the more general mode-indicator snapshot helper with width 80 and no collaboration mode indicator. The result is a stored snapshot assertion.

**Call relations**: `tests::footer_snapshots` calls this for many common footer states. It delegates actual drawing and assertion to `snapshot_footer_with_mode_indicator`.

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

**Purpose**: Test helper that snapshots a footer with a specific context-usage line on the right. This makes it easy to test percent and token display.

**Data flow**: It receives a snapshot name, footer properties, an optional percent, and optional token usage. It creates the context line with `context_window_line` and forwards everything to the full snapshot helper. The snapshot assertion happens there.

**Call relations**: `tests::footer_snapshots` calls this for cases where the right-side context text matters.

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

**Purpose**: Draws one complete footer frame inside tests. It mirrors the real rendering decisions closely enough to snapshot the final terminal output.

**Data flow**: It receives a test terminal, desired height, footer properties, optional collaboration mode, IDE-context flag, and right context line. Inside a draw call, it computes hint flags, decides whether passive status layout is active, measures left and right content, truncates status text if needed, chooses collapsed single-line layouts when appropriate, and renders left and right footer pieces into the test buffer.

**Call relations**: All footer snapshot helpers call this before comparing output. It exercises many production helpers together, including height calculation, passive status logic, width checks, collapse layout, and right-side rendering.

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

**Purpose**: Test helper that snapshots a footer with an optional collaboration mode indicator. It uses the default context-window line.

**Data flow**: It receives a snapshot name, width, footer properties, and optional mode indicator. It creates the default context line and forwards the full setup to `snapshot_footer_with_mode_indicator_and_context`. The final snapshot is handled there.

**Call relations**: `tests::snapshot_footer` and `tests::footer_snapshots` use this for mode-label layout cases.

*Call graph*: calls 1 internal fn (context_window_line); 1 external calls (snapshot_footer_with_mode_indicator_and_context).


##### `tests::snapshot_footer_with_mode_indicator_and_context`  (lines 1496–1514)

```
fn snapshot_footer_with_mode_indicator_and_context(
        name: &str,
        width: u16,
        props: &FooterProps,
        collaboration_mode_indicator: Option<CollaborationModeIndicator>,
```

**Purpose**: Full snapshot helper for footer rendering with custom width, optional mode indicator, and custom right-side context. It is the main snapshot assertion path.

**Data flow**: It receives the snapshot name, terminal width, footer properties, optional mode indicator, and context line. It computes footer height, creates a test terminal, draws the footer frame, and records/asserts the snapshot.

**Call relations**: Other snapshot helpers funnel into this when they need to test exact footer output. It calls `footer_height` and `draw_footer_frame` before the snapshot assertion.

*Call graph*: calls 1 internal fn (footer_height); 4 external calls (new, assert_snapshot!, draw_footer_frame, new).


##### `tests::render_footer_with_mode_indicator_and_context`  (lines 1516–1533)

```
fn render_footer_with_mode_indicator_and_context(
        width: u16,
        props: &FooterProps,
        collaboration_mode_indicator: Option<CollaborationModeIndicator>,
        context_line: Line<
```

**Purpose**: Renders a footer test frame and returns the terminal contents as a string. Unlike snapshot helpers, this supports direct text assertions.

**Data flow**: It receives width, footer properties, optional mode indicator, and context line. It computes height, creates a VT100-style test backend, draws the frame, and returns the screen contents. No snapshot is recorded.

**Call relations**: `tests::footer_status_line_truncates_to_keep_mode_indicator` calls this so it can check for specific text and ellipsis characters.

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

**Purpose**: Test helper for snapshotting the footer with collaboration and IDE-context indicators. It focuses on the right-side indicator row.

**Data flow**: It receives a snapshot name, width, footer properties, optional collaboration mode, and whether IDE context is active. It computes height, creates a test terminal, draws the frame with the default context-window line, and asserts the snapshot.

**Call relations**: `tests::footer_snapshots` uses this for cases where the footer should show both mode and IDE context indicators.

*Call graph*: calls 2 internal fn (context_window_line, footer_height); 4 external calls (new, assert_snapshot!, draw_footer_frame, new).


##### `tests::footer_snapshots`  (lines 1556–2000)

```
fn footer_snapshots()
```

**Purpose**: Runs a broad set of snapshot tests for the footer’s visual output. These tests protect against accidental changes in wording, spacing, colors, and width behavior.

**Data flow**: It creates many different `FooterProps` combinations: empty composer, shortcut overlay, running task, quit reminder, Esc hint, queue hint, mode indicator, status line, truncation, and active agent label. Each case is passed to one of the snapshot helpers. The output is compared with stored snapshots.

**Call relations**: This test calls the default key bindings, context formatting, key-building helpers, and the snapshot helper family. It exercises the file’s main rendering paths together.

*Call graph*: calls 4 internal fn (default_bindings, context_window_line, ctrl, shift); 7 external calls (Char, from, snapshot_footer, snapshot_footer_with_context, snapshot_footer_with_indicators, snapshot_footer_with_mode_indicator, snapshot_footer_with_mode_indicator_and_context).


##### `tests::footer_status_line_truncates_to_keep_mode_indicator`  (lines 2003–2041)

```
fn footer_status_line_truncates_to_keep_mode_indicator()
```

**Purpose**: Tests that a long status line is shortened so the mode indicator remains visible. This guards an important narrow-width layout promise.

**Data flow**: It builds footer properties with a long status line and collaboration mode enabled. It renders the footer to a string, collapses whitespace for one check, and asserts that “Plan mode” remains, the longer cycle hint is omitted, and an ellipsis appears. The test passes only if truncation preserves the important indicator.

**Call relations**: It uses `render_footer_with_mode_indicator_and_context` instead of a snapshot so it can make targeted assertions about the rendered text.

*Call graph*: calls 3 internal fn (default_bindings, context_window_line, ctrl); 4 external calls (Char, from, assert!, render_footer_with_mode_indicator_and_context).


##### `tests::paste_image_shortcut_prefers_ctrl_alt_v_under_wsl`  (lines 2044–2081)

```
fn paste_image_shortcut_prefers_ctrl_alt_v_under_wsl()
```

**Purpose**: Tests the platform-specific paste-image shortcut choice. Under WSL, plain Ctrl+V is often intercepted by terminals, so the UI should prefer Ctrl+Alt+V.

**Data flow**: It finds the paste-image shortcut descriptor, detects whether the test is running under WSL, builds the expected key for that environment, asks the descriptor for its active binding, and compares the actual key with the expected one.

**Call relations**: This test calls `FooterKeyHints::default_bindings` for a realistic shortcut state and uses `ShortcutDescriptor::binding_for` through the descriptor to verify the condition logic.

*Call graph*: calls 4 internal fn (default_bindings, is_probably_wsl, ctrl, ctrl_alt); 2 external calls (Char, assert_eq!).


### Popup and selection view helpers
These files provide the reusable state, constants, row models, tabs, and numbered-row helpers used by lightweight selection-style bottom-pane views.

### `tui/src/bottom_pane/popup_consts.rs`

`util` · `during popup rendering in the terminal UI`

Popups in the bottom pane often need the same basic rules: they should not grow too tall, and they should tell the user how to accept or back out. This file is the shared toolbox for that. The constant MAX_POPUP_ROWS sets a common height limit so different popups do not feel randomly sized.

The rest of the file builds short footer lines for the terminal UI. These lines are made from normal text plus styled key hints, such as Enter or Esc. Think of it like a standard sign at the bottom of every dialog box: “Press Enter to confirm or Esc to go back.” Keeping that sign here avoids each popup inventing its own wording or key display.

The file also supports custom keymaps. A keymap is the user interface’s table of which keys mean which action. If a list-style popup has different accept or cancel keys, this file can build the same kind of footer using those bindings instead of hard-coded Enter and Esc. If one of the keys is missing, the helper gracefully shows only the available instruction. If both are missing, it returns an empty line rather than showing misleading help.

#### Function details

##### `standard_popup_hint_line`  (lines 16–24)

```
fn standard_popup_hint_line() -> Line<'static>
```

**Purpose**: Builds the default popup footer that tells the user to press Enter to confirm or Esc to go back. It is used when a popup follows the normal key behavior and does not need a custom keymap.

**Data flow**: It takes no input. It creates a terminal text line made of plain words plus formatted key labels for Enter and Esc, then returns that line for a popup to draw at the bottom.

**Call relations**: Popup rendering code calls this when it needs the standard instruction line, such as confirmation popups, feedback prompts, selection views, and search-related UI. It relies on the shared key-hint formatting code so the key names look the same as they do elsewhere in the interface.

*Call graph*: called by 18 (show_replace_thread_goal_confirmation, apply_standard_popup_hint, render, render, feedback_disabled_params, feedback_upload_consent_params, make_selection_view, renders_search_query_line_when_enabled, snapshot_footer_note_wraps, footer_hint (+8 more)); 2 external calls (from, vec!).


##### `standard_popup_hint_line_for_keymap`  (lines 26–33)

```
fn standard_popup_hint_line_for_keymap(list_keymap: &ListKeymap) -> Line<'static>
```

**Purpose**: Builds the usual confirm-and-cancel footer, but using the keys defined by a supplied list keymap instead of assuming Enter and Esc. This matters for configurable controls or screens whose list navigation uses different bindings.

**Data flow**: It receives a ListKeymap, reads its accept and cancel actions, asks for the primary key binding for each action, and passes those bindings along with the standard labels “to confirm” and “to go back.” It returns the finished terminal text line.

**Call relations**: Selection-view setup and the standard hint-building path use this when the popup should reflect the active keymap. It hands the actual sentence construction to accept_cancel_hint_line, keeping this function focused on translating a keymap into the two keys a footer needs.

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

**Purpose**: Creates a popup footer from optional accept and cancel key bindings plus the words that describe what those keys do. It is the flexible helper behind both standard and custom popup instructions.

**Data flow**: It receives an optional accept key, an accept label, an optional cancel key, and a cancel label. If both keys exist, it returns a line like “Press [accept] ... or [cancel] ...”; if only one exists, it returns a line for just that key; if neither exists, it returns an empty line. It does not change any outside state.

**Call relations**: Higher-level popup code calls this when it already knows which keys should be shown, including approval footers and keymap-based popup hints. This function does the final assembly of the user-facing sentence so callers do not each need to duplicate the same branching logic.

*Call graph*: called by 2 (approval_footer_hint, standard_popup_hint_line_for_keymap); 2 external calls (from, vec!).


### `tui/src/bottom_pane/scroll_state.rs`

`domain_logic` · `user input handling and list rendering`

Many screens in a terminal interface show a list that is taller than the space available. This file solves the everyday problem of keeping the highlighted row and the scroll position in sync, like moving a bookmark through a long menu while a small window shows only part of the page. The central type, `ScrollState`, stores two pieces of information: the selected row, if there is one, and the first visible row at the top of the scroll window. It does not store the list itself. Instead, callers pass in the current list length and the number of visible rows each time they move around. That matters because lists can change after filtering, searching, or resizing. The helper can then clamp the selection so it never points past the end, clear it when the list is empty, move up or down with wrap-around, page up or down without wrapping, and jump to the top or bottom. The important safety behavior is that empty lists always reset to no selection and scroll position zero. Another key behavior is `ensure_visible`, which nudges the scroll window just enough so the selected row is not hidden above or below the visible area.

#### Function details

##### `ScrollState::new`  (lines 21–26)

```
fn new() -> Self
```

**Purpose**: Creates a fresh scroll state with no selected row and the view positioned at the top. UI panes use this when they first create a list-like menu.

**Data flow**: No outside data goes in. It builds a `ScrollState` where `selected_idx` is `None` and `scroll_top` is `0`, then returns that new value.

**Call relations**: Many constructors and setup paths call this when a pane, event view, prompt, or action state needs its own list navigation memory. After creation, other movement and visibility functions update the state as the user navigates.

*Call graph*: called by 17 (action_state, new, new, new, from_entry, open_selected_event, return_to_events, new, new, open_reset_confirmation (+7 more)).


##### `ScrollState::reset`  (lines 29–32)

```
fn reset(&mut self)
```

**Purpose**: Clears the current selection and moves the scroll window back to the top. This is useful when the list content changes enough that the old position should no longer be trusted.

**Data flow**: It takes an existing mutable scroll state. It sets the selected row to `None` and sets the top visible row to `0`; it does not return a separate value.

**Call relations**: Composer text changes, empty prompt setup, and tab switches call this when the old list position should be discarded. Afterward, callers can choose a new valid selection with functions such as `clamp_selection`.

*Call graph*: called by 3 (on_composer_text_change, set_empty_prompt, switch_tab).


##### `ScrollState::clamp_selection`  (lines 35–40)

```
fn clamp_selection(&mut self, len: usize)
```

**Purpose**: Makes sure the selected row is valid for the current list length. If there is no selection yet, it selects the first row; if the list is empty, it clears everything.

**Data flow**: The caller provides the current number of rows. The function first asks `clear_if_empty` whether the list has no rows. If rows exist, it takes the current selected index, defaults it to `0` if missing, and lowers it if needed so it is not beyond the last row.

**Call relations**: Filtering and match-updating code calls this after a visible row set changes. It relies on `clear_if_empty` for the empty-list case, then leaves the state ready for later movement or visibility adjustment.

*Call graph*: calls 1 internal fn (clear_if_empty); called by 7 (on_composer_text_change, set_matches, apply_filter, clamp_selection, apply_filter, clamp_selection, apply_filter).


##### `ScrollState::move_up_wrap`  (lines 43–52)

```
fn move_up_wrap(&mut self, len: usize)
```

**Purpose**: Moves the selection one row upward, wrapping from the first row to the last row. This gives arrow-key navigation the familiar circular menu behavior.

**Data flow**: The caller provides the current row count. If the count is zero, `clear_if_empty` resets the state. Otherwise, the selected row moves from `n` to `n - 1`, from the first row to the last row, or from no selection to the first row.

**Call relations**: Higher-level `move_up` operations in several panes call this when the user presses the up key. Those callers commonly follow it with visibility work so the newly selected row can be shown on screen.

*Call graph*: calls 1 internal fn (clear_if_empty); called by 10 (move_up, move_up, move_up, move_up, move_up, skip_disabled_up, move_up, move_up, move_up, move_up).


##### `ScrollState::move_down_wrap`  (lines 55–63)

```
fn move_down_wrap(&mut self, len: usize)
```

**Purpose**: Moves the selection one row downward, wrapping from the last row back to the first row. This supports repeated down-arrow navigation through a menu.

**Data flow**: The caller provides the current row count. If there are no rows, `clear_if_empty` resets the state. Otherwise, the selected row advances by one when possible, or becomes `0` when it was at the end or not yet set.

**Call relations**: Higher-level `move_down` operations and disabled-item skipping code call this during user navigation. The selected index it produces is then used by callers to update what is highlighted and visible.

*Call graph*: calls 1 internal fn (clear_if_empty); called by 10 (move_down, move_down, move_down, move_down, move_down, skip_disabled_down, move_down, move_down, move_down, move_down).


##### `ScrollState::page_up_clamped`  (lines 70–78)

```
fn page_up_clamped(&mut self, len: usize, visible_rows: usize)
```

**Purpose**: Moves the selection upward by one visible page, stopping at the first row instead of wrapping. This matches normal terminal list behavior for Page Up.

**Data flow**: The caller provides the row count and the number of rows that fit on screen. The function clears the state if the list is empty, chooses a page size of at least one row, moves the selected row upward by that amount without going below zero, then calls `ensure_visible` so the result is on screen.

**Call relations**: Pane-level `page_up` actions call this when the user requests a larger upward jump. It uses `clear_if_empty` for safety and hands the final selected row to `ensure_visible` to adjust the scroll window.

*Call graph*: calls 2 internal fn (clear_if_empty, ensure_visible); called by 5 (page_up, page_up, page_up, page_up, page_up).


##### `ScrollState::page_down_clamped`  (lines 85–93)

```
fn page_down_clamped(&mut self, len: usize, visible_rows: usize)
```

**Purpose**: Moves the selection downward by one visible page, stopping at the last row instead of wrapping. This matches normal terminal list behavior for Page Down.

**Data flow**: The caller provides the row count and visible window height. The function clears the state if needed, chooses a page size of at least one row, moves the selection down by that amount without passing the last row, then calls `ensure_visible` to keep the selection in view.

**Call relations**: Pane-level `page_down` actions call this for larger downward jumps. It combines empty-list protection from `clear_if_empty` with final scroll adjustment from `ensure_visible`.

*Call graph*: calls 2 internal fn (clear_if_empty, ensure_visible); called by 5 (page_down, page_down, page_down, page_down, page_down).


##### `ScrollState::jump_top`  (lines 96–102)

```
fn jump_top(&mut self, len: usize, visible_rows: usize)
```

**Purpose**: Selects the first row in the list and scrolls so that row can be seen. It is used for a Home-key style jump.

**Data flow**: The caller provides the row count and visible window height. If the list is empty, the state is cleared. Otherwise, the selected row becomes `0`, and `ensure_visible` updates `scroll_top` if necessary.

**Call relations**: Higher-level `jump_top` commands call this when the user wants to go straight to the beginning of a list. It delegates empty-list cleanup to `clear_if_empty` and screen-position cleanup to `ensure_visible`.

*Call graph*: calls 2 internal fn (clear_if_empty, ensure_visible); called by 5 (jump_top, jump_top, jump_top, jump_top, jump_top).


##### `ScrollState::jump_bottom`  (lines 105–111)

```
fn jump_bottom(&mut self, len: usize, visible_rows: usize)
```

**Purpose**: Selects the last row in the list and scrolls so that row can be seen. It is used for an End-key style jump.

**Data flow**: The caller provides the row count and visible window height. If there are no rows, the state is cleared. Otherwise, the selected row becomes `len - 1`, and `ensure_visible` moves the scroll window down if the last row is outside it.

**Call relations**: Higher-level `jump_bottom` commands call this when the user wants to go straight to the end of a list. It uses `clear_if_empty` to avoid invalid selection and `ensure_visible` to make the jump visible.

*Call graph*: calls 2 internal fn (clear_if_empty, ensure_visible); called by 5 (jump_bottom, jump_bottom, jump_bottom, jump_bottom, jump_bottom).


##### `ScrollState::clear_if_empty`  (lines 113–120)

```
fn clear_if_empty(&mut self, len: usize) -> bool
```

**Purpose**: Checks whether the current list has no rows, and if so, resets the scroll state. This private helper keeps all navigation methods from accidentally selecting a row that does not exist.

**Data flow**: It receives the current row count. If the count is not zero, it leaves the state unchanged and returns `false`. If the count is zero, it sets the selection to `None`, sets `scroll_top` to `0`, and returns `true`.

**Call relations**: All selection-changing methods call this before doing their own work. It acts like a guard at the door: empty lists are handled once, consistently, before any movement calculation can happen.

*Call graph*: called by 7 (clamp_selection, jump_bottom, jump_top, move_down_wrap, move_up_wrap, page_down_clamped, page_up_clamped).


##### `ScrollState::ensure_visible`  (lines 124–141)

```
fn ensure_visible(&mut self, len: usize, visible_rows: usize)
```

**Purpose**: Adjusts the top of the scroll window so the selected row is inside the visible area. It does not change which row is selected; it changes what slice of the list is shown.

**Data flow**: The caller provides the row count and visible window height. If the list or window is empty, `scroll_top` becomes `0`. If there is a selected row above the current window, `scroll_top` moves up to that row. If the selected row is below the current window, `scroll_top` moves down just enough to include it. If nothing is selected, the view returns to the top.

**Call relations**: Movement, filtering, text-change, and match-setting paths call this after the selected row may have changed. Page and jump methods call it directly, while simpler up/down callers often call it themselves after moving.

*Call graph*: called by 33 (move_down, move_up, on_composer_text_change, move_down, move_up, move_down, move_up, set_matches, move_down, move_up (+15 more)).


##### `tests::wrap_navigation_and_visibility`  (lines 149–171)

```
fn wrap_navigation_and_visibility()
```

**Purpose**: Checks that up/down navigation wraps correctly and that the selected row remains visible. It protects the expected arrow-key behavior from accidental changes.

**Data flow**: The test creates a new scroll state, uses a ten-row list with five visible rows, selects an initial row, moves up from the top to the bottom, then moves down back to the top. At each step it compares the state against expected selection and scroll values.

**Call relations**: This test calls `ScrollState::new` and then exercises the public navigation and visibility methods together. It verifies the story that real callers rely on: move the selection, then make sure the screen window follows it.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, assert_eq!, panic!).


##### `tests::page_and_jump_navigation_clamps`  (lines 174–203)

```
fn page_and_jump_navigation_clamps()
```

**Purpose**: Checks that page movement and top/bottom jumps stop at list edges and set the scroll window correctly. It protects the non-wrapping behavior of Page Up, Page Down, Home, and End style actions.

**Data flow**: The test creates a new scroll state, uses a ten-row list with four visible rows, then pages down several times, pages up once, jumps to the top, and jumps to the bottom. After each action it checks both the selected row and the top visible row.

**Call relations**: This test calls `ScrollState::new` and then drives the page and jump methods as a user would. It confirms that those methods cooperate with `ensure_visible` so the selection lands at the expected edge and remains visible.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


### `tui/src/bottom_pane/selection_popup_common.rs`

`domain_logic` · `main loop rendering`

Selection popups all need to solve the same small but tricky visual problem: show a list of choices in a narrow terminal area, keep the selected choice visible, and make names, descriptions, shortcuts, and disabled reasons readable. This file is the common toolbox for that job.

It defines a render-ready row shape, `GenericDisplayRow`, which is already formatted for display rather than tied to any one feature’s data model. A row can have a name, prefix styling, keyboard shortcut, search-match highlighting, a grey description, a category tag, or a disabled reason. The file also defines how the name and description columns are sized: based on visible rows, all rows, or a fixed split.

The main flow is: reserve the padded menu surface, decide which rows are visible from the scroll state, calculate where the description column should start, build styled terminal lines, wrap them if needed, apply selected or disabled styling, then paint them into the terminal buffer. It also has matching height-measurement functions so callers can ask, “How tall will this popup be?” before rendering it. Without this file, each popup would likely align, wrap, scroll, and highlight rows slightly differently, causing visual bugs and clipped text.

#### Function details

##### `ColumnWidthConfig::new`  (lines 65–70)

```
fn new(mode: ColumnWidthMode, name_column_width: Option<usize>) -> Self
```

**Purpose**: Creates a column-width setting for popup rows. Callers use it when they want to choose how the name column and description column should share horizontal space.

**Data flow**: It receives a column width mode and an optional preferred name-column width. It stores those two values together and returns a `ColumnWidthConfig` that later rendering or measuring code can follow.

**Call relations**: Higher-level height and render code calls this when it needs an explicit column layout choice instead of the default. The resulting config is passed down into the row measuring and drawing path.

*Call graph*: called by 2 (desired_height, render).


##### `menu_surface_inset`  (lines 85–87)

```
fn menu_surface_inset(area: Rect) -> Rect
```

**Purpose**: Shrinks a popup rectangle to leave the standard padding around menu contents. This keeps bottom-pane overlays from drawing text right against their border or edge.

**Data flow**: It receives a terminal rectangle. It applies a fixed vertical and horizontal inset, then returns the smaller rectangle where inner content should be drawn.

**Call relations**: Code that positions cursors, measures popup height, or renders confirmation/input overlays calls this so all menu-like surfaces use the same inner spacing. `render_menu_surface` also calls it after painting the background.

*Call graph*: calls 1 internal fn (vh); called by 7 (cursor_pos, desired_height, cursor_pos_impl, desired_height, unanswered_confirmation_height, desired_height_keeps_spacers_and_preferred_options_visible, render_menu_surface); 1 external calls (inset).


##### `menu_surface_padding_height`  (lines 90–92)

```
fn menu_surface_padding_height() -> u16
```

**Purpose**: Reports how many terminal rows are used by the menu surface’s top and bottom padding. Callers use it when calculating how tall a popup needs to be.

**Data flow**: It reads the fixed vertical padding constant, doubles it for top plus bottom, and returns that number.

**Call relations**: Popup height calculations call this so they include the same padding that rendering will actually apply. This helps prevent content from being clipped because measurement and drawing disagree.

*Call graph*: called by 3 (desired_height, desired_height, unanswered_confirmation_height).


##### `render_menu_surface`  (lines 99–107)

```
fn render_menu_surface(area: Rect, buf: &mut Buffer) -> Rect
```

**Purpose**: Paints the shared menu background and returns the padded inner area for content. It gives selection-style overlays a consistent surface color and spacing.

**Data flow**: It receives an outer rectangle and a mutable terminal buffer. If the rectangle is not empty, it fills that area with the user-message style, then returns the inset rectangle where callers should render the menu’s actual text.

**Call relations**: Popup renderers call this near the start of drawing. It delegates the padding calculation to `menu_surface_inset`, then hands the returned content rectangle back to the caller for the next rendering steps.

*Call graph*: calls 2 internal fn (menu_surface_inset, user_message_style); called by 5 (render, render, render, render_ui_at, render_unanswered_confirmation); 2 external calls (default, is_empty).


##### `wrap_styled_line`  (lines 113–122)

```
fn wrap_styled_line(line: &'a Line<'a>, width: u16) -> Vec<Line<'a>>
```

**Purpose**: Wraps a styled line of terminal text to fit a given width while keeping its styling. This is useful when a message may be too long for the available space.

**Data flow**: It receives a styled line and a target width. It clamps the width to at least one cell, asks the wrapping helper to split the line without adding indentation, and returns the wrapped lines.

**Call relations**: Height calculation and unanswered-confirmation layout code call this when they need to know or produce the line breaks for styled text. It relies on the shared wrapping system so style spans survive the split.

*Call graph*: calls 1 internal fn (new); called by 2 (desired_height, unanswered_confirmation_layout); 1 external calls (from).


##### `line_to_owned`  (lines 124–137)

```
fn line_to_owned(line: Line<'_>) -> Line<'static>
```

**Purpose**: Turns a styled line that may borrow text into one that owns its text. This makes wrapped lines safe to store or return without depending on the lifetime of the original input.

**Data flow**: It receives a `Line` whose spans may refer to borrowed text. It copies each span’s content into owned strings while preserving style and alignment, then returns a fully owned line.

**Call relations**: This helper is used inside `wrap_standard_row` after word wrapping. It bridges between the wrapping helper’s borrowed output and the renderer’s need for self-contained lines.


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

**Purpose**: Decides where the description column should start. This keeps option names on the left and explanatory text lined up on the right.

**Data flow**: It receives all rows, the current starting row, how many rows are considered visible, the available width, and the column-width configuration. It measures row names according to the chosen mode, applies caps so descriptions still have room, and returns a column number.

**Call relations**: Rendering, single-line rendering, height measurement, and wrapped-selection adjustment all call this before building row text. Its answer controls how `build_full_line` and wrapping helpers align names and descriptions.

*Call graph*: called by 4 (adjust_start_for_wrapped_selection_visibility, measure_rows_height_inner, render_rows_inner, render_rows_single_line_with_col_width_mode); 1 external calls (iter).


##### `wrap_indent`  (lines 206–216)

```
fn wrap_indent(row: &GenericDisplayRow, desc_col: usize, max_width: u16) -> usize
```

**Purpose**: Chooses how far continuation lines should be indented when a row wraps. This makes wrapped descriptions line up under the description column instead of starting at the far left.

**Data flow**: It receives a row, the chosen description column, and the maximum width. It uses the row’s explicit wrap indent if present, otherwise uses the description column when the row has descriptive or disabled text, and clamps the result so it fits.

**Call relations**: `wrap_standard_row` calls this while preparing word-wrap options. It supplies the indentation that makes multi-line rows readable.

*Call graph*: called by 1 (wrap_standard_row).


##### `should_wrap_name_in_column`  (lines 218–228)

```
fn should_wrap_name_in_column(row: &GenericDisplayRow) -> bool
```

**Purpose**: Checks whether a row is simple enough to use the special two-column wrapping layout. This path is meant for plain rows with long names and descriptions.

**Data flow**: It reads the row’s display features. It returns true only when the row has an explicit wrap indent and description, and does not have disabled text, match highlighting, shortcuts, tags, or prefix spans that would complicate two-column wrapping.

**Call relations**: `wrap_row_lines` uses this as a gate. If it says yes, the row may be wrapped by `wrap_two_column_row`; otherwise the safer standard wrapping path is used.

*Call graph*: called by 1 (wrap_row_lines).


##### `wrap_two_column_row`  (lines 230–288)

```
fn wrap_two_column_row(row: &GenericDisplayRow, desc_col: usize, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Wraps a plain row as two side-by-side columns: name on the left, description on the right. This keeps long option labels and long explanations readable without mixing them together.

**Data flow**: It receives a row, description-column position, and width. It wraps the name within the left column and the description within the right column, then combines corresponding lines with spacing between them. If the terminal is too narrow for a valid split, it returns no lines so the caller can fall back.

**Call relations**: `wrap_row_lines` calls this for rows approved by `should_wrap_name_in_column`. A test also calls it directly to confirm that a one-cell-wide layout returns safely instead of crashing.

*Call graph*: called by 2 (one_cell_width_falls_back_without_panic_for_wrapped_two_column_rows, wrap_row_lines); 5 external calls (from, new, with_capacity, new, wrap).


##### `wrap_standard_row`  (lines 290–303)

```
fn wrap_standard_row(row: &GenericDisplayRow, desc_col: usize, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds a normal full row line and wraps it if it is too wide. This is the general-purpose path for rows with styling, shortcuts, fuzzy-match highlights, disabled text, or tags.

**Data flow**: It receives a row, description column, and width. It first builds the styled full line, calculates continuation indentation, wraps the line, converts the result into owned lines, and returns them.

**Call relations**: `wrap_row_lines` calls this whenever the special two-column path is not appropriate or cannot produce output. It depends on `build_full_line` for the row content and `wrap_indent` for continuation spacing.

*Call graph*: calls 3 internal fn (build_full_line, wrap_indent, new); called by 1 (wrap_row_lines); 1 external calls (from).


##### `wrap_row_lines`  (lines 305–314)

```
fn wrap_row_lines(row: &GenericDisplayRow, desc_col: usize, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Chooses the best wrapping strategy for one display row. It hides the difference between the special two-column layout and the standard full-line layout.

**Data flow**: It receives a row, description column, and width. It tries two-column wrapping for simple eligible rows; if that does not apply or returns nothing, it produces standard wrapped lines instead.

**Call relations**: Rendering, measuring, and selected-row visibility checks all call this because they need to know how many terminal lines a row will occupy. It coordinates `should_wrap_name_in_column`, `wrap_two_column_row`, and `wrap_standard_row`.

*Call graph*: calls 3 internal fn (should_wrap_name_in_column, wrap_standard_row, wrap_two_column_row); called by 3 (is_selected_visible_in_wrapped_viewport, measure_rows_height_inner, render_rows_inner).


##### `apply_row_state_style`  (lines 316–331)

```
fn apply_row_state_style(lines: &mut [Line<'static>], selected: bool, is_disabled: bool)
```

**Purpose**: Applies visual state to already-built row lines. Selected rows get the accent style, and disabled rows are dimmed.

**Data flow**: It receives mutable styled lines plus flags for selected and disabled. It rewrites the style of each span in those lines, first applying the selected accent if needed, then dimming disabled content if needed.

**Call relations**: `render_rows_inner` calls this just before painting wrapped lines into the buffer. This keeps row construction separate from state-dependent styling.

*Call graph*: called by 1 (render_rows_inner); 1 external calls (iter_mut).


##### `compute_item_window_start`  (lines 333–354)

```
fn compute_item_window_start(
    rows_all: &[GenericDisplayRow],
    state: &ScrollState,
    max_items: usize,
) -> usize
```

**Purpose**: Finds which item index should appear first in the visible list. It keeps the selected item inside the item window when possible.

**Data flow**: It receives all rows, scroll state, and the maximum number of items to show. It starts from the scroll position, then moves the start upward or downward if the selected item would otherwise fall outside the visible item range.

**Call relations**: `adjust_start_for_wrapped_selection_visibility` calls this as the first pass. That later function refines the answer for rows that may take more than one terminal line.

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

**Purpose**: Checks whether the selected item actually appears within the available terminal height after row wrapping. This matters because one item can take several lines.

**Data flow**: It receives the rows, proposed start index, item limit, selected index, description column, width, and viewport height. It simulates wrapping and counting lines from the start index until the viewport is full, then returns whether the selected row was reached.

**Call relations**: `adjust_start_for_wrapped_selection_visibility` calls this while deciding whether it must move the starting item forward. It uses `wrap_row_lines` so its visibility check matches rendering behavior.

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

**Purpose**: Adjusts the first visible item so the selected row remains visible even when earlier rows wrap onto multiple lines. This avoids the confusing case where the selected item is technically in the item window but pushed below the screen.

**Data flow**: It receives rows, scroll state, item limits, width, height, and column settings. It computes an initial item-window start, then repeatedly checks whether the selected row is visible in the line-based viewport and advances the start until it is or cannot advance further.

**Call relations**: `render_rows_inner` calls this before drawing wrapped rows. It combines `compute_item_window_start`, `compute_desc_col`, and `is_selected_visible_in_wrapped_viewport` so scrolling works for both one-line and multi-line rows.

*Call graph*: calls 3 internal fn (compute_desc_col, compute_item_window_start, is_selected_visible_in_wrapped_viewport); called by 1 (render_rows_inner).


##### `build_full_line`  (lines 430–511)

```
fn build_full_line(row: &GenericDisplayRow, desc_col: usize) -> Line<'static>
```

**Purpose**: Builds the styled terminal line for one row before wrapping or truncation. It combines the row name, optional prefix, shortcut, description, disabled reason, search-match emphasis, and category tag.

**Data flow**: It receives a display row and the description column. It creates styled spans for the name, bolds matched characters if search indices are present, shortens the name if it would collide with the description, adds disabled labels and shortcut text, pads to the description column, then returns one styled line.

**Call relations**: `wrap_standard_row` uses this before wrapping, and single-line rendering uses it before truncating. It is the central row assembly step that turns row data into visible terminal text.

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

**Purpose**: Draws a wrapped selection list into the terminal buffer. It is the shared engine behind the public wrapped row render functions.

**Data flow**: It receives a drawing area, buffer, all rows, scroll state, result limit, empty message, and column-width settings. It draws an empty placeholder if needed, chooses the visible start row, computes description alignment, wraps each row, applies selected or disabled styling, paints lines until vertical space runs out, and returns how many terminal lines were drawn.

**Call relations**: `render_rows` and `render_rows_with_col_width_mode` delegate to this. It pulls together scrolling, column calculation, wrapping, state styling, and actual buffer rendering.

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

**Purpose**: Draws wrapped selection rows using the default column-width behavior. This is the convenient entry point for most selection popups.

**Data flow**: It receives the drawing area, buffer, rows, scroll state, maximum results, and empty message. It adds the default column configuration and passes everything to the shared renderer, returning the number of terminal lines drawn.

**Call relations**: Many popup render paths call this when they want standard wrapped list behavior. It is a thin wrapper around `render_rows_inner`.

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

**Purpose**: Draws wrapped selection rows with an explicit column-width configuration. Callers use it when they need stable or fixed column placement instead of the default.

**Data flow**: It receives the same rendering inputs as `render_rows`, plus a `ColumnWidthConfig`. It forwards them to the shared rendering engine and returns the number of lines drawn.

**Call relations**: Renderers that care about a specific column sizing mode call this. It feeds directly into `render_rows_inner`, which does the real drawing.

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

**Purpose**: Draws selection rows as one terminal line each, without wrapping. This is useful for denser popups where multi-line rows would make the list jump around vertically.

**Data flow**: It receives the area, buffer, rows, scroll state, result limit, and empty message. It supplies the default column configuration and calls the configurable single-line renderer.

**Call relations**: Popup renderers call this when they want compact list behavior. It delegates to `render_rows_single_line_with_col_width_mode`.

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

**Purpose**: Draws rows as single lines with explicit column-width behavior, cutting off overflow with an ellipsis. An ellipsis is the “…” mark that tells the user text continued but did not fit.

**Data flow**: It receives the drawing area, buffer, rows, scroll state, result limit, empty message, and column settings. It handles the empty case, chooses visible rows from the scroll state, computes the description column, builds each full line, applies selected or disabled styling, truncates text that is too wide, renders one line per row, and returns the number of lines drawn.

**Call relations**: Some render paths call this directly, while `render_rows_single_line` calls it with defaults. It uses `build_full_line`, `compute_desc_col`, and the line-truncation helper to create compact output.

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

**Purpose**: Calculates how many terminal rows a wrapped selection list will need using the default column behavior. Callers use this before rendering so they can reserve enough vertical space.

**Data flow**: It receives rows, scroll state, maximum results, and width. It applies the default column configuration, delegates to the shared measurement logic, and returns the required height.

**Call relations**: Popup layout and desired-height code call this before drawing. It must match `render_rows` so the measured height agrees with what will actually be rendered.

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

**Purpose**: Calculates wrapped selection-list height with an explicit column-width configuration. This is the measuring companion to the configurable wrapped renderer.

**Data flow**: It receives rows, scroll state, maximum results, width, and a column setting. It passes them to the shared measurement function and returns the number of terminal rows needed.

**Call relations**: Layout code that will render with `render_rows_with_col_width_mode` calls this first. Using the same column settings prevents underestimating or overestimating the popup height.

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

**Purpose**: Performs the actual height calculation for wrapped rows. It estimates the same wrapping and alignment that rendering will use.

**Data flow**: It receives rows, scroll state, maximum results, width, and column settings. It returns one line for an empty placeholder if there are no rows; otherwise it chooses the visible item window, computes the description column, wraps each visible row, adds up their line counts, and returns at least one row of height.

**Call relations**: `measure_rows_height` and `measure_rows_height_with_col_width_mode` both delegate to this. It shares `compute_desc_col` and `wrap_row_lines` with rendering so measurement stays consistent.

*Call graph*: calls 2 internal fn (compute_desc_col, wrap_row_lines); called by 2 (measure_rows_height, measure_rows_height_with_col_width_mode); 3 external calls (is_empty, iter, len).


##### `tests::one_cell_width_falls_back_without_panic_for_wrapped_two_column_rows`  (lines 846–856)

```
fn one_cell_width_falls_back_without_panic_for_wrapped_two_column_rows()
```

**Purpose**: Checks that the two-column wrapping code behaves safely when the available width is only one terminal cell. This protects against crashes in extremely narrow layouts.

**Data flow**: It creates a row with a long name, description, and wrap indent, then asks `wrap_two_column_row` to wrap it at width one. It expects an empty result, meaning the caller can fall back to another layout instead of panicking.

**Call relations**: This test calls `wrap_two_column_row` directly. It documents and verifies the narrow-width fallback that `wrap_row_lines` relies on.

*Call graph*: calls 1 internal fn (wrap_two_column_row); 2 external calls (default, assert_eq!).


##### `tests::selected_rows_use_the_shared_accent_style`  (lines 859–879)

```
fn selected_rows_use_the_shared_accent_style()
```

**Purpose**: Checks that selected rows are drawn with the shared accent style. This ensures popups use the same visual language for the current choice.

**Data flow**: It builds one row, marks it selected in the scroll state, renders it into a small buffer, then compares the first cell’s style with the expected accent style and confirms bold styling is present.

**Call relations**: This test calls `render_rows`, which goes through the normal wrapped rendering path. It verifies that selection styling applied by `apply_row_state_style` reaches the terminal buffer.

*Call graph*: calls 2 internal fn (render_rows, accent_style); 6 external calls (empty, default, new, assert!, assert_eq!, vec!).


### `tui/src/bottom_pane/selection_tabs.rs`

`domain_logic` · `UI rendering`

This file is the small “tab bar” piece of the bottom pane UI. A tab here represents a selectable section, with an id, a visible label, a header to render, and a list of selection items. Without this file, the bottom pane could still have data to show, but it would not have a clear row of labels telling the user which section is active or letting the surrounding UI reserve the right amount of space for those labels.

The main work is turning a list of tabs into one or more display lines. If the terminal is wide enough, all tab labels sit on one line with a small gap between them. If the terminal is too narrow, the labels wrap onto additional lines, like words wrapping in a paragraph. The active tab is shown with brackets and the project’s accent color, for example “[Files]”, while inactive tabs are dimmed so they fade into the background.

Two public helpers use the same layout calculation. One asks, “How many rows will this tab bar need?” The other actually paints those rows into ratatui’s screen buffer, which is the off-screen drawing area for the terminal UI. This keeps measuring and drawing consistent: the UI does not reserve one shape and then render a different one.

#### Function details

##### `tab_bar_height`  (lines 23–31)

```
fn tab_bar_height(tabs: &[SelectionTab], active_idx: usize, width: u16) -> u16
```

**Purpose**: This function tells the rest of the UI how many terminal rows the tab bar will need. It is used before drawing so the bottom pane can reserve enough vertical space, especially when narrow terminals force tabs to wrap.

**Data flow**: It receives the list of tabs, the active tab position, and the available width. If there are no tabs, it returns 0 because nothing should be shown. Otherwise it builds the same wrapped tab lines that rendering will use, counts them, and returns that count as a terminal height.

**Call relations**: The surrounding bottom-pane layout calls this through desired_height and render when it needs to know how much space the tab strip will occupy. It delegates the real wrapping decision to tab_bar_lines so measuring and drawing stay in sync.

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

**Purpose**: This function draws the tab bar into the terminal UI buffer. It is the painting step: it takes the prepared tab labels and places them row by row inside the given screen rectangle.

**Data flow**: It receives the tabs, the active tab position, the rectangular area where the bar should appear, and the buffer to draw into. It asks tab_bar_lines to make the wrapped visual lines for the current width, clips them to the available height, and renders each line at the correct y-position. The output is not a returned value; the buffer is changed so the tab bar appears on screen.

**Call relations**: The bottom pane render flow calls this when it is time to draw. It relies on tab_bar_lines for layout and then hands each produced Line to ratatui’s rendering machinery to write into the buffer.

*Call graph*: calls 1 internal fn (tab_bar_lines); called by 1 (render).


##### `tab_bar_lines`  (lines 56–93)

```
fn tab_bar_lines(tabs: &[SelectionTab], active_idx: usize, width: u16) -> Vec<Line<'static>>
```

**Purpose**: This function turns the tab list into the actual lines of styled text that make up the tab bar. It is where wrapping happens when the available width is too small for all labels on one row.

**Data flow**: It receives the tabs, the active tab position, and the available width. For each tab, it asks tab_unit to create the styled label pieces, measures how wide that label will be, and either adds it to the current line or starts a new line if it would not fit. It returns a vector of ready-to-render text lines.

**Call relations**: Both tab_bar_height and render_tab_bar call this so they agree on the tab bar’s shape. For each individual tab, it calls tab_unit to get the visual form of that tab before deciding where it fits.

*Call graph*: calls 1 internal fn (tab_unit); called by 2 (render_tab_bar, tab_bar_height); 4 external calls (from, new, is_empty, iter).


##### `tab_unit`  (lines 95–106)

```
fn tab_unit(label: &str, active: bool) -> Vec<Span<'static>>
```

**Purpose**: This function creates the styled text pieces for one tab label. It makes the active tab stand out and makes inactive tabs visually quieter.

**Data flow**: It receives a label and a true-or-false value saying whether this is the active tab. If active, it applies the accent style to an opening bracket, the label, and a closing bracket. If inactive, it turns the label into dim text. It returns those styled pieces as spans that can later be placed into a line.

**Call relations**: tab_bar_lines calls this once for each tab while building the full tab strip. When a tab is active, this function also calls accent_style to use the shared highlight style for the application.

*Call graph*: calls 1 internal fn (accent_style); called by 1 (tab_bar_lines); 1 external calls (vec!).


### `tui/src/selection_list.rs`

`domain_logic` · `rendering`

This file is a small building block for menus and choice lists in the terminal user interface. When the app needs to show several options, each option needs a number, a clear marker for the currently selected item, and readable text even if the label is long. This file turns that information into a renderable row that the rest of the UI can draw.

Think of it like printing labels for a paper checklist. The selected row gets a special arrow marker, like “› 2.”, while the others line up with spaces so every label starts in the same place. The selected row is colored cyan so it stands out. A row can also be dimmed, which is useful when an option is visible but should look less important or unavailable.

The file also pays attention to character width. Terminal text can contain characters that take different amounts of screen space, so it measures the prefix before laying out the label. The label itself is placed in a paragraph widget that wraps across lines without trimming whitespace. The result is returned as a general Renderable object, so callers do not need to know the layout details.

#### Function details

##### `selection_option_row`  (lines 10–16)

```
fn selection_option_row(
    index: usize,
    label: String,
    is_selected: bool,
) -> Box<dyn Renderable>
```

**Purpose**: Creates a normal selectable-list row without dimming. Callers use this when they only need to show whether an option is selected or not.

**Data flow**: It receives the option’s position, its text label, and whether it is currently selected. It passes those values onward with dimming turned off, then returns the finished renderable row produced by the more flexible helper.

**Call relations**: Menu and reference renderers call this when drawing ordinary selection options. It acts as the simple front door and immediately hands the work to selection_option_row_with_dim so the row-building rules stay in one place.

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

**Purpose**: Creates a selectable-list row with full control over its appearance, including whether it is selected and whether it should look dimmed. This is the main row-building function in the file.

**Data flow**: It receives an index, label text, a selected flag, and a dim flag. It turns the index into a numbered prefix, adds an arrow if the row is selected, chooses the right style, measures the prefix width, and builds a two-part row: fixed-width prefix first, wrapping label second. It returns that row as a Renderable object ready for the terminal UI to draw.

**Call relations**: This function is used directly by some renderers when they need dimming control, and indirectly through selection_option_row for the common non-dimmed case. It creates the row layout and hands back a generic renderable object so the caller can place it into the larger screen without caring how the row was assembled.

*Call graph*: calls 1 internal fn (new); called by 2 (render_ref, selection_option_row); 4 external calls (new, default, width, format!).


### Compact display-model shaping
This group gathers small formatting and labeling helpers that convert raw domain/configuration data into concise TUI-facing display text and models.

### `tui/src/chatwidget/warnings.rs`

`domain_logic` · `request handling`

In the text user interface, warnings can appear while a chat is running. Some warnings are useful once, but annoying if repeated. This file keeps track of one specific kind: a warning that says the app could not find metadata for a model and is using fallback information instead. That matters because fallback metadata may make the app slower or less reliable, so the user should know — but only once per affected model.

The central piece is `WarningDisplayState`, which stores a set of model names, also called slugs, that have already triggered this warning. A set is like a guest list: if a name is already on it, adding it again tells you it was not new.

When a warning message arrives, `should_display` checks whether it matches the exact expected wording for the fallback metadata warning. If it is some other kind of message, the file says yes, show it. If it is the fallback warning, the file extracts the model slug from inside the message and checks whether that slug has been seen before. New slug means show the warning and remember it. Repeated slug means hide it. This keeps the chat UI informative without becoming noisy.

#### Function details

##### `WarningDisplayState::should_display`  (lines 13–16)

```
fn should_display(&mut self, message: &str) -> bool
```

**Purpose**: Decides whether a warning message should be shown in the chat UI. It always allows ordinary warnings, but suppresses repeated fallback-metadata warnings for the same model.

**Data flow**: It receives a warning message and reads the stored set of model slugs that have already produced fallback-metadata warnings. It first asks `fallback_model_metadata_warning_slug` whether the message is that special warning and, if so, what model slug it mentions. If the message is not that kind of warning, it returns `true`; if it is, it adds the slug to the set and returns `true` only when that slug was not already present.

**Call relations**: This is the public decision point for this file’s small warning-filtering behavior. When the chat code wants to know whether to display a warning, it calls this method; the method then delegates the message-shape check to `fallback_model_metadata_warning_slug` before deciding whether to show or suppress the warning.

*Call graph*: calls 1 internal fn (fallback_model_metadata_warning_slug).


##### `fallback_model_metadata_warning_slug`  (lines 19–23)

```
fn fallback_model_metadata_warning_slug(message: &str) -> Option<&str>
```

**Purpose**: Checks whether a message is exactly the known fallback-metadata warning and, if it is, pulls out the model slug mentioned inside it. This lets the caller recognize repeated warnings for the same model.

**Data flow**: It receives the full warning text. It tries to remove the expected beginning text and the expected ending text; if both match, whatever remains in the middle is treated as the model slug and returned. If either the beginning or ending does not match, it returns nothing, meaning the message is not this special warning.

**Call relations**: This helper is called by `WarningDisplayState::should_display` whenever a warning needs to be classified. It does not decide whether to show anything itself; it only identifies the special warning format and hands the extracted slug back so the display state can make the final choice.

*Call graph*: called by 1 (should_display).


### `tui/src/external_agent_config_migration_model.rs`

`domain_logic` · `migration UI setup and rendering`

When Codex offers to import settings or history from another agent, it may receive many different things: global setup files, project-specific files, server settings, commands, agents, and recent chat sessions. This file is the small translation layer that makes those items understandable for a person looking at the migration screen.

It first sorts migration items into a few human-sized buckets. Items with no project folder become “Tools & setup.” Items tied to a project folder become either “Current project” or “Projects,” depending on how many project folders are involved. Chat history becomes its own “Chat sessions” group. This is like sorting a moving box into labeled piles before asking someone what they want to keep.

The file also provides display text for individual items. For example, a settings migration is shown as “Settings (settings.json -> config.toml),” and chat history is shown as “Recent chat sessions.” When extra detail is available, it creates compact summaries such as “3 agents: helper, reviewer, planner.” To avoid overwhelming the screen, it only includes up to four names in the summary.

Without this file, the migration UI would still have the raw data, but it would lack the clear grouping and plain labels that make the import process understandable.

#### Function details

##### `external_agent_config_migration_groups`  (lines 12–76)

```
fn external_agent_config_migration_groups(
    items: &[ExternalAgentConfigMigrationItem],
) -> Vec<ExternalAgentConfigMigrationGroupModel>
```

**Purpose**: Builds the visible groups used by the migration screen, such as tools, projects, and chat sessions. It gives the UI a clean structure so users can review related migration items together.

**Data flow**: It receives a list of migration items. It scans the list and remembers the positions of items that belong to global tools and setup, project-specific files, or chat sessions. It then creates group objects with a label, a short explanation, and the item positions that belong in that group. The result is a list of groups ready for the UI to display.

**Call relations**: This function is called during construction by `new`, when the migration view or model is being prepared. It does not move or change the migration items themselves; it hands back an organized map of which item indices belong under each heading.

*Call graph*: called by 1 (new); 3 external calls (new, iter, format!).


##### `external_agent_config_migration_item_label`  (lines 78–92)

```
fn external_agent_config_migration_item_label(
    item: &ExternalAgentConfigMigrationItem,
) -> &'static str
```

**Purpose**: Returns the short, user-facing name for one migration item. It turns internal item types into labels a person can recognize on the migration screen.

**Data flow**: It receives one migration item and looks at its item type. Based on that type, it returns a fixed label such as “Skills,” “MCP servers,” or “Recent chat sessions.” It does not change the item or allocate a custom string; it returns one of the built-in label texts.

**Call relations**: This is a lookup helper for display code. The provided call graph does not show a specific caller, but its role is to supply the label text whenever the UI needs to name an individual migration item.


##### `external_agent_config_migration_item_detail`  (lines 94–135)

```
fn external_agent_config_migration_item_detail(
    item: &ExternalAgentConfigMigrationItem,
) -> Option<String>
```

**Purpose**: Creates an optional extra detail line for migration items that have countable contents, such as agents, hooks, commands, servers, or chat sessions. It keeps the UI informative without making every item verbose.

**Data flow**: It receives one migration item and first checks whether that item includes detailed information. If there are no details, it returns nothing. For item types with useful lists, it counts the entries and collects their names or titles, then asks `format_counted_details` to turn that into a compact sentence. For item types where extra detail is not useful, it returns nothing.

**Call relations**: This function is called by `build_customize_render_lines` while the customization screen is being drawn. It delegates the repeated wording pattern to `format_counted_details`, so the render code can simply receive either a ready-to-show detail string or no detail at all.

*Call graph*: calls 1 internal fn (format_counted_details); called by 1 (build_customize_render_lines).


##### `format_counted_details`  (lines 137–147)

```
fn format_counted_details(
    noun: &str,
    count: usize,
    names: impl Iterator<Item = &'a str>,
) -> String
```

**Purpose**: Formats a count and a few names into a short readable summary. It is the shared wording helper behind detail lines like “2 hooks: lint, test.”

**Data flow**: It receives a noun, a count, and an iterator of names. It chooses the singular or plural form based on the count, takes up to four names, and then builds the final text. If there are no names, it returns only the count and noun, such as “3 agents.” If names are present, it appends them after a colon.

**Call relations**: This helper is called by `external_agent_config_migration_item_detail` for each item type that needs a counted summary. It does the final text formatting so the higher-level function can focus on choosing which list of details to summarize.

*Call graph*: called by 1 (external_agent_config_migration_item_detail); 3 external calls (is_empty, take, format!).


### `tui/src/goal_display.rs`

`domain_logic` · `during TUI goal display and goal status updates`

This file is a small presentation layer for the TUI, the text-based user interface. Its job is to make goal information understandable at a glance. A “goal” here is an objective attached to a conversation thread, such as completing a task over time. Without this file, other parts of the interface would either show raw numbers like seconds and token counts, or each screen would have to invent its own wording.

The file provides a usage string for the `/goal` command, so the UI can tell users how to use it. It also converts elapsed seconds into compact human labels such as `59s`, `30m`, `1h 30m`, or `2d 23h 42m`. This is like changing a stopwatch reading into the kind of shorthand people expect on a dashboard.

It also maps internal goal states, such as paused or budget-limited, into plain labels. Finally, it builds a one-line summary that includes the goal objective, time used when present, and token use when a token budget exists. Tokens are pieces of text counted by the model; showing them helps users understand spending or limits.

The tests in this file protect the display wording, especially the compact time format and budget summary text.

#### Function details

##### `format_goal_elapsed_seconds`  (lines 7–31)

```
fn format_goal_elapsed_seconds(seconds: i64) -> String
```

**Purpose**: Turns a number of elapsed seconds into a short label that is easy to read in the terminal. It is used when the UI needs to show how long a goal has been running or how long it took.

**Data flow**: It receives a signed number of seconds. If the number is negative, it treats it as zero, then chooses the largest useful unit: seconds, minutes, hours, or days. It returns a string such as `0s`, `1m`, `2h`, or `1d 0h 0m`; it does not change any outside data.

**Call relations**: When goal information is shown elsewhere, `active_goal_usage` and `completed_goal_usage` call this function to turn raw time into a user-friendly label. This function does the time wording and hands the finished text back to those display builders.

*Call graph*: called by 2 (active_goal_usage, completed_goal_usage); 1 external calls (format!).


##### `goal_status_label`  (lines 33–42)

```
fn goal_status_label(status: ThreadGoalStatus) -> &'static str
```

**Purpose**: Converts a goal's internal status value into a short phrase a person can read. For example, it turns the program's `UsageLimited` state into `usage limited`.

**Data flow**: It receives a `ThreadGoalStatus`, which is the program's fixed set of possible goal states. It matches that state to a plain text label and returns that label. It does not read or modify anything else.

**Call relations**: This is a simple translation helper for any UI code that needs to show a goal's state. It sits between the protocol-level status value and the human-facing terminal text.


##### `goal_usage_summary`  (lines 44–60)

```
fn goal_usage_summary(goal: &ThreadGoal) -> String
```

**Purpose**: Builds a compact one-line summary of a goal, including its objective, elapsed time when available, and token usage when a budget exists. It gives the rest of the TUI a ready-made sentence instead of forcing each caller to assemble the pieces itself.

**Data flow**: It receives a `ThreadGoal`, which contains the goal objective, time used, token budget, and token count. It starts with the objective, adds formatted time if time is greater than zero, and adds formatted token use if there is a token budget. It returns one combined string and leaves the goal unchanged.

**Call relations**: `set_thread_goal_draft` and `set_thread_goal_status` call this function when the interface needs to show updated goal information. This function gathers the important fields, uses compact formatting for time and token counts, and gives those callers a finished summary to display.

*Call graph*: called by 2 (set_thread_goal_draft, set_thread_goal_status); 2 external calls (format!, vec!).


##### `tests::format_goal_elapsed_seconds_is_compact`  (lines 70–85)

```
fn format_goal_elapsed_seconds_is_compact()
```

**Purpose**: Checks that elapsed time is displayed in the compact forms users expect. It protects against accidental changes such as showing `60s` instead of `1m`.

**Data flow**: It feeds several example second counts into `format_goal_elapsed_seconds`, including seconds, minutes, hours, and days. For each example, it compares the returned text with the exact expected string. The test succeeds only if every formatted result matches.

**Call relations**: This test exercises `format_goal_elapsed_seconds` directly. It acts as a safety net for the display code used by goal usage screens.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::test_thread_goal`  (lines 87–99)

```
fn test_thread_goal(token_budget: Option<i64>, tokens_used: i64) -> ThreadGoal
```

**Purpose**: Creates a sample goal object for the tests in this file. It avoids repeating the same setup every time a test needs a realistic goal.

**Data flow**: It receives an optional token budget and a token-used count. It combines those values with fixed sample data, such as a thread id, objective, status, and time used, then returns a complete `ThreadGoal` for testing.

**Call relations**: The summary-formatting test calls this helper to build a goal with known values. The helper keeps the test focused on the output text rather than on constructing the whole test object by hand.


##### `tests::goal_usage_summary_formats_time_and_budgeted_tokens`  (lines 102–110)

```
fn goal_usage_summary_formats_time_and_budgeted_tokens()
```

**Purpose**: Checks that a goal summary includes the objective, formatted elapsed time, and compact token usage when a token budget is set. It makes sure the final sentence shown to users stays stable.

**Data flow**: It creates a sample goal with a token budget and a token count, sends that goal into `goal_usage_summary`, and compares the returned sentence with the expected text. The test does not change external state.

**Call relations**: This test uses `tests::test_thread_goal` to prepare the input and then verifies `goal_usage_summary`. It protects the path used when `set_thread_goal_draft` and `set_thread_goal_status` need a readable usage summary.

*Call graph*: 1 external calls (assert_eq!).


### `tui/src/skills_helpers.rs`

`util` · `request handling`

A “skill” here is a capability described by metadata: it has an internal name, and may also have nicer text meant for people. This file is the adapter between that raw metadata and the terminal user interface. Without it, the UI would either show awkward internal names, repeat formatting rules in several places, or search skills in a less helpful way.

The first job is choosing what name to show. If a skill provides a dedicated display name, that wins. If not, and the internal name looks like it came from a plugin, such as `plugin:skill`, the helper turns it into a clearer label like `skill (plugin)`. Otherwise it simply uses the stored name.

The second job is choosing a short description. It prefers the interface-specific short description, then the skill’s own short description, and finally falls back to the full description so the UI always has something to show.

The file also keeps skill names from taking too much horizontal space by truncating them to a shared limit. Finally, it supports filtering: when the user types a search string, it first tries to match against the display name, and only falls back to the internal skill name if that is different. Think of it like a shop directory: search the label on the shelf first, then the stockroom code only if needed.

#### Function details

##### `skill_display_name`  (lines 8–25)

```
fn skill_display_name(skill: &SkillMetadata) -> String
```

**Purpose**: Chooses the best human-readable name for a skill. It helps the terminal UI avoid showing raw internal identifiers when a clearer display name or plugin-aware label is available.

**Data flow**: It receives one skill’s metadata. It first looks for an explicit display name in the skill’s interface information. If that is missing, it checks whether the internal name is shaped like `plugin:skill` and rewrites it as `skill (plugin)`. If neither special case applies, it returns the original skill name as a new string.

**Call relations**: When the UI is building mention items or a skill candidate, it calls this function to get the label users will actually see. This function does the naming decision locally and only uses string formatting when it needs to turn a plugin-qualified name into a friendlier label.

*Call graph*: called by 2 (mention_items, skill_candidate); 1 external calls (format!).


##### `skill_description`  (lines 27–34)

```
fn skill_description(skill: &SkillMetadata) -> &str
```

**Purpose**: Picks the most suitable short explanation for a skill. It makes sure the UI can show a concise description when one exists, while still falling back to the full description if that is all the metadata provides.

**Data flow**: It receives one skill’s metadata and reads description fields in priority order: interface short description, then skill short description, then the full description. It returns a borrowed text slice pointing to whichever description was chosen, without making a new copy.

**Call relations**: The optional skill description display asks this function for the text to show. This keeps the fallback rules in one place, so callers do not need to know all the possible metadata fields.

*Call graph*: called by 1 (optional_skill_description).


##### `truncate_skill_name`  (lines 36–38)

```
fn truncate_skill_name(name: &str) -> String
```

**Purpose**: Shortens a skill name to the UI’s standard maximum length. This prevents long names from crowding or breaking terminal layouts.

**Data flow**: It receives a name as text and passes it, along with the fixed skill-name length limit, to the shared text truncation helper. It returns the shortened string, or an unchanged equivalent if the name already fits.

**Call relations**: This function is the skill-specific wrapper around the general text-shortening routine. Other UI code can call it when it needs a name that fits the expected skill-name column or label space.

*Call graph*: calls 1 internal fn (truncate_text).


##### `match_skill`  (lines 40–54)

```
fn match_skill(
    filter: &str,
    display_name: &str,
    skill_name: &str,
) -> Option<(Option<Vec<usize>>, i32)>
```

**Purpose**: Checks whether a user’s filter text matches a skill, and returns information useful for ranking and highlighting the match. It favors matching the visible display name, but can still find a skill by its internal name.

**Data flow**: It receives the filter typed by the user, the display name shown in the UI, and the internal skill name. It first runs fuzzy matching on the display name; fuzzy matching means the typed letters can match in order even if they are not next to each other. If that works, it returns the matched character positions and a score. If not, and the display name is different from the internal name, it tries the internal name and returns only the score, with no display-name highlight positions. If neither matches, it returns nothing.

**Call relations**: When filtering a list of skills, the filtering code calls this function for each candidate. This helper delegates the actual fuzzy matching to the shared fuzzy-match library, then shapes the result so the caller knows both how strong the match is and whether the visible name can be highlighted.

*Call graph*: called by 1 (apply_filter); 1 external calls (fuzzy_match).


### `tui/src/status/format.rs`

`util` · `status rendering`

The status screen shows many small facts, such as labels on the left and values on the right. This file is the measuring tape and spacing guide for that display. Without it, rows with different label lengths would look uneven, continuation lines would not line up, and text could be cut in the middle in a way that breaks terminal layout.

The main piece is FieldFormatter. It first looks at all labels that may appear, finds the widest one, and uses that width to decide where every value should begin. Think of it like setting a tab stop on a typewriter: once the stop is chosen, every row can line up neatly. It also creates dimmed label spans, meaning the label text is styled to look less prominent than the value.

The file also includes helpers for collecting unique labels, measuring the visible width of a rendered line, and trimming a line so it fits inside a given terminal width. The width logic uses Unicode-aware measurement, because some characters take more than one terminal column and some take none. That matters for names, symbols, and non-English text: the code counts what the user actually sees, not just how many bytes or characters are in the string.

#### Function details

##### `FieldFormatter::from_labels`  (lines 18–36)

```
fn from_labels(labels: impl IntoIterator<Item = S>) -> Self
```

**Purpose**: Builds a formatter that knows how much space to reserve for labels. Someone uses this before drawing rows so all values start in the same column.

**Data flow**: It receives a collection of label strings. It measures each label by its visible terminal width, finds the widest one, combines that with the fixed indent and spacing, and returns a FieldFormatter containing the calculated offsets and indentation string.

**Call relations**: The status display setup calls this from display_lines after it has gathered the labels it may need to show. The returned formatter is then used by later row-building code to make the status text line up consistently.

*Call graph*: called by 1 (display_lines); 2 external calls (into_iter, width).


##### `FieldFormatter::line`  (lines 38–44)

```
fn line(
        &self,
        label: &'static str,
        value_spans: Vec<Span<'static>>,
    ) -> Line<'static>
```

**Purpose**: Creates one complete status line from a label and already-prepared value text. It is used when a row can be shown as a single line.

**Data flow**: It takes a label and a list of styled value spans. It asks full_spans to add the correctly padded label span in front, then turns the combined spans into a terminal Line that can be drawn.

**Call relations**: rate_limit_lines calls this when building rate-limit status output. Internally it relies on full_spans, which does the actual joining of label and value pieces.

*Call graph*: calls 1 internal fn (full_spans); called by 1 (rate_limit_lines); 1 external calls (from).


##### `FieldFormatter::continuation`  (lines 46–51)

```
fn continuation(&self, mut spans: Vec<Span<'static>>) -> Line<'static>
```

**Purpose**: Creates an extra line for a value that continues below the first row. The continuation starts under the value column instead of under the label.

**Data flow**: It receives styled spans for the continued text. It creates a dimmed leading blank span using the formatter's saved value indentation, appends the continued text after it, and returns a Line ready for display.

**Call relations**: This helper is available for multi-line status output. It fits into the same alignment scheme as normal rows by reusing the formatter's calculated value indentation.

*Call graph*: 3 external calls (from, from, with_capacity).


##### `FieldFormatter::value_width`  (lines 53–55)

```
fn value_width(&self, available_inner_width: usize) -> usize
```

**Purpose**: Calculates how much horizontal room is left for the value part of a row. This helps callers decide when text must be wrapped or shortened.

**Data flow**: It receives the available inner width of the status area. It subtracts the formatter's value starting offset, using safe subtraction so the answer becomes zero instead of underflowing if the screen is too narrow.

**Call relations**: rate_limit_row_lines calls this while laying out rate-limit rows. The result tells that code how much space the value text has after the label and spacing are accounted for.

*Call graph*: called by 1 (rate_limit_row_lines).


##### `FieldFormatter::full_spans`  (lines 57–66)

```
fn full_spans(
        &self,
        label: &str,
        mut value_spans: Vec<Span<'static>>,
    ) -> Vec<Span<'static>>
```

**Purpose**: Combines a formatted label with the styled value spans for a row. It is the shared helper behind both simple line creation and more custom row layout.

**Data flow**: It receives a label and value spans. It creates the label span with label_span, places it first, appends the value spans after it, and returns the full list of spans.

**Call relations**: FieldFormatter::line calls this for ordinary rows, and rate_limit_row_lines calls it when it needs the span list directly. It hands label creation off to label_span so spacing stays consistent in one place.

*Call graph*: calls 1 internal fn (label_span); called by 2 (rate_limit_row_lines, line); 1 external calls (with_capacity).


##### `FieldFormatter::label_span`  (lines 68–82)

```
fn label_span(&self, label: &str) -> Span<'static>
```

**Purpose**: Builds the left-hand label text with the right amount of padding after it. This is what makes labels such as “id:” and “requests:” still leave values aligned.

**Data flow**: It receives a label string. It starts with the formatter's indent, adds the label and a colon, measures the label's visible width, adds enough spaces to match the widest known label plus fixed spacing, and returns the whole label area as a dimmed styled span.

**Call relations**: full_spans calls this whenever it needs the label part of a status row. The rest of the file depends on this function for the exact spacing convention used in the status display.

*Call graph*: called by 1 (full_spans); 3 external calls (from, with_capacity, width).


##### `push_label`  (lines 85–93)

```
fn push_label(labels: &mut Vec<String>, seen: &mut BTreeSet<String>, label: &str)
```

**Purpose**: Adds a label to a list only if it has not already been added. This lets the formatter calculate widths from a clean set of labels without duplicates.

**Data flow**: It receives a mutable label list, a mutable set of labels already seen, and a label string. If the label is already in the set, it changes nothing. Otherwise it copies the label, records it in the set, and appends it to the label list.

**Call relations**: collect_rate_limit_labels and display_lines call this while gathering labels for the status output. Its job is to keep that gathering step tidy before FieldFormatter::from_labels measures the final label collection.

*Call graph*: called by 2 (collect_rate_limit_labels, display_lines); 2 external calls (contains, insert).


##### `line_display_width`  (lines 95–99)

```
fn line_display_width(line: &Line<'static>) -> usize
```

**Purpose**: Measures how wide a rendered line will appear in the terminal. This is different from counting characters because some Unicode characters take extra space or no space.

**Data flow**: It receives a Line made of styled spans. It walks through each span, measures the visible width of that span's text, adds the widths together, and returns the total display width.

**Call relations**: rate_limit_row_lines calls this while deciding how a row fits in the available space. It supplies the practical, on-screen width needed before wrapping or truncating text.

*Call graph*: called by 1 (rate_limit_row_lines); 1 external calls (iter).


##### `truncate_line_to_width`  (lines 101–147)

```
fn truncate_line_to_width(line: Line<'static>, max_width: usize) -> Line<'static>
```

**Purpose**: Cuts a styled terminal line down so it fits within a maximum visible width. It preserves styling on the kept text and avoids splitting based on raw byte length.

**Data flow**: It receives a Line and a maximum width. If the width is zero, it returns an empty line. Otherwise it walks through the line's spans in order, keeping whole spans that fit. When a span would be too wide, it copies only the characters that still fit by measuring each character's terminal width, keeps the original style for that shortened text, and returns the trimmed line.

**Call relations**: This is a general safety helper for terminal rendering. Other layout code can use it after building a styled line to ensure the final output does not overflow the available terminal area.

*Call graph*: 7 external calls (from, styled, new, width, width, new, new).


### `tui/src/status/helpers.rs`

`util` · `status display rendering`

The status area in a terminal user interface has very little room, so raw data cannot be shown exactly as it appears inside the program. This file acts like a label maker for that status area. It chooses friendly names, shortens large numbers, trims long paths, and formats times so a person can quickly understand them.

For example, a model may have extra settings such as reasoning effort or summary behavior. This file turns those into compact phrases like “reasoning high” or “summaries off.” Account plan names are also adjusted so internal plan types become customer-facing labels such as “Business” or “Enterprise.” Token counts are shortened from large raw numbers into forms like “1.2M,” which are much easier to scan.

Path formatting is an important part of the file. Agent instruction files may live in the current project, a parent folder, or somewhere else entirely. The helper tries to show the shortest useful version, such as just the file name when it is in the current directory, or a relative-looking path when possible. Directory display also replaces the user’s home folder with “~” and can truncate long paths to fit a given screen width.

The tests at the bottom check that plan names and agent path summaries stay readable and predictable.

#### Function details

##### `normalize_agents_display_path`  (lines 12–14)

```
fn normalize_agents_display_path(path: &Path) -> String
```

**Purpose**: This helper turns a path into a cleaner display string for the status view. It removes unnecessary path clutter, such as redundant `.` or `..` parts, before showing the path to the user.

**Data flow**: It receives a filesystem path. It asks a path-cleaning library to simplify that path, then converts the simplified path into text. The result is a string ready to place in the status summary.

**Call relations**: It is used by `compose_agents_summary` when an agent file cannot be shown as a simple file name or nearby relative path. In that case, this helper provides the fallback readable path.

*Call graph*: called by 1 (compose_agents_summary); 1 external calls (simplified).


##### `compose_model_display`  (lines 16–34)

```
fn compose_model_display(
    model_name: &str,
    entries: &[(&str, String)],
) -> (String, Vec<String>)
```

**Purpose**: This function prepares the model name and its most important model settings for display. It keeps the main model name separate from short detail labels, so the status view can show them cleanly.

**Data flow**: It receives a model name and a list of setting name/value pairs. It looks for settings called `reasoning effort` and `reasoning summaries`, rewrites them into short human-readable phrases, and returns the original model name plus a list of detail strings.

**Call relations**: It is called by a `new` function elsewhere when building the status display. It does not draw anything itself; it supplies the text pieces that the larger status component can arrange on screen.

*Call graph*: called by 1 (new); 2 external calls (new, format!).


##### `compose_agents_summary`  (lines 36–80)

```
fn compose_agents_summary(config: &Config, paths: &[AbsolutePathBuf]) -> String
```

**Purpose**: This function builds the short text that says which agent instruction files are active. It tries to make each file path understandable without wasting screen space.

**Data flow**: It receives the current configuration, including the current working directory, and a list of absolute paths to agent files. For each path, it decides whether to show only the file name, a path that walks up from the current folder, a path relative to the current folder, or a cleaned full path. It joins all displayed paths with commas, or returns `<none>` if there are no paths.

**Call relations**: It calls `normalize_agents_display_path` when it needs a cleaned path string. In the provided call graph it is exercised by `tests::compose_agents_summary_orders_global_before_project_agents`, which checks that the produced summary preserves the expected order.

*Call graph*: calls 1 internal fn (normalize_agents_display_path); called by 1 (compose_agents_summary_orders_global_before_project_agents); 2 external calls (new, format!).


##### `compose_account_display`  (lines 82–86)

```
fn compose_account_display(
    account_display: Option<&StatusAccountDisplay>,
) -> Option<StatusAccountDisplay>
```

**Purpose**: This function passes through account display information in a safe, owned form. It is used when the status view needs its own copy of optional account details.

**Data flow**: It receives either no account display value or a borrowed account display value. If a value is present, it clones it into a new owned value; if not, it returns nothing.

**Call relations**: It is called by a `new` function elsewhere while building the status display. Its job is small but useful: it lets the constructed status object keep account display information without borrowing it from the caller.

*Call graph*: called by 1 (new).


##### `plan_type_display_name`  (lines 88–98)

```
fn plan_type_display_name(plan_type: PlanType) -> String
```

**Purpose**: This function converts an internal account plan type into the label users should see. It hides internal naming differences and maps related plan variants to friendly names.

**Data flow**: It receives a `PlanType`, which is the program’s internal account-plan category. It checks whether the plan is team-like, business-like, or the special `ProLite` case, and returns labels such as `Business`, `Enterprise`, or `Pro Lite`. For other plans, it turns the internal enum name into simple title case.

**Call relations**: It uses `title_case` as a fallback for plan names that do not need special remapping. The test `tests::plan_type_display_name_remaps_display_labels` checks the expected labels for many plan types.

*Call graph*: calls 1 internal fn (title_case); 3 external calls (is_business_like, is_team_like, format!).


##### `format_tokens_compact`  (lines 100–139)

```
fn format_tokens_compact(value: i64) -> String
```

**Purpose**: This function makes large token counts short enough for a status line. A token is a chunk of text processed by the model, and raw counts can get too large to read quickly.

**Data flow**: It receives a number of tokens. Negative numbers are treated as zero. Small numbers are returned as-is, while thousands, millions, billions, and trillions are scaled to `K`, `M`, `B`, or `T`. It keeps a sensible number of decimal places and removes unnecessary trailing zeroes.

**Call relations**: It is called by `context_window_spans` and `token_usage_spans`, which need compact token labels for display. This function supplies the short number text, while those callers decide where it appears in the interface.

*Call graph*: called by 2 (context_window_spans, token_usage_spans); 1 external calls (format!).


##### `format_directory_display`  (lines 141–162)

```
fn format_directory_display(directory: &Path, max_width: Option<usize>) -> String
```

**Purpose**: This function turns a directory path into a friendly, screen-sized label. It prefers `~` for the user’s home folder and can shorten long paths so they fit in the terminal.

**Data flow**: It receives a directory path and optionally a maximum display width. First it tries to rewrite the path relative to the home directory, using `~` when possible. Then, if a width limit is provided, it measures the visible width of the text and truncates the middle of the path if it is too long. It returns the final display string.

**Call relations**: It calls `relativize_to_home` to make home-based paths friendlier and `center_truncate_path` to shorten paths without losing both ends. It is called by `display_lines`, which uses the resulting text as part of the visible status output.

*Call graph*: calls 2 internal fn (relativize_to_home, center_truncate_path); called by 1 (display_lines); 4 external calls (display, new, width, format!).


##### `format_reset_timestamp`  (lines 164–171)

```
fn format_reset_timestamp(dt: DateTime<Local>, captured_at: DateTime<Local>) -> String
```

**Purpose**: This function formats a reset time in a compact way. It shows just the time if the reset is today, but includes the date if it falls on another day.

**Data flow**: It receives the reset date/time and the time when the status information was captured. It formats the reset time as hours and minutes, compares the two calendar dates, and either returns just the time or returns the time plus a short date like `on 5 Jan`.

**Call relations**: The provided call graph does not show a caller, but this helper is designed for status text that needs to say when a quota or usage counter resets. It relies on date comparison and date formatting rather than doing any broader status work itself.

*Call graph*: 3 external calls (date_naive, format, format!).


##### `title_case`  (lines 173–183)

```
fn title_case(s: &str) -> String
```

**Purpose**: This helper makes a simple title-style word from an internal name. It is used when a plan type does not need a special display label.

**Data flow**: It receives a string. If it is empty, it returns an empty string. Otherwise it uppercases the first character, lowercases the rest using ASCII rules, and joins them into a new string.

**Call relations**: It is called by `plan_type_display_name` as the fallback path for ordinary plan names. That keeps the public plan-label function focused on business rules while this helper does the small text transformation.

*Call graph*: called by 1 (plan_type_display_name); 1 external calls (new).


##### `tests::test_config`  (lines 193–200)

```
async fn test_config(codex_home: &TempDir, cwd: &TempDir) -> Config
```

**Purpose**: This test helper builds a temporary configuration for tests that need a fake Codex home directory and a fake current working directory. It prevents each test from repeating the same setup code.

**Data flow**: It receives two temporary directories: one to act as the Codex home and one to act as the current working directory. It feeds those paths into a configuration builder, waits for the configuration to be built, and returns the resulting `Config`.

**Call relations**: It is called by the async agent-summary tests. Those tests need a realistic `Config` so `compose_agents_summary` can compare agent file paths against the current working directory.

*Call graph*: 2 external calls (path, default).


##### `tests::plan_type_display_name_remaps_display_labels`  (lines 203–222)

```
fn plan_type_display_name_remaps_display_labels()
```

**Purpose**: This test checks that internal account plan types are shown with the intended user-facing names. It protects against accidentally exposing confusing internal labels in the status view.

**Data flow**: It creates a list of plan types paired with the display text each one should produce. For each pair, it calls `plan_type_display_name` and compares the result with the expected label.

**Call relations**: This test directly exercises `plan_type_display_name`. If the mapping rules change by mistake, the assertions fail and point developers back to the display-label behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::compose_agents_summary_includes_global_agents_path`  (lines 225–235)

```
async fn compose_agents_summary_includes_global_agents_path()
```

**Purpose**: This test checks that a global agent file outside the current project still appears in the agent summary. It makes sure such paths are not dropped or mistaken for project-local files.

**Data flow**: It creates temporary Codex home and current working directories, builds a test configuration, and creates a path for a global agent file. It calls `compose_agents_summary` with that path and compares the result to the normal directory-display formatting for the same path.

**Call relations**: It uses `tests::test_config` for setup and then verifies the path-summary behavior. Although the call graph excerpt lists only external calls for this test, its purpose is to protect `compose_agents_summary` behavior for global agent paths.

*Call graph*: 3 external calls (new, assert_eq!, test_config).


##### `tests::compose_agents_summary_names_global_agents_override`  (lines 238–248)

```
async fn compose_agents_summary_names_global_agents_override()
```

**Purpose**: This test checks that a global override agent file is named correctly in the summary. It covers another global-file case so display behavior remains consistent.

**Data flow**: It creates temporary directories, builds a test configuration, and makes a path named `override.md` under the fake Codex home. It calls the agent-summary formatting path and asserts that the displayed result matches the expected formatted path.

**Call relations**: It depends on `tests::test_config` to create a realistic configuration. Like the neighboring global-agent test, it protects the path formatting expectations around `compose_agents_summary`.

*Call graph*: 3 external calls (new, assert_eq!, test_config).


##### `tests::compose_agents_summary_orders_global_before_project_agents`  (lines 251–273)

```
async fn compose_agents_summary_orders_global_before_project_agents()
```

**Purpose**: This test checks that the agent summary keeps paths in the order it was given, especially with a global file before a project file. That matters because order can imply priority or simply match the user’s expectations.

**Data flow**: It creates a fake global agent path and a fake project agent path, then builds a test configuration. It passes both paths to `compose_agents_summary`, splits the comma-separated result, and checks that the global path appears first, the project path appears second, and there are no extra entries.

**Call relations**: This test calls `compose_agents_summary` directly and uses `tests::test_config` for setup. It verifies the larger path-summary function rather than any one small formatting helper.

*Call graph*: calls 1 internal fn (compose_agents_summary); 4 external calls (new, assert!, assert_eq!, test_config).


### `tui/src/status/remote_connection.rs`

`domain_logic` · `startup and status display`

The text user interface can run against different kinds of app servers: one built into the same process, a local background service, or a remote server. This file answers a simple user-facing question: “Am I connected to something outside this UI, and if so, where and what version is it?”

If the app is using the embedded server, there is no remote connection to show, so it returns nothing. If the app is connected through a WebSocket, it prepares the WebSocket address for display. Importantly, it removes sensitive or noisy parts first: usernames, passwords, query strings, and URL fragments. That means a URL containing a token is shown like a street address, not like a key left under the doormat. If the app is connected through a Unix socket, it formats the socket path with a `unix://` prefix so the display clearly says what kind of connection it is.

The file also formats the server version. A known version becomes something like `v1.2.3`; a missing version becomes `unknown`. The small test at the bottom checks the main cases: embedded servers show nothing, WebSocket secrets are hidden, and Unix socket paths are displayed correctly.

#### Function details

##### `remote_connection_status_value`  (lines 11–34)

```
fn remote_connection_status_value(
    app_server_target: &AppServerTarget,
    server_version: Option<&str>,
) -> Option<RemoteConnectionStatus>
```

**Purpose**: Builds the connection status that the UI can show to the user. It decides whether there is a remote connection at all, chooses a safe display address, and adds the server version if known.

**Data flow**: It receives the chosen app server target and an optional server version string. If the target is embedded, it returns no status. If the target points to a WebSocket, it asks `sanitized_websocket_display_address` to clean the URL before showing it. If the target points to a Unix socket, it turns the socket path into a `unix://...` display string. It then changes a version like `1.2.3` into `v1.2.3`, or uses `unknown` when no version was provided, and returns a `RemoteConnectionStatus` containing both pieces of text.

**Call relations**: The larger run flow calls this when it needs a user-facing status value. Inside, it delegates WebSocket cleanup to `sanitized_websocket_display_address` so that secret-bearing URL details are removed before anything is displayed.

*Call graph*: calls 1 internal fn (sanitized_websocket_display_address); called by 1 (run); 1 external calls (format!).


##### `sanitized_websocket_display_address`  (lines 36–43)

```
fn sanitized_websocket_display_address(raw: &str) -> Option<String>
```

**Purpose**: Turns a raw WebSocket URL into a safer display version. It strips out private or distracting parts such as login details, query parameters, and fragments.

**Data flow**: It receives a raw URL string. It tries to parse it as a URL; if parsing fails, it returns nothing. If parsing succeeds, it clears the username, password, query string, and fragment, then returns the cleaned URL as text.

**Call relations**: `remote_connection_status_value` calls this only for WebSocket endpoints. Its result becomes the address shown in the remote connection status; if it cannot parse the URL, the caller falls back to the text `<invalid websocket URL>`.

*Call graph*: called by 1 (remote_connection_status_value); 1 external calls (parse).


##### `tests::remote_connection_status_value_formats_display_value`  (lines 51–85)

```
fn remote_connection_status_value_formats_display_value() -> color_eyre::Result<()>
```

**Purpose**: Checks that the status formatting behaves correctly for the main connection types. It is a safety net so future changes do not accidentally reveal secrets or change the display format.

**Data flow**: It creates three example situations: an embedded server, a remote WebSocket URL containing credentials and token-like details, and a local Unix socket path. It passes each one into `remote_connection_status_value` and compares the returned value with the expected result. Nothing is changed outside the test; it succeeds only if the formatted output matches exactly.

**Call relations**: This test exercises `remote_connection_status_value` the way the running UI would use it. It also indirectly checks `sanitized_websocket_display_address`, because the WebSocket case must come back with the sensitive parts removed.

*Call graph*: calls 1 internal fn (relative_to_current_dir); 1 external calls (assert_eq!).


### Specialized visual components
These files provide focused presentation helpers for chart palettes and reusable history-cell composition used elsewhere in the TUI.

### `tui/src/chatwidget/tokens/chart/palette.rs`

`domain_logic` · `chart rendering`

Token activity charts need to show “nothing happened” versus “some activity happened,” and ideally also show different activity levels. This file is the chart’s paint box. It decides which text styles and small block characters should be used for each cell in the chart.

The main type, `TokenActivityPalette`, stores five styles for activity levels, a separate style for bar charts, and a flag saying whether color can carry the meaning by itself. On terminals with good color support, the chart uses one solid square glyph and changes its color intensity, much like a GitHub contribution graph. On low-color terminals, color is not reliable enough, so the chart switches to different shapes: a hollow square for empty daily cells and a filled square for active ones. For bar views, it uses spaces for empty parts and full block characters for filled parts, so the chart looks like columns.

The file also connects the chart to the current theme. It tries to find a suitable accent color from syntax-highlight-like theme scopes, blends that color against the terminal background, and then converts it to the best color the terminal can actually display. If anything important is missing, such as terminal background color or a usable RGB theme color, it falls back to a simpler but dependable accent style.

#### Function details

##### `TokenActivityPalette::current`  (lines 40–47)

```
fn current() -> Self
```

**Purpose**: Builds the palette that should be used right now for the user’s current terminal and theme. Chart drawing code calls this when it needs styles and glyph choices for token activity cells.

**Data flow**: It reads the terminal’s default foreground color, default background color, detected color capability, and the theme’s activity accent style. It passes those pieces into the palette builder. The result is a `TokenActivityPalette` ready to use for drawing the chart.

**Call relations**: This is the normal entry point for chart rendering: `chart_lines` asks for the current palette before drawing. It gathers information from `default_fg`, `default_bg`, `stdout_color_level`, and `theme_activity_style`, then hands everything to `TokenActivityPalette::from_parts` to make the final decision.

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

**Purpose**: Creates a palette from explicit terminal and theme information. This is the decision-making function that chooses between a rich color-gradient palette and a simpler fallback palette.

**Data flow**: It receives optional terminal foreground and background RGB colors, the terminal’s color level, and the theme’s active style. First it checks whether all needed color information is available and whether the terminal can show enough colors. If not, it returns the fallback palette. If yes, it blends the theme accent color with the terminal background at several strengths, converts each blended color to the best displayable terminal color, and stores those styles in the palette. It also prepares a bar-chart style and marks that the palette can rely on color.

**Call relations**: This function is called by `TokenActivityPalette::current` in real use, and by several tests that check different terminal and theme situations. It relies on `activity_anchor_rgb` to get a real RGB accent color, on color blending helpers to create intensity levels, and on `best_color_for_level` to fit those colors to the terminal.

*Call graph*: calls 4 internal fn (activity_anchor_rgb, blend, is_light, best_color_for_level); called by 5 (ansi16_palette_uses_theme_accent_without_green_fallback, missing_terminal_colors_use_theme_accent_fallback, non_rgb_theme_accent_remains_active_fallback, truecolor_palette_blends_empty_cell_for_light_background, truecolor_palette_blends_theme_accent_against_dark_background); 3 external calls (default, matches!, from_fn).


##### `TokenActivityPalette::fallback`  (lines 93–106)

```
fn fallback(active_style: Style) -> Self
```

**Purpose**: Builds a safe palette for terminals or themes where a color gradient cannot be trusted. It makes empty cells dim and active cells use the theme accent style.

**Data flow**: It receives the active theme style. It creates a dim default style for empty cells, uses the active style for all non-empty levels and bars, and records that the palette should not rely on color alone. The output is a simple `TokenActivityPalette` that remains readable in limited terminals.

**Call relations**: This is the backup path used by `TokenActivityPalette::from_parts` when terminal colors are missing, the theme accent is not an RGB color, or the terminal only supports very limited colors. It keeps the chart usable instead of producing misleading or invisible color differences.

*Call graph*: 1 external calls (default).


##### `TokenActivityPalette::for_level`  (lines 108–110)

```
fn for_level(&self, level: usize) -> Style
```

**Purpose**: Returns the text style for a chart cell at a given activity level. It lets the renderer ask, “How should level 0, 1, 2, 3, or 4 look?”

**Data flow**: It receives a numeric level. If the number is higher than the palette’s maximum level, it clamps it down to the highest supported level. It then returns the stored style for that level without changing the palette.

**Call relations**: Chart helper code such as `legend_line` uses this to style level examples. `TokenActivityPalette::for_bar_level` also calls it for level 0, so empty bar cells match the normal empty-cell style.

*Call graph*: called by 2 (legend_line, for_bar_level).


##### `TokenActivityPalette::for_bar_level`  (lines 112–118)

```
fn for_bar_level(&self, level: usize) -> Style
```

**Purpose**: Returns the style for a cell in a bar-style chart. Empty bar cells use the normal empty style, while any filled part of the bar uses the dedicated bar style.

**Data flow**: It receives a bar level. If the level is zero, it asks `TokenActivityPalette::for_level` for the empty-cell style. If the level is above zero, it returns the palette’s stored bar style. The palette itself is not changed.

**Call relations**: This function fits into the bar-chart drawing path. It reuses `for_level` for empty space so the chart stays visually consistent, and uses the separate bar style for filled columns so bars have a clear silhouette.

*Call graph*: calls 1 internal fn (for_level).


##### `TokenActivityPalette::glyph`  (lines 125–134)

```
fn glyph(&self, view: TokenActivityView, level: usize) -> &'static str
```

**Purpose**: Chooses the actual character to draw for a chart cell. It decides whether a cell should be a square, a hollow square, a full block, or a space.

**Data flow**: It receives the chart view type and the activity level for one cell. For non-daily views, it returns a space for level 0 and a full block for active levels, creating a bar-chart look. For daily views, it returns a filled square when color can show the difference or when the cell is active; otherwise it returns a hollow square for empty cells. The output is a static string slice containing the glyph to print.

**Call relations**: `legend_line` calls this when it needs example glyphs for the chart legend. The function uses the palette’s `uses_color` setting, which was chosen earlier by `from_parts` or `fallback`, so glyph choice stays in sync with terminal color capability.

*Call graph*: called by 1 (legend_line).


##### `theme_activity_style`  (lines 137–141)

```
fn theme_activity_style() -> Style
```

**Purpose**: Finds the theme style that should represent token activity. It tries theme scopes that are likely to have a pleasant accent color, then falls back to the app’s normal accent style.

**Data flow**: It asks the highlighting system for a foreground style matching several named scopes, such as type names or variables. If that lookup succeeds, it uses that style; otherwise it uses `accent_style`. It then makes the style bold and returns it.

**Call relations**: `TokenActivityPalette::current` calls this while building the live palette. This function is the bridge between the general app theme and the token activity chart’s color choices.

*Call graph*: calls 1 internal fn (foreground_style_for_scopes); called by 1 (current).


##### `activity_anchor_rgb`  (lines 143–148)

```
fn activity_anchor_rgb(style: Style) -> Option<(u8, u8, u8)>
```

**Purpose**: Extracts a plain RGB color from a style, if the style has one. The palette needs this raw red-green-blue value so it can blend the accent color with the terminal background.

**Data flow**: It receives a `Style`. It looks at the style’s foreground color. If that foreground is an RGB color, it returns the three color components. If there is no foreground color, or if the foreground uses another kind of terminal color, it returns nothing.

**Call relations**: `TokenActivityPalette::from_parts` calls this before trying to build a color-gradient palette. If this function cannot provide an RGB anchor color, `from_parts` chooses the fallback palette instead.

*Call graph*: called by 1 (from_parts).


### `tui/src/history_cell/base.rs`

`domain_logic` · `main loop / transcript rendering`

The terminal user interface keeps a running history, like a chat transcript or activity log. Each entry in that history must be able to answer a few questions: what lines should be shown on screen, what plain text should be copied or saved, and where any clickable links are. This file provides the basic kinds of history entries used by other parts of the transcript system.

A PlainHistoryCell is the simplest case: it stores already-prepared lines and gives them back. A WebHyperlinkHistoryCell is similar, but it can also scan its text for web addresses and return lines with link information attached, so terminals that support hyperlinks can make URLs clickable. A PrefixedWrappedHistoryCell is for text that needs a label or marker at the start, then a different prefix on wrapped follow-up lines, like a bullet point whose later lines line up neatly. It wraps based on the available terminal width.

CompositeHistoryCell is the “folder” version. It contains several other history cells and presents them as one entry, putting a blank line between non-empty parts. This lets larger transcript items be assembled from small pieces without each caller reimplementing spacing, wrapping, raw text, and hyperlink behavior.

#### Function details

##### `PlainHistoryCell::new`  (lines 11–13)

```
fn new(lines: Vec<Line<'static>>) -> Self
```

**Purpose**: Creates a plain history cell from a list of already-built display lines. Other code uses this when it has text that does not need special wrapping or hyperlink detection.

**Data flow**: It receives a vector of terminal lines. It stores those lines inside a new PlainHistoryCell and returns that cell; nothing else is changed.

**Call relations**: Many transcript-building helpers call this when they need a simple entry, such as permission decisions, renamed confirmations, fork events, and tests. Later, the history system asks the cell for display or raw lines.

*Call graph*: called by 16 (plain_line_cell, handle_permissions_decision, add_plain_history_lines, rename_confirmation_cell, emit_forked_thread_event, completed_token_activity_refresh_waits_for_active_history_cell, pending_token_activity_refresh_keeps_composer_visible_in_short_viewport, startup_reset_hint_waits_for_active_output_snapshot, new_token_activity_output, new_debug_config_output (+6 more)).


##### `PlainHistoryCell::display_lines`  (lines 17–19)

```
fn display_lines(&self, _width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns the plain cell's lines for on-screen display. The terminal width is accepted for consistency with other cell types, but this cell does not need it because its lines are already prepared.

**Data flow**: It reads the stored lines, clones them, and returns the clone. The original cell stays unchanged.

**Call relations**: When display code such as cell_to_text needs to turn a history cell into visible text, it calls this method. This method does not hand off to other helpers because plain cells need no extra formatting.

*Call graph*: called by 1 (cell_to_text).


##### `PlainHistoryCell::raw_lines`  (lines 21–23)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns a plain-text version of the cell's stored lines. This is useful for transcript export, copying, or any place where styling should not matter.

**Data flow**: It clones the stored lines, passes them through plain_lines to strip or normalize styling, and returns the resulting plain lines. The stored display version is not changed.

**Call relations**: This is part of the shared HistoryCell behavior. It is used when the wider transcript system wants content rather than terminal decoration.


##### `WebHyperlinkHistoryCell::new`  (lines 32–34)

```
fn new(lines: Vec<Line<'static>>) -> Self
```

**Purpose**: Creates a history cell whose text may contain web links. Callers use it when a displayed message should still look like normal text but URLs should be discoverable as hyperlinks.

**Data flow**: It receives prepared terminal lines, stores them in a WebHyperlinkHistoryCell, and returns the new cell. It does not scan links yet; that happens only when hyperlink lines are requested.

**Call relations**: It is called by feedback_success_cell, which creates a success message that may include a web URL. Later display and transcript methods decide whether to return plain lines or hyperlink-aware lines.

*Call graph*: called by 1 (feedback_success_cell).


##### `WebHyperlinkHistoryCell::display_lines`  (lines 38–40)

```
fn display_lines(&self, _width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns the stored lines for normal screen display, without adding hyperlink metadata. This keeps ordinary rendering simple and unchanged.

**Data flow**: It reads the stored lines, clones them, and returns the clone. The width parameter is ignored because this cell does not wrap its text here.

**Call relations**: This method satisfies the normal display part of the HistoryCell behavior. Hyperlink-specific rendering uses a different method in the same cell.


##### `WebHyperlinkHistoryCell::display_hyperlink_lines`  (lines 42–44)

```
fn display_hyperlink_lines(&self, _width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Returns the cell's display lines with web URLs marked as hyperlinks. In plain terms, it takes visible text and adds hidden link targets where URLs appear.

**Data flow**: It clones the stored lines, sends them to annotate_web_urls, and returns the resulting hyperlink-aware lines. The cell itself is not modified.

**Call relations**: When a renderer wants clickable links, it calls this method. It delegates the actual URL finding to annotate_web_urls, keeping this cell focused on history-cell behavior rather than URL parsing.

*Call graph*: calls 1 internal fn (annotate_web_urls); called by 1 (transcript_hyperlink_lines).


##### `WebHyperlinkHistoryCell::transcript_hyperlink_lines`  (lines 46–48)

```
fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Returns hyperlink-aware lines for transcript use. For this cell, transcript hyperlinks are the same as display hyperlinks.

**Data flow**: It receives the requested width, passes that along to display_hyperlink_lines, and returns whatever that method produces.

**Call relations**: This method is the transcript-facing path. It simply reuses display_hyperlink_lines so display and transcript output stay consistent for web links.

*Call graph*: calls 1 internal fn (display_hyperlink_lines).


##### `WebHyperlinkHistoryCell::raw_lines`  (lines 50–52)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns the web-link cell as plain text lines, without hyperlink metadata or terminal styling. This is useful when saving or copying the transcript.

**Data flow**: It clones the stored lines, runs them through plain_lines, and returns the cleaned-up plain lines. The hyperlink-capable cell remains unchanged.

**Call relations**: This supports the raw-text side of the HistoryCell contract. It intentionally does not call the hyperlink annotation path because raw text should contain only readable text.


##### `PrefixedWrappedHistoryCell::new`  (lines 62–72)

```
fn new(
        text: impl Into<Text<'static>>,
        initial_prefix: impl Into<Line<'static>>,
        subsequent_prefix: impl Into<Line<'static>>,
    ) -> Self
```

**Purpose**: Creates a history cell for text that should be wrapped to the terminal width and shown with prefixes. This is useful for entries like warnings, approvals, or status messages where the first line has one label and wrapped continuation lines need another indent.

**Data flow**: It receives text, an initial prefix, and a subsequent-line prefix. It converts each input into the internal text and line types, stores them, and returns a new PrefixedWrappedHistoryCell.

**Call relations**: Approval, guardian, warning, and other event-building code call this when they need neatly wrapped transcript text. Later, display_lines uses the stored text and prefixes to format the entry for the current terminal width.

*Call graph*: called by 11 (new_approval_decision_cell, new_guardian_approved_action_request, new_guardian_denied_action_request, new_guardian_denied_patch_request, new_guardian_timed_out_action_request, new_guardian_timed_out_patch_request, new_warning_event, display_lines, prefixed_wrapped_history_cell_does_not_split_url_like_token, prefixed_wrapped_history_cell_height_matches_wrapped_rendering (+1 more)); 1 external calls (into).


##### `PrefixedWrappedHistoryCell::display_lines`  (lines 76–84)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Formats the cell for the current terminal width, wrapping long text and adding the right prefix to the first and later lines. This keeps messages readable instead of spilling awkwardly across the screen.

**Data flow**: It receives a width. If the width is zero, it returns no lines. Otherwise, it builds wrapping options using the width and cloned prefixes, passes the stored text into adaptive_wrap_lines, and returns the wrapped lines.

**Call relations**: The display system calls this whenever the terminal needs to show the cell. It relies on the wrapping helper to do the line breaking, while this method supplies the prefixes and width rules.

*Call graph*: calls 1 internal fn (new); 2 external calls (clone, new).


##### `PrefixedWrappedHistoryCell::raw_lines`  (lines 86–88)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns the cell's original text as plain lines, without the visual prefixes or wrapping used on screen. This gives exports or copies the content itself rather than the terminal layout.

**Data flow**: It clones the stored text lines, passes them through plain_lines, and returns the plain result. It does not use terminal width and does not change the cell.

**Call relations**: This method is used through the HistoryCell interface when the transcript system wants raw content. It deliberately avoids the display wrapping path because raw transcript text should not depend on screen width.

*Call graph*: 1 external calls (clone).


##### `CompositeHistoryCell::new`  (lines 96–98)

```
fn new(parts: Vec<Box<dyn HistoryCell>>) -> Self
```

**Purpose**: Creates a history cell made from several smaller history cells. This lets a complex transcript entry be built like a small stack of blocks.

**Data flow**: It receives a vector of boxed HistoryCell objects, stores them as parts, and returns a CompositeHistoryCell. The child cells keep their own display, raw text, and hyperlink behavior.

**Call relations**: Higher-level builders call this for combined outputs such as token activity, unified execution output, status output with rate limits, and hyperlink-preserving test cases. Later, the composite asks each child cell for its own lines.

*Call graph*: called by 4 (new_token_activity_output, new_unified_exec_processes_output, composite_cell_preserves_child_web_links, new_status_output_with_rate_limits_handle).


##### `CompositeHistoryCell::display_lines`  (lines 102–116)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Returns the normal display lines for all child cells as one combined entry. It inserts a blank line between non-empty parts so separate sections remain visually distinct.

**Data flow**: It receives a terminal width, asks each child for its display lines at that width, skips empty children, adds a blank separator before every non-first non-empty part, and returns the combined list.

**Call relations**: The terminal display path calls this when it needs to show a composite entry. This method does not format each section itself; it delegates to the child cells and only controls the joining and spacing.

*Call graph*: 2 external calls (from, new).


##### `CompositeHistoryCell::display_hyperlink_lines`  (lines 118–132)

```
fn display_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Returns hyperlink-aware display lines for all child cells as one combined entry. It preserves each child's own link behavior while adding blank lines between sections.

**Data flow**: It receives a width, asks each child for hyperlink display lines, skips empty results, inserts a blank hyperlink line between non-empty parts, and returns the combined hyperlink-aware list.

**Call relations**: When the renderer wants clickable display output for a composite entry, it calls this method. The composite acts like a coordinator: each child supplies its own hyperlink lines, and the composite stitches them together.

*Call graph*: calls 1 internal fn (from); 1 external calls (new).


##### `CompositeHistoryCell::transcript_hyperlink_lines`  (lines 134–148)

```
fn transcript_hyperlink_lines(&self, width: u16) -> Vec<HyperlinkLine>
```

**Purpose**: Returns hyperlink-aware lines for transcript output across all child cells. It keeps the same section spacing rule as normal display, but uses each child's transcript-specific hyperlink representation.

**Data flow**: It receives a width, asks each child for transcript hyperlink lines, skips empty children, adds blank separators between non-empty parts, and returns the combined result.

**Call relations**: Transcript export or transcript rendering code calls this when hyperlinks should be preserved. It hands responsibility for each section to the child cells, then combines their answers in order.

*Call graph*: calls 1 internal fn (from); 1 external calls (new).


##### `CompositeHistoryCell::raw_lines`  (lines 150–164)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns plain-text lines for all child cells as one combined entry. It keeps blank separators between non-empty sections so the raw transcript still reads clearly.

**Data flow**: It asks each child for raw lines, skips empty children, inserts a blank plain line between non-empty parts, and returns the full plain-text list. No child cell is changed.

**Call relations**: The raw transcript path calls this when a composite entry must be copied, saved, or compared without terminal styling. The composite relies on each child to produce its own raw text, then joins the pieces.

*Call graph*: 2 external calls (from, new).
