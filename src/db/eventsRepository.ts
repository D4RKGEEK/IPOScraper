/**
 * db/eventsRepository.ts — Append-only audit trail for the `events` collection.
 *
 * Index:
 *   docHash    1
 *   at         -1
 *   type       1
 */

// @ts-ignore CommonJS module
import { getDb } from './mongo.js';
import type { Collection } from 'mongodb';

export interface EventDoc {
  _id?: string;
  docHash: string;
  at: string;         // ISO timestamp
  type: 'info' | 'warning' | 'error' | 'stage' | 'retry' | 'review';
  message: string;
  data?: Record<string, unknown>;
}

export async function insertEvent(event: EventDoc): Promise<void> {
  const col = getDb().collection('events') as Collection<EventDoc>;
  await col.insertOne(event);
}

export async function findByDocHash(
  docHash: string,
  limit = 200,
): Promise<EventDoc[]> {
  const col = getDb().collection('events') as Collection<EventDoc>;
  return (await col.find({ docHash }).sort({ at: -1 }).limit(limit).toArray()) as unknown as EventDoc[];
}

export async function eventsCollection(): Promise<Collection<EventDoc>> {
  return getDb().collection('events');
}