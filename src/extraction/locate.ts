/**
 * locate.ts — the locator cascade (PRD §8 S3).
 * Output: a VERIFIED section → page-range map. Each layer runs only if the
 * previous left sections unresolved. An unverified location never feeds the
 * extractor (L-E is mandatory).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type * as mupdf from 'mupdf';
import { outline, pageStructured, pageText, rangeText } from './pdf/mupdf-helpers';

export interface SectionRange {
  start: number; // 0-based PDF index
  end: number;   // 0-based PDF index, inclusive
  method: 'bookmarks' | 'printed_toc' | 'heading_scan' | 'deepseek';
  confidence: number;
}
export type LocatedMap = Record<string, SectionRange>;

const FUZZY_THRESHOLD = 0.82;
const MAX_SECTION_PAGES = 20;

/** Anchor keyword groups per section (L-E): every group must match (any alternative). */
export const SECTION_KEYWORDS: Record<string, string[][]> = {
  capital_structure: [['PROMOTER'], ['EQUITY SHARES']],
  offer_structure: [['EQUITY SHARES'], ['OFFER', 'ISSUE']],
  basis_for_price: [['BASIS'], ['PRICE']],
  objects: [['OBJECTS'], ['OFFER', 'ISSUE']],
  promoters: [['PROMOTER']],
  financials: [['FINANCIAL']],
  general_info: [['REGISTRAR']],
};

export function loadAliases(file = path.join(__dirname, 'aliases.yaml')): Record<string, string[]> {
  return yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, string[]>;
}

// ── fuzzy title matching: normalized token-sort similarity ──────────────────
export const normTitle = (s: string) =>
  s.toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

const tokenSort = (s: string) => normTitle(s).split(' ').sort().join(' ');

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i, ...new Array<number>(n).fill(0)];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n] as number;
}

export function tokenSortRatio(a: string, b: string): number {
  const x = tokenSort(a);
  const y = tokenSort(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

function matchSection(
  title: string,
  aliases: Record<string, string[]>,
): { section: string; score: number } | null {
  let best: { section: string; score: number } | null = null;
  for (const [section, names] of Object.entries(aliases)) {
    for (const alias of names) {
      const score = tokenSortRatio(title, alias);
      if (!best || score > best.score) best = { section, score };
    }
  }
  return best;
}

// ── L-E verification (mandatory, free) ─────────────────────────────────────
export function verifySection(doc: mupdf.Document, section: string, start: number, end: number): boolean {
  const groups = SECTION_KEYWORDS[section];
  if (!groups) return true;
  const text = rangeText(doc, start - 2, end + 2).toUpperCase(); // ±2 pages: content spills
  return groups.every((alts) => alts.some((kw) => text.includes(kw)));
}

// ── the cascade ────────────────────────────────────────────────────────────
interface Start { page: number; method: SectionRange['method']; confidence: number }

export interface LocateOpts {
  deepseek?: (system: string, user: string) => Promise<unknown>;
  log?: (msg: string) => unknown;
  /** L-D rescues log a suggested alias line (PRD §8). */
  onAliasSuggestion?: (section: string, title: string) => unknown;
  aliasesFile?: string;
}

export async function locateSections(
  doc: mupdf.Document,
  opts: LocateOpts = {},
): Promise<{ map: LocatedMap; unresolved: string[] }> {
  const log = opts.log ?? (() => {});
  const aliases = loadAliases(opts.aliasesFile);
  const sections = Object.keys(aliases);
  const pageCount = doc.countPages();
  const starts: Record<string, Start> = {};

  const unresolvedNow = () => sections.filter((s) => !starts[s]);

  /** Build ranges from current starts, run L-E, drop failures. */
  const verifyAll = () => {
    const map = buildRanges(starts, pageCount);
    for (const [section, range] of Object.entries(map)) {
      if (!verifySection(doc, section, range.start, range.end)) {
        log(`locate: verification failed for ${section} (${range.method} p${range.start + 1}-${range.end + 1}) — dropping`);
        delete starts[section];
      }
    }
  };

  // ── L-A: embedded bookmarks (free, instant) ──────────────────────────────
  for (const { title, page } of outline(doc)) {
    const m = matchSection(title, aliases);
    if (m && m.score >= FUZZY_THRESHOLD) {
      const cur = starts[m.section];
      if (!cur || m.score > cur.confidence) {
        starts[m.section] = { page, method: 'bookmarks', confidence: m.score };
      }
    }
  }
  if (Object.keys(starts).length) {
    log(`locate L-A: bookmarks resolved ${Object.keys(starts).length}/${sections.length}`);
    verifyAll();
  }

  // ── L-B: printed ToC page with offset correction ───────────────────────────
  let tocRaw = '';
  if (unresolvedNow().length) {
    const entries: Array<{ title: string; printed: number }> = [];
    for (let p = 0; p < Math.min(8, pageCount); p++) {
      const text = pageText(doc, p);
      const matches = [...text.matchAll(/^(.{4,80}?)\.{3,}\s*(\d{1,3})\s*$/gm)];
      if (matches.length >= 5) {
        tocRaw = text;
        for (const m of matches) entries.push({ title: (m[1] as string).trim(), printed: parseInt(m[2] as string, 10) });
        break;
      }
    }
    if (entries.length >= 5) {
      // Offset correction: anchor the most distinctive matched entry.
      const scored = entries
        .map((e) => ({ ...e, m: matchSection(e.title, aliases) }))
        .filter((e) => e.m && e.m.score >= FUZZY_THRESHOLD)
        .sort((a, b) => (b.m as { score: number }).score - (a.m as { score: number }).score
          || b.title.length - a.title.length);
      let offset: number | null = null;
      for (const anchor of scored.slice(0, 3)) {
        const idx = findHeadingPage(doc, anchor.title, anchor.printed);
        if (idx !== null) { offset = idx - anchor.printed; break; } // one anchor fixes the whole map
      }
      if (offset !== null) {
        for (const e of scored) {
          const section = (e.m as { section: string }).section;
          if (starts[section]) continue;
          const page = e.printed + offset;
          if (page >= 0 && page < pageCount) {
            starts[section] = { page, method: 'printed_toc', confidence: (e.m as { score: number }).score };
          }
        }
        log(`locate L-B: printed ToC (offset ${offset}) — resolved ${Object.keys(starts).length}/${sections.length}`);
        verifyAll();
      } else {
        log('locate L-B: ToC found but no offset anchor — discarding ToC result');
      }
    }
  }

  // ── L-C: font-heuristic heading scan ──────────────────────────────────────
  let headingCandidates: Array<{ page: number; title: string }> = [];
  if (unresolvedNow().length) {
    headingCandidates = scanHeadings(doc);
    for (const cand of headingCandidates) {
      const m = matchSection(cand.title, aliases);
      if (m && m.score >= FUZZY_THRESHOLD && !starts[m.section]) {
        starts[m.section] = { page: cand.page, method: 'heading_scan', confidence: m.score };
      }
    }
    log(`locate L-C: heading scan — resolved ${Object.keys(starts).length}/${sections.length}`);
    verifyAll();
  }

  // ── L-D: DeepSeek locator (fires on maybe 1 doc in 10) ───────────────────────
  const remaining = unresolvedNow();
  if (remaining.length && opts.deepseek) {
    const source = tocRaw
      ? `TABLE OF CONTENTS TEXT:\n${tocRaw.slice(0, 6000)}`
      : `HEADING CANDIDATES (pdf page → heading):\n${headingCandidates
          .map((h) => `${h.page + 1}: ${h.title}`)
          .join('\n')
          .slice(0, 6000)}`;
    try {
      const res = (await opts.deepseek(
        'You map canonical IPO document sections to their starting page numbers. Return strict JSON only: an object whose keys are the given canonical section ids and whose values are the 1-based PDF page number where the section starts, or null if absent. No prose.',
        `CANONICAL SECTIONS: ${remaining.join(', ')}\n\n${source}`,
      )) as Record<string, unknown>;
      for (const section of remaining) {
        const v = res?.[section];
        if (typeof v === 'number' && v >= 1 && v <= pageCount) {
          starts[section] = { page: Math.round(v) - 1, method: 'deepseek', confidence: 0.7 };
          opts.onAliasSuggestion?.(section, `page ${v}`);
        }
      }
      log(`locate L-D: deepseek — resolved ${Object.keys(starts).length}/${sections.length}`);
      verifyAll();
    } catch (e) {
      log(`locate L-D failed: ${String(e)}`);
    }
  }

  const map = buildRanges(starts, pageCount);
  const unresolved = sections.filter((s) => !map[s]);
  return { map, unresolved };
}

/** Find the PDF page whose first ~300 chars contain `title` as a heading. */
function findHeadingPage(doc: mupdf.Document, title: string, printedHint: number): number | null {
  const want = normTitle(title);
  const pageCount = doc.countPages();
  // Search around the printed hint first (covers small offsets), then whole doc.
  const order: number[] = [];
  for (let d = 0; d <= 40; d++) {
    for (const idx of [printedHint - 1 + d, printedHint - 1 - d]) {
      if (idx >= 0 && idx < pageCount && !order.includes(idx)) order.push(idx);
    }
  }
  for (const idx of order) {
    const head = normTitle(pageText(doc, idx).slice(0, 300));
    if (want && head.includes(want)) return idx;
  }
  return null;
}

/** Heading candidates: bold-weight OR all-caps, size ≥ 1.25 × doc median, top 20% of page. */
function scanHeadings(doc: mupdf.Document): Array<{ page: number; title: string }> {
  const pageCount = doc.countPages();
  const sizes: number[] = [];
  const step = Math.max(1, Math.floor(pageCount / 60)); // sample for the median
  for (let p = 0; p < pageCount; p += step) {
    for (const b of pageStructured(doc, p)) {
      for (const l of b.lines ?? []) {
        if (l.font?.size) sizes.push(l.font.size);
      }
    }
  }
  sizes.sort((a, b) => a - b);
  const median = sizes.length ? (sizes[Math.floor(sizes.length / 2)] as number) : 10;

  const out: Array<{ page: number; title: string }> = [];
  for (let p = 0; p < pageCount; p++) {
    const blocks = pageStructured(doc, p);
    const first = blocks.find((b) => (b.lines ?? []).some((l) => (l.text ?? '').trim()));
    if (!first) continue;
    const pageH = Math.max(...blocks.map((b) => (b.bbox ? b.bbox.y + b.bbox.h : 0)), 800);
    for (const l of (first.lines ?? []).slice(0, 3)) {
      const text = (l.text ?? '').trim();
      if (text.length < 4 || text.length > 80) continue;
      const y = l.y ?? l.bbox?.y ?? 0;
      if (y > pageH * 0.2) continue; // top 20% only
      const bold = /bold/i.test(l.font?.weight ?? '') || /bold/i.test(l.font?.name ?? '');
      const caps = text === text.toUpperCase() && /[A-Z]/.test(text);
      const big = (l.font?.size ?? 0) >= 1.25 * median;
      if ((bold || caps) && big) out.push({ page: p, title: text });
    }
  }
  return out;
}

/** Starts → ranges: end = next section start − 1, capped at MAX_SECTION_PAGES. */
function buildRanges(starts: Record<string, Start>, pageCount: number): LocatedMap {
  const entries = Object.entries(starts).sort((a, b) => a[1].page - b[1].page);
  const map: LocatedMap = {};
  for (let i = 0; i < entries.length; i++) {
    const [section, s] = entries[i] as [string, Start];
    const nextStart = i + 1 < entries.length ? (entries[i + 1] as [string, Start])[1].page : pageCount;
    const end = Math.min(nextStart - 1, s.page + MAX_SECTION_PAGES - 1, pageCount - 1);
    map[section] = { start: s.page, end: Math.max(s.page, end), method: s.method, confidence: s.confidence };
  }
  return map;
}
