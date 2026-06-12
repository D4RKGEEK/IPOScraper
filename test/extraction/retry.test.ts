import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../../src/extraction/util/retry';

describe('withRetry (PRD §11.2)', () => {
  it('retries with backoff and eventually succeeds', async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      if (n < 2) throw new Error('boom');
      return 'ok';
    });
    await expect(withRetry(fn, 'test')).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  }, 15000);

  it('throws after exhausting tries', async () => {
    const fn = vi.fn(async () => {
      throw new Error('down');
    });
    await expect(withRetry(fn, 'test', 1)).rejects.toThrow(/failed after 1 attempts/);
    expect(fn).toHaveBeenCalledTimes(1);
  }, 15000);
});
