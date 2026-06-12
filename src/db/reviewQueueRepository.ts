/**
 * db/reviewQueueRepository.ts — Human review queue for the `review_queue` collection.
 *
 * Index:
 *   _id        (auto)
 *   docHash    1
 *   status     1 (open/resolved/dismissed)
 *   ipoSlug    1
 *   createdAt  -1
 */

// @ts-ignore CommonJS module — no bundled .d.ts for db/mongo.js
import { getDb } from './mongo.js';
import type { Collection, WithId, Filter } from 'mongodb';
import type { FieldCandidate } from '../src/types/index.js';

export interface ReviewEntry {
  _id: string;                // format: "{docHash}_{fieldKey}_{timestamp}"
  docHash: string;
  fieldKey: string;
  section: string;
  ipoSlug: string;
  candidates: FieldCandidate[];
  pngUrl?: string;
  status: 'open' | 'resolved' | 'dismissed';
  resolvedValue?: unknown;
  resolvedBy?: string;
  resolvedAt?: string;
  dismissedAt?: string;
  createdAt: string;
}

export async function createReviewEntry(entry: ReviewEntry): Promise<void> {
  const col = getDb().collection('review_queue') as Collection<ReviewEntry>;
  await col.insertOne(entry as WithId<ReviewEntry>);
}

export async function findOpenReviews(opts: {
  limit?: number;
  skip?: number;
  ipoSlug?: string;
} = {}): Promise<ReviewEntry[]> {
  const col = getDb().collection('review_queue') as Collection<ReviewEntry>;
  const filter: Filter<ReviewEntry> = { status: 'open' };
  if (opts.ipoSlug) filter.ipoSlug = opts.ipoSlug;

  return col
    .find(filter)
    .sort({ createdAt: 1 })
    .skip(opts.skip ?? 0)
    .limit(opts.limit ?? 50)
    .toArray() as Promise<ReviewEntry[]>;
}

export async function findById(id: string): Promise<ReviewEntry | null> {
  const col = getDb().collection('review_queue') as Collection<ReviewEntry>;
  return col.findOne({ _id: id }) as Promise<ReviewEntry | null>;
}

export async function resolveReview(
  id: string,
  opts: { value?: unknown; dismissed?: boolean; resolvedBy?: string },
): Promise<void> {
  const col = getDb().collection('review_queue') as Collection<ReviewEntry>;
  const now = new Date().toISOString();

  if (opts.dismissed) {
    await col.updateOne(
      { _id: id },
      { $set: { status: 'dismissed', dismissedAt: now } },
    );
  } else {
    await col.updateOne(
      { _id: id },
      {
        $set: {
          status: 'resolved',
          resolvedValue: opts.value,
          ...(opts.resolvedBy !== undefined ? { resolvedBy: opts.resolvedBy } : {}),
          resolvedAt: now,
        },
      },
    );
  }
}

export async function getStats(): Promise<{
  open: number;
  resolved: number;
  dismissed: number;
}> {
  const col = getDb().collection('review_queue') as Collection<ReviewEntry>;
  const pipeline = [
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
      },
    },
  ];
  const results = await col.aggregate(pipeline).toArray();
  const stats = { open: 0, resolved: 0, dismissed: 0 };

  for (const r of results) {
    if (r._id === 'open') stats.open = (r.count as number) ?? 0;
    else if (r._id === 'resolved') stats.resolved = (r.count as number) ?? 0;
    else if (r._id === 'dismissed') stats.dismissed = (r.count as number) ?? 0;
  }

  return stats;
}

export async function reviewQueueCollection(): Promise<Collection<ReviewEntry>> {
  return getDb().collection('review_queue');
}