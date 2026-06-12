/**
 * firecrawl.ts — §11.4. `.md` files are the PRIMARY (cheap) path; mini-PDF is the
 * expensive table-rescue fallback. Response parsing is deliberately tolerant.
 */
import { CFG } from '../config';
import { withRetry } from '../util/retry';

async function firecrawlParseFile(
  file: Buffer,
  name: string,
  mime: string,
  formats: unknown[],
): Promise<Record<string, unknown>> {
  return withRetry(async () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file)], { type: mime }), name);
    form.append('formats', JSON.stringify(formats));
    const res = await fetch(`${CFG.firecrawl.base}/v2/parse`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CFG.firecrawl.apiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`firecrawl /parse ${res.status}: ${await res.text()}`);
    const d = (await res.json()) as Record<string, unknown>;
    return (d?.data as Record<string, unknown>) ?? d; // tolerate response-shape drift
  }, `fc-parse-${name}`);
}

/** LAYER 1 (primary, cheap): locally-generated markdown + JSON schema. */
export const parseMdJson = (md: string, name: string, schema: object) =>
  firecrawlParseFile(Buffer.from(md, 'utf8'), `${name}.md`, 'text/markdown', [{ type: 'json', schema }]);

/** LAYER 3 (fallback, expensive): mini-PDF — one metered parse, two outputs. */
export const parsePdfBoth = (pdf: Buffer, name: string, schema: object) =>
  firecrawlParseFile(pdf, `${name}.pdf`, 'application/pdf', ['markdown', { type: 'json', schema }]);

/** HTML sources (e.g. BSE anchor circular pages) via /scrape with the same json format. */
export async function scrapeJson(url: string, schema: object): Promise<unknown> {
  return withRetry(async () => {
    const res = await fetch(`${CFG.firecrawl.base}/v2/scrape`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CFG.firecrawl.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: [{ type: 'json', schema }] }),
    });
    if (!res.ok) throw new Error(`firecrawl /scrape ${res.status}`);
    const d = (await res.json()) as { data?: { json?: unknown } };
    return d?.data?.json ?? null;
  }, 'fc-scrape');
}
