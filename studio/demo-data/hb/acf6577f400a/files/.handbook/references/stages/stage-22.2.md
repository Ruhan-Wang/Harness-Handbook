# Text, parsing, truncation, and rendering helpers  `stage-22.2`

This stage is shared behind-the-scenes support for almost every place the project reads, prepares, or shows text. It is not one main feature. It is more like the workshop that cuts, labels, cleans, and paints text before other parts use it, especially in the command-line and terminal interface.

The generic text utilities shorten long output, format numbers and times, fill simple templates, protect private values, and make strings safe for terminals, metrics, or JSON. The streaming parsers handle text that arrives piece by piece, such as live model output or process logs. They join split characters, wait for complete lines, remove hidden markup, and keep useful metadata separate from visible words.

The layout and rendering helpers then make text fit on screen. They measure width, wrap lines, preserve colors and links, truncate safely, and support scrollable views such as diffs. Above that, the presentation helpers choose consistent styles, colors, rows, popups, footers, warnings, and status labels. Finally, the animation and progress helpers add small motion effects and temporary “working” messages without cluttering the final output.

## Sub-stages

- [Generic string, formatting, truncation, and templating utilities](stage-22.2.1.md) `stage-22.2.1` — 12 files
- [Streaming, line framing, and hidden-markup parsers](stage-22.2.2.md) `stage-22.2.2` — 9 files
- [TUI text layout, wrapping, and text-rendering primitives](stage-22.2.3.md) `stage-22.2.3` — 10 files
- [TUI presentation models, styling, and lightweight view helpers](stage-22.2.4.md) `stage-22.2.4` — 21 files
- [TUI animation, motion, terminal media, and transient progress output](stage-22.2.5.md) `stage-22.2.5` — 5 files
