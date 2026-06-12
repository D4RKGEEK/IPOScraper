'use strict';

/**
 * validation.js — deterministic sanity checks + provenance tracking for every
 * value extracted from prospectus documents.
 *
 * Two layers:
 *   1. Sanity bounds (hard clamp): every numeric field has a plausible range.
 *      Values outside → flagged in the DB as `{ value, reason, field }`.
 *   2. Cross-field consistency (soft): relationships between fields across
 *      different extractors are checked and scored.
 *
 * Each extracted value SHOULD carry a provenance tag so we can trace it back
 * to the exact regex pattern / source line that produced it.
 *
 * Expressed as a plain object so it serialises cleanly into MongoDB.
 */

// ---------------------------------------------------------------------------
// 1. SANITY BOUNDS
// ---------------------------------------------------------------------------

/**
 * Every numeric field we extract, with its plausible [min, max] range.
 *
 * Source of truth for ranges:
 *  - Indian IPO share counts:  SME min ~8L shares; mainboard min ~50L.
 *    Upper bound: 10B (1,00,00,00,000) covers the largest IPOs ever.
 *  - Reserved portions: single-digit shares are legal (e.g. 1 share reserved).
 *  - Price: ₹1–₹5,000 per share.
 *  - Lot sizes: 1–100,000 shares.
 *  - Application amounts: ₹1K to ₹100Cr.
 */
const SANITY = {
  // ―― Issue Details (share counts) ――
  totalIssueShares:      { min: 100,     max: 1e10, label: 'Total Issue Shares' },
  freshIssueShares:      { min: 0,       max: 1e10, label: 'Fresh Issue Shares' },
  ofsShares:             { min: 0,       max: 1e10, label: 'OFS Shares' },
  marketMakerShares:     { min: 0,       max: 1e10, label: 'Market Maker Reservation Shares' },
  employeeReservationShares: { min: 0,   max: 1e10, label: 'Employee Reservation Shares' },
  netOfferShares:        { min: 0,       max: 1e10, label: 'Net Offer Shares' },
  preIssueShares:        { min: 100,     max: 1e11, label: 'Pre-Issue Outstanding Shares' },
  postIssueShares:       { min: 100,     max: 1e11, label: 'Post-Issue Outstanding Shares' },

  // ―― Lot Details (share counts per lot) ――
  lotSize:               { min: 1,       max: 1e5,  label: 'Lot Size (shares)' },

  // ―― Price Band ――
  priceMin:              { min: 1,       max: 5000, label: 'Price Band Min' },
  priceMax:              { min: 1,       max: 5000, label: 'Price Band Max' },
  issuePrice:            { min: 1,       max: 5000, label: 'Final Issue Price' },
  faceValue:             { min: 0.5,     max: 100,  label: 'Face Value' },

  // ―― Financials (restated) ――
  revenueFromOperations: { min: -1e12,   max: 1e12, label: 'Revenue from Operations' },
  totalIncome:           { min: -1e12,   max: 1e12, label: 'Total Income' },
  ebitda:                { min: -1e12,   max: 1e12, label: 'EBITDA' },
  profitAfterTax:        { min: -1e12,   max: 1e12, label: 'Profit After Tax' },
  netWorth:              { min: -1e12,   max: 1e12, label: 'Net Worth' },
  totalBorrowings:       { min: 0,       max: 1e12, label: 'Total Borrowings' },
  basicEPS:              { min: -1e5,    max: 1e5,  label: 'Basic EPS' },
  dilutedEPS:            { min: -1e5,    max: 1e5,  label: 'Diluted EPS' },
  ronw:                  { min: -500,    max: 500,  label: 'RoNW (%)' },
  netAssetValue:         { min: -1e5,    max: 1e5,  label: 'Net Asset Value Per Share' },

  // ―― KPIs (ratios / %) ――
  roce:                  { min: -500,    max: 500,  label: 'RoCE (%)' },
  roe:                   { min: -500,    max: 500,  label: 'RoE (%)' },
  debtEquity:            { min: 0,       max: 50,   label: 'Debt / Equity' },
  ebitdaMargin:          { min: -200,    max: 200,  label: 'EBITDA Margin (%)' },
  patMargin:             { min: -200,    max: 200,  label: 'PAT Margin (%)' },
  grossMargin:           { min: -200,    max: 200,  label: 'Gross Margin (%)' },
  priceToBook:           { min: 0,       max: 500,  label: 'Price / Book' },
  currentRatio:          { min: 0,       max: 50,   label: 'Current Ratio' },
  nav:                   { min: -1e5,    max: 1e5,  label: 'NAV per Share' },
  eps:                   { min: -1e5,    max: 1e5,  label: 'EPS' },

  // ―― Objects of the Issue (₹ in Lakhs/Crore) ――
  objectsAmount:         { min: 1,       max: 1e11, label: 'Object Amount' },
  objectsTotal:          { min: 1,       max: 1e11, label: 'Objects Total' },
};

/** Flag a value that falls outside its field's sanity bounds. */
function sanityCheck(value, field) {
  const bounds = SANITY[field];
  if (!bounds || value == null) return { ok: true, field, value };
  if (typeof value !== 'number') return { ok: false, field, value, reason: 'not_a_number' };
  if (value < bounds.min) return { ok: false, field, value, reason: `below_min:${bounds.min}` };
  if (value > bounds.max) return { ok: false, field, value, reason: `above_max:${bounds.max}` };
  return { ok: true, field, value };
}

/**
 * Run sanity checks on a flat map of field→value entries.
 * Returns { flagged[], ok: boolean }.
 */
function sanityPass(map) {
  const flagged = [];
  for (const [field, value] of Object.entries(map)) {
    const r = sanityCheck(value, field);
    if (!r.ok) flagged.push(r);
  }
  return { flagged, ok: flagged.length === 0 };
}

// ---------------------------------------------------------------------------
// 2. PROVENANCE TAG
// ---------------------------------------------------------------------------

/**
 * Build a provenance tag for a single extracted value.
 *
 * @param {string} field    — canonical field name (e.g. "freshIssueShares")
 * @param {string} pattern  — short descriptor of the regex/step (e.g. "LABEL_PATTERNS::freshIssueShares")
 * @param {string} [section] — document section the text was taken from (e.g. "cover", "issue-table")
 * @param {string} [source]  — origin type (e.g. "table-row", "prose", "cover-page")
 * @returns {object} tag
 */
function provenance(field, pattern, section = null, source = null) {
  return { field, pattern, section, source, extractedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// 3. CROSS-FIELD CONSISTENCY
// ---------------------------------------------------------------------------

/**
 * Cross-field consistency rules.
 * Each rule: { name, check(results): boolean, detail: string|function }
 */
const CONSISTENCY_RULES = [
  {
    name: 'post_equals_pre_plus_fresh',
    check: (r) => r.postIssueShares == null || r.preIssueShares == null || r.freshIssueShares == null
      || r.postIssueShares === r.preIssueShares + r.freshIssueShares,
    detail: (r) => `post(${r.postIssueShares}) vs pre(${r.preIssueShares}) + fresh(${r.freshIssueShares}) = ${(r.preIssueShares || 0) + (r.freshIssueShares || 0)}`,
  },
  {
    name: 'total_equals_fresh_plus_ofs',
    check: (r) => r.totalIssueShares == null || (r.freshIssueShares == null && r.ofsShares == null)
      || r.totalIssueShares === (r.freshIssueShares || 0) + (r.ofsShares || 0),
    detail: (r) => `total(${r.totalIssueShares}) vs fresh(${r.freshIssueShares}) + ofs(${r.ofsShares}) = ${(r.freshIssueShares || 0) + (r.ofsShares || 0)}`,
  },
  {
    name: 'fresh_ge_reserved_sum',
    check: (r) => r.freshIssueShares == null
      || (r.marketMakerShares || 0) + (r.employeeReservationShares || 0) + (r.netOfferShares || 0) <= r.freshIssueShares + (r.freshIssueShares * 0.01),
    detail: (r) => `fresh(${r.freshIssueShares}) vs mm(${r.marketMakerShares}) + emp(${r.employeeReservationShares}) + net(${r.netOfferShares}) = ${(r.marketMakerShares || 0) + (r.employeeReservationShares || 0) + (r.netOfferShares || 0)}`,
  },
  {
    name: 'pre_issue_positive',
    check: (r) => r.preIssueShares == null || r.preIssueShares >= 100,
    detail: (r) => `preIssueShares=${r.preIssueShares}`,
  },
  {
    name: 'price_band_order',
    check: (r) => r.priceMin == null || r.priceMax == null || r.priceMin <= r.priceMax,
    detail: (r) => `min(${r.priceMin}) > max(${r.priceMax})`,
  },
  {
    name: 'listing_exchange_present',
    check: (r) => !r.listingAt || (r.listingAt !== 'BSE SME' && r.listingAt !== 'NSE SME') || r.issueType === 'SME',
    detail: () => 'listing says SME but issueType mismatch',
  },
  {
    name: 'promoters_non_empty',
    check: (r) => !r.promoters || r.promoters.length > 0,
    detail: (r) => `promoters=${JSON.stringify(r.promoters)}`,
  },
  {
    name: 'lead_managers_present',
    check: (r) => !r.leadManagerCount || r.leadManagerCount >= 1,
    detail: (r) => `leadManagers=${r.leadManagerCount}`,
  },
  {
    name: 'objects_non_empty_on_fresh_issue',
    check: (r) => r.freshIssueShares == null || r.freshIssueShares <= 0 || !r.objectCount || r.objectCount > 0,
    detail: (r) => `freshIssue=${r.freshIssueShares}, objects=${r.objectCount}`,
  },
];

/**
 * Run all cross-field consistency checks on the combined extraction results.
 * @param {object} flat — flattened key→value map of ALL extracted fields
 * @returns {{ passed: string[], failed: object[], ok: boolean }}
 */
function crossFieldConsistency(flat) {
  const results = [];
  for (const rule of CONSISTENCY_RULES) {
    const pass = rule.check(flat);
    results.push({
      name: rule.name,
      status: pass ? 'pass' : 'fail',
      detail: typeof rule.detail === 'function' ? rule.detail(flat) : rule.detail,
    });
  }
  return {
    checks: results,
    failed: results.filter((r) => r.status === 'fail'),
    ok: results.every((r) => r.status === 'pass'),
  };
}

// ---------------------------------------------------------------------------
// 4. MASTER VALIDATION
// ---------------------------------------------------------------------------

/**
 * Validate a complete extraction result and return a summary suitable for
 * storing in the IPO's DB document.
 *
 * @param {object} extraction — flat key→value of ALL fields (issueDetails + financials + promoters + …)
 * @param {object} [opts]
 * @param {object} [opts.provenance] — { field: tag, … } per-field provenance tags
 * @returns {object} validation summary
 */
function validateExtraction(extraction, opts = {}) {
  const sanity = sanityPass(extraction);
  const consistency = crossFieldConsistency(extraction);

  // Overall score: start at 1.0, deduct for each flagged issue.
  let score = 1.0;
  score -= 0.15 * sanity.flagged.length;
  score -= 0.10 * consistency.failed.length;
  score = Math.max(0, Math.min(1, Number(score.toFixed(3))));

  const needsReview = sanity.flagged.length > 0 || consistency.failed.length > 0 || score < 0.7;

  return {
    score,
    needsReview,
    sanity: { ok: sanity.ok, flagged: sanity.flagged.slice(0, 20) },
    consistency: { ok: consistency.ok, failed: consistency.failed.slice(0, 20) },
    provenance: opts.provenance || {},
    validatedAt: new Date().toISOString(),
  };
}

module.exports = {
  SANITY,
  sanityCheck,
  sanityPass,
  provenance,
  crossFieldConsistency,
  validateExtraction,
};
