# Illustration mapping

Every visual on the blog was **drawn from scratch** in the blog's own visual
language (editorial, warm paper, three semantic colors: sienna = behavior,
blue = handbook, graphite = implementation). This file records which
illustration corresponds to which part of the paper, and where to edit each one.

| Blog illustration | Source in paper | Where it lives | How to edit |
|---|---|---|---|
| `hero-bridge.svg` | Figure 1 (behavior ⇄ scattered implementation) | Hero | `heroSVG()` in `script.js` (theme-aware) + standalone export here |
| `behavior-scatter.svg` | §2 "one behavior, many sites" (file-tree view) | Part 02 · The real bottleneck | `treeSVG()` in `script.js` + export here |
| `progressive-disclosure.svg` | Figure 1 right panel (L1→L2→L3) | Part 03 · One map, three levels | `levelsSVG()` in `script.js` + export here |
| Unit-entry card | Figure 1 ("Main Loop" card) reimagined as an L3 excerpt | Part 03 (HTML `.unit-card`) | Edit markup in `index.html` |
| `construction-pipeline.svg` | Figure 2 (3-step pipeline) | Part 04 · Building a handbook | `pipelineSVG()` in `script.js` + export here |
| `bgpd-flow.svg` | §3.3 + Algorithm 1 (q → S → U → L → plan) | Part 05 · Using the handbook | `bgpdSVG()` in `script.js` + export here |
| Win-rate + token bar charts | Figure 3 (a/b) | Part 06 · Result 1 | `WIN` / `TOKENS` data + `groupedBars()` in `script.js` |
| Judge dumbbell chart | Figure 3 (c) | Part 06 · Result 1 | `JUDGES` data + `dumbbell()` in `script.js` |
| Localization table | Table 1 (both answer keys) | Part 06 · Result 2 | `LOC_KEYS` in `script.js` |
| Scenario bar chart | Figures 4–5 | Part 06 · Result 3 | `SCENARIO` in `script.js` |

## Notes on data

* Chart numbers were read from the paper's figures/table; the localization
  table offers both the **Opus 4.8** and **GPT-5.5** answer-key columns of Table 1.
* Chart colors follow an emphasis scheme validated for color-vision deficiency:
  Handbook `#2a78d6` (light) / `#3987e5` (dark) vs. de-emphasis gray Baseline
  `#a5a29a` / `#75736c`; every bar carries a direct value label.

## Why two copies of each diagram?

The **standalone `.svg` files** here are light-theme exports with literal hex
colors so they can be opened, reused, or handed off on their own. The **live
site** generates a theme-aware copy in `script.js` (colors via CSS custom
properties, strings via i18n) so diagrams recolor in dark mode and translate to
Chinese. The exports are produced mechanically from the live versions — after
editing `script.js`, re-export rather than editing these files by hand.
