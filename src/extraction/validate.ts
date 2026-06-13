/**
 * validate.ts — §11.6. Evidence-or-it-didn't-happen (§3.3): a model cannot
 * fabricate a quote that string-matches the source. The exact same function
 * runs on POST /reviews/:id/resolve (evidence waived for humans, schema +
 * business rules NOT waived).
 */
import { fieldByKey } from './registry/fields';

// Evidence comes back through Firecrawl's markdown/table rendering, which inserts
// pipes/colons and reflows whitespace. Compare on alphanumerics only: drop currency
// + thousands separators first (so "1,234"=="1234"), then collapse every other run
// of punctuation/whitespace to a single space.
const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[₹,]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export function verifyEvidence(evidence: string, sourceText: string): boolean {
  if (!evidence || evidence.length < 8) return false;
  return norm(sourceText).includes(norm(evidence));
}

export interface FieldPayload {
  value?: unknown;
  evidence?: string;
  page?: number;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export function validateField(
  key: string,
  payload: FieldPayload | null | undefined,
  sourceText: string,
  all: Record<string, unknown>,
  opts: { skipEvidence?: boolean } = {},
): ValidationResult {
  const def = fieldByKey(key);
  if (!def) return { ok: false, reason: `unknown field ${key}` };
  if (payload?.value === null || payload?.value === undefined) {
    return { ok: false, reason: 'value_null' };
  }
  if (!opts.skipEvidence && !verifyEvidence(payload.evidence ?? '', sourceText)) {
    return { ok: false, reason: 'evidence_mismatch — quote not found verbatim in source' };
  }
  const parsed = def.schema.safeParse(payload.value);
  if (!parsed.success) {
    return { ok: false, reason: `schema: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  }
  for (const rule of def.rules ?? []) {
    const err = rule(payload.value, all);
    if (err) return { ok: false, reason: `rule: ${err}` };
  }
  return { ok: true };
}
