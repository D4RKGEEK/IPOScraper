'use strict';

/**
 * offset.js — Phase 1, Step 3: Offset correction.
 *
 * IPO PDFs number pages from "1" on the cover, but the PDF index starts from 0
 * and may include unnumbered pages (blank, legal notices). This module computes
 * the offset between printed page numbers and actual PDF page indices.
 */

const { getPageTexts } = require('../convert/pdf-bridge');
const { logger } = require('../../utils/logger');

const log = logger.child({ module: 'extraction:offset' });

/**
 * Find the offset between printed page numbers and PDF page indices.
 *
 * Strategy: take high-confidence ToC entries, try offsets 0..maxOffset,
 * and check if the heading text appears on the expected PDF page.
 *
 * @param {string} pdfPath
 * @param {object} tocMapping   { SECTION_KEY: { printedPage, matchedHeading, confidence } }
 * @param {number} totalPages   Total pages in the PDF
 * @param {number} [maxOffset=40]
 * @returns {Promise<number|null>} The offset to add to (printedPage - 1), or null if unfound
 */
async function findOffset(pdfPath, tocMapping, totalPages, maxOffset = 40) {
  // Only use high-confidence entries as anchors, sorted by page
  const candidates = Object.entries(tocMapping)
    .filter(([, v]) => v.confidence === 'high' && v.printedPage)
    .sort((a, b) => a[1].printedPage - b[1].printedPage);

  if (candidates.length === 0) {
    log.warn('no high-confidence ToC entries to compute offset');
    return null;
  }

  for (const [key, info] of candidates) {
    const heading = (info.matchedHeading || '').toLowerCase().trim();
    if (!heading) continue;

    // Extract just the heading text (before the dots/page number)
    const headingClean = heading.replace(/[.\s\t]{2,}\d{1,4}\s*$/, '').trim();
    const searchStr = headingClean.slice(0, 30); // first 30 chars to match
    if (!searchStr) continue;

    const printedPage = info.printedPage;

    for (let offset = 0; offset <= maxOffset; offset++) {
      const idx = printedPage - 1 + offset;
      if (idx >= totalPages) break;

      const pages = await getPageTexts(pdfPath, idx, idx);
      if (!pages.length) continue;

      const pageText = pages[0].text.toLowerCase();

      if (pageText.slice(0, 800).includes(searchStr)) {
        log.info({ offset, anchor: key, printedPage, pdfIndex: idx }, 'offset found');
        return offset;
      }
    }
  }

  log.warn('could not determine page offset');
  return null;
}

/**
 * Apply the offset to all ToC entries and compute (start, end) page ranges.
 *
 * Each section's range ends where the next section begins (minus 1).
 * The last section extends to the end of the document.
 *
 * @param {object} tocMapping   { SECTION_KEY: { printedPage, ... } }
 * @param {number} offset       Offset from findOffset()
 * @param {number} totalPages   Total pages in the PDF
 * @returns {object} { SECTION_KEY: [startPage, endPage] }  (0-indexed)
 */
function computeRanges(tocMapping, offset, totalPages) {
  // Sort sections by printed page
  const sections = Object.entries(tocMapping)
    .filter(([, v]) => v.printedPage != null)
    .map(([key, v]) => [key, v.printedPage])
    .sort((a, b) => a[1] - b[1]);

  const ranges = {};
  for (let i = 0; i < sections.length; i++) {
    const [section, printedPage] = sections[i];
    const start = printedPage - 1 + offset;

    // End = start of next section - 1, or end of doc
    let end;
    if (i + 1 < sections.length) {
      end = sections[i + 1][1] - 1 + offset - 1;
    } else {
      end = totalPages - 1;
    }

    ranges[section] = [
      Math.max(0, start),
      Math.max(start, Math.min(end, totalPages - 1)),
    ];
  }

  return ranges;
}

module.exports = { findOffset, computeRanges };
