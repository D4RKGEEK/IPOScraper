import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { normTitle, tokenSortRatio, loadAliases } from '../../src/extraction/locate';

describe('locator fuzzy matching (PRD §8 S3)', () => {
  it('normTitle strips punctuation and collapses whitespace', () => {
    expect(normTitle('  Objects of  the Offer!! ')).toBe('OBJECTS OF THE OFFER');
  });

  it('token-sort similarity is order-insensitive', () => {
    expect(tokenSortRatio('STRUCTURE CAPITAL', 'CAPITAL STRUCTURE')).toBe(1);
  });

  it('close SEBI variants score high; unrelated titles score low', () => {
    const close = tokenSortRatio('BASIS FOR OFFER PRICE', 'BASIS FOR ISSUE PRICE');
    expect(close).toBeGreaterThan(0.7);
    const far = tokenSortRatio('RISK FACTORS', 'CAPITAL STRUCTURE');
    expect(far).toBeLessThan(0.82);
  });

  it('loadAliases parses the seed dictionary', () => {
    const aliases = loadAliases(path.join(process.cwd(), 'src', 'extraction', 'aliases.yaml'));
    expect(aliases.offer_structure).toContain('ISSUE STRUCTURE');
    expect(aliases.capital_structure).toContain('CAPITAL STRUCTURE');
  });
});
