'use strict';

/**
 * toc-regex.js — Phase 1, Step 1: FREE regex-based ToC parsing.
 *
 * Scans the first N pages of a PDF for a "TABLE OF CONTENTS" heading,
 * then matches ToC lines like "Capital Structure ............. 45" against
 * the section alias dictionary.
 */

const { getPageTexts } = require('../convert/pdf-bridge');
const { SECTION_ALIASES } = require('../config');
const { logger } = require('../../utils/logger');

const log = logger.child({ module: 'extraction:toc-regex' });

// Pattern: "heading text ......... 45" or "heading text    45"
const LINE_PATTERN = /^(.*?)[.\s\t]{2,}(\d{1,4})\s*$/;

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

  // Expand to include up to 5 consecutive pages from the first ToC page
  const first = tocPages[0];
  const expanded = [];
  for (let i = first; i < Math.min(first + 5, nPages); i++) {
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
 * @returns {Promise<object>} { SECTION_KEY: { printedPage, matchedHeading, confidence } }
 */
async function regexExtractTocMapping(pdfPath, tocPages) {
  if (!tocPages.length) return {};

  const mapping = {};
  const pages = await getPageTexts(pdfPath, tocPages[0], tocPages[tocPages.length - 1]);

  for (const { text } of pages) {
    const lines = text.split('\n');

    for (const rawLine of lines) {
      const line = rawLine.trim();
      const match = LINE_PATTERN.exec(line);
      if (!match) continue;

      const headingText = match[1].trim().toLowerCase();
      const pageNum = parseInt(match[2], 10);

      for (const [sectionKey, aliases] of Object.entries(SECTION_ALIASES)) {
        if (mapping[sectionKey]) continue; // already found

        for (const alias of aliases) {
          if (headingText.includes(alias)) {
            mapping[sectionKey] = {
              printedPage: pageNum,
              matchedHeading: line,
              confidence: 'high',
            };
            log.debug({ section: sectionKey, page: pageNum, heading: line }, 'regex matched');
            break;
          }
        }
      }
    }
  }

  return mapping;
}

module.exports = { findTocPages, regexExtractTocMapping };
