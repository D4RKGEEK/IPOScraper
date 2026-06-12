/**
 * retry.ts — wraps EVERY network call (PRD §11.2): 3 tries, 90s timeout,
 * exponential backoff + jitter.
 */
export async function withRetry<T>(fn: () => Promise<T>, label: string, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await withTimeout(fn(), 90_000, label);
    } catch (e) {
      last = e;
      const wait = 1000 * 2 ** i + Math.random() * 500; // expo backoff + jitter
      console.warn(`[retry] ${label} attempt ${i + 1} failed: ${String(e)} — waiting ${Math.round(wait)}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error(`[${label}] failed after ${tries} attempts: ${String(last)}`);
}

export const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, rej) => {
      const t = setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms);
      // Don't hold the event loop open just for the timeout.
      (t as unknown as { unref?: () => void }).unref?.();
    }),
  ]);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
