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
const { pipeline: streamPipeline } = require('stream/promises');
const { getSectionRanges } = require('./locate');
const { pagesToMarkdown } = require('./convert/pdf-bridge');
const { runGeminiExtraction } = require('./extract/gemini');
const { runFirecrawlExtraction } = require('./extract/firecrawl');
const { mergeSectionResponses } = require('./extract/merge');
const { env } = require('./config');
const { resetUsage, getUsage } = require('./usage');
const { collections } = require('../db/mongo');
const { findBySlug } = require('../db/ipoRepository');
const { logger } = require('../utils/logger');

const log = logger.child({ module: 'extraction' });

/**
 * Check if the extraction output is proper/complete.
 * Must have company_name and at least 8 populated fields.
 */
function isExtractionProper(result) {
  if (!result || typeof result !== 'object') return false;
  if (!result.company_name) return false;

  let populatedCount = 0;
  for (const [key, val] of Object.entries(result)) {
    if (val !== null && val !== undefined && val !== '') {
      if (Array.isArray(val) && val.length === 0) continue;
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
  const { IPO_DETAILS_SCHEMA } = require('./llm/schema');

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
${JSON.stringify(IPO_DETAILS_SCHEMA)}

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
      try { fs.unlinkSync(localPath); } catch (e) {}
    }
    throw err;
  }

  const stats = fs.statSync(localPath);

  // Validate size against content-length if provided to prevent caching truncated downloads
  if (!isNaN(contentLength) && stats.size < contentLength) {
    if (fs.existsSync(localPath)) {
      try { fs.unlinkSync(localPath); } catch (e) {}
    }
    throw new Error(`PDF download truncated: got ${stats.size} bytes of expected ${contentLength}`);
  }

  log.info({ localPath, bytes: stats.size }, 'PDF downloaded');

  return localPath;
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
  const logMsg = opts.log || (() => {});

  // Auto-pick pipeline
  if (!pipeline || pipeline === 'default' || pipeline === 'deepseek') {
    pipeline = 'cascade';
  } else if (pipeline !== 'gemini' && pipeline !== 'firecrawl' && pipeline !== 'both' && pipeline !== 'cascade') {
    pipeline = 'cascade';
  }

  // Auto-pick docType based on priority: final > rhp > drhp
  if (!docType || docType === 'auto') {
    if (ipo.documents?.final?.url) {
      docType = 'final';
    } else if (ipo.documents?.rhp?.url) {
      docType = 'rhp';
    } else if (ipo.documents?.drhp?.url) {
      docType = 'drhp';
    } else {
      throw new Error(`No documents (final, rhp, or drhp) found for IPO ${ipo.slug}`);
    }
  }

  resetUsage();

  const pdfUrl = ipo.documents?.[docType]?.url;
  if (!pdfUrl) throw new Error(`No ${docType} URL found for IPO ${ipo.slug}`);

  const outputDir = path.join(env.OUTPUT_DIR, ipo.slug);
  fs.mkdirSync(outputDir, { recursive: true });

  // ── Phase 0: Download PDF ──────────────────────────────────────────────
  logMsg(`downloading ${docType} PDF...`);
  const pdfPath = await downloadPdf(pdfUrl, outputDir, force);

  // ── Phase 1: LOCATE sections ───────────────────────────────────────────
  logMsg('locating sections...');
  const ranges = await getSectionRanges(pdfPath, undefined, logMsg);

  const foundSections = Object.entries(ranges)
    .filter(([, v]) => v.range)
    .map(([k]) => k);

  logMsg(`found ${foundSections.length} sections: ${foundSections.join(', ')}`);

  // ── Phase 2: CONVERT pages → markdown ──────────────────────────────────
  logMsg('converting pages to markdown...');
  const converted = await convertSections(pdfPath, outputDir, ranges, logMsg);

  // ── Phase 3: EXTRACT structured data ───────────────────────────────────
  const results = {};
  let finalResult = null;
  let extractionStatus = 'completed';

  if (pipeline === 'cascade') {
    logMsg('running Cascade extraction (Firecrawl with fallback)...');
    
    // 1. Try Firecrawl first
    logMsg('1/3: running Firecrawl extraction...');
    try {
      const sectionResponses = await runFirecrawlExtraction(outputDir, converted, ipo.slug, logMsg);
      results.firecrawl = mergeSectionResponses(sectionResponses);

      // Save merged result
      const fcPath = path.join(outputDir, 'summary_firecrawl.json');
      fs.writeFileSync(fcPath, JSON.stringify(results.firecrawl, null, 2), 'utf8');
      logMsg('Firecrawl extraction complete');
    } catch (e) {
      log.warn({ err: e.message }, 'Firecrawl extraction failed');
      logMsg(`Firecrawl extraction failed: ${e.message}`);
      results.firecrawl = null;
    }

    if (isExtractionProper(results.firecrawl)) {
      logMsg('Firecrawl extraction is proper. Completed.');
      finalResult = results.firecrawl;
    } else {
      logMsg('Firecrawl result incomplete/not proper. Flagging for review and falling back...');
      extractionStatus = 'review';
      
      // 2. Try Gemini fallback
      logMsg('2/3: running Gemini extraction fallback...');
      try {
        results.gemini = await runGeminiExtraction(outputDir, converted);
        logMsg('Gemini extraction complete');
      } catch (e) {
        log.warn({ err: e.message }, 'Gemini fallback failed');
        logMsg(`Gemini fallback failed: ${e.message}`);
        results.gemini = null;
      }

      if (isExtractionProper(results.gemini)) {
        logMsg('Gemini fallback result is proper.');
        finalResult = results.gemini;
      } else {
        // 3. Try DeepSeek fallback
        logMsg('3/3: running DeepSeek extraction fallback...');
        try {
          results.deepseek = await runDeepSeekExtraction(outputDir, converted);
          logMsg('DeepSeek extraction complete');
        } catch (e) {
          log.error({ err: e.message }, 'DeepSeek fallback failed');
          logMsg(`DeepSeek fallback failed: ${e.message}`);
          results.deepseek = null;
        }
        
        // Use best available result
        finalResult = results.deepseek || results.gemini || results.firecrawl || null;
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
      }
    }

    finalResult = pipeline === 'both' ? results : (results[pipeline] || null);
  }

  // ── Save to MongoDB ────────────────────────────────────────────────────
  const extractionDoc = {
    ipoSlug: ipo.slug,
    docType,
    pipeline,
    pdfUrl,
    sections: ranges,
    result: finalResult,
    usage: getUsage(),
    status: extractionStatus,
    extractedAt: new Date().toISOString(),
  };

  await collections.extractions().updateOne(
    { ipoSlug: ipo.slug, docType, pipeline },
    { $set: extractionDoc },
    { upsert: true },
  );

  logMsg('extraction saved to MongoDB');

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
    usage: getUsage(),
  };
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
  const logMsg = opts.log || (() => {});

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
      { 'documents.final.url': { $exists: true, $ne: null } },
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
        if (ipo.documents?.final?.url) targetDocType = 'final';
        else if (ipo.documents?.rhp?.url) targetDocType = 'rhp';
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

module.exports = { runExtraction, runBulkExtraction };
