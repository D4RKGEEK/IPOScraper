import { describe, it, expect } from 'vitest';
import { diffResult, compareResults, jaccard } from '../../src/extraction/eval.js';

const fields = {
  company_name: { type: 'string' },
  risk_factors: { type: 'list' },
  financials: { type: 'objectList', fields: { period: { type: 'string' }, pat: { type: 'string' } } },
};

describe('eval: jaccard', () => {
  it('1 for identical sets, 0 for disjoint, partial otherwise', () => {
    expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(jaccard(['a'], ['b'])).toBe(0);
    expect(jaccard(['a', 'b'], ['a'])).toBeCloseTo(0.5, 5);
    expect(jaccard([], [])).toBe(1);
  });
});

describe('eval: diffResult', () => {
  const golden = {
    company_name: 'Acme Ltd',
    risk_factors: ['r1', 'r2'],
    financials: [{ period: 'FY2024', pat: '10' }],
  };

  it('perfect match scores 1.0', () => {
    const d = diffResult({ ...golden }, golden, fields);
    expect(d.overall).toBe(1);
    expect(d.matched).toBe(3);
  });

  it('a wrong string field drops accuracy', () => {
    const d = diffResult({ ...golden, company_name: 'Totally Different Corp' }, golden, fields);
    expect(d.overall).toBeLessThan(1);
    expect(d.fieldScores.company_name).toBe(0);
    expect(d.fieldScores.risk_factors).toBe(1);
  });

  it('partial list overlap yields partial credit', () => {
    const d = diffResult({ ...golden, risk_factors: ['r1'] }, golden, fields);
    expect(d.fieldScores.risk_factors).toBeCloseTo(0.5, 5);
  });

  it('both-placeholder counts as a match', () => {
    const g = { company_name: '[-]' };
    const d = diffResult({ company_name: '[-]' }, g, fields);
    expect(d.overall).toBe(1);
  });
});

describe('eval: compareResults', () => {
  it('flags disagreements across pipelines and lists them first', () => {
    const rows = [
      { pipeline: 'gemini', result: { company_name: 'Acme Ltd', price_band: '₹10 to ₹12' } },
      { pipeline: 'firecrawl', result: { company_name: 'Acme Limited', price_band: '₹10 to ₹12' } },
    ];
    const c = compareResults(rows, { company_name: { type: 'string' }, price_band: { type: 'string' } });
    expect(c.pipelines).toEqual(['gemini', 'firecrawl']);
    const cn = c.fields.find((f) => f.key === 'company_name');
    const pb = c.fields.find((f) => f.key === 'price_band');
    expect(cn.agree).toBe(false);   // "Acme Ltd" vs "Acme Limited"
    expect(pb.agree).toBe(true);
    expect(c.fields[0].agree).toBe(false); // disagreements sorted first
  });
});
