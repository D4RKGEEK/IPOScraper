'use strict';

/**
 * page-scan.js — Phase 1, Step 4: LLM full page-scan fallback.
 *
 * Last resort for sections not found via ToC. Scans the entire document in
 * 15-page chunks, asking the LLM to classify each page as start/end/inside/none.
 */

const { getPageTexts, getPageCount } = require('../convert/pdf-bridge');
const { getSectionAliases } = require('../config');
const { callLlmJson } = require('../llm/client');
const { logger } = require('../../utils/logger');

const log = logger.child({ module: 'extraction:page-scan' });

/**
 * Scan the entire PDF in chunks to locate a specific section.
 *
 * @param {string} pdfPath
 * @param {string} sectionKey  e.g. 'CAPITAL_STRUCTURE'
 * @param {number} [chunkSize=15]
 * @returns {Promise<[number, number]|null>} [startPage, endPage] or null
 */
async function llmFallbackLocate(pdfPath, sectionKey, chunkSize = 15) {
  const aliases = getSectionAliases()[sectionKey] || [sectionKey.toLowerCase().replace(/_/g, ' ')];
  const totalPages = await getPageCount(pdfPath);

  let foundStart = null;
  let foundEnd = null;
  let page = 0;

  log.debug({ section: sectionKey, totalPages }, 'starting LLM page-scan');

  while (page <= totalPages - 1) {
    const chunkEnd = Math.min(page + chunkSize - 1, totalPages - 1);

    const pages = await getPageTexts(pdfPath, page, chunkEnd);

    let chunkText = '';
    for (const { page: idx, text } of pages) {
      // Truncate each page to 2000 chars to limit token usage
      chunkText += `\n=== PDF_PAGE_${idx} ===\n${text.slice(0, 2000)}\n`;
    }

    const prompt = `Locate section "${sectionKey}" (aliases: ${JSON.stringify(aliases)}) in this DRHP/RHP excerpt.
For each PDF_PAGE_<n>, classify: "start", "end", "inside", or "none".

Return ONLY JSON: {"PDF_PAGE_<n>": "start|end|inside|none", ...}

TEXT:
${chunkText}`;

    const result = await callLlmJson(prompt, {
      maxTokens: 1000,
      cacheNs: `page_scan_${sectionKey}`,
    });

    for (let i = page; i <= chunkEnd; i++) {
      const label = result[`PDF_PAGE_${i}`] || 'none';
      if (label === 'start' && foundStart === null) {
        foundStart = i;
      }
      if ((label === 'end' || label === 'inside') && foundStart !== null) {
        foundEnd = i;
      }
    }

    // Early exit when both bounds found
    if (foundStart !== null && foundEnd !== null) {
      log.info({ section: sectionKey, start: foundStart, end: foundEnd }, 'page-scan found section');
      return [foundStart, foundEnd];
    }

    page = chunkEnd + 1;
  }

  if (foundStart !== null) {
    log.info({ section: sectionKey, start: foundStart, end: foundEnd }, 'page-scan partial result');
    return [foundStart, foundEnd || foundStart];
  }

  log.warn({ section: sectionKey }, 'page-scan could not locate section');
  return null;
}

module.exports = { llmFallbackLocate };
