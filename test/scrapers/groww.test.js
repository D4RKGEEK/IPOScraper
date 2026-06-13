import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { mapGrowwRecord, mapStatus, priceBandOf, toIsoDate } = require('../../src/scrapers/groww.js');

describe('toIsoDate', () => {
  it('converts epoch ms to YYYY-MM-DD', () => {
    expect(toIsoDate(1780633800000)).toBe('2026-06-05');
  });
  it('returns null for bad input', () => {
    expect(toIsoDate(null)).toBe(null);
    expect(toIsoDate('x')).toBe(null);
  });
});

describe('mapStatus', () => {
  it('falls back to the feed bucket', () => {
    expect(mapStatus('open', {})).toBe('open');
    expect(mapStatus('closed', null)).toBe('closed');
  });
  it('maps Groww status strings', () => {
    expect(mapStatus('closed', { status: 'ACTIVE' })).toBe('open');
    expect(mapStatus('open', { status: 'UPCOMING' })).toBe('upcoming');
    expect(mapStatus('open', { status: 'LISTED' })).toBe('listed');
  });
  it('treats a listed price as listed', () => {
    expect(mapStatus('closed', { status: 'LISTED', listing: { listingPrice: 120 } })).toBe('listed');
  });
});

describe('priceBandOf', () => {
  it('prefers detail price', () => {
    expect(priceBandOf({ categories: [{ minPrice: 1, maxPrice: 2 }] }, { minPrice: 42, maxPrice: 45 }))
      .toEqual({ minimum: 42, maximum: 45 });
  });
  it('falls back to the first list category', () => {
    expect(priceBandOf({ categories: [{ minPrice: 42, maxPrice: 45 }] }, null))
      .toEqual({ minimum: 42, maximum: 45 });
  });
  it('returns nulls when unknown', () => {
    expect(priceBandOf({}, {})).toEqual({ minimum: null, maximum: null });
  });
});

describe('mapGrowwRecord', () => {
  const listItem = { symbol: 'HEXAGON', isin: 'INE0JUI01012', companyName: 'Hexagon Nutrition', searchId: 'hexagon-nutrition-ipo', bidStartTimestamp: 1780633800000, categories: [{ minPrice: 42, maxPrice: 45 }] };

  it('maps an open IPO with detail; doc treated as RHP', () => {
    const detail = { status: 'ACTIVE', minPrice: 42, maxPrice: 45, startDate: '2026-06-05', companyShortName: 'Hexagon Nutrition', documentUrl: 'https://drive.google.com/file/d/abc/view', subscriptionRates: [], financials: [] };
    const r = mapGrowwRecord(listItem, detail, 'open');
    expect(r).toMatchObject({
      isin: 'INE0JUI01012', symbol: 'HEXAGON', status: 'open',
      biddingStartDate: '2026-06-05',
      priceBand: { minimum: 42, maximum: 45 },
    });
    expect(r.documentUrls.rhp).toContain('drive.google.com');
    expect(r.documentUrls.drhp).toBe(null);
    expect(r.raw_sources.groww.searchId).toBe('hexagon-nutrition-ipo');
  });

  it('classifies an upcoming SEBI filing as DRHP', () => {
    const detail = { status: 'UPCOMING', documentUrl: 'https://www.sebi.gov.in/filings/public-issues/mar-2026/truhome.pdf' };
    const r = mapGrowwRecord({ symbol: 'TEMPTRU', searchId: 'truhome-finance-ipo' }, detail, 'upcoming');
    expect(r.status).toBe('upcoming');
    expect(r.documentUrls.drhp).toContain('sebi.gov.in');
    expect(r.documentUrls.rhp).toBe(null);
  });

  it('works from list item alone (no detail)', () => {
    const r = mapGrowwRecord(listItem, null, 'open');
    expect(r.symbol).toBe('HEXAGON');
    expect(r.biddingStartDate).toBe('2026-06-05'); // from bidStartTimestamp
    expect(r.priceBand).toEqual({ minimum: 42, maximum: 45 });
    expect(r.raw_sources.groww.detail).toBe(null);
  });
});
