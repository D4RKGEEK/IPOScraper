'use strict';

// ─── Timeline Builder ─────────────────────────────────────────────────────────
//
// Builds a normalized `timeline` object and maintains an append-only
// `statusHistory` array for each IPO record.
//
// Timeline fields (all YYYY-MM-DD strings or null):
//   drhp_available  — date drhp_url first appeared in any source
//   rhp_available   — date rhp_url first appeared in any source
//   open            — application/bidding start date
//   close           — application/bidding end date
//   allotment       — allotment date
//   listing         — listing date
//
// Status history entry shape:
//   { status, date, source, detectedAt }
//   status    — one of the TIMELINE_EVENTS keys
//   date      — the actual event date (YYYY-MM-DD), or null if unknown
//   source    — 'upstox' | 'nse' | 'inferred'
//   detectedAt — ISO timestamp of when our pipeline first observed this
//
// Design notes:
//   - buildTimeline() is pure — takes raw_sources, returns a new timeline object
//   - appendStatusHistory() is pure — takes existing history + new timeline,
//     returns a new array with only genuinely new events appended
//   - Neither function mutates its inputs

// Ordered list of timeline event keys (determines display order)
const TIMELINE_EVENTS = [
  'drhp_available',
  'rhp_available',
  'open',
  'close',
  'allotment',
  'listing',
];

/**
 * Extract a YYYY-MM-DD string from a value that may already be ISO format
 * or an Indian date string (DD-Mon-YYYY). Returns null if unparseable.
 * @param {string|null|undefined} val
 * @returns {string|null}
 */
function toIsoDate(val) {
  if (!val) return null;
  const s = String(val).trim();

  // Already YYYY-MM-DD — validate month/day bounds
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const month = parseInt(s.slice(5, 7), 10);
    const day   = parseInt(s.slice(8, 10), 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return s;
    return null;
  }

  // DD-Mon-YYYY  e.g. "09-Jun-2026"
  const indianMatch = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (indianMatch) {
    const months = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const mon = indianMatch[2].toLowerCase();
    if (months[mon]) {
      const dayNum = parseInt(indianMatch[1], 10);
      if (dayNum < 1 || dayNum > 31) return null;
      const day = indianMatch[1].padStart(2, '0');
      return `${indianMatch[3]}-${months[mon]}-${day}`;
    }
  }

  // DD-MON-YYYY uppercase e.g. "21-MAY-2026"
  const upperMatch = s.match(/^(\d{1,2})-([A-Z]{3})-(\d{4})$/);
  if (upperMatch) {
    const months = {
      JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
      JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
    };
    if (months[upperMatch[2]]) {
      const dayNum = parseInt(upperMatch[1], 10);
      if (dayNum < 1 || dayNum > 31) return null;
      const day = upperMatch[1].padStart(2, '0');
      return `${upperMatch[3]}-${months[upperMatch[2]]}-${day}`;
    }
  }

  return null;
}

/**
 * Builds a normalized timeline object from an IPO record's raw_sources.
 *
 * Source precedence per field:
 *   open / close  — upstox.timeline > upstox top-level > nse
 *   allotment     — upstox.timeline only
 *   listing       — upstox.timeline > nse.listingDate > top-level listingDate
 *   drhp_available — presence of any drhp_url in documentUrls or raw_sources
 *   rhp_available  — presence of any rhp_url in documentUrls or raw_sources
 *
 * @param {object} ipo  A standardized IPO record (may include raw_sources, documentUrls)
 * @returns {{ drhp_available: string|null, rhp_available: string|null, open: string|null,
 *             close: string|null, allotment: string|null, listing: string|null }}
 */
function buildTimeline(ipo) {
  const upstox = (ipo.raw_sources && ipo.raw_sources.upstox) || {};
  const nse    = (ipo.raw_sources && ipo.raw_sources.nse)    || {};
  const tl     = upstox.timeline || {};
  const docs   = ipo.documentUrls || {};

  // open: bidding/application start
  const open =
    toIsoDate(tl.application_start_date) ||
    toIsoDate(upstox.bidding_start_date) ||
    toIsoDate(nse.issueStartDate) ||
    toIsoDate(nse.ipoStartDate) ||
    toIsoDate(ipo.biddingStartDate) ||
    null;

  // close: bidding/application end
  const close =
    toIsoDate(tl.application_end_date) ||
    toIsoDate(upstox.bidding_end_date) ||
    toIsoDate(nse.issueEndDate) ||
    toIsoDate(nse.ipoEndDate) ||
    toIsoDate(ipo.biddingEndDate) ||
    null;

  // allotment
  const allotment =
    toIsoDate(tl.allotment_date) ||
    toIsoDate(tl.allotment_start_date) ||
    null;

  // listing
  const listing =
    toIsoDate(tl.listing_date) ||
    toIsoDate(nse.listingDate) ||
    toIsoDate(ipo.listingDate) ||
    null;

  // drhp_available — inferred from URL presence (we don't have the actual filing date)
  const hasDrhp = !!(
    docs.drhp ||
    upstox.drhp_url ||
    (nse.metaInfo && nse.metaInfo.drhpUrl) ||
    nse.drhpUrl
  );

  // rhp_available — inferred from URL presence
  const hasRhp = !!(
    docs.rhp ||
    upstox.rhp_url ||
    (nse.metaInfo && nse.metaInfo.rhpUrl) ||
    nse.rhpUrl
  );

  return {
    drhp_available: hasDrhp ? (toIsoDate(ipo.biddingStartDate) || open || null) : null,
    rhp_available:  hasRhp  ? (toIsoDate(ipo.biddingStartDate) || open || null) : null,
    open,
    close,
    allotment,
    listing,
  };
}

/**
 * Determines the source label for a given timeline event, based on which
 * raw_source field provided the data.
 *
 * @param {string} event   Timeline event key
 * @param {object} ipo     Standardized IPO record with raw_sources
 * @returns {'upstox'|'nse'|'inferred'}
 */
function resolveSource(event, ipo) {
  const upstox = (ipo.raw_sources && ipo.raw_sources.upstox) || {};
  const nse    = (ipo.raw_sources && ipo.raw_sources.nse)    || {};
  const tl     = upstox.timeline || {};

  switch (event) {
    case 'open':
      if (tl.application_start_date || upstox.bidding_start_date) return 'upstox';
      if (nse.issueStartDate || nse.ipoStartDate) return 'nse';
      return 'inferred';

    case 'close':
      if (tl.application_end_date || upstox.bidding_end_date) return 'upstox';
      if (nse.issueEndDate || nse.ipoEndDate) return 'nse';
      return 'inferred';

    case 'allotment':
      return tl.allotment_date ? 'upstox' : 'inferred';

    case 'listing':
      if (tl.listing_date) return 'upstox';
      if (nse.listingDate) return 'nse';
      return 'inferred';

    case 'drhp_available':
    case 'rhp_available':
      return 'inferred';

    default:
      return 'inferred';
  }
}

/**
 * Appends new status events to an existing statusHistory array.
 * Only events that are not already recorded (matched by status + date) are added.
 * Existing entries are never modified — this is append-only.
 *
 * @param {object[]} existingHistory  Current statusHistory array (may be empty/undefined)
 * @param {object}   newTimeline      Timeline object from buildTimeline()
 * @param {object}   ipo              Standardized IPO record (used for source resolution)
 * @param {string}   [nowIso]         ISO timestamp for detectedAt (defaults to now)
 * @returns {object[]}  New statusHistory array (existing entries + any new ones)
 */
function appendStatusHistory(existingHistory, newTimeline, ipo, nowIso) {
  const history = Array.isArray(existingHistory) ? existingHistory : [];
  const detectedAt = nowIso || new Date().toISOString();
  const additions = [];

  for (const event of TIMELINE_EVENTS) {
    const date = newTimeline[event];
    if (!date) continue;

    // Check if this exact event+date combo is already recorded
    const alreadyRecorded = history.some(
      entry => entry.status === event && entry.date === date
    );
    if (alreadyRecorded) continue;

    additions.push({
      status:     event,
      date,
      source:     resolveSource(event, ipo),
      detectedAt,
    });
  }

  return [...history, ...additions];
}

/**
 * Applies timeline and statusHistory to an IPO record.
 * Returns a new record object — does not mutate the input.
 *
 * @param {object}   ipo          Standardized IPO record
 * @param {string}   [nowIso]     ISO timestamp for detectedAt
 * @returns {object}  New IPO record with `timeline` and `statusHistory` fields
 */
function applyTimeline(ipo, nowIso) {
  const timeline = buildTimeline(ipo);
  const statusHistory = appendStatusHistory(ipo.statusHistory, timeline, ipo, nowIso);
  return { ...ipo, timeline, statusHistory };
}

module.exports = {
  buildTimeline,
  appendStatusHistory,
  applyTimeline,
  toIsoDate,
  TIMELINE_EVENTS,
};
