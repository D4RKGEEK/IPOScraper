'use strict';

/**
 * groww.js — Groww IPO source.
 *
 * Lists: open / upcoming / closed (listed shares the "closed" feed).
 *   https://groww.in/v1/api/primaries/v1/ipo/{open?v=2 | upcoming | closed?v=2}
 * Detail (by searchId/slug):
 *   https://groww.in/v1/api/stocks_primary_market_data/v1/ipo/company/{searchId}?isHniEnabled=true
 *
 * Each item carries a `searchId` slug used for the detail call. Output is mapped
 * into the shared standardized record (raw_sources.groww = { list, detail }),
 * so run_pipeline's ISIN/symbol/Jaro-Winkler dedup merges it with NSE/Upstox.
 */

const axios = require('axios');

const LIST_URLS = {
  open: 'https://groww.in/v1/api/primaries/v1/ipo/open?v=2',
  upcoming: 'https://groww.in/v1/api/primaries/v1/ipo/upcoming',
  closed: 'https://groww.in/v1/api/primaries/v1/ipo/closed?v=2',
};
const DETAIL_URL = (searchId) =>
  `https://groww.in/v1/api/stocks_primary_market_data/v1/ipo/company/${searchId}?isHniEnabled=true`;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  Accept: 'application/json',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function requestWithRetry(url, retries = 3, delay = 800) {
  try {
    const res = await axios.get(url, { headers: HEADERS, timeout: 20000 });
    return res.data;
  } catch (error) {
    const status = error.response && error.response.status;
    if ((status === 429 || (status >= 500 && status < 600) || !status) && retries > 0) {
      await sleep(delay);
      return requestWithRetry(url, retries - 1, delay * 2);
    }
    throw error;
  }
}

/** Epoch ms -> ISO date (YYYY-MM-DD), or null. */
function toIsoDate(ms) {
  if (!ms || typeof ms !== 'number') return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Map a Groww status/bucket to the standardized status. */
function mapStatus(bucket, detail) {
  // Listing info overrides: if it has listed, call it listed.
  const listed = detail && detail.listing &&
    (detail.listing.listingPrice != null || (Array.isArray(detail.listing.listedOn) && detail.listing.listedOn.length && detail.status === 'LISTED'));
  if (listed) return 'listed';
  const s = (detail && detail.status ? detail.status : '').toUpperCase();
  if (s === 'LISTED') return 'listed';
  if (s === 'ACTIVE' || s === 'OPEN') return 'open';
  if (s === 'UPCOMING' || s === 'PRE_APPLY') return 'upcoming';
  if (s === 'CLOSED') return 'closed';
  return bucket; // fall back to the feed it came from
}

/** Price band from detail (preferred) or the list item's first category. */
function priceBandOf(listItem, detail) {
  if (detail && detail.minPrice != null) {
    return { minimum: Number(detail.minPrice), maximum: detail.maxPrice != null ? Number(detail.maxPrice) : null };
  }
  const cat = listItem && Array.isArray(listItem.categories) ? listItem.categories[0] : null;
  if (cat && cat.minPrice != null) {
    return { minimum: Number(cat.minPrice), maximum: cat.maxPrice != null ? Number(cat.maxPrice) : null };
  }
  return { minimum: null, maximum: null };
}

/**
 * Map a Groww list item (+ optional detail) into the standardized record.
 * @param {object} listItem
 * @param {object|null} detail
 * @param {string} bucket  open|upcoming|closed
 */
function mapGrowwRecord(listItem, detail, bucket) {
  const li = listItem || {};
  const d = detail || {};
  const biddingStartDate = d.startDate || toIsoDate(li.bidStartTimestamp) || null;
  const docUrl = d.documentUrl || null;
  const status = mapStatus(bucket, d);
  // Groww exposes a single prospectus link without a type. Pre-issue/upcoming
  // links (and SEBI filing pages) are the DRHP; once open/closed it's the RHP.
  const isDraft = !!docUrl && (status === 'upcoming' || /sebi\.gov\.in\/filings/i.test(docUrl));

  const rec = {
    isin: li.isin || d.isin || null,
    symbol: li.symbol || d.symbol || null,
    companyName: d.companyShortName || li.companyName || d.companyName || null,
    status,
    biddingStartDate,
    priceBand: priceBandOf(li, d),
    documentUrls: {
      rhp: isDraft ? null : docUrl,
      drhp: isDraft ? docUrl : null,
    },
    raw_sources: {
      groww: { searchId: li.searchId || d.parentSearchId || null, list: li, detail: detail || null, documentUrl: docUrl, docType: isDraft ? 'drhp' : 'rhp' },
    },
  };
  if (d.listingDate) rec.listingDate = d.listingDate;
  return rec;
}

/**
 * Fetch one status bucket's list.
 * @returns {Promise<object[]>} raw list items
 */
async function fetchList(bucket) {
  const url = LIST_URLS[bucket];
  if (!url) throw new Error(`Unknown Groww bucket: ${bucket}`);
  const data = await requestWithRetry(url);
  const list = (data && (data.ipoList || data.data || data.results)) || [];
  return Array.isArray(list) ? list : [];
}

/**
 * Fetch the detail payload for a Groww IPO by its searchId slug.
 * @returns {Promise<object|null>}
 */
async function fetchDetail(searchId) {
  if (!searchId) return null;
  try {
    return await requestWithRetry(DETAIL_URL(searchId));
  } catch (e) {
    return null; // detail is best-effort; list data still usable
  }
}

/**
 * Fetch Groww IPOs across buckets, mapped to standardized records.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.statuses=['open','upcoming','closed']]
 * @param {boolean} [opts.fetchDetails=true]  also pull per-IPO detail (needed for the document URL)
 * @param {boolean} [opts.docsOnly=false]     keep only the document URL from detail; drop the heavy payload
 * @param {number} [opts.detailDelayMs=120]   pause between detail calls
 * @param {number} [opts.maxDetails]          cap detail calls (e.g. skip the long closed tail)
 * @returns {Promise<object[]>}
 */
async function fetchGrowwIpos(opts = {}) {
  const statuses = opts.statuses || ['open', 'upcoming', 'closed'];
  const fetchDetails = opts.fetchDetails !== false;
  const docsOnly = opts.docsOnly === true;
  const includeListed = opts.includeListed === true; // listed IPOs no longer update
  const delay = opts.detailDelayMs ?? 120;

  // Collect list items per bucket, de-duplicating within Groww by searchId/symbol.
  const seen = new Map(); // key -> { item, bucket }
  for (const bucket of statuses) {
    let list = [];
    try {
      list = await fetchList(bucket);
    } catch (e) {
      console.error(`[groww] list ${bucket} failed: ${e.message}`);
      continue;
    }
    for (const item of list) {
      const key = item.searchId || item.isin || item.symbol;
      if (!key) continue;
      // open/upcoming take precedence over closed for the bucket label
      if (!seen.has(key)) seen.set(key, { item, bucket });
    }
  }

  const entries = [...seen.values()];
  const records = [];
  let detailCount = 0;
  for (const { item, bucket } of entries) {
    let detail = null;
    if (fetchDetails && (opts.maxDetails == null || detailCount < opts.maxDetails)) {
      detail = await fetchDetail(item.searchId);
      detailCount++;
      if (delay) await sleep(delay);
    }
    const rec = mapGrowwRecord(item, detail, bucket);
    if (!includeListed && rec.status === 'listed') continue; // skip listed — no updates
    if (docsOnly && rec.raw_sources.groww) {
      // Keep only what's needed to collect documents; drop financials/subscription/about.
      const g = rec.raw_sources.groww;
      rec.raw_sources.groww = { searchId: g.searchId, documentUrl: detail ? detail.documentUrl || null : null };
    }
    records.push(rec);
  }
  return records;
}

module.exports = { fetchGrowwIpos, fetchList, fetchDetail, mapGrowwRecord, mapStatus, priceBandOf, toIsoDate, LIST_URLS };
