'use strict';

/**
 * toc-regex.js — Phase 1, Step 1: FREE regex-based ToC parsing.
 *
 * Scans the first N pages of a PDF for a "TABLE OF CONTENTS" heading,
 * then matches ToC lines like "Capital Structure ............. 45" against
 * the section alias dictionary.
 */

const { getPageTexts } = require('../convert/pdf-bridge');
const { getSectionAliases } = require('../config');
const { logger } = require('../../utils/logger');

const log = logger.child({ module: 'extraction:toc-regex' });

// Pattern: "heading text ......... 45" or "heading text    45"
const LINE_PATTERN = /^(.*?)[.\s\t]{2,}(\d{1,4})\s*$/;

// A page is considered part of the ToC only if it has at least this many
// dot-leader / "heading ... number" lines. Real content pages rarely do.
const TOC_LINE_THRESHOLD = 3;

// How many pages past the first ToC page we are willing to scan while they
// still look like a ToC.
const MAX_TOC_WINDOW = 5;

/**
 * Heuristic: does this page text look like a Table of Contents page?
 * True when it contains several "heading .......... 45" style lines.
 *
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeToc(text) {
  let hits = 0;
  for (const rawLine of text.split('\n')) {
    if (LINE_PATTERN.test(rawLine.trim())) {
      hits++;
      if (hits >= TOC_LINE_THRESHOLD) return true;
    }
  }
  return false;
}

/**
 * Find which pages contain a Table of Contents heading.
 * Scans the first `nPages` pages for "TABLE OF CONTENTS" or standalone "CONTENTS".
 *
 * @param {string} pdfPath
 * @param {number} [nPages=15]
 * @returns {Promise<number[]>} 0-indexed page indices
 */
async function findTocPages(pdfPath, nPages = 15) {
  const pages = await getPageTexts(pdfPath, 0, nPages - 1);

  // Build a quick lookup of page index -> text for the expansion step.
  const textByPage = new Map(pages.map((p) => [p.page, p.text]));

  const tocPages = [];
  for (const { page, text } of pages) {
    const lower = text.toLowerCase();
    if (
      lower.includes('table of contents') ||
      /^\s*contents\s*$/im.test(text)
    ) {
      tocPages.push(page);
    }
  }

  if (tocPages.length === 0) return [];

  // Expand from the first ToC page, but only keep following pages while they
  // still look like a ToC. This stops us from scanning real content pages
  // (which would otherwise produce false section/page matches downstream).
  const first = tocPages[0];
  const expanded = [first];
  for (let i = first + 1; i < first + MAX_TOC_WINDOW; i++) {
    const text = textByPage.get(i);
    if (text == null || !looksLikeToc(text)) break;
    expanded.push(i);
  }

  log.debug({ tocPages: expanded }, 'found ToC pages');
  return expanded;
}

/**
 * Parse ToC lines with regex and match against section aliases.
 *
 * @param {string} pdfPath
 * @param {number[]} tocPages  0-indexed page indices to scan
 * @param {number} [totalPages]  Total pages in the PDF; used to reject
 *                               implausible page numbers (e.g. a year read as a page)
 * @returns {Promise<object>} { SECTION_KEY: { printedPage, matchedHeading, confidence } }
 */
async function regexExtractTocMapping(pdfPath, tocPages, totalPages) {
  if (!tocPages.length) return {};

  const SECTION_ALIASES = getSectionAliases();

  // A printed page number is plausible only if it's >= 1 and not larger than
  // the document. When totalPages is unknown, accept anything positive.
  const isPlausiblePage = (n) =>
    Number.isInteger(n) && n >= 1 && (totalPages == null || n <= totalPages);

  const mapping = {};
  const pages = await getPageTexts(pdfPath, tocPages[0], tocPages[tocPages.length - 1]);

  // First Pass: Single-line matching (existing logic)
  for (const { text } of pages) {
    const lines = text.split('\n');

    for (const rawLine of lines) {
      const line = rawLine.trim();
      const match = LINE_PATTERN.exec(line);
      if (!match) continue;

      const headingText = match[1].trim().toLowerCase();
      const pageNum = parseInt(match[2], 10);
      if (!isPlausiblePage(pageNum)) continue;

      for (const [sectionKey, aliases] of Object.entries(SECTION_ALIASES)) {
        if (mapping[sectionKey]) continue; // already found

        for (const alias of aliases) {
          if (headingText.includes(alias)) {
            mapping[sectionKey] = {
              printedPage: pageNum,
              matchedHeading: line,
              confidence: 'high',
            };
            log.info({ section: sectionKey, page: pageNum, heading: line }, 'regex matched');
            break;
          }
        }
      }
    }
  }

  // Second Pass: Multi-line matching (appended for any sections still missing)
  for (const { text } of pages) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headingText = line.toLowerCase();

      for (const [sectionKey, aliases] of Object.entries(SECTION_ALIASES)) {
        if (mapping[sectionKey]) continue; // already found by first pass or previously

        for (const alias of aliases) {
          if (headingText === alias || (headingText.length < 100 && headingText.includes(alias))) {
            let pageNum = null;
            let matchedNextLine = '';

            // Check if the next line or the line after is a standalone number
            if (i + 1 < lines.length && /^\d{1,4}$/.test(lines[i + 1])) {
              pageNum = parseInt(lines[i + 1], 10);
              matchedNextLine = lines[i + 1];
            } else if (i + 2 < lines.length && /^\d{1,4}$/.test(lines[i + 2])) {
              pageNum = parseInt(lines[i + 2], 10);
              matchedNextLine = lines[i + 2];
            }

            if (pageNum !== null && isPlausiblePage(pageNum)) {
              // Multi-line matches are weaker than dot-leader matches, so mark
              // them 'medium'. Offset detection (offset.js) only anchors on
              // 'high' entries, so this keeps a shaky guess from poisoning the
              // offset — which would otherwise mislocate every section.
              mapping[sectionKey] = {
                printedPage: pageNum,
                matchedHeading: `${line} -> ${matchedNextLine}`,
                confidence: 'medium',
              };
              log.info({ section: sectionKey, page: pageNum, heading: line }, 'regex multi-line matched');
              break;
            }
          }
        }
      }
    }
  }

  return mapping;
}

module.exports = { findTocPages, regexExtractTocMapping };
