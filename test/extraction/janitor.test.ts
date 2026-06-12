import { describe, it, expect } from 'vitest';
import { janitor } from '../../src/extraction/janitor';
import type { R2 } from '../../src/extraction/r2';

const HASH_DONE = 'abcdef1234abcdef1234';
const HASH_ORPHAN = 'feedbeef9900feedbeef';

function fakeR2(objects: Array<{ key: string; size: number }>) {
  const deleted: string[] = [];
  const r2: R2 = {
    async put() { /* noop */ },
    async get() { return null; },
    async delete(key) { deleted.push(key); },
    async list(prefix) { return objects.filter((o) => o.key.startsWith(prefix)); },
    async presign() { return 'https://example/signed'; },
  };
  return { r2, deleted };
}

function fakeDb(docs: Array<Record<string, unknown>>, reviews: Array<Record<string, unknown>>) {
  return {
    collection(name: string) {
      if (name === 'documents') {
        return {
          find: () => ({ project: () => ({ toArray: async () => docs }) }),
        };
      }
      if (name === 'review_queue') {
        return {
          countDocuments: async (q: { docHash: string }) =>
            reviews.filter((r) => r.docHash === q.docHash && r.status === 'open').length,
          findOne: async (q: { imageKey: string }) => reviews.find((r) => r.imageKey === q.imageKey) ?? null,
        };
      }
      return { insertOne: async () => ({}) }; // events
    },
  } as never;
}

describe('janitor (PRD §5.3)', () => {
  const objects = [
    { key: `pdf/${HASH_DONE}.pdf`, size: 1000 },          // rule 2: doc done → delete
    { key: `work/${HASH_DONE}/offer_structure.md`, size: 10 }, // rule 1: terminal → delete
    { key: `review/${HASH_DONE}/lot_size.png`, size: 50 },     // rule 3: resolved → delete
    { key: `pdf/${HASH_ORPHAN}.pdf`, size: 2000 },        // rule 4: no Mongo doc → delete
  ];
  const docs = [{ _id: HASH_DONE, status: 'done', updatedAt: new Date() }];
  const reviews = [{ docHash: HASH_DONE, imageKey: `review/${HASH_DONE}/lot_size.png`, status: 'resolved' }];

  it('dryRun lists every deletion without touching R2 (W7)', async () => {
    const { r2, deleted } = fakeR2(objects);
    const res = await janitor(r2, fakeDb(docs, reviews), { dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.deleted.length).toBe(4);
    expect(res.freedBytes).toBe(3060);
    expect(deleted).toEqual([]); // nothing actually deleted
  });

  it('real run applies all four rules', async () => {
    const { r2, deleted } = fakeR2(objects);
    const res = await janitor(r2, fakeDb(docs, reviews));
    expect(deleted.sort()).toEqual(objects.map((o) => o.key).sort());
    const rules = new Set(res.deleted.map((d) => d.rule));
    expect(rules.has(1)).toBe(true);
    expect(rules.has(2)).toBe(true);
    expect(rules.has(3)).toBe(true);
    expect(rules.has(4)).toBe(true);
  });

  it('keeps the pdf while reviews are still open', async () => {
    const openReviews = [{ docHash: HASH_DONE, imageKey: `review/${HASH_DONE}/lot_size.png`, status: 'open' }];
    const reviewDocs = [{ _id: HASH_DONE, status: 'done_with_review', updatedAt: new Date() }];
    const { r2 } = fakeR2(objects.slice(0, 3));
    const res = await janitor(r2, fakeDb(reviewDocs, openReviews));
    const keys = res.deleted.map((d) => d.key);
    expect(keys).not.toContain(`pdf/${HASH_DONE}.pdf`);     // original kept until reviews resolved
    expect(keys).not.toContain(`review/${HASH_DONE}/lot_size.png`); // open review PNG kept
    expect(keys).toContain(`work/${HASH_DONE}/offer_structure.md`); // work/ still swept
  });
});
