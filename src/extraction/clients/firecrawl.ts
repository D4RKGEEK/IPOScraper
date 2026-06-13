/**
 * firecrawl.ts — structured extraction via /v2/parse (file upload, no hosting needed).
 *
 * TWO non-obvious requirements, both learned the hard way:
 *   1. The `formats` array MUST be wrapped in an `options` form field. Sent bare,
 *      /parse silently ignores it and returns ONLY markdown (no `json`).
 *   2. A `prompt` is required for Firecrawl to fill the evidence envelope faithfully
 *      (verbatim quote + page); without it you get values but no usable evidence.
 *
 * We always request `markdown` alongside `json` so the caller can verify the
 * verbatim-quote evidence against Firecrawl's own rendering of the page.
 */
import { CFG } from '../config';
import { withRetry } from '../util/retry';

/** Instruction that makes Firecrawl populate the evidence envelope correctly. */
export const EXTRACT_PROMPT =
  'Extract each field from this Indian IPO document (DRHP/RHP/Prospectus). For every field: ' +
  '"evidence" MUST be a short quote copied VERBATIM from the document text that contains the value; ' +
  '"page" MUST be the integer from the nearest "--- page N ---" marker above the evidence (use 1 if none is visible). ' +
  'If a field is not present, set its value to null — never guess. ' +
  'For numbers, strip currency symbols and thousands separators (e.g. "₹1,234.5 Cr" → 1234.5).';

export interface ParseResult {
  /** Parsed structured object (one evidence envelope per field), or null. */
  json: Record<string, unknown> | null;
  /** Firecrawl's own markdown of the page — an evidence haystack robust to table reformatting. */
  markdown: string;
}

async function firecrawlParse(file: Buffer, name: string, mime: string, formats: unknown[]): Promise<ParseResult> {
  return withRetry(async () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file)], { type: mime }), name);
    form.append('options', JSON.stringify({ formats })); // ← MUST be `options`, not bare `formats`
    const res = await fetch(`${CFG.firecrawl.base}/v2/parse`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CFG.firecrawl.apiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`firecrawl /parse ${res.status}: ${await res.text()}`);
    const d = (await res.json()) as { data?: { json?: unknown; markdown?: unknown } };
    const json = d?.data?.json;
    return {
      json: json && typeof json === 'object' ? (json as Record<string, unknown>) : null,
      markdown: typeof d?.data?.markdown === 'string' ? (d.data.markdown as string) : '',
    };
  }, `fc-parse-${name}`);
}

/** LAYER 1 (primary): locally-built clean HTML → structured json + markdown. */
export const parseHtmlJson = (html: string, name: string, schema: object): Promise<ParseResult> =>
  firecrawlParse(Buffer.from(html, 'utf8'), `${name}.html`, 'text/html', [
    { type: 'json', schema, prompt: EXTRACT_PROMPT },
    'markdown',
  ]);

/** LAYER 2 (table workhorse): mini-PDF → structured json + markdown (Firecrawl's native layout). */
export const parsePdfJson = (pdf: Buffer, name: string, schema: object): Promise<ParseResult> =>
  firecrawlParse(pdf, `${name}.pdf`, 'application/pdf', [
    { type: 'json', schema, prompt: EXTRACT_PROMPT },
    'markdown',
  ]);
