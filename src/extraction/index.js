'use strict';

/**
 * extraction/index.js — Main orchestrator for the PDF extraction pipeline.
 *
 * runExtraction(ipo, opts)     — extract from a single IPO's document
 * runBulkExtraction(opts)      — extract from all IPOs matching a filter
 *
 * Integrates with the existing scraper data model:
 *   - Reads PDF URLs from ipo.documents.drhp.url / ipo.documents.rhp.url
 *   - Stores results in the 'extractions' MongoDB collection
 *   - Uses the existing job tracking system for progress logging
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline: streamPipeline } = require('stream/promises');
const { getSectionRanges } = require('./locate');
const { pagesToMarkdown } = require('./convert/pdf-bridge');
const { runGeminiExtraction } = require('./extract/gemini');
const { runFirecrawlExtraction } = require('./extract/firecrawl');
const { mergeSectionResponses } = require('./extract/merge');
const { normalize, isPlaceholder, withFields, validateFields } = require('./llm/schema');
const { validateExtraction } = require('./validate');
const { env, getCascadeOrder } = require('./config');
const { resetUsage, getUsage } = require('./usage');
const { runOpenAIExtraction } = require('./extract/openai');
const { collections } = require('../db/mongo');
const { findBySlug, reconcileExtractions } = require('../db/ipoRepository');
const r2 = require('../storage/r2');
const { serializeMergedMarkdown, splitMergedMarkdown } = require('./markdown');
const { logger } = require('../utils/logger');

const log = logger.child({ module: 'extraction' });

/**
 * Check if the extraction output is proper/complete.
 * Must have company_name and at least 8 populated fields.
 */
function isExtractionProper(result) {
  if (!result || typeof result !== 'object') return false;
  if (isPlaceholder(result.company_name)) return false;

  let populatedCount = 0;
  for (const val of Object.values(result)) {
    if (Array.isArray(val)) {
      if (val.length > 0) populatedCount++;
    } else if (!isPlaceholder(val)) {
      populatedCount++;
    }
  }

  return populatedCount >= 8;
}

/**
 * DeepSeek structured extraction fallback.
 */
async function runDeepSeekExtraction(outputDir, sections) {
  const { callLlmJson } = require('./llm/client');
  const { getIpoDetailsSchema } = require('./llm/schema');

  // Read merged markdown
  const mergedPath = path.join(outputDir, 'merged.md');
  let mergedText = '';
  if (fs.existsSync(mergedPath)) {
    mergedText = fs.readFileSync(mergedPath, 'utf8');
  } else {
    const mergedParts = [];
    for (const section of sections) {
      const mdPath = path.join(outputDir, `${section}.md`);
      if (fs.existsSync(mdPath)) {
        mergedParts.push(`# SECTION: ${section}\n\n${fs.readFileSync(mdPath, 'utf8')}\n`);
      }
    }
    mergedText = mergedParts.join('\n\n');
  }

  const prompt = `You are an expert financial analyst specializing in Indian IPOs.
Extract all available structured information from the following DRHP/RHP prospectus text.
You must output a strictly valid JSON object matching the JSON Schema provided. Do not include any explanation or markdown formatting (e.g. no \`\`\`json blocks), just output raw JSON.
For any fields not found in the text, return null.

JSON SCHEMA:
${JSON.stringify(getIpoDetailsSchema())}

PROSPECTUS TEXT:
${mergedText}`;

  log.info('calling DeepSeek structured extraction fallback');
  const result = await callLlmJson(prompt, { maxTokens: 4000 });

  // Save result
  const resultPath = path.join(outputDir, 'summary_deepseek.json');
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
  log.info({ resultPath }, 'DeepSeek structured extraction complete');

  return result;
}

// ── PDF download ─────────────────────────────────────────────────────────────

async function downloadPdf(url, outputDir, force = false) {
  fs.mkdirSync(outputDir, { recursive: true });

  // Derive filename from URL
  const urlObj = new URL(url);
  let filename = path.basename(urlObj.pathname) || 'document.pdf';
  if (!filename.endsWith('.pdf')) filename += '.pdf';

  const localPath = path.join(outputDir, filename);

  if (fs.existsSync(localPath) && !force) {
    log.debug({ localPath }, 'PDF already downloaded');
    return localPath;
  }

  log.info({ url, localPath }, 'downloading PDF');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PDF download failed: ${res.status} ${res.statusText}`);

  const contentLength = parseInt(res.headers.get('content-length'), 10);

  const fileStream = fs.createWriteStream(localPath);
  try {
    await streamPipeline(res.body, fileStream);
  } catch (err) {
    if (fs.existsSync(localPath)) {
      try { fs.unlinkSync(localPath); } catch (e) { }
    }
    throw err;
  }

  const stats = fs.statSync(localPath);

  // Validate size against content-length if provided to prevent caching truncated downloads
  if (!isNaN(contentLength) && stats.size < contentLength) {
    if (fs.existsSync(localPath)) {
      try { fs.unlinkSync(localPath); } catch (e) { }
    }
    throw new Error(`PDF download truncated: got ${stats.size} bytes of expected ${contentLength}`);
  }

  log.info({ localPath, bytes: stats.size }, 'PDF downloaded');

  return localPath;
}

/** SHA-256 of a file's bytes — the document content fingerprint for dedup. */
function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// ── Section conversion (Phase 2) ─────────────────────────────────────────────

/**
 * Convert located sections to markdown files using pymupdf4llm.
 *
 * @param {string} pdfPath
 * @param {string} outputDir
 * @param {object} ranges  { SECTION_KEY: { range: [start, end], method } }
 * @param {function} [logMsg] progress logger
 * @returns {Promise<string[]>} Section names that were successfully converted
 */
async function convertSections(pdfPath, outputDir, ranges, logMsg) {
  const converted = [];

  // Always extract cover pages (fixed range)
  const allSections = { COVER_PAGES: { range: [0, 1], method: 'fixed' }, ...ranges };

  for (const [section, info] of Object.entries(allSections)) {
    if (!info.range) {
      if (logMsg) logMsg(`skipping ${section} (not found)`);
      continue;
    }

    const [start, end] = info.range;
    try {
      const md = await pagesToMarkdown(pdfPath, start, end);
      const mdPath = path.join(outputDir, `${section}.md`);
      fs.writeFileSync(mdPath, md, 'utf8');
      converted.push(section);
      if (logMsg) logMsg(`converted ${section} (pages ${start}–${end}) → ${section}.md`);
    } catch (e) {
      log.warn({ section, err: e.message }, 'failed to convert section');
      if (logMsg) logMsg(`failed to convert ${section}: ${e.message}`);
    }
  }

  return converted;
}

// ── Main orchestrator ────────────────────────────────────────────────────────

/**
 * Run the full extraction pipeline on a single IPO's document.
 *
 * @param {object} ipo     Full IPO document from MongoDB
 * @param {object} opts
 * @param {string} [opts.pipeline='gemini']  'gemini' | 'firecrawl' | 'both'
 * @param {string} [opts.docType='drhp']     'drhp' | 'rhp'
 * @param {boolean} [opts.force=false]       Re-extract even if cached
 * @param {function} [opts.log]              Progress logging callback
 * @returns {Promise<object>} { slug, docType, pipeline, sections, result }
 */
async function runExtraction(ipo, opts = {}) {
  let { pipeline = 'cascade', docType = 'auto', force = false } = opts;
  const logMsg = opts.log || (() => { });

  // Auto-pick pipeline
  if (!pipeline || pipeline === 'default' || pipeline === 'deepseek') {
    pipeline = 'cascade';
  } else if (pipeline !== 'gemini' && pipeline !== 'firecrawl' && pipeline !== 'both' && pipeline !== 'cascade') {
    pipeline = 'cascade';
  }

  // Auto-pick docType based on priority: rhp > drhp
  if (!docType || docType === 'auto') {
    if (ipo.documents?.rhp?.url) {
      docType = 'rhp';
    } else if (ipo.documents?.drhp?.url) {
      docType = 'drhp';
    } else {
      throw new Error(`No documents (rhp or drhp) found for IPO ${ipo.slug}`);
    }
  }

  resetUsage();

  const pdfUrl = ipo.documents?.[docType]?.url;
  if (!pdfUrl) throw new Error(`No ${docType} URL found for IPO ${ipo.slug}`);

  const outputDir = path.join(env.OUTPUT_DIR, ipo.slug);
  fs.mkdirSync(outputDir, { recursive: true });

  let ranges;
  let converted;

  // Prior extraction row for this exact document (used for hash-based dedup).
  const existing = !force
    ? await collections.extractions().findOne({ ipoSlug: ipo.slug, docType, pipeline })
    : null;

  // Failure transparency: track the current phase + per-engine errors so a crash
  // mid-pipeline records WHERE it died and what each engine reported.
  let phase = 'download';
  const engineErrors = {};
  try {

    // ── Phase 0: Download PDF + content fingerprint ────────────────────────
    logMsg(`downloading ${docType} PDF...`);
    const pdfPath = await downloadPdf(pdfUrl, outputDir, force);
    const contentHash = sha256File(pdfPath);
    const sameContent = !!(existing && existing.contentHash === contentHash);

    // ── Dedup short-circuit ────────────────────────────────────────────────
    // Byte-identical document already extracted successfully → reuse the stored
    // result and skip the expensive convert + LLM cascade entirely.
    if (sameContent && existing.status !== 'failed' && existing.result) {
      logMsg('document unchanged (content hash match) — reusing previous extraction');
      if (process.env.NODE_ENV === 'production') {
        try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (e) { }
      }
      try { await reconcileExtractions(ipo.slug); } catch (e) { log.warn({ err: e.message }, 'reconcile after cache hit failed'); }
      return {
        slug: ipo.slug,
        docType,
        pipeline,
        sections: Object.fromEntries(
          Object.entries(existing.sections || {}).map(([k, v]) => [k, v && v.method]),
        ),
        result: existing.result,
        validation: existing.validation || null,
        usage: getUsage(),
        cached: true,
      };
    }

    // ── Phase 1–2: reuse cached markdown only if it matches THIS content ────
    // Existence isn't enough — stale markdown from a since-changed PDF must not
    // be reused. The content hash gates it: same bytes → the cached markdown is
    // still valid, so skip the locate + convert.
    const cachedMd = sameContent ? await r2.getMarkdown(ipo.slug, docType) : null;
    if (cachedMd) {
      logMsg('reusing cached markdown (content unchanged) — skipping convert');
      const parts = splitMergedMarkdown(cachedMd);
      for (const { name, content } of parts) {
        fs.writeFileSync(path.join(outputDir, `${name}.md`), content, 'utf8');
      }
      converted = parts.map((p) => p.name);
      ranges = Object.fromEntries(converted.map((name) => [name, { method: 'cached' }]));
      logMsg(`rehydrated ${converted.length} cached sections: ${converted.join(', ')}`);
    } else {
      // ── Phase 1: LOCATE sections ─────────────────────────────────────────
      phase = 'locate';
      logMsg('locating sections...');
      ranges = await getSectionRanges(pdfPath, undefined, logMsg);

      const foundSections = Object.entries(ranges)
        .filter(([, v]) => v.range)
        .map(([k]) => k);

      logMsg(`found ${foundSections.length} sections: ${foundSections.join(', ')}`);

      // ── Phase 2: CONVERT pages → markdown ────────────────────────────────
      phase = 'convert';
      logMsg('converting pages to markdown...');
      converted = await convertSections(pdfPath, outputDir, ranges, logMsg);

      // Cache the merged markdown so an unchanged-content re-run skips convert.
      if (r2.isEnabled() && converted.length) {
        try {
          const mergedParts = converted.map((name) => ({
            name,
            content: fs.readFileSync(path.join(outputDir, `${name}.md`), 'utf8'),
          }));
          await r2.putMarkdown(ipo.slug, docType, serializeMergedMarkdown(mergedParts));
          logMsg('cached merged markdown to R2');
        } catch (e) {
          log.warn({ err: e.message }, 'failed to cache markdown to R2');
        }
      }
    }

    // ── Phase 3: EXTRACT structured data ───────────────────────────────────
    phase = 'extract';
    const results = {};
    let finalResult = null;
    let extractionStatus = 'completed';

    if (pipeline === 'cascade') {
      const cascade = getCascadeOrder();
      logMsg(`running Cascade extraction with order: ${cascade.join(' > ')}...`);

      // Firecrawl is always first (primary extraction)
      logMsg('1/4: running Firecrawl extraction...');
      try {
        const sectionResponses = await runFirecrawlExtraction(outputDir, converted, ipo.slug, logMsg);
        results.firecrawl = mergeSectionResponses(sectionResponses);

        const fcPath = path.join(outputDir, 'summary_firecrawl.json');
        fs.writeFileSync(fcPath, JSON.stringify(results.firecrawl, null, 2), 'utf8');
        logMsg('Firecrawl extraction complete');
      } catch (e) {
        log.warn({ err: e.message }, 'Firecrawl extraction failed');
        logMsg(`Firecrawl extraction failed: ${e.message}`);
        results.firecrawl = null;
        engineErrors.firecrawl = e.message;
      }

      // Use Firecrawl if proper, else try fallbacks in configured order
      let currentFallback = results.firecrawl;
      if (isExtractionProper(currentFallback)) {
        logMsg('Firecrawl extraction is proper. Completed.');
        finalResult = currentFallback;
      } else {
        logMsg('Firecrawl result incomplete/not proper. Flagging for review and falling back...');
        extractionStatus = 'review';

        // Try fallbacks in configured order (gemini, deepseek, openai)
        let fallbackIndex = 1;
        for (const engine of cascade) {
          if (engine === 'firecrawl') continue; // Already tried

          fallbackIndex++;
          logMsg(`${fallbackIndex}/4: running ${engine} extraction fallback...`);
          try {
            let result;
            if (engine === 'gemini') {
              result = await runGeminiExtraction(outputDir, converted);
            } else if (engine === 'deepseek') {
              result = await runDeepSeekExtraction(outputDir, converted);
            } else if (engine === 'openai') {
              result = await runOpenAIExtraction(outputDir, converted);
            }

            results[engine] = result;
            logMsg(`${engine} extraction complete`);

            if (isExtractionProper(result)) {
              logMsg(`${engine} fallback result is proper.`);
              finalResult = result;
              break;
            }
          } catch (e) {
            log.error({ err: e.message }, `${engine} fallback failed`);
            logMsg(`${engine} fallback failed: ${e.message}`);
            results[engine] = null;
            engineErrors[engine] = e.message;
          }
        }

        // Use best available result from fallback chain
        if (!finalResult) {
          finalResult = results.gemini || results.deepseek || results.openai || results.firecrawl || null;
        }
      }
    } else {
      // Standard pipelines
      if (pipeline === 'gemini' || pipeline === 'both') {
        logMsg('running Gemini extraction...');
        try {
          results.gemini = await runGeminiExtraction(outputDir, converted);
          logMsg('Gemini extraction complete');
        } catch (e) {
          log.error({ err: e.message }, 'Gemini extraction failed');
          logMsg(`Gemini extraction failed: ${e.message}`);
          results.gemini = null;
          engineErrors.gemini = e.message;
        }
      }

      if (pipeline === 'firecrawl' || pipeline === 'both') {
        logMsg('running Firecrawl extraction...');
        try {
          const sectionResponses = await runFirecrawlExtraction(outputDir, converted, ipo.slug, logMsg);
          results.firecrawl = mergeSectionResponses(sectionResponses);

          // Save merged result
          const fcPath = path.join(outputDir, 'summary_firecrawl.json');
          fs.writeFileSync(fcPath, JSON.stringify(results.firecrawl, null, 2), 'utf8');
          logMsg('Firecrawl extraction complete');
        } catch (e) {
          log.error({ err: e.message }, 'Firecrawl extraction failed');
          logMsg(`Firecrawl extraction failed: ${e.message}`);
          results.firecrawl = null;
          engineErrors.firecrawl = e.message;
        }
      }

      finalResult = pipeline === 'both' ? results : (results[pipeline] || null);
    }

    // ── Normalize to the canonical schema shape ────────────────────────────
    // Force whichever engine won into the exact format defined in llm/schema.js:
    // every field present, extra keys dropped, missing scalars → "[-]", missing
    // lists → []. This is what guarantees a consistent output regardless of which
    // engine (Firecrawl / Gemini / DeepSeek) produced the data.
    let validation = null;
    if (finalResult) {
      if (pipeline === 'both') {
        if (finalResult.gemini) finalResult.gemini = normalize(finalResult.gemini);
        if (finalResult.firecrawl) finalResult.firecrawl = normalize(finalResult.firecrawl);
      } else {
        finalResult = normalize(finalResult);

        // ── Validate: score the result and set the review status from it ──────
        // The score (vs the dashboard-editable ruleset) supersedes the coarse
        // isExtractionProper() gate used above for engine selection. Below the
        // below threshold → 'review' so a human can correct it (this is the
        // status the dashboard review queue, KPI and resolve button all key on).
        validation = validateExtraction(finalResult, ipo);
        extractionStatus = validation.status === 'pass' ? 'completed' : 'review';
        logMsg(`validation score ${validation.score}/100 → ${extractionStatus}` +
          (validation.failed ? ` (${validation.failed} rule(s) failed)` : ''));
      }
    } else {
      extractionStatus = 'failed';
    }

    // ── Save to MongoDB ────────────────────────────────────────────────────
    // A failed extraction has no usable result, so it doesn't get a markdown
    // pointer (and the orphan markdown is purged below).
    phase = 'save';
    const r2Url = (r2.isEnabled() && extractionStatus !== 'failed') ? r2.mdKey(ipo.slug, docType) : null;
    const extractionDoc = {
      ipoSlug: ipo.slug,
      docType,
      pipeline,
      pdfUrl,
      contentHash,
      sections: ranges,
      result: finalResult,
      validation,
      usage: getUsage(),
      status: extractionStatus,
      superseded: false,
      markdownKey: r2Url,
      // engineErrors is {} on a clean run; populated when an engine in the cascade
      // failed but a later one succeeded — surfaces partial degradation in the UI.
      engineErrors,
      extractedAt: new Date().toISOString(),
    };

    await collections.extractions().updateOne(
      { ipoSlug: ipo.slug, docType, pipeline },
      { $set: extractionDoc },
      { upsert: true },
    );

    logMsg('extraction saved to MongoDB');

    // A failed run may have uploaded markdown during convert but produced no
    // usable result — purge it so it doesn't orphan in R2.
    if (extractionStatus === 'failed' && r2.isEnabled()) {
      await r2.deleteMarkdown(ipo.slug, docType);
      logMsg('purged orphan markdown for failed extraction');
    }

    // Record the content fingerprint (+ cached-markdown pointer) on the IPO's
    // document entry — surfaces same-bytes dedup across docTypes (e.g. an "RHP"
    // that's really the DRHP re-listed shows an identical hash).
    const docSet = { [`documents.${docType}.hash`]: contentHash };
    if (r2Url) docSet[`documents.${docType}.r2Url`] = r2Url;
    await collections.ipos().updateOne({ slug: ipo.slug }, { $set: docSet });

    // Mark superseded docs + denormalize the current-extraction pointer onto the IPO.
    try {
      await reconcileExtractions(ipo.slug);
      logMsg('reconciled extraction supersession state');
    } catch (e) {
      log.warn({ err: e.message }, 'reconcileExtractions failed');
    }

    // Clean up temp files in production (ephemeral filesystem)
    if (process.env.NODE_ENV === 'production') {
      try {
        fs.rmSync(outputDir, { recursive: true, force: true });
        logMsg('cleaned up temp files');
      } catch (e) {
        log.warn({ err: e.message }, 'temp cleanup failed');
      }
    }

    log.info({ slug: ipo.slug, docType, pipeline }, 'extraction pipeline complete');

    return {
      slug: ipo.slug,
      docType,
      pipeline,
      sections: Object.fromEntries(
        Object.entries(ranges).map(([k, v]) => [k, v.method]),
      ),
      result: finalResult,
      validation,
      usage: getUsage(),
    };

  } catch (err) {
    // ── Failure transparency ──────────────────────────────────────────────
    // Record WHERE it died + per-engine errors, and make the failure visible in
    // the extractions list — WITHOUT clobbering a previously-good result.
    const now = new Date().toISOString();
    const failInfo = { lastError: err.message, lastFailedPhase: phase, lastFailedAt: now, engineErrors };
    try {
      if (existing && existing.result) {
        // Keep the prior good extraction; just annotate the failed re-run.
        await collections.extractions().updateOne(
          { ipoSlug: ipo.slug, docType, pipeline }, { $set: failInfo });
      } else {
        await collections.extractions().updateOne(
          { ipoSlug: ipo.slug, docType, pipeline },
          {
            $set: {
              ipoSlug: ipo.slug, docType, pipeline, pdfUrl,
              status: 'failed', error: err.message, failedPhase: phase,
              partial: { converted: converted || [], engineErrors },
              result: null, validation: null, superseded: false, extractedAt: now,
            }
          },
          { upsert: true });
      }
    } catch (e2) {
      log.warn({ err: e2.message }, 'failed to persist failure record');
    }
    logMsg(`✕ extraction failed at "${phase}": ${err.message}`);
    log.error({ slug: ipo.slug, phase, err: err.message }, 'extraction failed');
    throw err; // the job tracker records the failure too
  }
}

/**
 * Test a CANDIDATE schema against a real IPO — without saving anything.
 *
 * Powers the schema editor's "Test on IPO" preview: runs one extraction engine
 * with the edited (unsaved) field registry applied via withFields(), reusing the
 * cached markdown when available (no download/locate/convert), and returns the
 * result + validation. Persists nothing to Mongo. MUST run on the heavy lane so
 * the temporary global schema swap can't bleed into a concurrent extraction.
 *
 * @param {object} ipo
 * @param {object} opts  { fields (required), docType='auto', pipeline='gemini', log }
 * @returns {Promise<{ slug, docType, pipeline, result, validation, usedCache, usage }>}
 */
async function testSchemaOnIpo(ipo, opts = {}) {
  const logMsg = opts.log || (() => { });
  let { docType = 'auto', pipeline = 'gemini' } = opts;
  if (!['gemini', 'firecrawl'].includes(pipeline)) pipeline = 'gemini'; // single engine for a deterministic preview
  if (!opts.fields || typeof opts.fields !== 'object') throw new Error('fields (the schema to test) is required');
  const candidate = validateFields(opts.fields); // throws on bad schema

  if (!docType || docType === 'auto') {
    if (ipo.documents?.rhp?.url) docType = 'rhp';
    else if (ipo.documents?.drhp?.url) docType = 'drhp';
    else throw new Error(`No documents (rhp/drhp) for ${ipo.slug}`);
  }
  const pdfUrl = ipo.documents?.[docType]?.url;
  if (!pdfUrl) throw new Error(`No ${docType} URL for ${ipo.slug}`);

  resetUsage();
  const outputDir = path.join(env.OUTPUT_DIR, '__schema_test__', ipo.slug);
  try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (e) { }
  fs.mkdirSync(outputDir, { recursive: true });

  // Prefer cached markdown so a test is a single LLM call (no download/convert).
  let converted;
  let usedCache = false;
  const cachedMd = await r2.getMarkdown(ipo.slug, docType);
  if (cachedMd) {
    logMsg('using cached markdown (no re-convert)');
    const parts = splitMergedMarkdown(cachedMd);
    for (const { name, content } of parts) fs.writeFileSync(path.join(outputDir, `${name}.md`), content, 'utf8');
    converted = parts.map((p) => p.name);
    usedCache = true;
  } else {
    logMsg('no cached markdown — downloading + converting (one-off)...');
    const pdfPath = await downloadPdf(pdfUrl, outputDir, false);
    const ranges = await getSectionRanges(pdfPath, undefined, logMsg);
    converted = await convertSections(pdfPath, outputDir, ranges, logMsg);
  }

  // Apply the candidate schema for the duration of this one extraction.
  const out = await withFields(candidate, async () => {
    logMsg(`running ${pipeline} extraction with the edited schema...`);
    let raw;
    if (pipeline === 'firecrawl') {
      raw = mergeSectionResponses(await runFirecrawlExtraction(outputDir, converted, ipo.slug, logMsg));
    } else {
      raw = await runGeminiExtraction(outputDir, converted);
    }
    const result = normalize(raw);
    const validation = validateExtraction(result, ipo);
    return { result, validation };
  });

  try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (e) { }
  logMsg(`done — validation score ${out.validation?.score}/100 (this was a test; nothing was saved)`);
  return { slug: ipo.slug, docType, pipeline, usedCache, fieldCount: Object.keys(candidate).length, ...out, usage: getUsage() };
}

/**
 * Bulk extraction: find all IPOs matching a filter and run extraction on each.
 *
 * @param {object} opts
 * @param {string} [opts.pipeline='gemini']
 * @param {string} [opts.docType='drhp']
 * @param {string} [opts.status]   IPO status filter (e.g. 'open', 'upcoming')
 * @param {function} [opts.log]
 * @returns {Promise<object>} { total, extracted, skipped, errors }
 */
async function runBulkExtraction(opts = {}) {
  let { pipeline = 'cascade', docType = 'auto', status } = opts;
  const logMsg = opts.log || (() => { });

  // Auto-pick pipeline
  if (!pipeline || pipeline === 'default' || pipeline === 'deepseek') {
    pipeline = 'cascade';
  } else if (pipeline !== 'gemini' && pipeline !== 'firecrawl' && pipeline !== 'both' && pipeline !== 'cascade') {
    pipeline = 'cascade';
  }

  const filter = {};
  if (status) filter.status = status;

  if (!docType || docType === 'auto') {
    filter.$or = [
      { 'documents.rhp.url': { $exists: true, $ne: null } },
      { 'documents.drhp.url': { $exists: true, $ne: null } }
    ];
  } else {
    filter[`documents.${docType}.url`] = { $exists: true, $ne: null };
  }

  const ipos = await collections.ipos().find(filter).toArray();
  logMsg(`found ${ipos.length} IPOs with documents matching filter`);

  const summary = { total: ipos.length, extracted: 0, skipped: 0, errors: [] };

  for (const ipo of ipos) {
    try {
      // Determine what resolved docType will be for this specific IPO
      let targetDocType = docType;
      if (targetDocType === 'auto' || !targetDocType) {
        if (ipo.documents?.rhp?.url) targetDocType = 'rhp';
        else if (ipo.documents?.drhp?.url) targetDocType = 'drhp';
      }

      // Skip if already extracted (unless force)
      if (!opts.force) {
        const existing = await collections.extractions().findOne({
          ipoSlug: ipo.slug, docType: targetDocType, pipeline,
          status: { $in: ['completed', 'review'] },
        });
        if (existing) {
          summary.skipped++;
          logMsg(`skipping ${ipo.slug} (already extracted for docType=${targetDocType})`);
          continue;
        }
      }

      logMsg(`\n── extracting ${ipo.slug} (docType=${targetDocType}) ──`);
      await runExtraction(ipo, { pipeline, docType: targetDocType, force: opts.force, log: logMsg });
      summary.extracted++;
    } catch (e) {
      summary.errors.push({ slug: ipo.slug, error: e.message });
      logMsg(`ERROR: ${ipo.slug}: ${e.message}`);
    }
  }

  logMsg(`\nbulk extraction done: ${summary.extracted} extracted, ${summary.skipped} skipped, ${summary.errors.length} errors`);
  return { ...summary, usage: getUsage() };
}

module.exports = { runExtraction, runBulkExtraction, testSchemaOnIpo, downloadPdf };
