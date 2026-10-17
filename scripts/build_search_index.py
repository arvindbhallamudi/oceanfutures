#!/usr/bin/env python3
"""Rebuild js/search-data.js from the site's own HTML.

Run from anywhere:  python3 scripts/build_search_index.py

For every .html page it extracts the visible body copy (header, footer,
nav, boot loader, search UI and the guide sidebar are skipped) and writes
it into SEARCH_INDEX. Each page's display title and description are kept
from the existing search-data.js; new pages fall back to their <title>
and meta description. To retitle a page in search results, edit TITLES
below or the existing file.
"""
import glob, json, os, re
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "js", "search-data.js")

TITLES = {
    "insight-seaweed-materials.html": (
        "Seaweed Structures: An ‘Abundant’ Resource?",
        "History, Science and Design with Algae.",
    ),
    "insight-wetlands-blue-carbon.html": (
        "Wetlands & Blue Carbon - Can It Help With Emissions Mitigation?",
        "Climate-Change Solutions Review, Terra.do.",
    ),
    "insight-decarbonizing-shipping.html": (
        "The Path To Decarbonize Shipping",
        "A Systems Perspective Toward Net-Zero in Maritime Transport.",
    ),
}

EXCLUDE_TAGS = {"script", "style", "header", "footer", "nav", "svg"}
EXCLUDE_IDS = {"searchOverlay", "mobileNavSheet", "bootLoader", "pageTransition", "guideSidebar"}
EXCLUDE_CLASSES = {"boot-loader", "search-overlay", "mobile-nav-sheet", "page-transition",
                   "site-header", "site-footer", "guide-sidebar", "guide-pagenav"}


class Extractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.skip = 0
        self.chunks = []
        self.title = ""
        self.desc = ""
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        if tag == "title":
            self.in_title = True
        if tag == "meta" and d.get("name") == "description":
            self.desc = d.get("content", "")
        if tag in ("meta", "link", "img", "br", "hr", "input", "source"):
            return  # void elements never get an end tag
        if self.skip:
            self.skip += 1
            return
        classes = set((d.get("class") or "").split())
        if tag in EXCLUDE_TAGS or d.get("id") in EXCLUDE_IDS or classes & EXCLUDE_CLASSES:
            self.skip = 1

    def handle_startendtag(self, tag, attrs):
        # Self-closing tags (<path/>, <meta/>) have no end tag, so they
        # must never change the skip depth.
        d = dict(attrs)
        if tag == "meta" and d.get("name") == "description":
            self.desc = d.get("content", "")

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        if tag in ("meta", "link", "img", "br", "hr", "input", "source"):
            return
        if self.skip:
            self.skip -= 1
            return
        if tag in ("p", "div", "li", "h1", "h2", "h3", "h4", "h5", "section", "td", "tr", "figcaption"):
            self.chunks.append(" | ")

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        if self.skip:
            return
        text = data.strip()
        if text:
            self.chunks.append(text)


def clean(chunks):
    text = " ".join(chunks)
    text = re.sub(r"\s*\|\s*", " | ", text)
    text = re.sub(r"(\s*\|\s*){2,}", " | ", text)
    return re.sub(r"[ \t]+", " ", text).strip(" |")


existing = {}
if os.path.exists(OUT):
    raw = open(OUT, encoding="utf-8").read()
    if "const SEARCH_INDEX = " in raw:
        body = raw.split("const SEARCH_INDEX = ", 1)[1].rstrip().rstrip(";")
        existing = {e["url"]: e for e in json.loads(body)}

pages = []
for path in sorted(glob.glob(os.path.join(ROOT, "*.html"))):
    url = os.path.basename(path)
    p = Extractor()
    p.feed(open(path, encoding="utf-8").read())
    old = existing.get(url, {})
    title = old.get("title") or p.title.strip()
    desc = old.get("desc", p.desc.strip())
    if url in TITLES:
        title, desc = TITLES[url]
    pages.append({"url": url, "title": title, "desc": desc, "body": clean(p.chunks)})

header = """// ============================================================
// Ocean Futures — header search index
// Generated from each page's own rendered body text (header, footer,
// nav, boot-loader and the search UI itself excluded) — see
// initSearch() in main.js, which searches title, description and
// body for a match and highlights it in the result snippet.
// Regenerate with:  python3 scripts/build_search_index.py
// ============================================================
"""
with open(OUT, "w", encoding="utf-8") as f:
    f.write(header + "const SEARCH_INDEX = " + json.dumps(pages, ensure_ascii=False, separators=(",", ":")) + ";")
print(f"Wrote {OUT}: {len(pages)} pages, {os.path.getsize(OUT):,} bytes")
