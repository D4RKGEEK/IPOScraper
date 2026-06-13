/**
 * worker.ts — the queue worker (PRD §11.9). Sequential, crash-safe: claim →
 * S1..S6 → terminal. Each stage is idempotent (checks Mongo first); kill -9 at
 * any moment loses at most one network call. One doc / one section / one
 * network call at a time — fits 500 MB RAM.
 */
import type { Db, Document as MongoDoc } from 'mongodb';
import type * as mupdf from 'mupdf';
import { CFG } from './config';
import type { R2 } from './r2';
import { sleep } from './util/retry';
import { openDoc, pagePng } from './pdf/mupdf-helpers';
import { classifyDoc } from './classify';
import { locateSections, type LocatedMap } from './locate';
import { extractSection, type Ctx, type ExtractionClients } from './extract';
import { parseHtmlJson, parsePdfJson } from './clients/firecrawl';
import { deepseekJson, EXTRACT_SYSTEM } from './clients/deepseek';
import { FIELDS, REGISTRY_SECTIONS, type DocType } from './registry/fields';
import { claimNext, setStage, setStatus, setField, markPoison, expectedFields } from './state';
import { ingest } from './ingest';
import { mergeIpoRecord } from './merge';
import { janitorForDoc, janitor } from './janitor';
import { logEvent } from './db';

const DEFAULT_CLIENTS: ExtractionClients = {
  parseHtmlJson,
  parsePdfJson,
  deepseekJson,
  extractSystem: EXTRACT_SYSTEM,
};

// Sections whose registry fields physically live on the cover page + "THE OFFER"
// summary, not (only) inside their located range — price band, issue sizes, lot,
// dates, ISIN, registrar, BRLMs. Swept first, cheaply, before the located ranges.
const COVER_SECTIONS = ['offer_structure', 'general_info'];

export async function startWorkerLoop(db: Db, r2: R2, clients: ExtractionClients = DEFAULT_CLIENTS): Promise<never> {
  // Janitor also runs on a 6h timer (PRD §5.3).
  setInterval(() => void janitor(r2, db).catch(() => {}), 6 * 3600 * 1000).unref();
  for (;;) {
    let doc: MongoDoc | null = null;
    try {
      doc = await claimNext(db);
    } catch (e) {
      console.warn(`[worker] claim failed (Mongo down? — fallback #27): ${String(e)}`);
      await sleep(15_000);
      continue;
    }
    if (!doc) {
      await sleep(15_000);
      continue;
    }
    const deadline = Date.now() + CFG.budget.wallMsPerDoc;
    try {
      await processDoc(db, r2, doc, deadline, clients);
    } catch (e) {
      await markPoison(db, String(doc._id), String(e)).catch(() => {});
    } finally {
      await janitorForDoc(r2, db, String(doc._id)).catch(() => {});
    }
  }
}

export async function processDoc(
  db: Db,
  r2: R2,
  doc: MongoDoc,
  deadline: number,
  clients: ExtractionClients = DEFAULT_CLIENTS,
): Promise<void> {
  const id = String(doc._id);
  const documents = db.collection('documents');
  const checkBudget = () => {
    if (Date.now() > deadline) throw new Error('budget_exceeded'); // fallback #20
  };
  const log = (msg: string) => void logEvent(id, 'pipeline', msg);

  // ── S1 fetch (idempotent: skip if stages.fetched.done; re-fetch buf from R2) ───
  let buf: Buffer | null = null;
  let state = (await documents.findOne({ _id: id as never })) as MongoDoc;
  if (!state.stages?.fetched?.done) {
    await setStatus(db, id, 'fetching');
    const res = await ingest(db, r2, { _id: id, sourceUrl: state.sourceUrl as string });
    if (!res.ok) return; // poison or byte-deduped — already recorded
    buf = res.buf ?? null;
    state = (await documents.findOne({ _id: id as never })) as MongoDoc;
  } else {
    buf = await r2.get(`pdf/${id}.pdf`);
    if (!buf) {
      // R2 lifecycle beat us to it — re-fetch from the saved source URL.
      const res = await ingest(db, r2, { _id: id, sourceUrl: state.sourceUrl as string });
      if (!res.ok) return;
      buf = res.buf ?? null;
      state = (await documents.findOne({ _id: id as never })) as MongoDoc;
    }
  }
  if (!buf) throw new Error('pdf buffer unavailable');
  checkBudget();

  const pdfDoc = openDoc(buf);
  try {
    // ── S2 classify ────────────────────────────────────────────────────────
    if (!state.stages?.classified?.done) {
      await setStatus(db, id, 'classifying');
      const t0 = Date.now();
      const docType = classifyDoc(pdfDoc);
      await documents.updateOne({ _id: id as never }, { $set: { docType } });
      // Fields not expected for this docType are born not_expected (§8 S2, #17).
      const expected = expectedFields(docType as DocType | 'UNKNOWN');
      for (const f of FIELDS) {
        if (!expected.includes(f.key)) {
          await setField(db, id, f.key, { value: null, status: 'not_expected' });
        }
      }
      await setStage(db, id, 'classified', Date.now() - t0);
      state = (await documents.findOne({ _id: id as never })) as MongoDoc;
    }
    checkBudget();

    // ── S3 locate (cached forever — re-extraction never re-locates) ───────────────
    let map = (state.stages?.located?.map ?? null) as LocatedMap | null;
    if (!state.stages?.located?.done) {
      await setStatus(db, id, 'locating');
      const t0 = Date.now();
      const { map: located, unresolved } = await locateSections(pdfDoc, {
        deepseek: (s, u) => clients.deepseekJson(s, u),
        log,
        onAliasSuggestion: (section, hint) =>
          void logEvent(id, 'alias_suggestion', { section, hint }), // §8 L-D
      });
      map = located;
      await setStage(db, id, 'located', Date.now() - t0, { map, unresolved });
      // Every field in an unresolved section is born needs_review (§8 L-E, #7/#8).
      const ctx0 = makeCtx(db, r2, id, state, buf, pdfDoc, clients, log);
      for (const section of unresolved.filter((s) => REGISTRY_SECTIONS.includes(s))) {
        for (const f of FIELDS.filter((f) => f.section === section)) {
          const cur = ((await documents.findOne({ _id: id as never })) as MongoDoc).fields?.[f.key];
          if (cur?.status === 'validated' || cur?.status === 'not_expected') continue;
          await queueUnlocatedReview(ctx0, f.key, `section_unresolved: ${section}`);
        }
      }
      state = (await documents.findOne({ _id: id as never })) as MongoDoc;
    }
    checkBudget();

    // ── S4 extract (skips validated fields — resume-safe, new-field-cheap) ─────────
    await setStatus(db, id, 'extracting');
    const ctx = makeCtx(db, r2, id, state, buf, pdfDoc, clients, log);
    const openFor = async (section: string): Promise<string[]> => {
      const fresh = (await documents.findOne({ _id: id as never })) as MongoDoc;
      return FIELDS.filter(
        (f) => f.section === section && !['validated', 'not_expected', 'needs_review'].includes(
          (fresh.fields?.[f.key] as { status?: string } | undefined)?.status ?? '',
        ),
      ).map((f) => f.key);
    };

    // Front-matter sweep: the cover + summary carry the scattered commercial terms
    // that rarely sit inside a section's located range. Opportunistic (finalPass:
    // false) — it only persists what it validates; misses fall through to the
    // located-range loop below, which then queues the true stragglers for review.
    const coverRange = { start: 0, end: Math.min(2, pdfDoc.countPages() - 1) };
    for (const section of COVER_SECTIONS) {
      checkBudget();
      const open = await openFor(section);
      if (!open.length) continue;
      await extractSection(ctx, section, coverRange, { only: open, finalPass: false });
    }

    const sections = Object.entries(map ?? {}).filter(([s]) => REGISTRY_SECTIONS.includes(s));
    let i = 0;
    for (const [section, range] of sections) {
      i++;
      checkBudget();
      const open = await openFor(section);
      if (!open.length) continue;
      await documents.updateOne(
        { _id: id as never },
        { $set: { 'progress.stageDetail': `section ${section} (${i}/${sections.length})` } },
      );
      await extractSection(ctx, section, range, { only: open });
    }
    await setStage(db, id, 'extracted', 0);

    // ── S5 validate (per-field validation ran inside the ladder) ───────────────────
    await setStatus(db, id, 'validating');
    await setStage(db, id, 'validated', 0);

    // ── S6 persist & merge ───────────────────────────────────────────────────
    const final = (await documents.findOne({ _id: id as never })) as MongoDoc;
    const anyReview = Object.values((final.fields ?? {}) as Record<string, { status?: string }>).some(
      (f) => f.status === 'needs_review',
    );
    await setStatus(db, id, anyReview ? 'done_with_review' : 'done', { lockedBy: null, lockedAt: null });
    await mergeIpoRecord(db, final);
  } finally {
    pdfDoc.destroy();
  }
}

// ── Ctx wiring: per-field attempt memory lives here; persisted state in Mongo ────
function makeCtx(
  db: Db,
  r2: R2,
  id: string,
  state: MongoDoc,
  buf: Buffer,
  pdfDoc: mupdf.Document,
  clients: ExtractionClients,
  log: (msg: string) => unknown,
): Ctx {
  const failures = new Map<string, Array<{ layer: string; reason: string; value: unknown }>>();
  const validatedValues: Record<string, unknown> = {};
  for (const [k, f] of Object.entries((state.fields ?? {}) as Record<string, { status?: string; value?: unknown }>)) {
    if (f.status === 'validated') validatedValues[k] = { value: f.value };
  }
  const cost = { firecrawlMdCalls: 0, firecrawlPdfCalls: 0, deepseekTokens: 0 };
  const flushCost = () =>
    void db.collection('documents').updateOne(
      { _id: id as never },
      { $inc: { 'cost.firecrawlMdCalls': cost.firecrawlMdCalls, 'cost.firecrawlPdfCalls': cost.firecrawlPdfCalls, 'cost.deepseekTokens': cost.deepseekTokens } },
    ).then(() => { cost.firecrawlMdCalls = 0; cost.firecrawlPdfCalls = 0; cost.deepseekTokens = 0; });

  return {
    hash: id,
    docType: (state.docType ?? 'UNKNOWN') as DocType,
    isScanned: !!state.isScanned,
    pdfBuf: buf,
    pdfDoc,
    db,
    r2,
    clients,
    log,
    setField: async (key, patch) => {
      if ((patch as { status?: string }).status === 'validated') {
        validatedValues[key] = { value: (patch as { value?: unknown }).value };
      }
      const attempts = (failures.get(key)?.length ?? 0) + ((patch as { status?: string }).status === 'validated' ? 1 : 0);
      await setField(db, id, key, { ...patch, attempts: Math.max(1, attempts) });
      await flushCost();
    },
    fieldValues: () => validatedValues,
    recordFailure: (key, layer, reason, value) => {
      const list = failures.get(key) ?? [];
      list.push({ layer, reason, value });
      failures.set(key, list);
      void db.collection('documents').updateOne(
        { _id: id as never },
        { $set: { [`fields.${key}`]: { status: 'in_ladder', layer, attempts: list.length, lastError: reason } } },
      );
      void logEvent(id, 'ladder_attempt', { key, layer, reason });
    },
    fmtLastError: (key) => {
      const last = failures.get(key)?.at(-1);
      return last ? `${key}: returned ${JSON.stringify(last.value)} via ${last.layer}, failed because ${last.reason}` : null;
    },
    lastError: (key) => failures.get(key)?.at(-1)?.reason ?? null,
    lastGuess: (key) => failures.get(key)?.at(-1)?.value,
    allLayerValues: (key) => {
      const out: Record<string, unknown> = {};
      for (const f of failures.get(key) ?? []) if (f.value !== undefined) out[f.layer] = f.value;
      const v = (validatedValues[key] as { value?: unknown } | undefined)?.value;
      if (v !== undefined) out.validated = v;
      return out;
    },
    bumpCost: (layer) => {
      if (layer === 'firecrawl_md') cost.firecrawlMdCalls++;
      else if (layer === 'firecrawl_pdf' || layer === 'combined') cost.firecrawlPdfCalls++;
    },
    onDeepseekTokens: (t) => {
      cost.deepseekTokens += t;
    },
    useDeepseek: CFG.extract.useDeepseek,
  };
}

async function queueUnlocatedReview(ctx: Ctx, key: string, reason: string): Promise<void> {
  const imageKey = `review/${ctx.hash}/${key}.png`;
  try {
    await ctx.r2.put(imageKey, pagePng(ctx.pdfBuf, 0), 'image/png');
  } catch { /* degrade: review entry without image (fallback #28) */ }
  await ctx.db.collection('review_queue').updateOne(
    { docHash: ctx.hash, field: key, status: 'open' },
    {
      $set: {
        docHash: ctx.hash, field: key, pages: [1], bestGuess: null, lastError: reason,
        candidates: {}, imageKey, status: 'open', resolvedValue: null, resolvedBy: null, resolvedAt: null,
      },
    },
    { upsert: true },
  );
  await ctx.setField(key, { value: null, status: 'needs_review', reason });
}
