'use strict';

/**
 * tools.js — interactive inspection tools for the dashboard "PDF Lab".
 *
 * These expose the individual pipeline stages so a human can poke at a single
 * PDF without running a full extraction:
 *   • ensureLocalPdf  — download (cache) an IPO's PDF locally
 *   • inspectToc      — find ToC pages + regex section→page mapping
 *   • locateSections  — run the full LOCATE cascade, return page ranges + method
 *   • getPageText     — raw text for a page range
 *   • getPageMarkdown — pymupdf4llm markdown for a page range (preview)
 *   • suggestSchema   — give the LLM a slice of the PDF + a prompt; it proposes
 *                       new FIELDS entries to add to the schema
 */

const path = require('path');
const { env, getTargetSections } = require('./config');
const { downloadPdf } = require('./index');
const { getPageCount, getPageTexts, pagesToMarkdown } = require('./convert/pdf-bridge');
const { findTocPages, regexExtractTocMapping } = require('./locate/toc-regex');
const { getSectionRanges } = require('./locate');
const { callLlmJson } = require('./llm/client');
const { getFields } = require('./llm/schema');
const { logger } = require('../utils/logger');

const log = logger.child({ module: 'extraction:tools' });

const MAX_PREVIEW_PAGES = 12;       // cap range tools to keep responses small
const MAX_LLM_TEXT_CHARS = 60_000;  // cap text sent to the LLM

/** Resolve the docType to use for an IPO (priority: final > rhp > drhp). */
function resolveDocType(ipo, docType) {
  if (docType && docType !== 'auto') {
    if (!ipo.documents?.[docType]?.url) throw new Error(`No ${docType} URL for ${ipo.slug}`);
    return docType;
  }
  if (ipo.documents?.final?.url) return 'final';
  if (ipo.documents?.rhp?.url) return 'rhp';
  if (ipo.documents?.drhp?.url) return 'drhp';
  throw new Error(`No documents (final/rhp/drhp) for ${ipo.slug}`);
}

/** Download (or reuse cached) the IPO's PDF locally. Returns { pdfPath, docType, url }. */
async function ensureLocalPdf(ipo, docType, logMsg = () => {}) {
  const resolved = resolveDocType(ipo, docType);
  const url = ipo.documents[resolved].url;
  const outputDir = path.join(env.OUTPUT_DIR, ipo.slug);
  logMsg(`ensuring ${resolved} PDF for ${ipo.slug}...`);
  const pdfPath = await downloadPdf(url, outputDir, false);
  logMsg(`PDF ready: ${pdfPath}`);
  return { pdfPath, docType: resolved, url, outputDir };
}

function clampRange(start, end, total) {
  let s = Math.max(0, parseInt(start, 10) || 0);
  let e = end == null ? s + MAX_PREVIEW_PAGES - 1 : parseInt(end, 10);
  if (total != null) { s = Math.min(s, total - 1); e = Math.min(e, total - 1); }
  if (e < s) e = s;
  if (e - s + 1 > MAX_PREVIEW_PAGES) e = s + MAX_PREVIEW_PAGES - 1;
  return [s, e];
}

/** Find ToC pages + regex section→printed-page mapping. */
async function inspectToc(ipo, docType, logMsg = () => {}) {
  const { pdfPath, docType: dt } = await ensureLocalPdf(ipo, docType, logMsg);
  const totalPages = await getPageCount(pdfPath);
  logMsg('scanning for Table of Contents pages...');
  const tocPages = await findTocPages(pdfPath);
  logMsg(`ToC pages: ${tocPages.length ? tocPages.join(', ') : 'none found'}`);
  const mapping = tocPages.length ? await regexExtractTocMapping(pdfPath, tocPages, totalPages) : {};
  logMsg(`regex matched ${Object.keys(mapping).length} sections`);
  return { slug: ipo.slug, docType: dt, totalPages, tocPages, mapping };
}

/** Run the full LOCATE cascade and return page ranges + the method used per section. */
async function locateSections(ipo, docType, targets, logMsg = () => {}) {
  const { pdfPath, docType: dt } = await ensureLocalPdf(ipo, docType, logMsg);
  const sections = Array.isArray(targets) && targets.length ? targets : getTargetSections();
  const ranges = await getSectionRanges(pdfPath, sections, logMsg);
  return { slug: ipo.slug, docType: dt, ranges };
}

/** Raw text for a page range (0-indexed inclusive, clamped to MAX_PREVIEW_PAGES). */
async function getPageText(ipo, docType, start, end, logMsg = () => {}) {
  const { pdfPath, docType: dt } = await ensureLocalPdf(ipo, docType, logMsg);
  const total = await getPageCount(pdfPath);
  const [s, e] = clampRange(start, end, total);
  logMsg(`extracting text for pages ${s}–${e} (of ${total})...`);
  const pages = await getPageTexts(pdfPath, s, e);
  return { slug: ipo.slug, docType: dt, totalPages: total, start: s, end: e, pages };
}

/** Markdown (pymupdf4llm) for a page range — the same conversion extraction uses. */
async function getPageMarkdown(ipo, docType, start, end, logMsg = () => {}) {
  const { pdfPath, docType: dt } = await ensureLocalPdf(ipo, docType, logMsg);
  const total = await getPageCount(pdfPath);
  const [s, e] = clampRange(start, end, total);
  logMsg(`converting pages ${s}–${e} (of ${total}) to markdown...`);
  const markdown = await pagesToMarkdown(pdfPath, s, e);
  return { slug: ipo.slug, docType: dt, totalPages: total, start: s, end: e, markdown };
}

// ── LLM-assisted schema suggestion ─────────────────────────────────────────────

const SUGGEST_SYSTEM = `You are a schema-design assistant for an Indian IPO (DRHP/RHP) data-extraction pipeline.
The pipeline stores each extractable datapoint as a "field" in a registry. A field definition looks like:
  { "type": "string" | "list" | "objectList", "format"?: "date"|"period"|"percent"|"currency"|"category", "description": "...", "fields"?: { ...sub-fields for objectList... }, "mergeKey"?: "subFieldKey", "mergeMatch"?: "similar"|"category" }
Rules:
- "string" = one value; "list" = array of strings; "objectList" = a table (rows of string sub-fields).
- objectList sub-fields are ALWAYS type "string" (optionally with a format).
- Use snake_case keys (a-z, 0-9, _). Do NOT propose keys that already exist.
- Only propose fields whose data you actually SEE in the provided text.`;

/**
 * Ask the LLM whether the requested data exists in the PDF slice, and to propose
 * schema field(s) for it.
 *
 * @param {object} ipo
 * @param {string} docType
 * @param {string} userPrompt   What the user wants (e.g. "I want a loans table")
 * @param {object} [opts]        { start, end }
 * @returns {Promise<{explanation, found, proposedFields, evidence}>}
 */
async function suggestSchema(ipo, docType, userPrompt, opts = {}, logMsg = () => {}) {
  const { pdfPath, docType: dt } = await ensureLocalPdf(ipo, docType, logMsg);
  const total = await getPageCount(pdfPath);
  const [s, e] = clampRange(opts.start, opts.end == null ? Math.min(total - 1, (parseInt(opts.start, 10) || 0) + MAX_PREVIEW_PAGES - 1) : opts.end, total);

  logMsg(`reading pages ${s}–${e} for LLM analysis...`);
  const pages = await getPageTexts(pdfPath, s, e);
  let text = pages.map((p) => `=== PAGE ${p.page} ===\n${p.text}`).join('\n\n');
  if (text.length > MAX_LLM_TEXT_CHARS) text = text.slice(0, MAX_LLM_TEXT_CHARS);

  const existingKeys = Object.keys(getFields());

  const prompt = `${SUGGEST_SYSTEM}

EXISTING FIELD KEYS (do not duplicate): ${existingKeys.join(', ')}

USER REQUEST: ${userPrompt}

PROSPECTUS TEXT (pages ${s}–${e}):
${text}

Respond with STRICT JSON only, no markdown:
{
  "found": true | false,                         // is the requested data present in the text?
  "explanation": "1-3 sentences on what you found and where",
  "evidence": ["short verbatim snippet 1", "snippet 2"],   // quotes that justify the fields
  "proposedFields": {                            // {} if nothing to add
     "field_key": { "type": "...", "format": "...", "description": "...", "fields": { ... }, "mergeKey": "...", "mergeMatch": "..." }
  }
}`;

  logMsg('asking the LLM to analyze and propose schema fields...');
  const result = await callLlmJson(prompt, { maxTokens: 3000, cache: false, cacheNs: 'schema_suggest' });
  log.info({ slug: ipo.slug, proposed: Object.keys(result?.proposedFields || {}).length }, 'schema suggestion complete');

  return {
    slug: ipo.slug,
    docType: dt,
    pageRange: [s, e],
    found: !!result.found,
    explanation: result.explanation || '',
    evidence: Array.isArray(result.evidence) ? result.evidence : [],
    proposedFields: (result.proposedFields && typeof result.proposedFields === 'object') ? result.proposedFields : {},
  };
}

module.exports = {
  resolveDocType,
  ensureLocalPdf,
  inspectToc,
  locateSections,
  getPageText,
  getPageMarkdown,
  suggestSchema,
};
