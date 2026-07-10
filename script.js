/* ==========================================================================
   Harness Handbook — interactions & generated graphics
   --------------------------------------------------------------------------
   Modules (vanilla JS, no dependencies):
     1. Theme toggle
     2. Reading progress + TOC scrollspy
     3. Reveal-on-scroll
     4. Figures (inline SVG, theme-aware through CSS custom properties)
     5. Charts (grouped bars, dumbbell) + localization table
     6. Copy BibTeX + language re-render
   Figure & chart colors reference CSS variables directly (fill="var(--x)"),
   so they adapt to light/dark without re-rendering.
   ========================================================================== */
(function () {
  "use strict";
  const tr = (k, fb) => window.HH_I18N?.tr(k, fb) ?? fb;
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ---- shared tokens for generated SVG ---- */
  const INK   = "var(--ink)";
  const SOFT  = "var(--ink-soft)";
  const MUT   = "var(--muted)";
  const FAINT = "var(--faint)";
  const LINE  = "var(--line)";
  const LINES = "var(--line-soft)";
  const SURF  = "var(--surface)";
  const BLUE  = "var(--accent)";
  const BLUEI = "var(--accent-ink)";
  const BLUEW = "var(--accent-wash)";
  const SIEN  = "var(--sienna)";
  const SIENI = "var(--sienna-ink)";
  const SIENW = "var(--sienna-wash)";
  const GRA   = "var(--graphite)";
  const MONO  = "var(--font-mono)";

  /* ===================== 1. THEME ===================== */
  const root = document.documentElement;
  const forced = new URLSearchParams(location.search).get("theme");
  const saved = forced || localStorage.getItem("hh-theme");
  if (saved === "dark" || (!saved && matchMedia("(prefers-color-scheme: dark)").matches)) {
    root.classList.add("dark");
  } else if (saved === "light") {
    root.classList.remove("dark");
  }
  $("#theme-toggle")?.addEventListener("click", () => {
    root.classList.toggle("dark");
    localStorage.setItem("hh-theme", root.classList.contains("dark") ? "dark" : "light");
  });

  /* ===================== 2. PROGRESS + SCROLLSPY ===================== */
  const bar = $("#progress-bar");
  const tocItems = $$(".toc__item");
  const sections = tocItems
    .map((a) => document.getElementById(a.getAttribute("href").slice(1)))
    .filter(Boolean);

  function onScroll() {
    const h = document.documentElement;
    const scrolled = h.scrollTop / (h.scrollHeight - h.clientHeight);
    if (bar) bar.style.width = (scrolled * 100).toFixed(2) + "%";
    let active = sections[0];
    const probe = h.scrollTop + 130;
    for (const sec of sections) if (sec.offsetTop <= probe) active = sec;
    tocItems.forEach((a) =>
      a.classList.toggle("is-active", a.getAttribute("href") === "#" + (active && active.id))
    );
  }
  document.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);

  /* ===================== 3. REVEAL ===================== */
  const revealSel = [
    ".hero__figure", ".tldr", ".note", ".figure", ".steps", ".specs",
    ".usecols", ".flowpath", ".insights", ".tk-lead", ".tkgrid", ".tk-studio",
    ".chart-card", ".aside"
  ].join(",");
  $$(revealSel).forEach((el) => el.classList.add("reveal"));
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
    });
  }, { threshold: 0.1 });
  $$(".reveal").forEach((el) => io.observe(el));

  /* ===================== 4. FIGURES ===================== */

  // text helper
  function T(x, y, s, o = {}) {
    const a = [
      `x="${x}"`, `y="${y}"`,
      `font-size="${o.size || 13}"`,
      o.w ? `font-weight="${o.w}"` : "",
      `fill="${o.fill || SOFT}"`,
      o.anchor ? `text-anchor="${o.anchor}"` : "",
      o.ls ? `letter-spacing="${o.ls}"` : "",
      o.italic ? `font-style="italic"` : "",
      o.mono ? `font-family="${MONO}"` : "",
      o.op ? `opacity="${o.op}"` : ""
    ].filter(Boolean).join(" ");
    return `<text ${a}>${s}</text>`;
  }
  const overline = (x, y, s, fill) => T(x, y, s, { size: 11, w: 650, fill, anchor: "middle", ls: ".12em" });
  // horizontal arrow with head
  const harrow = (x1, x2, y, color, wdt = 1.6) =>
    `<path d="M${x1} ${y} H${x2 - 7}" stroke="${color}" stroke-width="${wdt}" fill="none"/>` +
    `<polygon points="${x2 - 8},${y - 4.5} ${x2},${y} ${x2 - 8},${y + 4.5}" fill="${color}"/>`;
  // curved connector with head (ends moving rightward)
  const carrow = (x1, y1, x2, y2, color, op = 1) => {
    const mx = (x1 + x2) / 2;
    return `<path d="M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2 - 7} ${y2}" stroke="${color}" stroke-width="1.5" fill="none" opacity="${op}"/>` +
      `<polygon points="${x2 - 8},${y2 - 4.2} ${x2},${y2} ${x2 - 8},${y2 + 4.2}" fill="${color}" opacity="${op}"/>`;
  };

  // ---- Hero: behavior → handbook → code -------------------------------
  function heroSVG() {
    // center column: three levels
    const levels = [
      ["L1", tr("fig.hero.l1", "System overview"),         tr("fig.hero.l1s", "execution flow")],
      ["L2", tr("fig.hero.l2", "Behavior-unit overview"), tr("fig.hero.l2s", "relevant behavior units")],
      ["L3", tr("fig.hero.l3", "Behavior-unit detail"),   tr("fig.hero.l3s", "implementation evidence")]
    ];
    const rows = levels.map((l, i) => {
      const y = 116 + i * 64;
      return `
        <g class="fx" style="--d:${(0.34 + i * 0.08).toFixed(2)}s">
        <rect x="379" y="${y}" width="202" height="52" rx="8" fill="${SURF}" stroke="${LINE}"/>
        <rect x="391" y="${y + 13}" width="26" height="26" rx="6" fill="${BLUEW}"/>
        ${T(404, y + 31, l[0], { size: 11.5, w: 650, fill: BLUEI, anchor: "middle" })}
        ${T(429, y + 24, l[1], { size: 13, w: 600, fill: INK })}
        ${T(429, y + 41, l[2], { size: 11.5, fill: MUT })}
        ${i < 2 ? `<path d="M475 ${y + 56} l5 5 5 -5" fill="none" stroke="${FAINT}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>` : ""}
        </g>`;
    }).join("");

    // right column: implementation sites
    const files = [
      ["prompts/system.md", true],
      ["tools/wrapper.py", true],
      ["state/manager.py", true],
      ["config/flags.py", true],
      ["telemetry/events.py", true],
      ["memory/store.py", false]
    ];
    const fileRows = files.map((f, i) => {
      const y = 104 + i * 37;
      const hl = f[1];
      return `
        <g class="fx" style="--d:${(0.62 + i * 0.06).toFixed(2)}s"><g opacity="${hl ? 1 : 0.5}">
          <rect x="700" y="${y}" width="240" height="30" rx="6" fill="${SURF}" stroke="${LINE}"/>
          ${hl ? `<circle cx="716" cy="${y + 15}" r="3.6" fill="${SIEN}"/>` : ""}
          ${T(hl ? 728 : 716, y + 19.5, f[0], { size: 12, mono: true, fill: hl ? SOFT : MUT })}
        </g></g>`;
    }).join("");
    const fan = files.filter((f) => f[1]).map((f, i) => {
      const y = 104 + files.indexOf(f) * 37 + 15;
      return carrow(600, 212, 700, y, BLUE, 0.5);
    }).join("");

    return `
<svg viewBox="0 0 960 348" role="img" aria-label="${tr("fig.hero.aria", "A behavior request, mapped through the handbook to the implementation sites in code")}">
  <!-- left: the behavior -->
  <g class="fx">
    ${overline(135, 86, tr("fig.hero.olA", "THE BEHAVIOR YOU WANT"), SIENI)}
    <rect x="20" y="102" width="230" height="94" rx="10" fill="${SIENW}" stroke="color-mix(in srgb, ${SIEN} 34%, ${LINE})"/>
    ${T(135, 141, tr("fig.hero.q1", "“Ask the user before"), { size: 14.5, italic: true, anchor: "middle", fill: SOFT })}
    ${T(135, 163, tr("fig.hero.q2", "deleting files.”"), { size: 14.5, italic: true, anchor: "middle", fill: SOFT })}
    ${T(135, 226, tr("fig.hero.subA1", "Expressed in plain language"), { size: 12.5, anchor: "middle", fill: MUT })}
    ${T(135, 244, tr("fig.hero.subA2", "by the user."), { size: 12.5, anchor: "middle", fill: MUT })}
  </g>

  <!-- middle: the handbook -->
  <g class="fx" style="--d:.26s">
    ${overline(480, 86, tr("fig.hero.olB", "THE HANDBOOK"), BLUEI)}
    <rect x="365" y="102" width="230" height="206" rx="12" fill="none" stroke="color-mix(in srgb, ${BLUE} 40%, ${LINE})" stroke-width="1.4"/>
  </g>
  ${rows}

  <!-- right: the code -->
  <g class="fx" style="--d:.58s">${overline(820, 86, tr("fig.hero.olC", "IMPLEMENTATION SITES IN CODE"), GRA)}</g>
  ${fileRows}
  <g class="fx" style="--d:1s">${T(820, 336, tr("fig.hero.subC", "five scattered sites — identified before editing begins"), { size: 12.5, anchor: "middle", fill: MUT })}</g>

  <!-- connectors -->
  <g class="fx" style="--d:.18s">${carrow(250, 149, 365, 205, SIEN, 0.85)}</g>
  <g class="fx" style="--d:.55s">${fan}</g>
</svg>`;
  }

  // ---- The problem: one behavior scattered through a file tree --------
  function treeSVG() {
    const rows = [
      ["core/", 0, false, ""],
      ["loop.py", 1, false, ""],
      ["state_manager.py", 1, true,  tr("fig.tree.a1", "records whether the user approved")],
      ["tools/", 0, false, ""],
      ["wrapper.py", 1, true,  tr("fig.tree.a2", "intercepts the delete tool call")],
      ["registry.py", 1, false, ""],
      ["prompts/", 0, false, ""],
      ["system.md", 1, true,  tr("fig.tree.a3", "tells the model to ask before deleting")],
      ["config/", 0, false, ""],
      ["flags.py", 1, true,  tr("fig.tree.a4", "defines deletion as high-risk")],
      ["memory/", 0, false, ""],
      ["store.py", 1, false, ""],
      ["telemetry/", 0, false, ""],
      ["events.py", 1, true,  tr("fig.tree.a5", "records the confirmation result")],
      ["consumers/", 0, false, ""],
      ["result_handler.py", 1, true,  tr("fig.tree.a6", "handles sandbox execution & fallbacks")]
    ];
    const y0 = 84, dy = 23.5;
    let k = 0;
    const baseRows = [], siteRows = [];
    rows.forEach((r, i) => {
      const y = y0 + i * dy;
      const x = r[1] ? 374 : 352;
      let out = "";
      if (r[2]) {
        out += `<rect class="site-hl" x="340" y="${y - 15}" width="272" height="21" rx="5" fill="${SIENW}"/>`;
        out += `<circle cx="356" cy="${y - 4.5}" r="3.4" fill="${SIEN}"/>`;
      }
      out += T(r[2] ? 368 : x, y, r[0], {
        size: 12, mono: true,
        fill: r[1] ? (r[2] ? SOFT : MUT) : FAINT,
        w: r[2] ? 500 : 400
      });
      if (r[3]) {
        out += `<path d="M614 ${y - 4.5} H646" stroke="${LINE}" stroke-width="1.2"/>`;
        out += T(654, y - 0.5, r[3], { size: 12.5, fill: SOFT });
      }
      if (r[2]) { siteRows.push(`<g class="fx site" style="--d:${(0.4 + k * 0.09).toFixed(2)}s">${out}</g>`); k++; }
      else baseRows.push(out);
    });
    const rowsSVG = baseRows.join("");
    const sitesSVG = siteRows.join("");

    return `
<svg viewBox="0 0 960 508" role="img" aria-label="${tr("fig.tree.aria", "The delete-confirmation behavior maps to many scattered files in the harness codebase")}">
  <!-- left: the request -->
  <g class="fx">
    ${overline(135, 100, tr("fig.tree.olA", "THE BEHAVIOR QUESTION"), SIENI)}
    <rect x="20" y="116" width="230" height="92" rx="10" fill="${SIENW}" stroke="color-mix(in srgb, ${SIEN} 34%, ${LINE})"/>
  ${T(135, 154, tr("fig.tree.q1", "“Ask the user before"), { size: 14.5, italic: true, anchor: "middle", fill: SOFT })}
  ${T(135, 176, tr("fig.tree.q2", "deleting files.”"), { size: 14.5, italic: true, anchor: "middle", fill: SOFT })}
    ${T(135, 238, tr("fig.tree.subA", ""), { size: 12.5, anchor: "middle", fill: MUT })}
  </g>
  <g class="fx" style="--d:.15s">${harrow(256, 326, 162, SIEN)}</g>

  <!-- middle: file tree -->
  <g class="fx" style="--d:.25s">
    <rect x="330" y="20" width="292" height="462" rx="10" fill="${SURF}" stroke="${LINE}"/>
    ${T(350, 48, "harness/", { size: 12.5, mono: true, w: 600, fill: SOFT })}
    <path d="M330 62 H622" stroke="${LINES}" stroke-width="1"/>
    ${rowsSVG}
  </g>
  ${sitesSVG}

  <!-- right: what each site does -->
  <g class="fx" style="--d:.35s">${overline(790, 48, tr("fig.tree.olC", "WHAT EACH SITE DOES"), GRA)}</g>
  <g class="fx" style="--d:1s">
    <circle cx="660" cy="474" r="3.4" fill="${SIEN}"/>
    ${T(672, 478.5, tr("fig.tree.stat1", "One behavior, many implementation sites."), { size: 12.5, w: 600, fill: SOFT })}
    ${T(672, 497, tr("fig.tree.stat2", "Keyword search misses the indirect paths."), { size: 12.5, fill: MUT })}
  </g>
</svg>`;
  }

  // ---- The handbook: behavior question → code evidence funnel ----------
  function levelsSVG() {
    const downArrow = (x, y1, y2, color = BLUE) => `
      <path d="M${x} ${y1} V${y2 - 8}" stroke="${color}" stroke-width="1.7" fill="none" opacity="0.72"/>
      <polygon points="${x - 5},${y2 - 9} ${x},${y2} ${x + 5},${y2 - 9}" fill="${color}" opacity="0.72"/>`;

    const chip = (x, y, w, text, color = BLUEI) => `
      <rect x="${x}" y="${y}" width="${w}" height="24" rx="6" fill="${BLUEW}" stroke="color-mix(in srgb, ${BLUE} 24%, ${LINE})"/>
      ${T(x + w / 2, y + 16, text, { size: 11.2, w: 600, fill: color, anchor: "middle" })}`;

    // one funnel card: header row (level chip · title · output), body text full-width
    const card = (id, d, y, w, color, wash, level, title, task, q1, q2, out1, out2) => {
      const x = (960 - w) / 2;
      return `
      <g class="fx" style="--d:${d}s" data-pick="${id}" tabindex="0" role="button" aria-label="${title}">
        <rect class="pick-bg" x="${x}" y="${y}" width="${w}" height="112" rx="13" fill="${SURF}" stroke="${LINE}"/>
        <rect x="${x}" y="${y}" width="${w}" height="36" rx="13" fill="${wash}" opacity="0.86"/>
        <path d="M${x} ${y + 36} H${x + w}" stroke="${LINES}" stroke-width="1"/>
        <rect x="${x + 16}" y="${y + 8}" width="34" height="21" rx="6" fill="${SURF}" stroke="color-mix(in srgb, ${color} 32%, ${LINE})"/>
        ${T(x + 33, y + 22.5, level, { size: 11, w: 700, fill: color, anchor: "middle" })}
        ${T(x + 62, y + 23, title, { size: 14, w: 700, fill: INK })}
        ${T(x + w - 18, y + 23, `${out1} → ${out2}`, { size: 11.5, w: 600, fill: color, anchor: "end" })}
        ${T(x + 22, y + 62, task, { size: 14.2, w: 650, fill: INK })}
        ${T(x + 22, y + 85, q1, { size: 12.4, fill: MUT })}
        ${T(x + 22, y + 103, q2, { size: 12.4, fill: MUT })}
      </g>`;
    };

    return `
<svg viewBox="0 0 960 684" role="img" aria-label="${tr("fig.levels.aria", "From system understanding to behavior evidence through three handbook levels")}">
  ${T(480, 30, tr("fig.levels.funnel.title", "From system understanding to behavior evidence"), { size: 23, w: 800, fill: INK, anchor: "middle" })}
  ${T(480, 54, tr("fig.levels.funnel.sub", "The handbook organizes behavior information step by step through three levels."), { size: 13, fill: MUT, anchor: "middle" })}

  <!-- behavior question -->
  <g class="fx">
    <rect x="286" y="78" width="388" height="58" rx="13" fill="${SIENW}" stroke="color-mix(in srgb, ${SIEN} 35%, ${LINE})"/>
    ${overline(480, 100, tr("fig.levels.input.label", "HARNESS REPOSITORY"), SIENI)}
    ${T(480, 124, tr("fig.levels.input.text", "Code facts organized into a three-level handbook"), { size: 13.3, fill: SOFT, anchor: "middle" })}
  </g>

  <g class="fx" style="--d:.15s">${downArrow(480, 144, 174, SIEN)}</g>

  <!-- funnel cards -->
  ${card(
    "l1", 0.3, 174, 800, BLUEI, BLUEW,
    tr("fig.levels.l1.level", "L1"),
    tr("fig.levels.l1tab", "System Overview"),
    tr("fig.levels.l1task", "Build overall system understanding"),
    tr("fig.levels.l1q1", "Question: How does this harness run as a whole?"),
    tr("fig.levels.l1q2", "Focus on architecture, execution flow, main stages, and state flow."),
    tr("fig.levels.l1out1", "Output"),
    tr("fig.levels.l1out2", "system-level behavior framework")
  )}

  <g class="fx" style="--d:.45s">${downArrow(480, 290, 316, BLUE)}</g>

  ${card(
    "l2", 0.5, 316, 690, BLUEI, BLUEW,
    tr("fig.levels.l2.level", "L2"),
    tr("fig.levels.l2tab", "Behavior-Unit Overview"),
    tr("fig.levels.l2task", "Identify the system’s behavior units"),
    tr("fig.levels.l2q1", "Question: Which behavior units exist, and how do they connect?"),
    tr("fig.levels.l2q2", "Focus on responsibilities, inputs/outputs, ordering, and key state."),
    tr("fig.levels.l2out1", "Output"),
    tr("fig.levels.l2out2", "behavior-unit map")
  )}

  <g class="fx" style="--d:.65s">${downArrow(480, 432, 458, BLUE)}</g>

  ${card(
    "l3", 0.7, 458, 580, GRA, "var(--graphite-wash)",
    tr("fig.levels.l3.level", "L3"),
    tr("fig.levels.l3tab", "Behavior-Unit Detail"),
    tr("fig.levels.l3task", "Go inside a single behavior unit"),
    tr("fig.levels.l3q1", "Question: How does this behavior unit execute?"),
    tr("fig.levels.l3q2", "Focus on triggers, state changes, exception paths, and evidence."),
    tr("fig.levels.l3out1", "Output"),
    tr("fig.levels.l3out2", "verifiable implementation evidence")
  )}

  <g class="fx" style="--d:.85s">${downArrow(480, 574, 600, GRA)}</g>

  <!-- code evidence -->
  <g class="fx" style="--d:.95s">
    <rect x="286" y="600" width="388" height="42" rx="10" fill="${SURF}" stroke="${LINE}"/>
    ${chip(306, 609, 112, "wrapper.py", BLUEI)}
    ${chip(430, 609, 110, "manager.py", BLUEI)}
    ${chip(552, 609, 102, "flags.py", BLUEI)}
  </g>

  ${T(480, 674, tr("fig.levels.hint", "Click a level to focus it — click again to reset."), { size: 11.5, italic: true, fill: FAINT, anchor: "middle" })}
</svg>`;
  }

  // ---- Construction pipeline: extract → organize → synthesize ---------
  function pipelineSVG() {
    const stations = [
      {
        cx: 296, n: "1",
        t: tr("fig.pipe.t1", "Extract facts"),
        d1: tr("fig.pipe.d1a", "static analysis of files, functions,"),
        d2: tr("fig.pipe.d1b", "calls, state and config"),
        out: tr("fig.pipe.o1", "program graph")
      },
      {
        cx: 552, n: "2",
        t: tr("fig.pipe.t2", "Organize by behavior"),
        d1: tr("fig.pipe.d2a", "map code onto an execution skeleton,"),
        d2: tr("fig.pipe.d2b", "refine until the mapping converges"),
        out: tr("fig.pipe.o2", "behavior map")
      },
      {
        cx: 808, n: "3",
        t: tr("fig.pipe.t3", "Synthesize"),
        d1: tr("fig.pipe.d3a", "render the three levels, keep"),
        d2: tr("fig.pipe.d3b", "every evidence link intact"),
        out: tr("fig.pipe.o3", "handbook · L1–L3")
      }
    ];
    const st = stations.map((s, i) => `
      <g class="fx hov" style="--d:${(0.18 + i * 0.2).toFixed(2)}s">
      <circle cx="${s.cx}" cy="56" r="15" fill="${BLUEW}" stroke="color-mix(in srgb, ${BLUE} 38%, ${LINE})"/>
      ${T(s.cx, 61, s.n, { size: 13, w: 650, fill: BLUEI, anchor: "middle" })}
      ${T(s.cx, 98, s.t, { size: 15.5, w: 650, fill: INK, anchor: "middle" })}
      ${T(s.cx, 120, s.d1, { size: 12.5, fill: MUT, anchor: "middle" })}
      ${T(s.cx, 137, s.d2, { size: 12.5, fill: MUT, anchor: "middle" })}
      <rect x="${s.cx - 78}" y="156" width="156" height="30" rx="8" fill="${BLUEW}"/>
      ${T(s.cx, 175.5, s.out, { size: 12.5, w: 600, fill: BLUEI, anchor: "middle" })}
      </g>`).join("");

    return `
<svg viewBox="0 0 960 262" role="img" aria-label="${tr("fig.pipe.aria", "Handbook construction: extract facts, organize by behavior, synthesize")}">
  <!-- input -->
  <g class="fx">
    <rect x="20" y="38" width="128" height="36" rx="9" fill="${SURF}" stroke="${LINE}"/>
    ${T(84, 61, tr("fig.pipe.repo", "harness repo"), { size: 12.5, mono: true, fill: SOFT, anchor: "middle" })}
  </g>
  <g class="fx" style="--d:.1s">${harrow(154, 274, 56, FAINT)}</g>
  <g class="fx" style="--d:.3s">${harrow(322, 528, 56, FAINT)}</g>
  <g class="fx" style="--d:.5s">${harrow(578, 784, 56, FAINT)}</g>
  ${st}
  <!-- proposer-reviewer loop under station 2 -->
  <g class="fx" style="--d:.72s">
    <path d="M492 214 a10 10 0 1 1 6 9" fill="none" stroke="${FAINT}" stroke-width="1.5"/>
    <polygon points="494,226 502,224 497,217" fill="${FAINT}"/>
    ${T(518, 220, tr("fig.pipe.loop", "proposer ⇄ reviewer, until convergence"), { size: 12, fill: MUT })}
  </g>
  <g class="fx" style="--d:.88s">${T(480, 252, tr("fig.pipe.foot", "Prose explains — facts anchor. Every entry stays linked to verifiable code evidence."), { size: 12.5, italic: true, fill: MUT, anchor: "middle" })}</g>
</svg>`;
  }

  // ---- BGPD: request → stages → units → L3 evidence → edit plan --------
  function bgpdSVG() {
    const header = (x, s) => T(x, 40, s, { size: 11, w: 650, fill: FAINT, ls: ".1em" });
    const GOODC = "var(--c-good)";
    // one column = header + mini panel; the panel bg doubles as the pick ring
    const col = (id, d, x0, w, label, inner) => `
      <g class="fx" style="--d:${d}s" data-pick="${id}" tabindex="0" role="button" aria-label="${label}">
        <rect class="pick-bg" x="${x0}" y="56" width="${w}" height="252" rx="12" fill="${SURF}" stroke="${LINE}"/>
        ${header(x0 + 2, label)}
        ${inner}
      </g>`;
    // the layer's FORM, printed as its first line — what makes this level distinct
    const form = (x0, s) => T(x0 + 14, 78, s, { size: 10.5, w: 650, fill: FAINT });
    const hlRow = (x, y, w) => `<rect x="${x}" y="${y}" width="${w}" height="26" rx="7" fill="color-mix(in srgb, ${BLUE} 10%, transparent)" stroke="${BLUE}" stroke-width="1.4"/>`;

    // L1 · overview: prose + a vertical lifecycle
    const stages = [
      [tr("fig.bgpd.st1", "input"), 0], [tr("fig.bgpd.st2", "plan"), 0],
      [tr("fig.bgpd.st3", "tool execution"), 1], [tr("fig.bgpd.st4", "observe"), 0],
      [tr("fig.bgpd.st5", "finalize"), 0]
    ];
    const l1rows = stages.map((st, i) => {
      const y = 94 + i * 42;
      return `
        ${st[1] ? hlRow(219, y, 152) : `<rect x="219" y="${y}" width="152" height="26" rx="7" fill="${BLUEW}" stroke="color-mix(in srgb, ${BLUE} 22%, ${LINE})"/>`}
        ${T(295, y + 17.5, st[0], { size: 12, w: st[1] ? 650 : 500, fill: BLUEI, anchor: "middle" })}
        ${i < 4 ? `<path d="M295 ${y + 29} v7 m-4 -4 l4 5 4 -5" stroke="${FAINT}" stroke-width="1.3" fill="none"/>` : ""}`;
    }).join("");

    // L2 · index: unit map with jobs + function counts + the register table
    const units = [
      [tr("fig.bgpd.u1", "Delete guard"), "3", 1],
      [tr("fig.bgpd.u2", "Permission rule"), "1", 0],
      [tr("fig.bgpd.u3", "State record"), "2", 0],
      [tr("fig.bgpd.u4", "Fallback path"), "2", 0]
    ];
    const l2rows = units.map((u, i) => {
      const y = 94 + i * 40;
      return `
        ${u[2] ? hlRow(424, y, 152) : `<rect x="424" y="${y}" width="152" height="26" rx="7" fill="${SURF}" stroke="${LINE}"/>`}
        ${T(436, y + 17.5, u[0], { size: 12, w: u[2] ? 650 : 500, fill: u[2] ? BLUEI : SOFT })}
        ${T(566, y + 17.5, u[1] + " " + tr("fig.bgpd.fn", "fn"), { size: 10, fill: FAINT, anchor: "end" })}`;
    }).join("");

    return `
<svg viewBox="0 0 1000 400" role="img" aria-label="${tr("fig.bgpd.aria", "BGPD narrows a behavior question through L1, L2, L3 to code evidence and an edit plan")}">
  <!-- 1 · behavior question -->
  ${col("req", 0, 20, 160, tr("fig.bgpd.h1", "1 · BEHAVIOR QUESTION"), `
    <rect x="32" y="126" width="136" height="92" rx="10" fill="${SIENW}" stroke="color-mix(in srgb, ${SIEN} 34%, ${LINE})"/>
    ${T(100, 162, tr("fig.bgpd.q1", "“Before deleting a file,"), { size: 12, italic: true, anchor: "middle", fill: SOFT })}
    ${T(100, 182, tr("fig.bgpd.q2", "must it confirm?”"), { size: 12, italic: true, anchor: "middle", fill: SOFT })}`)}

  <!-- 2 · L1: prose + lifecycle -->
  ${col("l1", 0.15, 205, 180, tr("fig.bgpd.h2", "2 · L1 SYSTEM OVERVIEW"), `
    ${form(205, tr("fig.bgpd.l1form", "prose + lifecycle diagram"))}
    ${l1rows}`)}

  <!-- 3 · L2: the unit map -->
  ${col("l2", 0.3, 410, 180, tr("fig.bgpd.h3", "3 · L2 UNIT OVERVIEW"), `
    ${form(410, tr("fig.bgpd.l2form", "unit map · roles & functions"))}
    ${l2rows}
    <path d="M424 262 H576" stroke="${LINES}" stroke-width="1"/>
    ${T(424, 284, tr("fig.bgpd.l2reg", "registers · every read/write"), { size: 10.5, fill: MUT })}`)}

  <!-- 4 · L3: one behavior-unit detail -->
  ${col("l3", 0.45, 615, 180, tr("fig.bgpd.h4", "4 · L3 UNIT DETAIL"), `
    ${form(615, tr("fig.bgpd.l3form", "unit · trigger/state/evidence"))}
    ${hlRow(629, 96, 152)}
    ${T(641, 113.5, tr("fig.bgpd.l3title", "Confirm before delete"), { size: 12, w: 650, fill: BLUEI })}
    ${T(629, 144, tr("fig.bgpd.l3r1", "trigger: delete_file(path)"), { size: 10.6, fill: SOFT })}
    ${T(629, 168, tr("fig.bgpd.l3r2", "permission: high risk"), { size: 10.6, fill: MUT })}
    ${T(629, 192, tr("fig.bgpd.l3r3", "state: record confirmation"), { size: 10.6, fill: MUT })}
    ${T(629, 216, tr("fig.bgpd.l3r4", "path: approve / reject"), { size: 10.6, fill: MUT })}
    ${T(629, 244, tr("fig.bgpd.l3r5", "evidence: 5 sites"), { size: 10.6, fill: MUT })}`)}

  <!-- 5 · evidence / edit plan -->
  ${col("plan", 0.6, 820, 160, tr("fig.bgpd.h5", "5 \u00b7 EVIDENCE / EDIT PLAN"), `
    ${form(820, tr("fig.bgpd.pform", "a plan that cites evidence"))}
    ${T(834, 102, tr("fig.bgpd.pA1", "goal"), { size: 10.5, w: 650, fill: FAINT, ls: ".06em" })}
    ${T(834, 120, tr("fig.bgpd.pA2", "confirm before deleting"), { size: 12, w: 650, fill: SOFT })}
    <path d="M834 136 H966" stroke="${LINES}" stroke-width="1"/>
    ${T(834, 160, "1", { size: 11, w: 650, fill: FAINT })}
    ${T(848, 160, "wrapper.py", { size: 11, mono: true, w: 600, fill: SOFT })}
    ${T(848, 177, tr("fig.bgpd.d1", "add the confirm check"), { size: 10.5, fill: MUT })}
    ${T(834, 210, "2", { size: 11, w: 650, fill: FAINT })}
    ${T(848, 210, "permissions.py", { size: 11, mono: true, w: 600, fill: SOFT })}
    ${T(848, 227, tr("fig.bgpd.d2", "mark delete high-risk"), { size: 10.5, fill: MUT })}
    ${T(834, 260, "3", { size: 11, w: 650, fill: FAINT })}
    ${T(848, 260, tr("fig.bgpd.f3", "fallback paths"), { size: 11, mono: true, w: 600, fill: SOFT })}
    ${T(848, 277, tr("fig.bgpd.d3", "close the bypass"), { size: 10.5, fill: MUT })}
    ${T(834, 300, tr("fig.bgpd.d4", "each step \u2190 cites L3 evidence"), { size: 10, italic: true, fill: FAINT })}`)}

  <!-- arrows -->
  <g class="fx" style="--d:.12s">${harrow(184, 202, 172, BLUE)}</g>
  <g class="fx" style="--d:.27s">${harrow(389, 407, 172, BLUE)}</g>
  <g class="fx" style="--d:.42s">${harrow(594, 612, 172, BLUE)}</g>
  <g class="fx" style="--d:.57s">${harrow(799, 817, 172, BLUE)}</g>

  <!-- coarse \u2192 fine axis -->
  <g class="fx" style="--d:.75s">
    <path d="M20 330 H960" stroke="${LINE}" stroke-width="1"/>
    <polygon points="960,326 968,330 960,334" fill="${FAINT}"/>
    ${T(20, 352, tr("fig.bgpd.coarse", "coarse \u2014 system context"), { size: 12, fill: MUT })}
    ${T(968, 352, tr("fig.bgpd.fine", "fine \u2014 code evidence"), { size: 12, fill: MUT, anchor: "end" })}
    ${T(494, 376, tr("fig.bgpd.note", "Each step reveals only what the decision needs \u2014 the evidence serves understanding and auditing, and can go on to support an edit plan."), { size: 12.5, italic: true, fill: MUT, anchor: "middle" })}
  </g>
</svg>`;
  }

  // ---- Studio: request → handbook diff → review → write & sync ----
  function studioSVG() {
    const GOOD = "var(--c-good)";
    const goodWash = `color-mix(in srgb, ${GOOD} 12%, transparent)`;
    const siteWash = `color-mix(in srgb, ${BLUE} 7%, transparent)`;
    const siteStroke = `color-mix(in srgb, ${BLUE} 34%, transparent)`;
    const sienWash = `color-mix(in srgb, ${SIEN} 12%, transparent)`;
    // a real eval case (Codex · CF11 "per-command env overrides"): the
    // reference plan requires 14 sites across 10 files. Every file gets a row;
    // each row carries its real snippet — clicking opens the source + diff.
    const SITES = [
      { f: "protocol/models.rs · ShellCommandToolCallParams", p: "+5", m: "", code: [
        ["c", "# protocol/src/models.rs:1608"],
        ["n", "pub struct ShellCommandToolCallParams {"],
        ["n", "    pub additional_permissions:"],
        ["n", "        Option<AdditionalPermissionProfile>,"],
        ["n", "    pub justification: Option<String>,"],
        ["a", "    /// Extra env vars on top of the"],
        ["a", "    /// inherited environment, for this"],
        ["a", "    /// command only. Not persisted."],
        ["a", "    #[serde(default, skip_serializing\u2026)]"],
        ["a", "    pub env:"],
        ["a", "        Option<HashMap<String, String>>,"],
        ["n", "}"]
      ]},
      { f: "handlers/shell_spec.rs · shell_command spec", p: "+13", m: "", code: [
        ["c", "# handlers/shell_spec.rs:168"],
        ["n", "(\"timeout_ms\".to_string(),"],
        ["n", "  JsonSchema::number(Some("],
        ["n", "    \"Maximum command runtime.\"\u2026))),"],
        ["a", "(\"env\".to_string(), {"],
        ["a", "  let mut schema = JsonSchema::object("],
        ["a", "    BTreeMap::new(), None,"],
        ["a", "    Some(JsonSchema::string(None).into()));"],
        ["a", "  schema.description = Some("],
        ["a", "    \"Extra environment variables added"],
        ["a", "     for this command only; not"],
        ["a", "     persisted for later commands.\"\u2026);"],
        ["a", "  schema }),"]
      ]},
      { f: "handlers/shell_spec.rs · exec_command spec", p: "+13", m: "", code: [
        ["c", "# handlers/shell_spec.rs:51"],
        ["n", "(\"max_output_tokens\".to_string(),"],
        ["n", "  JsonSchema::number(Some("],
        ["n", "    \"Output token budget.\"\u2026))),"],
        ["a", "(\"env\".to_string(), {"],
        ["a", "  let mut schema = JsonSchema::object("],
        ["a", "    BTreeMap::new(), None,"],
        ["a", "    Some(JsonSchema::string(None).into()));"],
        ["a", "  schema.description = Some("],
        ["a", "    \"Extra env vars added on top of the"],
        ["a", "     inherited environment for this"],
        ["a", "     command only.\"\u2026);"],
        ["a", "  schema }),"]
      ]},
      { f: "handlers/shell/shell_command.rs · to_exec_params", p: "+7", m: "", code: [
        ["c", "# handlers/shell/shell_command.rs:98"],
        ["a", "let mut env = create_env(&turn_context"],
        ["a", "    .shell_environment_policy,"],
        ["a", "    Some(thread_id));"],
        ["a", "if let Some(extra) = params.env.as_ref() {"],
        ["a", "    for (k, v) in extra {"],
        ["a", "        env.insert(k.clone(), v.clone());"],
        ["a", "    }"],
        ["a", "}"],
        ["n", "Ok(ExecParams {"],
        ["n", "    command,"],
        ["n", "    cwd,"],
        ["n", "    expiration: params.timeout_ms.into(),"],
        ["a", "    env,"],
        ["n", "})"]
      ]},
      { f: "handlers/unified_exec.rs · ExecCommandArgs", p: "+4", m: "", code: [
        ["c", "# core/src/tools/handlers/unified_exec.rs:28"],
        ["n", "pub struct ExecCommandArgs {"],
        ["n", "    #[serde(default)]"],
        ["n", "    justification: Option<String>,"],
        ["n", "    #[serde(default)]"],
        ["n", "    prefix_rule: Option<Vec<String>>,"],
        ["a", "    /// Extra env vars for this command"],
        ["a", "    /// only. Not persisted."],
        ["a", "    #[serde(default)]"],
        ["a", "    env: Option<HashMap<String, String>>,"],
        ["n", "}"]
      ]},
      { f: "unified_exec/mod.rs · ExecCommandRequest", p: "+3", m: "", code: [
        ["c", "# core/src/unified_exec/mod.rs:92"],
        ["n", "pub struct ExecCommandRequest {"],
        ["n", "    pub sandbox_permissions:"],
        ["n", "        SandboxPermissions,"],
        ["n", "    pub justification: Option<String>,"],
        ["n", "    pub prefix_rule: Option<Vec<String>>,"],
        ["a", "    /// Per-command extra env vars."],
        ["a", "    pub extra_env:"],
        ["a", "        Option<HashMap<String, String>>,"],
        ["n", "}"]
      ]},
      { f: "unified_exec/exec_command.rs · handle_call", p: "+2", m: "", code: [
        ["c", "# unified_exec/exec_command.rs:180,280"],
        ["n", "let ExecCommandArgs {"],
        ["n", "    tty,"],
        ["n", "    yield_time_ms,"],
        ["n", "    max_output_tokens,"],
        ["n", "    justification,"],
        ["n", "    prefix_rule,"],
        ["a", "    env: extra_env,"],
        ["n", "    .."],
        ["n", "} = args;"],
        ["n", "ExecCommandRequest {"],
        ["n", "    justification,"],
        ["n", "    prefix_rule,"],
        ["a", "    extra_env,"],
        ["n", "},"]
      ]},
      { f: "unified_exec/process_manager.rs · spawn env", p: "+6", m: "", code: [
        ["c", "# unified_exec/process_manager.rs:1036"],
        ["n", "let mut env = local_policy_env.clone();"],
        ["n", "env.insert("],
        ["n", "    CODEX_THREAD_ID_ENV_VAR.to_string(),"],
        ["n", "    context.session.thread_id"],
        ["n", "        .to_string());"],
        ["a", "if let Some(extra) ="],
        ["a", "    request.extra_env.as_ref() {"],
        ["a", "    for (k, v) in extra {"],
        ["a", "        env.insert(k.clone(), v.clone());"],
        ["a", "    }"],
        ["a", "}"],
        ["n", "let env = apply_unified_exec_env(env);"]
      ]},
      { f: "handlers/shell_tests.rs · params \u00d72", p: "+2", m: "", code: [
        ["c", "# handlers/shell_tests.rs:90,152"],
        ["n", "let params = ShellCommandToolCallParams {"],
        ["n", "    command,"],
        ["n", "    workdir,"],
        ["n", "    login,"],
        ["n", "    timeout_ms,"],
        ["n", "    justification: None,"],
        ["a", "    env: None,"],
        ["n", "};"],
        ["c", "// same field added in the second"],
        ["c", "// to_exec_params test literal"]
      ]},
      { f: "spec & manager tests · mirrors \u00d73", p: "+3", m: "", code: [
        ["c", "# shell_spec_tests.rs:64,241"],
        ["c", "# process_manager_tests.rs:217"],
        ["n", "expected_properties.insert("],
        ["n", "    \"timeout_ms\", JsonSchema::number(\u2026));"],
        ["a", "expected_properties.insert("],
        ["a", "    \"env\", JsonSchema::object("],
        ["a", "      \u2026, additionalProperties: string,"],
        ["a", "      description: \"Extra environment"],
        ["a", "      variables\u2026\"));"],
        ["n", "ExecCommandRequest {"],
        ["n", "    prefix_rule: None,"],
        ["a", "    extra_env: None,"],
        ["n", "};"]
      ]}
    ];
    // five representative sites take the stage automatically, one by one;
    // site 0 remains as the final default diff after the walkthrough completes.
    const SHOW = { 0: 0, 1: 1, 3: 2, 5: 3, 7: 4 };
    const stripItems = [
      { t: tr("sui.flow.1", "① pose a behavior question"), c: "sd-a" },
      { t: "→", c: "sd-b", a: 1 },
      { t: tr("sui.flow.2", "② locate the behavior unit"), c: "sd-b" },
      { t: "→", c: "sd-c", a: 1 },
      { t: tr("sui.flow.3", "③ cross-check code evidence"), c: "sd-c" },
      { t: "→", c: "sd-d", a: 1 },
      { t: tr("sui.flow.4", "④ raise a change intent"), c: "sd-d" },
      { t: "→", c: "sd-s5", a: 1 },
      { t: tr("sui.flow.5", "⑤ handbook review & code sync"), c: "sd-s5" }
    ];
    const stripW = stripItems.map((it) => Math.round([...it.t].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? 11 : 6.4), 0)));
    const stripTotal = stripW.reduce((a, b) => a + b, 0) + (stripItems.length - 1) * 12;
    const sk = Math.min(1, 772 / stripTotal);
    let sx = Math.max(10, (800 - stripTotal * sk) / 2);
    const STRIP = stripItems.map((it, i) => {
      const cx = sx + (stripW[i] * sk) / 2; sx += (stripW[i] + 12) * sk;
      return `<g class="sd ${it.c}">${T(cx, 786, it.t, { size: 11.5 * sk, w: 600, fill: it.a ? FAINT : SOFT, anchor: "middle" })}</g>`;
    }).join("");
    // chip rows for the L1 stages and L2 units (widths handle CJK + Latin)
    const tw = (t, size) => Math.round([...t].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? size : size * 0.62), 0));
    const T3W = tw(tr("sui.fig.hbTitle", "Command execution & env vars"), 15) + 18;
    const rowY = (si) => 472 + si * 24;
    const showEntries = Object.entries(SHOW).map(([site, show]) => [Number(site), show]);
    const matchOverlay = (si, show) => {
      const y = rowY(si);
      const cy = y + 11;
      return `<g class="sd sd-site-match" data-show="${show}">
        <rect x="30" y="${y - 3}" width="370" height="28" rx="7" fill="color-mix(in srgb, ${BLUE} 10%, transparent)" stroke="${BLUE}" stroke-width="1.8"/>
        <path d="M402 ${cy} C 418 ${cy}, 416 463, 430 463" stroke="${BLUE}" stroke-width="1.4" fill="none" opacity=".55"/>
        <circle cx="402" cy="${cy}" r="2.4" fill="${BLUE}"/>
      </g>`;
    };
    // downward fan: exits the handbook, enters each site row from the right
    const fanArrow = (ox, oy, tx, ty) => {
      const my = (oy + ty) / 2;
      return `<path d="M${ox} ${oy} C ${ox} ${my}, ${tx + 22} ${ty}, ${tx + 9} ${ty}" stroke="${BLUE}" stroke-width="1.5" fill="none" opacity="0.4"/>` +
             `<polygon points="${tx + 10},${ty - 4.2} ${tx + 1},${ty} ${tx + 10},${ty + 4.2}" fill="${BLUE}" opacity="0.4"/>`;
    };
    // one detail card per site, hidden until its row is clicked
    // the detail pane lives BESIDE the code panel, never over it
    const detailCard = (s, si) => `
      <g class="sd-detail" data-detail="${si}"${SHOW[si] !== undefined ? ` data-show="${SHOW[si]}"` : ""} tabindex="0" role="button">
        <rect x="430" y="440" width="350" height="292" rx="10" fill="color-mix(in srgb, var(--code-bg) 84%, transparent)" stroke="color-mix(in srgb, ${BLUE} 45%, ${LINE})" stroke-width="1.2"/>
        ${T(444, 463, s.f, { size: 11, mono: true, w: 650, fill: SOFT })}
        ${s.m ? T(766, 463, s.m, { size: 11, mono: true, w: 650, fill: SIENI, anchor: "end" }) : ""}
        ${T(s.m ? 740 : 766, 463, s.p, { size: 11, mono: true, w: 650, fill: GOOD, anchor: "end" })}
        <path d="M430 473 H780" stroke="${LINES}" stroke-width="1"/>
        ${s.code.map((l, li) => {
          const y = 492 + li * 15;
          const wash = l[0] === "a" ? `<rect x="438" y="${y - 10.5}" width="334" height="14.6" rx="2" fill="${goodWash}"/>`
                     : l[0] === "d" ? `<rect x="438" y="${y - 10.5}" width="334" height="14.6" rx="2" fill="${sienWash}"/>` : "";
          const fill = l[0] === "a" ? GOOD : l[0] === "d" ? SIENI : MUT;
          const deco = l[0] === "d" ? ` text-decoration="line-through"` : "";
          const pfx = l[0] === "a" ? "+ " : l[0] === "d" ? "− " : "  ";
          return `${wash}<text x="444" y="${y}" font-size="11" font-family="${MONO}" fill="${fill}" xml:space="preserve"${deco}>${pfx}${l[1].replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`;
        }).join("")}
        ${T(605, 722, tr("sui.fig.close", "click to close"), { size: 10, italic: true, fill: FAINT, anchor: "middle" })}
      </g>`;

    return `
<svg viewBox="0 0 800 800" role="img" aria-label="${tr("sui.fig.aria", "One sentence to the handbook becomes a synchronized change across 14 sites in 10 files")}">
  ${overline(88, 44, tr("sui.fig.olA", "USER"), SIENI)}
  ${overline(357, 44, tr("sui.fig.olB", "HANDBOOK STUDIO"), BLUEI)}
  ${overline(666, 44, tr("sui.fig.olE", "HANDBOOK DIFF"), GRA)}
  <!-- the hard-code world: fenced off — the user never edits inside it -->
  <g class="fx" style="--d:.3s">
    <rect x="14" y="412" width="776" height="346" rx="14" fill="none" stroke="color-mix(in srgb, ${SIEN} 70%, ${LINE})" stroke-width="1.8" stroke-dasharray="8 6"/>
    <rect x="228" y="750" width="344" height="17" fill="var(--bg)"/>
    ${T(400, 762, tr("sui.fig.isol", "implementation layer · auto-synced, not edited directly"), { size: 10.5, italic: true, w: 600, fill: SIENI, anchor: "middle" })}
  </g>
  <g class="fx" style="--d:.35s">
    ${overline(215, 424, tr("sui.fig.olC", "SOURCE CODE"), GRA)}
    <rect x="20" y="440" width="390" height="292" rx="12" fill="none" stroke="${LINES}" stroke-width="1.4" stroke-dasharray="6 5"/>
    ${T(215, 576, tr("sui.fig.cpHint", "once the unit is located —"), { size: 13, italic: true, fill: FAINT, anchor: "middle" })}
    ${T(215, 596, tr("sui.fig.cpHint2", "its 14 code sites are listed here"), { size: 13, italic: true, fill: FAINT, anchor: "middle" })}
  </g>
  <!-- diff-pane placeholder: static frame, cards paint over it -->
  <g class="fx" style="--d:.4s">
    ${overline(605, 424, tr("sui.fig.olD", "SOURCE DIFF"), GRA)}
    <rect x="430" y="440" width="350" height="292" rx="10" fill="none" stroke="${LINES}" stroke-width="1.4" stroke-dasharray="6 5"/>
    ${T(605, 576, tr("sui.fig.dzHint", "click a site on the left —"), { size: 13, italic: true, fill: FAINT, anchor: "middle" })}
    ${T(605, 596, tr("sui.fig.dzHint2", "its source diff opens here"), { size: 13, italic: true, fill: FAINT, anchor: "middle" })}
  </g>

  <!-- user -->
  <g class="fx">
    <circle cx="88" cy="94" r="17" fill="${SIENW}" stroke="color-mix(in srgb, ${SIEN} 34%, ${LINE})"/>
    <circle cx="88" cy="88.5" r="5" fill="${SIENI}"/>
    <path d="M78 103.5 a10 6.5 0 0 1 20 0 Z" fill="${SIENI}"/>
  </g>
  <!-- ① the request: one plain sentence (real case Codex · CF11) -->
  <g class="sd sd-a">
    <rect x="12" y="132" width="152" height="92" rx="10" fill="${SIENW}" stroke="color-mix(in srgb, ${SIEN} 34%, ${LINE})"/>
    <polygon points="80,132 88,120 96,132" fill="${SIENW}"/>
    ${T(88, 152, tr("sui.fig.q1", "“Could this backtest"), { size: 11, italic: true, anchor: "middle", fill: SOFT })}
    ${T(88, 170, tr("sui.fig.q2", "command carry a data token"), { size: 11, italic: true, anchor: "middle", fill: SOFT })}
    ${T(88, 188, tr("sui.fig.q3", "and date-range variables"), { size: 11, italic: true, anchor: "middle", fill: SOFT })}
    ${T(88, 206, tr("sui.fig.q4", "for this run only?”"), { size: 11, italic: true, anchor: "middle", fill: SOFT })}
  </g>
  <g class="sd sd-a">${harrow(168, 182, 170, SIEN)}</g>

  <!-- handbook panel: the FULL three-level handbook, L1 → L2 → L3 -->
  <g class="fx" style="--d:.15s">
    <rect x="182" y="64" width="350" height="316" rx="12" fill="${SURF}" stroke="${LINE}"/>
    ${T(198, 90, tr("sui.fig.hbName", "Codex Handbook"), { size: 16, w: 700, fill: INK })}
    <path d="M182 102 H532" stroke="${LINES}" stroke-width="1"/>

    <rect x="198" y="112" width="26" height="16" rx="5" fill="${BLUEW}"/>
    ${T(211, 123.5, "L3", { size: 9.5, w: 700, fill: BLUEI, anchor: "middle" })}
    ${T(232, 124, tr("sui.fig.l3", "Unit detail"), { size: 10, w: 600, fill: MUT })}
    ${T(516, 124, tr("sui.fig.path", "L1 tool execution & guards → L2 backends & sandbox"), { size: 9.5, fill: MUT, anchor: "end" })}
    ${T(202, 152, tr("sui.fig.hbTitle", "Command execution & env vars"), { size: 15, w: 650, fill: INK })}
    ${T(202, 178, tr("sui.fig.pl1", "Each time the agent runs a command, a"), { size: 11.2, fill: SOFT })}
    ${T(202, 197, tr("sui.fig.pl2", "fresh environment is prepared — keys, paths."), { size: 11.2, fill: SOFT })}
    ${T(202, 222, tr("sui.fig.pl3", "It is built from one global policy, the same"), { size: 11.2, fill: SOFT })}
    ${T(202, 241, tr("sui.fig.pl4", "for every command; discarded right after."), { size: 11.2, fill: SOFT })}
    ${T(202, 266, tr("sui.fig.pl5", "Approval and sandbox policy still gate the"), { size: 11.2, fill: SOFT })}
    ${T(202, 285, tr("sui.fig.pl6", "run — env vars never bypass those checks."), { size: 11.2, fill: SOFT })}
    ${T(202, 331, tr("sui.fig.l.fields", "COMMAND FIELDS"), { size: 10.2, w: 650, fill: FAINT })}
    ${T(264, 331, "command · workdir · timeout_ms …", { size: 10.5, mono: true, fill: SOFT })}
    ${T(202, 352, tr("sui.fig.ev", "EVIDENCE"), { size: 10.2, w: 650, fill: FAINT })}
    ${T(264, 352, tr("sui.fig.evVal", "10 files · 14 implementation sites"), { size: 10.8, fill: MUT })}
  </g>
  <!-- the line the handbook currently states — struck through when the diff lands at ④ -->
  <g class="sd-orig" pointer-events="none">
    ${T(202, 306, tr("sui.fig.p3", "A command cannot specify its own environment variables."), { size: 11.2, fill: SOFT })}
  </g>
  <!-- level-detail pane: L1/L2/L3 open here, beside the handbook -->
  <g class="fx" style="--d:.3s">
    <rect x="544" y="64" width="244" height="316" rx="10" fill="none" stroke="${LINES}" stroke-width="1.4" stroke-dasharray="6 5"/>
    ${T(666, 210, tr("sui.fig.dfHint", "after ④ raise a change intent —"), { size: 11.5, italic: true, fill: FAINT, anchor: "middle" })}
    ${T(666, 228, tr("sui.fig.dfHint2", "the handbook diff opens here"), { size: 12, italic: true, fill: FAINT, anchor: "middle" })}
  </g>
  <!-- ② locate: the unit title lights up in the handbook page -->
  <g class="sd sd-l3" pointer-events="none">
    <rect x="196" y="137" width="${T3W}" height="23" rx="7" fill="color-mix(in srgb, ${BLUE} 8%, transparent)" stroke="${BLUE}" stroke-width="1.2"/>
  </g>
  <!-- ④ the change intent: the old line is struck in place; the handbook diff opens in the right pane -->
  <g class="sd sd-d" pointer-events="none">
    <rect x="196" y="294" width="330" height="17" rx="4" fill="${sienWash}"/>
    <text x="202" y="306" font-size="11.2" fill="${SIENI}" text-decoration="line-through">${tr("sui.fig.p3", "A command cannot specify its own environment variables.")}</text>
  </g>
  <g class="sd sd-d">
    <rect x="544" y="64" width="244" height="316" rx="10" fill="color-mix(in srgb, var(--code-bg) 84%, transparent)" stroke="color-mix(in srgb, ${BLUE} 45%, ${LINE})" stroke-width="1.2"/>
    ${T(556, 90, tr("sui.fig.dfTitle", "stage-14.2 · exec & environment"), { size: 10.5, mono: true, w: 600, fill: SOFT })}
    <path d="M544 102 H788" stroke="${LINES}" stroke-width="1"/>
    ${T(556, 126, tr("sui.fig.dfc1", "Each time the agent runs a"), { size: 11, mono: true, fill: MUT })}
    ${T(556, 142, tr("sui.fig.dfc2", "command, a fresh environment"), { size: 11, mono: true, fill: MUT })}
    ${T(556, 158, tr("sui.fig.dfc3", "is prepared — keys, paths."), { size: 11, mono: true, fill: MUT })}
    ${T(556, 182, tr("sui.fig.dfc4", "It is built from one global"), { size: 11, mono: true, fill: MUT })}
    ${T(556, 198, tr("sui.fig.dfc5", "policy, the same for every"), { size: 11, mono: true, fill: MUT })}
    ${T(556, 214, tr("sui.fig.dfc6", "command; discarded right after."), { size: 11, mono: true, fill: MUT })}
    ${T(556, 238, tr("sui.fig.dfc7", "Approval and sandbox policy"), { size: 11, mono: true, fill: MUT })}
    ${T(556, 254, tr("sui.fig.dfc8", "still gate the run — env vars"), { size: 11, mono: true, fill: MUT })}
    ${T(556, 270, tr("sui.fig.dfc9", "never bypass those checks."), { size: 11, mono: true, fill: MUT })}
    <rect x="550" y="277" width="232" height="15" rx="3" fill="${sienWash}"/>
    <text x="556" y="288" font-size="10" font-family="${MONO}" font-weight="600" fill="${SIENI}" text-decoration="line-through">${tr("sui.fig.del1", "− A command cannot specify its own env vars.")}</text>
    <rect x="550" y="294" width="232" height="15" rx="3" fill="${goodWash}"/>
    ${T(556, 305, tr("sui.fig.add1", "+ env: a command’s own vars"), { size: 11, mono: true, w: 600, fill: GOOD })}
    <rect x="550" y="310.5" width="232" height="15" rx="3" fill="${goodWash}"/>
    ${T(556, 321.5, tr("sui.fig.add2", "+ e.g. data token, date range"), { size: 11, mono: true, w: 600, fill: GOOD })}
    <rect x="550" y="327" width="232" height="15" rx="3" fill="${goodWash}"/>
    ${T(556, 338, tr("sui.fig.add3", "+ scoped to this command only"), { size: 11, mono: true, w: 600, fill: GOOD })}
    <rect x="550" y="343.5" width="232" height="15" rx="3" fill="${goodWash}"/>
    ${T(556, 354.5, tr("sui.fig.add4", "+ new field: env (optional map)"), { size: 11, mono: true, w: 600, fill: GOOD })}
    ${T(666, 372, tr("sui.fig.dfFoot", "confirm → synchronize 14 code sites"), { size: 10, italic: true, fill: FAINT, anchor: "middle" })}
  </g>
  <!-- ⑤ review & confirm (card action, top right) -->
  <g class="sd sd-e">
    <rect x="408" y="74" width="116" height="28" rx="8" fill="${BLUEW}" stroke="color-mix(in srgb, ${BLUE} 40%, ${LINE})"/>
    ${T(466, 92.5, tr("sui.fig.confirm", "Review & confirm"), { size: 12.5, w: 650, fill: BLUEI, anchor: "middle" })}
  </g>
  <rect class="sd-ring" x="402" y="68" width="128" height="40" rx="12" fill="none" stroke="${BLUE}" stroke-width="2"/>

  <!-- write after review: the one-field diff fans out to ten sites -->
  <g class="sd sd-f">
    ${SITES.map((s, si) => fanArrow(450, 384, 412, rowY(si) + 11)).join("")}
    ${T(605, 437, tr("sui.fig.apply", "apply after review"), { size: 11, w: 600, fill: BLUEI, anchor: "middle" })}
  </g>

  <!-- code panel: enters after the level details, at the evidence beat -->
  <g class="sd sd-code">
    <rect x="20" y="440" width="390" height="292" rx="12" fill="var(--code-bg)" stroke="${LINE}"/>
    ${T(34, 462, tr("sui.fig.sites", "10 files · 14 implementation sites"), { size: 11.5, mono: true, w: 600, fill: FAINT })}
    ${T(215, 724, tr("sui.fig.clickHint", "click a site to see its source & diff"), { size: 12.5, italic: true, fill: FAINT, anchor: "middle" })}
  </g>
  ${SITES.map((s, si) => `
  <g class="sd sd-code site-row" data-site="${si}" tabindex="0" role="button" aria-label="${s.f}">
    <rect class="site-bg" x="34" y="${rowY(si)}" width="362" height="22" rx="5" fill="${SURF}" stroke="${LINE}"/>
    ${T(44, rowY(si) + 15.5, s.f, { size: 10.8, mono: true, fill: MUT })}
  </g>`).join("")}
  ${showEntries.map(([si, show]) => matchOverlay(si, show)).join("")}
  <!-- every site updates itself, in waves (overlays don't block clicks) -->
  ${SITES.map((s, si) => `
  <g class="sd ${si < 3 ? "sd-g" : si < 7 ? "sd-h" : "sd-i"}" pointer-events="none">
    <rect x="34" y="${rowY(si)}" width="362" height="22" rx="5" fill="${siteWash}" stroke="${siteStroke}"/>
    ${T(44, rowY(si) + 15.5, s.f, { size: 10.8, mono: true, fill: SOFT })}
    ${s.m ? T(386, rowY(si) + 15.5, s.m, { size: 10.8, mono: true, w: 650, fill: SIENI, anchor: "end" }) : ""}
    ${T(s.m ? 362 : 386, rowY(si) + 15.5, s.p, { size: 10.8, mono: true, w: 650, fill: GOOD, anchor: "end" })}
  </g>`).join("")}
  <g class="sd sd-j">
    <rect x="272" y="446" width="124" height="21" rx="10.5" fill="${goodWash}" stroke="color-mix(in srgb, ${GOOD} 32%, transparent)"/>
    ${T(334, 460.5, tr("sui.fig.synced", "14 sites synced ✓"), { size: 10.5, w: 700, fill: GOOD, anchor: "middle" })}
    ${T(357, 406, tr("sui.fig.simple", "behavior intent → field-level diff"), { size: 13, w: 650, fill: BLUEI, anchor: "middle" })}
    ${T(215, 748, tr("sui.fig.complex", "14 code updates synced"), { size: 13, w: 650, fill: GOOD, anchor: "middle" })}
  </g>
  <!-- detail cards: sites AND handbook levels share the detail stage -->
  ${SITES.map((s, si) => detailCard(s, si)).join("")}

  <!-- the section's five steps, lighting up as the story advances -->
  ${STRIP}
</svg>`;
  }

  function renderIllustrations() {
    const put = (id, svg) => {
      const el = $(id);
      if (el) { el.removeAttribute("data-active"); el.classList.remove("has-open"); el.innerHTML = svg; }
    };
    put("#hero-illustration", heroSVG());
    put("#scatter-illustration", treeSVG());
    put("#levels-illustration", levelsSVG());
    put("#pipeline-illustration", pipelineSVG());
    put("#bgpd-illustration", bgpdSVG());
    put("#studio-illustration", studioSVG());
  }
  renderIllustrations();

  /* staged entrance: play each figure's FX the first time it scrolls into view */
  const fxObs = new IntersectionObserver((es) => {
    es.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("is-anim"); fxObs.unobserve(e.target); }
    });
  }, { threshold: 0.15 });

  /* click-to-focus: spotlight a [data-pick] group, dim the rest (delegated,
     so it survives language-change re-renders) */
  $$(".illustration").forEach((el) => {
    fxObs.observe(el);
    el.addEventListener("click", (ev) => {
      // site detail cards (studio figure): open on row click, close on card click
      const det = ev.target.closest("[data-detail]");
      if (det && el.contains(det)) {
        det.classList.remove("is-open");
        if (!el.querySelector(".sd-detail.is-open")) {
          el.classList.remove("has-open");
          $$(".site-row.is-selected", el).forEach((x) => x.classList.remove("is-selected"));
        }
        return;
      }
      const site = ev.target.closest("[data-site]");
      if (site && el.contains(site)) {
        const id = site.getAttribute("data-site");
        $$("[data-detail]", el).forEach((d) => {
          d.classList.toggle("is-open", d.getAttribute("data-detail") === id);
        });
        $$("[data-site]", el).forEach((x) => {
          x.classList.toggle("is-selected", x.getAttribute("data-site") === id);
        });
        el.classList.add("has-open");
        return;
      }
      const g = ev.target.closest("[data-pick]");
      if (!g || !el.contains(g)) return;
      const was = g.classList.contains("is-picked");
      $$("[data-pick]", el).forEach((x) => x.classList.remove("is-picked"));
      if (was) el.removeAttribute("data-active");
      else { g.classList.add("is-picked"); el.setAttribute("data-active", ""); }
    });
    el.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      const g = ev.target.closest?.("[data-pick], [data-site], [data-detail]");
      if (!g) return;
      ev.preventDefault();
      g.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  });

  /* shared chart tooltip (values are also direct-labeled; this adds series identity) */
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  const tipVal = document.createElement("div");
  tipVal.className = "chart-tip__val";
  const tipLbl = document.createElement("div");
  tip.append(tipVal, tipLbl);
  document.body.appendChild(tip);
  function tipMove(ev) {
    const pad = 14, r = tip.getBoundingClientRect();
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
    if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - pad;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  }
  function bindTips(root) {
    $$(".hit", root).forEach((h) => {
      h.addEventListener("pointerenter", () => {
        tipVal.textContent = h.dataset.tipVal || "";
        tipLbl.textContent = h.dataset.tipLbl || "";
        tip.classList.add("is-on");
      });
      h.addEventListener("pointermove", tipMove);
      h.addEventListener("pointerleave", () => tip.classList.remove("is-on"));
    });
  }

  /* ===================== 5. CHARTS ===================== */
  const C_HB = "var(--c-handbook)";
  const C_BL = "var(--c-baseline)";

  // bar with 4px rounded data-end, square baseline
  function barPath(x, yTop, w, h, r = 4) {
    if (h <= 0) return "";
    const rr = Math.min(r, h, w / 2);
    const yBase = yTop + h;
    return `M${x} ${yBase} L${x} ${yTop + rr} Q${x} ${yTop} ${x + rr} ${yTop} L${x + w - rr} ${yTop} Q${x + w} ${yTop} ${x + w} ${yTop + rr} L${x + w} ${yBase} Z`;
  }

  // grouped vertical bars: baseline (gray) vs handbook (blue)
  function groupedBars(el, cfg) {
    if (!el) return;
    const W = cfg.W || 440, H = cfg.H || 240;
    // padT reserves headroom for the group delta badge so it never collides with value labels
    const padL = 40, padR = 6, padT = cfg.padT || 44, padB = 30;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const max = cfg.max, min = cfg.min || 0;
    const y = (v) => padT + plotH - ((v - min) / (max - min)) * plotH;
    const fmt = cfg.fmt || ((v) => v.toFixed(1));
    const tickFmt = cfg.tickFmt || fmt;

    let grid = "";
    cfg.ticks.forEach((v) => {
      const yy = y(v);
      grid += `<line class="grid-line" x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}"/>` +
        `<text class="tick-label" x="${padL - 7}" y="${yy + 3.5}" text-anchor="end" font-size="10.5" style="font-variant-numeric:tabular-nums">${tickFmt(v)}</text>`;
    });

    const n = cfg.groups.length;
    const groupW = plotW / n;
    const barW = Math.min(30, groupW * 0.24), gap = 8;
    const nameBL = tr("legend.baseline", "Baseline");
    const nameHB = tr("legend.handbook", "With handbook");
    let bars = "";
    cfg.groups.forEach((g, i) => {
      const cx = padL + groupW * i + groupW / 2;
      const bx = cx - barW - gap / 2, hx = cx + gap / 2;
      const yb = y(g.baseline), yh = y(g.handbook);
      // hover hit target is the full column above each bar, wider than the mark
      const mark = (xPos, v, yTop, fill, name, k, lblSize, lblW, lblFill) => {
        const d = (i * 2 + k) * 70;
        return `
        <g class="hit" data-tip-val="${fmt(v)}" data-tip-lbl="${name} · ${g.label}">
          <rect x="${xPos - 4}" y="${padT}" width="${barW + 8}" height="${plotH}" fill="transparent"/>
          <path class="bar" style="--d:${d}ms" d="${barPath(xPos, yTop, barW, padT + plotH - yTop)}" fill="${fill}"/>
          <text class="val-label fade-label" style="--d:${d}ms" x="${xPos + barW / 2}" y="${yTop - 6}" text-anchor="middle" font-size="${lblSize}" font-weight="${lblW}"${lblFill ? ` fill="${lblFill}"` : ""}>${fmt(v)}</text>
        </g>`;
      };
      // delta badge: centered over the pair, above the taller bar, clear of value labels
      const gapV = g.handbook - g.baseline;
      const improved = cfg.lowerBetter ? gapV < 0 : gapV > 0;
      const c = improved ? "var(--c-good)" : "var(--muted)";
      const txt = cfg.deltaPct
        ? `${gapV > 0 ? "▲" : "▼"} ${(Math.abs(gapV) / g.baseline * 100).toFixed(0)}%`
        : `${gapV > 0 ? "▲" : "▼"} ${fmt(Math.abs(gapV))}`;
      const bw = txt.length * 6.4 + 16;
      const yTopPair = Math.min(yb, yh);
      const badge = `
        <g class="delta-label" style="--d:${(i * 2 + 1) * 70}ms">
          <rect x="${cx - bw / 2}" y="${yTopPair - 41}" width="${bw}" height="19" rx="9.5" fill="color-mix(in srgb, ${c} 13%, transparent)" stroke="color-mix(in srgb, ${c} 34%, transparent)" stroke-width="1"/>
          <text x="${cx}" y="${yTopPair - 27.5}" text-anchor="middle" font-size="10.5" font-weight="700" fill="${c}">${txt}</text>
        </g>`;
      bars += mark(bx, g.baseline, yb, C_BL, nameBL, 0, 11, 500, "var(--muted)")
            + mark(hx, g.handbook, yh, `url(#hbgrad-${el.id})`, nameHB, 1, 11.5, 650, "")
            + badge
            + `<text class="grp-label" x="${cx}" y="${H - 8}" text-anchor="middle" font-size="12" font-weight="550">${g.label}</text>`;
    });

    // truncated axis: mark the break so the non-zero start is explicit
    const axisBreak = min > 0 ? `
      <line class="axis-line" x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}"/>
      <g stroke="var(--muted)" stroke-width="1.4" fill="none">
        <path d="M${padL - 5} ${padT + plotH - 9} l10 -4"/>
        <path d="M${padL - 5} ${padT + plotH - 4} l10 -4"/>
      </g>` : "";

    el.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" role="img">
        <defs>
          <linearGradient id="hbgrad-${el.id}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="color-mix(in srgb, var(--c-handbook) 74%, var(--surface))"/>
            <stop offset="1" stop-color="var(--c-handbook)"/>
          </linearGradient>
        </defs>
        ${grid}
        <line class="axis-line" x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}"/>
        ${axisBreak}
        ${bars}
      </svg>`;
    bindTips(el);
  }

  // dumbbell: baseline → handbook per judge, faceted by harness
  function dumbbell(el, cfg) {
    if (!el) return;
    const W = 860, rowH = 30, headH = 26, gapH = 18;
    const x0 = 150, x1 = 828;
    const max = cfg.max, min = cfg.min || 0;
    const x = (v) => x0 + ((v - min) / (max - min)) * (x1 - x0);

    let y = 34;
    let body = "";
    const rowYs = [];
    let ri = 0;
    cfg.facets.forEach((f) => {
      body += `<text x="${x0 - 132}" y="${y}" font-size="12.5" font-weight="650" fill="var(--ink)">${f.label}</text>`;
      y += headH - 12;
      f.rows.forEach((r) => {
        y += rowH;
        rowYs.push(y - 10);
        const xb = x(r.baseline), xh = x(r.handbook);
        const cy = y - 10;
        body += `
          <g class="db-row hit" style="--d:${ri * 90}ms"
             data-tip-val="${r.baseline.toFixed(1)} → ${r.handbook.toFixed(1)}"
             data-tip-lbl="${f.label} · ${r.label}">
          <rect x="${x0 - 140}" y="${cy - 13}" width="${x1 - x0 + 160}" height="26" fill="transparent"/>
          <text x="${x0 - 14}" y="${cy + 4}" text-anchor="end" font-size="12" fill="var(--muted)">${r.label}</text>
          <line class="db-line" x1="${xb}" y1="${cy}" x2="${xh}" y2="${cy}" stroke="${C_HB}" stroke-width="3" stroke-linecap="round" opacity="0.35"/>
          ${xh - xb > 26 ? `<path class="db-dot" d="M${xh - 17} ${cy - 4.5} L${xh - 9.5} ${cy} L${xh - 17} ${cy + 4.5} Z" fill="${C_HB}" opacity="0.55" style="--d:${ri * 90}ms"/>` : ""}
          <circle cx="${xb}" cy="${cy}" r="6" fill="${C_BL}" stroke="var(--surface)" stroke-width="2"/>
          <circle class="db-dot" cx="${xh}" cy="${cy}" r="6" fill="${C_HB}" stroke="var(--surface)" stroke-width="2"/>
          <text class="fade-label" x="${xb - 13}" y="${cy + 4}" text-anchor="end" font-size="10.5" fill="var(--muted)" style="font-variant-numeric:tabular-nums;--d:${ri * 90}ms">${r.baseline.toFixed(1)}</text>
          <text class="db-dot" x="${xh + 13}" y="${cy + 4}" font-size="11" font-weight="650" fill="var(--ink-soft)" style="font-variant-numeric:tabular-nums;--d:${ri * 90}ms">${r.handbook.toFixed(1)}</text>
          </g>`;
        ri++;
      });
      y += gapH;
    });
    const axisY = y + 2;

    let grid = "";
    cfg.ticks.forEach((v) => {
      grid += `<line class="grid-line" x1="${x(v)}" y1="24" x2="${x(v)}" y2="${axisY}"/>` +
        `<text class="tick-label" x="${x(v)}" y="${axisY + 16}" text-anchor="middle" font-size="10.5" style="font-variant-numeric:tabular-nums">${v}</text>`;
    });

    const legend = `
      <circle cx="${x1 - 208}" cy="14" r="5.5" fill="${C_BL}"/>
      <text x="${x1 - 198}" y="18" font-size="11.5" fill="var(--muted)">${tr("legend.baseline", "Baseline")}</text>
      <circle cx="${x1 - 108}" cy="14" r="5.5" fill="${C_HB}"/>
      <text x="${x1 - 98}" y="18" font-size="11.5" fill="var(--muted)">${tr("legend.handbook", "With handbook")}</text>`;

    const axisBreak = min > 0 ? `
      <g stroke="var(--muted)" stroke-width="1.4" fill="none">
        <path d="M${x0 + 8} ${axisY - 5} l-4 10"/>
        <path d="M${x0 + 13} ${axisY - 5} l-4 10"/>
      </g>` : "";

    el.innerHTML = `
      <svg viewBox="0 0 ${W} ${axisY + 26}" role="img">
        ${grid}
        <line class="axis-line" x1="${x0}" y1="${axisY}" x2="${x1}" y2="${axisY}"/>
        ${axisBreak}
        ${legend}
        ${body}
      </svg>`;
    bindTips(el);
  }

  // render a chart when it first becomes visible
  function whenVisible(el, fn) {
    if (!el) return;
    const o = new IntersectionObserver((es) => {
      es.forEach((e) => { if (e.isIntersecting) { fn(); o.disconnect(); } });
    }, { threshold: 0.12 });
    o.observe(el);
  }

  /* ---- data (paper Figures 3–5, Table 1) ---- */
  const WIN = [
    { label: "Codex",    baseline: 28.3, handbook: 38.3 },
    { label: "Terminus", baseline: 26.7, handbook: 45.6 }
  ];
  const TOKENS = [
    { label: "Codex",    baseline: 0.102, handbook: 0.089 },
    { label: "Terminus", baseline: 0.058, handbook: 0.053 }
  ];
  const JUDGES = {
    facets: [
      { label: "Codex", rows: [
        { label: "GPT-5.5",  baseline: 26.7, handbook: 36.7 },
        { label: "Opus 4.8", baseline: 30.0, handbook: 40.0 },
        { label: "DeepSeek", baseline: 30.0, handbook: 40.0 }
      ]},
      { label: "Terminus", rows: [
        { label: "GPT-5.5",  baseline: 36.7, handbook: 50.0 },
        { label: "Opus 4.8", baseline: 23.3, handbook: 50.0 },
        { label: "DeepSeek", baseline: 20.0, handbook: 36.7 }
      ]}
    ],
    min: 15, max: 55, ticks: [20, 30, 40, 50]
  };
  const SCENARIO = {
    Codex: {
      pattern: [
        { key: "sc.q",  baseline: 16.7, handbook: 43.4 },
        { key: "sc.cf", baseline: 36.7, handbook: 53.0 },
        { key: "sc.sh", baseline: 20.0, handbook: 36.7 }
      ],
      difficulty: [
        { key: "sc.easy",   baseline: 16.7, handbook: 50.0 },
        { key: "sc.medium", baseline: 28.0, handbook: 33.4 },
        { key: "sc.hard",   baseline: 33.3, handbook: 44.5 }
      ]
    },
    Terminus: {
      pattern: [
        { key: "sc.q",  baseline: 30.0, handbook: 33.3 },
        { key: "sc.cf", baseline: 26.7, handbook: 46.7 },
        { key: "sc.sh", baseline: 23.3, handbook: 56.6 }
      ],
      difficulty: [
        { key: "sc.easy",   baseline: 28.5, handbook: 35.0 },
        { key: "sc.medium", baseline: 28.0, handbook: 46.0 },
        { key: "sc.hard",   baseline: 40.8, handbook: 44.5 }
      ]
    }
  };
  const SC_LABELS = {
    "sc.q":     ["sc.q",     "Q · local change"],
    "sc.cf":    ["sc.cf",    "CF · cross-file"],
    "sc.sh":    ["sc.sh",    "SH · search-hostile"],
    "sc.easy":  ["sc.easy",  "Easy"],
    "sc.medium":["sc.medium","Medium"],
    "sc.hard":  ["sc.hard",  "Hard"]
  };

  function renderResult1() {
    groupedBars($("#chart-winrate"), {
      groups: WIN, min: 20, max: 50, ticks: [20, 30, 40, 50],
      fmt: (v) => v.toFixed(1), tickFmt: (v) => String(v)
    });
    groupedBars($("#chart-tokens"), {
      groups: TOKENS, min: 0.05, max: 0.11, ticks: [0.05, 0.07, 0.09, 0.11],
      lowerBetter: true, deltaPct: true,
      fmt: (v) => v.toFixed(3), tickFmt: (v) => v.toFixed(2)
    });
  }
  function renderJudges() { dumbbell($("#chart-judges"), JUDGES); }

  function renderScenario() {
    const h = $("#scenario-harness .is-active")?.dataset.harness || "Codex";
    const v = $("#scenario-view .is-active")?.dataset.sview || "pattern";
    const groups = SCENARIO[h][v].map((g) => ({
      label: tr(SC_LABELS[g.key][0], SC_LABELS[g.key][1]),
      baseline: g.baseline, handbook: g.handbook
    }));
    groupedBars($("#chart-scenario"), {
      groups, min: 10, max: 60, ticks: [10, 20, 30, 40, 50, 60],
      W: 720, H: 256, fmt: (v) => v.toFixed(1), tickFmt: (v) => String(v)
    });
  }

  whenVisible($("#chart-winrate"), renderResult1);
  whenVisible($("#chart-judges"), renderJudges);
  whenVisible($("#chart-scenario"), renderScenario);

  $$("#scenario-harness .seg__btn, #scenario-view .seg__btn").forEach((b) =>
    b.addEventListener("click", () => {
      const parent = b.parentElement;
      $$(".seg__btn", parent).forEach((x) => x.classList.remove("is-active"));
      b.classList.add("is-active");
      renderScenario();
    })
  );

  /* ---- localization table (Table 1) ---- */
  const LOC_KEYS = {
    opus: {
      label: "Opus 4.8",
      rows: [
        ["Codex", "File",   "Recall",    55.4, 69.7, false],
        ["Codex", "File",   "Precision", 46.1, 60.2, false],
        ["Codex", "File",   "F1",        46.6, 61.8, false],
        ["Codex", "File",   "Wrong",     37.0, 14.8, true],
        ["Codex", "Symbol", "Recall",    47.1, 65.4, false],
        ["Codex", "Symbol", "Precision", 38.0, 55.3, false],
        ["Codex", "Symbol", "F1",        38.3, 57.1, false],
        ["Codex", "Symbol", "Wrong",     44.4, 18.5, true],
        ["Terminus", "File",   "Recall",    74.7, 83.9, false],
        ["Terminus", "File",   "Precision", 74.1, 86.2, false],
        ["Terminus", "File",   "F1",        74.1, 84.7, false],
        ["Terminus", "File",   "Wrong",     24.1, 13.8, true],
        ["Terminus", "Symbol", "Recall",    64.7, 76.3, false],
        ["Terminus", "Symbol", "Precision", 65.1, 78.4, false],
        ["Terminus", "Symbol", "F1",        64.8, 77.1, false],
        ["Terminus", "Symbol", "Wrong",     24.1, 13.8, true]
      ]
    },
    gpt: {
      label: "GPT-5.5",
      rows: [
        ["Codex", "File",   "Recall",    49.4, 49.8, false],
        ["Codex", "File",   "Precision", 53.0, 62.2, false],
        ["Codex", "File",   "F1",        47.3, 52.3, false],
        ["Codex", "File",   "Wrong",     21.4, 21.4, true],
        ["Codex", "Symbol", "Recall",    46.4, 49.1, false],
        ["Codex", "Symbol", "Precision", 48.4, 60.4, false],
        ["Codex", "Symbol", "F1",        43.8, 51.2, false],
        ["Codex", "Symbol", "Wrong",     28.6, 21.4, true],
        ["Terminus", "File",   "Recall",    76.1, 87.5, false],
        ["Terminus", "File",   "Precision", 78.3, 93.3, false],
        ["Terminus", "File",   "F1",        76.5, 89.3, false],
        ["Terminus", "File",   "Wrong",     20.0, 6.7, true],
        ["Terminus", "Symbol", "Recall",    73.0, 87.5, false],
        ["Terminus", "Symbol", "Precision", 73.9, 93.3, false],
        ["Terminus", "Symbol", "F1",        73.0, 89.3, false],
        ["Terminus", "Symbol", "Wrong",     20.0, 6.7, true]
      ]
    }
  };

  const locBar = (v, cls, d) => `
    <div class="loc-bar">
      <div class="loc-bar__track"></div>
      <div class="loc-bar__fill ${cls}" style="width:${v}%;--d:${d}ms"></div>
      <span class="loc-bar__val">${v.toFixed(1)}</span>
    </div>`;

  function trMetric(m) {
    const map = { Recall: "loc.m.recall", Precision: "loc.m.precision", F1: "loc.m.f1", Wrong: "loc.m.wrong" };
    return tr(map[m] || m, m);
  }
  function trLevel(l) {
    return tr(l === "File" ? "loc.l.file" : "loc.l.symbol", l);
  }

  function renderLocTable(key) {
    const tb = $("#loc-tbody");
    const cap = $("#loc-cap");
    const cfg = LOC_KEYS[key];
    if (!tb || !cfg) return;
    let prevH = "", prevL = "";
    tb.innerHTML = cfg.rows.map((r, idx) => {
      const [h, lvl, metric, bl, hb, lowerBetter] = r;
      const rawGap = hb - bl;
      const improved = lowerBetter ? rawGap < 0 : rawGap > 0;
      const gapTxt = (rawGap > 0 ? "+" : "") + rawGap.toFixed(1);
      const showH = h !== prevH; const showL = (h !== prevH || lvl !== prevL);
      const sep = (idx > 0 && lvl !== prevL) ? " class=\"row-sep\"" : "";
      prevH = h; prevL = lvl;
      return `<tr${sep}>
        <td class="cell-harness">${showH ? h : ""}</td>
        <td class="cell-level">${showL ? trLevel(lvl) : ""}</td>
        <td class="cell-metric">${trMetric(metric)}${lowerBetter ? " ↓" : ""}</td>
        <td>${locBar(bl, "loc-bar__fill--bl", idx * 26)}</td>
        <td>${locBar(hb, "loc-bar__fill--hb", idx * 26 + 60)}</td>
        <td class="num ${improved ? "gap-pos" : "gap-neg"}">${gapTxt}</td>
      </tr>`;
    }).join("");
    if (cap) {
      const label = tr(key === "opus" ? "seg.opus.short" : "seg.gpt.short", cfg.label);
      cap.innerHTML = tr(
        "loc.cap",
        "<b>Localization scores against the reference plan</b> ({label} reference). For <b>Wrong</b>, lower is better."
      ).replace("{label}", label);
    }
  }

  whenVisible($("#loc-table"), () => renderLocTable($("#loc-key-view .is-active")?.dataset.key || "opus"));
  $$("#loc-key-view .seg__btn").forEach((b) =>
    b.addEventListener("click", () => {
      $$("#loc-key-view .seg__btn").forEach((x) => x.classList.remove("is-active"));
      b.classList.add("is-active");
      renderLocTable(b.dataset.key);
    })
  );

  /* ===================== 6. LANGUAGE ===================== */
  document.addEventListener("hh-langchange", () => {
    renderIllustrations();
    if ($("#chart-winrate svg")) renderResult1();
    if ($("#chart-judges svg")) renderJudges();
    if ($("#chart-scenario svg")) renderScenario();
    if ($("#loc-tbody").children.length) renderLocTable($("#loc-key-view .is-active")?.dataset.key || "opus");
  });

  /* ---- handbook picker ---- */
  const handbookMenu = $("#handbook-menu");
  const handbookBtn = $(".handbook-menu__button", handbookMenu);
  const handbookPanel = $("#handbook-menu-panel");
  function closeHandbookMenu() {
    if (!handbookBtn || !handbookPanel) return;
    handbookPanel.hidden = true;
    handbookBtn.setAttribute("aria-expanded", "false");
  }
  handbookBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    const willOpen = handbookPanel.hidden;
    handbookPanel.hidden = !willOpen;
    handbookBtn.setAttribute("aria-expanded", String(willOpen));
  });
  handbookPanel?.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", closeHandbookMenu);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeHandbookMenu();
  });

  onScroll();
})();
