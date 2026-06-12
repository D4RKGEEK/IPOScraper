'use strict';

/**
 * gmpService.js — fetch grey-market premium from InvestorGain, match to our IPOs
 * by name, store the latest on the IPO and append to the gmp_history time series.
 * Only open/upcoming IPOs are eligible (listed/closed have no live GMP).
 */

const { fetchGmpList, fetchGmpHistory, normalizeName } = require('../scrapers/gmpCrawler');
const { jaroWinkler } = require('../utils/jaroWinkler');
const { collections } = require('../db/mongo');

const ELIGIBLE = new Set(['open', 'upcoming']);

/** Best GMP entry for an IPO by normalized-name match (exact, then Jaro-Winkler). */
function matchGmp(ipo, gmpList) {
  const target = normalizeName(ipo.companyName);
  if (!target) return null;
  let best = null; let bestScore = 0;
  for (const e of gmpList) {
    const n = normalizeName(e.companyName);
    if (!n) continue;
    if (n === target) return e;
    const score = jaroWinkler(n, target);
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return bestScore >= 0.92 ? best : null;
}

/**
 * @param {object} [opts] { slugs?: string[], status?: 'open'|'upcoming'|'all' }
 */
async function runGmp(opts = {}) {
  const log = opts.log || (() => {});
  const ipos = collections.ipos();
  const now = new Date().toISOString();

  let targets;
  if (opts.slugs && opts.slugs.length) {
    targets = await ipos.find({ slug: { $in: opts.slugs } }).toArray();
  } else {
    const statusFilter = (!opts.status || opts.status === 'all') ? { status: { $in: [...ELIGIBLE] } } : { status: opts.status };
    targets = await ipos.find(statusFilter).toArray();
  }

  const gmpList = await fetchGmpList();
  log(`fetched ${gmpList.length} InvestorGain entries; ${targets.length} target IPOs`);
  const results = [];
  const skipped = [];

  for (const ipo of targets) {
    if (!ELIGIBLE.has(ipo.status)) {
      skipped.push({ slug: ipo.slug, reason: `status ${ipo.status} — no live GMP` });
      continue;
    }
    const entry = matchGmp(ipo, gmpList);
    if (!entry || !entry.gmp) {
      skipped.push({ slug: ipo.slug, reason: 'no GMP found' });
      continue;
    }
    const percentage = entry.gmpPercent != null
      ? entry.gmpPercent
      : (entry.price ? Math.round((entry.gmp / entry.price) * 10000) / 100 : null);
    const gmp = { value: entry.gmp, percentage, source: 'investorgain', updatedAt: now };
    await ipos.updateOne({ slug: ipo.slug }, { $set: { gmp, updatedAt: now } });

    // Backfill the GMP history series from the detail endpoint (dedupe by day).
    let series = entry.id ? await fetchGmpHistory(entry.id) : [];
    if (!series.length) series = [{ date: now.slice(0, 10), gmp: entry.gmp }];
    let added = 0;
    for (const row of series) {
      const r = await collections.gmpHistory().updateOne(
        { slug: ipo.slug, date: row.date },
        { $set: { slug: ipo.slug, date: row.date, value: row.gmp, source: 'investorgain', updatedAt: now } },
        { upsert: true },
      );
      if (r.upsertedCount) added++;
    }
    log(`matched ${ipo.slug} — gmp ${gmp.value} (${percentage}%), +${added} history points`);
    results.push({ slug: ipo.slug, gmp, historyPoints: series.length, newHistoryPoints: added, source: 'investorgain' });
  }

  return { processed: results.length, results, skipped };
}

module.exports = { runGmp, matchGmp };
