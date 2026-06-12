import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { computeApplicationTable } = require('../utils/lotSizeCalculator');

function find(res, category, type) {
  return res.applications.find((a) => a.category === category && (type === undefined || a.type === type));
}

describe('AMIRCHAND mainboard (ground truth)', () => {
  const res = computeApplicationTable({ lotSize: 70, price: 212, marketType: 'mainboard' });

  it('reproduces every row of the published table exactly', () => {
    expect(find(res, 'Retail', 'Min')).toMatchObject({ lots: 1, shares: 70, amount: 14840 });
    expect(find(res, 'Retail', 'Max')).toMatchObject({ lots: 13, shares: 910, amount: 192920 });
    expect(find(res, 'S-HNI', 'Min')).toMatchObject({ lots: 14, shares: 980, amount: 207760 });
    expect(find(res, 'S-HNI', 'Max')).toMatchObject({ lots: 67, shares: 4690, amount: 994280 });
    expect(find(res, 'B-HNI', 'Min')).toMatchObject({ lots: 68, shares: 4760, amount: 1009120 });
  });

  it('exposes per-lot value with no warnings', () => {
    expect(res.perLot).toBe(14840);
    expect(res.warnings).toHaveLength(0);
  });
});

describe('mainboard pattern holds for other issues', () => {
  it('CLEANMAX (lot 14 × ₹1053) lands retail max 13, S-HNI max 67', () => {
    const res = computeApplicationTable({ lotSize: 14, price: 1053, marketType: 'mainboard' });
    expect(find(res, 'Retail', 'Max').lots).toBe(13);
    expect(find(res, 'S-HNI', 'Max').lots).toBe(67);
    expect(find(res, 'B-HNI', 'Min').lots).toBe(68);
  });
});

describe('SME rules (effective 1 Jul 2025)', () => {
  // GENXAI-like: lot 1200, cap ₹116 => perLot ₹139,200
  const res = computeApplicationTable({ lotSize: 1200, price: 116, marketType: 'sme' });

  it('Individual is exactly 2 lots (not 1, not a range)', () => {
    expect(find(res, 'Individual')).toMatchObject({ lots: 2, shares: 2400, amount: 278400 });
    expect(find(res, 'Retail')).toBeUndefined();
  });
  it('S-HNI starts at 3 lots, max = floor(₹10L / perLot)', () => {
    expect(find(res, 'S-HNI', 'Min').lots).toBe(3);
    expect(find(res, 'S-HNI', 'Max').lots).toBe(7); // floor(1000000/139200)=7
    expect(find(res, 'B-HNI', 'Min').lots).toBe(8);
  });
});

describe('SME collapse: very large lot value leaves no S-HNI band', () => {
  // lot 1200 × ₹300 => perLot ₹360,000; floor(₹10L/360000)=2 < 3 => no S-HNI
  const res = computeApplicationTable({ lotSize: 1200, price: 300, marketType: 'sme' });
  it('has Individual (2 lots) then jumps to B-HNI at 3 lots', () => {
    expect(find(res, 'Individual').lots).toBe(2);
    expect(find(res, 'S-HNI')).toBeUndefined();
    expect(find(res, 'B-HNI', 'Min').lots).toBe(3);
    expect(res.warnings.join(' ')).toMatch(/collapses into B-HNI/);
  });
});

describe('guards', () => {
  it('fails cleanly without lot or price', () => {
    expect(computeApplicationTable({ lotSize: 0, price: 100 }).ok).toBe(false);
    expect(computeApplicationTable({ lotSize: 70, price: 0 }).ok).toBe(false);
  });
});
