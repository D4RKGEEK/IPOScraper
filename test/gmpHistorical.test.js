import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { matchGmp } = require('../services/gmpService');
const { deriveHistorical } = require('../services/historicalService');
const { extractGmpId, igDateToIso } = require('../utils/gmpCrawler');

describe('InvestorGain parsing helpers', () => {
  it('extracts the IPO id from an InvestorGain href', () => {
    expect(extractGmpId('/gmp/horizon-reclaim-india-ipo/2199/')).toBe(2199);
    expect(extractGmpId('/ipo/foo/100')).toBe(100);
    expect(extractGmpId('')).toBe(null);
  });
  it('converts DD-MM-YYYY to ISO', () => {
    expect(igDateToIso('09-06-2026')).toBe('2026-06-09');
    expect(igDateToIso('garbage')).toBe(null);
  });
});

describe('matchGmp', () => {
  const list = [
    { companyName: 'Hexagon Nutrition Limited', gmp: 8, gmpPercent: 17.8, price: 45 },
    { companyName: 'Some Other Co', gmp: 3, price: 100 },
  ];
  it('matches on normalized name', () => {
    expect(matchGmp({ companyName: 'Hexagon Nutrition' }, list).gmp).toBe(8);
  });
  it('returns null when nothing is close enough', () => {
    expect(matchGmp({ companyName: 'Completely Unrelated Brand' }, list)).toBe(null);
  });
});

describe('deriveHistorical', () => {
  const candles = [
    { date: '2026-06-14', open: 60, high: 62, low: 59, close: 61 }, // latest
    { date: '2026-06-12', open: 48, high: 52, low: 46, close: 50 }, // listing day
    { date: '2026-06-13', open: 50, high: 55, low: 49, close: 54 },
  ];
  it('derives listing/current/day stats and listing gain from issue price', () => {
    const h = deriveHistorical(candles, 45); // issue price 45, listing open 48
    expect(h.listingPrice).toBe(48);
    expect(h.dayHigh).toBe(52);
    expect(h.dayLow).toBe(46);
    expect(h.currentPrice).toBe(61);
    expect(h.openingGain).toBeCloseTo(6.67, 1); // (48-45)/45*100
    expect(h.asOf).toBe('2026-06-14');
  });
  it('returns null without candles', () => {
    expect(deriveHistorical([], 45)).toBe(null);
  });
});
