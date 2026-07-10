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
    ".usecols", ".flowpath", ".insights", ".ticklist--takeaways",
    ".chart-card", ".aside", ".closing"
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
        <rect x="379" y="${y}" width="202" height="52" rx="8" fill="${SURF}" stroke="${LINE}"/>
        <rect x="391" y="${y + 13}" width="26" height="26" rx="6" fill="${BLUEW}"/>
        ${T(404, y + 31, l[0], { size: 11.5, w: 650, fill: BLUEI, anchor: "middle" })}
        ${T(429, y + 24, l[1], { size: 13, w: 600, fill: INK })}
        ${T(429, y + 41, l[2], { size: 11.5, fill: MUT })}
        ${i < 2 ? `<path d="M475 ${y + 56} l5 5 5 -5" fill="none" stroke="${FAINT}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>` : ""}`;
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
        <g opacity="${hl ? 1 : 0.5}">
          <rect x="700" y="${y}" width="240" height="30" rx="6" fill="${SURF}" stroke="${LINE}"/>
          ${hl ? `<circle cx="716" cy="${y + 15}" r="3.6" fill="${SIEN}"/>` : ""}
          ${T(hl ? 728 : 716, y + 19.5, f[0], { size: 12, mono: true, fill: hl ? SOFT : MUT })}
        </g>`;
    }).join("");
    const fan = files.filter((f) => f[1]).map((f, i) => {
      const y = 104 + files.indexOf(f) * 37 + 15;
      return carrow(600, 212, 700, y, BLUE, 0.5);
    }).join("");

    return `
<svg viewBox="0 0 960 348" role="img" aria-label="${tr("fig.hero.aria", "A behavior request, mapped through the handbook to the implementation sites in code")}">
  <!-- left: the behavior -->
  ${overline(135, 86, tr("fig.hero.olA", "THE BEHAVIOR YOU WANT"), SIENI)}
  <rect x="20" y="102" width="230" height="94" rx="10" fill="${SIENW}" stroke="color-mix(in srgb, ${SIEN} 34%, ${LINE})"/>
  ${T(135, 141, tr("fig.hero.q1", "“Ask the user before"), { size: 14.5, italic: true, anchor: "middle", fill: SOFT })}
  ${T(135, 163, tr("fig.hero.q2", "deleting files.”"), { size: 14.5, italic: true, anchor: "middle", fill: SOFT })}
  ${T(135, 226, tr("fig.hero.subA1", "Expressed in plain language"), { size: 12.5, anchor: "middle", fill: MUT })}
  ${T(135, 244, tr("fig.hero.subA2", "by the user."), { size: 12.5, anchor: "middle", fill: MUT })}

  <!-- middle: the handbook -->
  ${overline(480, 86, tr("fig.hero.olB", "THE HANDBOOK"), BLUEI)}
  <rect x="365" y="102" width="230" height="206" rx="12" fill="none" stroke="color-mix(in srgb, ${BLUE} 40%, ${LINE})" stroke-width="1.4"/>
  ${rows}

  <!-- right: the code -->
  ${overline(820, 86, tr("fig.hero.olC", "WHERE IT LIVES IN CODE"), GRA)}
  ${fileRows}
  ${T(820, 336, tr("fig.hero.subC", "five sites — found before editing begins"), { size: 12.5, anchor: "middle", fill: MUT })}

  <!-- connectors -->
  ${carrow(250, 149, 365, 205, SIEN, 0.85)}
  ${fan}
</svg>`;
  }

  // ---- The problem: one behavior scattered through a file tree --------
  function treeSVG() {
    const rows = [
      ["core/", 0, false, ""],
      ["loop.py", 1, false, ""],
      ["state_manager.py", 1, true,  tr("fig.tree.a1", "tracks the pending confirmation")],
      ["tools/", 0, false, ""],
      ["wrapper.py", 1, true,  tr("fig.tree.a2", "intercepts the destructive call")],
      ["registry.py", 1, false, ""],
      ["prompts/", 0, false, ""],
      ["system.md", 1, true,  tr("fig.tree.a3", "tells the model when to ask")],
      ["config/", 0, false, ""],
      ["flags.py", 1, true,  tr("fig.tree.a4", "feature gate for the behavior")],
      ["memory/", 0, false, ""],
      ["store.py", 1, false, ""],
      ["telemetry/", 0, false, ""],
      ["events.py", 1, true,  tr("fig.tree.a5", "logs the outcome")],
      ["consumers/", 0, false, ""],
      ["result_handler.py", 1, true,  tr("fig.tree.a6", "consumes the user's decision")]
    ];
    const y0 = 84, dy = 23.5;
    const rowsSVG = rows.map((r, i) => {
      const y = y0 + i * dy;
      const x = r[1] ? 374 : 352;
      let out = "";
      if (r[2]) {
        out += `<rect x="340" y="${y - 15}" width="272" height="21" rx="5" fill="${SIENW}"/>`;
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
      return out;
    }).join("");

    return `
<svg viewBox="0 0 960 508" role="img" aria-label="${tr("fig.tree.aria", "One behavioral request maps to six scattered files in the harness codebase")}">
  <!-- left: the request -->
  ${overline(135, 100, tr("fig.tree.olA", "THE REQUEST"), SIENI)}
  <rect x="20" y="116" width="230" height="92" rx="10" fill="${SIENW}" stroke="color-mix(in srgb, ${SIEN} 34%, ${LINE})"/>
  ${T(135, 154, tr("fig.tree.q1", "“Ask the user before"), { size: 14.5, italic: true, anchor: "middle", fill: SOFT })}
  ${T(135, 176, tr("fig.tree.q2", "deleting files.”"), { size: 14.5, italic: true, anchor: "middle", fill: SOFT })}
  ${T(135, 238, tr("fig.tree.subA", "Sounds like a one-line change."), { size: 12.5, anchor: "middle", fill: MUT })}
  ${harrow(256, 326, 162, SIEN)}

  <!-- middle: file tree -->
  <rect x="330" y="20" width="292" height="462" rx="10" fill="${SURF}" stroke="${LINE}"/>
  ${T(350, 48, "harness/", { size: 12.5, mono: true, w: 600, fill: SOFT })}
  <path d="M330 62 H622" stroke="${LINES}" stroke-width="1"/>
  ${rowsSVG}

  <!-- right: what each site does -->
  ${overline(790, 48, tr("fig.tree.olC", "WHAT EACH SITE DOES"), GRA)}
  <circle cx="660" cy="474" r="3.4" fill="${SIEN}"/>
  ${T(672, 478.5, tr("fig.tree.stat1", "6 sites across 4 subsystems."), { size: 12.5, w: 600, fill: SOFT })}
  ${T(672, 497, tr("fig.tree.stat2", "Half never mention “confirm”."), { size: 12.5, fill: MUT })}
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

    const card = (y, w, color, wash, level, title, task, q1, q2, out1, out2) => {
      const x = (960 - w) / 2;
      return `
        <rect x="${x}" y="${y}" width="${w}" height="108" rx="13" fill="${SURF}" stroke="${LINE}"/>
        <rect x="${x}" y="${y}" width="${w}" height="34" rx="13" fill="${wash}" opacity="0.86"/>
        ${T(x + 22, y + 23, level, { size: 11.2, w: 750, fill: color, ls: ".1em" })}
        ${T(x + 128, y + 23, title, { size: 14.2, w: 750, fill: INK })}
        ${T(x + 22, y + 58, task, { size: 14.2, w: 700, fill: INK })}
        ${T(x + 22, y + 81, q1, { size: 12.4, fill: MUT })}
        ${T(x + 22, y + 99, q2, { size: 12.4, fill: MUT })}
        <rect x="${x + w - 210}" y="${y + 58}" width="188" height="32" rx="8" fill="${wash}" stroke="color-mix(in srgb, ${color} 28%, ${LINE})"/>
        ${T(x + w - 116, y + 78, out1, { size: 11.6, w: 650, fill: color, anchor: "middle" })}
        ${T(x + w - 116, y + 95, out2, { size: 10.8, fill: MUT, anchor: "middle" })}`;
    };

    return `
<svg viewBox="0 0 960 660" role="img" aria-label="${tr("fig.levels.aria", "From behavior question to code evidence through three handbook levels")}">
  ${T(480, 30, tr("fig.levels.funnel.title", "From behavior question to code evidence"), { size: 23, w: 800, fill: INK, anchor: "middle" })}
  ${T(480, 54, tr("fig.levels.funnel.sub", "Each layer answers one question, then narrows the search."), { size: 13, fill: MUT, anchor: "middle" })}

  <!-- behavior question -->
  <rect x="286" y="78" width="388" height="58" rx="13" fill="${SIENW}" stroke="color-mix(in srgb, ${SIEN} 35%, ${LINE})"/>
  ${overline(480, 100, tr("fig.levels.input.label", "BEHAVIOR QUESTION"), SIENI)}
  ${T(480, 124, tr("fig.levels.input.text", "What does the system do, and where is it implemented?"), { size: 13.3, fill: SOFT, anchor: "middle" })}

  ${downArrow(480, 144, 174, SIEN)}

  <!-- funnel cards -->
  ${card(
    174, 760, BLUEI, BLUEW,
    tr("fig.levels.l1.level", "L1"),
    tr("fig.levels.l1tab", "System Overview"),
    tr("fig.levels.l1task", "Build the global mental model"),
    tr("fig.levels.l1q1", "Question: How does this harness run as a whole?"),
    tr("fig.levels.l1q2", "Look at lifecycle, stages, data flow, and state flow."),
    tr("fig.levels.l1out1", "Output"),
    tr("fig.levels.l1out2", "relevant stages")
  )}

  ${downArrow(480, 286, 318, BLUE)}

  ${card(
    318, 640, BLUEI, BLUEW,
    tr("fig.levels.l2.level", "L2"),
    tr("fig.levels.l2tab", "Component Overview"),
    tr("fig.levels.l2task", "Narrow to the relevant modules"),
    tr("fig.levels.l2q1", "Question: Which components participate in this behavior?"),
    tr("fig.levels.l2q2", "Inspect responsibilities, dependencies, inputs, outputs, state."),
    tr("fig.levels.l2out1", "Output"),
    tr("fig.levels.l2out2", "components + dependencies")
  )}

  ${downArrow(480, 430, 462, BLUE)}

  ${card(
    462, 520, GRA, "var(--graphite-wash)",
    tr("fig.levels.l3.level", "L3"),
    tr("fig.levels.l3tab", "Unit Deep Dive"),
    tr("fig.levels.l3task", "Return to verifiable code evidence"),
    tr("fig.levels.l3q1", "Question: Which code implements the behavior?"),
    tr("fig.levels.l3q2", "Check logic, state transitions, exceptions, source anchors."),
    tr("fig.levels.l3out1", "Output"),
    tr("fig.levels.l3out2", "files + functions + links")
  )}

  ${downArrow(480, 574, 604, GRA)}

  <!-- code evidence -->
  <rect x="286" y="604" width="388" height="38" rx="10" fill="${SURF}" stroke="${LINE}"/>
  ${chip(306, 611, 112, "wrapper.py", BLUEI)}
  ${chip(430, 611, 110, "manager.py", BLUEI)}
  ${chip(552, 611, 102, "flags.py", BLUEI)}
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
    const st = stations.map((s) => `
      <circle cx="${s.cx}" cy="56" r="15" fill="${BLUEW}" stroke="color-mix(in srgb, ${BLUE} 38%, ${LINE})"/>
      ${T(s.cx, 61, s.n, { size: 13, w: 650, fill: BLUEI, anchor: "middle" })}
      ${T(s.cx, 98, s.t, { size: 15.5, w: 650, fill: INK, anchor: "middle" })}
      ${T(s.cx, 120, s.d1, { size: 12.5, fill: MUT, anchor: "middle" })}
      ${T(s.cx, 137, s.d2, { size: 12.5, fill: MUT, anchor: "middle" })}
      <rect x="${s.cx - 78}" y="156" width="156" height="30" rx="8" fill="${BLUEW}"/>
      ${T(s.cx, 175.5, s.out, { size: 12.5, w: 600, fill: BLUEI, anchor: "middle" })}`).join("");

    return `
<svg viewBox="0 0 960 262" role="img" aria-label="${tr("fig.pipe.aria", "Handbook construction: extract facts, organize by behavior, synthesize")}">
  <!-- input -->
  <rect x="20" y="38" width="128" height="36" rx="9" fill="${SURF}" stroke="${LINE}"/>
  ${T(84, 61, tr("fig.pipe.repo", "harness repo"), { size: 12.5, mono: true, fill: SOFT, anchor: "middle" })}
  ${harrow(154, 274, 56, FAINT)}
  ${harrow(322, 528, 56, FAINT)}
  ${harrow(578, 784, 56, FAINT)}
  ${st}
  <!-- proposer-reviewer loop under station 2 -->
  <path d="M492 214 a10 10 0 1 1 6 9" fill="none" stroke="${FAINT}" stroke-width="1.5"/>
  <polygon points="494,226 502,224 497,217" fill="${FAINT}"/>
  ${T(518, 220, tr("fig.pipe.loop", "proposer ⇄ reviewer, until convergence"), { size: 12, fill: MUT })}
  ${T(480, 252, tr("fig.pipe.foot", "Prose explains — facts anchor. Every entry stays linked to verifiable code evidence."), { size: 12.5, italic: true, fill: MUT, anchor: "middle" })}
</svg>`;
  }

  // ---- BGPD: request → stages → units → L3 evidence → edit plan --------
  function bgpdSVG() {
    const header = (x, s) => T(x, 40, s, { size: 11, w: 650, fill: FAINT, ls: ".1em" });
    const row = (x, y, w, s, state) => {
      // state: "hl" | "norm" | "dim"
      const hl = state === "hl";
      return `<g opacity="${state === "dim" ? 0.42 : 1}">
        <rect x="${x}" y="${y}" width="${w}" height="30" rx="7"
              fill="${hl ? BLUEW : SURF}" stroke="${hl ? `color-mix(in srgb, ${BLUE} 55%, ${LINE})` : LINE}" stroke-width="${hl ? 1.4 : 1}"/>
        ${T(x + 14, y + 19.5, s, { size: 12.5, w: hl ? 650 : 500, fill: hl ? BLUEI : SOFT })}
      </g>`;
    };
    const chipRow = (x, y, w, s, state) => {
      const hl = state === "hl";
      return `<g opacity="${state === "dim" ? 0.42 : 1}">
        <rect x="${x}" y="${y}" width="${w}" height="28" rx="7"
              fill="${hl ? BLUEW : SURF}" stroke="${hl ? `color-mix(in srgb, ${BLUE} 55%, ${LINE})` : LINE}" stroke-width="${hl ? 1.4 : 1}"/>
        ${T(x + 12, y + 18.5, s, { size: 11.3, fill: hl ? BLUEI : MUT })}
      </g>`;
    };

    const stages = [
      [tr("fig.bgpd.st1", "input"), "dim"], [tr("fig.bgpd.st2", "plan"), "hl"], [tr("fig.bgpd.st3", "act"), "hl"],
      [tr("fig.bgpd.st4", "observe"), "dim"], [tr("fig.bgpd.st5", "finalize"), "dim"]
    ];
    const units = [
      [tr("fig.bgpd.u1", "Delete guard"), "hl"], [tr("fig.bgpd.u2", "Prompt rule"), "hl"],
      [tr("fig.bgpd.u3", "Tool wrapper"), "norm"], [tr("fig.bgpd.u4", "Fallback path"), "dim"]
    ];
    const l3details = [
      [tr("fig.bgpd.l3title", "Confirm before deletion"), "hl"],
      [tr("fig.bgpd.l3r1", "trigger: delete_file(path)"), "hl"],
      [tr("fig.bgpd.l3r2", "permission: high risk"), "hl"],
      [tr("fig.bgpd.l3r3", "state: record confirmation"), "norm"],
      [tr("fig.bgpd.l3r5", "evidence: 5 sites"), "dim"]
    ];

    const diff = (y, sign, good, s) => `
      ${T(866, y, sign, { size: 14, w: 700, fill: good ? "var(--c-good)" : SIENI })}
      ${T(882, y - 1, s, { size: 11.6, fill: SOFT })}`;

    return `
<svg viewBox="0 0 1000 358" role="img" aria-label="${tr("fig.bgpd.aria", "BGPD narrows a request through stages and units to L3 behavior-unit evidence and an edit plan")}">
  ${header(20,  tr("fig.bgpd.h1", "1 · REQUEST"))}
  ${header(220, tr("fig.bgpd.h2", "2 · L1 SYSTEM OVERVIEW"))}
  ${header(430, tr("fig.bgpd.h3", "3 · L2 UNIT OVERVIEW"))}
  ${header(640, tr("fig.bgpd.h4", "4 · L3 UNIT DETAIL"))}
  ${header(850, tr("fig.bgpd.h5", "5 · EDIT PLAN"))}

  <!-- 1 · request -->
  <rect x="20" y="102" width="160" height="88" rx="10" fill="${SIENW}" stroke="color-mix(in srgb, ${SIEN} 34%, ${LINE})"/>
  ${T(100, 138, tr("fig.bgpd.q1", "“Add confirmation"), { size: 13, italic: true, anchor: "middle", fill: SOFT })}
  ${T(100, 158, tr("fig.bgpd.q2", "before delete.”"), { size: 13, italic: true, anchor: "middle", fill: SOFT })}

  <!-- 2 · stages -->
  ${stages.map((s, i) => row(220, 58 + i * 38, 160, s[0], s[1])).join("")}

  <!-- 3 · units -->
  ${units.map((u, i) => row(430, 77 + i * 38, 170, u[0], u[1])).join("")}

  <!-- 4 · L3 behavior-unit detail -->
  ${l3details.map((l, i) => chipRow(640, 58 + i * 36, 170, l[0], l[1])).join("")}

  <!-- 5 · edit plan -->
  <rect x="850" y="58" width="140" height="150" rx="10" fill="${SURF}" stroke="${LINE}"/>
  ${diff(92, "+", true, tr("fig.bgpd.d1", "confirm check"))}
  ${diff(122, "+", true, tr("fig.bgpd.d2", "prompt rule"))}
  ${diff(152, "−", false, tr("fig.bgpd.d3", "direct delete"))}
  ${T(866, 190, tr("fig.bgpd.d4", "scoped, minimal"), { size: 11, fill: MUT })}

  <!-- arrows -->
  ${harrow(186, 214, 146, BLUE)}
  ${harrow(386, 424, 146, BLUE)}
  ${harrow(606, 634, 146, BLUE)}
  ${harrow(816, 844, 146, BLUE)}

  <!-- coarse → fine axis -->
  <path d="M220 296 H960" stroke="${LINE}" stroke-width="1"/>
  <polygon points="960,292 968,296 960,300" fill="${FAINT}"/>
  ${T(220, 320, tr("fig.bgpd.coarse", "coarse — the whole system"), { size: 12, fill: MUT })}
  ${T(968, 320, tr("fig.bgpd.fine", "fine — one edit"), { size: 12, fill: MUT, anchor: "end" })}
  ${T(594, 348, tr("fig.bgpd.note", "Each step reveals only what the current decision needs — the repository stays the ground truth."), { size: 12.5, italic: true, fill: MUT, anchor: "middle" })}
</svg>`;
  }

  function renderIllustrations() {
    const put = (id, svg) => { const el = $(id); if (el) el.innerHTML = svg; };
    put("#hero-illustration", heroSVG());
    put("#scatter-illustration", treeSVG());
    put("#levels-illustration", levelsSVG());
    put("#pipeline-illustration", pipelineSVG());
    put("#bgpd-illustration", bgpdSVG());
  }
  renderIllustrations();

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

  // grouped vertical bars: baseline (gray) vs handbook (blue), from zero
  function groupedBars(el, cfg) {
    if (!el) return;
    const W = cfg.W || 440, H = cfg.H || 232;
    const padL = 40, padR = 6, padT = 18, padB = 30;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const max = cfg.max;
    const y = (v) => padT + plotH - (v / max) * plotH;
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
    let bars = "";
    cfg.groups.forEach((g, i) => {
      const cx = padL + groupW * i + groupW / 2;
      const bx = cx - barW - gap / 2, hx = cx + gap / 2;
      const yb = y(g.baseline), yh = y(g.handbook);
      bars += `
        <path class="bar" d="${barPath(bx, yb, barW, padT + plotH - yb)}" fill="${C_BL}"/>
        <path class="bar" d="${barPath(hx, yh, barW, padT + plotH - yh)}" fill="${C_HB}"/>
        <text class="val-label fade-label" x="${bx + barW / 2}" y="${yb - 6}" text-anchor="middle" font-size="11" font-weight="500" fill="var(--muted)">${fmt(g.baseline)}</text>
        <text class="val-label fade-label" x="${hx + barW / 2}" y="${yh - 6}" text-anchor="middle" font-size="11.5" font-weight="650">${fmt(g.handbook)}</text>
        <text class="grp-label" x="${cx}" y="${H - 8}" text-anchor="middle" font-size="12" font-weight="550">${g.label}</text>`;
    });

    el.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" role="img">
        ${grid}
        <line class="axis-line" x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}"/>
        ${bars}
      </svg>`;
  }

  // dumbbell: baseline → handbook per judge, faceted by harness
  function dumbbell(el, cfg) {
    if (!el) return;
    const W = 860, rowH = 30, headH = 26, gapH = 18;
    const x0 = 150, x1 = 828;
    const max = cfg.max;
    const x = (v) => x0 + (v / max) * (x1 - x0);

    let y = 34;
    let body = "";
    const rowYs = [];
    cfg.facets.forEach((f) => {
      body += `<text x="${x0 - 132}" y="${y}" font-size="12.5" font-weight="650" fill="var(--ink)">${f.label}</text>`;
      y += headH - 12;
      f.rows.forEach((r) => {
        y += rowH;
        rowYs.push(y - 10);
        const xb = x(r.baseline), xh = x(r.handbook);
        const cy = y - 10;
        body += `
          <text x="${x0 - 14}" y="${cy + 4}" text-anchor="end" font-size="12" fill="var(--muted)">${r.label}</text>
          <line x1="${xb}" y1="${cy}" x2="${xh}" y2="${cy}" stroke="${C_HB}" stroke-width="3" stroke-linecap="round" opacity="0.3"/>
          <circle cx="${xb}" cy="${cy}" r="6" fill="${C_BL}" stroke="var(--surface)" stroke-width="2"/>
          <circle cx="${xh}" cy="${cy}" r="6" fill="${C_HB}" stroke="var(--surface)" stroke-width="2"/>
          <text class="fade-label" x="${xb - 13}" y="${cy + 4}" text-anchor="end" font-size="10.5" fill="var(--muted)" style="font-variant-numeric:tabular-nums">${r.baseline.toFixed(1)}</text>
          <text class="fade-label" x="${xh + 13}" y="${cy + 4}" font-size="11" font-weight="650" fill="var(--ink-soft)" style="font-variant-numeric:tabular-nums">${r.handbook.toFixed(1)}</text>`;
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

    el.innerHTML = `
      <svg viewBox="0 0 ${W} ${axisY + 26}" role="img">
        ${grid}
        <line class="axis-line" x1="${x0}" y1="${axisY}" x2="${x1}" y2="${axisY}"/>
        ${legend}
        ${body}
      </svg>`;
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
    { label: "Codex",    baseline: 6.152, handbook: 5.138 },
    { label: "Terminus", baseline: 0.687, handbook: 0.244 }
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
    max: 60, ticks: [0, 20, 40, 60]
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
    "sc.q":     ["sc.q",     "Q · refine"],
    "sc.cf":    ["sc.cf",    "CF · crossfile"],
    "sc.sh":    ["sc.sh",    "SH · search-hostile"],
    "sc.easy":  ["sc.easy",  "Easy"],
    "sc.medium":["sc.medium","Medium"],
    "sc.hard":  ["sc.hard",  "Hard"]
  };

  function renderResult1() {
    groupedBars($("#chart-winrate"), {
      groups: WIN, max: 50, ticks: [0, 10, 20, 30, 40, 50],
      fmt: (v) => v.toFixed(1), tickFmt: (v) => String(v)
    });
    groupedBars($("#chart-tokens"), {
      groups: TOKENS, max: 6.5, ticks: [0, 2, 4, 6],
      fmt: (v) => v.toFixed(3), tickFmt: (v) => String(v)
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
      groups, max: 60, ticks: [0, 20, 40, 60],
      W: 720, H: 250, fmt: (v) => v.toFixed(1), tickFmt: (v) => String(v)
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

  const locBar = (v, cls) => `
    <div class="loc-bar">
      <div class="loc-bar__track"></div>
      <div class="loc-bar__fill ${cls}" style="width:${v}%"></div>
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
        <td>${locBar(bl, "loc-bar__fill--bl")}</td>
        <td>${locBar(hb, "loc-bar__fill--hb")}</td>
        <td class="num ${improved ? "gap-pos" : "gap-neg"}">${gapTxt}</td>
      </tr>`;
    }).join("");
    if (cap) {
      const label = tr(key === "opus" ? "seg.opus.short" : "seg.gpt.short", cfg.label);
      cap.innerHTML = tr(
        "loc.cap",
        "<b>Answer-key-grounded localization</b> ({label} reference key). For <b>Wrong</b>, lower is better."
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

  onScroll();
})();
