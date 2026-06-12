const axios = require('axios');

const UPSTOX_CANDLE_URL = 'https://api.upstox.com/v2/historical-candle';

/**
 * Build the Upstox instrument key for historical candle fetching.
 * Upstox uses format: NSE_EQ|{ISIN} or BSE_EQ|{ISIN}
 * @param {string} isin
 * @param {string} [exchange='NSE_EQ']
 * @returns {string}
 */
function buildInstrumentKey(isin, exchange = 'NSE_EQ') {
  return `${exchange}|${isin}`;
}

/**
 * Format a Date to YYYY-MM-DD string.
 * @param {Date} date
 * @returns {string}
 */
function formatDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Fetch daily OHLCV candles from Upstox for a given ISIN.
 * Tries NSE_EQ first, falls back to BSE_EQ on 4xx.
 *
 * @param {string} isin         - ISIN of the listed instrument
 * @param {string} fromDate     - Start date YYYY-MM-DD
 * @param {string} toDate       - End date YYYY-MM-DD (defaults to today)
 * @param {string} accessToken  - Upstox Bearer token
 * @returns {Promise<Array>}    Array of { date, open, high, low, close, volume, oi }
 */
async function fetchDailyCandles(isin, fromDate, toDate, accessToken) {
  if (!isin) throw new Error('fetchDailyCandles: isin is required');
  if (!accessToken) throw new Error('fetchDailyCandles: accessToken is required');

  const resolvedTo = toDate || formatDate(new Date());
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  };

  const exchanges = ['NSE_EQ', 'BSE_EQ'];

  for (const exchange of exchanges) {
    const instrumentKey = encodeURIComponent(buildInstrumentKey(isin, exchange));
    const url = `${UPSTOX_CANDLE_URL}/${instrumentKey}/day/${resolvedTo}/${fromDate}`;

    try {
      const response = await axios.get(url, { headers, timeout: 15000 });
      const candles = response.data?.data?.candles || [];

      // Candle format from Upstox: [timestamp, open, high, low, close, volume, oi]
      return candles.map(c => ({
        date: c[0] ? c[0].split('T')[0] : null,
        open: c[1] ?? null,
        high: c[2] ?? null,
        low: c[3] ?? null,
        close: c[4] ?? null,
        volume: c[5] ?? null,
        oi: c[6] ?? null,
      }));
    } catch (err) {
      const status = err.response?.status;
      // On 404/400 try next exchange; on other errors, warn and return empty
      if (status === 404 || status === 400) {
        console.warn(`[candleFetcher] ${exchange} not found for ${isin}, trying next...`);
        continue;
      }
      console.warn(`[candleFetcher] Error fetching candles for ${isin} (${exchange}): ${err.message}`);
      return [];
    }
  }

  console.warn(`[candleFetcher] No candle data found for ${isin} on any exchange`);
  return [];
}

/**
 * Fetch and append daily candle history to all listed IPO records.
 * Only processes records with status='listed' and a valid ISIN.
 * Merges new candles into existing priceHistory array (deduplicates by date).
 *
 * @param {Array}  ipoRecords   - Array of IPO master records
 * @param {object} [options]
 * @param {string} [options.accessToken]  - Upstox token (falls back to UPSTOX_ACCESS_TOKEN env)
 * @param {string} [options.fromDate]     - Start date YYYY-MM-DD (defaults to 1 year ago)
 * @param {string} [options.toDate]       - End date YYYY-MM-DD (defaults to today)
 * @param {number} [options.delayMs=300]  - Delay between API calls
 * @returns {Promise<{ updated: number, skipped: number, errors: number }>}
 */
async function fetchAndMergeCandles(ipoRecords, options = {}) {
  const {
    accessToken = process.env.UPSTOX_ACCESS_TOKEN,
    fromDate,
    toDate,
    delayMs = 300,
  } = options;

  if (!accessToken) {
    throw new Error('fetchAndMergeCandles: UPSTOX_ACCESS_TOKEN is required');
  }

  const resolvedFrom = fromDate || formatDate(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000));
  const resolvedTo = toDate || formatDate(new Date());

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const record of ipoRecords) {
    // Only fetch for listed IPOs with an ISIN
    if (record.status !== 'listed' || !record.isin) {
      skipped++;
      continue;
    }

    await new Promise(r => setTimeout(r, delayMs));

    try {
      const candles = await fetchDailyCandles(record.isin, resolvedFrom, resolvedTo, accessToken);

      if (candles.length === 0) {
        skipped++;
        continue;
      }

      // Merge: build date-keyed map of existing candles
      const existing = {};
      if (Array.isArray(record.priceHistory)) {
        for (const c of record.priceHistory) {
          if (c.date) existing[c.date] = c;
        }
      }

      // Add new candles, preserving existing ones
      for (const c of candles) {
        if (c.date) existing[c.date] = c;
      }

      // Sort by date ascending
      record.priceHistory = Object.values(existing).sort((a, b) =>
        (a.date || '').localeCompare(b.date || '')
      );

      updated++;
    } catch (err) {
      console.error(`[candleFetcher] Failed for ${record.isin}: ${err.message}`);
      errors++;
    }
  }

  return { updated, skipped, errors };
}

/**
 * Fetch today's candle only for a given ISIN.
 * @param {string} isin
 * @param {string} accessToken
 * @returns {Promise<object|null>}
 */
async function fetchTodayCandle(isin, accessToken) {
  const today = formatDate(new Date());
  const candles = await fetchDailyCandles(isin, today, today, accessToken);
  return candles.length > 0 ? candles[0] : null;
}

module.exports = {
  fetchDailyCandles,
  fetchTodayCandle,
  fetchAndMergeCandles,
  buildInstrumentKey,
  formatDate,
};
