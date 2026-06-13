'use strict';

/**
 * toc-llm.js — Phase 1, Step 2: LLM-based ToC fallback.
 *
 * For sections the regex missed, sends only the ToC pages (minimal tokens)
 * to the LLM and asks it to find printed page numbers.
 */

const { getPageTexts } = require('../convert/pdf-bridge');
const { getSectionAliases } = require('../config');
const { callLlmJson } = require('../llm/client');
const { logger } = require('../../utils/logger');

const log = logger.child({ module: 'extraction:toc-llm' });

/**
 * Ask the LLM to find printed page numbers for missing sections by reading
 * only the ToC pages.
 *
 * @param {string} pdfPath
 * @param {string[]} missingSections  Section keys not found by regex
 * @param {number[]} tocPages         0-indexed page indices of the ToC
 * @returns {Promise<object>} { SECTION_KEY: { printedPage, matchedHeading, confidence } }
 */
async function llmTocMapping(pdfPath, missingSections, tocPages) {
  // If no ToC pages were found at all, scan first 5 pages as a guess
  const pagesToSend = tocPages.length ? tocPages : [0, 1, 2, 3, 4];
  const start = pagesToSend[0];
  const end = pagesToSend[pagesToSend.length - 1];

  const pages = await getPageTexts(pdfPath, start, end);

  let text = '';
  for (const { page, text: pageText } of pages) {
    text += `\n=== PDF_PAGE_${page} ===\n${pageText}\n`;
  }

  // Build aliases subset for only the missing sections
  const SECTION_ALIASES = getSectionAliases();
  const aliasesSubset = {};
  for (const key of missingSections) {
    aliasesSubset[key] = SECTION_ALIASES[key] || [key.toLowerCase().replace(/_/g, ' ')];
  }

  const prompt = `Raw text from a DRHP/RHP IPO prospectus (Table of Contents pages).
Find the PRINTED page number for each section below.
Fuzzy-match headings using these aliases:
${JSON.stringify(aliasesSubset, null, 2)}

Return ONLY JSON:
{
  "SECTION_KEY": {
    "printedPage": <int or null>,
    "matchedHeading": "<exact text found, or null>",
    "confidence": "high|medium|low"
  }
}

TEXT:
${text}`;

  log.debug({ missingSections }, 'calling LLM for ToC mapping');

  const result = await callLlmJson(prompt, { cacheNs: 'llm_toc' });

  // Normalize: ensure each entry has the expected shape
  const mapping = {};
  for (const key of missingSections) {
    const entry = result[key];
    if (entry && entry.printedPage != null) {
      mapping[key] = {
        printedPage: typeof entry.printedPage === 'number' ? entry.printedPage : parseInt(entry.printedPage, 10),
        matchedHeading: entry.matchedHeading || null,
        confidence: entry.confidence || 'medium',
      };
      log.debug({ section: key, page: mapping[key].printedPage }, 'LLM found section');
    }
  }

  return mapping;
}

module.exports = { llmTocMapping };
