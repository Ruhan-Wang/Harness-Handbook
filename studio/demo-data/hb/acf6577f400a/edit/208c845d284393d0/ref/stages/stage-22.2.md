# Text, parsing, truncation, and rendering helpers  `stage-22.2`

This stage is shared support that helps the rest of the system turn raw text into something readable on screen or safe to store and pass around. It is not one step in startup or shutdown. It is a toolbox used all through the program, especially while the terminal interface is running.

One part cleans up and formats text. It shortens long strings, fills in simple templates, formats numbers and times, and makes display text consistent. Another part reads text that arrives in pieces, like a stream. It rebuilds full characters and lines, and it can notice hidden tags, mentions, tables, or citation markers mixed into the text.

Once the text is understood, the layout helpers make it fit the terminal. They measure visible width, wrap or trim lines, preserve colors and links, and support scrolling views. On top of that, the presentation helpers choose styles, colors, labels, menus, and small view models so different screens look consistent. Finally, the animation and progress helpers add spinners, shimmer effects, simple terminal media, and temporary progress lines when the terminal can handle them.

## Sub-stages

- [Generic string, formatting, truncation, and templating utilities](stage-22.2.1.md) `stage-22.2.1` — 12 files
- [Streaming, line framing, and hidden-markup parsers](stage-22.2.2.md) `stage-22.2.2` — 9 files
- [TUI text layout, wrapping, and text-rendering primitives](stage-22.2.3.md) `stage-22.2.3` — 10 files
- [TUI presentation models, styling, and lightweight view helpers](stage-22.2.4.md) `stage-22.2.4` — 21 files
- [TUI animation, motion, terminal media, and transient progress output](stage-22.2.5.md) `stage-22.2.5` — 5 files
