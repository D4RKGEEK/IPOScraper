/**
 * janitor.ts — R2 retention enforcement (PRD §5.3). Runs (a) inline at the end
 * of every document, (b) on a timer every 6h, (c) on demand via the API.
 *
 * Rules:
 *  1. work/ for any doc in a terminal state → delete all
 *  2. pdf/  for docs done + reviews resolved, or poison older than 7d → delete
 *  3. review/ PNGs whose review_queue entry is resolved → delete
 *  4. orphans: any {hash} in R2 with no Mongo document → delete
 *  5. log freed bytes to events collection
 */
import type { Db } from 'mongodb';
import type { R2 } from './r2';

const TERMINAL = ['done', 'done_with_review', 'failed_poison'];
const POISON_RETENTION_MS = 7 * 24 * 3600 * 1000;

export interface JanitorResult {
  dryRun: boolean;
  deleted: Array<{ key: string; size: number; rule: number }>;
  freedBytes: number;
}

function hashFromKey(key: string): string | null {
  const m = /^(?:pdf\/([0-9a-f]{8,})\.pdf|work\/([0-9a-f]{8,})\/|review\/([0-9a-f]{8,})\/)/.exec(key);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

export async function janitor(
  r2: R2,
  db: Db,
  opts: { dryRun?: boolean; onlyHash?: string } = {},
): Promise<JanitorResult> {
  const dryRun = !!opts.dryRun;
  const deleted: JanitorResult['deleted'] = [];
  const drop = async (key: string, size: number, rule: number) => {
    deleted.push({ key, size, rule });
    if (!dryRun) await r2.delete(key);
  };

  const documents = db.collection('documents');
  const reviews = db.collection('review_queue');

  const docs = await documents
    .find(opts.onlyHash ? { _id: opts.onlyHash as never } : {})
    .project({ _id: 1, status: 1, updatedAt: 1 })
    .toArray();
  const byHash = new Map(docs.map((d) => [String(d._id), d]));

  const [pdfObjs, workObjs, reviewObjs] = [
    await r2.list(opts.onlyHash ? `pdf/${opts.onlyHash}` : 'pdf/'),
    await r2.list(opts.onlyHash ? `work/${opts.onlyHash}/` : 'work/'),
    await r2.list(opts.onlyHash ? `review/${opts.onlyHash}/` : 'review/'),
  ];

  // Rule 1 — work/ for any doc in a terminal state (orphans → rule 4)
  for (const o of workObjs) {
    const hash = hashFromKey(o.key);
    const doc = hash ? byHash.get(hash) : undefined;
    if (doc && TERMINAL.includes(doc.status as string)) await drop(o.key, o.size, 1);
    else if (hash && !doc && !opts.onlyHash) await drop(o.key, o.size, 4);
  }

  // Rule 2 — pdf/ for done docs with all reviews resolved, or stale poison
  for (const o of pdfObjs) {
    const hash = hashFromKey(o.key);
    if (!hash) continue;
    const doc = byHash.get(hash);
    if (!doc) {
      if (!opts.onlyHash) await drop(o.key, o.size, 4);
      continue;
    }
    const status = doc.status as string;
    if (status === 'done') {
      await drop(o.key, o.size, 2);
    } else if (status === 'done_with_review') {
      const open = await reviews.countDocuments({ docHash: hash, status: 'open' });
      if (open === 0) await drop(o.key, o.size, 2);
    } else if (status === 'failed_poison') {
      const updatedAt = doc.updatedAt ? new Date(doc.updatedAt as string | Date).getTime() : 0;
      if (Date.now() - updatedAt > POISON_RETENTION_MS) await drop(o.key, o.size, 2);
    }
  }

  // Rule 3 — review/ PNGs whose review_queue entry is resolved (or dismissed)
  for (const o of reviewObjs) {
    const hash = hashFromKey(o.key);
    if (hash && !byHash.has(hash)) {
      if (!opts.onlyHash) await drop(o.key, o.size, 4);
      continue;
    }
    const entry = await reviews.findOne({ imageKey: o.key });
    if (entry && entry.status !== 'open') await drop(o.key, o.size, 3);
  }

  const freedBytes = deleted.reduce((s, d) => s + d.size, 0);
  // Rule 5 — log freed bytes to events
  try {
    await db.collection('events').insertOne({
      at: new Date(),
      docHash: opts.onlyHash ?? null,
      kind: 'janitor_sweep',
      detail: { dryRun, deleted: deleted.length, freedBytes },
    });
  } catch {
    /* best-effort audit */
  }
  return { dryRun, deleted, freedBytes };
}

/** Inline cleanup for one document hash (called at the end of every doc). */
export const janitorForDoc = (r2: R2, db: Db, hash: string) => janitor(r2, db, { onlyHash: hash });
