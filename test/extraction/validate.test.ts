import { describe, it, expect } from 'vitest';
import { verifyEvidence, validateField } from '../../src/extraction/validate';

const SOURCE = `--- page 312 ---\nPrice  Band:\n₹95 to ₹100 per Equity Share\nBid Lot 150 Equity Shares`;

describe('verifyEvidence (PRD §3.3, §11.6)', () => {
  it('rejects a fabricated quote', () => {
    expect(verifyEvidence('Price Band: ₹105 to ₹110 per Equity Share', SOURCE)).toBe(false);
  });
  it('accepts a whitespace/currency-shuffled genuine quote', () => {
    expect(verifyEvidence('Price Band: ₹95 to ₹100 per Equity Share', SOURCE)).toBe(true);
  });
  it('rejects quotes shorter than 8 chars', () => {
    expect(verifyEvidence('₹95', SOURCE)).toBe(false);
  });
});

describe('validateField (PRD §11.6, business rules §8 S5)', () => {
  const ev = 'Price Band: ₹95 to ₹100 per Equity Share';

  it('validates a correct price band with verbatim evidence', () => {
    const r = validateField('price_band', { value: { low: 95, high: 100 }, evidence: ev, page: 312 }, SOURCE, {});
    expect(r).toEqual({ ok: true });
  });

  it('rejects value_null', () => {
    const r = validateField('price_band', { value: null, evidence: ev, page: 312 }, SOURCE, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('value_null');
  });

  it('rejects evidence mismatch (hallucinated quote)', () => {
    const r = validateField('price_band', { value: { low: 95, high: 100 }, evidence: 'totally made up quote here', page: 1 }, SOURCE, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('evidence_mismatch');
  });

  it('rejects a swapped price band via business rule', () => {
    const r = validateField('price_band', { value: { low: 100, high: 95 }, evidence: ev, page: 312 }, SOURCE, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('low must be < high');
  });

  it('rejects a band wider than the SEBI 25% cap', () => {
    const r = validateField('price_band', { value: { low: 95, high: 130 }, evidence: ev, page: 312 }, SOURCE, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('SEBI');
  });

  it('cross-validates lot_size against the price band (retail window)', () => {
    const all = { price_band: { value: { low: 95, high: 100 } } };
    const bad = validateField('lot_size', { value: 15, evidence: 'Bid Lot 150 Equity Shares', page: 312 }, SOURCE, all);
    expect(bad.ok).toBe(false); // 15 × 100 = ₹1,500 — outside 13k..16k (W3)
    const good = validateField('lot_size', { value: 150, evidence: 'Bid Lot 150 Equity Shares', page: 312 }, SOURCE, all);
    expect(good).toEqual({ ok: true });
  });

  it('rejects face_value outside {1,2,5,10}', () => {
    const r = validateField('face_value', { value: 3, evidence: ev, page: 312 }, SOURCE, {}, { skipEvidence: true });
    expect(r.ok).toBe(false);
  });

  it('human resolve path: evidence waived, rules NOT waived (W8)', () => {
    const r = validateField('promoter_pct', { value: 642, evidence: 'human_review', page: 86 }, '', {}, { skipEvidence: true });
    expect(r.ok).toBe(false); // schema max 100
    const ok = validateField('promoter_pct', { value: 64.2, evidence: 'human_review', page: 86 }, '', {}, { skipEvidence: true });
    expect(ok).toEqual({ ok: true });
  });
});
