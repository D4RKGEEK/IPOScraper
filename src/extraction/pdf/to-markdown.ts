/**
 * to-markdown.ts — turn located pages into LLM-friendly markdown LOCALLY and
 * free, so Firecrawl meters a tiny text file instead of PDF pages (PRD §9).
 *
 * Heuristics:
 *  - heading: line fontSize ≥ 1.25 × page median, or bold + ALLCAPS → "## " line
 *  - table-ish: ≥ 3 lines on the page sharing ≥ 3 x-position columns
 *    (cluster x-origins with 8px tolerance) → pipe table, cells in x-order
 *  - everything else: plain paragraphs in reading order (sort by y, then x)
 *  - ALWAYS prefix each page with `\n--- page N ---\n` (evidence + page attribution)
 *
 * tableConfidence = share of table-ish rows whose column count was consistent;
 * < 0.7 routes table-bearing fields straight to Layer 3 (PRD §9, fallback #25).
 */
import * as mupdf from 'mupdf';
import { pageStructured } from './mupdf-helpers';

interface Cell { x: number; y: number; text: string; size: number; bold: boolean }

const X_TOL = 8;   // px tolerance when clustering x-origins
const Y_TOL = 3;   // px tolerance when grouping lines into rows

function collectCells(doc: mupdf.Document, pageIdx: number): Cell[] {
  const cells: Cell[] = [];
  for (const block of pageStructured(doc, pageIdx)) {
    for (const line of block.lines ?? []) {
      const text = (line.text ?? '').trim();
      if (!text) continue;
      const x = line.x ?? line.bbox?.x ?? 0;
      const y = line.y ?? line.bbox?.y ?? 0;
      const size = line.font?.size ?? 0;
      const bold = /bold/i.test(line.font?.weight ?? '') || /bold/i.test(line.font?.name ?? '');
      cells.push({ x, y, text, size, bold });
    }
  }
  cells.sort((a, b) => (Math.abs(a.y - b.y) > Y_TOL ? a.y - b.y : a.x - b.x));
  return cells;
}

/** Group cells into visual rows by y (tolerance Y_TOL). */
function toRows(cells: Cell[]): Cell[][] {
  const rows: Cell[][] = [];
  for (const c of cells) {
    const row = rows[rows.length - 1];
    if (row && row[0] && Math.abs(row[0].y - c.y) <= Y_TOL) row.push(c);
    else rows.push([c]);
  }
  for (const r of rows) r.sort((a, b) => a.x - b.x);
  return rows;
}

/** Cluster x-origins across rows with X_TOL tolerance; returns sorted cluster centers. */
function clusterX(rows: Cell[][]): number[] {
  const xs = rows.flatMap((r) => r.map((c) => c.x)).sort((a, b) => a - b);
  const clusters: number[] = [];
  for (const x of xs) {
    const last = clusters[clusters.length - 1];
    if (last === undefined || Math.abs(x - last) > X_TOL) clusters.push(x);
  }
  return clusters;
}

const isAllCaps = (s: string) => s.length >= 4 && s === s.toUpperCase() && /[A-Z]/.test(s);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Like sectionToMarkdown, but emits clean STRUCTURED HTML — real `<table>`/`<tr>`/`<td>`
 * for table regions, `<h2>` for headings, `<p>` for prose. Firecrawl's `/parse` reads
 * HTML structure, so genuine table markup (vs. a `<pre>` blob) is what lets the cheap
 * path carry numeric/table fields (price band, lot size, issue sizes). Each page is
 * still announced with a `--- page N ---` marker so the model can attribute pages.
 */
export function sectionToHtml(
  doc: mupdf.Document,
  start: number,
  end: number,
): { html: string; tableConfidence: number } {
  const last = doc.countPages() - 1;
  const lo = Math.max(0, start);
  const hi = Math.min(last, end);

  const allSizes: number[] = [];
  const perPage: Cell[][] = [];
  for (let p = lo; p <= hi; p++) {
    const cells = collectCells(doc, p);
    perPage.push(cells);
    for (const c of cells) if (c.size > 0) allSizes.push(c.size);
  }
  allSizes.sort((a, b) => a - b);
  const median = allSizes.length ? (allSizes[Math.floor(allSizes.length / 2)] as number) : 10;

  let body = '';
  let tableRows = 0;
  let consistentTableRows = 0;

  for (let p = lo; p <= hi; p++) {
    body += `<p>--- page ${p + 1} ---</p>\n`;
    const cells = perPage[p - lo] ?? [];
    const rows = toRows(cells);
    const columns = clusterX(rows);
    const multiRows = rows.filter((r) => r.length >= 2);
    const tableMode = multiRows.length >= 3 && columns.length >= 3;

    let inTable = false;
    let expectedCols: number | null = null;
    const closeTable = (): void => {
      if (inTable) {
        body += '</table>\n';
        inTable = false;
        expectedCols = null;
      }
    };

    for (const row of rows) {
      const joined = row.map((c) => c.text).join(' ').trim();
      if (!joined) continue;

      if (tableMode && row.length >= 2) {
        tableRows++;
        if (expectedCols === null) expectedCols = row.length;
        if (row.length === expectedCols) consistentTableRows++;
        if (!inTable) {
          body += '<table>\n';
          inTable = true;
        }
        body += '<tr>' + row.map((c) => `<td>${esc(c.text)}</td>`).join('') + '</tr>\n';
        continue;
      }

      closeTable();
      const cell = row[0];
      if (!cell) continue;
      const heading = cell.size >= 1.25 * median || (cell.bold && isAllCaps(joined));
      body += heading ? `<h2>${esc(joined)}</h2>\n` : `<p>${esc(joined)}</p>\n`;
    }
    closeTable();
  }

  const tableConfidence = tableRows === 0 ? 1 : consistentTableRows / tableRows;
  return { html: `<!DOCTYPE html><html><body>\n${body}</body></html>`, tableConfidence };
}

export function sectionToMarkdown(
  doc: mupdf.Document,
  start: number,
  end: number,
): { md: string; tableConfidence: number } {
  const last = doc.countPages() - 1;
  const lo = Math.max(0, start);
  const hi = Math.min(last, end);

  // Median font size over the section (for heading detection).
  const allSizes: number[] = [];
  const perPage: Cell[][] = [];
  for (let p = lo; p <= hi; p++) {
    const cells = collectCells(doc, p);
    perPage.push(cells);
    for (const c of cells) if (c.size > 0) allSizes.push(c.size);
  }
  allSizes.sort((a, b) => a - b);
  const median = allSizes.length ? (allSizes[Math.floor(allSizes.length / 2)] as number) : 10;

  let md = '';
  let tableRows = 0;
  let consistentTableRows = 0;

  for (let p = lo; p <= hi; p++) {
    md += `\n--- page ${p + 1} ---\n`;
    const cells = perPage[p - lo] ?? [];
    const rows = toRows(cells);
    const columns = clusterX(rows);

    // Table region: ≥ 3 rows with ≥ 2 cells, aligned to ≥ 3 shared column clusters.
    const multiRows = rows.filter((r) => r.length >= 2);
    const tableMode = multiRows.length >= 3 && columns.length >= 3;

    let expectedCols: number | null = null;
    for (const row of rows) {
      const joined = row.map((c) => c.text).join(' ').trim();
      if (!joined) continue;

      if (tableMode && row.length >= 2) {
        // pipe table row, cells in x-order
        tableRows++;
        if (expectedCols === null) expectedCols = row.length;
        if (row.length === expectedCols) consistentTableRows++;
        md += `| ${row.map((c) => c.text.replace(/\|/g, '/')).join(' | ')} |\n`;
        continue;
      }

      const cell = row[0];
      if (!cell) continue;
      const heading = cell.size >= 1.25 * median || (cell.bold && isAllCaps(joined));
      md += heading ? `\n## ${joined}\n` : `${joined}\n`;
      expectedCols = null; // table block ended
    }
  }

  const tableConfidence = tableRows === 0 ? 1 : consistentTableRows / tableRows;
  return { md: md.trim() + '\n', tableConfidence };
}
