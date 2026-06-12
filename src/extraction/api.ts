/**
 * api.ts — the extraction REST API (PRD §7) as an Express Router mounted at
 * /v1 inside the main scraper app (PRD §2 explicitly allows Express). Thin:
 * reads/writes Mongo, presigns R2, enqueues. No business logic.
 * Auth: a single X-API-Key header on every /v1 route.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { ObjectId, type Db, type Document as MongoDoc } from 'mongodb';
import { CFG } from './config';
import type { R2 } from './r2';
import { sha256, computeProgress } from './state';
import { validateField } from './validate';
import { mergeIpoRecord } from './merge';
import { janitor } from './janitor';
import { logEvent } from './db';

const LOCK_FIELDS = { lockedBy: 0, lockedAt: 0 };
const TERMINAL = ['done', 'done_with_review', 'failed_poison'];

export function buildExtractionRouter(db: Db, r2: R2): Router {
  const router = Router();
  const documents = () => db.collection('documents');
  const reviews = () => db.collection('review_queue');

  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.headers['x-api-key'] !== CFG.apiKey) {
      res.status(401).json({ error: 'invalid or missing X-API-Key' });
      return;
    }
    next();
  });

  const h = (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) => {
      fn(req, res).catch(next);
    };

  // ── §7.1 POST /v1/documents — submit a PDF by link ───────────────────────────
  router.post('/documents', h(async (req, res) => {
    const body = (req.body ?? {}) as { pdfUrl?: string; ipoSlug?: string; meta?: object; webhookUrl?: string; force?: boolean };
    const force = !!body.force;
    
    if (!body.pdfUrl && body.ipoSlug) {
      const ipoDb = db.client.db(process.env.MONGODB_DB || 'ipo');
      const ipo = await ipoDb.collection('ipos').findOne({ slug: body.ipoSlug });
      body.pdfUrl = ipo?.documents?.drhp?.url || ipo?.documents?.rhp?.url || undefined;
    }

    if (!body.pdfUrl || !/^https?:\/\//.test(body.pdfUrl)) {
      return res.status(400).json({ error: 'pdfUrl (http/https) is required, or provide a valid ipoSlug that has documents in the database.' });
    }
    const id = sha256(body.pdfUrl);
    const existing = await documents().findOne({ _id: id as never });
    if (existing) {
      if (force) {
        await documents().updateOne(
          { _id: id as never },
          { $set: { status: 'queued', fields: {}, stages: {}, error: null, progress: { percent: 0, stage: 'queued' }, lockedBy: null, lockedAt: null, updatedAt: new Date() } },
        );
        await logEvent(id, 'retry', { force });
        return res.status(202).json({ documentId: id, status: 'queued', force, statusUrl: `/v1/documents/${id}` });
      } else {
        // Dedupe by sourceUrl — re-submit forces nothing (§7.1, fallback #29).
        return res.status(202).json({ documentId: id, status: existing.status, deduped: true, statusUrl: `/v1/documents/${id}` });
      }
    }
    try {
      await documents().insertOne({
        _id: id as never,
        sourceUrl: body.pdfUrl,
        sourceMeta: { scrapedBy: (body.meta as { scrapedBy?: string } | undefined)?.scrapedBy ?? 'api', ipoSlug: body.ipoSlug ?? null, ...(body.meta ?? {}) },
        webhookUrl: body.webhookUrl ?? null,
        docType: 'UNKNOWN', isScanned: false,
        status: 'queued', progress: { percent: 0, stage: 'queued' },
        stages: {}, fields: {}, cost: { firecrawlMdCalls: 0, firecrawlPdfCalls: 0, deepseekTokens: 0 },
        error: null, lockedBy: null, lockedAt: null,
        createdAt: new Date(), updatedAt: new Date(),
        wallDeadline: null,
      });
    } catch (e) {
      if (!String(e).includes('E11000')) throw e; // racing duplicate → fall through
    }
    await logEvent(id, 'submitted', { sourceUrl: body.pdfUrl, ipoSlug: body.ipoSlug ?? null });
    return res.status(202).json({ documentId: id, status: 'queued', deduped: false, statusUrl: `/v1/documents/${id}` });
  }));

  // ── §7.2 GET /v1/documents/:id — the detailed progress answer (main poll) ────────
  router.get('/documents/:id', h(async (req, res) => {
    const id = req.params.id as string;
    const doc = await documents().findOne({ _id: id as never }, { projection: LOCK_FIELDS });
    if (!doc) return res.status(404).json({ error: 'document not found', id });
    return res.json(detailPayload(doc));
  }));

  // ── GET /v1/documents — list/filter ─────────────────────────────────────────
  router.get('/documents', h(async (req, res) => {
    const q = req.query as { status?: string; ipoSlug?: string; page?: string };
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.ipoSlug) filter['sourceMeta.ipoSlug'] = q.ipoSlug;
    const page = Math.max(1, parseInt(q.page ?? '1', 10) || 1);
    const limit = 50;
    const total = await documents().countDocuments(filter);
    const data = await documents()
      .find(filter, { projection: { ...LOCK_FIELDS, fields: 0, stages: 0 } })
      .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray();
    return res.json({ data: data.map((d) => ({ documentId: String(d._id), ...d, _id: undefined })), pagination: { page, limit, total } });
  }));

  // ── GET /v1/documents/:id/result — 404-with-status if not terminal ───────────────
  router.get('/documents/:id/result', h(async (req, res) => {
    const id = req.params.id as string;
    const doc = await documents().findOne({ _id: id as never }, { projection: LOCK_FIELDS });
    if (!doc) return res.status(404).json({ error: 'document not found', id });
    if (!TERMINAL.includes(doc.status as string)) {
      return res.status(404).json({ error: 'not terminal yet', status: doc.status, progress: doc.progress });
    }
    return res.json({ documentId: id, docType: doc.docType, status: doc.status, fields: doc.fields ?? {}, cost: doc.cost ?? {} });
  }));

  // ── GET /v1/documents/:id/events — audit trail ────────────────────────────────
  router.get('/documents/:id/events', h(async (req, res) => {
    const id = req.params.id as string;
    const events = await db.collection('events').find({ docHash: id }).sort({ at: -1 }).limit(500).toArray();
    return res.json({ documentId: id, events });
  }));

  // ── POST /v1/documents/:id/retry — re-enqueue (§7.3) ────────────────────────────
  router.post('/documents/:id/retry', h(async (req, res) => {
    const id = req.params.id as string;
    const force = !!((req.body ?? {}) as { force?: boolean }).force;
    const doc = await documents().findOne({ _id: id as never });
    if (!doc) return res.status(404).json({ error: 'document not found', id });

    if (force) {
      // Wipe and redo everything.
      await documents().updateOne(
        { _id: id as never },
        { $set: { status: 'queued', fields: {}, stages: {}, error: null, progress: { percent: 0, stage: 'queued' }, lockedBy: null, lockedAt: null, updatedAt: new Date() } },
      );
    } else {
      // Only non-validated fields re-enter the ladder; located map stays cached.
      const fields = { ...(doc.fields ?? {}) } as Record<string, { status?: string }>;
      for (const k of Object.keys(fields)) {
        const s = fields[k]?.status;
        if (s !== 'validated' && s !== 'not_expected') delete fields[k];
      }
      await documents().updateOne(
        { _id: id as never },
        { $set: { status: 'queued', fields, error: null, 'stages.extracted': { done: false }, 'stages.validated': { done: false }, lockedBy: null, lockedAt: null, updatedAt: new Date() } },
      );
    }
    await logEvent(id, 'retry', { force });
    return res.status(202).json({ documentId: id, status: 'queued', force, statusUrl: `/v1/documents/${id}` });
  }));

  // ── GET /v1/ipos/:slug — the merged canonical IPO record ────────────────────────
  router.get('/ipos/:slug', h(async (req, res) => {
    const slug = req.params.slug as string;
    const ipo = await db.collection('ipos').findOne({ _id: slug as never });
    if (!ipo) return res.status(404).json({ error: 'ipo not found', slug });
    return res.json(ipo);
  }));

  router.get('/ipos', h(async (req, res) => {
    const q = req.query as Record<string, string>;
    const filter: Record<string, unknown> = {};
    if (q['completeness.needsReview'] !== undefined) {
      filter['completeness.needsReview'] = parseInt(q['completeness.needsReview'], 10);
    }
    const data = await db.collection('ipos').find(filter).sort({ updatedAt: -1 }).limit(200).toArray();
    return res.json({ data });
  }));

  // ── GET /v1/reviews — humans resolve in seconds (presigned PNGs, 15-min) ─────────
  router.get('/reviews', h(async (req, res) => {
    const status = (req.query as { status?: string }).status ?? 'open';
    const list = await reviews().find({ status }).sort({ _id: -1 }).limit(200).toArray();
    const data = await Promise.all(
      list.map(async (r) => ({
        ...r,
        _id: String(r._id),
        imageUrl: r.imageKey ? await r2.presign(r.imageKey as string).catch(() => null) : null,
      })),
    );
    return res.json({ data });
  }));

  // ── POST /v1/reviews/:id/resolve — humans get validated too (§7.3, W8) ───────────
  router.post('/reviews/:id/resolve', h(async (req, res) => {
    const rid = req.params.id as string;
    const body = (req.body ?? {}) as { value?: unknown; dismiss?: boolean; resolvedBy?: string };
    const review = await reviews().findOne({ _id: new ObjectId(rid) });
    if (!review) return res.status(404).json({ error: 'review not found', id: rid });
    if (review.status !== 'open') return res.status(409).json({ error: `review already ${review.status}` });

    const docId = review.docHash as string;
    const key = review.field as string;

    if (body.dismiss) {
      await reviews().updateOne({ _id: review._id }, { $set: { status: 'dismissed', resolvedBy: body.resolvedBy ?? 'api', resolvedAt: new Date() } });
      await documents().updateOne(
        { _id: docId as never },
        { $set: { [`fields.${key}`]: { value: null, status: 'not_expected', resolvedBy: body.resolvedBy ?? 'api' } } },
      );
      if (review.imageKey) await r2.delete(review.imageKey as string).catch(() => {});
      await finalizeDocAfterReview(db, docId);
      return res.json({ resolved: false, dismissed: true });
    }

    // Same validation code path — evidence waived for humans, schema + rules NOT waived.
    const doc = await documents().findOne({ _id: docId as never });
    const all: Record<string, unknown> = {};
    for (const [k, f] of Object.entries((doc?.fields ?? {}) as Record<string, { status?: string; value?: unknown }>)) {
      if (f.status === 'validated') all[k] = { value: f.value };
    }
    const v = validateField(key, { value: body.value, evidence: 'human_review', page: (review.pages as number[] | undefined)?.[0] ?? 1 }, '', all, { skipEvidence: true });
    if (!v.ok) return res.status(422).json({ error: v.reason });

    await documents().updateOne(
      { _id: docId as never },
      { $set: { [`fields.${key}`]: { value: body.value, status: 'validated', layer: 'human_review', page: (review.pages as number[] | undefined)?.[0] ?? null, evidence: 'human_review', resolvedBy: body.resolvedBy ?? 'api' }, updatedAt: new Date() } },
    );
    await reviews().updateOne(
      { _id: review._id },
      { $set: { status: 'resolved', resolvedValue: body.value, resolvedBy: body.resolvedBy ?? 'api', resolvedAt: new Date() } },
    );
    if (review.imageKey) await r2.delete(review.imageKey as string).catch(() => {});
    await finalizeDocAfterReview(db, docId);
    await logEvent(docId, 'review_resolved', { field: key });
    return res.json({ resolved: true, field: key, value: body.value });
  }));

  // ── GET /v1/stats — the improvement dashboard ─────────────────────────────────
  router.get('/stats', h(async (_req, res) => {
    const byStatus = await documents().aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
    const docs = await documents().find({}, { projection: { fields: 1, cost: 1 } }).toArray();
    const layerWins: Record<string, number> = {};
    let validated = 0; let review = 0;
    let cost = { firecrawlMdCalls: 0, firecrawlPdfCalls: 0, deepseekTokens: 0 };
    for (const d of docs) {
      for (const f of Object.values((d.fields ?? {}) as Record<string, { status?: string; layer?: string }>)) {
        if (f.status === 'validated') { validated++; if (f.layer) layerWins[f.layer] = (layerWins[f.layer] ?? 0) + 1; }
        if (f.status === 'needs_review') review++;
      }
      const c = (d.cost ?? {}) as typeof cost;
      cost = {
        firecrawlMdCalls: cost.firecrawlMdCalls + (c.firecrawlMdCalls ?? 0),
        firecrawlPdfCalls: cost.firecrawlPdfCalls + (c.firecrawlPdfCalls ?? 0),
        deepseekTokens: cost.deepseekTokens + (c.deepseekTokens ?? 0),
      };
    }
    const n = Math.max(1, docs.length);
    return res.json({
      documents: Object.fromEntries(byStatus.map((s) => [s._id, s.n])),
      fields: { validated, needsReview: review, reviewRate: validated + review ? review / (validated + review) : 0 },
      layerWinRates: layerWins,
      avgCostPerDoc: {
        firecrawlMdCalls: cost.firecrawlMdCalls / n,
        firecrawlPdfCalls: cost.firecrawlPdfCalls / n,
        deepseekTokens: cost.deepseekTokens / n,
      },
    });
  }));

  // ── GET /v1/health ───────────────────────────────────────────────────────────
  router.get('/health', h(async (_req, res) => {
    let mongo = false; let r2ok = false;
    try { await db.command({ ping: 1 }); mongo = true; } catch { /* report below */ }
    try { await r2.list('pdf/'); r2ok = true; } catch { /* report below */ }
    const queueDepth = await documents().countDocuments({ status: 'queued' }).catch(() => -1);
    return res.json({ ok: mongo && r2ok, mongo, r2: r2ok, queueDepth, memoryRssMb: Math.round(process.memoryUsage().rss / 1048576) });
  }));

  // ── POST /v1/admin/janitor — trigger sweep; ?dryRun=1 lists deletions (W7) ───────
  router.post('/admin/janitor', h(async (req, res) => {
    const dryRun = (req.query as { dryRun?: string }).dryRun === '1';
    return res.json(await janitor(r2, db, { dryRun }));
  }));

  // Router-scoped error handler — /v1 errors never leak HTML stacks.
  router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });

  return router;
}

/** §7.2 detail payload: full record minus lock fields, plus computed extras. */
function detailPayload(doc: MongoDoc): Record<string, unknown> {
  const progress = computeProgress(doc);
  const stages = (doc.stages ?? {}) as Record<string, { done?: boolean; at?: Date; ms?: number; method?: string }>;
  const timeline = Object.entries(stages)
    .filter(([, s]) => s.done)
    .map(([stage, s]) => ({ stage, at: s.at ?? null, ms: s.ms ?? null, ...(s.method ? { method: s.method } : {}) }));

  // etaSeconds: rolling average per settled field × remaining (§7.2).
  const created = doc.createdAt ? new Date(doc.createdAt as Date).getTime() : Date.now();
  const settled = (progress.fieldsValidated as number) + (progress.fieldsReview as number) + (progress.fieldsNotExpected as number);
  const pending = progress.fieldsPending as number;
  const etaSeconds = settled > 0 && pending > 0 ? Math.round(((Date.now() - created) / settled) * pending / 1000) : null;

  return {
    documentId: String(doc._id),
    sourceUrl: doc.sourceUrl,
    sourceMeta: doc.sourceMeta,
    fileName: doc.fileName ?? null,
    sizeBytes: doc.sizeBytes ?? null,
    pageCount: doc.pageCount ?? null,
    docType: doc.docType,
    isScanned: !!doc.isScanned,
    status: doc.status,
    progress: {
      percent: progress.percent,
      stage: doc.status,
      stageDetail: (doc.progress as { stageDetail?: string } | undefined)?.stageDetail ?? null,
      etaSeconds,
      fields: {
        total: progress.fieldsTotal,
        validated: progress.fieldsValidated,
        needsReview: progress.fieldsReview,
        pending: progress.fieldsPending,
        notExpected: progress.fieldsNotExpected,
      },
    },
    timeline,
    fields: doc.fields ?? {},
    cost: doc.cost ?? {},
    error: doc.error ?? null,
    links: { result: `/v1/documents/${String(doc._id)}/result`, events: `/v1/documents/${String(doc._id)}/events` },
  };
}

/** After a review closes: flip done_with_review → done when nothing is open. */
async function finalizeDocAfterReview(db: Db, docId: string): Promise<void> {
  const open = await db.collection('review_queue').countDocuments({ docHash: docId, status: 'open' });
  const doc = await db.collection('documents').findOne({ _id: docId as never });
  if (!doc) return;
  const anyReviewFields = Object.values((doc.fields ?? {}) as Record<string, { status?: string }>).some(
    (f) => f.status === 'needs_review',
  );
  if (open === 0 && !anyReviewFields && doc.status === 'done_with_review') {
    await db.collection('documents').updateOne({ _id: docId as never }, { $set: { status: 'done', updatedAt: new Date() } });
  }
  const fresh = (await db.collection('documents').findOne({ _id: docId as never })) as MongoDoc;
  await db.collection('documents').updateOne({ _id: docId as never }, { $set: { progress: computeProgress(fresh) } });
  await mergeIpoRecord(db, fresh);
}
