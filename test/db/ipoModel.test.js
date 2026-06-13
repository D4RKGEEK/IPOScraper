import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { slugify } = require('../../src/utils/slug.js');
const { toIpoDoc, issueType, subscription, documentsMap } = require('../../src/db/ipoModel.js');
const { diffFields, mergeDocuments } = require('../../src/db/ipoRepository.js');

describe('slugify', () => {
  it('builds company-name-ipo, stripping suffixes', () => {
    expect(slugify('Hexagon Nutrition Limited')).toBe('hexagon-nutrition-ipo');
    expect(slugify('Reliance Industries Ltd.')).toBe('reliance-industries-ipo');
    expect(slugify('Foo & Bar Pvt Ltd')).toBe('foo-and-bar-ipo');
  });
  it('adds a suffix on demand (collision handling)', () => {
    expect(slugify('Acme', { suffix: 'NSE123' })).toBe('acme-ipo-nse123');
  });
});

const sampleRecord = {
  isin: 'INE0JUI01012', symbol: 'HEXAGON', companyName: 'Hexagon Nutrition', status: 'open',
  biddingStartDate: '2026-06-05',
  priceBand: { minimum: 42, maximum: 45 },
  documentUrls: { rhp: 'https://x/rhp.pdf', drhp: null },
  raw_sources: {
    upstox: { lot_size: 333, issue_size: 1388700000, face_value: 1, issue_type: 'regular', industry: 'FMCG', rhp_url: 'https://x/rhp.pdf' },
    groww: { detail: {
      sector: 'Nutrition', issueSize: 1388700000, lotSize: 333, registrar: 'KARVY', endDate: '2026-06-09', listingDate: '2026-06-12T00:00:00',
      subscriptionRates: [
        { category: 'QIB', subscriptionRate: 19.77 },
        { category: 'NII', subscriptionRate: 160.35 },
        { category: 'RETAIL', subscriptionRate: 25.01 },
        { category: 'TOTAL', subscriptionRate: 52.52 },
      ],
      documentUrl: 'https://drive.google.com/file/d/abc/view',
    } },
  },
};

describe('issueType', () => {
  it('maps regular -> MAINBOARD, sme -> SME', () => {
    expect(issueType(sampleRecord)).toBe('MAINBOARD');
    expect(issueType({ raw_sources: { upstox: { issue_type: 'sme' } } })).toBe('SME');
    expect(issueType({ raw_sources: { groww: { detail: { isSme: true } } } })).toBe('SME');
  });
});

describe('subscription', () => {
  it('extracts retail/qualified/nii/total from Groww rates', () => {
    expect(subscription(sampleRecord)).toEqual({ retail: 25.01, qualified: 19.77, nii: 160.35, total: 52.52 });
  });
  it('returns null without rates', () => {
    expect(subscription({ raw_sources: {} })).toBe(null);
  });
});

describe('toIpoDoc', () => {
  const doc = toIpoDoc(sampleRecord, { now: '2026-06-09T10:00:00Z' });
  it('promotes enriched fields from raw sources', () => {
    expect(doc).toMatchObject({
      slug: 'hexagon-nutrition-ipo', isin: 'INE0JUI01012', symbol: 'HEXAGON',
      issueType: 'MAINBOARD', faceValue: 1, lotSize: 333, issueSize: 1388700000,
      sector: 'Nutrition', priceBand: { min: 42, max: 45 },
      biddingStart: '2026-06-05', biddingEnd: '2026-06-09',
    });
    expect(doc.minimumAmount).toBe(333 * 45);
    expect(doc.displayName).toBe('Hexagon Nutrition IPO');
  });
  it('builds documents map with provenance and keeps raw_sources', () => {
    expect(doc.documents.rhp.url).toContain('rhp.pdf');
    expect(doc.documents.drhp.url).toContain('drive.google.com');
    expect(Object.keys(doc.sources).sort()).toEqual(['groww', 'upstox']);
    expect(doc.raw_sources.upstox.lot_size).toBe(333);
  });
});

describe('mergeDocuments', () => {
  it('preserves processing fields when a re-scrape brings only {url, source}', () => {
    const existing = { rhp: { url: 'u', status: 'extracted', markdownUrl: 'md', pageHashes: ['a', 'b'] } };
    const incoming = { rhp: { url: 'u2', source: 'nse' } };
    const out = mergeDocuments(existing, incoming);
    expect(out.rhp.status).toBe('extracted');   // not wiped
    expect(out.rhp.markdownUrl).toBe('md');
    expect(out.rhp.pageHashes).toEqual(['a', 'b']);
    expect(out.rhp.url).toBe('u2');              // url updated
    expect(out.rhp.source).toBe('nse');
  });
});

describe('diffFields', () => {
  it('detects meaningful field changes, ignores timestamps', () => {
    const a = { status: 'upcoming', priceBand: { min: 1, max: 2 }, updatedAt: 'x' };
    const b = { status: 'open', priceBand: { min: 1, max: 2 }, updatedAt: 'y' };
    expect(diffFields(a, b)).toEqual(['status']);
  });
  it('returns empty when nothing watched changed', () => {
    expect(diffFields({ status: 'open' }, { status: 'open' })).toEqual([]);
  });
});
