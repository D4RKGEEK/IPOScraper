/**
 * merge.ts — S6.2 IPO-level merge (PRD §6.2). DRHP → RHP → Prospectus of the
 * same company merge into ONE canonical IPO record, field by field, with
 * precedence PROSPECTUS > RHP > DRHP > ADDENDUM-patches. Newer/stronger
 * documents overwrite; gaps fall through. Every field remembers its source.
 */
import type { Db, Document as MongoDoc } from 'mongodb';
import { FIELDS, type DocType } from './registry/fields';
import { logEvent } from './db';

const RANK: Record<DocType, number> = { PROSPECTUS: 3, RHP: 2, DRHP: 1, ADDENDUM: 0 };

export async function mergeIpoRecord(db: Db, doc: MongoDoc): Promise<void> {
  const slug = (doc.sourceMeta as { ipoSlug?: string } | undefined)?.ipoSlug;
  if (!slug) return;
  const docType = (doc.docType ?? 'UNKNOWN') as DocType | 'UNKNOWN';
  if (docType === 'UNKNOWN') return;

  const ipos = db.collection('ipos');
  const existing = (await ipos.findOne({ _id: slug as never })) ?? { fields: {}, documents: [] };
  const fields = { ...(existing.fields ?? {}) } as Record<
    string,
    { value: unknown; fromDoc: string; fromType: DocType; page: number | null; processedAt: Date }
  >;

  const now = new Date();
  const docFields = (doc.fields ?? {}) as Record<string, { status?: string; value?: unknown; page?: number }>;
  for (const def of FIELDS) {
    const f = docFields[def.key];
    if (!f || f.status !== 'validated') continue; // §12 invariant: only verified values merge
    const cur = fields[def.key];
    const incomingRank = RANK[docType];
    const curRank = cur ? RANK[cur.fromType] ?? -1 : -1;
    // Stronger type wins; equal type → newer processedAt wins (fallback #33);
    // ADDENDUM (rank 0) patches only gaps it explicitly contains.
    const overwrite =
      !cur || incomingRank > curRank || (incomingRank === curRank && now >= cur.processedAt);
    if (overwrite) {
      fields[def.key] = {
        value: f.value,
        fromDoc: String(doc._id),
        fromType: docType,
        page: f.page ?? null,
        processedAt: now,
      };
    }
  }

  const expected = FIELDS.filter((f) =>
    docType === 'ADDENDUM' ? true : f.expectedIn.includes(docType),
  ).length;
  const filled = Object.keys(fields).length;
  const needsReview = Object.values(docFields).filter((f) => f.status === 'needs_review').length;

  const documents = [
    ...((existing.documents ?? []) as Array<{ hash: string; type: string; processedAt: Date }>).filter(
      (d) => d.hash !== String(doc._id),
    ),
    { hash: String(doc._id), type: docType, processedAt: now },
  ];
  if (documents.filter((d) => d.type === docType).length > 1) {
    await logEvent(String(doc._id), 'ipo_merge_conflict', { slug, type: docType }); // fallback #33
  }

  await ipos.updateOne(
    { _id: slug as never },
    {
      $set: {
        company: (doc.sourceMeta as { company?: string } | undefined)?.company ?? existing.company ?? null,
        isin: (fields['isin']?.value as string | undefined) ?? existing.isin ?? null,
        fields,
        documents,
        completeness: { expected, filled, needsReview },
        updatedAt: now,
      },
    },
    { upsert: true },
  );
}
