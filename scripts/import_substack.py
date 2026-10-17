#!/usr/bin/env python3
"""Convert a public Substack post into the HTML fragment used by an
Ocean Futures insight page, word for word, and download its images.

Needs BeautifulSoup:  pip install beautifulsoup4
Usage:
  python3 scripts/import_substack.py <post-url> <image-prefix> <out-fragment.html>

Writes the article body (headings, paragraphs, lists, figures) to the
fragment file and saves each image into images/<image-prefix>-N.<ext>,
resized for the web. Prints title, subtitle and date for the page header.
Substack's own subscribe widgets and heading-anchor buttons are dropped;
every other word of the post is kept exactly as written.
"""
import json, os, re, subprocess, sys, urllib.request
from bs4 import BeautifulSoup, NavigableString, Tag

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36"
INLINE_KEEP = {"strong", "b", "em", "i", "a", "sub", "sup", "br", "code"}


def fetch(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=60).read()


def inline_html(node):
    """Inner HTML with only text, strong/em/a/br kept (spans unwrapped).
    Whitespace is collapsed to single spaces but never trimmed inside
    nested elements, so "up to <a>five times</a> the carbon" keeps its
    spaces; only the outermost call trims."""
    return re.sub(r"\s+", " ", _inline(node)).strip()


def _inline(node):
    out = []
    for c in node.children:
        if isinstance(c, NavigableString):
            out.append(str(c).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
        elif isinstance(c, Tag):
            if c.get("class") and any("header-anchor" in k for k in c.get("class")):
                continue
            if c.name in INLINE_KEEP:
                if c.name == "a":
                    href = c.get("href", "")
                    href = re.sub(r"[?&]utm_[^&]*", "", href)
                    inner = _inline(c)
                    if inner.strip():
                        out.append(f'<a href="{href}">{inner}</a>')
                elif c.name == "br":
                    out.append("<br>")
                else:
                    inner = _inline(c)
                    if inner.strip():
                        out.append(f"<{c.name}>{inner}</{c.name}>")
            else:
                out.append(_inline(c))
    return "".join(out)


def best_image_url(fig):
    img = fig.find("img")
    attrs = json.loads(img.get("data-attrs", "{}")) if img and img.get("data-attrs") else {}
    return attrs.get("src") or (img.get("src") if img else None)


def convert(url, prefix):
    soup = BeautifulSoup(fetch(url).decode("utf-8"), "html.parser")
    title = soup.select_one("h1.post-title").get_text(strip=True)
    sub = soup.select_one("h3.subtitle")
    sub = sub.get_text(strip=True) if sub else ""
    t = soup.select_one("time")
    date = t.get_text(strip=True) if t else ""
    body = soup.select_one("div.body.markup")
    parts, n_img = [], 0

    def block(el):
        nonlocal n_img
        if isinstance(el, NavigableString) or not isinstance(el, Tag):
            return
        cls = " ".join(el.get("class", []))
        if "subscription-widget" in cls or "button-wrapper" in cls:
            return
        if el.name in ("h2", "h3", "h4"):
            parts.append(f"<{el.name}>{inline_html(el)}</{el.name}>")
        elif el.name == "p":
            h = inline_html(el)
            if h:
                parts.append(f"<p>{h}</p>")
        elif el.name in ("ul", "ol"):
            items = "\n".join(f"      <li>{inline_html(li)}</li>" for li in el.find_all("li", recursive=False))
            parts.append(f"<{el.name}>\n{items}\n    </{el.name}>")
        elif el.name == "blockquote":
            parts.append(f"<blockquote>{inline_html(el)}</blockquote>")
        elif el.name == "hr":
            if not parts or parts[-1] != "<hr>":
                parts.append("<hr>")
        elif "captioned-image-container" in cls or el.name == "figure":
            fig = el.find("figure") or el
            src = best_image_url(fig)
            if not src:
                return
            n_img += 1
            ext = os.path.splitext(src.split("?")[0])[1].lower() or ".jpg"
            name = f"{prefix}-{n_img}{ext}"
            raw = os.path.join("/tmp", name)
            open(raw, "wb").write(fetch(src))
            dest = os.path.join(ROOT, "images", name)
            subprocess.run(["sips", "-Z", "1600", raw, "--out", dest], capture_output=True)
            # Large PNGs are almost always screenshots/photos: re-encode
            # as JPEG so a long article doesn't ship tens of megabytes.
            if ext == ".png" and os.path.getsize(dest) > 400_000:
                name = f"{prefix}-{n_img}.jpg"
                jpg = os.path.join(ROOT, "images", name)
                subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "72", dest, "--out", jpg], capture_output=True)
                os.remove(dest)
                dest = jpg
            cap = fig.find("figcaption")
            cap_html = inline_html(cap) if cap else ""
            alt = re.sub(r"<[^>]+>", "", cap_html)[:140]
            parts.append(
                f'<figure>\n      <img loading="lazy" src="images/{name}" alt="{alt}" />'
                + (f"\n      <figcaption>{cap_html}</figcaption>" if cap_html else "")
                + "\n    </figure>"
            )
        else:
            for c in el.children:
                block(c)

    for child in body.children:
        block(child)
    return title, sub, date, "\n    ".join(parts)


if __name__ == "__main__":
    u, prefix, out = sys.argv[1:4]
    title, sub, date, html = convert(u, prefix)
    open(out, "w", encoding="utf-8").write(html)
    print(json.dumps({"title": title, "subtitle": sub, "date": date, "chars": len(html)}, ensure_ascii=False))
