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
// Placeholder detection and field groupings come from the single source of
// truth (schema.js) so adding/removing a field there updates merge too.
const {
  isPlaceholder, STRING_FIELDS, LIST_FIELDS, OBJECT_LIST_FIELDS,
  canonicalCategory, canonicalPeriod,
} = require('../llm/schema');

const log = logger.child({ module: 'extraction:merge' });

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

// ── Core merge logic ─────────────────────────────────────────────────────────
// STRING_FIELDS (take the longer / non-placeholder value) and LIST_FIELDS
// (append non-duplicates) are derived from the field registry in schema.js.

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

// ── Generic object-list merging ───────────────────────────────────────────────
// How to merge each objectList field. A field listed here is grouped by a key
// (rows with a matching key are combined, preferring non-placeholder values);
// anything else just gets exact-duplicate rows removed.
//   'similar'  → group by fuzzy-matching the key value (e.g. period names)
//   'category' → group by normalized investor-category synonyms
const OBJECT_LIST_MERGE = {
  financials: { key: 'period', match: 'similar' },
  kpis: { key: 'period', match: 'similar' },
  reservations: { key: 'category', match: 'category' },
  subscription: { key: 'category', match: 'category' },
};

/**
 * Merge rows of an objectList by grouping on a key field. Rows whose key
 * matches an existing group are folded in, filling only placeholder slots.
 *
 * @param {object[]} rows
 * @param {string} keyField        Sub-field to group on (e.g. 'period')
 * @param {'similar'|'category'} matchMode  How to compare key values
 */
function mergeObjectListByKey(rows, keyField, matchMode) {
  const groups = []; // { keyNorm, obj }

  for (const entry of rows) {
    if (!entry || typeof entry !== 'object' || isPlaceholder(entry[keyField])) continue;

    // Canonicalize the key the same way normalize() will, so equivalent values
    // (e.g. "31-05-2025" and "31 May 2025", or "QIB" and "Qualified
    // Institutional Buyers") collapse into a single row.
    const keyNorm = matchMode === 'category'
      ? canonicalCategory(entry[keyField])
      : canonicalPeriod(entry[keyField]);

    const matched = groups.find((g) =>
      matchMode === 'category'
        ? g.keyNorm === keyNorm
        : g.keyNorm === keyNorm || stringSimilarity(g.keyNorm, keyNorm) >= 0.7,
    );

    if (matched) {
      for (const [k, v] of Object.entries(entry)) {
        if (!isPlaceholder(v) && isPlaceholder(matched.obj[k])) {
          matched.obj[k] = v;
        }
      }
    } else {
      groups.push({ keyNorm, obj: { ...entry } });
    }
  }

  return groups.map((g) => g.obj);
}

/**
 * Remove exact-duplicate rows from an objectList (for fields with no key).
 */
function dedupeObjectList(rows) {
  const seen = new Set();
  const out = [];
  for (const entry of rows) {
    if (!entry || typeof entry !== 'object') continue;
    const sig = JSON.stringify(entry);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(entry);
  }
  return out;
}

/**
 * Merge multiple partial extraction responses into one combined result.
 *
 * @param {object[]} responses  Array of per-section extracted JSON
 * @returns {object} Merged IPODetails
 */
function mergeSectionResponses(responses) {
  const combined = {};

  // Initialize list & object-list fields
  for (const key of LIST_FIELDS) combined[key] = [];
  for (const key of OBJECT_LIST_FIELDS) combined[key] = [];

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

    // Object-list fields: collect all rows for merging below
    for (const key of OBJECT_LIST_FIELDS) {
      if (Array.isArray(resp[key])) combined[key].push(...resp[key]);
    }
  }

  // Fuzzy dedup string lists
  for (const key of LIST_FIELDS) {
    combined[key] = fuzzyDedupeStrings(combined[key]);
  }

  // Merge object-lists: by key where configured, else dedupe exact duplicates
  for (const key of OBJECT_LIST_FIELDS) {
    const rule = OBJECT_LIST_MERGE[key];
    combined[key] = rule
      ? mergeObjectListByKey(combined[key], rule.key, rule.match)
      : dedupeObjectList(combined[key]);
  }

  log.debug({ fields: Object.keys(combined).filter((k) => !isPlaceholder(combined[k])).length }, 'merge complete');

  return combined;
}

module.exports = { mergeSectionResponses, isPlaceholder };
