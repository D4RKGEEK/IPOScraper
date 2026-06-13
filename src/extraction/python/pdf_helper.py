#!/usr/bin/env python3
"""
pdf_helper.py — Thin CLI wrapper around PyMuPDF + pymupdf4llm.

Called from Node.js via child_process.execFile(). All output is JSON on stdout.

Commands:
  page_count <pdf_path>
  text       <pdf_path> <start_page> <end_page>
  markdown   <pdf_path> <start_page> <end_page>

Output format:
  {"ok": true,  "data": <string or int>}
  {"ok": false, "error": "<message>"}
"""

import json
import sys

def respond(data):
    print(json.dumps({"ok": True, "data": data}))
    sys.exit(0)

def fail(msg):
    print(json.dumps({"ok": False, "error": str(msg)}))
    sys.exit(1)

def cmd_page_count(pdf_path):
    import fitz
    doc = fitz.open(pdf_path)
    count = len(doc)
    doc.close()
    respond(count)

def cmd_text(pdf_path, start_page, end_page):
    import fitz
    doc = fitz.open(pdf_path)
    pages = []
    for i in range(start_page, min(end_page + 1, len(doc))):
        pages.append({
            "page": i,
            "text": doc[i].get_text()
        })
    doc.close()
    respond(pages)

def cmd_markdown(pdf_path, start_page, end_page):
    import pymupdf4llm
    page_list = list(range(start_page, end_page + 1))
    md = pymupdf4llm.to_markdown(pdf_path, pages=page_list)
    respond(md)

def main():
    if len(sys.argv) < 3:
        fail("Usage: pdf_helper.py <command> <pdf_path> [args...]")

    command = sys.argv[1]
    pdf_path = sys.argv[2]

    try:
        if command == "page_count":
            cmd_page_count(pdf_path)
        elif command == "text":
            if len(sys.argv) < 5:
                fail("Usage: pdf_helper.py text <pdf_path> <start_page> <end_page>")
            cmd_text(pdf_path, int(sys.argv[3]), int(sys.argv[4]))
        elif command == "markdown":
            if len(sys.argv) < 5:
                fail("Usage: pdf_helper.py markdown <pdf_path> <start_page> <end_page>")
            cmd_markdown(pdf_path, int(sys.argv[3]), int(sys.argv[4]))
        else:
            fail(f"Unknown command: {command}")
    except Exception as e:
        fail(str(e))

if __name__ == "__main__":
    main()
