'use strict';

/**
 * firecrawl.js — Phase 3B: Firecrawl per-section extraction.
 *
 * Processes sections individually (avoids payload limits): converts each
 * section's markdown → styled HTML → uploads to Firecrawl /v2/parse → JSON.
 */

const fs = require('fs');
const path = require('path');
const { markdownToHtml, wrapInStyledHtml } = require('../convert/md-to-html');
const { IPO_DETAILS_SCHEMA } = require('../llm/schema');
const { generateCacheKey, getCachedResponse, setCachedResponse } = require('../cache');
const { recordFirecrawlUsage } = require('../usage');
const { env } = require('../config');
const { logger } = require('../../utils/logger');

const log = logger.child({ module: 'extraction:firecrawl' });

/**
 * Convert a section .md file to a styled .html file.
 *
 * @param {string} outputDir  e.g. 'data/output/hexagon-nutrition-ipo'
 * @param {string} section    e.g. 'CAPITAL_STRUCTURE'
 * @returns {string} Path to the generated HTML file
 */
function convertSectionToHtml(outputDir, section) {
  const mdPath = path.join(outputDir, `${section}.md`);
  const content = fs.readFileSync(mdPath, 'utf8');
  const htmlBody = markdownToHtml(content);
  const fullHtml = wrapInStyledHtml(htmlBody, section);
  const htmlPath = path.join(outputDir, `${section}.html`);
  fs.writeFileSync(htmlPath, fullHtml, 'utf8');
  return htmlPath;
}

/**
 * Send an HTML file to Firecrawl /v2/parse and get structured JSON.
 *
 * @param {string} htmlPath   Path to the HTML file
 * @param {string} section    Section name (for cache key)
 * @param {string} ipoSlug    IPO slug (for cache key)
 * @returns {Promise<object>} Extracted JSON data
 */
async function firecrawlParse(htmlPath, section, ipoSlug) {
  // Check cache first
  const cacheKey = generateCacheKey('firecrawl', `firecrawl_v2_${section}_${ipoSlug}`);
  const cached = getCachedResponse(cacheKey);
  if (cached) {
    log.debug({ section }, 'firecrawl cache hit');
    return cached;
  }

  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  const fileName = path.basename(htmlPath);

  // Build multipart form data manually using Blob (Node 18+)
  const options = {
    onlyMainContent: true,
    formats: [{
      type: 'json',
      schema: IPO_DETAILS_SCHEMA,
      prompt: 'Extract all available IPO details from this specific prospectus section. For any fields not found, return null.',
    }],
  };

  const formData = new FormData();
  formData.append('file', new Blob([htmlContent], { type: 'text/html' }), fileName);
  formData.append('options', JSON.stringify(options));

  log.debug({ section, url: env.FIRECRAWL_API_URL }, 'calling Firecrawl');

  const res = await fetch(env.FIRECRAWL_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.FIRECRAWL_API_KEY}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text();
    log.warn({ section, status: res.status, body: body.slice(0, 300) }, 'Firecrawl returned error');
    return {};
  }

  const responseData = await res.json();
  const extracted = responseData?.data?.json || {};

  // Track Firecrawl credits used
  if (typeof responseData.creditsUsed === 'number') {
    recordFirecrawlUsage(responseData.creditsUsed);
  }

  // Cache the result
  setCachedResponse(cacheKey, extracted);

  // Save per-section result
  const savePath = path.join(path.dirname(htmlPath), `summary_${section}.json`);
  fs.writeFileSync(savePath, JSON.stringify(extracted, null, 2), 'utf8');

  return extracted;
}

/**
 * Run Firecrawl extraction for all sections.
 *
 * @param {string} outputDir   e.g. 'data/output/hexagon-nutrition-ipo'
 * @param {string[]} sections  Section names with .md files in outputDir
 * @param {string} ipoSlug     For cache keys
 * @returns {Promise<object[]>} Array of per-section extracted JSON objects
 */
async function runFirecrawlExtraction(outputDir, sections, ipoSlug) {
  const sectionResponses = [];

  for (const section of ['COVER_PAGES', ...sections]) {
    const mdPath = path.join(outputDir, `${section}.md`);
    if (!fs.existsSync(mdPath)) {
      log.warn({ section }, 'section markdown not found, skipping');
      continue;
    }

    try {
      const htmlPath = convertSectionToHtml(outputDir, section);
      const extracted = await firecrawlParse(htmlPath, section, ipoSlug);
      if (Object.keys(extracted).length > 0) {
        sectionResponses.push(extracted);
      }
    } catch (e) {
      log.warn({ section, err: e.message }, 'Firecrawl extraction failed for section');
    }
  }

  log.info({ sections: sectionResponses.length }, 'Firecrawl extraction complete');
  return sectionResponses;
}

module.exports = { runFirecrawlExtraction };
