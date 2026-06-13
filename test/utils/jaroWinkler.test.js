import { test, expect } from 'vitest';
import { jaroWinkler } from '../../src/utils/jaroWinkler.js';

test('Jaro-Winkler similarity matching', () => {
  // Completely different names should have low similarity
  expect(jaroWinkler('Apex Logistics', 'Tata Motors')).toBeLessThan(0.70);
  
  // Names with minor spelling variations should have high similarity
  expect(jaroWinkler('Apex Logistics', 'Apex Logistix')).toBeGreaterThanOrEqual(0.90);
  
  // 'Apex Logistics' and 'Apex Diagnostics' are spelling-wise very similar (scores ~0.93)
  // This is why we need a date-range overlap guard to supplement Jaro-Winkler.
  expect(jaroWinkler('Apex Logistics', 'Apex Diagnostics')).toBeGreaterThanOrEqual(0.90);
  
  // Null/Empty check
  expect(jaroWinkler('', 'Apex')).toBe(0);
  expect(jaroWinkler(null, 'Apex')).toBe(0);
  expect(jaroWinkler('Apex', 'Apex')).toBe(1);
});
