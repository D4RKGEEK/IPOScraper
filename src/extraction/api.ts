/**
 * api.ts — the REST API (PRD §7, §11.10). Thin: reads/writes Mongo, presigns R2,
 * enqueues. No business logic. All responses are detailed by design.
 * Auth: a single X-API-Key header — this is an internal service.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ObjectId, type Db, type Document as MongoDoc } from 'mongodb';
import { CFG } from './config';
import type { R2 } from './r2';
import { sha256, computeProgress } from './state';
import { FIELDS } from './registry/fields';
import { validateField } from './validate';
import { mergeIpoRecord } from './merge';
import { janitor } from './janitor';
import { logEvent } from './db';

const LOCK_FIELDS = { lockedBy: 0, lockedAt: 0 };
const TERMINAL = ['done', 'done_with_review', 'failed_poison'];

export function buildApi(db: Db, r2: R2): FastifyInstance {
  const app = Fastify({ logger: false });
  const documents = () => db.collection('documents');
  const reviews = () => db.collection('review_queue');

  app.addHook('onRequest', async (req, reply) => {
    if (req.headers['x-api-key'] !== CFG.apiKey) {
      await reply.status(401).send({ error: 'invalid or missing X-API-Key' });
    }
  });

  // ── §7.1 POST /v1/documents — submit a PDF by link ───────────────────────────
  app.post('/v1/documents', async (req, reply) => {
    const body = (req.body ?? {}) as { pdfUrl?: string; ipoSlug?: string; meta?: object; webhookUrl?: string };
    if (!body.pdfUrl || !/^https?:\/\//.test(body.pdfUrl)) {
      return reply.status(400).send({ error: 'pdfUrl (http/https) is required' });
    }
    const id = sha256(body.pdfUrl);
    const existing = await documents().findOne({ _id: id as never });
    if (existing) {
      // Dedupe by sourceUrl — re-submit forces nothing (§7.1, fallback #29).
      return reply.status(202).send({
        documentId: id, status: existing.status, deduped: true, statusUrl: `/v1/documents/${id}`,
      });
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
    return reply.status(202).send({ documentId: id, status: 'queued', deduped: false, statusUrl: `/v1/documents/${id}` });
  });

  // ── §7.2 GET /v1/documents/:id — the detailed progress answer (main poll) ────────
  app.get('/v1/documents/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const doc = await documents().findOne({ _id: id as never }, { projection: LOCK_FIELDS });
    if (!doc) return reply.status(404).send({ error: 'document not found', id });
    return reply.send(detailPayload(doc));
  });

  // ── GET /v1/documents — list/filter ─────────────────────────────────────────
  app.get('/v1/documents', async (req) => {
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
    return { data: data.map((d) => ({ documentId: String(d._id), ...d, _id: undefined })), pagination: { page, limit, total } };
  });

  // ── GET /v1/documents/:id/result — 404-with-status if not terminal ───────────────
  app.get('/v1/documents/:id/result', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const doc = await documents().findOne({ _id: id as never }, { projection: LOCK_FIELDS });
    if (!doc) return reply.status(404).send({ error: 'document not found', id });
    if (!TERMINAL.includes(doc.status as string)) {
      return reply.status(404).send({ error: 'not terminal yet', status: doc.status, progress: doc.progress });
    }
    return reply.send({ documentId: id, docType: doc.docType, status: doc.status, fields: doc.fields ?? {}, cost: doc.cost ?? {} });
  });

  // ── GET /v1/documents/:id/events — audit trail ────────────────────────────────
  app.get('/v1/documents/:id/events', async (req) => {
    const id = (req.params as { id: string }).id;
    const events = await db.collection('events').find({ docHash: id }).sort({ at: -1 }).limit(500).toArray();
    return { documentId: id, events };
  });

  // ── POST /v1/documents/:id/retry — re-enqueue (§7.3) ────────────────────────────
  app.post('/v1/documents/:id/retry', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const force = !!((req.body ?? {}) as { force?: boolean }).force;
    const doc = await documents().findOne({ _id: id as never });
    if (!doc) return reply.status(404).send({ error: 'document not found', id });

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
    return reply.status(202).send({ documentId: id, status: 'queued', force, statusUrl: `/v1/documents/${id}` });
  });

  // ── GET /v1/ipos/:slug — the merged canonical IPO record ────────────────────────
  app.get('/v1/ipos/:slug', async (req, reply) => {
    const slug = (req.params as { slug: string }).slug;
    const ipo = await db.collection('ipos').findOne({ _id: slug as never });
    if (!ipo) return reply.status(404).send({ error: 'ipo not found', slug });
    return reply.send(ipo);
  });

  app.get('/v1/ipos', async (req) => {
    const q = req.query as Record<string, string>;
    const filter: Record<string, unknown> = {};
    if (q['completeness.needsReview'] !== undefined) {
      filter['completeness.needsReview'] = parseInt(q['completeness.needsReview'], 10);
    }
    const data = await db.collection('ipos').find(filter).sort({ updatedAt: -1 }).limit(200).toArray();
    return { data };
  });

  // ── GET /v1/reviews — humans resolve in seconds (presigned PNGs, 15-min) ─────────
  app.get('/v1/reviews', async (req) => {
    const status = (req.query as { status?: string }).status ?? 'open';
    const list = await reviews().find({ status }).sort({ _id: -1 }).limit(200).toArray();
    const data = await Promise.all(
      list.map(async (r) => ({
        ...r,
        _id: String(r._id),
        imageUrl: r.imageKey ? await r2.presign(r.imageKey as string).catch(() => null) : null,
      })),
    );
    return { data };
  });

  // ── POST /v1/reviews/:id/resolve — humans get validated too (§7.3, W8) ───────────
  app.post('/v1/reviews/:id/resolve', async (req, reply) => {
    const rid = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { value?: unknown; dismiss?: boolean; resolvedBy?: string };
    const review = await reviews().findOne({ _id: new ObjectId(rid) });
    if (!review) return reply.status(404).send({ error: 'review not found', id: rid });
    if (review.status !== 'open') return reply.status(409).send({ error: `review already ${review.status}` });

    const docId = review.docHash as string;
    const key = review.field as string;

    if (body.dismiss) {
      await reviews().updateOne({ _id: review._id }, { $set: { status: 'dismissed', resolvedBy: body.resolvedBy ?? 'api', resolvedAt: new Date() } });
      await db.collection('documents').updateOne(
        { _id: docId as never },
        { $set: { [`fields.${key}`]: { value: null, status: 'not_expected', resolvedBy: body.resolvedBy ?? 'api' } } },
      );
      if (review.imageKey) await r2.delete(review.imageKey as string).catch(() => {});
      await finalizeDocAfterReview(db, docId);
      return reply.send({ resolved: false, dismissed: true });
    }

    // Same validation code path — evidence waived for humans, schema + rules NOT waived.
    const doc = await db.collection('documents').findOne({ _id: docId as never });
    const all: Record<string, unknown> = {};
    for (const [k, f] of Object.entries((doc?.fields ?? {}) as Record<string, { status?: string; value?: unknown }>)) {
      if (f.status === 'validated') all[k] = { value: f.value };
    }
    const v = validateField(key, { value: body.value, evidence: 'human_review', page: (review.pages as number[] | undefined)?.[0] ?? 1 }, '', all, { skipEvidence: true });
    if (!v.ok) return reply.status(422).send({ error: v.reason });

    await db.collection('documents').updateOne(
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
    return reply.send({ resolved: true, field: key, value: body.value });
  });

  // ── GET /v1/stats — the improvement dashboard ─────────────────────────────────
  app.get('/v1/stats', async () => {
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
    return {
      documents: Object.fromEntries(byStatus.map((s) => [s._id, s.n])),
      fields: { validated, needsReview: review, reviewRate: validated + review ? review / (validated + review) : 0 },
      layerWinRates: layerWins,
      avgCostPerDoc: {
        firecrawlMdCalls: cost.firecrawlMdCalls / n,
        firecrawlPdfCalls: cost.firecrawlPdfCalls / n,
        deepseekTokens: cost.deepseekTokens / n,
      },
    };
  });

  // ── GET /v1/health ───────────────────────────────────────────────────────────
  app.get('/v1/health', async () => {
    let mongo = false; let r2ok = false;
    try { await db.command({ ping: 1 }); mongo = true; } catch { /* report below */ }
    try { await r2.list('pdf/'); r2ok = true; } catch { /* report below */ }
    const queueDepth = await documents().countDocuments({ status: 'queued' }).catch(() => -1);
    return { ok: mongo && r2ok, mongo, r2: r2ok, queueDepth, memoryRssMb: Math.round(process.memoryUsage().rss / 1048576) };
  });

  // ── POST /v1/admin/janitor — trigger sweep; ?dryRun=1 lists deletions (W7) ───────
  app.post('/v1/admin/janitor', async (req) => {
    const dryRun = (req.query as { dryRun?: string }).dryRun === '1';
    return janitor(r2, db, { dryRun });
  });

  return app;
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
  await db.collection('documents').updateOne(
    { _id: docId as never },
    [{ $set: { progress: { $literal: computeProgress((await db.collection('documents').findOne({ _id: docId as never })) as MongoDoc) } } }] as never,
  ).catch(() => {});
  await mergeIpoRecord(db, (await db.collection('documents').findOne({ _id: docId as never })) as MongoDoc);
}
