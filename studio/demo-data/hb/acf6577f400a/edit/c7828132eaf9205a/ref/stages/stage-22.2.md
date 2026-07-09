# Text, parsing, truncation, and rendering helpers  `stage-22.2`

This stage is shared support that helps the rest of the system turn raw text into something clean, readable, and safe to show. It is mostly behind the scenes, especially for the terminal interface, but many other parts use it too. You can think of it as the text workshop: it reads text in, tidies it up, measures it, reshapes it, and prepares it for display.

One part provides everyday string tools: formatting numbers and durations, filling in templates with placeholders, escaping JSON text, and shortening long text without cutting a character in half. Another part reads streaming text as it arrives in pieces, rebuilds full UTF-8 characters, splits lines correctly, removes hidden markup, and extracts special items like mentions, citations, or tables.

On top of that, the layout layer figures out how wide text will be in a terminal, wraps or truncates it, and keeps colors and links intact. The presentation layer then applies styles, labels, spacing, and reusable small view pieces. Finally, animation and progress helpers add spinners, shimmer effects, and temporary status lines so long-running work feels responsive.

## Sub-stages

- [Generic string, formatting, truncation, and templating utilities](stage-22.2.1.md) `stage-22.2.1` — 12 files
- [Streaming, line framing, and hidden-markup parsers](stage-22.2.2.md) `stage-22.2.2` — 9 files
- [TUI text layout, wrapping, and text-rendering primitives](stage-22.2.3.md) `stage-22.2.3` — 10 files
- [TUI presentation models, styling, and lightweight view helpers](stage-22.2.4.md) `stage-22.2.4` — 21 files
- [TUI animation, motion, terminal media, and transient progress output](stage-22.2.5.md) `stage-22.2.5` — 5 files
