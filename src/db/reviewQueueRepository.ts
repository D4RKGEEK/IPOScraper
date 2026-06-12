/**
 * reviewQueueRepository.ts — typed access to the extraction pipeline's
 * review_queue (PRD §6.3). Resolution VALIDATION lives in the API layer
 * (same zod + business rules as the ladder — humans don't bypass validation).
 */
import { ObjectId, type Document as MongoDoc } from 'mongodb';
import { col } from '../extraction/db';

export type ReviewStatus = 'open' | 'resolved' | 'dismissed';

export async function listReviews(status: ReviewStatus = 'open', limit = 200): Promise<MongoDoc[]> {
  return col.reviewQueue().find({ status }).sort({ _id: -1 }).limit(limit).toArray();
}

export async function getReview(id: string): Promise<MongoDoc | null> {
  return col.reviewQueue().findOne({ _id: new ObjectId(id) });
}

export async function markResolved(id: string, value: unknown, resolvedBy = 'api'): Promise<void> {
  await col.reviewQueue().updateOne(
    { _id: new ObjectId(id) },
    { $set: { status: 'resolved', resolvedValue: value, resolvedBy, resolvedAt: new Date() } },
  );
}

export async function markDismissed(id: string, resolvedBy = 'api'): Promise<void> {
  await col.reviewQueue().updateOne(
    { _id: new ObjectId(id) },
    { $set: { status: 'dismissed', resolvedBy, resolvedAt: new Date() } },
  );
}
