import { test, expect } from 'vitest';
import {
  normalizeCompanyName,
  normalizeSymbol,
  parseIndianDate,
  formatDateISO
} from '../utils/normalizers.js';

test('Normalizers normalization checks', () => {
  // Company name normalization
  expect(normalizeCompanyName('Apex Logistics Limited')).toBe('apex logistics');
  expect(normalizeCompanyName('Apex Logistics Ltd.')).toBe('apex logistics');
  expect(normalizeCompanyName('Apex IPO Details')).toBe('apex');
  expect(normalizeCompanyName('  Apex   Logistics  ')).toBe('apex logistics');
  expect(normalizeCompanyName('Apex Corp & Co!')).toBe('apex'); // "corp", "&", "co" all removed
  expect(normalizeCompanyName('')).toBe('');
  expect(normalizeCompanyName(null)).toBe('');

  // Symbol normalization
  expect(normalizeSymbol('RELIANCE-EQ')).toBe('RELIANCE');
  expect(normalizeSymbol('TATA-BE')).toBe('TATA');
  expect(normalizeSymbol('INFY.NS')).toBe('INFY');
  expect(normalizeSymbol('500180.BO')).toBe('500180');
  expect(normalizeSymbol('')).toBe('');
  expect(normalizeSymbol(null)).toBe('');

  // Date parsing and ISO formatting
  expect(formatDateISO(parseIndianDate('25-MAY-2026'))).toBe('2026-05-25');
  expect(formatDateISO(parseIndianDate('2026-05-25'))).toBe('2026-05-25');
  expect(formatDateISO(parseIndianDate('05 Jun 2026'))).toBe('2026-06-05');
  expect(parseIndianDate(null)).toBeNull();
  expect(parseIndianDate('invalid-date-string')).toBeNull();
});
