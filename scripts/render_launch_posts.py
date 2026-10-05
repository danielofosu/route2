#!/usr/bin/env python3
"""Render the small, paste-ready launch-copy page from the Markdown drafts.

The drafts contain research notes and future-post templates alongside the live
copy.  This renderer extracts only the explicitly named ready-to-post blocks,
then embeds them as JSON in a self-contained HTML page.  Keeping extraction in
one place makes it safe to refresh the page after the draft copy changes.
"""

from __future__ import annotations

import argparse
import base64
import json
import re
from pathlib import Path


class SourceError(ValueError):
    """Raised when a required ready-to-post block is missing or ambiguous."""


def _normalise(value: str) -> str:
    """Remove only outer blank lines while retaining the block's exact text."""

    lines = value.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


def _heading_line(line: str, level: int, pattern: str) -> bool:
    return re.fullmatch(rf"#{{{level}}}\s+{pattern}\s*", line) is not None


def section(text: str, heading_pattern: str, *, level: int = 2, source: str) -> str:
    """Return a Markdown heading's block, stopping at the next same-level heading."""

    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    matches = [
        index
        for index, line in enumerate(lines)
        if _heading_line(line, level, heading_pattern)
    ]
    if not matches:
        raise SourceError(f"{source}: required heading was not found: ## {heading_pattern}")
    if len(matches) > 1:
        raise SourceError(f"{source}: required heading appears more than once: ## {heading_pattern}")

    start = matches[0] + 1
    end = len(lines)
    next_heading = re.compile(rf"^#{{1,{level}}}\s+")
    for index in range(start, len(lines)):
        if next_heading.match(lines[index]):
            end = index
            break
    return _normalise("\n".join(lines[start:end]))


def read(root: Path, filename: str) -> str:
    path = root / filename
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError as error:
        raise SourceError(f"missing source draft: {path}") from error


def x_posts(root: Path) -> dict[str, str]:
    source = "x-draft.md"
    text = read(root, source)
    return {
        "main": section(
            text,
            r"Candidate\s+2\s+—\s+recommended",
            level=3,
            source=source,
        ),
        "reply": section(
            text,
            r"First\s+reply\s+\(posted\s+immediately\s+under\s+the\s+main\s+post,\s+all\s+candidates\)",
            level=2,
            source=source,
        ),
    }


def hacker_news(root: Path) -> dict[str, str]:
    source = "hn-final.md"
    text = read(root, source)
    return {
        "title": section(text, r"THE\s+ONE\s+HN\s+TITLE\s+TO\s+USE", source=source),
        "body": section(text, r"Body", source=source),
    }


def product_hunt(root: Path) -> dict[str, str]:
    source = "ph-draft.md"
    text = read(root, source)
    taglines = section(text, r"Taglines\b.*", source=source)
    tagline_match = re.search(r"(?m)^1\.\s+(.+?)\s*$", taglines)
    if not tagline_match:
        raise SourceError(f"{source}: recommended tagline (number 1) was not found")
    tagline = re.sub(r"\s*[★*]?\s*RECOMMENDED\s*$", "", tagline_match.group(1)).strip()
    return {
        "tagline": tagline,
        "short_description": section(text, r"Short\s+description", source=source),
        "maker_comment": section(text, r"Maker\s+comment", source=source),
    }


def _reddit_sections(text: str, source: str) -> list[tuple[int, str, list[str]]]:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    numbered_heading = re.compile(r"^##\s+(\d+)\.\s+(.+?)\s*$")
    any_heading = re.compile(r"^##\s+.+$")
    starts: list[tuple[int, int, str]] = []
    all_heading_indexes = [index for index, line in enumerate(lines) if any_heading.match(line)]
    for index, line in enumerate(lines):
        match = numbered_heading.match(line)
        if match:
            starts.append((index, int(match.group(1)), match.group(2).strip()))
    sections: list[tuple[int, str, list[str]]] = []
    for start, number, heading_text in starts:
        following = [index for index in all_heading_indexes if index > start]
        end = following[0] if following else len(lines)
        sections.append((number, heading_text, lines[start + 1 : end]))
    return sections


def reddit_posts(root: Path) -> list[dict[str, str | int]]:
    source = "reddit-drafts.md"
    sections = _reddit_sections(read(root, source), source)
    numbered = [item for item in sections if 1 <= item[0] <= 6]
    if [item[0] for item in numbered] != list(range(1, 7)):
        raise SourceError(f"{source}: expected Reddit sections numbered 1 through 6")

    posts: list[dict[str, str | int]] = []
    for number, heading_text, lines in numbered:
        title_indexes = [index for index, line in enumerate(lines) if line.startswith("Title:")]
        body_indexes = [index for index, line in enumerate(lines) if line.strip() == "Body:"]
        if len(title_indexes) != 1 or len(body_indexes) != 1 or body_indexes[0] <= title_indexes[0]:
            raise SourceError(f"{source}: Reddit section {number} must contain one Title: and Body:")
        title = lines[title_indexes[0]][len("Title:") :].strip()
        body_lines = lines[body_indexes[0] + 1 :]
        # One source section also carries a separate first-comment template.
        # The page's Reddit contract is title + body, so stop before that
        # editorial marker rather than presenting it as part of the post.
        comment_marker = next(
            (index for index, line in enumerate(body_lines) if line.strip().startswith("[First comment by OP:]")),
            len(body_lines),
        )
        body_lines = body_lines[:comment_marker]
        while body_lines and not body_lines[-1].strip():
            body_lines.pop()
        # The source uses Markdown horizontal rules between Reddit drafts;
        # those separators are editorial structure, not outgoing post text.
        if body_lines and body_lines[-1].strip() == "---":
            body_lines.pop()
        body = _normalise("\n".join(body_lines))
        if not title or not body:
            raise SourceError(f"{source}: Reddit section {number} has an empty title or body")
        community = re.sub(r"\s+—.*$", "", heading_text).strip()
        posts.append({"number": number, "community": community, "title": title, "body": body})
    return posts


def extract_posts(root: Path) -> dict[str, object]:
    """Extract only the outgoing blocks used by the page."""

    posts = {
        "x": x_posts(root),
        "hacker_news": hacker_news(root),
        "product_hunt": product_hunt(root),
        "reddit": reddit_posts(root),
    }
    article = root / "x-article.md"
    if article.exists():
        lines = article.read_text(encoding="utf-8").splitlines()
        posts["article"] = {"title": lines[0].removeprefix("# "), "markdown": "\n".join(lines[1:]).strip()}
        reply = root / "x-article-reply.md"
        if reply.exists():
            posts["article"]["reply"] = section(reply.read_text(encoding="utf-8"), r"Reply", source=reply.name)
    return posts


HTML_HEAD = r'''<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>route2 · launch posts</title>
  <style>
    :root {
      --ink: #16222d;
      --muted: #617080;
      --line: #d9e1e8;
      --paper: #ffffff;
      --canvas: #f3f6f8;
      --accent: #2459d6;
      --accent-soft: #eaf0ff;
      --shadow: 0 12px 32px rgba(22, 34, 45, .08);
    }

    * { box-sizing: border-box; }
    html { min-width: 320px; background: var(--canvas); }
    body {
      margin: 0;
      color: var(--ink);
      background: var(--canvas);
      font: 15px/1.55 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button { font: inherit; cursor: pointer; }
    .topbar {
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, .95);
    }
    .topbar-inner, .shell { width: min(1040px, calc(100% - 32px)); margin: 0 auto; }
    .topbar-inner {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 20px;
      padding: 28px 0 24px;
    }
    .eyebrow {
      margin: 0 0 4px;
      color: var(--accent);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: .16em;
      text-transform: uppercase;
    }
    h1, h2, h3, p { margin-top: 0; }
    h1 { margin-bottom: 5px; font-size: clamp(24px, 4vw, 34px); letter-spacing: -.04em; line-height: 1.1; }
    .subtitle { margin: 0; color: var(--muted); }
    .count {
      flex: 0 0 auto;
      padding: 7px 11px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      background: var(--paper);
      font-size: 12px;
      white-space: nowrap;
    }
    .shell { padding: 24px 0 64px; }
    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 22px;
    }
    .tab {
      padding: 9px 15px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      background: var(--paper);
      font-weight: 750;
    }
    .tab:hover, .tab:focus-visible { border-color: var(--accent); color: var(--accent); outline: 0; }
    .tab[aria-selected="true"] { border-color: var(--accent); color: #fff; background: var(--accent); }
    .panel[hidden] { display: none; }
    .panel-head { margin-bottom: 14px; }
    .panel-head h2 { margin-bottom: 2px; font-size: 22px; letter-spacing: -.025em; }
    .panel-head p { margin-bottom: 0; color: var(--muted); }
    .stack { display: grid; gap: 14px; }
    .card {
      min-width: 0;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--paper);
      box-shadow: var(--shadow);
    }
    .card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 13px 16px;
      border-bottom: 1px solid var(--line);
    }
    .card-head h3 { margin: 0; font-size: 14px; }
    .card-head span { color: var(--muted); font-size: 12px; }
    .copy {
      flex: 0 0 auto;
      padding: 6px 10px;
      border: 1px solid var(--line);
      border-radius: 7px;
      color: var(--accent);
      background: #fff;
      font-size: 12px;
      font-weight: 750;
    }
    .copy:hover, .copy:focus-visible { border-color: var(--accent); background: var(--accent-soft); outline: 0; }
    pre {
      margin: 0;
      padding: 17px 18px 19px;
      overflow-x: auto;
      color: #263544;
      background: #fbfcfd;
      font: 14px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .reddit-card { box-shadow: none; }
    .reddit-card > .card-head { background: #fbfcfd; }
    .reddit-copy { display: grid; gap: 12px; padding: 14px; }
    .reddit-copy .card { box-shadow: none; border-radius: 10px; }
    .reddit-copy pre { font-size: 13px; }
    .post-banner { display: block; width: 100%; height: auto; }
    .article-body { padding: 24px; font-size: 17px; line-height: 1.75; }
    .article-body h2 { margin: 28px 0 12px; font-size: 24px; }
    .article-body p { margin-bottom: 20px; }
    .article-body img { display: block; width: 100%; height: auto; margin: 24px 0; border-radius: 10px; }
    .article-body img[src^="data:image/gif"] { image-rendering: pixelated; }
    .article-body a { color: var(--accent); overflow-wrap: anywhere; }
    @media (max-width: 600px) {
      .topbar-inner { align-items: start; flex-direction: column; }
      .count { align-self: start; }
      .topbar-inner, .shell { width: min(100% - 22px, 1040px); }
      pre { padding: 14px; font-size: 13px; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <div>
        <p class="eyebrow">route2</p>
        <h1>Launch posts</h1>
        <p class="subtitle">Ready-to-paste copy for each channel.</p>
      </div>
      <div class="count" id="post-count"></div>
    </div>
  </header>
  <main class="shell">
    <nav class="tabs" role="tablist" aria-label="Launch channels">
      <button class="tab" id="tab-x" role="tab" aria-selected="true" aria-controls="panel-x" data-tab="x">X</button>
      <button class="tab" id="tab-hacker-news" role="tab" aria-selected="false" aria-controls="panel-hacker-news" data-tab="hacker-news">Hacker News</button>
      <button class="tab" id="tab-product-hunt" role="tab" aria-selected="false" aria-controls="panel-product-hunt" data-tab="product-hunt">Product Hunt</button>
      <button class="tab" id="tab-reddit" role="tab" aria-selected="false" aria-controls="panel-reddit" data-tab="reddit">Reddit</button>
      <button class="tab" id="tab-article" role="tab" aria-selected="false" aria-controls="panel-article" data-tab="article">X article</button>
    </nav>
    <section class="panel" id="panel-x" role="tabpanel" aria-labelledby="tab-x" data-panel="x"></section>
    <section class="panel" id="panel-hacker-news" role="tabpanel" aria-labelledby="tab-hacker-news" data-panel="hacker-news" hidden></section>
    <section class="panel" id="panel-product-hunt" role="tabpanel" aria-labelledby="tab-product-hunt" data-panel="product-hunt" hidden></section>
    <section class="panel" id="panel-reddit" role="tabpanel" aria-labelledby="tab-reddit" data-panel="reddit" hidden></section>
    <section class="panel" id="panel-article" role="tabpanel" aria-labelledby="tab-article" data-panel="article" hidden></section>
  </main>
  <script type="application/json" id="launch-posts-data">
__POSTS_JSON__
  </script>
  <script>
    (function () {
      "use strict";

      var posts = JSON.parse(document.getElementById("launch-posts-data").textContent);
      var count = document.getElementById("post-count");
      count.textContent = "4 channels · 10 posts" + (posts.article ? " + article" : "");

      function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
      }

      function copyText(text, button) {
        var copied = function () {
          var old = button.textContent;
          button.textContent = "Copied";
          window.setTimeout(function () { button.textContent = old; }, 1200);
        };
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(text).then(copied, function () {});
          return;
        }
        var area = el("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.left = "-9999px";
        document.body.appendChild(area);
        area.select();
        try { if (document.execCommand("copy")) copied(); } finally { area.remove(); }
      }

      function copyCard(label, text, detail) {
        var card = el("article", "card");
        var head = el("div", "card-head");
        var heading = el("h3", "", label);
        var action = el("button", "copy", "Copy");
        action.type = "button";
        action.addEventListener("click", function () { copyText(text, action); });
        head.appendChild(heading);
        if (detail) head.appendChild(el("span", "", detail));
        head.appendChild(action);
        card.appendChild(head);
        card.appendChild(el("pre", "", text));
        return card;
      }

      function panelHead(title, subtitle) {
        var head = el("div", "panel-head");
        head.appendChild(el("h2", "", title));
        head.appendChild(el("p", "", subtitle));
        return head;
      }

      function renderX() {
        var panel = document.querySelector('[data-panel="x"]');
        panel.appendChild(panelHead("X", "Main post and first reply."));
        var stack = el("div", "stack");
        var main = copyCard("Main post", posts.x.main,
          posts.x.main.length > 280 ? "Long post · " + posts.x.main.length + " characters" : "");
        if (posts.x.banner) {
          var banner = el("img", "post-banner");
          banner.src = posts.x.banner;
          banner.alt = "Route2 banner: pixel octopus beside the route2 wordmark";
          main.appendChild(banner);
        }
        stack.appendChild(main);
        stack.appendChild(copyCard("First reply", posts.x.reply));
        panel.appendChild(stack);
      }

      function renderHackerNews() {
        var panel = document.querySelector('[data-panel="hacker-news"]');
        panel.appendChild(panelHead("Hacker News", "Final title and body."));
        var stack = el("div", "stack");
        stack.appendChild(copyCard("Title", posts.hacker_news.title));
        stack.appendChild(copyCard("Body", posts.hacker_news.body));
        panel.appendChild(stack);
      }

      function renderProductHunt() {
        var panel = document.querySelector('[data-panel="product-hunt"]');
        panel.appendChild(panelHead("Product Hunt", "Listing copy and maker comment."));
        var stack = el("div", "stack");
        stack.appendChild(copyCard("Tagline", posts.product_hunt.tagline));
        stack.appendChild(copyCard("Short description", posts.product_hunt.short_description));
        stack.appendChild(copyCard("Maker comment", posts.product_hunt.maker_comment));
        panel.appendChild(stack);
      }

      function renderReddit() {
        var panel = document.querySelector('[data-panel="reddit"]');
        panel.appendChild(panelHead("Reddit", "Six community-specific posts."));
        var stack = el("div", "stack");
        posts.reddit.forEach(function (post) {
          var card = el("article", "card reddit-card");
          var head = el("div", "card-head");
          head.appendChild(el("h3", "", post.community));
          head.appendChild(el("span", "", post.number + " / " + posts.reddit.length));
          card.appendChild(head);
          var copy = el("div", "reddit-copy");
          copy.appendChild(copyCard("Title", post.title));
          copy.appendChild(copyCard("Body", post.body));
          card.appendChild(copy);
          stack.appendChild(card);
        });
        panel.appendChild(stack);
      }

      function renderArticle() {
        if (!posts.article) { document.getElementById("tab-article").hidden = true; return; }
        var panel = document.querySelector('[data-panel="article"]');
        panel.appendChild(panelHead("X article", "Draft for the third post in the launch thread."));
        if (posts.article.reply) panel.appendChild(copyCard("Article reply", posts.article.reply));
        var card = el("article", "card");
        var head = el("div", "card-head");
        head.appendChild(el("h3", "", posts.article.title));
        var copy = el("button", "copy", "Copy article");
        copy.addEventListener("click", function () { copyText("# " + posts.article.title + "\n\n" + posts.article.markdown, copy); });
        head.appendChild(copy); card.appendChild(head);
        var body = el("div", "article-body");
        posts.article.markdown.split(/\n\s*\n/).forEach(function (block) {
          var media = block.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
          var markdownLink = block.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
          if (media && posts.article.images && posts.article.images[media[2]]) {
            var img = el("img"); img.alt = media[1]; img.src = posts.article.images[media[2]]; body.appendChild(img);
          } else if (/^## /.test(block)) body.appendChild(el("h2", "", block.slice(3)));
          else if (markdownLink) { var sourceLink = el("a", "", markdownLink[1]); sourceLink.href = markdownLink[2].replace(/^\.\.\/\.\.\/docs\//, ""); body.appendChild(el("p")).appendChild(sourceLink); }
          else if (/^https:\/\//.test(block)) { var link = el("a", "", block); link.href = block; body.appendChild(el("p")).appendChild(link); }
          else body.appendChild(el("p", "", block));
        });
        card.appendChild(body); panel.appendChild(card);
      }
      renderArticle();
      renderX();
      renderHackerNews();
      renderProductHunt();
      renderReddit();

      function selectTab(name) {
          document.querySelectorAll("[data-tab]").forEach(function (item) {
            item.setAttribute("aria-selected", item.getAttribute("data-tab") === name ? "true" : "false");
          });
          document.querySelectorAll("[data-panel]").forEach(function (panel) {
            panel.hidden = panel.getAttribute("data-panel") !== name;
          });
      }
      document.querySelectorAll("[data-tab]").forEach(function (tab) {
        tab.addEventListener("click", function () {
          var name = tab.getAttribute("data-tab");
          selectTab(name);
          history.replaceState(null, "", "#" + name);
        });
      });
      var fragment = location.hash.slice(1);
      if (fragment.indexOf("doc=") === 0) {
        var oldPath = new URLSearchParams(fragment).get("doc") || "";
        fragment = /hn-(draft|final)\.md$/.test(oldPath) ? "hacker-news"
          : /ph-draft\.md$/.test(oldPath) ? "product-hunt"
          : /reddit-drafts\.md$/.test(oldPath) ? "reddit" : "x";
      }
      if (["x", "hacker-news", "product-hunt", "reddit", "article"].indexOf(fragment) !== -1) selectTab(fragment);
    }());
  </script>
</body>
</html>
'''


def render_html(posts: dict[str, object]) -> str:
    # JSON is placed in a non-rendered script block.  Escape HTML-significant
    # characters so draft text can never terminate the block or become markup.
    encoded = json.dumps(posts, ensure_ascii=False, indent=2)
    encoded = (
        encoded.replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("/", "\\u002f")
    )
    return HTML_HEAD.replace("__POSTS_JSON__", encoded)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-root",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "launch" / "drafts",
        help="directory containing x-draft.md, hn-final.md, ph-draft.md, and reddit-drafts.md",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "docs" / "launch-review.html",
        help="HTML file to write",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    posts = extract_posts(args.source_root)
    banner = Path(__file__).resolve().parents[1] / "assets" / "route2-banner.png"
    posts["x"]["banner"] = "data:image/png;base64," + base64.b64encode(banner.read_bytes()).decode("ascii")
    if "article" in posts:
        images = {}
        for relative in re.findall(r"!\[[^\]]*\]\(([^)]+)\)", posts["article"]["markdown"]):
            asset = (args.source_root / relative).resolve()
            if asset.exists() and asset.suffix in (".png", ".gif"):
                mime = "image/gif" if asset.suffix == ".gif" else "image/png"
                images[relative] = "data:" + mime + ";base64," + base64.b64encode(asset.read_bytes()).decode("ascii")
        posts["article"]["images"] = images
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(render_html(posts), encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SourceError as error:
        raise SystemExit(f"render_launch_posts.py: {error}")
