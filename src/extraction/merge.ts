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
    { value: unknown; status: string; fromDoc: string; fromType: DocType; page: number | null; processedAt: Date }
  >;

  const now = new Date();
  const docFields = (doc.fields ?? {}) as Record<string, { status?: string; value?: unknown; page?: number }>;
  for (const def of FIELDS) {
    const f = docFields[def.key];
    // Merge real values AND placeholders: a placeholder ('[.]') holds the slot until a
    // stronger document supplies the real value (user's DRHP→RHP rule).
    if (!f || (f.status !== 'validated' && f.status !== 'placeholder')) continue;
    const cur = fields[def.key];
    const incomingValidated = f.status === 'validated';
    const curValidated = cur?.status === 'validated';
    const incomingRank = RANK[docType];
    const curRank = cur ? RANK[cur.fromType] ?? -1 : -1;
    let overwrite: boolean;
    if (!cur) overwrite = true;
    else if (incomingValidated && !curValidated) overwrite = true;   // real value replaces a placeholder
    else if (!incomingValidated && curValidated) overwrite = false;  // never downgrade real → placeholder
    // same tier (both real or both placeholder): stronger doc wins, then newer (#33).
    else overwrite = incomingRank > curRank || (incomingRank === curRank && now >= cur.processedAt);
    if (overwrite) {
      fields[def.key] = {
        value: f.value,
        status: f.status as string,
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
  const filled = Object.values(fields).filter((f) => f.status === 'validated').length;
  const placeholders = Object.values(fields).filter((f) => f.status === 'placeholder').length;
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
        isin: (fields['isin']?.status === 'validated' ? (fields['isin']?.value as string) : undefined) ?? existing.isin ?? null,
        fields,
        documents,
        completeness: { expected, filled, placeholders, needsReview },
        updatedAt: now,
      },
    },
    { upsert: true },
  );
}
