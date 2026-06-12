import { describe, it, expect } from 'vitest';
import { classifyText } from '../../src/extraction/classify';

describe('classifyText (PRD §8 S2)', () => {
  it('DRAFT RED HERRING → DRHP', () => {
    expect(classifyText('Draft Red Herring Prospectus dated March 1, 2026')).toBe('DRHP');
  });
  it('RED HERRING PROSPECTUS → RHP', () => {
    expect(classifyText('RED HERRING PROSPECTUS\nPlease read Section 32')).toBe('RHP');
  });
  it('PROSPECTUS without red herring → PROSPECTUS', () => {
    expect(classifyText('PROSPECTUS dated June 2026')).toBe('PROSPECTUS');
  });
  it('ADDENDUM wins even when it references the RHP it amends', () => {
    expect(classifyText('ADDENDUM TO THE RED HERRING PROSPECTUS')).toBe('ADDENDUM');
    expect(classifyText('Corrigendum to the Prospectus')).toBe('ADDENDUM');
  });
  it('unmatched → UNKNOWN', () => {
    expect(classifyText('Annual Report 2025-26')).toBe('UNKNOWN');
  });
});
