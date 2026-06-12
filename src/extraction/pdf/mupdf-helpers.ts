/**
 * mupdf-helpers.ts — local PDF engine (PRD §11.3).
 * Every mupdf object is destroy()ed in a finally.
 */
import * as mupdf from 'mupdf';

export function openDoc(buf: Buffer): mupdf.PDFDocument {
  return mupdf.Document.openDocument(buf, 'application/pdf') as mupdf.PDFDocument;
}

interface StLine {
  text?: string;
  x?: number;
  y?: number;
  font?: { name?: string; family?: string; weight?: string; style?: string; size?: number };
  bbox?: { x: number; y: number; w: number; h: number };
}
interface StBlock { type?: string; bbox?: { x: number; y: number; w: number; h: number }; lines?: StLine[] }

/** Parse one page's structured text into blocks/lines (geometry preserved). */
export function pageStructured(doc: mupdf.Document, idx: number): StBlock[] {
  const page = doc.loadPage(idx);
  try {
    const st = page.toStructuredText('preserve-whitespace');
    try {
      const parsed = JSON.parse(st.asJSON()) as { blocks?: StBlock[] };
      return parsed.blocks ?? [];
    } finally {
      st.destroy();
    }
  } finally {
    page.destroy();
  }
}

export function pageText(doc: mupdf.Document, idx: number): string {
  const blocks = pageStructured(doc, idx);
  return blocks
    .flatMap((b) => b.lines ?? [])
    .map((l) => l.text ?? '')
    .join('\n');
}

/** Text of pages [start..end] (0-based, clamped) with `--- page N ---` markers (1-based). */
export function rangeText(doc: mupdf.Document, start: number, end: number): string {
  let out = '';
  const last = doc.countPages() - 1;
  for (let i = Math.max(0, start); i <= Math.min(last, end); i++) {
    out += `\n--- page ${i + 1} ---\n` + pageText(doc, i);
  }
  return out;
}

/** Split pages [start..end] (0-based) into a standalone mini-PDF buffer (Layer 3 fallback). */
export function miniPdf(srcBuf: Buffer, start: number, end: number): Buffer {
  const src = openDoc(srcBuf);
  const dst = new mupdf.PDFDocument();
  try {
    const last = src.countPages() - 1;
    for (let i = Math.max(0, start); i <= Math.min(last, end); i++) {
      dst.graftPage(-1, src, i);
    }
    const buf = dst.saveToBuffer('compress');
    try {
      return Buffer.from(buf.asUint8Array());
    } finally {
      buf.destroy();
    }
  } finally {
    src.destroy();
    dst.destroy();
  }
}

/** Render one page (0-based) to PNG for the human review queue. Small pixmaps only. */
export function pagePng(srcBuf: Buffer, idx: number, width = 1200): Buffer {
  const doc = openDoc(srcBuf);
  try {
    const page = doc.loadPage(Math.max(0, Math.min(doc.countPages() - 1, idx)));
    try {
      const bounds = page.getBounds();
      const scale = width / Math.max(1, bounds[2] - bounds[0]);
      const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
      try {
        return Buffer.from(pix.asPNG());
      } finally {
        pix.destroy();
      }
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
}

/** Embedded bookmarks: [{title, page}] (page is a 0-based PDF index). Locator L-A. */
export function outline(doc: mupdf.Document): Array<{ title: string; page: number }> {
  const items = doc.loadOutline() ?? [];
  const out: Array<{ title: string; page: number }> = [];
  const walk = (nodes: Array<{ title?: string; page?: number; down?: unknown[] }>) => {
    for (const n of nodes) {
      if (n.title != null && typeof n.page === 'number' && n.page >= 0) {
        out.push({ title: n.title, page: n.page });
      }
      if (Array.isArray(n.down)) walk(n.down as Array<{ title?: string; page?: number; down?: unknown[] }>);
    }
  };
  walk(items as Array<{ title?: string; page?: number; down?: unknown[] }>);
  return out;
}

export function isEncrypted(doc: mupdf.PDFDocument): boolean {
  try {
    return typeof (doc as unknown as { needsPassword?: () => boolean }).needsPassword === 'function'
      ? (doc as unknown as { needsPassword: () => boolean }).needsPassword()
      : false;
  } catch {
    return false;
  }
}
