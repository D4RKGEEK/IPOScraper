/**
 * state.ts — Mongo state manager (PRD §11.8). Mongo is the single source of
 * truth; any restart resumes from the last completed unit of work.
 *
 * Identity note: `_id` is the SHA-256 of the sourceUrl (stable from submit time,
 * so the API can return a documentId immediately); `pdfHash` is the SHA-256 of
 * the fetched bytes and powers byte-level dedupe (PRD §8 S1.3 — a document is
 * never processed twice). R2 keys use `_id`.
 */
import * as crypto from 'node:crypto';
import type { Db, Document as MongoDoc } from 'mongodb';
import { FIELDS, type DocType } from './registry/fields';

export const WORKER_ID = `worker-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
const STALE_LOCK_MS = 15 * 60_000;

export const sha256 = (data: crypto.BinaryLike): string =>
  crypto.createHash('sha256').update(data).digest('hex');

export type DocStatus =
  | 'queued' | 'fetching' | 'classifying' | 'locating' | 'extracting'
  | 'validating' | 'done' | 'done_with_review' | 'failed_poison';

/** Claim the oldest queued doc, or one with a stale lock (§11.8). Atomic. */
export async function claimNext(db: Db): Promise<MongoDoc | null> {
  const res = await db.collection('documents').findOneAndUpdate(
    {
      $or: [
        { status: 'queued' },
        {
          status: { $in: ['fetching', 'classifying', 'locating', 'extracting', 'validating'] },
          lockedAt: { $lt: new Date(Date.now() - STALE_LOCK_MS) },
        },
      ],
    },
    { $set: { lockedBy: WORKER_ID, lockedAt: new Date() } },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
  return res ?? null;
}

/** Expected fields for a docType (drives progress + not_expected marking). */
export function expectedFields(docType: DocType | 'UNKNOWN'): string[] {
  if (docType === 'ADDENDUM' || docType === 'UNKNOWN') return FIELDS.map((f) => f.key);
  return FIELDS.filter((f) => f.expectedIn.includes(docType)).map((f) => f.key);
}

/** Recompute the §7.2 progress block from a document. Pure — unit-testable. */
export function computeProgress(doc: MongoDoc): Record<string, unknown> {
  const fields = (doc.fields ?? {}) as Record<string, { status?: string }>;
  const docType = (doc.docType ?? 'UNKNOWN') as DocType | 'UNKNOWN';
  const expected = expectedFields(docType);
  const total = FIELDS.length;
  let validated = 0; let review = 0; let notExpected = 0;
  for (const key of Object.keys(fields)) {
    const s = fields[key]?.status;
    if (s === 'validated') validated++;
    else if (s === 'needs_review') review++;
    else if (s === 'not_expected') notExpected++;
  }
  // Fields outside this docType's expectations count as not_expected up front.
  notExpected += Math.max(0, total - expected.length - Object.keys(fields).filter((k) => fields[k]?.status === 'not_expected' && !expected.includes(k)).length * 0);
  notExpected = Math.min(notExpected, total - validated - review);
  const settled = validated + review + notExpected;
  const pending = Math.max(0, total - settled);

  // Stage weights (PRD §7.2): fetch 5, classify 5, locate 15,
  // extract 65 × fieldsDone/fieldsTotal, validate+persist 10.
  const stages = (doc.stages ?? {}) as Record<string, { done?: boolean }>;
  let percent = 0;
  if (stages.fetched?.done) percent += 5;
  if (stages.classified?.done) percent += 5;
  if (stages.located?.done) percent += 15;
  percent += Math.round(65 * (total ? settled / total : 0));
  const status = doc.status as DocStatus;
  if (status === 'done' || status === 'done_with_review' || status === 'failed_poison') percent = 100;
  percent = Math.min(100, percent);

  return {
    percent,
    stage: status,
    stageDetail: doc.progress && (doc.progress as Record<string, unknown>).stageDetail || null,
    fieldsTotal: total,
    fieldsValidated: validated,
    fieldsReview: review,
    fieldsPending: pending,
    fieldsNotExpected: notExpected,
  };
}

/** $set fields.<key> + recompute progress + updatedAt (§11.8). */
export async function setField(db: Db, id: string, key: string, patch: Record<string, unknown>): Promise<void> {
  const documents = db.collection('documents');
  const after = await documents.findOneAndUpdate(
    { _id: id as never },
    { $set: { [`fields.${key}`]: patch, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (after) {
    await documents.updateOne({ _id: id as never }, { $set: { progress: computeProgress(after) } });
  }
}

export async function setStage(
  db: Db,
  id: string,
  stage: 'fetched' | 'classified' | 'located' | 'extracted' | 'validated',
  ms: number,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const documents = db.collection('documents');
  const after = await documents.findOneAndUpdate(
    { _id: id as never },
    { $set: { [`stages.${stage}`]: { done: true, at: new Date(), ms, ...extra }, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (after) {
    await documents.updateOne({ _id: id as never }, { $set: { progress: computeProgress(after) } });
  }
}

export async function setStatus(
  db: Db,
  id: string,
  status: DocStatus,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const documents = db.collection('documents');
  const after = await documents.findOneAndUpdate(
    { _id: id as never },
    { $set: { status, updatedAt: new Date(), ...extra } },
    { returnDocument: 'after' },
  );
  if (after) {
    await documents.updateOne({ _id: id as never }, { $set: { progress: computeProgress(after) } });
  }
}

export async function markPoison(db: Db, id: string, reason: string): Promise<void> {
  await setStatus(db, id, 'failed_poison', { error: reason, lockedBy: null, lockedAt: null });
}
