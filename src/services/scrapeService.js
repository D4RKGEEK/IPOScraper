'use strict';

/**
 * scrapeService.js — orchestrate a multi-source scrape into MongoDB.
 *
 *   fetch each requested source -> dedup/merge (ISIN→symbol→Jaro-Winkler) ->
 *   upsert each merged record -> tally new/updated/unchanged + per-IPO changes.
 *
 * Source fetchers are injectable (for tests) and default to the real ones.
 */

const path = require('path');
const { fetchUpstoxIpos } = require('../scrapers/upstox.js');
const { fetchNseIpos } = require('../scrapers/nse.js');
const { fetchGrowwIpos } = require('../scrapers/groww.js');
const { fetchZerodhaIpos } = require('../scrapers/zerodha.js');
const { deduplicateRecords } = require('../utils/dedup.js');
const { upsertRecord } = require('../db/ipoRepository');

const ROOT = path.join(__dirname, '..');

// NSE has no clean listed/closed split, so limit its "past" window to recent
// issues (still in the closed/allotment phase) rather than 4 years of history.
const NSE_PAST_DAYS = 120;

const DEFAULT_FETCHERS = {
  upstox: () => fetchUpstoxIpos(),
  nse: () => fetchNseIpos(ROOT, new Date(Date.now() - NSE_PAST_DAYS * 864e5), new Date()),
  groww: () => fetchGrowwIpos(),
  zerodha: () => fetchZerodhaIpos(),
};

const ALL_SOURCES = Object.keys(DEFAULT_FETCHERS);

/**
 * Run a scrape.
 * @param {object} [opts]
 * @param {string[]} [opts.sources]      which sources (default all)
 * @param {boolean}  [opts.dryRun]       fetch + merge only; no DB writes
 * @param {boolean}  [opts.force]        reserved (re-scrape even if fresh)
 * @param {object}   [opts.fetchers]     override source fetchers (tests)
 * @param {string}   [opts.now]
 * @returns {Promise<object>} summary { scraped, details, errors, perSource }
 */
async function runScrape(opts = {}) {
  const log = opts.log || (() => {});
  const fetchers = opts.fetchers || DEFAULT_FETCHERS;
  const sources = (opts.sources && opts.sources.length ? opts.sources : ALL_SOURCES)
    .filter((s) => { if (fetchers[s]) return true; return false; });
  const errors = [];
  const perSource = {};
  const all = [];

  log(`scraping sources: ${sources.join(', ')}`);
  await Promise.all(sources.map(async (s) => {
    try {
      const recs = await fetchers[s]();
      perSource[s] = Array.isArray(recs) ? recs.length : 0;
      if (Array.isArray(recs)) all.push(...recs);
      log(`fetched ${perSource[s]} from ${s}`);
    } catch (e) {
      perSource[s] = 0;
      errors.push({ source: s, error: e.message });
      log(`source ${s} failed: ${e.message}`);
    }
  }));
  // Unknown sources requested
  for (const s of (opts.sources || [])) {
    if (!fetchers[s]) errors.push({ source: s, error: 'unknown source' });
  }

  let { master } = deduplicateRecords(all);
  // Final guard: never persist listed IPOs (they no longer change).
  const beforeListed = master.length;
  master = master.filter((r) => r.status !== 'listed');
  if (beforeListed !== master.length) log(`dropped ${beforeListed - master.length} listed IPOs`);
  log(`merged ${all.length} raw → ${master.length} active IPOs`);

  if (opts.dryRun) {
    log('dryRun: skipping DB writes');
    return { dryRun: true, perSource, wouldUpsert: master.length, scraped: { new: 0, updated: 0, unchanged: 0, errors: errors.length }, errors };
  }

  const scraped = { new: 0, updated: 0, unchanged: 0, errors: errors.length };
  const details = [];
  for (const rec of master) {
    try {
      const r = await upsertRecord(rec, { now: opts.now });
      scraped[r.action]++;
      if (r.action !== 'unchanged') details.push({ slug: r.slug, status: r.action, changes: r.changes });
    } catch (e) {
      scraped.errors++;
      errors.push({ slug: rec.symbol || rec.companyName, error: e.message });
    }
  }
  log(`upsert done — new ${scraped.new}, updated ${scraped.updated}, unchanged ${scraped.unchanged}, errors ${scraped.errors}`);
  return { scraped, details, errors, perSource };
}

module.exports = { runScrape, DEFAULT_FETCHERS, ALL_SOURCES };
