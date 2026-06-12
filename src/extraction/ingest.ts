/**
 * ingest.ts — S1: fetch & ingest from the scraper's link (PRD §8 S1, §12 #1–4, #23–24).
 * Stream → /tmp semantics with a hard 100 MB cap, 120s timeout, 3 retries.
 */
import type { Db } from 'mongodb';
import type { R2 } from './r2';
import { withRetry, withTimeout } from './util/retry';
import { openDoc, pageText, isEncrypted } from './pdf/mupdf-helpers';
import { sha256, setStage, markPoison } from './state';
import { logEvent } from './db';

const MAX_BYTES = 100 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 120_000;

export interface IngestResult {
  ok: boolean;
  buf?: Buffer;
  dedupedInto?: string;
}

export async function ingest(db: Db, r2: R2, doc: { _id: unknown; sourceUrl: string }): Promise<IngestResult> {
  const id = String(doc._id);
  const t0 = Date.now();

  // Download (3 retries, 120s timeout, 100 MB cap) — fallback #23.
  let buf: Buffer;
  try {
    buf = await withRetry(
      () => withTimeout(download(doc.sourceUrl), FETCH_TIMEOUT_MS, `fetch-${id.slice(0, 8)}`),
      `ingest-${id.slice(0, 8)}`,
    );
  } catch (e) {
    await markPoison(db, id, `source_unreachable: ${String(e)}`);
    return { ok: false };
  }

  // Magic bytes — fallback #24 (HTML/login page instead of a PDF).
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    await logEvent(id, 'source_not_pdf', { head: buf.subarray(0, 500).toString('utf8') });
    await markPoison(db, id, 'source_not_pdf');
    return { ok: false };
  }

  // Byte-level dedupe (same file, new URL) — link and stop (PRD §8 S1.3).
  const pdfHash = sha256(buf);
  const existing = await db.collection('documents').findOne({ pdfHash, _id: { $ne: id as never } });
  if (existing) {
    await db.collection('documents').updateOne(
      { _id: existing._id },
      { $addToSet: { altUrls: doc.sourceUrl } },
    );
    await db.collection('documents').updateOne(
      { _id: id as never },
      { $set: { status: 'done', dedupedInto: String(existing._id), pdfHash, updatedAt: new Date(), lockedBy: null, lockedAt: null } },
    );
    await logEvent(id, 'byte_dedupe', { into: String(existing._id) });
    return { ok: false, dedupedInto: String(existing._id) };
  }

  // Guards: opens in mupdf; not encrypted; scanned detection (page-1 text > 50 chars).
  let pageCount = 0;
  let isScanned = false;
  try {
    const pdf = openDoc(buf);
    try {
      if (isEncrypted(pdf)) {
        await markPoison(db, id, 'password_protected');
        return { ok: false };
      }
      pageCount = pdf.countPages();
      isScanned = pageText(pdf, 0).trim().length <= 50;
    } finally {
      pdf.destroy();
    }
  } catch (e) {
    await markPoison(db, id, `corrupt_pdf: ${String(e)}`);
    return { ok: false };
  }

  await r2.put(`pdf/${id}.pdf`, buf, 'application/pdf');
  await db.collection('documents').updateOne(
    { _id: id as never },
    {
      $set: {
        pdfHash,
        sizeBytes: buf.length,
        fileName: fileNameFromUrl(doc.sourceUrl),
        pageCount,
        isScanned,
        updatedAt: new Date(),
      },
    },
  );
  await setStage(db, id, 'fetched', Date.now() - t0);
  return { ok: true, buf };
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('empty body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new Error(`exceeds ${MAX_BYTES} byte cap`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

const fileNameFromUrl = (url: string): string => {
  try {
    const p = new URL(url).pathname;
    return decodeURIComponent(p.split('/').pop() || 'document.pdf');
  } catch {
    return 'document.pdf';
  }
};
