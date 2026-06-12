'use strict';

/**
 * documentDispatcher.js — submit an IPO's document URLs (drhp/rhp) to the
 * extraction pipeline REST API (PRD v2.1 §4: ingest is API-driven — the scraper
 * supplies PDF links; the extraction service fetches them).
 *
 * The extraction service runs separately (`npm run extraction`); this module
 * only POSTs links and never blocks the scrape on extraction work.
 */

/**
 * @param {object} ipo  scraper IPO doc: { slug, companyName, documents: { drhp|rhp: { url } } }
 * @param {object} [opts] { baseUrl?, apiKey?, fetch? }
 * @returns {Promise<Array<{docType, url, status?, documentId?, deduped?, error?}>>}
 */
async function dispatchIpoDocuments(ipo, opts = {}) {
  const base = (opts.baseUrl
    || process.env.EXTRACTION_API_URL
    || `http://localhost:${process.env.EXTRACTION_PORT || 8090}`).replace(/\/+$/, '');
  const apiKey = opts.apiKey || process.env.SERVICE_API_KEY || '';
  const fetchFn = opts.fetch || fetch;

  const results = [];
  for (const [docType, doc] of Object.entries(ipo.documents || {})) {
    const url = doc && doc.url;
    if (!url) continue;
    try {
      const res = await fetchFn(`${base}/v1/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({
          pdfUrl: url,
          ipoSlug: ipo.slug,
          meta: { scrapedBy: 'ipo-backend', docType, company: ipo.companyName || null },
        }),
      });
      const body = await res.json().catch(() => ({}));
      results.push({ docType, url, status: res.status, documentId: body.documentId || null, deduped: !!body.deduped });
    } catch (e) {
      results.push({ docType, url, error: e.message });
    }
  }
  return results;
}

module.exports = { dispatchIpoDocuments };
