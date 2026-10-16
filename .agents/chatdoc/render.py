#!/usr/bin/env python3
"""Render chatdoc Markdown to a same-name .html companion for wslview.

Usage: python3 .agents/chatdoc/render.py <file.md> [more.md ...]
Requires the `markdown` package; if missing: python3 -m venv /tmp/mdenv &&
/tmp/mdenv/bin/pip install markdown, then run with /tmp/mdenv/bin/python.
"""
import sys, pathlib
import markdown

STYLE = """
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; max-width: 62rem; margin: 2rem auto; padding: 0 1.5rem; line-height: 1.55; color: #1a1a1a; }
  h1 { border-bottom: 2px solid #444; padding-bottom: .3rem; font-size: 1.5rem; }
  h2 { border-bottom: 1px solid #ccc; padding-bottom: .2rem; margin-top: 2rem; }
  code { background: #f0f0f0; padding: .1em .3em; border-radius: 3px; font-size: .92em; }
  pre { background: #f6f6f6; border: 1px solid #ddd; padding: .8rem; overflow-x: auto; border-radius: 6px; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; margin: 1rem 0; font-size: .95em; }
  th, td { border: 1px solid #ccc; padding: .35rem .7rem; text-align: left; vertical-align: top; }
  th { background: #efefef; }
  blockquote { border-left: 3px solid #bbb; margin-left: 0; padding-left: 1rem; color: #555; }
"""

for arg in sys.argv[1:]:
    src = pathlib.Path(arg)
    body = markdown.markdown(src.read_text(), extensions=["tables", "fenced_code", "toc"])
    html = (f'<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">\n'
            f'<title>{src.stem}</title>\n<style>{STYLE}</style></head><body>\n{body}\n'
            f'<hr><p><small>Rendered from <code>.agents/chatdoc/{src.name}</code>.</small></p>\n</body></html>')
    out = src.with_suffix(".html")
    out.write_text(html)
    print("rendered", out)
