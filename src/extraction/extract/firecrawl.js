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
const { getIpoDetailsSchema } = require('../llm/schema');
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
function convertSectionToHtml(outputDir, section, logMsg) {
  const mdPath = path.join(outputDir, `${section}.md`);
  const content = fs.readFileSync(mdPath, 'utf8');
  const htmlBody = markdownToHtml(content);
  const fullHtml = wrapInStyledHtml(htmlBody, section);
  const htmlPath = path.join(outputDir, `${section}.html`);
  fs.writeFileSync(htmlPath, fullHtml, 'utf8');
  log.info({ section, htmlPath, htmlSize: fullHtml.length }, 'converted section markdown to styled HTML');
  if (logMsg) logMsg(`converted section ${section} markdown to styled HTML (${fullHtml.length} bytes)`);
  return htmlPath;
}

/**
 * Send an HTML file to Firecrawl /v2/parse and get structured JSON.
 *
 * @param {string} htmlPath   Path to the HTML file
 * @param {string} section    Section name (for cache key)
 * @param {string} ipoSlug    IPO slug (for cache key)
 * @param {function} [logMsg] Job progress logger
 * @returns {Promise<object>} Extracted JSON data
 */
async function firecrawlParse(htmlPath, section, ipoSlug, logMsg) {
  // Check cache first
  const cacheKey = generateCacheKey('firecrawl', `firecrawl_v2_${section}_${ipoSlug}`);
  const cached = await getCachedResponse(cacheKey);
  if (cached) {
    log.info({ section, ipoSlug }, 'firecrawl cache hit (loaded from disk cache)');
    if (logMsg) logMsg(`Firecrawl cache hit for section ${section} (loaded from disk cache)`);
    return cached;
  }

  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  const fileName = path.basename(htmlPath);

  // Build multipart form data manually using Blob (Node 18+)
  const options = {
    onlyMainContent: true,
    formats: [{
      type: 'json',
      schema: getIpoDetailsSchema(),
      prompt: 'Extract all available IPO details from this specific prospectus section. For any fields not found, return null.',
    }],
  };

  const formData = new FormData();
  formData.append('file', new Blob([htmlContent], { type: 'text/html' }), fileName);
  formData.append('options', JSON.stringify(options));

  log.info({ section, fileName, fileSize: htmlContent.length, url: env.FIRECRAWL_API_URL }, 'sending HTML file to Firecrawl /v2/parse');
  if (logMsg) logMsg(`sending HTML file ${fileName} (${htmlContent.length} bytes) to Firecrawl /v2/parse...`);

  const res = await fetch(env.FIRECRAWL_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.FIRECRAWL_API_KEY}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text();
    log.error({ section, status: res.status, error: body.slice(0, 500) }, 'Firecrawl API call failed');
    if (logMsg) logMsg(`Firecrawl API call failed for section ${section}: status ${res.status}`);
    return {};
  }

  const responseData = await res.json();
  const extracted = responseData?.data?.json || {};
  
  const populatedFields = Object.keys(extracted).filter(k => extracted[k] !== null && extracted[k] !== undefined && extracted[k] !== '');
  log.info({ section, populatedFieldsCount: populatedFields.length, creditsUsed: responseData.creditsUsed || 0 }, 'Firecrawl parse response received successfully');
  if (logMsg) logMsg(`Firecrawl parsed section ${section} successfully (found ${populatedFields.length} fields)`);

  // Track Firecrawl credits used
  if (typeof responseData.creditsUsed === 'number') {
    recordFirecrawlUsage(responseData.creditsUsed);
  }

  // Cache the result
  await setCachedResponse(cacheKey, extracted);

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
 * @param {function} [logMsg]  Job progress logger
 * @returns {Promise<object[]>} Array of per-section extracted JSON objects
 */
async function runFirecrawlExtraction(outputDir, sections, ipoSlug, logMsg) {
  const sectionResponses = [];

  for (const section of ['COVER_PAGES', ...sections]) {
    const mdPath = path.join(outputDir, `${section}.md`);
    if (!fs.existsSync(mdPath)) {
      log.warn({ section }, 'section markdown not found, skipping');
      if (logMsg) logMsg(`skipping Firecrawl parse for ${section} (markdown not found)`);
      continue;
    }

    try {
      const htmlPath = convertSectionToHtml(outputDir, section, logMsg);
      const extracted = await firecrawlParse(htmlPath, section, ipoSlug, logMsg);
      if (Object.keys(extracted).length > 0) {
        sectionResponses.push(extracted);
      }
    } catch (e) {
      log.warn({ section, err: e.message }, 'Firecrawl extraction failed for section');
      if (logMsg) logMsg(`Firecrawl extraction failed for ${section}: ${e.message}`);
    }
  }

  log.info({ sections: sectionResponses.length }, 'Firecrawl extraction complete');
  return sectionResponses;
}

module.exports = { runFirecrawlExtraction };
