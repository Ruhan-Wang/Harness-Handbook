---
title: Harness Handbook
emoji: 📘
colorFrom: blue
colorTo: indigo
sdk: static
app_file: index.html
pinned: false
---

# Harness Handbook — research blog

A public-facing research blog for the paper **"Harness Handbook: Making Evolving
Agent Harnesses Readable, Navigable, and Editable"** (Tencent Hunyuan, 2026).

It retells the paper for a broad ML/AI audience in an editorial research-article
style: warm paper background, serif reading column, a sticky table of contents,
redrawn figures, and interactive result charts. The page's goal is that a reader
leaves understanding **what the handbook is** (one map, three levels, evidence
links), **how it is built**, and **how they would use it** — including a
realistic Level-3 handbook entry and a "what this looks like in practice"
section for developers and coding agents.

> All text, diagrams, and assets are **newly created** from the paper's content.
> Nothing was copied from the paper's PDF figures or from any reference website.

## Run it

Fully static — no build step, no dependencies.

```bash
# from this folder
python3 -m http.server 8000
# then open http://localhost:8000
```

Or open `index.html` directly. URL switches: `?theme=light|dark` forces a theme,
`?lang=en|zh` forces a language (both otherwise persist via `localStorage`).

`harness-handbook.html` is a self-contained single-file bundle — regenerate it
with `python3 build.py` after editing any source file.

## Structure

```
handbook_blog/
├── index.html        # semantic HTML5, one <section> per part; EN copy lives here
├── style.css         # design system: tokens, type, layout, components, dark mode
├── script.js         # theme, scrollspy, generated SVG figures, charts, tables
├── i18n.js           # ZH dictionary + language runtime (EN is cached from the DOM)
├── build.py          # bundles everything into harness-handbook.html
└── assets/
    ├── illustrations/ # standalone light-theme SVG exports + MAPPING.md
    ├── icons/         # brand mark / favicon
    └── images/        # judge logos
```

## Design system

- **Type** — Source Serif 4 for display and body; Inter for UI, captions, and
  everything inside figures/charts; IBM Plex Mono for code. Chinese falls back
  to Noto Sans SC.
- **Color** — warm paper neutrals plus three semantic colors used consistently
  in prose and figures: **sienna = behavior**, **blue = handbook**,
  **graphite = implementation**. Hairline borders instead of shadows.
- **Charts** — emphasis scheme (Handbook in blue, Baseline in de-emphasis gray),
  thin marks with rounded data-ends, solid hairline grids, direct value labels,
  a dumbbell for the per-judge before→after comparison. The pair was validated
  for CVD separation and contrast on both surfaces.
- **Figures** — generated as inline SVG in `script.js`; colors reference CSS
  custom properties (so dark mode needs no re-render) and strings go through
  `tr()` (so figures translate). Standalone exports live in
  `assets/illustrations/` — see `MAPPING.md` there.

## Editing guide

- **Copy (EN)** — edit the relevant `<section>` in `index.html`. Each section is
  commented with its content source in the paper (e.g. `Source: §3.3 + Algorithm 1`).
- **Copy (ZH)** — mirror the change in the `ZH` dictionary in `i18n.js`
  (keys match `data-i18n` attributes and `tr()` calls).
- **Figures** — edit the generator functions in `script.js`
  (`heroSVG`, `treeSVG`, `levelsSVG`, `pipelineSVG`, `bgpdSVG`), then re-export
  the standalone copies (see `assets/illustrations/MAPPING.md`).
- **Chart / table data** — the `WIN`, `TOKENS`, `JUDGES`, `SCENARIO`, and
  `LOC_KEYS` objects in `script.js`.
- **Colors / type / spacing** — CSS custom properties in `:root` (and
  `html.dark`) at the top of `style.css`.

## Accessibility & performance

- Responsive to mobile (TOC collapses, grids stack, tables scroll in place).
- Respects `prefers-reduced-motion` (reveal and chart animations disabled) and
  `prefers-color-scheme`, with a manual toggle persisted to `localStorage`.
- Chart geometry is complete in the markup itself — entrance animation is
  CSS-only, so charts render fully even without JS timers (e.g. in snapshots).
- Every chart has direct value labels; the localization result is a real table.
- No JavaScript frameworks; all graphics are inline SVG.

## Deploy to GitHub Pages

This folder is ready for GitHub Pages as a static site:

- Entry point: `index.html` (self-contained bundle with embedded CSS/JS)
- `.nojekyll` disables Jekyll processing so all paths are served as-is
- Links use relative paths (`codex-handbook/`, `terminus-handbook/`, `studio/`)

After pushing to GitHub, enable Pages:

1. Repo → **Settings** → **Pages**
2. **Build and deployment** → Source: **Deploy from a branch**
3. Branch: `main` / folder: `/ (root)`
4. Save and wait 1–2 minutes

If the repo is named `harness-handbook-blog`, the site URL is:

```text
https://<your-github-username>.github.io/harness-handbook-blog/
```

If the repo is named `<your-github-username>.github.io`, the site URL is:

```text
https://<your-github-username>.github.io/
```

Note: the full folder is ~440 MB (mostly `codex-handbook/` and `studio/demo-data/`).
The first push may take several minutes. One demo file is ~74 MB, which is under
GitHub's 100 MB per-file limit but will trigger a size warning.
