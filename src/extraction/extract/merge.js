'use strict';

/**
 * merge.js — Fuzzy-merge partial section responses from Firecrawl.
 *
 * Each section gives partial data. We merge them with precedence:
 *  - String fields: longer / non-placeholder value wins
 *  - List fields: append non-duplicates with fuzzy dedup
 *  - Financials: merge by period name
 *  - Reservations: merge by investor category synonyms
 */

const { logger } = require('../../utils/logger');

const log = logger.child({ module: 'extraction:merge' });

// ── Placeholder detection ────────────────────────────────────────────────────

const PLACEHOLDERS = new Set([
  'null', 'none', 'n/a', 'na', 'not mentioned', 'not available',
  'not applicable', 'not disclosed', 'tba', 'tbd', 'to be announced',
  '[●]', '-', '--', '—', '',
]);

function isPlaceholder(val) {
  if (val == null) return true;
  const cleaned = String(val).trim().toLowerCase();
  return !cleaned || PLACEHOLDERS.has(cleaned) || cleaned.includes('[●]');
}

// ── String similarity ────────────────────────────────────────────────────────

function normalizeStr(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9\s]/g, '');
}

function stringSimilarity(a, b) {
  const sa = normalizeStr(a);
  const sb = normalizeStr(b);
  if (sa === sb) return 1;
  if (!sa || !sb) return 0;

  // Simple Jaccard-like similarity on words
  const wordsA = new Set(sa.split(/\s+/));
  const wordsB = new Set(sb.split(/\s+/));
  let intersection = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersection++;
  return intersection / Math.max(wordsA.size, wordsB.size);
}

// ── Investor category synonyms ───────────────────────────────────────────────

const CATEGORY_SYNONYMS = [
  new Set(['qib', 'qualified institutional buyers', 'qualified institutional bidders', 'qib portion']),
  new Set(['nib', 'nii', 'non-institutional investor', 'non institutional bidders', 'non-institutional investors', 'nii portion']),
  new Set(['retail', 'retail individual investors', 'retail individual bidders', 'retail portion', 'retail investors']),
  new Set(['market maker', 'market maker portion']),
  new Set(['employee', 'employee reservation', 'employees']),
  new Set(['anchor', 'anchor investor', 'anchor investors']),
];

function normalizeCategory(cat) {
  const lower = normalizeStr(cat);
  for (const group of CATEGORY_SYNONYMS) {
    for (const syn of group) {
      if (lower.includes(syn) || syn.includes(lower)) {
        return [...group][0]; // canonical name (first in set)
      }
    }
  }
  return lower;
}

// ── Core merge logic ─────────────────────────────────────────────────────────

// String fields — take the longer / non-placeholder value
const STRING_FIELDS = [
  'company_name', 'company_description', 'incorporation_date', 'registered_office',
  'website', 'issue_type', 'face_value', 'price_band', 'lot_size', 'issue_size',
  'fresh_issue', 'offer_for_sale', 'registrar', 'sector', 'pe_ratio', 'roce',
  'roe', 'debt_to_equity', 'promoter_holding_pre', 'promoter_holding_post',
];

// List fields — append non-duplicates
const LIST_FIELDS = [
  'listing_at', 'promoters', 'lead_managers', 'objects_of_the_offer',
  'risk_factors', 'competitive_strengths', 'business_strategies',
];

/**
 * Fuzzy-deduplicate a string array (similarity ≥ 0.8 → duplicate).
 */
function fuzzyDedupeStrings(items) {
  const result = [];
  for (const item of items) {
    const isDup = result.some((existing) => stringSimilarity(existing, item) >= 0.8);
    if (!isDup) result.push(item);
  }
  return result;
}

/**
 * Merge financial periods by fuzzy-matching period names.
 */
function mergeFinancials(allFinancials) {
  const byPeriod = {};

  for (const entry of allFinancials) {
    if (!entry?.period) continue;
    const normPeriod = normalizeStr(entry.period);

    // Find existing period with similar name
    let matched = null;
    for (const key of Object.keys(byPeriod)) {
      if (stringSimilarity(key, normPeriod) >= 0.7) {
        matched = key;
        break;
      }
    }

    if (matched) {
      // Merge: prefer non-placeholder values
      for (const [k, v] of Object.entries(entry)) {
        if (!isPlaceholder(v) && isPlaceholder(byPeriod[matched][k])) {
          byPeriod[matched][k] = v;
        }
      }
    } else {
      byPeriod[normPeriod] = { ...entry };
    }
  }

  return Object.values(byPeriod);
}

/**
 * Merge reservations by normalized investor category.
 */
function mergeReservations(allReservations) {
  const byCategory = {};

  for (const entry of allReservations) {
    if (!entry?.category) continue;
    const normCat = normalizeCategory(entry.category);

    if (!byCategory[normCat] || isPlaceholder(byCategory[normCat].percentage)) {
      byCategory[normCat] = {
        category: entry.category, // keep original casing
        percentage: entry.percentage,
      };
    }
  }

  return Object.values(byCategory);
}

/**
 * Merge multiple partial extraction responses into one combined result.
 *
 * @param {object[]} responses  Array of per-section extracted JSON
 * @returns {object} Merged IPODetails
 */
function mergeSectionResponses(responses) {
  const combined = {};

  // Initialize list fields
  for (const key of LIST_FIELDS) combined[key] = [];
  combined.financials = [];
  combined.reservations = [];

  for (const resp of responses) {
    if (!resp || typeof resp !== 'object') continue;

    // String fields: prefer longer / non-placeholder
    for (const key of STRING_FIELDS) {
      const val = resp[key];
      if (val && !isPlaceholder(val)) {
        const curr = combined[key];
        if (isPlaceholder(curr) || String(val).length > String(curr || '').length) {
          combined[key] = val;
        }
      }
    }

    // List fields: append non-duplicates
    for (const key of LIST_FIELDS) {
      const items = resp[key];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (item && !isPlaceholder(item) && !combined[key].includes(item)) {
          combined[key].push(item);
        }
      }
    }

    // Financials and reservations: collect all
    if (Array.isArray(resp.financials)) combined.financials.push(...resp.financials);
    if (Array.isArray(resp.reservations)) combined.reservations.push(...resp.reservations);
  }

  // Fuzzy dedup lists
  for (const key of LIST_FIELDS) {
    combined[key] = fuzzyDedupeStrings(combined[key]);
  }

  // Fuzzy merge financials and reservations
  combined.financials = mergeFinancials(combined.financials);
  combined.reservations = mergeReservations(combined.reservations);

  log.debug({ fields: Object.keys(combined).filter((k) => !isPlaceholder(combined[k])).length }, 'merge complete');

  return combined;
}

module.exports = { mergeSectionResponses, isPlaceholder };
