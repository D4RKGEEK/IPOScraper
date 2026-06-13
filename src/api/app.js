'use strict';

/**
 * app.js — Express application for the IPO platform API.
 * Routers are mounted here; server.js wires the Mongo connection and listens.
 */

const path = require('path');
const express = require('express');
const { query, findBySlug, deleteBySlug } = require('../db/ipoRepository');
const { collections } = require('../db/mongo');
const { runScrape, ALL_SOURCES } = require('../services/scrapeService');
const { runGmp } = require('../services/gmpService');
const { runHistorical } = require('../services/historicalService');
const { runExtraction, runBulkExtraction } = require('../extraction');
const { createJob, appendLog, completeJob, failJob, getJob, listJobs } = require('../db/jobRepository');
const { logger, requestLogger } = require('../utils/logger');

function buildApp(opts = {}) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(requestLogger);



  // Serve the dashboard SPA
  const publicDir = path.join(__dirname, 'public');
  app.use('/dashboard', express.static(publicDir));
  app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'dashboard.html')));

  const asyncH = (fn) => (req, res) => fn(req, res).catch((e) => {
    logger.error({ err: e, method: req.method, path: req.path }, 'Request error');
    res.status(500).json({ error: e.message });
  });

  /**
   * Run a POST operation as a tracked job. fn(log) does the work and returns the
   * result. Long ops run async by default (return jobId, poll /jobs/:id); pass
   * { wait:true } in the body to run synchronously. Short ops omit longOp.
   */
  async function runTracked(res, { type, params, longOp = false, wait = false }, fn) {
    const jobId = await createJob(type, params);
    // Serialize log writes so they persist in call order (services call log() without await).
    let logChain = Promise.resolve();
    const log = (msg) => { logChain = logChain.then(() => appendLog(jobId, msg)); return logChain; };
    const exec = async () => {
      const t0 = Date.now();
      try {
        const result = await fn(log);
        await logChain; // ensure all milestone logs are flushed before result
        await completeJob(jobId, result, Date.now() - t0);
        return result;
      } catch (e) {
        await logChain;
        await failJob(jobId, e.message, Date.now() - t0);
        throw e;
      }
    };
    if (longOp && !wait) {
      exec().catch(() => {}); // tracked via the job; errors recorded there
      return res.status(202).json({ jobId, status: 'running', poll: `/jobs/${jobId}` });
    }
    const result = await exec();
    return res.json({ jobId, status: 'completed', ...result });
  }

  // ── Index card projection for GET /ipos ────────────────────────────────────
  function toCard(doc) {
    return {
      slug: doc.slug,
      companyName: doc.companyName,
      displayName: doc.displayName,
      isin: doc.isin,
      symbol: doc.symbol,
      status: doc.status,
      issueType: doc.issueType,
      priceBand: doc.priceBand,
      lotSize: doc.lotSize,
      issueSize: doc.issueSize,
      biddingStart: doc.biddingStart,
      biddingEnd: doc.biddingEnd,
      listingDate: doc.listingDate,
      gmp: doc.gmp ? doc.gmp.value : null,
      sector: doc.sector,
      sources: Object.keys(doc.sources || {}),
      documents: doc.documents || {},
      updatedAt: doc.updatedAt,
      createdAt: doc.createdAt,
    };
  }

  app.get('/health', asyncH(async (_req, res) => {
    const count = await collections.ipos().estimatedDocumentCount();
    res.json({ ok: true, ipos: count });
  }));

  // API 1: GET /ipos — meta/index
  app.get('/ipos', asyncH(async (req, res) => {
    const { data, pagination } = await query(req.query);
    res.json({ data: data.map(toCard), pagination });
  }));

  // GET /sources — available sources + health
  app.get('/sources', asyncH(async (_req, res) => {
    const ipos = collections.ipos();
    const known = ['nse', 'bse', 'upstox', 'groww', 'zerodha', 'investorgain'];
    const out = [];
    for (const s of known) {
      const count = await ipos.countDocuments({ [`sources.${s}`]: { $exists: true } });
      const latest = await ipos.find({ [`sources.${s}.lastFetched`]: { $exists: true } })
        .sort({ [`sources.${s}.lastFetched`]: -1 }).limit(1).project({ sources: 1 }).toArray();
      out.push({
        source: s,
        ipos: count,
        healthy: count > 0,
        lastFetched: latest[0] ? latest[0].sources[s].lastFetched : null,
      });
    }
    const lastScrape = (await collections.jobs().find({ type: 'scrape' }).sort({ createdAt: -1 }).limit(1).toArray())[0] || null;
    res.json({ sources: out, lastScrape: lastScrape ? { jobId: lastScrape._id.toString(), status: lastScrape.status, at: lastScrape.createdAt } : null });
  }));

  // API 2: GET /ipos/:slug — full details (merged, or ?raw=true)
  app.get('/ipos/:slug', asyncH(async (req, res) => {
    const doc = await findBySlug(req.params.slug);
    if (!doc) return res.status(404).json({ error: 'IPO not found', slug: req.params.slug });
    if (req.query.raw === 'true') {
      return res.json({ slug: doc.slug, _raw: doc.raw_sources || {} });
    }
    const { raw_sources, _id, ...merged } = doc;
    res.json(merged);
  }));

  // API 3: POST /ipos/scrape — scrape & save
  // Body: { sources?, dryRun?, force?, async? }. Synchronous by default (returns
  // summary); pass async:true to get a jobId immediately and poll GET /jobs/:id.
  app.post('/ipos/scrape', asyncH(async (req, res) => {
    const { sources, dryRun = false, force = false, wait = false } = req.body || {};
    await runTracked(res,
      { type: 'scrape', params: { sources: sources || ALL_SOURCES, dryRun, force }, longOp: true, wait },
      (log) => runScrape({ sources, dryRun, force, log }));
  }));



  // GET /ipos/:slug/history — GMP / status time series
  app.get('/ipos/:slug/history', asyncH(async (req, res) => {
    const doc = await findBySlug(req.params.slug);
    if (!doc) return res.status(404).json({ error: 'IPO not found', slug: req.params.slug });
    const gmp = await collections.gmpHistory().find({ slug: req.params.slug }).sort({ date: -1 }).limit(500).toArray();
    res.json({
      slug: req.params.slug,
      statusHistory: doc.statusHistory || [],
      gmp: gmp.map((g) => ({ date: g.date, value: g.value, percentage: g.percentage, source: g.source })),
    });
  }));

  // API 5: POST /ipos/gmp — scrape GMP (open/upcoming only), store + time-series
  app.post('/ipos/gmp', asyncH(async (req, res) => {
    const { slugs, status } = req.body || {};
    await runTracked(res, { type: 'gmp', params: { slugs, status } }, (log) => runGmp({ slugs, status, log }));
  }));

  // API 6: POST /ipos/historical — post-listing price data for listed IPOs
  app.post('/ipos/historical', asyncH(async (req, res) => {
    const { status, since, limit } = req.body || {};
    await runTracked(res, { type: 'historical', params: { status, since, limit } }, (log) => runHistorical({ status, since, limit, log }));
  }));

  // ── Extraction pipeline ──────────────────────────────────────────────────

  // POST /ipos/:slug/extract — extract structured data from this IPO's DRHP/RHP
  app.post('/ipos/:slug/extract', asyncH(async (req, res) => {
    const ipo = await findBySlug(req.params.slug);
    if (!ipo) return res.status(404).json({ error: 'IPO not found', slug: req.params.slug });
    const { pipeline = 'gemini', docType = 'drhp', force = false, wait = false } = req.body || {};
    const docUrl = ipo.documents?.[docType]?.url;
    if (!docUrl) return res.status(400).json({ error: `No ${docType} URL found for this IPO` });
    await runTracked(res,
      { type: 'extraction', params: { slug: ipo.slug, docType, pipeline }, longOp: true, wait },
      (log) => runExtraction(ipo, { pipeline, docType, force, log }));
  }));

  // POST /ipos/extract — bulk extract all IPOs that have documents
  app.post('/ipos/extract', asyncH(async (req, res) => {
    const { pipeline = 'gemini', docType = 'drhp', status, force = false, wait = false } = req.body || {};
    await runTracked(res,
      { type: 'extraction-bulk', params: { pipeline, docType, status }, longOp: true, wait },
      (log) => runBulkExtraction({ pipeline, docType, status, force, log }));
  }));

  // GET /extractions/:slug — get extraction results for an IPO
  app.get('/extractions/:slug', asyncH(async (req, res) => {
    const results = await collections.extractions().find({ ipoSlug: req.params.slug }).toArray();
    if (!results.length) return res.status(404).json({ error: 'No extractions found', slug: req.params.slug });
    res.json({ slug: req.params.slug, extractions: results.map((r) => ({ ...r, _id: undefined })) });
  }));


  // DELETE /ipos/:slug — remove IPO + its documents
  app.delete('/ipos/:slug', asyncH(async (req, res) => {
    const ipo = await findBySlug(req.params.slug);
    if (!ipo) return res.status(404).json({ error: 'IPO not found', slug: req.params.slug });
    await collections.gmpHistory().deleteMany({ slug: req.params.slug });
    await deleteBySlug(req.params.slug);
    res.json({ deleted: req.params.slug });
  }));

  // GET /jobs — background job status (history)
  app.get('/jobs', asyncH(async (req, res) => {
    res.json({ jobs: await listJobs(req.query) });
  }));

  app.get('/jobs/:id', asyncH(async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found', id: req.params.id });
    res.json(job);
  }));



  app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }));
  return app;
}

module.exports = { buildApp };
