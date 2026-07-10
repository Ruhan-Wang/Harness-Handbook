# Text, parsing, truncation, and rendering helpers  `stage-22.2`

This stage is shared support code for anything the system needs to do with text before showing it to a person. It mostly works behind the scenes, especially for command-line and terminal screens, but many other parts use it too. You can think of it as the workshop where raw data is cleaned up, shortened, parsed, and shaped into something readable.

One part provides general string tools: formatting numbers and times, hiding secrets, shortening long text safely, keeping history within size limits, producing plain JSON text, and filling simple templates with placeholders like {{ name }}. Another part reads streaming input a piece at a time. It safely decodes bytes into text, waits for full lines, detects special hidden tags or table blocks, and extracts structured mentions without mixing them into visible output.

Above that, the layout helpers turn styled text into terminal-width lines. They measure visible width correctly, wrap long content, preserve links and colors, and support smooth scrolling. The presentation helpers add consistent colors, spacing, labels, menus, and status text. Finally, the motion tools add careful animation and progress output, with quieter fallbacks when less movement is preferred.

## Sub-stages

- [Generic string, formatting, truncation, and templating utilities](stage-22.2.1.md) `stage-22.2.1` — 12 files
- [Streaming, line framing, and hidden-markup parsers](stage-22.2.2.md) `stage-22.2.2` — 9 files
- [TUI text layout, wrapping, and text-rendering primitives](stage-22.2.3.md) `stage-22.2.3` — 10 files
- [TUI presentation models, styling, and lightweight view helpers](stage-22.2.4.md) `stage-22.2.4` — 21 files
- [TUI animation, motion, terminal media, and transient progress output](stage-22.2.5.md) `stage-22.2.5` — 5 files
