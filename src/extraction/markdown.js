'use strict';

/**
 * markdown.js — pure helpers for the merged section-markdown format.
 *
 * Section markdown files are combined into one document with a delimiter line
 * per section (the same `# SECTION: NAME` header the extractors already emit).
 * Storing this single merged blob in R2 lets a re-extraction reconstruct the
 * individual section files without re-downloading + re-converting the PDF.
 *
 * Both functions are pure (no IO) so the round-trip is unit-testable.
 */

const SECTION_HEADER = /^# SECTION: (.+)$/;

/**
 * Combine section parts into one markdown blob.
 * @param {Array<{name:string, content:string}>} parts
 * @returns {string}
 */
function serializeMergedMarkdown(parts) {
  return (parts || [])
    .map(({ name, content }) => `# SECTION: ${name}\n\n${content}\n`)
    .join('\n\n');
}

/**
 * Split a merged markdown blob back into section parts.
 * @param {string} text
 * @returns {Array<{name:string, content:string}>}
 */
function splitMergedMarkdown(text) {
  if (!text) return [];
  const lines = String(text).split('\n');
  const parts = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(SECTION_HEADER);
    if (m) {
      if (current) parts.push(current);
      current = { name: m[1].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) parts.push(current);
  return parts.map(({ name, lines: body }) => ({
    name,
    // Drop the leading blank line after the header and trailing blank lines.
    content: body.join('\n').replace(/^\n+/, '').replace(/\s+$/, ''),
  }));
}

module.exports = { serializeMergedMarkdown, splitMergedMarkdown, SECTION_HEADER };
