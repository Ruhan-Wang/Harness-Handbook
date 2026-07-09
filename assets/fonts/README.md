# Fonts

The blog loads three open-source families from Google Fonts (see the `<link>`
in `index.html`):

- **Source Serif 4** — body text (long-form reading)
- **Source Sans 3** — headings, UI, labels, captions
- **IBM Plex Mono** — code, symbols, data labels

To self-host (offline / no external requests), drop the `.woff2` files in this
folder and replace the Google Fonts `<link>` in `index.html` with local
`@font-face` rules in `style.css`. The CSS already references the families via
the `--font-serif`, `--font-sans`, and `--font-mono` variables, so only the
`@font-face` sources need to change.
