import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { reconcileExtractionState, docPriority } = require('../../src/db/ipoModel.js');
const { serializeMergedMarkdown, splitMergedMarkdown } = require('../../src/extraction/markdown.js');

describe('docPriority', () => {
  it('orders final > rhp > drhp > unknown', () => {
    expect(docPriority('final')).toBeGreaterThan(docPriority('rhp'));
    expect(docPriority('rhp')).toBeGreaterThan(docPriority('drhp'));
    expect(docPriority('drhp')).toBeGreaterThan(docPriority('whatever'));
  });
});

describe('reconcileExtractionState', () => {
  it('marks drhp superseded once rhp extracts (the core RHP problem)', () => {
    const rows = [
      { docType: 'drhp', pipeline: 'cascade', status: 'completed', validation: { score: 90 }, extractedAt: '2026-01-01' },
      { docType: 'rhp', pipeline: 'cascade', status: 'completed', validation: { score: 95 }, extractedAt: '2026-02-01' },
    ];
    const s = reconcileExtractionState(rows);
    expect(s.currentDocType).toBe('rhp');
    expect(s.current).toMatchObject({ docType: 'rhp', status: 'completed', score: 95 });
    expect(s.supersededDocTypes).toEqual(['drhp']);
    const drhp = s.rows.find((r) => r.docType === 'drhp');
    const rhp = s.rows.find((r) => r.docType === 'rhp');
    expect(drhp.superseded).toBe(true);
    expect(rhp.superseded).toBe(false);
  });

  it('keeps drhp current while it is the only document', () => {
    const rows = [
      { docType: 'drhp', pipeline: 'cascade', status: 'review', validation: { score: 60 }, extractedAt: '2026-01-01' },
    ];
    const s = reconcileExtractionState(rows);
    expect(s.currentDocType).toBe('drhp');
    expect(s.current).toMatchObject({ docType: 'drhp', status: 'review', score: 60 });
    expect(s.supersededDocTypes).toEqual([]);
    expect(s.rows[0].superseded).toBe(false);
  });

  it('does not let a FAILED rhp supersede a completed drhp', () => {
    const rows = [
      { docType: 'drhp', pipeline: 'cascade', status: 'completed', validation: { score: 88 }, extractedAt: '2026-01-01' },
      { docType: 'rhp', pipeline: 'cascade', status: 'failed', validation: null, extractedAt: '2026-02-01' },
    ];
    const s = reconcileExtractionState(rows);
    expect(s.currentDocType).toBe('drhp');
    expect(s.supersededDocTypes).toEqual([]);
    expect(s.rows.find((r) => r.docType === 'drhp').superseded).toBe(false);
  });

  it('final supersedes both rhp and drhp', () => {
    const rows = [
      { docType: 'drhp', pipeline: 'cascade', status: 'completed', validation: { score: 80 }, extractedAt: '2026-01-01' },
      { docType: 'rhp', pipeline: 'cascade', status: 'completed', validation: { score: 90 }, extractedAt: '2026-02-01' },
      { docType: 'final', pipeline: 'cascade', status: 'completed', validation: { score: 99 }, extractedAt: '2026-03-01' },
    ];
    const s = reconcileExtractionState(rows);
    expect(s.currentDocType).toBe('final');
    expect(new Set(s.supersededDocTypes)).toEqual(new Set(['drhp', 'rhp']));
  });

  it('prefers completed over review within the same docType', () => {
    const rows = [
      { docType: 'rhp', pipeline: 'gemini', status: 'review', validation: { score: 70 }, extractedAt: '2026-02-02' },
      { docType: 'rhp', pipeline: 'firecrawl', status: 'completed', validation: { score: 85 }, extractedAt: '2026-02-01' },
    ];
    const s = reconcileExtractionState(rows);
    expect(s.current).toMatchObject({ pipeline: 'firecrawl', status: 'completed' });
  });

  it('returns null current when every extraction failed', () => {
    const rows = [
      { docType: 'drhp', pipeline: 'cascade', status: 'failed', validation: null, extractedAt: '2026-01-01' },
    ];
    const s = reconcileExtractionState(rows);
    expect(s.currentDocType).toBeNull();
    expect(s.current).toBeNull();
  });
});

describe('merged markdown round-trip', () => {
  it('serialize → split recovers section names and content', () => {
    const parts = [
      { name: 'COVER_PAGES', content: 'Acme Ltd\nIPO cover' },
      { name: 'RISK_FACTORS', content: '- risk one\n- risk two' },
    ];
    const merged = serializeMergedMarkdown(parts);
    const back = splitMergedMarkdown(merged);
    expect(back).toEqual(parts);
  });

  it('handles empty input', () => {
    expect(splitMergedMarkdown('')).toEqual([]);
    expect(serializeMergedMarkdown([])).toBe('');
  });
});
