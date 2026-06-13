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
const { collections } = require('../db/mongo');
const { findBySlug } = require('../db/ipoRepository');
const { logger } = require('../utils/logger');

const log = logger.child({ module: 'extraction' });

// ── PDF download ─────────────────────────────────────────────────────────────

/**
 * Download a PDF from a URL to a local file. Skips if already exists (unless forced).
 *
 * @param {string} url       PDF URL
 * @param {string} outputDir Directory to save to
 * @param {boolean} [force]  Re-download even if cached
 * @returns {Promise<string>} Local file path
 */
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

  const fileStream = fs.createWriteStream(localPath);
  await streamPipeline(res.body, fileStream);

  const stats = fs.statSync(localPath);
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
  const { pipeline = 'gemini', docType = 'drhp', force = false } = opts;
  const logMsg = opts.log || (() => {});

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
      const sectionResponses = await runFirecrawlExtraction(outputDir, converted, ipo.slug);
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

  // ── Save to MongoDB ────────────────────────────────────────────────────
  const extractionDoc = {
    ipoSlug: ipo.slug,
    docType,
    pipeline,
    pdfUrl,
    sections: ranges,
    result: pipeline === 'both' ? results : (results[pipeline] || null),
    status: 'completed',
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
    result: extractionDoc.result,
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
  const { pipeline = 'gemini', docType = 'drhp', status } = opts;
  const logMsg = opts.log || (() => {});

  const filter = {};
  if (status) filter.status = status;
  filter[`documents.${docType}.url`] = { $exists: true, $ne: null };

  const ipos = await collections.ipos().find(filter).toArray();
  logMsg(`found ${ipos.length} IPOs with ${docType} documents`);

  const summary = { total: ipos.length, extracted: 0, skipped: 0, errors: [] };

  for (const ipo of ipos) {
    try {
      // Skip if already extracted (unless force)
      if (!opts.force) {
        const existing = await collections.extractions().findOne({
          ipoSlug: ipo.slug, docType, pipeline, status: 'completed',
        });
        if (existing) {
          summary.skipped++;
          logMsg(`skipping ${ipo.slug} (already extracted)`);
          continue;
        }
      }

      logMsg(`\n── extracting ${ipo.slug} ──`);
      await runExtraction(ipo, { pipeline, docType, force: opts.force, log: logMsg });
      summary.extracted++;
    } catch (e) {
      summary.errors.push({ slug: ipo.slug, error: e.message });
      logMsg(`ERROR: ${ipo.slug}: ${e.message}`);
    }
  }

  logMsg(`\nbulk extraction done: ${summary.extracted} extracted, ${summary.skipped} skipped, ${summary.errors.length} errors`);
  return summary;
}

module.exports = { runExtraction, runBulkExtraction };
