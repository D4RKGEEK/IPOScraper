import { test, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const { buildInstrumentKey, formatDate, fetchDailyCandles } = require('../../src/scrapers/candleFetcher.js');

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── buildInstrumentKey ────────────────────────────────────────────────────────

test('buildInstrumentKey defaults to NSE_EQ', () => {
  expect(buildInstrumentKey('INE001A01036')).toBe('NSE_EQ|INE001A01036');
});

test('buildInstrumentKey respects explicit exchange', () => {
  expect(buildInstrumentKey('INE001A01036', 'BSE_EQ')).toBe('BSE_EQ|INE001A01036');
});

// ─── formatDate ────────────────────────────────────────────────────────────────

test('formatDate outputs YYYY-MM-DD', () => {
  expect(formatDate(new Date(2026, 5, 7))).toBe('2026-06-07'); // June is month 5 (0-indexed)
  expect(formatDate(new Date(2026, 0, 1))).toBe('2026-01-01');
});

// ─── fetchDailyCandles error guards ───────────────────────────────────────────

test('fetchDailyCandles throws if isin is missing', async () => {
  await expect(fetchDailyCandles(null, '2026-01-01', '2026-06-01', 'token'))
    .rejects.toThrow(/isin is required/i);
});

test('fetchDailyCandles throws if accessToken is missing', async () => {
  await expect(fetchDailyCandles('INE001A01036', '2026-01-01', '2026-06-01', null))
    .rejects.toThrow(/accessToken is required/i);
});

// ─── fetchDailyCandles mock ────────────────────────────────────────────────────

test('fetchDailyCandles maps Upstox candle array format correctly', async () => {
  // Mock axios to return a candle response without hitting the network
  const axios = require('axios');
  vi.spyOn(axios, 'get').mockResolvedValueOnce({
    data: {
      data: {
        candles: [
          ['2026-06-01T00:00:00+05:30', 100, 110, 95, 105, 1000, 0],
          ['2026-06-02T00:00:00+05:30', 105, 115, 100, 112, 2000, 0],
        ],
      },
    },
  });

  const candles = await fetchDailyCandles('INE001A01036', '2026-01-01', '2026-06-07', 'mock-token');

  expect(Array.isArray(candles)).toBe(true);
  expect(candles.length).toBe(2);
  expect(candles[0].date).toBe('2026-06-01');
  expect(candles[0].open).toBe(100);
  expect(candles[0].close).toBe(105);
  expect(candles[1].volume).toBe(2000);
});
