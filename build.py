#!/usr/bin/env python3
"""Bundle index.html + style.css + script.js + favicon into one standalone file.

Usage:  python3 build.py
Output: harness-handbook.html  (fully self-contained; only external ref is Google Fonts)
"""
import base64
import pathlib
import re

MIME = {
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}


def inline_local_assets(html: str, root: pathlib.Path) -> str:
    def repl_src(m):
        rel = m.group(1)
        path = root / rel
        if not path.is_file():
            return m.group(0)
        mime = MIME.get(path.suffix.lower(), "application/octet-stream")
        data = base64.b64encode(path.read_bytes()).decode()
        return f'src="data:{mime};base64,{data}"'

    return re.sub(r'src="((?:assets/)[^"]+)"', repl_src, html)


here = pathlib.Path(__file__).parent
html = (here / "index.html").read_text()
css = (here / "style.css").read_text()
i18n = (here / "i18n.js").read_text()
js = (here / "script.js").read_text()
favsvg = (here / "assets/icons/book-mark.svg").read_text()

# 1) inline favicon as a data URI
fav_b64 = base64.b64encode(favsvg.encode()).decode()
html = html.replace(
    '<link rel="icon" type="image/svg+xml" href="assets/icons/book-mark.svg" />',
    f'<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,{fav_b64}" />',
)

# 2) inline CSS
html = html.replace('<link rel="stylesheet" href="style.css" />', "<style>\n" + css + "\n</style>")

# 3) inline i18n + JS (i18n must run before script.js)
combined_js = i18n + "\n" + js
html = html.replace(
    '  <script src="i18n.js"></script>\n  <script src="script.js"></script>',
    "<script>\n" + combined_js + "\n</script>",
)

# 4) inline raster assets referenced from HTML
html = inline_local_assets(html, here)

out = here / "harness-handbook.html"
out.write_text(html)

leftovers = re.findall(r'(?:href|src)="(?!https:|data:|#)[^"]+"', html)
print(f"wrote {out.name} ({out.stat().st_size // 1024} KB)")
print("remaining local references:", leftovers or "none")
