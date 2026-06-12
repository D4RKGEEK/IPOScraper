/**
 * eventsRepository.ts — typed access to the extraction pipeline's append-only
 * audit log (PRD §6.4; capped collection, created by src/extraction/db.ts).
 */
import { col } from '../extraction/db';

export interface EventRecord {
  at: Date;
  docHash: string | null;
  kind: string;
  detail: unknown;
}

export async function appendEvent(docHash: string | null, kind: string, detail: unknown): Promise<void> {
  await col.events().insertOne({ at: new Date(), docHash, kind, detail });
}

export async function listEvents(docHash: string, limit = 500): Promise<EventRecord[]> {
  const rows = await col.events().find({ docHash }).sort({ at: -1 }).limit(limit).toArray();
  return rows as unknown as EventRecord[];
}
