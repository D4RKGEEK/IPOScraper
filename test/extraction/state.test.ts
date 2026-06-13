import { describe, it, expect } from 'vitest';
import { computeProgress, expectedFields } from '../../src/extraction/state';
import { FIELDS } from '../../src/extraction/registry/fields';

describe('computeProgress (PRD §7.2 stage weights)', () => {
  const total = FIELDS.length;

  it('queued doc with nothing done → 0%', () => {
    const p = computeProgress({ status: 'queued', stages: {}, fields: {} });
    expect(p.percent).toBe(0);
    expect(p.fieldsPending).toBe(total);
  });

  it('fetch+classify+locate done → 25% before any field settles', () => {
    const p = computeProgress({
      status: 'extracting',
      stages: { fetched: { done: true }, classified: { done: true }, located: { done: true } },
      fields: {},
    });
    expect(p.percent).toBe(25);
  });

  it('extract weight scales with settled fields (65 × done/total)', () => {
    const fields: Record<string, { status: string }> = {};
    const half = Math.floor(total / 2);
    FIELDS.slice(0, half).forEach((f) => { fields[f.key] = { status: 'validated' }; });
    const p = computeProgress({
      status: 'extracting',
      stages: { fetched: { done: true }, classified: { done: true }, located: { done: true } },
      fields,
    });
    expect(p.percent).toBe(25 + Math.round(65 * (half / total)));
    expect(p.fieldsValidated).toBe(half);
  });

  it('not_expected and needs_review both count as settled — no double counting', () => {
    const fields: Record<string, { status: string }> = {};
    FIELDS.forEach((f, i) => { fields[f.key] = { status: i % 2 ? 'not_expected' : 'needs_review' }; });
    const p = computeProgress({ status: 'extracting', stages: { fetched: { done: true }, classified: { done: true }, located: { done: true } }, fields });
    expect((p.fieldsReview as number) + (p.fieldsNotExpected as number)).toBe(total);
    expect(p.fieldsPending).toBe(0);
  });

  it('terminal states pin to 100%', () => {
    for (const status of ['done', 'done_with_review', 'failed_poison']) {
      expect(computeProgress({ status, stages: {}, fields: {} }).percent).toBe(100);
    }
  });
});

describe('expectedFields (placeholder model)', () => {
  it('DRHP expects every field — values absent in the DRHP become [.] placeholders, not not_expected', () => {
    const drhp = expectedFields('DRHP');
    // Under the placeholder model a DRHP still "expects" price band / lot size / dates;
    // when they are "[●]" in the document they are stored as placeholders and a later
    // RHP/Prospectus overwrites them.
    expect(drhp).toContain('price_band');
    expect(drhp).toContain('lot_size');
    expect(drhp).toContain('issue_open_date');
    expect(drhp).toContain('promoter_pct');
  });
  it('PROSPECTUS expects everything', () => {
    expect(expectedFields('PROSPECTUS').length).toBe(FIELDS.length);
  });
});
