const axios = require('axios');

// InvestorGain web JSON endpoints (the public api.* host is dead).
const GMP_LIST_URL = 'https://webnodejs.investorgain.com/cloud/v2/index/gmp-data';
const GMP_DETAIL_URL = (id) => `https://webnodejs.investorgain.com/cloud/v2/ipo/ipo-gmp-read/${id}/true?v=17-17`;
const IG_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  Accept: 'application/json',
  Referer: 'https://www.investorgain.com/',
};

/** Pull the numeric IPO id out of an InvestorGain href like /gmp/foo-ipo/2199/. */
function extractGmpId(href) {
  const m = String(href || '').match(/\/(\d+)\/?$/);
  return m ? Number(m[1]) : null;
}

/** "09-06-2026" (DD-MM-YYYY) -> "2026-06-09". */
function igDateToIso(s) {
  const m = String(s || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/**
 * Normalize a company name for matching purposes.
 * @param {string} name
 * @returns {string}
 */
function normalizeName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/\b(limited|ltd\.?|ipo)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fetch GMP snapshot list from InvestorGain.
 * Returns array of { companyName, gmp, price, estimatedListingPrice, lastUpdated }
 * @returns {Promise<Array>}
 */
async function fetchGmpList() {
  try {
    const response = await axios.get(GMP_LIST_URL, { timeout: 15000, headers: IG_HEADERS });
    const items = (response.data && response.data.gmpList) || [];
    return items.map(item => ({
      companyName: item.company_short_name || null,
      id: extractGmpId(item.gmp_href || item.href),
      gmp: parseFloat(item.gmp) || 0,
      price: parseFloat(item.ipo_price) || null,
      gmpPercent: parseFloat(item.gmp_perc) || null,
      category: item.ipo_category || null,   // SME | Mainboard
      status: item.ipo_status || null,       // U/O/... InvestorGain code
      lastUpdated: new Date().toISOString(),
    }));
  } catch (err) {
    console.warn(`[gmpCrawler] fetchGmpList failed: ${err.message}`);
    return [];
  }
}

/**
 * Fetch the GMP history series for a specific IPO by its InvestorGain id.
 * @param {number} id  InvestorGain ipo id (from fetchGmpList entry.id)
 * @returns {Promise<Array>} Array of { date (ISO), gmp } ascending-agnostic
 */
async function fetchGmpHistory(id) {
  if (!id) return [];
  try {
    const response = await axios.get(GMP_DETAIL_URL(id), { timeout: 15000, headers: IG_HEADERS });
    const rows = (response.data && response.data.ipoGmpData) || [];
    return rows
      .map(r => ({ date: igDateToIso(r.gmp_date), gmp: parseFloat(r.gmp) || 0 }))
      .filter(r => r.date);
  } catch (err) {
    console.warn(`[gmpCrawler] fetchGmpHistory(${id}) failed: ${err.message}`);
    return [];
  }
}

/**
 * Match a GMP list entry to an IPO master record by company name similarity.
 * Uses simple normalized substring matching.
 * @param {object} gmpEntry  - { companyName, ... }
 * @param {Array}  ipoList   - Array of IPO master records
 * @returns {object|null}    Matched IPO record or null
 */
function matchGmpToIpo(gmpEntry, ipoList) {
  if (!gmpEntry.companyName) return null;
  const gmpNorm = normalizeName(gmpEntry.companyName);

  for (const ipo of ipoList) {
    const ipoNorm = normalizeName(ipo.companyName);
    if (!ipoNorm) continue;

    // Exact normalized match
    if (gmpNorm === ipoNorm) return ipo;

    // Substring match (one contains the other)
    if (gmpNorm.length >= 4 && ipoNorm.includes(gmpNorm)) return ipo;
    if (ipoNorm.length >= 4 && gmpNorm.includes(ipoNorm)) return ipo;
  }

  return null;
}

/**
 * Fetch GMP snapshot and detailed histories, then merge into IPO master records.
 * Mutates records in-place by adding gmp and gmpHistory fields.
 *
 * @param {Array} ipoRecords  - Array of IPO master records (from ipo_master.json)
 * @param {object} [options]
 * @param {boolean} [options.fetchHistory=true] - Whether to fetch per-IPO daily histories
 * @param {number} [options.historyDelayMs=200]  - Delay between history API calls
 * @returns {Promise<{ updated: number, skipped: number }>}
 */
async function crawlAndMergeGmp(ipoRecords, options = {}) {
  const { fetchHistory = true, historyDelayMs = 200 } = options;

  let updated = 0;
  let skipped = 0;

  // Step 1: Fetch snapshot list
  const gmpList = await fetchGmpList();
  console.log(`[gmpCrawler] Fetched ${gmpList.length} GMP snapshot entries`);

  // Step 2: Match each GMP entry to a master record and update snapshot
  for (const gmpEntry of gmpList) {
    const match = matchGmpToIpo(gmpEntry, ipoRecords);
    if (!match) {
      skipped++;
      continue;
    }

    match.gmp = {
      current: gmpEntry.gmp,
      gmpPercent: gmpEntry.gmpPercent,
      id: gmpEntry.id,
      lastUpdated: gmpEntry.lastUpdated,
    };
    updated++;
  }

  // Step 3: Optionally fetch per-IPO daily history for matched records
  if (fetchHistory) {
    for (const record of ipoRecords) {
      if (!record.gmp) continue;

      await new Promise(r => setTimeout(r, historyDelayMs));

      const history = await fetchGmpHistory(record.gmp.id);
      if (history.length > 0) {
        record.gmpHistory = history;
      }
    }
  }

  return { updated, skipped };
}

module.exports = {
  fetchGmpList,
  fetchGmpHistory,
  matchGmpToIpo,
  crawlAndMergeGmp,
  normalizeName,
  extractGmpId,
  igDateToIso,
};
