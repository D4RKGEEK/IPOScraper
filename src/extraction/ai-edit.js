'use strict';

/**
 * ai-edit.js — LLM-assisted editing of the extraction SCHEMA and the VALIDATION
 * ruleset from a freeform natural-language instruction (the same idea as the PDF
 * Lab's suggestSchema, but operating on the whole config instead of a PDF).
 *
 *   "drop the peer_comparison field and add a field for the company's GST number"
 *   "be stricter: require at least 5 risk factors and make lot_size an error"
 *
 * ┌─ SAFETY CONTRACT ─────────────────────────────────────────────────────────┐
 * │  The LLM's raw output is NEVER trusted. Every proposal is run through the   │
 * │  SAME strict validator the manual editor uses                              │
 * │  (schema.validateFields / validate.validateRules). Only the sanitized,     │
 * │  validated object is ever returned/applied — so a malformed AI response    │
 * │  can't break normalize(), buildJsonSchema(), merge(), or evalRule().       │
 * │  On a validation failure we return the error + the raw output for the UI;  │
 * │  nothing is applied.                                                       │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * These functions only COMPUTE a validated proposal — persisting (with a backup)
 * is the caller's job via configRepository.saveSchema / saveValidation.
 */

// Required as a namespace (not destructured) so the call site reads the live
// `callLlmJson` off the module — keeps it stubbable in tests via spyOn.
const llmClient = require('./llm/client');
const schemaStore = require('./llm/schema');
const validationStore = require('./validate');

// ── Shared helpers ───────────────────────────────────────────────────────────

/** Summarize what changed between two keyed maps (for the UI preview). */
function diffKeys(before, after) {
  const a = new Set(Object.keys(before));
  const b = new Set(Object.keys(after));
  const added = [...b].filter((k) => !a.has(k));
  const removed = [...a].filter((k) => !b.has(k));
  const changed = [...b].filter((k) => a.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  return { added, removed, changed };
}

/**
 * HARD-VALIDATE a raw model output with `validator` (THE safety gate). Returns
 * the sanitized object on success; throws an Error tagged with `.raw` and
 * `.status = 422` on failure so the caller can surface the bad output. Pure —
 * no IO — so it is unit-tested directly without mocking the LLM.
 */
function gate(candidate, validator, raw) {
  try {
    return validator(candidate);
  } catch (e) {
    const err = new Error(`AI proposal failed validation: ${e.message}`);
    err.raw = raw;
    err.status = 422; // unprocessable — the model produced structurally invalid config
    throw err;
  }
}

// ── Schema editing ─────────────────────────────────────────────────────────────

const SCHEMA_SPEC = `A field definition is:
  { "type": "string" | "list" | "objectList", "format"?: "date"|"period"|"percent"|"currency"|"category", "description": "...", "fields"?: { <sub-fields for objectList> }, "mergeKey"?: "subFieldKey", "mergeMatch"?: "similar"|"category" }
Rules:
- "string" = one value; "list" = array of strings; "objectList" = a table whose sub-fields are ALWAYS type "string" (optionally with a format).
- Keys are snake_case (a-z, 0-9, _). objectList must declare at least one sub-field.
- A mergeKey, if present, must name one of that objectList's sub-fields.`;

function schemaPrompt(current, instruction) {
  return `You edit the field registry (schema) of an Indian IPO (DRHP/RHP) data-extraction pipeline.

${SCHEMA_SPEC}

CURRENT SCHEMA (JSON):
${JSON.stringify(current, null, 2)}

USER INSTRUCTION (apply exactly what is asked; keep everything else unchanged):
${instruction}

Respond with STRICT JSON only, no markdown:
{
  "explanation": "1-3 sentences describing the changes you made",
  "fields": { <the COMPLETE updated schema — every field that should exist, not just the changes> }
}`;
}

/**
 * PURE: turn a raw model response into a validated schema proposal + diff.
 * Throws (422, .raw) if the model output fails the schema validator.
 */
function buildSchemaProposal(raw, current = schemaStore.getFields()) {
  const proposed = gate(raw && raw.fields, schemaStore.validateFields, raw);
  return { explanation: String((raw && raw.explanation) || ''), proposed, diff: diffKeys(current, proposed), raw };
}

/**
 * Update the field SCHEMA from a freeform instruction (LLM call + safety gate).
 * @param {string} instruction  what the user wants added / removed / changed
 * @returns {Promise<{ explanation, proposed, diff, raw }>}
 */
async function aiEditSchema(instruction) {
  if (!instruction || !String(instruction).trim()) throw new Error('instruction is required');
  const current = schemaStore.getFields();
  const raw = await llmClient.callLlmJson(schemaPrompt(current, instruction), { maxTokens: 4000, cache: false, cacheNs: 'schema_ai_edit' });
  return buildSchemaProposal(raw, current);
}

// ── Validation-rule editing ─────────────────────────────────────────────────────

function ruleSpec() {
  const types = Object.entries(validationStore.RULE_TYPES)
    .map(([t, m]) => `  - "${t}": params [${m.params.join(', ') || 'none'}] — ${m.note}`)
    .join('\n');
  return `A rule is:
  { "id": "snake_case", "field": "<result field key>", "type": <one of below>, "severity": "error"|"warning"|"info", "weight": <number>, "enabled": true, "description": "...", "params": { ... } }
Rule types and their params:
${types}
Notes:
- "field" is a key in the extraction result (e.g. "price_band", "financials").
- cross_check compares against the scraped master IPO record via params.against (e.g. "priceBand", "companyName").
- weight is the rule's contribution to the 0-100 score; errors cost full weight, warnings 40%.`;
}

function validationPrompt(currentRules, currentThreshold, instruction) {
  return `You edit the VALIDATION ruleset of an Indian IPO data-extraction pipeline. Each extraction result is scored 0-100 against these rules; below the threshold it is flagged for human review.

${ruleSpec()}

CURRENT THRESHOLD: ${currentThreshold}
CURRENT RULES (JSON array):
${JSON.stringify(currentRules, null, 2)}

USER INSTRUCTION (apply exactly what is asked; keep everything else unchanged):
${instruction}

Respond with STRICT JSON only, no markdown:
{
  "explanation": "1-3 sentences describing the changes you made",
  "threshold": <number 0-100 — repeat the current value unless the user asked to change it>,
  "rules": [ <the COMPLETE updated rules array — every rule that should exist, not just the changes> ]
}`;
}

/**
 * PURE: turn a raw model response into a validated ruleset proposal + threshold +
 * diff + soft warnings. Throws (422, .raw) if the model output fails the validator.
 */
function buildValidationProposal(raw, current = validationStore.getRules(), currentThreshold = validationStore.getThreshold(), schemaFields = Object.keys(schemaStore.getFields())) {
  const proposed = gate(raw && raw.rules, validationStore.validateRules, raw);
  const byId = Object.fromEntries(current.map((r) => [r.id, r]));

  // Soft warnings: rules referencing a field not in the current schema. Not a
  // hard block (sub-paths / future fields are legitimate), just a heads-up.
  const known = new Set(schemaFields);
  const warnings = proposed
    .filter((r) => !known.has(r.field))
    .map((r) => `rule "${r.id}" targets field "${r.field}" which is not in the current schema`);

  let threshold = currentThreshold;
  if (raw && raw.threshold != null) {
    const t = Number(raw.threshold);
    if (Number.isFinite(t) && t >= 0 && t <= 100) threshold = t;
  }

  return {
    explanation: String((raw && raw.explanation) || ''),
    proposed,
    threshold,
    diff: diffKeys(byId, Object.fromEntries(proposed.map((r) => [r.id, r]))),
    warnings,
    raw,
  };
}

/**
 * Update the VALIDATION ruleset from a freeform instruction (LLM call + gate).
 * @param {string} instruction
 * @returns {Promise<{ explanation, proposed, threshold, diff, warnings, raw }>}
 */
async function aiEditValidation(instruction) {
  if (!instruction || !String(instruction).trim()) throw new Error('instruction is required');
  const currentRules = validationStore.getRules();
  const currentThreshold = validationStore.getThreshold();
  const raw = await llmClient.callLlmJson(validationPrompt(currentRules, currentThreshold, instruction), { maxTokens: 4000, cache: false, cacheNs: 'validation_ai_edit' });
  return buildValidationProposal(raw, currentRules, currentThreshold, Object.keys(schemaStore.getFields()));
}

module.exports = {
  aiEditSchema,
  aiEditValidation,
  // pure cores (LLM-independent; unit-tested directly)
  buildSchemaProposal,
  buildValidationProposal,
  diffKeys,
};
