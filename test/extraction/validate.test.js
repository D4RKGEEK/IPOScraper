import { describe, it, expect, beforeEach } from 'vitest';
import * as v from '../../src/extraction/validate.js';

// A result that passes every default rule cleanly.
const goodResult = {
  company_name: 'Leapfrog Engineering Services Ltd.',
  price_band: '₹21 to ₹23',
  total_issue_amount: '₹88.51 Crore',
  lot_size: '6,000 Shares',
  financials: [{ period: 'FY2024', pat: '12.5' }],
  objects_of_the_offer: [{ object: 'Working capital', estimated_amount: '36.05' }],
  risk_factors: ['risk a', 'risk b', 'risk c', 'risk d'],
  lead_managers: ['Anant Securities'],
  reservations: [
    { category: 'QIB', pct_of_net_issue: '50%' },
    { category: 'NII', pct_of_net_issue: '15%' },
    { category: 'Retail', pct_of_net_issue: '35%' },
  ],
};
const goodIpo = { companyName: 'Leapfrog Engineering Services Limited', priceBand: '21-23' };

describe('validate: extractNumbers', () => {
  it('pulls all numbers, strips commas', () => {
    expect(v.extractNumbers('₹21 to ₹23')).toEqual([21, 23]);
    expect(v.extractNumbers('3,84,84,000 shares')).toEqual([38484000]);
    expect(v.extractNumbers('21-23')).toEqual([21, 23]); // hyphen = range, not minus
    expect(v.extractNumbers('-5%')).toEqual([-5]);        // leading minus = negative
    expect(v.extractNumbers(null)).toEqual([]);
  });
});

describe('validate: scoring', () => {
  beforeEach(() => v.resetRules());

  it('a complete, consistent result scores 100 and passes', () => {
    const r = v.validateExtraction(goodResult, goodIpo);
    expect(r.score).toBe(100);
    expect(r.status).toBe('pass');
    expect(r.failed).toBe(0);
  });

  it('missing required fields drop the score and flip to review', () => {
    const r = v.validateExtraction({ ...goodResult, company_name: '[-]', price_band: '[-]' }, goodIpo);
    expect(r.score).toBeLessThan(80);
    expect(r.status).toBe('review');
    const ids = r.findings.filter((f) => !f.ok && !f.skipped).map((f) => f.id);
    expect(ids).toContain('company_name_present');
    expect(ids).toContain('price_band_present');
  });

  it('non-required rules are SKIPPED (no penalty) when the field is absent', () => {
    const r = v.validateExtraction({ company_name: 'X', price_band: '[-]' }, {});
    const pf = r.findings.find((f) => f.id === 'price_band_format');
    expect(pf.skipped).toBe(true);
    expect(pf.ok).toBe(true);
  });

  it('objectlist_sum flags reservation percentages that do not sum to ~100', () => {
    const bad = { ...goodResult, reservations: [{ category: 'QIB', pct_of_net_issue: '10%' }] };
    const r = v.validateExtraction(bad, goodIpo);
    const f = r.findings.find((x) => x.id === 'reservations_sum_100');
    expect(f.ok).toBe(false);
  });

  it('cross_check fuzzy matches a near-identical master company name', () => {
    const r = v.validateExtraction(goodResult, goodIpo);
    const f = r.findings.find((x) => x.id === 'company_name_matches_master');
    expect(f.ok).toBe(true);
  });

  it('cross_check numeric fails when extracted price band differs from master', () => {
    const r = v.validateExtraction({ ...goodResult, price_band: '₹99 to ₹100' }, goodIpo);
    const f = r.findings.find((x) => x.id === 'price_band_matches_master');
    expect(f.ok).toBe(false);
  });

  it('cross_check is skipped when the master field is empty', () => {
    const r = v.validateExtraction(goodResult, {}); // no companyName/priceBand on ipo
    const f = r.findings.find((x) => x.id === 'price_band_matches_master');
    expect(f.skipped).toBe(true);
  });
});

describe('validate: ruleset mutation', () => {
  beforeEach(() => v.resetRules());

  it('validateRules rejects a bad id', () => {
    expect(() => v.setRules([{ id: 'Bad Id', field: 'x', type: 'required', weight: 1 }])).toThrow(/invalid id/);
  });

  it('validateRules rejects an unknown type', () => {
    expect(() => v.setRules([{ id: 'r1', field: 'x', type: 'nope', weight: 1 }])).toThrow(/invalid type/);
  });

  it('validateRules rejects duplicate ids', () => {
    expect(() => v.setRules([
      { id: 'r1', field: 'x', type: 'required', weight: 1 },
      { id: 'r1', field: 'y', type: 'required', weight: 1 },
    ])).toThrow(/duplicate/);
  });

  it('setThreshold clamps to 0–100', () => {
    expect(() => v.setThreshold(150)).toThrow(/0–100/);
    expect(v.setThreshold(50)).toBe(50);
  });

  it('disabled rules are not evaluated', () => {
    const rules = v.getDefaultRules().map((r) => r.id === 'company_name_present' ? { ...r, enabled: false } : r);
    v.setRules(rules);
    const r = v.validateExtraction({ ...goodResult, company_name: '[-]' }, goodIpo);
    expect(r.findings.some((f) => f.id === 'company_name_present')).toBe(false);
  });
});
