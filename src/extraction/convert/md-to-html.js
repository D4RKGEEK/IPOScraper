'use strict';

/**
 * md-to-html.js — Convert markdown to styled HTML for Firecrawl ingestion.
 *
 * Firecrawl's /v2/parse expects HTML files. We convert the pymupdf4llm markdown
 * output into clean, styled HTML with table borders and readable typography.
 */

const { marked } = require('marked');

/**
 * Convert markdown text to an HTML body string.
 * @param {string} mdContent  Markdown text
 * @returns {string} HTML body
 */
function markdownToHtml(mdContent) {
  return marked.parse(mdContent, { gfm: true, breaks: false });
}

/**
 * Wrap HTML body in a full styled HTML document.
 * @param {string} htmlBody  HTML from markdownToHtml()
 * @param {string} sectionName  e.g. 'CAPITAL_STRUCTURE'
 * @returns {string} Complete HTML document
 */
function wrapInStyledHtml(htmlBody, sectionName) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>SECTION: ${sectionName}</title>
  <style>
    body { font-family: 'Segoe UI', Tahoma, sans-serif; max-width: 960px; margin: 0 auto; padding: 2rem; line-height: 1.6; color: #222; }
    h1 { color: #1a1a2e; border-bottom: 2px solid #16213e; padding-bottom: 0.5rem; }
    h2 { color: #16213e; margin-top: 2rem; }
    h3 { color: #0f3460; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { border: 1px solid #999; padding: 8px 12px; text-align: left; }
    th { background-color: #e2e8f0; font-weight: 600; }
    tr:nth-child(even) { background-color: #f7fafc; }
    ul, ol { margin: 0.5rem 0; padding-left: 1.5rem; }
    p { margin: 0.5rem 0; }
    strong { font-weight: 600; }
  </style>
</head>
<body>
  <h1>SECTION: ${sectionName}</h1>
  ${htmlBody}
</body>
</html>`;
}

module.exports = { markdownToHtml, wrapInStyledHtml };
