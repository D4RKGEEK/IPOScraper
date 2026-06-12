/**
 * extract.ts — the v2 extraction ladder, markdown-first (PRD §3.2, §8 S4, §11.7).
 *
 *   local raw text (free) → local .md to Firecrawl /parse (cheap)
 *                         → raw text to DeepSeek (fractions of a cent)
 *                         → mini-PDF to Firecrawl /parse (expensive — table rescue)
 *                         → review floor. Never guess.
 */
import type * as mupdf from 'mupdf';
import type { Db } from 'mongodb';
import type { R2 } from './r2';
import { FIELDS, schemaFor, type DocType, type FieldDef } from './registry/fields';
import { validateField, type FieldPayload } from './validate';
import { miniPdf, rangeText, pagePng } from './pdf/mupdf-helpers';
import { sectionToMarkdown } from './pdf/to-markdown';

export interface ExtractionClients {
  parseMdJson: (md: string, name: string, schema: object) => Promise<Record<string, unknown>>;
  parsePdfBoth: (pdf: Buffer, name: string, schema: object) => Promise<Record<string, unknown>>;
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
}

const TABLE_CONFIDENCE_FLOOR = 0.7;

export async function extractSection(
  ctx: Ctx,
  section: string,
  range: { start: number; end: number },
): Promise<void> {
  const dynamicDoc = ctx.docType === 'ADDENDUM'; // extract only what's present (PRD §8 S2)
  const defs = FIELDS.filter(
    (f) => f.section === section && (dynamicDoc || f.expectedIn.includes(ctx.docType as 'DRHP' | 'RHP' | 'PROSPECTUS')),
  );
  if (!defs.length) return;

  // Step 0 — local representations (free). ±1 free widening on raw text.
  const sectionText = rangeText(ctx.pdfDoc, range.start - 1, range.end + 1);
  const { md, tableConfidence } = sectionToMarkdown(ctx.pdfDoc, range.start, range.end);
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

  // tableConfidence router (PRD §9, fallback #25): if local text mangles this
  // section's tables, don't pay for a doomed cheap call.
  const mdViable = tableConfidence >= TABLE_CONFIDENCE_FLOOR && !ctx.isScanned;

  // ── Layer 1: Firecrawl /parse on local .md (primary — cheap credits) ───────────
  if (mdViable) {
    const d1 = await ctx.clients.parseMdJson(md, section, schemaFor(defs)).catch((e) => {
      ctx.log(`L1 firecrawl_md failed for ${section}: ${String(e)}`);
      return null;
    });
    settle((d1 as Record<string, unknown> | null)?.json, 'firecrawl_md');
  }

  // ── Layer 2: DeepSeek on raw text (fallback 1) with failure feedback ────────────
  const open2 = defs.filter((d) => !results[d.key]);
  if (open2.length && !ctx.isScanned) {
    const widened = rangeText(ctx.pdfDoc, range.start - 3, range.end + 3); // widened ±3
    const feedback = open2.map((d) => ctx.fmtLastError(d.key)).filter(Boolean).join('\n');
    const d2 = await ctx.clients
      .deepseekJson(
        ctx.clients.extractSystem(JSON.stringify(schemaFor(open2))),
        `${feedback ? 'PREVIOUS FAILURES:\n' + feedback + '\n\n' : ''}DOCUMENT TEXT:\n${widened}`,
        ctx.onDeepseekTokens,
      )
      .catch((e) => {
        ctx.log(`L2 deepseek failed for ${section}: ${String(e)}`);
        return null;
      });
    settle(d2, 'deepseek_text', widened);
  }

  // ADDENDUM: fields the doc simply doesn't carry are not_expected, not failures.
  if (dynamicDoc) {
    for (const d of defs.filter((d) => !results[d.key])) {
      if (ctx.lastError(d.key) === 'value_null' || ctx.lastError(d.key) === null) {
        results[d.key] = { value: null, status: 'not_expected' };
      }
    }
  }

  // ── Layer 3: mini-PDF to Firecrawl (fallback 2 — expensive, surgical) ───────────
  const open3 = defs.filter((d) => !results[d.key]);
  if (open3.length) {
    const mini = miniPdf(ctx.pdfBuf, range.start, range.end);
    const d3 = await ctx.clients.parsePdfBoth(mini, section, schemaFor(open3)).catch((e) => {
      ctx.log(`L3 firecrawl_pdf failed for ${section}: ${String(e)}`);
      return null;
    });
    const d3md = typeof d3?.markdown === 'string' ? (d3.markdown as string) : '';
    if (d3 && 'json' in d3) {
      // Scanned docs: evidence checked against Firecrawl's own markdown (fallback #3).
      settle(d3.json, 'firecrawl_pdf', d3md + '\n' + sectionText);
    }
    // last automated shot: Firecrawl's own markdown → DeepSeek
    const open3b = defs.filter((d) => !results[d.key]);
    if (open3b.length && d3md.length > 100) {
      const d3b = await ctx.clients
        .deepseekJson(
          ctx.clients.extractSystem(JSON.stringify(schemaFor(open3b))),
          `DOCUMENT (markdown):\n${d3md}`,
          ctx.onDeepseekTokens,
        )
        .catch(() => null);
      settle(d3b, 'combined', d3md + '\n' + sectionText);
    }
  }

  // ── Layer 4: review floor — never guess ────────────────────────────────────
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

  for (const [k, v] of Object.entries(results)) await ctx.setField(k, v); // Mongo, atomic

  ctx.log(
    `section ${section}: ${Object.values(results).filter((r) => r.status === 'validated').length}/${defs.length} validated` +
      ` (tableConfidence ${tableConfidence.toFixed(2)}${mdViable ? '' : ' → md path skipped'})`,
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
