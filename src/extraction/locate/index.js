'use strict';

/**
 * locate/index.js — Phase 1 orchestrator: getSectionRanges().
 *
 * Runs the 4-step cheapest-first cascade to find page ranges for each target
 * section in a PDF prospectus:
 *   Step 1: Regex ToC parsing (free, instant)
 *   Step 2: LLM ToC fallback (only for missing sections)
 *   Step 3: Offset correction (printed page ≠ PDF index)
 *   Step 4: LLM page-scan (last resort, per missing section)
 *
 * Returns { SECTION_KEY: { range: [start, end] | null, method: string } }
 */

const { findTocPages, regexExtractTocMapping } = require('./toc-regex');
const { llmTocMapping } = require('./toc-llm');
const { findOffset, computeRanges } = require('./offset');
const { llmFallbackLocate } = require('./page-scan');
const { getPageCount } = require('../convert/pdf-bridge');
const { TARGET_SECTIONS } = require('../config');
const { logger } = require('../../utils/logger');

const log = logger.child({ module: 'extraction:locate' });

/**
 * Find page ranges for target sections in a PDF prospectus.
 *
 * @param {string} pdfPath          Path to the PDF file
 * @param {string[]} [targetSections]  Section keys to locate (defaults to TARGET_SECTIONS)
 * @param {function} [progressLog]    Optional logging callback
 * @returns {Promise<object>} { SECTION_KEY: { range: [start, end] | null, method: string } }
 */
async function getSectionRanges(pdfPath, targetSections, progressLog) {
  const sections = targetSections || TARGET_SECTIONS;
  const logMsg = progressLog || (() => {});

  const totalPages = await getPageCount(pdfPath);
  log.info({ totalPages, sections }, 'starting section location');

  // ── Step 1: Regex ToC (free) ─────────────────────────────────────────────
  const tocPages = await findTocPages(pdfPath);
  let tocMapping = {};
  const regexFound = new Set();

  if (tocPages.length) {
    tocMapping = await regexExtractTocMapping(pdfPath, tocPages, totalPages);
    for (const key of Object.keys(tocMapping)) regexFound.add(key);
    logMsg(`regex ToC found: ${Object.keys(tocMapping).join(', ') || 'none'}`);
  } else {
    logMsg('no ToC pages found, will rely on LLM');
  }

  // ── Step 2: LLM ToC for what regex missed ────────────────────────────────
  const missing = sections.filter((s) => !tocMapping[s]);
  if (missing.length) {
    logMsg(`LLM ToC fallback for: ${missing.join(', ')}`);
    try {
      const llmMap = await llmTocMapping(pdfPath, missing, tocPages);
      for (const [key, val] of Object.entries(llmMap)) {
        if (val.printedPage != null) tocMapping[key] = val;
      }
    } catch (e) {
      log.warn({ err: e.message }, 'LLM ToC fallback failed');
      logMsg(`LLM ToC fallback failed: ${e.message}`);
    }
  }

  // ── Step 3: Offset correction → page ranges ─────────────────────────────
  let offset = null;
  let ranges = {};

  if (Object.keys(tocMapping).length) {
    offset = await findOffset(pdfPath, tocMapping, totalPages);
    if (offset !== null) {
      ranges = computeRanges(tocMapping, offset, totalPages);
      logMsg(`offset: ${offset}, computed ranges for ${Object.keys(ranges).length} sections`);
    } else {
      logMsg('could not determine page offset');
    }
  }

  // ── Step 4: Final pass — page-scan for missing / low-confidence ──────────
  const finalRanges = {};

  for (const section of sections) {
    const r = ranges[section];
    const confidence = tocMapping[section]?.confidence || 'low';

    if (r == null || confidence === 'low' || offset === null) {
      // Need LLM page-scan
      logMsg(`page-scanning for ${section}...`);
      try {
        const fb = await llmFallbackLocate(pdfPath, section);
        if (fb) {
          finalRanges[section] = { range: fb, method: 'llm_page_scan' };
        } else if (r) {
          // Use the ToC-derived range even if low confidence
          finalRanges[section] = { range: r, method: 'toc_low_confidence' };
        } else {
          finalRanges[section] = { range: null, method: 'not_found' };
        }
      } catch (e) {
        log.warn({ section, err: e.message }, 'page-scan failed');
        if (r) {
          finalRanges[section] = { range: r, method: 'toc_low_confidence' };
        } else {
          finalRanges[section] = { range: null, method: 'not_found' };
        }
      }
    } else {
      const method = regexFound.has(section) ? 'regex_toc' : 'llm_toc';
      finalRanges[section] = { range: r, method };
    }
  }

  const found = Object.values(finalRanges).filter((v) => v.range).length;
  logMsg(`located ${found}/${sections.length} sections`);
  log.info({ finalRanges }, 'section location complete');

  return finalRanges;
}

module.exports = { getSectionRanges };
