'use strict';

/**
 * validate.js — VALIDATION RULES for extraction results.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  Mirrors llm/schema.js: a runtime-mutable, dashboard-editable registry.   │
 * │  Built-in defaults are the seed; whatever the dashboard saves (persisted  │
 * │  to MongoDB `config` _id:'validation') overrides them at runtime.         │
 * │                                                                           │
 * │  After each extraction, validateExtraction(result, ipo) scores the result │
 * │  0–100 against the enabled rules and returns per-rule findings. A score    │
 * │  below the threshold flips the extraction to `review`.                    │
 * │                                                                           │
 * │  Re-runnable on a STORED result with NO LLM call — so rules can be tuned   │
 * │  and the whole corpus re-scored instantly.                                │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * A rule:
 *   {
 *     id:        unique snake_case id,
 *     field:     top-level result field the rule inspects,
 *     type:      'required'|'regex'|'min_items'|'enum'|'cross_check'|'objectlist_sum'|'compare',
 *     severity:  'error' | 'warning' | 'info',
 *     weight:    number (contribution to the score; default 10),
 *     enabled:   boolean (default true),
 *     description: human explanation (shown in the dashboard),
 *     params:    type-specific (see RULE_TYPES below),
 *   }
 *
 * Rule semantics:
 *   - `required` fails when the field is missing/placeholder (list/objectList: empty).
 *   - Every OTHER rule is SKIPPED (counts as OK, no penalty) when its field is
 *     absent — absence is the `required` rule's job, so we never double-penalize.
 */

const { isPlaceholder } = require('./llm/schema');
const { jaroWinkler } = require('../utils/jaroWinkler');

// Score at or above this → `completed`; below → `review` (the canonical status
// the dashboard review queue keys on; see mongo.js normalizeData).
const DEFAULT_THRESHOLD = 80;

const VALID_TYPES = new Set(['required', 'regex', 'min_items', 'enum', 'cross_check', 'objectlist_sum', 'compare']);
const VALID_SEVERITIES = new Set(['error', 'warning', 'info']);
const SEVERITY_COST = { error: 1, warning: 0.4, info: 0 };

// ── Built-in DEFAULT ruleset ─────────────────────────────────────────────────
// References real fields from llm/schema.js and real master-data fields from the
// scraped ipo doc (companyName, priceBand, lotSize, …).
const DEFAULT_RULES = [
  { id: 'company_name_present', field: 'company_name', type: 'required', severity: 'error', weight: 15,
    description: 'Company name must be extracted.' },
  { id: 'price_band_present', field: 'price_band', type: 'required', severity: 'error', weight: 10,
    description: 'Price band must be present.' },
  { id: 'price_band_format', field: 'price_band', type: 'regex', severity: 'warning', weight: 5,
    params: { pattern: '\\d[\\d,]*\\s*(?:to|-|–|—)\\s*₹?\\s*\\d', flags: 'i' },
    description: 'Price band should look like a range, e.g. "₹21 to ₹23".' },
  { id: 'total_issue_amount_present', field: 'total_issue_amount', type: 'required', severity: 'error', weight: 8,
    description: 'Total issue amount must be present.' },
  { id: 'lot_size_present', field: 'lot_size', type: 'required', severity: 'warning', weight: 5,
    description: 'Lot size should be extracted.' },
  { id: 'financials_present', field: 'financials', type: 'min_items', severity: 'error', weight: 8,
    params: { min: 1 }, description: 'At least one financial period must be extracted.' },
  { id: 'objects_present', field: 'objects_of_the_offer', type: 'min_items', severity: 'warning', weight: 6,
    params: { min: 1 }, description: 'At least one stated object of the offer.' },
  { id: 'risk_factors_present', field: 'risk_factors', type: 'min_items', severity: 'warning', weight: 5,
    params: { min: 3 }, description: 'At least 3 risk factors should be summarized.' },
  { id: 'lead_managers_present', field: 'lead_managers', type: 'min_items', severity: 'warning', weight: 4,
    params: { min: 1 }, description: 'At least one lead manager (BRLM).' },
  { id: 'reservations_sum_100', field: 'reservations', type: 'objectlist_sum', severity: 'warning', weight: 5,
    params: { subField: 'pct_of_net_issue', expected: 100, tolerance: 5 },
    description: 'Category reservation percentages should sum to ~100% of the net issue.' },
  { id: 'company_name_matches_master', field: 'company_name', type: 'cross_check', severity: 'warning', weight: 6,
    params: { against: 'companyName', match: 'fuzzy', threshold: 0.8 },
    description: 'Extracted company name should match the scraped master record.' },
  { id: 'price_band_matches_master', field: 'price_band', type: 'cross_check', severity: 'warning', weight: 6,
    params: { against: 'priceBand', match: 'numeric', tolerance: 1 },
    description: 'Extracted price band numbers should match the scraped master record.' },
];

// Documentation surfaced to the dashboard so the rule editor can render the
// right param inputs for each type.
const RULE_TYPES = {
  required:       { params: [], note: 'Field must be present (lists/objectLists: non-empty).' },
  regex:          { params: ['pattern', 'flags'], note: 'String field must match the regular expression.' },
  min_items:      { params: ['min'], note: 'List / objectList must have at least `min` items.' },
  enum:           { params: ['values'], note: 'Value must be one of `values` (case-insensitive).' },
  cross_check:    { params: ['against', 'match', 'tolerance', 'threshold'], note: 'Compare to a scraped master field (e.g. against:"priceBand"). match: numeric | fuzzy | exact.' },
  objectlist_sum: { params: ['subField', 'expected', 'tolerance'], note: 'Sum a numeric sub-field across rows; must be within tolerance of `expected`.' },
  compare:        { params: ['other', 'op', 'tolerance'], note: 'Numeric relation to another field. op: gt | gte | lt | lte | approx.' },
};

// ── Value helpers ────────────────────────────────────────────────────────────

/**
 * All numbers in a string → floats (commas stripped). "₹21 to ₹23" → [21,23].
 * A hyphen directly after a digit is a range separator ("21-23"), not a minus,
 * so it is NOT read as a negative; a leading "-" still is ("-5%" → [-5]).
 */
function extractNumbers(val) {
  if (val == null) return [];
  return (String(val).replace(/,/g, '').match(/(?<!\d)-?\d+(?:\.\d+)?/g) || []).map(Number);
}

/** Single leading number from a value, commas/symbols stripped, or null. */
function parseNum(val) {
  const nums = extractNumbers(val);
  return nums.length ? nums[0] : null;
}

/** Resolve a dot-path against an object (e.g. "documents.drhp.url"). */
function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function isEmptyValue(val) {
  if (Array.isArray(val)) return val.length === 0;
  return isPlaceholder(val);
}

// ── Single-rule evaluation ───────────────────────────────────────────────────
// Returns { ok, skipped, message, expected?, actual? }.

function evalRule(rule, ctx) {
  const { result, ipo } = ctx;
  const val = result ? result[rule.field] : undefined;
  const p = rule.params || {};

  // `required` is the only rule that asserts presence.
  if (rule.type === 'required') {
    const ok = !isEmptyValue(val);
    return { ok, skipped: false, message: ok ? 'present' : 'missing or placeholder' };
  }

  // Every other rule no-ops on an absent field (the `required` rule owns that).
  if (isEmptyValue(val)) return { ok: true, skipped: true, message: 'field empty — skipped' };

  switch (rule.type) {
    case 'regex': {
      let re;
      try { re = new RegExp(p.pattern, p.flags || ''); }
      catch { return { ok: false, skipped: false, message: `invalid regex: ${p.pattern}` }; }
      const ok = re.test(String(val));
      return { ok, skipped: false, message: ok ? 'matches' : `does not match /${p.pattern}/`, actual: String(val) };
    }
    case 'min_items': {
      const n = Array.isArray(val) ? val.length : (isPlaceholder(val) ? 0 : 1);
      const ok = n >= (p.min ?? 1);
      return { ok, skipped: false, message: `${n} item(s), need ≥ ${p.min ?? 1}`, actual: n, expected: p.min ?? 1 };
    }
    case 'enum': {
      const allowed = (p.values || []).map((v) => String(v).toLowerCase());
      const ok = allowed.includes(String(val).toLowerCase());
      return { ok, skipped: false, message: ok ? 'in set' : `not in {${(p.values || []).join(', ')}}`, actual: String(val) };
    }
    case 'objectlist_sum': {
      if (!Array.isArray(val)) return { ok: true, skipped: true, message: 'not a list — skipped' };
      const nums = val.map((row) => parseNum(row && row[p.subField])).filter((n) => n != null);
      if (!nums.length) return { ok: true, skipped: true, message: `no numeric "${p.subField}" — skipped` };
      const sum = nums.reduce((a, b) => a + b, 0);
      const tol = p.tolerance ?? 0;
      const ok = Math.abs(sum - p.expected) <= tol;
      return { ok, skipped: false, message: `sum=${sum.toFixed(2)}, expected ${p.expected}±${tol}`, actual: sum, expected: p.expected };
    }
    case 'compare': {
      const a = parseNum(val);
      const b = parseNum(result ? result[p.other] : undefined);
      if (a == null || b == null) return { ok: true, skipped: true, message: 'non-numeric operand — skipped' };
      const tol = p.tolerance ?? 0;
      let ok;
      switch (p.op) {
        case 'gt': ok = a > b; break;
        case 'gte': ok = a >= b; break;
        case 'lt': ok = a < b; break;
        case 'lte': ok = a <= b; break;
        case 'approx': ok = Math.abs(a - b) <= tol; break;
        default: return { ok: false, skipped: false, message: `unknown op "${p.op}"` };
      }
      return { ok, skipped: false, message: `${a} ${p.op} ${b}${tol ? `±${tol}` : ''}`, actual: a, expected: b };
    }
    case 'cross_check': {
      const masterVal = getPath(ipo || {}, p.against);
      if (isEmptyValue(masterVal)) return { ok: true, skipped: true, message: `master "${p.against}" empty — skipped` };
      const match = p.match || 'fuzzy';
      if (match === 'numeric') {
        const a = new Set(extractNumbers(val));
        const b = extractNumbers(masterVal);
        const tol = p.tolerance ?? 0;
        const ok = b.length > 0 && b.every((bn) => [...a].some((an) => Math.abs(an - bn) <= tol));
        return { ok, skipped: false, message: ok ? 'numbers match master' : 'numbers differ from master', actual: String(val), expected: String(masterVal) };
      }
      if (match === 'exact') {
        const ok = String(val).trim().toLowerCase() === String(masterVal).trim().toLowerCase();
        return { ok, skipped: false, message: ok ? 'matches master' : 'differs from master', actual: String(val), expected: String(masterVal) };
      }
      // fuzzy (default)
      const sim = jaroWinkler(String(val).toLowerCase(), String(masterVal).toLowerCase());
      const ok = sim >= (p.threshold ?? 0.8);
      return { ok, skipped: false, message: `similarity ${sim.toFixed(2)} (need ≥ ${p.threshold ?? 0.8})`, actual: String(val), expected: String(masterVal) };
    }
    default:
      return { ok: true, skipped: true, message: `unknown rule type "${rule.type}" — skipped` };
  }
}

// ── Public: score an extraction result ───────────────────────────────────────

/**
 * Validate an extraction result against the active ruleset.
 * @param {object} result  normalized extraction result
 * @param {object} [ipo]   scraped master IPO doc (for cross_check rules)
 * @param {object} [opts]  { rules?, threshold? } override (defaults to the registry)
 * @returns {{ score, status, threshold, ranAt, passed, failed, findings }}
 */
function validateExtraction(result, ipo = {}, opts = {}) {
  const rules = (opts.rules || RULES).filter((r) => r.enabled !== false);
  const threshold = opts.threshold ?? THRESHOLD;
  const ctx = { result: result || {}, ipo: ipo || {} };

  let totalWeight = 0;
  let lost = 0;
  const findings = [];

  for (const rule of rules) {
    const weight = Number(rule.weight) || 0;
    const r = evalRule(rule, ctx);
    totalWeight += weight;
    if (!r.ok && !r.skipped) lost += weight * (SEVERITY_COST[rule.severity] ?? 1);
    findings.push({
      id: rule.id,
      field: rule.field,
      type: rule.type,
      severity: rule.severity,
      weight,
      ok: r.ok,
      skipped: !!r.skipped,
      message: r.message,
      ...(r.expected !== undefined ? { expected: r.expected } : {}),
      ...(r.actual !== undefined ? { actual: r.actual } : {}),
    });
  }

  const score = totalWeight ? Math.max(0, Math.round(100 * (1 - lost / totalWeight))) : 100;
  const failed = findings.filter((f) => !f.ok && !f.skipped);
  return {
    score,
    threshold,
    status: score >= threshold ? 'pass' : 'review',
    ranAt: new Date().toISOString(),
    passed: findings.filter((f) => f.ok).length,
    failed: failed.length,
    findings,
  };
}

// ── Runtime-mutable registry (mirrors llm/schema.js) ─────────────────────────

const clone = (o) => JSON.parse(JSON.stringify(o));
let RULES = clone(DEFAULT_RULES);
let THRESHOLD = DEFAULT_THRESHOLD;

const KEY_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Validate + sanitize a candidate ruleset. Throws on the first problem.
 * Returns the sanitized clone on success.
 */
function validateRules(candidate) {
  if (!Array.isArray(candidate)) throw new Error('rules must be an array');
  const ids = new Set();
  return candidate.map((rule, i) => {
    if (!rule || typeof rule !== 'object') throw new Error(`rule[${i}] must be an object`);
    const id = String(rule.id || '');
    if (!KEY_RE.test(id)) throw new Error(`rule[${i}] has invalid id "${rule.id}" (snake_case: a-z, 0-9, _)`);
    if (ids.has(id)) throw new Error(`duplicate rule id "${id}"`);
    ids.add(id);
    if (!rule.field || typeof rule.field !== 'string') throw new Error(`rule "${id}" needs a field`);
    if (!VALID_TYPES.has(rule.type)) throw new Error(`rule "${id}" has invalid type "${rule.type}"`);
    const severity = rule.severity || 'warning';
    if (!VALID_SEVERITIES.has(severity)) throw new Error(`rule "${id}" has invalid severity "${severity}"`);
    const weight = Number(rule.weight);
    if (!Number.isFinite(weight) || weight < 0) throw new Error(`rule "${id}" needs a non-negative weight`);
    return {
      id,
      field: rule.field,
      type: rule.type,
      severity,
      weight,
      enabled: rule.enabled !== false,
      description: String(rule.description || ''),
      params: rule.params && typeof rule.params === 'object' ? rule.params : {},
    };
  });
}

function getRules() { return RULES; }
function getDefaultRules() { return clone(DEFAULT_RULES); }
function getThreshold() { return THRESHOLD; }

function setRules(candidate) { RULES = validateRules(candidate); return RULES; }
function setThreshold(t) {
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('threshold must be 0–100');
  THRESHOLD = n;
  return THRESHOLD;
}
function resetRules() { RULES = clone(DEFAULT_RULES); THRESHOLD = DEFAULT_THRESHOLD; return RULES; }

module.exports = {
  validateExtraction,
  // registry access (runtime-mutable)
  getRules,
  getDefaultRules,
  getThreshold,
  setRules,
  setThreshold,
  resetRules,
  validateRules,
  // metadata / constants
  RULE_TYPES,
  DEFAULT_THRESHOLD,
  // exposed for tests
  extractNumbers,
  evalRule,
};
