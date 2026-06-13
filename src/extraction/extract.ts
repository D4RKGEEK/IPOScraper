/**
 * extract.ts — the v2 extraction ladder, FIRECRAWL-first (PRD §3.2, §8 S4, §11.7).
 *
 *   local clean HTML to Firecrawl /parse (cheap credits)
 *                       → mini-PDF to Firecrawl /parse (real layout — table workhorse)
 *                       → raw text to DeepSeek (OFF by default — CFG.extract.useDeepseek)
 *                       → review floor. Never guess.
 *
 * DeepSeek costs real money; Firecrawl credits don't. The ladder therefore exhausts
 * both Firecrawl paths before it will even consider DeepSeek, and DeepSeek only runs
 * at all when EXTRACT_USE_DEEPSEEK=true.
 */
import type * as mupdf from 'mupdf';
import type { Db } from 'mongodb';
import type { R2 } from './r2';
import { FIELDS, schemaFor, type DocType, type FieldDef } from './registry/fields';
import { validateField, type FieldPayload } from './validate';
import { miniPdf, rangeText, pagePng } from './pdf/mupdf-helpers';
import { sectionToHtml } from './pdf/to-markdown';
import type { ParseResult } from './clients/firecrawl';

export interface ExtractionClients {
  parseHtmlJson: (html: string, name: string, schema: object) => Promise<ParseResult>;
  parsePdfJson: (pdf: Buffer, name: string, schema: object) => Promise<ParseResult>;
  deepseekJson: (system: string, user: string, onTokens?: (t: number) => void) => Promise<unknown>;
  extractSystem: (schemaText: string) => string;
}

export interface Ctx {
  hash: string;
  docType: DocType;
  isScanned: boolean;
  pdfBuf: Buffer;
  pdfDoc: mupdf.Document;
  db: Db;
  r2: R2;
  clients: ExtractionClients;
  log: (msg: string) => unknown;
  /** Persist one field's final state to Mongo (atomic; recomputes progress). */
  setField: (key: string, patch: Record<string, unknown>) => Promise<void>;
  /** Validated values so far (for cross-field business rules). */
  fieldValues: () => Record<string, unknown>;
  recordFailure: (key: string, layer: string, reason: string, value: unknown) => void;
  fmtLastError: (key: string) => string | null;
  lastError: (key: string) => string | null;
  lastGuess: (key: string) => unknown;
  allLayerValues: (key: string) => Record<string, unknown>;
  bumpCost: (layer: 'firecrawl_md' | 'firecrawl_pdf' | 'deepseek_text' | 'combined') => void;
  onDeepseekTokens: (tokens: number) => void;
  /** Field-extraction ladder may fall through to DeepSeek (CFG.extract.useDeepseek). */
  useDeepseek: boolean;
}

const TABLE_CONFIDENCE_FLOOR = 0.7;

export interface ExtractOpts {
  /** Restrict this pass to these field keys (e.g. the still-open set). */
  only?: string[];
  /**
   * Final pass (default true) runs the review floor + high-stakes disagreement
   * check and writes needs_review/not_expected. An opportunistic pass (false —
   * e.g. the cover/front-matter sweep) only persists what it validates and leaves
   * everything else untouched for a later pass over the located range.
   */
  finalPass?: boolean;
}

export async function extractSection(
  ctx: Ctx,
  section: string,
  range: { start: number; end: number },
  opts: ExtractOpts = {},
): Promise<void> {
  const finalPass = opts.finalPass !== false;
  const dynamicDoc = ctx.docType === 'ADDENDUM'; // extract only what's present (PRD §8 S2)
  let defs = FIELDS.filter(
    (f) => f.section === section && (dynamicDoc || f.expectedIn.includes(ctx.docType as 'DRHP' | 'RHP' | 'PROSPECTUS')),
  );
  if (opts.only) defs = defs.filter((d) => opts.only!.includes(d.key));
  if (!defs.length) return;

  // Step 0 — local representations (free). ±1 free widening on raw text.
  const sectionText = rangeText(ctx.pdfDoc, range.start - 1, range.end + 1);
  const { html, tableConfidence } = sectionToHtml(ctx.pdfDoc, range.start, range.end);
  const results: Record<string, Record<string, unknown>> = {};

  const settle = (cand: unknown, layer: string, evidenceAgainst = sectionText): void => {
    if (!cand || typeof cand !== 'object') return;
    const obj = cand as Record<string, FieldPayload | undefined>;
    for (const d of defs) {
      if (results[d.key]) continue;
      const payload = obj[d.key];
      const v = validateField(d.key, payload, evidenceAgainst, ctx.fieldValues());
      if (v.ok && payload) {
        results[d.key] = { ...payload, status: 'validated', layer };
        ctx.bumpCost(layer as 'firecrawl_md');
      } else {
        ctx.recordFailure(d.key, layer, v.ok ? 'unknown' : v.reason, payload?.value);
      }
    }
  };

  // ── Layer 1: Firecrawl /parse on local clean HTML (primary — cheap credits) ─────
  // tableConfidence router (PRD §9): if local table detection was inconsistent the
  // emitted HTML tables will be malformed too — skip straight to the real-layout
  // mini-PDF instead of paying for a doomed cheap call.
  const htmlViable = tableConfidence >= TABLE_CONFIDENCE_FLOOR && !ctx.isScanned;
  if (htmlViable) {
    const res1 = await ctx.clients.parseHtmlJson(html, section, schemaFor(defs)).catch((e: unknown) => {
      ctx.log(`L1 firecrawl_html failed for ${section}: ${String(e)}`);
      return { json: null, markdown: '' } as ParseResult;
    });
    if (res1.json) settle(res1.json, 'firecrawl_md', res1.markdown + '\n' + sectionText);
  }

  // ── Layer 2: mini-PDF to Firecrawl /parse (real PDF layout — the table workhorse) ─
  const open2 = defs.filter((d) => !results[d.key]);
  if (open2.length) {
    const mini = miniPdf(ctx.pdfBuf, range.start, range.end);
    const res2 = await ctx.clients.parsePdfJson(mini, section, schemaFor(open2)).catch((e: unknown) => {
      ctx.log(`L2 firecrawl_pdf failed for ${section}: ${String(e)}`);
      return { json: null, markdown: '' } as ParseResult;
    });
    if (res2.json) {
      // mini-PDF pages renumber from 1; map them back to original doc pages.
      for (const v of Object.values(res2.json)) {
        const pv = v as { page?: unknown };
        if (typeof pv.page === 'number') pv.page = pv.page + range.start;
      }
      // evidence checked against Firecrawl's own markdown (+ raw text fallback).
      settle(res2.json, 'firecrawl_pdf', res2.markdown + '\n' + sectionText);
    }
  }

  // ── Layer 3: DeepSeek — last resort, OFF by default (CFG.extract.useDeepseek) ────
  if (ctx.useDeepseek && !ctx.isScanned) {
    const open3 = defs.filter((d) => !results[d.key]);
    if (open3.length) {
      const widened = rangeText(ctx.pdfDoc, range.start - 3, range.end + 3); // widened ±3
      const feedback = open3.map((d) => ctx.fmtLastError(d.key)).filter(Boolean).join('\n');
      const d3 = await ctx.clients
        .deepseekJson(
          ctx.clients.extractSystem(JSON.stringify(schemaFor(open3))),
          `${feedback ? 'PREVIOUS FAILURES:\n' + feedback + '\n\n' : ''}DOCUMENT TEXT:\n${widened}`,
          ctx.onDeepseekTokens,
        )
        .catch((e: unknown) => {
          ctx.log(`L3 deepseek failed for ${section}: ${String(e)}`);
          return null;
        });
      settle(d3, 'deepseek_text', widened);
    }
  }

  // ADDENDUM: fields the doc simply doesn't carry are not_expected, not failures.
  if (dynamicDoc && finalPass) {
    for (const d of defs.filter((d) => !results[d.key])) {
      if (ctx.lastError(d.key) === 'value_null' || ctx.lastError(d.key) === null) {
        results[d.key] = { value: null, status: 'not_expected' };
      }
    }
  }

  if (finalPass) {
    // ── Layer 4: review floor — never guess ──────────────────────────────────
    for (const d of defs.filter((d) => !results[d.key])) {
      await queueReview(ctx, d, range, ctx.lastError(d.key) ?? 'ladder_exhausted');
      results[d.key] = { value: null, status: 'needs_review' };
    }
    // High-stakes disagreement check — straight to review, no silent tiebreak.
    for (const d of defs.filter((d) => d.highStakes)) {
      const vals = Object.values(ctx.allLayerValues(d.key)).filter((v) => v !== null && v !== undefined);
      if (vals.length > 1 && new Set(vals.map((v) => JSON.stringify(v))).size > 1) {
        await queueReview(ctx, d, range, 'source_disagreement');
        results[d.key] = { value: null, status: 'needs_review', reason: 'source_disagreement' };
      }
    }
  }

  for (const [k, v] of Object.entries(results)) await ctx.setField(k, v); // Mongo, atomic

  ctx.log(
    `section ${section}${finalPass ? '' : ' (front-matter)'}: ` +
      `${Object.values(results).filter((r) => r.status === 'validated').length}/${defs.length} validated` +
      ` (tableConfidence ${tableConfidence.toFixed(2)}${htmlViable ? '' : ' → html path skipped'})`,
  );
}

async function queueReview(
  ctx: Ctx,
  d: FieldDef,
  range: { start: number; end: number },
  lastError: string,
): Promise<void> {
  const imageKey = `review/${ctx.hash}/${d.key}.png`;
  try {
    const png = pagePng(ctx.pdfBuf, range.start);
    await ctx.r2.put(imageKey, png, 'image/png');
  } catch (e) {
    // R2 down (fallback #28): degrade to page-number-only review entries.
    ctx.log(`review PNG upload failed for ${d.key}: ${String(e)}`);
  }
  await ctx.db.collection('review_queue').updateOne(
    { docHash: ctx.hash, field: d.key, status: 'open' },
    {
      $set: {
        docHash: ctx.hash,
        field: d.key,
        pages: [range.start + 1, range.end + 1],
        bestGuess: ctx.lastGuess(d.key) ?? null,
        lastError,
        candidates: ctx.allLayerValues(d.key),
        imageKey,
        status: 'open',
        resolvedValue: null,
        resolvedBy: null,
        resolvedAt: null,
      },
    },
    { upsert: true },
  );
}
