'use strict';

/**
 * ipoModel.js — map a merged standardized IPO record (from sources / ipo_master)
 * into the MongoDB IPO document shape used by the API. Pure + testable.
 *
 * Anything not promoted to a top-level field stays in raw_sources.
 */

const { slugify } = require('../utils/slug');

const g = (record) => (record.raw_sources && record.raw_sources.groww) || {};
const gDetail = (record) => g(record).detail || g(record);
const u = (record) => (record.raw_sources && record.raw_sources.upstox) || {};
const z = (record) => (record.raw_sources && record.raw_sources.zerodha) || {};

/** SME vs MAINBOARD from whichever source knows. */
function issueType(record) {
  const up = u(record);
  if (up.issue_type) return /sme/i.test(up.issue_type) ? 'SME' : 'MAINBOARD';
  const gd = gDetail(record);
  if (typeof gd.isSme === 'boolean') return gd.isSme ? 'SME' : 'MAINBOARD';
  if (typeof z(record).isSme === 'boolean') return z(record).isSme ? 'SME' : 'MAINBOARD';
  if (gd.issueType) return /sme/i.test(gd.issueType) ? 'SME' : 'MAINBOARD';
  return null;
}

function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v;
  return null;
}

function normUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

/** Build the { drhp, rhp, final } documents map with provenance. */
function documentsMap(record) {
  const map = {};
  const push = (docType, url, source) => {
    if (url && !map[docType]) {
      map[docType] = { url: normUrl(url), source };
    }
  };

  if (record.documentUrls) {
    push('rhp', record.documentUrls.rhp, 'merged');
    push('drhp', record.documentUrls.drhp, 'merged');
  }

  const rs = record.raw_sources || {};
  if (rs.upstox) {
    push('rhp', rs.upstox.rhp_url, 'upstox');
    push('drhp', rs.upstox.drhp_url, 'upstox');
  }
  if (rs.nse) {
    push('rhp', rs.nse.rhpUrl, 'nse');
    push('drhp', rs.nse.drhpUrl, 'nse');
    const meta = rs.nse.metaInfo || (rs.nse.details && rs.nse.details.metaInfo);
    if (meta) {
      push('rhp', meta.rhpUrl, 'nse');
      push('drhp', meta.drhpUrl, 'nse');
    }
  }
  if (rs.groww) {
    const gUrl = rs.groww.documentUrl || (rs.groww.detail && rs.groww.detail.documentUrl);
    push(rs.groww.docType || 'drhp', gUrl, 'groww');
  }
  if (rs.zerodha && rs.zerodha.prospectusUrl) {
    push(rs.zerodha.docType || 'drhp', rs.zerodha.prospectusUrl, 'zerodha');
  }

  return map;
}

/** Subscription {retail,qualified,nii,total} from Groww's subscriptionRates. */
function subscription(record) {
  const rates = gDetail(record).subscriptionRates;
  if (!Array.isArray(rates) || !rates.length) return null;
  const by = {};
  for (const r of rates) by[(r.category || '').toUpperCase()] = r.subscriptionRate;
  const out = {};
  if (by.RETAIL != null) out.retail = round2(by.RETAIL);
  if (by.QIB != null) out.qualified = round2(by.QIB);
  if (by.NII != null) out.nii = round2(by.NII);
  if (by.TOTAL != null) out.total = round2(by.TOTAL);
  return Object.keys(out).length ? out : null;
}

const round2 = (n) => (typeof n === 'number' ? Math.round(n * 100) / 100 : n);

/** Per-source tracking: { nse:{url}, upstox:{...}, ... } seeded from raw_sources. */
function sourcesMeta(record, now) {
  const meta = {};
  const rs = record.raw_sources || {};
  for (const src of Object.keys(rs)) {
    const url = rs[src].detailUrl || rs[src].url || null;
    meta[src] = { lastFetched: now, url };
  }
  return meta;
}

/**
 * Map a standardized record to a Mongo IPO document body (no _id/createdAt).
 * @param {object} record
 * @param {object} [opts] { now }
 */
function toIpoDoc(record, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const up = u(record);
  const gd = gDetail(record);
  const lotSize = firstDefined(up.lot_size, gd.lotSize, record.lotSize);
  const priceMax = record.priceBand && record.priceBand.maximum;
  const priceBand = record.priceBand
    ? { min: record.priceBand.minimum ?? null, max: record.priceBand.maximum ?? null }
    : { min: null, max: null };

  return {
    slug: record.slug || slugify(record.companyName || record.symbol),
    isin: record.isin || null,
    symbol: record.symbol || null,
    companyName: record.companyName || null,
    displayName: record.companyName ? `${record.companyName} IPO` : null,
    status: record.status || null,
    issueType: issueType(record),
    sector: firstDefined(gd.sector, up.industry),
    industry: firstDefined(up.industry, gd.sector),
    faceValue: firstDefined(up.face_value, gd.faceValue),
    priceBand,
    issuePrice: firstDefined(gd.issuePrice, up.cut_off_price),
    lotSize: lotSize ?? null,
    minimumAmount: lotSize && priceMax ? lotSize * priceMax : null,
    issueSize: firstDefined(gd.issueSize, up.issue_size),
    biddingStart: firstDefined(record.biddingStartDate, gd.startDate, up.bidding_start_date),
    biddingEnd: firstDefined(gd.endDate, up.bidding_end_date, up.timeline && up.timeline.application_end_date),
    listingDate: firstDefined(record.listingDate, gd.listingDate, up.timeline && up.timeline.listing_date),
    cutoffTime: firstDefined(gd.lastBidPlaceTime, up.timeline && up.timeline.application_end_date),
    allotmentDate: firstDefined(gd.allotmentDate, up.timeline && up.timeline.allotment_date),
    registrar: firstDefined(gd.registrar) || null,
    gmp: null,
    subscription: subscription(record),
    documents: documentsMap(record),
    sources: sourcesMeta(record, now),
    raw_sources: record.raw_sources || {},
    statusHistory: record.statusHistory || undefined,
    timeline: record.timeline || undefined,
    updatedAt: now,
  };
}

// ── Extraction supersession ──────────────────────────────────────────────────
// An IPO can accumulate several extraction rows (one per docType×pipeline). The
// authoritative one is the highest-priority document that extracted (final >
// rhp > drhp). When a better document arrives (e.g. the RHP after the DRHP),
// lower-priority rows are marked `superseded` and a single summary is
// denormalized onto the IPO so consumers have one obvious "live data" pointer.

const DOC_PRIORITY = { final: 3, rhp: 2, drhp: 1 };
const docPriority = (t) => DOC_PRIORITY[t] || 0;

/**
 * Pure reconciliation of an IPO's extraction rows.
 *
 * @param {Array<{docType, pipeline, status, validation, extractedAt}>} rows
 * @returns {{
 *   currentDocType: string|null,
 *   current: {docType, pipeline, status, score, extractedAt}|null,
 *   rows: Array<{docType, pipeline, superseded: boolean}>,
 *   supersededDocTypes: string[],
 * }}
 */
function reconcileExtractionState(rows = []) {
  const usable = rows.filter((r) => r && r.status !== 'failed');
  const maxPriority = usable.reduce((m, r) => Math.max(m, docPriority(r.docType)), -1);

  const flagged = rows.map((r) => ({
    docType: r.docType,
    pipeline: r.pipeline,
    // Only non-failed rows can be "superseded"; failed rows just stay failed.
    superseded: r.status !== 'failed' && docPriority(r.docType) < maxPriority,
  }));

  // docTypes whose rows are all eclipsed by a higher-priority document.
  const supersededDocTypes = [...new Set(
    rows.filter((r) => docPriority(r.docType) < maxPriority).map((r) => r.docType),
  )];

  // Pick the best row of the winning docType for the denormalized summary.
  const statusRank = { completed: 2, review: 1 };
  const score = (r) => (r.validation && typeof r.validation.score === 'number' ? r.validation.score : -1);
  const winners = usable.filter((r) => docPriority(r.docType) === maxPriority);
  winners.sort((a, b) =>
    (statusRank[b.status] || 0) - (statusRank[a.status] || 0) ||
    score(b) - score(a) ||
    String(b.extractedAt || '').localeCompare(String(a.extractedAt || '')));
  const best = winners[0] || null;

  return {
    currentDocType: best ? best.docType : null,
    current: best ? {
      docType: best.docType,
      pipeline: best.pipeline,
      status: best.status,
      score: best.validation && typeof best.validation.score === 'number' ? best.validation.score : null,
      extractedAt: best.extractedAt || null,
    } : null,
    rows: flagged,
    supersededDocTypes,
  };
}

module.exports = {
  toIpoDoc, issueType, subscription, documentsMap, sourcesMeta,
  reconcileExtractionState, docPriority, DOC_PRIORITY,
};
