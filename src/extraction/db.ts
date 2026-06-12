/**
 * db.ts — Mongo bootstrap for the extraction pipeline (PRD §6, §16.3).
 * Collections: documents (state machine), ipos (merged canonical records),
 * review_queue, events (capped audit log).
 */
import { MongoClient, Db } from 'mongodb';
import { CFG } from './config';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectExtractionDb(): Promise<Db> {
  if (db) return db;
  client = new MongoClient(CFG.mongoUrl, { maxPoolSize: 10 });
  await client.connect();
  db = client.db(CFG.mongoDb);
  await ensureCollections(db);
  return db;
}

export function getExtractionDb(): Db {
  if (!db) throw new Error('extraction Mongo not connected — call connectExtractionDb() first');
  return db;
}

async function ensureCollections(database: Db): Promise<void> {
  // events: capped so it can never grow unbounded (PRD §6.4)
  const names = (await database.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
  if (!names.includes('events')) {
    await database.createCollection('events', { capped: true, size: 50 * 1024 * 1024 });
  }

  const documents = database.collection('documents');
  await documents.createIndex({ status: 1, createdAt: 1 });           // queue claim
  await documents.createIndex({ sourceUrl: 1 }, { unique: true });    // dedupe by URL
  await documents.createIndex({ 'sourceMeta.ipoSlug': 1 });

  const reviews = database.collection('review_queue');
  await reviews.createIndex({ status: 1 });
  await reviews.createIndex({ docHash: 1, field: 1 });

  const events = database.collection('events');
  await events.createIndex({ docHash: 1 });
}

export const col = {
  documents: () => getExtractionDb().collection('documents'),
  ipos: () => getExtractionDb().collection('ipos'),
  reviewQueue: () => getExtractionDb().collection('review_queue'),
  events: () => getExtractionDb().collection('events'),
};

/** Append-only audit log entry (PRD §6.4). */
export async function logEvent(docHash: string | null, kind: string, detail: unknown): Promise<void> {
  try {
    await col.events().insertOne({ at: new Date(), docHash, kind, detail });
  } catch {
    /* events are best-effort; never fail the pipeline on audit writes */
  }
}

export async function closeExtractionDb(): Promise<void> {
  if (client) await client.close();
  client = null;
  db = null;
}
