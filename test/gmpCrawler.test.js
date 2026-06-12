import { test, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const { normalizeName, matchGmpToIpo } = require('../utils/gmpCrawler.js');

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── normalizeName ─────────────────────────────────────────────────────────────

test('normalizeName lowercases and strips suffixes', () => {
  expect(normalizeName('Apex Logistics Limited')).toBe('apex logistics');
  expect(normalizeName('Mock Company Ltd.')).toBe('mock company');
  expect(normalizeName('FooBar IPO')).toBe('foobar');
  expect(normalizeName('')).toBe('');
  expect(normalizeName(null)).toBe('');
});

test('normalizeName collapses whitespace', () => {
  expect(normalizeName('  Foo   Bar  ')).toBe('foo bar');
});

// ─── matchGmpToIpo ─────────────────────────────────────────────────────────────

test('matchGmpToIpo matches by exact normalized name', () => {
  const ipoList = [
    { companyName: 'Apex Logistics Limited', isin: 'INE001A01036' },
    { companyName: 'Unrelated Corp', isin: 'INE999Z01010' },
  ];

  const gmpEntry = { companyName: 'Apex Logistics' };
  const match = matchGmpToIpo(gmpEntry, ipoList);

  // 'apex logistics' is substring of 'apex logistics' (normalized from 'Apex Logistics Limited')
  expect(match).not.toBeNull();
  expect(match.isin).toBe('INE001A01036');
});

test('matchGmpToIpo returns null when no match found', () => {
  const ipoList = [
    { companyName: 'Apex Logistics Limited', isin: 'INE001A01036' },
  ];

  const gmpEntry = { companyName: 'Completely Unrelated Company XYZ' };
  const match = matchGmpToIpo(gmpEntry, ipoList);
  expect(match).toBeNull();
});

test('matchGmpToIpo returns null when gmpEntry has no companyName', () => {
  const ipoList = [{ companyName: 'Apex Logistics', isin: 'INE001A01036' }];
  expect(matchGmpToIpo({}, ipoList)).toBeNull();
  expect(matchGmpToIpo({ companyName: null }, ipoList)).toBeNull();
});
