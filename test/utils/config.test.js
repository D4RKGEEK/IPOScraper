import { test, expect } from 'vitest';
import dotenv from 'dotenv';
dotenv.config();

test('dotenv loads environment variables correctly', () => {
  expect(process.env.UPSTOX_ACCESS_TOKEN).toBeDefined();
  expect(typeof process.env.UPSTOX_ACCESS_TOKEN).toBe('string');
  expect(process.env.UPSTOX_ACCESS_TOKEN.length).toBeGreaterThan(0);
});
