'use strict';

/**
 * eval.js — cross-pipeline comparison + golden-set regression evaluation.
 *
 *   compareResults(rows)              — align stored extractions field-by-field
 *                                       across pipelines, flagging disagreements.
 *   diffResult(candidate, golden)     — field-level accuracy of a candidate
 *                                       result vs a verified golden result.
 *   runEval({ pipeline, limit, log }) — re-extract every golden with the CURRENT
 *                                       schema and score accuracy vs the golden.
 *
 * The compare + diff functions are PURE (no IO) and unit-tested directly.
 */

const { isPlaceholder, getFields } = require('./llm/schema');
const { jaroWinkler } = require('../utils/jaroWinkler');

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

/** Jaccard similarity of two string arrays (case-insensitive). 1 if both empty. */
function jaccard(a = [], b = []) {
  const sa = new Set(a.map(norm).filter(Boolean));
  const sb = new Set(b.map(norm).filter(Boolean));
  if (!sa.size && !sb.size) return 1;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter || 1);
}

/** Per-field similarity (0..1) of a candidate value vs the golden value. */
function fieldSimilarity(type, cand, gold) {
  if (type === 'list') return jaccard(Array.isArray(cand) ? cand : [], Array.isArray(gold) ? gold : []);
  if (type === 'objectList') {
    const ca = (Array.isArray(cand) ? cand : []).map((r) => JSON.stringify(r));
    const ga = (Array.isArray(gold) ? gold : []).map((r) => JSON.stringify(r));
    return jaccard(ca, ga);
  }
  // string: both empty/placeholder → match; else exact-normalized, else a fuzzy
  // partial credit so near-misses don't read as total failures.
  const ce = isPlaceholder(cand); const ge = isPlaceholder(gold);
  if (ce && ge) return 1;
  if (ce || ge) return 0;
  if (norm(cand) === norm(gold)) return 1;
  const sim = jaroWinkler(norm(cand), norm(gold));
  return sim >= 0.92 ? sim : 0; // only credit very close strings
}

/**
 * Field-level accuracy of a candidate result vs a golden result.
 * @returns {{ overall, matched, total, fieldScores }}
 */
function diffResult(candidate = {}, golden = {}, fields = getFields()) {
  const keys = Object.keys(golden);
  const fieldScores = {};
  let sum = 0;
  let total = 0;
  let matched = 0;
  for (const k of keys) {
    const type = (fields[k] && fields[k].type) || (Array.isArray(golden[k]) ? 'list' : 'string');
    const s = fieldSimilarity(type, candidate[k], golden[k]);
    fieldScores[k] = Math.round(s * 100) / 100;
    sum += s; total += 1;
    if (s >= 0.999) matched += 1;
  }
  return { overall: total ? Math.round((sum / total) * 100) / 100 : null, matched, total, fieldScores };
}

/**
 * Align several stored extraction rows (different pipelines, same IPO+doc)
 * field-by-field for side-by-side comparison.
 * @param {object[]} rows  [{ pipeline, result }]
 * @returns {{ pipelines, fields }}  fields: [{ key, type, values:{pipeline:val}, agree }]
 */
function compareResults(rows = [], fields = getFields()) {
  const usable = rows.filter((r) => r && r.result && typeof r.result === 'object');
  const pipelines = usable.map((r) => r.pipeline);
  const keys = new Set();
  for (const r of usable) for (const k of Object.keys(r.result)) keys.add(k);

  const out = [];
  for (const k of keys) {
    const type = (fields[k] && fields[k].type) || 'string';
    const values = {};
    const reprs = [];
    for (const r of usable) {
      const v = r.result[k];
      values[r.pipeline] = v;
      reprs.push(type === 'string' ? norm(v) : JSON.stringify(Array.isArray(v) ? v : []));
    }
    const agree = reprs.every((x) => x === reprs[0]);
    out.push({ key: k, type, values, agree });
  }
  // disagreements first, then alphabetical
  out.sort((a, b) => (a.agree === b.agree ? a.key.localeCompare(b.key) : a.agree ? 1 : -1));
  return { pipelines, fields: out };
}

/**
 * Run a regression eval: for every golden, re-extract with the CURRENT schema +
 * the given pipeline (no save) and score accuracy vs the golden result.
 * Heavy (one LLM call per golden) — runs on the tracked heavy lane.
 *
 * @param {object} opts  { pipeline='gemini', limit, log }
 * @param {object} deps  { collections, findBySlug, testSchemaOnIpo } (injected to avoid a require cycle)
 */
async function runEval(opts, deps) {
  const { pipeline = 'gemini', limit, log = () => {} } = opts || {};
  const { collections, findBySlug, testSchemaOnIpo } = deps;
  const fields = getFields();

  const goldens = await collections.golden().find({}).sort({ capturedAt: -1 }).limit(limit || 1000).toArray();
  log(`evaluating ${goldens.length} golden record(s) with pipeline=${pipeline}...`);

  const items = [];
  for (const g of goldens) {
    const ipo = await findBySlug(g.ipoSlug);
    if (!ipo) { items.push({ slug: g.ipoSlug, docType: g.docType, error: 'IPO not found' }); continue; }
    try {
      log(`→ ${g.ipoSlug} (${g.docType})`);
      const out = await testSchemaOnIpo(ipo, { fields, docType: g.docType, pipeline, log: () => {} });
      const diff = diffResult(out.result, g.result, fields);
      items.push({ slug: g.ipoSlug, docType: g.docType, accuracy: diff.overall, matched: diff.matched, total: diff.total, score: out.validation?.score, fieldScores: diff.fieldScores });
      log(`  accuracy ${(diff.overall * 100).toFixed(0)}% (${diff.matched}/${diff.total} fields exact)`);
    } catch (e) {
      items.push({ slug: g.ipoSlug, docType: g.docType, error: e.message });
      log(`  ERROR: ${e.message}`);
    }
  }

  const accs = items.filter((i) => i.accuracy != null).map((i) => i.accuracy);
  const meanAccuracy = accs.length ? Math.round((accs.reduce((a, b) => a + b, 0) / accs.length) * 100) / 100 : null;
  const run = {
    pipeline,
    count: items.length,
    evaluated: accs.length,
    errors: items.filter((i) => i.error).length,
    meanAccuracy,
    fieldCount: Object.keys(fields).length,
    items,
    createdAt: new Date().toISOString(),
  };
  const res = await collections.evalRuns().insertOne(run);
  log(`eval complete — mean accuracy ${meanAccuracy != null ? (meanAccuracy * 100).toFixed(0) + '%' : 'n/a'}`);
  return { runId: res.insertedId.toString(), ...run };
}

module.exports = { compareResults, diffResult, fieldSimilarity, jaccard, runEval };
