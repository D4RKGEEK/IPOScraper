/**
 * classify.ts — S2 (PRD §8). Read pages 1–3, uppercase, match in priority order.
 * A DRHP has no price band by law: without classification the pipeline would
 * report fake failures on fields that were never in the document. Unexpected
 * fields are marked `not_expected` — never failures.
 */
import type * as mupdf from 'mupdf';
import { rangeText } from './pdf/mupdf-helpers';
import type { DocType } from './registry/fields';

export type ClassifiedType = DocType | 'UNKNOWN';

export function classifyText(firstPagesText: string): ClassifiedType {
  const t = firstPagesText.toUpperCase();
  // ADDENDUM/CORRIGENDUM first: such covers routinely reference the
  // "RED HERRING PROSPECTUS" they amend and would otherwise misclassify.
  if (/\b(ADDENDUM|CORRIGENDUM)\b/.test(t)) return 'ADDENDUM';
  if (t.includes('DRAFT RED HERRING')) return 'DRHP';
  if (t.includes('RED HERRING PROSPECTUS')) return 'RHP';
  if (t.includes('PROSPECTUS')) return 'PROSPECTUS';
  return 'UNKNOWN';
}

export function classifyDoc(doc: mupdf.Document): ClassifiedType {
  return classifyText(rangeText(doc, 0, 2));
}
