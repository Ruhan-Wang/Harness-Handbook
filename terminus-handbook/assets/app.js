/* Codex Handbook — shared behavior (blog-consistent) */
(function () {
  "use strict";
  var root = document.documentElement;

  /* ---- theme toggle: html.dark + hh-theme, matching the blog ---- */
  var tt = document.getElementById("theme-toggle");
  if (tt) {
    tt.addEventListener("click", function () {
      root.classList.toggle("dark");
      try {
        localStorage.setItem("hh-theme", root.classList.contains("dark") ? "dark" : "light");
      } catch (e) {}
    });
  }

  /* ---- reading progress bar ---- */
  var bar = document.getElementById("progress-bar");
  if (bar) {
    var onScroll = function () {
      var h = document.documentElement;
      var max = h.scrollHeight - h.clientHeight;
      bar.style.width = max > 0 ? (100 * h.scrollTop / max) + "%" : "0%";
    };
    document.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* ---- expand / collapse all (scoped to nearest section or page) ---- */
  document.querySelectorAll(".tool[data-x]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var scope = btn.closest("section") || document;
      var open = btn.dataset.x === "expand";
      scope.querySelectorAll("details.file, details.fn, details.t-node, details.registers").forEach(function (d) {
        d.open = open;
      });
    });
  });

  /* ---- code pages: "back" prefers browser history over the home link ---- */
  var backBtn = document.getElementById("back-btn");
  if (backBtn) {
    backBtn.addEventListener("click", function (e) {
      if (history.length > 1) {
        e.preventDefault();
        history.back();
      }
    });
  }

  /* ---- links inside <summary> shouldn't toggle the disclosure ---- */
  document.querySelectorAll("summary a").forEach(function (a) {
    a.addEventListener("click", function (e) { e.stopPropagation(); });
  });

  /* ---- code pages: #L10 / #L10-L25 highlight, gutter click to link ---- */
  /* any page loaded inside the split-pane iframe runs in embed mode */
  if (window.self !== window.top) root.classList.add("embed");

  var codepre = document.getElementById("codepre");
  if (codepre) {
    var lines = codepre.children;
    var applyHl = function (scroll) {
      var m = location.hash.match(/^#L(\d+)(?:-L?(\d+))?$/);
      codepre.querySelectorAll("i.hl").forEach(function (el) { el.classList.remove("hl"); });
      if (!m) return;
      var a = +m[1], b = +(m[2] || m[1]);
      if (b < a) { var t = a; a = b; b = t; }
      for (var i = a; i <= b && i <= lines.length; i++) lines[i - 1].classList.add("hl");
      if (scroll && lines[a - 1]) lines[a - 1].scrollIntoView({ block: "center" });
    };
    applyHl(true);
    /* external hash navigation (e.g. the split pane retargeting) should re-scroll */
    window.addEventListener("hashchange", function () { applyHl(true); });

    var lastLine = null;
    codepre.addEventListener("click", function (e) {
      var el = e.target;
      while (el && el.parentElement !== codepre) el = el.parentElement;
      if (!el || el.tagName !== "I") return;
      /* only the line-number gutter is clickable */
      if (e.clientX - el.getBoundingClientRect().left > 60) return;
      var n = Array.prototype.indexOf.call(lines, el) + 1;
      var h = (e.shiftKey && lastLine)
        ? "L" + Math.min(lastLine, n) + "-L" + Math.max(lastLine, n)
        : (lastLine = n, "L" + n);
      history.replaceState(null, "", "#" + h);
      applyHl(false);
    });
  }

  /* ---- split pane: handbook left, code right (Studio-style) ---- */
  var pane = document.getElementById("codepane");
  if (pane) {
    var frame = document.getElementById("codepane-frame");
    var pathEl = document.getElementById("codepane-path");
    var openEl = document.getElementById("codepane-open");
    var layout = document.querySelector(".layout");

    var openPane = function (href) {
      var m = href.match(/code\/(.+?)\.html(#.*)?$/);
      pathEl.textContent = m
        ? m[1] + (m[2] ? "  " + m[2].replace("#", ":").replace("-L", "–") : "")
        : decodeURIComponent(href).replace(/\.html/, "").replace("#", "  ·  ");
      openEl.href = href;
      if (frame.getAttribute("src") !== href) frame.setAttribute("src", href);
      pane.hidden = false;
      layout.classList.add("code-open");
    };
    var closePane = function () {
      pane.hidden = true;
      layout.classList.remove("code-open");
    };

    /* capture phase: runs before the summary-link stopPropagation handlers.
       Reference lookups (code, registers, cross-page fn links) open in the
       pane; primary navigation (breadcrumbs, sub-stage cards, prev/next,
       sidebar) still navigates normally. */
    document.addEventListener("click", function (e) {
      if (root.classList.contains("embed")) return; /* inside the pane: navigate in place */
      var a = e.target.closest && e.target.closest(
        "a.code-link, a.src-link, a.fn-range, a.reg, .fn-body a, .reg-list a, section.fni a");
      if (!a) return;
      var href = a.getAttribute("href") || "";
      if (!href || href.indexOf("http") === 0 || a.classList.contains("ext")) return;
      if (href.charAt(0) === "#") return; /* same-page anchors jump in place */
      if (e.metaKey || e.ctrlKey || e.shiftKey) return; /* let the browser open a tab */
      e.preventDefault();
      e.stopPropagation();
      openPane(href);
    }, true);

    document.getElementById("codepane-close").addEventListener("click", closePane);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !pane.hidden) closePane();
    });

    /* drag the divider to resize; width persists */
    try {
      var saved = localStorage.getItem("hb-pane-w");
      if (saved) layout.style.setProperty("--pane-w", saved);
    } catch (err) {}
    var grip = document.getElementById("codepane-resize");
    grip.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      frame.style.pointerEvents = "none";
      var move = function (ev) {
        var w = Math.min(Math.max(window.innerWidth - ev.clientX, 340), window.innerWidth * 0.72);
        layout.style.setProperty("--pane-w", w + "px");
      };
      var up = function () {
        frame.style.pointerEvents = "";
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        try { localStorage.setItem("hb-pane-w", layout.style.getPropertyValue("--pane-w")); } catch (err) {}
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
    });
  }

  /* ---- deep link: open ancestors of #hash target ---- */
  function revealHash() {
    if (!location.hash) return;
    var el;
    try { el = document.querySelector(decodeURIComponent(location.hash)); } catch (e) { return; }
    if (!el) return;
    var p = el;
    while (p) {
      if (p.tagName === "DETAILS") p.open = true;
      p = p.parentElement;
    }
    if (el.tagName === "DETAILS") el.open = true;
    el.scrollIntoView({ block: "start" });
  }
  revealHash();
  window.addEventListener("hashchange", revealHash);

  /* ---- landing page: language sections ---- */
  var seg = document.getElementById("lang-seg");
  if (seg) {
    var params = new URLSearchParams(location.search);
    var lang = params.get("lang");
    if (!lang) {
      try { lang = localStorage.getItem("hb-lang"); } catch (e) {}
    }
    if (lang !== "en" && lang !== "zh") lang = "zh";

    function show(l) {
      document.querySelectorAll(".lang-sec").forEach(function (s) {
        s.hidden = s.dataset.lang !== l;
      });
      seg.querySelectorAll("button").forEach(function (b) {
        b.classList.toggle("on", b.dataset.lang === l);
      });
      root.lang = l === "zh" ? "zh-CN" : "en";
      try { localStorage.setItem("hb-lang", l); } catch (e) {}
    }
    show(lang);
    seg.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () { show(b.dataset.lang); });
    });
  }

  /* ---- keyword highlighting helpers ---- */
  var escRe = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); };

  var unhighlight = function (rootEl) {
    rootEl.querySelectorAll("mark.hlt").forEach(function (mk) {
      var parent = mk.parentNode;
      parent.replaceChild(document.createTextNode(mk.textContent), mk);
      parent.normalize();
    });
  };

  var highlightTerms = function (rootEl, terms, skipSel) {
    if (!terms.length) return 0;
    var re = new RegExp("(" + terms.map(escRe).join("|") + ")", "gi");
    var walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var p = node.parentElement;
        if (!p || p.closest("mark.hlt, script, style")) return NodeFilter.FILTER_REJECT;
        if (skipSel) {
          /* skip only sub-containers INSIDE rootEl — the card itself may sit
             within an ancestor's .t-kids, which must not disqualify it */
          var sk = p.closest(skipSel);
          if (sk && rootEl.contains(sk)) return NodeFilter.FILTER_REJECT;
        }
        re.lastIndex = 0; /* global regex keeps state across .test() calls */
        return re.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    var targets = [];
    while (walker.nextNode()) targets.push(walker.currentNode);
    var count = 0;
    targets.forEach(function (node) {
      var frag = document.createDocumentFragment();
      var text = node.nodeValue, last = 0, m;
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        var mk = document.createElement("mark");
        mk.className = "hlt";
        mk.textContent = m[0];
        frag.appendChild(mk);
        last = m.index + m[0].length;
        count++;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    });
    return count;
  };

  /* ---- stage pages: honor ?hl=<terms> arriving from the landing filter ---- */
  var stageContent = document.querySelector(".stage-head") && document.querySelector(".content");
  if (stageContent) {
    var hlq = new URLSearchParams(location.search).get("hl");
    if (hlq) {
      var hlTerms = hlq.split(/\s+/).filter(Boolean);
      var nHits = highlightTerms(stageContent, hlTerms);
      if (nHits) {
        stageContent.querySelectorAll("details").forEach(function (d) {
          if (d.querySelector("mark.hlt")) d.open = true;
        });
        var first = stageContent.querySelector("mark.hlt");
        if (first) setTimeout(function () { first.scrollIntoView({ block: "center" }); }, 0);
      }
    }
  }

  /* ---- landing tree filter: full-text over each stage's title + own description ---- */
  document.querySelectorAll(".filter").forEach(function (input) {
    var tree = document.getElementById(input.dataset.tree);
    if (!tree) return;
    var nodes = tree.querySelectorAll("details.t-node");

    var counter = document.createElement("span");
    counter.className = "filter-count";
    input.insertAdjacentElement("afterend", counter);

    /* a node's searchable text: its summary + direct description paragraphs,
       excluding the nested .t-kids subtree so parents don't shadow children */
    var hayOf = function (n) {
      if (n._hay) return n._hay;
      var s = (n.dataset.title || "") + " " + n.querySelector(":scope > summary").textContent;
      var body = n.querySelector(":scope > .t-body");
      if (body) {
        Array.prototype.forEach.call(body.children, function (c) {
          if (!c.classList || !c.classList.contains("t-kids")) s += " " + c.textContent;
        });
      }
      return (n._hay = s.toLowerCase());
    };

    /* while a query is active, stage links carry it as ?hl= so the target
       page can highlight the keyword too */
    tree.addEventListener("click", function (e) {
      var a = e.target.closest && e.target.closest("a.t-link");
      if (!a) return;
      var q = input.value.trim();
      if (!q) return;
      e.preventDefault();
      location.href = a.getAttribute("href") + "?hl=" + encodeURIComponent(q);
    });

    input.addEventListener("input", function () {
      var q = input.value.trim().toLowerCase();
      unhighlight(tree);
      if (!q) {
        nodes.forEach(function (n) { n.classList.remove("dim"); n.open = false; });
        counter.textContent = "";
        return;
      }
      var terms = q.split(/\s+/).filter(Boolean);
      var hits = [];
      nodes.forEach(function (n) { n.classList.add("dim"); });
      nodes.forEach(function (n) {
        var hay = hayOf(n);
        var ok = terms.every(function (t) { return hay.indexOf(t) !== -1; });
        if (!ok) return;
        hits.push(n);
        n.classList.remove("dim");
        var p = n.parentElement;
        while (p && p !== tree) {
          if (p.tagName === "DETAILS") { p.classList.remove("dim"); p.open = true; }
          p = p.parentElement;
        }
      });
      /* hidden nodes stay closed; few hits -> open them so the match is visible */
      nodes.forEach(function (n) { if (n.classList.contains("dim")) n.open = false; });
      hits.forEach(function (n) { n.open = hits.length <= 8; });
      /* mark the keyword in every visible card's own text (hits + revealed ancestors) */
      nodes.forEach(function (n) {
        if (!n.classList.contains("dim")) highlightTerms(n, terms, ".t-kids");
      });
      counter.textContent = hits.length
        ? hits.length + (document.documentElement.lang === "en" ? " hits" : " 个命中")
        : (document.documentElement.lang === "en" ? "no match" : "无命中");
    });
  });
})();

/* function-index page: full-name search over every documented function */
(function () {
  var input = document.getElementById("fni-filter");
  if (!input) return;
  var secs = document.querySelectorAll("section.fni");
  var resBox = document.getElementById("fni-results");
  var idx = window.FNIDX || null;
  var keys = idx ? Object.keys(idx) : [];
  var lkeys = keys.map(function (k) { return k.toLowerCase(); });
  var zh = document.documentElement.lang !== "en";

  var counter = document.createElement("span");
  counter.className = "filter-count";
  input.insertAdjacentElement("afterend", counter);

  var slug = function (s) {
    return s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  };
  var esc = function (s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  };

  var render = function (q) {
    var exact = [], prefix = [], sub = [];
    for (var i = 0; i < lkeys.length; i++) {
      var lk = lkeys[i];
      var pos = lk.indexOf(q);
      if (pos === -1) continue;
      if (lk === q) exact.push(i);
      else if (pos === 0 || lk.indexOf("::" + q) !== -1) prefix.push(i);
      else sub.push(i);
      if (exact.length + prefix.length + sub.length > 2000) break;
    }
    var order = exact.concat(prefix, sub);
    var shown = order.slice(0, 200);
    var html = shown.map(function (i) {
      var k = keys[i];
      var items = idx[k].map(function (e) {
        var parts = e.split("|");
        var sid = parts[0], path = parts[1];
        var aid = slug(path) + "--" + slug(k);
        return '<li><a href="' + sid + '.html#' + aid + '"><code>' + esc(k) + "</code></a>" +
          '<span class="fni-path"><code>' + esc(path) + "</code></span>" +
          '<span class="fni-stage">' + sid.replace("stage-", "") + "</span></li>";
      }).join("");
      return '<section class="fni"><h3><code>' + esc(k) + "</code>" +
        '<span class="pill">' + idx[k].length + "</span></h3><ul>" + items + "</ul></section>";
    }).join("");
    resBox.innerHTML = html;
    counter.textContent = order.length
      ? (order.length > 200 ? (zh ? "前 200 / " : "top 200 of ") : "") + order.length + (zh ? " 个命中" : " hits")
      : (zh ? "无命中" : "no match");
  };

  input.addEventListener("input", function () {
    var q = input.value.trim().toLowerCase();
    if (!q) {
      resBox.innerHTML = "";
      counter.textContent = "";
      secs.forEach(function (s) { s.style.display = ""; });
      return;
    }
    if (idx) {
      secs.forEach(function (s) { s.style.display = "none"; });
      render(q);
    } else {
      /* fallback: filter the static ambiguous list */
      secs.forEach(function (s) {
        var name = s.querySelector("h3 code").textContent.toLowerCase();
        s.style.display = name.indexOf(q) !== -1 ? "" : "none";
      });
    }
  });
})();
