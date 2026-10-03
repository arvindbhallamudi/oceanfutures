// ============================================================
// Ocean Futures — shared site behaviour
// nav highlighting, mobile nav sheet, guide sidebar scroll-spy,
// trends filter, diagram tab-switcher + hotspot tooltips
// ============================================================

function currentPage() {
  const p = location.pathname.split("/").pop() || "index.html";
  if (p.startsWith("ocean-guide")) return "ocean-guide.html";
  if (p.startsWith("map")) return "map.html";
  if (p.startsWith("insights")) return "insights.html";
  if (p.startsWith("about")) return "about.html";
  return "index.html";
}

function initNav() {
  const page = currentPage();
  document.querySelectorAll(".nav-link, .mns-list a").forEach((a) => {
    const href = a.getAttribute("href");
    if (href === page) a.classList.add("active");
  });

  const sheet = document.getElementById("mobileNavSheet");
  const toggle = document.getElementById("mobileToggle");
  const close = document.getElementById("mnsClose");
  if (sheet && toggle) {
    toggle.addEventListener("click", () => sheet.classList.add("show"));
    close?.addEventListener("click", () => sheet.classList.remove("show"));
    sheet.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => sheet.classList.remove("show")));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") sheet.classList.remove("show");
    });
  }
}

// ============================================================
// Boot loader — a branded wavy overlay shown from first paint on
// every page, covering the initial load (fonts, hero images, the
// map's basemap tiles) instead of leaving a blank or half-styled
// flash. Independent of the circle page-transition below: it just
// fades out once the page is actually ready, using the same
// `load`-event-or-400ms-cap heuristic so it hands off cleanly into
// either the circle reveal (arriving via an internal link) or the
// plain fade+float reveal (direct/typed URL, reload).
// ============================================================
// Resolves the instant the boot loader starts fading out. Other arrival
// animations (the circle reveal and the plain fade+float reveal, both
// below) await this before doing anything visible, so nothing ever
// plays hidden underneath/behind the loader — see initBootLoader.
let resolveBootLoaderDone;
window.bootLoaderDone = new Promise((resolve) => { resolveBootLoaderDone = resolve; });

function initBootLoader() {
  const el = document.getElementById("bootLoader");
  if (!el) {
    resolveBootLoaderDone();
    return;
  }
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const shownAt = performance.now();
  // Held on screen for at least a full second regardless of how fast the
  // page actually loads (a fast/cached local load could otherwise hide
  // this before a single wave rotation completes), so it reads as a
  // deliberate loading beat rather than a flash, and hands off cleanly
  // into the circle reveal below rather than both happening at once.
  const MIN_SHOW_MS = 1000;
  const hide = () => {
    const wait = Math.max(0, MIN_SHOW_MS - (performance.now() - shownAt));
    setTimeout(() => {
      el.classList.add("hide");
      resolveBootLoaderDone();
      setTimeout(() => el.remove(), 700);
    }, wait);
  };
  if (reduced) {
    setTimeout(hide, 150);
    return;
  }
  if (document.readyState === "complete") {
    hide();
    return;
  }
  let done = false;
  const start = () => {
    if (done) return;
    done = true;
    hide();
  };
  window.addEventListener("load", start);
  setTimeout(start, 1400);
}

// ============================================================
// Header search — a small static index of every page (title +
// description), filtered client-side as you type. No backend, so
// this is the entire site's real page list, not a fuzzy full-text
// index of body copy.
// ============================================================
function initSearch() {
  const toggle = document.getElementById("searchToggle");
  const overlay = document.getElementById("searchOverlay");
  if (!toggle || !overlay || typeof SEARCH_INDEX === "undefined") return;
  const input = document.getElementById("searchInput");
  const results = document.getElementById("searchResults");
  const closeBtn = document.getElementById("searchClose");

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  // Wraps every case-insensitive occurrence of q inside text in <mark>,
  // after escaping the rest — used for both the snippet and the title.
  function highlight(text, q) {
    const escaped = escapeHtml(text);
    if (!q) return escaped;
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
    return escaped.replace(re, (m) => `<mark>${m}</mark>`);
  }
  // A page can match in its title, description or full body text —
  // every page's complete rendered copy (not just title/description)
  // is in SEARCH_INDEX, built from the live site, see search-data.js.
  // Body matches pull a short window of real surrounding text so the
  // result reads like "here's where that word actually appears",
  // rather than just naming the page.
  function matchFor(page, q) {
    const title = page.title.toLowerCase();
    const desc = (page.desc || "").toLowerCase();
    const body = page.body || "";
    const bodyLower = body.toLowerCase();
    if (title.includes(q)) return { score: 3, snippet: page.desc || "", field: "title" };
    if (desc.includes(q)) return { score: 2, snippet: page.desc, field: "description" };
    const idx = bodyLower.indexOf(q);
    if (idx !== -1) {
      const start = Math.max(0, idx - 60);
      const end = Math.min(body.length, idx + q.length + 60);
      let snippet = body.slice(start, end).replace(/\s*\|\s*/g, " — ").trim();
      if (start > 0) snippet = "…" + snippet;
      if (end < body.length) snippet += "…";
      return { score: 1, snippet, field: "page text" };
    }
    return null;
  }

  function render(query) {
    const q = query.trim().toLowerCase();
    if (!q) {
      results.innerHTML = SEARCH_INDEX
        .slice(0, 8)
        .map((p) => `<a href="${p.url}" class="search-result"><span class="sr-title">${escapeHtml(p.title)}</span><span class="sr-desc">${escapeHtml(p.desc || "")}</span></a>`)
        .join("");
      return;
    }
    const matches = SEARCH_INDEX
      .map((p) => {
        const m = matchFor(p, q);
        return m && { page: p, ...m };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    results.innerHTML = matches
      .slice(0, 8)
      .map(
        (m) =>
          `<a href="${m.page.url}?hl=${encodeURIComponent(query.trim())}" class="search-result">` +
          `<span class="sr-title">${highlight(m.page.title, q)}</span>` +
          `<span class="sr-desc">${highlight(m.snippet, q)}</span>` +
          `</a>`
      )
      .join("") || `<p class="search-empty">No pages match "${query}".</p>`;
  }

  function open() {
    overlay.classList.add("show");
    render("");
    input.value = "";
    setTimeout(() => input.focus(), 50);
  }
  function close() {
    overlay.classList.remove("show");
  }

  toggle.addEventListener("click", open);
  closeBtn?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("show")) close();
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      overlay.classList.contains("show") ? close() : open();
    }
  });
  input.addEventListener("input", () => render(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = results.querySelector(".search-result");
      if (first) location.href = first.getAttribute("href");
    }
  });
}

// ============================================================
// Lands a search result's matched term on the destination page: scroll
// to its first occurrence in the body copy and flash-highlight it, so
// clicking a body-text search result doesn't just drop someone on the
// page with no idea where the word actually is.
// ============================================================
function initHighlightFromQuery() {
  const term = new URLSearchParams(location.search).get("hl");
  if (!term) return;
  window.bootLoaderDone.then(() => {
    setTimeout(() => {
      const root = document.getElementById("ptContent") || document.body;
      const termLower = term.toLowerCase();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue.toLowerCase().includes(termLower)) return NodeFilter.FILTER_REJECT;
          if (node.parentElement?.closest("script, style, header, .search-overlay, .mobile-nav-sheet, .guide-sidebar")) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const node = walker.nextNode();
      if (!node) return;
      const idx = node.nodeValue.toLowerCase().indexOf(termLower);
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + term.length);
      const mark = document.createElement("mark");
      mark.className = "search-highlight";
      try {
        range.surroundContents(mark);
      } catch {
        return; // range crosses element boundaries — skip rather than break the page
      }
      mark.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => mark.classList.add("fade"), 2200);
    }, 300);
  });
}

// ============================================================
// Ocean Guide sidebar — scroll-spy highlighting for the static
// left-column table of contents (ocean-guide.html only)
// ============================================================
function initGuideSidebar() {
  const links = document.querySelectorAll(".guide-sidebar-list a");
  if (!links.length) return;
  const map = new Map();
  links.forEach((a) => {
    const id = a.getAttribute("href").slice(1);
    const el = document.getElementById(id);
    if (el) map.set(el, a);
  });

  const setActive = (link) => {
    links.forEach((a) => a.classList.remove("active"));
    link?.classList.add("active");
  };

  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible.length) setActive(map.get(visible[0].target));
    },
    { rootMargin: "-15% 0px -70% 0px", threshold: 0 }
  );
  map.forEach((_, el) => observer.observe(el));
}

// ============================================================
// Insights filter — type (single-select) + topic (multi-select)
// (insights.html only)
// ============================================================
function initInsightsFilter() {
  const grid = document.getElementById("insightsGrid");
  if (!grid) return;
  const cards = Array.from(grid.querySelectorAll(".insight-card"));
  const typeBtns = Array.from(document.querySelectorAll(".insights-type-btn"));
  const topicPills = Array.from(document.querySelectorAll(".insights-topic-pill"));
  const countEl = document.getElementById("insightsCount");
  let activeType = "all";
  let activeTopics = new Set();

  // Deep-link support: /insights.html?type=explainer lands pre-filtered
  // (used by the footer's Insights column).
  const requestedType = new URLSearchParams(location.search).get("type");
  const requestedBtn = requestedType && typeBtns.find((b) => b.dataset.type === requestedType);
  if (requestedBtn) {
    typeBtns.forEach((b) => b.classList.remove("active"));
    requestedBtn.classList.add("active");
    activeType = requestedType;
  }

  function apply() {
    let visible = 0;
    cards.forEach((c) => {
      const typeMatch = activeType === "all" || c.dataset.type === activeType;
      const topics = c.dataset.topics.split(" ");
      const topicMatch = activeTopics.size === 0 || topics.some((t) => activeTopics.has(t));
      const match = typeMatch && topicMatch;
      c.classList.toggle("hide", !match);
      if (match) visible++;
    });
    if (countEl) countEl.textContent = `Showing ${visible} of ${cards.length}`;
  }

  typeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      typeBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeType = btn.dataset.type;
      apply();
    });
  });

  topicPills.forEach((pill) => {
    pill.addEventListener("click", () => {
      const topic = pill.dataset.topic;
      if (topic === "all") {
        activeTopics.clear();
        topicPills.forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
      } else {
        document.querySelector('.insights-topic-pill[data-topic="all"]')?.classList.remove("active");
        pill.classList.toggle("active");
        if (pill.classList.contains("active")) activeTopics.add(topic);
        else activeTopics.delete(topic);
        if (activeTopics.size === 0) document.querySelector('.insights-topic-pill[data-topic="all"]')?.classList.add("active");
      }
      apply();
    });
  });

  apply();
}

// Cross-browser fallback for orphan words in body copy — `text-wrap:
// balance` (used on headings via CSS) doesn't yet cover paragraph text
// everywhere, so swap each paragraph's last space for a non-breaking
// one, keeping the final two words together on one line.
function fixWidows() {
  document.querySelectorAll("p, .lead").forEach((el) => {
    if (el.dataset.widowFixed) return;
    el.dataset.widowFixed = "1";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let lastNode = null;
    while (walker.nextNode()) lastNode = walker.currentNode;
    if (lastNode) {
      lastNode.textContent = lastNode.textContent.replace(/ ([^\s]+)\s*$/, " $1");
    }
  });
}

// Subtle scroll-linked drift on hero imagery (data-parallax elements) —
// the background stays fixed (see body::before in style.css) while these
// images move at a slightly different rate than the rest of the page for
// a bit of depth. Deliberately small (a few percent of scroll distance)
// and rAF-throttled so it never competes with the sticky header for
// paint time the way the earlier background-attachment:fixed bug did.
function initParallax() {
  const els = Array.from(document.querySelectorAll("[data-parallax]"));
  if (!els.length || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let ticking = false;
  function update() {
    const vh = window.innerHeight;
    els.forEach((el) => {
      const rect = el.getBoundingClientRect();
      const centerOffset = rect.top + rect.height / 2 - vh / 2;
      el.style.transform = `translateY(${(centerOffset * -0.035).toFixed(1)}px)`;
    });
    ticking = false;
  }
  window.addEventListener(
    "scroll",
    () => {
      if (!ticking) {
        requestAnimationFrame(update);
        ticking = true;
      }
    },
    { passive: true }
  );
  update();
}

// ============================================================
// Scroll reveal — subtle float-up-and-fade-in for content blocks as
// they enter the viewport, applied from this one shared place rather
// than hand-added per page/section. Fires once per element (then
// unobserves), staggers siblings that appear together (e.g. a row of
// cards), and does nothing at all under prefers-reduced-motion.
//
// skipAlreadyVisible (used when arriving via the page-transition
// circle, after it finishes — see initPageTransition) leaves any
// element already in the viewport at that moment alone entirely,
// instead of starting a fresh fade+float for it: the circle already
// revealed it, and on a content-heavy page (Trends Explorer's 40+
// cards, the Solutions grid) starting dozens of *more* simultaneous
// opacity/transform transitions right as the circle finishes reads as
// its own second burst of jank, which is what made those pages look
// slow/broken even after the circle itself was fixed. Below-the-fold
// elements still get the normal one-at-a-time treatment as the user
// scrolls to them.
// ============================================================
function initReveal(skipAlreadyVisible) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const selector = [
    ".section-head", ".offer-text", ".offer-image",
    ".card", ".path-card", ".trend-card", ".read-card", ".sol-card", ".sol-media",
    ".course-topic-card", ".driver-card", ".driver-media", ".insight-card",
    ".flow-card", ".feature-card", ".editorial-card", ".icon-tile",
    ".footer-brand", ".footer-col", ".founder-quote",
  ].join(", ");
  let els = Array.from(document.querySelectorAll(selector)).filter((el) => !el.closest(".map-shell"));
  if (skipAlreadyVisible) {
    const vh = window.innerHeight;
    els = els.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom < 0 || r.top > vh; // keep only elements NOT currently in view
    });
  }
  if (!els.length) return;

  // Stagger delay is per sibling-group (e.g. a row of cards sharing a
  // grid parent), capped so a long list doesn't end in one giant wait.
  const indexInParent = new Map();
  els.forEach((el) => {
    const n = indexInParent.get(el.parentElement) || 0;
    indexInParent.set(el.parentElement, n + 1);
    el.classList.add("reveal");
    el.style.setProperty("--reveal-delay", `${Math.min(n, 4) * 0.08}s`);
  });

  const observer = new IntersectionObserver(
    (entries, obs) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("in");
        obs.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.1 }
  );
  els.forEach((el) => observer.observe(el));
}

// ============================================================
// Page transition — see the .page-transition rules in style.css for
// what it looks like; this is what drives it. Exactly one visible
// animation, on arrival only: real page content growing out of a
// circle at the center of the screen. Clicking a link navigates
// immediately — no covering animation plays first, so there's never
// a "blank circle, then a second content circle" double-motion.
// Plain multi-page navigation (no SPA router): the incoming page
// starts pre-covered via html.pt-incoming, set synchronously by the
// tiny inline script right after <body> (before this file even runs,
// and before first paint), so there's nothing to flash while it
// loads. This file then waits for the page to fully finish loading
// (images included, via the `load` event, not just DOMContentLoaded)
// before growing the reveal, so there's always real content inside
// the circle — never bare background with content popping in after.
// ============================================================
// Returns true if it has taken over responsibility for starting
// initReveal() once the circle finishes (see the call site), false if
// the caller should just start initReveal() itself right away.
function initPageTransition() {
  const overlay = document.getElementById("pageTransition");
  const content = document.getElementById("ptContent");
  const hasIncoming = document.documentElement.classList.contains("pt-incoming");
  const arriving = !!overlay && !!content && hasIncoming && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (hasIncoming && !arriving) {
    // Reduced motion, or the page-transition markup is missing — no
    // animation is going to run, so just clear the flag now. Left
    // alone, html.pt-incoming would leave .pt-content permanently
    // clipped to nothing (invisible) forever, since nothing else ever
    // removes it.
    document.documentElement.classList.remove("pt-incoming");
  }

  if (arriving) {
    const reveal = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // The real page content grows its own circle open — see the
          // big comment on .page-transition in style.css for why this
          // is on .pt-content and not the overlay. Dropping
          // html.pt-incoming here snaps the (transition-less) overlay
          // back to invisible in the same instant.
          content.classList.add("pt-reveal");
          document.documentElement.classList.remove("pt-incoming");
          // .pt-reveal's clip-path (even at its fully-open 150vmax
          // value) makes .pt-content a containing block for the sticky
          // header — drop the class once the animation is actually
          // done so clip-path goes back to none and sticky works again.
          // transitionend BUBBLES, and .reveal descendants (the
          // fade+float cards/sections inside this same wrapper) fire
          // their own opacity/transform transitionend well before
          // clip-path's 2.2s is up — without this target/propertyName
          // check, the first one of those to fire (often under 200ms
          // in) was yanking pt-reveal off early, cutting the circle
          // reveal down to a near-instant snap instead of the full
          // slow growth.
          content.addEventListener("transitionend", (ev) => {
            if (ev.target !== content || ev.propertyName !== "clip-path") return;
            content.classList.remove("pt-reveal");
            // Don't start the fade+float reveal system until the circle
            // is fully done — running dozens of simultaneous
            // opacity/transform transitions (one per card/section
            // already in view) *while* the full-viewport clip-path is
            // also animating visibly janked the circle on
            // content-heavy pages (Trends Explorer's 40+ cards, the
            // driver/solutions grids), making it look stalled or
            // broken there even though it ran fine on lighter pages.
            initReveal(true);
          });
        });
      });
    };
    // Capped at 400ms rather than an unbounded wait for `load` — on
    // this dev server every image loads in well under 50ms regardless
    // of how many a page has, so the cap never actually engages here,
    // but an unbounded wait ties the moment the circle starts to
    // however long images take on whatever's actually serving the
    // site, which otherwise makes the reveal start at a different,
    // inconsistent delay per page depending on image count/weight —
    // capping it keeps the start point (and so the whole animation)
    // landing at the same time everywhere.
    // Also gated on window.bootLoaderDone (see initBootLoader) — the
    // loader sits above this overlay (z-index 10000 vs 9999), so
    // without this the circle would grow to full size completely
    // hidden behind it. Both are centered at 50%/50%, so once the
    // loader fades away the circle is already open from that same
    // point, reading as one continuous reveal rather than two.
    const revealAfterLoader = () => window.bootLoaderDone.then(reveal);
    if (document.readyState === "complete") revealAfterLoader();
    else {
      let started = false;
      const start = () => {
        if (started) return;
        started = true;
        revealAfterLoader();
      };
      window.addEventListener("load", start);
      setTimeout(start, 400);
    }
  }

  if (!overlay || !content) return arriving;

  document.addEventListener("click", (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest("a");
    if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
    let url;
    try {
      url = new URL(href, location.href);
    } catch {
      return;
    }
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.search === location.search) return; // same-page anchor

    e.preventDefault();
    sessionStorage.setItem("pt-origin", "1");
    // A cache-busting param guarantees a real fetch of the destination
    // document itself (not just its CSS/JS) — without it, a browser
    // can serve an already-stale cached copy of the page straight from
    // its disk cache without ever hitting the network, silently
    // reverting every feature on this page to whatever it looked like
    // the last time it was cached. The tiny inline script right after
    // <body> strips this param back out via history.replaceState once
    // the fresh page has loaded, so it never shows in the address bar.
    url.searchParams.set("_r", Date.now().toString(36));
    location.href = url.href;
  });

  // A bfcache restore (browser back/forward) can bring this page back
  // mid-animation — reset rather than leave it stuck covering the page.
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    content.classList.remove("pt-reveal");
    document.documentElement.classList.remove("pt-incoming");
  });

  return arriving;
}

window.addEventListener("DOMContentLoaded", () => {
  initBootLoader();
  initNav();
  initSearch();
  initHighlightFromQuery();
  initGuideSidebar();
  initInsightsFilter();
  initParallax();
  // initPageTransition() calls initReveal() itself, once the circle
  // reveal finishes, when arriving via an internal link click — see
  // the comment on initPageTransition for why the two are kept from
  // running at the same time. Otherwise (direct/typed URL, reload,
  // reduced motion) start initReveal() once the boot loader is out of
  // the way, so the fade+float-in is still visible instead of having
  // already finished hidden behind the loader.
  if (!initPageTransition()) window.bootLoaderDone.then(() => initReveal());
  if (location.hash) {
    const el = document.getElementById(location.hash.slice(1));
    if (el) setTimeout(() => el.scrollIntoView({ behavior: "smooth" }), 200);
  }
  initTrendFilter();
  initDiagramViewer();
  fixWidows();
});

// ============================================================
// Trends Explorer filter (trends-drivers.html only)
// ============================================================
function initTrendFilter() {
  const grid = document.getElementById("trendGrid");
  if (!grid) return;
  const pills = document.querySelectorAll(".filter-pill");
  const countEl = document.getElementById("trendCount");
  const cards = Array.from(grid.querySelectorAll(".trend-card"));

  function applyFilter(cat) {
    let visible = 0;
    cards.forEach((c) => {
      const match = cat === "all" || c.dataset.cat === cat;
      c.style.display = match ? "" : "none";
      if (match) visible++;
    });
    if (countEl) countEl.textContent = `Showing ${visible} of ${cards.length} trends`;
  }

  pills.forEach((pill) => {
    pill.addEventListener("click", () => {
      pills.forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      applyFilter(pill.dataset.cat);
    });
  });

  applyFilter("all");
}

// ============================================================
// Diagram viewer: tab switching (swaps the diagram image + caption;
// all tabs share one hotspot set since the underlying geometry is
// identical) + hover/tap tooltips on hotspots
// (science.html Causes & Effects — Figma-sourced diagrams)
// ============================================================
function initDiagramViewer() {
  const tabsEl = document.querySelector(".diagram-tabs");
  if (!tabsEl) return;

  const tabs = Array.from(tabsEl.querySelectorAll(".diagram-tab"));
  const img = document.getElementById(tabsEl.dataset.imgTarget);
  const captionTitle = document.getElementById(tabsEl.dataset.captionTitle);
  const captionDesc = document.getElementById(tabsEl.dataset.captionDesc);

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      if (img && tab.dataset.svg) img.src = tab.dataset.svg;
      if (captionTitle && tab.dataset.captionTitle) captionTitle.textContent = tab.dataset.captionTitle;
      if (captionDesc && tab.dataset.captionDesc) captionDesc.textContent = tab.dataset.captionDesc;
    });
  });

  document.querySelectorAll(".diagram-stage").forEach((stage) => {
    const tooltip = stage.querySelector(".tooltip");
    if (!tooltip) return;
    const hotspots = stage.querySelectorAll(".hotspot");

    function show(hotspot) {
      const title = hotspot.dataset.title;
      const desc = hotspot.dataset.desc;
      tooltip.innerHTML = `<div class="tooltip-title">${title}</div><div class="tooltip-desc">${desc}</div>`;
      const left = hotspot.style.left;
      let top = hotspot.style.top;
      tooltip.style.left = left;
      tooltip.style.top = top;
      tooltip.classList.add("show");
    }
    function hide() {
      tooltip.classList.remove("show");
    }

    hotspots.forEach((h) => {
      h.addEventListener("mouseenter", () => show(h));
      h.addEventListener("mouseleave", hide);
      h.addEventListener("focus", () => show(h));
      h.addEventListener("blur", hide);
      h.addEventListener("click", (e) => {
        e.preventDefault();
        tooltip.classList.contains("show") && tooltip.dataset.active === h.dataset.title ? hide() : show(h);
        tooltip.dataset.active = h.dataset.title;
      });
    });
  });
}
