'use strict';

/**
 * historicalService.js — for listed IPOs, fetch post-listing daily candles from
 * Upstox and derive listing price, current price, day high/low, and listing gain.
 */

const { fetchDailyCandles, formatDate } = require('../scrapers/candleFetcher');
const { collections } = require('../db/mongo');

/** Derive the historical block from candles (sorted ascending) + issue price. */
function deriveHistorical(candles, issuePrice) {
  if (!candles || !candles.length) return null;
  const asc = [...candles].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const first = asc[0];
  const last = asc[asc.length - 1];
  const listingPrice = first.open ?? first.close ?? null;
  const openingGain = (listingPrice != null && issuePrice)
    ? Math.round(((listingPrice - issuePrice) / issuePrice) * 10000) / 100
    : null;
  return {
    listingPrice,
    dayHigh: first.high ?? null,
    dayLow: first.low ?? null,
    currentPrice: last.close ?? null,
    openingGain,
    asOf: last.date || null,
  };
}

/**
 * @param {object} [opts] { status?: 'listed', since?: 'YYYY-MM-DD', limit?: number, accessToken? }
 */
async function runHistorical(opts = {}) {
  const log = opts.log || (() => {});
  const ipos = collections.ipos();
  const token = opts.accessToken || process.env.UPSTOX_ACCESS_TOKEN;
  if (!token) return { processed: 0, results: [], skipped: [{ reason: 'missing UPSTOX_ACCESS_TOKEN' }] };

  const filter = { status: opts.status || 'listed', isin: { $type: 'string' } };
  if (opts.since) filter.listingDate = { $gte: opts.since };
  const limit = Math.min(100, opts.limit || 10);
  const targets = await ipos.find(filter).limit(limit).toArray();
  log(`${targets.length} listed IPOs to process`);

  const results = [];
  const skipped = [];
  const now = new Date().toISOString();

  for (const ipo of targets) {
    const from = (ipo.listingDate || '').slice(0, 10) || formatDate(new Date(Date.now() - 365 * 864e5));
    const issuePrice = ipo.issuePrice || (ipo.priceBand && ipo.priceBand.max) || null;
    try {
      const candles = await fetchDailyCandles(ipo.isin, from, formatDate(new Date()), token);
      const hist = deriveHistorical(candles, issuePrice);
      if (!hist) { skipped.push({ slug: ipo.slug, reason: 'no candle data' }); continue; }
      await ipos.updateOne({ slug: ipo.slug }, { $set: { historical: hist, updatedAt: now } });
      log(`${ipo.slug}: listing ${hist.listingPrice} → current ${hist.currentPrice} (${hist.openingGain}%)`);
      results.push({ slug: ipo.slug, isin: ipo.isin, listingDate: ipo.listingDate, ...hist });
    } catch (e) {
      skipped.push({ slug: ipo.slug, reason: e.message });
    }
  }
  return { processed: results.length, results, skipped };
}

module.exports = { runHistorical, deriveHistorical };
