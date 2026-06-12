import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const {
  classifyDocFromUrl, parsePriceBand, parseDateRange, inferStatus,
  parseList, parseDetailProspectus, mapZerodhaRecord,
} = require('../utils/zerodha');

describe('classifyDocFromUrl', () => {
  it('follows the filename rule (drhp > final > rhp > default drhp)', () => {
    expect(classifyDocFromUrl('https://x/rhphorizon.pdf')).toBe('rhp');
    expect(classifyDocFromUrl('https://x/abc-drhp.pdf')).toBe('drhp');     // drhp before rhp
    expect(classifyDocFromUrl('https://x/company-final.pdf')).toBe('final');
    expect(classifyDocFromUrl('https://x/SUSAN_inprinciple.pdf')).toBe('drhp'); // nothing -> drhp
    expect(classifyDocFromUrl(null)).toBe(null);
  });
});

describe('parsePriceBand', () => {
  it('parses two-number and single-number bands', () => {
    expect(parsePriceBand('₹42 – ₹45')).toEqual({ minimum: 42, maximum: 45 });
    expect(parsePriceBand('₹110 ₹116')).toEqual({ minimum: 110, maximum: 116 });
    expect(parsePriceBand('₹1,053')).toEqual({ minimum: 1053, maximum: 1053 });
    expect(parsePriceBand('To be announced')).toEqual({ minimum: null, maximum: null });
  });
});

describe('parseDateRange', () => {
  it('applies the trailing month/year to both days', () => {
    expect(parseDateRange('05th – 09th Jun 2026')).toEqual({ start: '2026-06-05', end: '2026-06-09' });
  });
  it('handles a single date', () => {
    const r = parseDateRange('12 Jun 2026');
    expect(r.start).toBe('2026-06-12');
  });
  it('returns nulls for junk', () => {
    expect(parseDateRange('To be announced')).toEqual({ start: null, end: null });
  });
});

describe('inferStatus', () => {
  const now = new Date('2026-06-07T00:00:00Z');
  it('classifies by dates relative to now', () => {
    expect(inferStatus('2026-06-05', '2026-06-09', '2026-06-12', now)).toBe('open');
    expect(inferStatus('2026-06-10', '2026-06-12', '2026-06-17', now)).toBe('upcoming');
    expect(inferStatus('2026-05-01', '2026-05-05', '2026-05-08', now)).toBe('listed');
  });
});

describe('parseList', () => {
  const html = `
    <table><tr>
      <td class="ipo-logo"><a href="/ipo/447807/hexagon-nutrition"><img/></a></td>
      <td class="name"><a href="/ipo/447807/hexagon-nutrition">
        <span class="ipo-symbol">HEXAGON<span class="ipo-type">Mainboard</span></span>
        <span class="ipo-name text-12 text-grey">Hexagon Nutrition</span></a></td>
      <td class="date"><span class="hidden">2026-06-12</span>05th – 09th Jun 2026</td>
      <td class="date">12 Jun 2026</td>
      <td class="text-right">₹42 &ndash; ₹45</td>
    </tr></table>`;

  it('extracts symbol, type, name, dates, price, detail path', () => {
    const rows = parseList(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      symbol: 'HEXAGON', isSme: false, companyName: 'Hexagon Nutrition',
      detailPath: '/ipo/447807/hexagon-nutrition/', biddingRange: '05th – 09th Jun 2026',
      listingDateText: '12 Jun 2026',
    });
    expect(rows[0].priceText).toMatch(/42/);
  });
});

describe('parseDetailProspectus', () => {
  it('grabs the prospectus pdf, ignoring other pdfs', () => {
    const html = `
      <a href="https://x/grievance.pdf">Grievances Redressal Mechanism</a>
      <a href="https://gyr.com/rhphorizon.pdf" target="_blank">Download prospectus (PDF)</a>`;
    expect(parseDetailProspectus(html)).toBe('https://gyr.com/rhphorizon.pdf');
  });
});

describe('mapZerodhaRecord', () => {
  const row = { symbol: 'HORIZON', isSme: true, type: 'SME', companyName: 'Horizon Reclaim (India)', detailPath: '/ipo/449844/horizon-reclaim-india/', biddingRange: '12th – 16th Jun 2026', listingDateText: '19 Jun 2026', priceText: '₹98 – ₹103' };
  it('maps an rhp doc into documentUrls.rhp with raw provenance', () => {
    const r = mapZerodhaRecord(row, 'https://gyr.com/rhphorizon.pdf', new Date('2026-06-07'));
    expect(r.symbol).toBe('HORIZON');
    expect(r.priceBand).toEqual({ minimum: 98, maximum: 103 });
    expect(r.biddingStartDate).toBe('2026-06-12');
    expect(r.documentUrls.rhp).toContain('rhphorizon.pdf');
    expect(r.documentUrls.drhp).toBe(null);
    expect(r.isin).toBe(null);
    expect(r.raw_sources.zerodha.docType).toBe('rhp');
  });
  it('defaults an untyped filename to drhp', () => {
    const r = mapZerodhaRecord(row, 'https://bsesme.com/SUSAN_inprinciple.pdf');
    expect(r.documentUrls.drhp).toContain('SUSAN');
    expect(r.documentUrls.rhp).toBe(null);
  });
});
