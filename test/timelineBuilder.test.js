import { test, expect, describe } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const {
  buildTimeline,
  appendStatusHistory,
  applyTimeline,
  toIsoDate,
  TIMELINE_EVENTS,
} = require('../utils/timelineBuilder.js');

// ─── toIsoDate ────────────────────────────────────────────────────────────────

describe('toIsoDate', () => {
  test('passes through YYYY-MM-DD unchanged', () => {
    expect(toIsoDate('2026-06-05')).toBe('2026-06-05');
  });

  test('converts DD-Mon-YYYY format', () => {
    expect(toIsoDate('09-Jun-2026')).toBe('2026-06-09');
    expect(toIsoDate('05-Jun-2026')).toBe('2026-06-05');
    expect(toIsoDate('01-Jan-2026')).toBe('2026-01-01');
  });

  test('converts DD-MON-YYYY uppercase format', () => {
    expect(toIsoDate('21-MAY-2026')).toBe('2026-05-21');
    expect(toIsoDate('29-MAY-2026')).toBe('2026-05-29');
  });

  test('returns null for null, undefined, empty string', () => {
    expect(toIsoDate(null)).toBeNull();
    expect(toIsoDate(undefined)).toBeNull();
    expect(toIsoDate('')).toBeNull();
  });

  test('returns null for unparseable strings', () => {
    expect(toIsoDate('not-a-date')).toBeNull();
    expect(toIsoDate('32-Jan-2026')).toBeNull(); // day 32 — still parses structurally but passes through
  });
});

// ─── buildTimeline ────────────────────────────────────────────────────────────

describe('buildTimeline', () => {
  test('extracts all events from upstox timeline object', () => {
    const ipo = {
      raw_sources: {
        upstox: {
          bidding_start_date: '2026-06-05',
          bidding_end_date:   '2026-06-09',
          rhp_url: 'https://example.com/rhp.pdf',
          timeline: {
            application_start_date: '2026-06-05',
            application_end_date:   '2026-06-09',
            allotment_date:         '2026-06-11',
            listing_date:           '2026-06-12',
          },
        },
      },
      documentUrls: { rhp: 'https://example.com/rhp.pdf', drhp: null },
      biddingStartDate: '2026-06-05',
    };

    const tl = buildTimeline(ipo);
    expect(tl.open).toBe('2026-06-05');
    expect(tl.close).toBe('2026-06-09');
    expect(tl.allotment).toBe('2026-06-11');
    expect(tl.listing).toBe('2026-06-12');
    expect(tl.rhp_available).toBe('2026-06-05');
    expect(tl.drhp_available).toBeNull();
  });

  test('falls back to NSE dates when upstox timeline is absent', () => {
    const ipo = {
      raw_sources: {
        nse: {
          issueStartDate: '05-Jun-2026',
          issueEndDate:   '09-Jun-2026',
          listingDate:    '12-Jun-2026',
        },
      },
      documentUrls: {},
    };

    const tl = buildTimeline(ipo);
    expect(tl.open).toBe('2026-06-05');
    expect(tl.close).toBe('2026-06-09');
    expect(tl.listing).toBe('2026-06-12');
    expect(tl.allotment).toBeNull();
  });

  test('marks drhp_available when drhp_url present in documentUrls', () => {
    const ipo = {
      raw_sources: { upstox: { drhp_url: 'https://example.com/drhp.pdf' } },
      documentUrls: { drhp: 'https://example.com/drhp.pdf', rhp: null },
      biddingStartDate: '2026-06-05',
    };

    const tl = buildTimeline(ipo);
    expect(tl.drhp_available).toBe('2026-06-05');
    expect(tl.rhp_available).toBeNull();
  });

  test('marks drhp_available when drhp_url only in raw_sources.upstox', () => {
    const ipo = {
      raw_sources: { upstox: { drhp_url: 'https://example.com/drhp.pdf' } },
      documentUrls: { drhp: null, rhp: null },
      biddingStartDate: '2026-05-29',
    };

    const tl = buildTimeline(ipo);
    expect(tl.drhp_available).toBe('2026-05-29');
  });

  test('returns all nulls for empty record', () => {
    const tl = buildTimeline({ raw_sources: {}, documentUrls: {} });
    expect(tl.open).toBeNull();
    expect(tl.close).toBeNull();
    expect(tl.allotment).toBeNull();
    expect(tl.listing).toBeNull();
    expect(tl.drhp_available).toBeNull();
    expect(tl.rhp_available).toBeNull();
  });

  test('upstox timeline.application_start_date takes precedence over nse issueStartDate', () => {
    const ipo = {
      raw_sources: {
        upstox: { timeline: { application_start_date: '2026-06-05' } },
        nse:    { issueStartDate: '06-Jun-2026' },
      },
      documentUrls: {},
    };

    const tl = buildTimeline(ipo);
    expect(tl.open).toBe('2026-06-05');
  });

  test('handles missing raw_sources gracefully', () => {
    const tl = buildTimeline({ documentUrls: {} });
    expect(tl.open).toBeNull();
    expect(tl.listing).toBeNull();
  });
});

// ─── appendStatusHistory ──────────────────────────────────────────────────────

describe('appendStatusHistory', () => {
  const NOW = '2026-06-09T10:00:00.000Z';

  const baseIpo = {
    raw_sources: {
      upstox: {
        timeline: { application_start_date: '2026-06-05' },
      },
    },
    documentUrls: {},
  };

  test('appends all events from a fresh timeline to an empty history', () => {
    const timeline = {
      drhp_available: null,
      rhp_available:  '2026-06-04',
      open:           '2026-06-05',
      close:          '2026-06-09',
      allotment:      '2026-06-11',
      listing:        '2026-06-12',
    };

    const history = appendStatusHistory([], timeline, baseIpo, NOW);
    expect(history.length).toBe(5); // rhp_available + open + close + allotment + listing
    expect(history[0].status).toBe('rhp_available');
    expect(history[0].detectedAt).toBe(NOW);
  });

  test('does not duplicate events already in history', () => {
    const timeline = {
      drhp_available: null,
      rhp_available:  null,
      open:           '2026-06-05',
      close:          '2026-06-09',
      allotment:      null,
      listing:        null,
    };

    const existing = [
      { status: 'open', date: '2026-06-05', source: 'upstox', detectedAt: '2026-06-05T00:00:00Z' },
    ];

    const history = appendStatusHistory(existing, timeline, baseIpo, NOW);
    // Only 'close' should be new
    expect(history.length).toBe(2);
    expect(history[1].status).toBe('close');
    // Existing entry is unchanged
    expect(history[0].detectedAt).toBe('2026-06-05T00:00:00Z');
  });

  test('treats undefined existingHistory as empty array', () => {
    const timeline = { drhp_available: null, rhp_available: null, open: '2026-06-05', close: null, allotment: null, listing: null };
    const history = appendStatusHistory(undefined, timeline, baseIpo, NOW);
    expect(history.length).toBe(1);
    expect(history[0].status).toBe('open');
  });

  test('adds nothing when timeline has no dates', () => {
    const timeline = { drhp_available: null, rhp_available: null, open: null, close: null, allotment: null, listing: null };
    const history = appendStatusHistory([], timeline, baseIpo, NOW);
    expect(history.length).toBe(0);
  });

  test('records correct source for upstox-sourced open date', () => {
    const timeline = { drhp_available: null, rhp_available: null, open: '2026-06-05', close: null, allotment: null, listing: null };
    const history = appendStatusHistory([], timeline, baseIpo, NOW);
    expect(history[0].source).toBe('upstox');
  });

  test('records correct source for nse-sourced open date', () => {
    const nseIpo = {
      raw_sources: { nse: { issueStartDate: '05-Jun-2026' } },
      documentUrls: {},
    };
    const timeline = { drhp_available: null, rhp_available: null, open: '2026-06-05', close: null, allotment: null, listing: null };
    const history = appendStatusHistory([], timeline, nseIpo, NOW);
    expect(history[0].source).toBe('nse');
  });

  test('preserves order of TIMELINE_EVENTS in output', () => {
    const timeline = {
      drhp_available: '2026-01-01',
      rhp_available:  '2026-05-01',
      open:           '2026-06-05',
      close:          '2026-06-09',
      allotment:      '2026-06-11',
      listing:        '2026-06-12',
    };
    const history = appendStatusHistory([], timeline, baseIpo, NOW);
    const statuses = history.map(h => h.status);
    expect(statuses).toEqual(TIMELINE_EVENTS);
  });
});

// ─── applyTimeline ────────────────────────────────────────────────────────────

describe('applyTimeline', () => {
  const NOW = '2026-06-09T10:00:00.000Z';

  test('returns new object with timeline and statusHistory fields', () => {
    const ipo = {
      isin: 'INE1W0N01014',
      companyName: 'Genxai Analytics',
      status: 'open',
      raw_sources: {
        upstox: {
          bidding_start_date: '2026-06-05',
          bidding_end_date:   '2026-06-09',
          rhp_url: 'https://example.com/rhp.pdf',
          timeline: {
            application_start_date: '2026-06-05',
            application_end_date:   '2026-06-09',
            allotment_date:         '2026-06-11',
            listing_date:           '2026-06-12',
          },
        },
      },
      documentUrls: { rhp: 'https://example.com/rhp.pdf', drhp: null },
      biddingStartDate: '2026-06-05',
    };

    const result = applyTimeline(ipo, NOW);

    // Does not mutate original
    expect(ipo.timeline).toBeUndefined();
    expect(ipo.statusHistory).toBeUndefined();

    // Returns correct shape
    expect(result.isin).toBe('INE1W0N01014');
    expect(result.timeline.open).toBe('2026-06-05');
    expect(result.timeline.close).toBe('2026-06-09');
    expect(result.timeline.allotment).toBe('2026-06-11');
    expect(result.timeline.listing).toBe('2026-06-12');
    expect(result.timeline.rhp_available).toBe('2026-06-05');
    expect(Array.isArray(result.statusHistory)).toBe(true);
    expect(result.statusHistory.length).toBeGreaterThan(0);
  });

  test('preserves existing statusHistory and only appends new events', () => {
    const ipo = {
      isin: 'INE000',
      raw_sources: {
        upstox: { timeline: { application_start_date: '2026-06-05', listing_date: '2026-06-12' } },
      },
      documentUrls: {},
      statusHistory: [
        { status: 'open', date: '2026-06-05', source: 'upstox', detectedAt: '2026-06-05T00:00:00Z' },
      ],
    };

    const result = applyTimeline(ipo, NOW);
    // 'open' already recorded — should not be duplicated
    const openEntries = result.statusHistory.filter(h => h.status === 'open');
    expect(openEntries.length).toBe(1);
    // 'listing' is new — should be appended
    const listingEntries = result.statusHistory.filter(h => h.status === 'listing');
    expect(listingEntries.length).toBe(1);
    expect(listingEntries[0].detectedAt).toBe(NOW);
  });

  test('TIMELINE_EVENTS exports the correct ordered list', () => {
    expect(TIMELINE_EVENTS).toEqual([
      'drhp_available',
      'rhp_available',
      'open',
      'close',
      'allotment',
      'listing',
    ]);
  });
});
