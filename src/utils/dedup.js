'use strict';

const { jaroWinkler } = require('./jaroWinkler.js');
const { normalizeCompanyName, normalizeSymbol, parseIndianDate } = require('./normalizers.js');
const { applyTimeline } = require('./timelineBuilder.js');

const JARO_THRESHOLD = 0.90;

function areDatesWithin30Days(dateStr1, dateStr2) {
  if (!dateStr1 || !dateStr2) return false;
  const d1 = parseIndianDate(dateStr1);
  const d2 = parseIndianDate(dateStr2);
  if (!d1 || !d2) return false;
  const diffMs = Math.abs(d1.getTime() - d2.getTime());
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays <= 30;
}

function mergeRecordPair(rec1, rec2) {
  // Determine which record is nse-origin and which is upstox-origin
  const nseRec   = rec2.raw_sources && rec2.raw_sources.nse   ? rec2
                 : rec1.raw_sources && rec1.raw_sources.nse   ? rec1
                 : null;
  const upstoxRec = rec1.raw_sources && rec1.raw_sources.upstox ? rec1
                  : rec2.raw_sources && rec2.raw_sources.upstox ? rec2
                  : null;

  // Prefer non-null values; use precedence rules where both have values
  const merged = {
    isin:             rec1.isin || rec2.isin,
    symbol:           rec1.symbol || rec2.symbol,
    companyName:      rec1.companyName || rec2.companyName,
    status:           rec1.status || rec2.status,
    biddingStartDate: (nseRec && nseRec.biddingStartDate)
                        ? nseRec.biddingStartDate
                        : (upstoxRec && upstoxRec.biddingStartDate)
                        ? upstoxRec.biddingStartDate
                        : rec1.biddingStartDate || rec2.biddingStartDate,
    priceBand: (upstoxRec && upstoxRec.priceBand && upstoxRec.priceBand.minimum != null)
                 ? upstoxRec.priceBand
                 : (nseRec && nseRec.priceBand)
                 ? nseRec.priceBand
                 : rec1.priceBand || rec2.priceBand,
    documentUrls: {
      rhp:  (nseRec && nseRec.documentUrls && nseRec.documentUrls.rhp)
              ? nseRec.documentUrls.rhp
              : (rec1.documentUrls && rec1.documentUrls.rhp) || (rec2.documentUrls && rec2.documentUrls.rhp) || null,
      drhp: (nseRec && nseRec.documentUrls && nseRec.documentUrls.drhp)
              ? nseRec.documentUrls.drhp
              : (rec1.documentUrls && rec1.documentUrls.drhp) || (rec2.documentUrls && rec2.documentUrls.drhp) || null,
    },
    raw_sources: {
      ...(rec1.raw_sources || {}),
      ...(rec2.raw_sources || {}),
    },
  };

  if (rec1.listingDate || rec2.listingDate) {
    merged.listingDate = rec1.listingDate || rec2.listingDate;
  }
  if (rec1.timeline || rec2.timeline) {
    merged.timeline = rec1.timeline || rec2.timeline;
  }
  if (rec1.statusHistory || rec2.statusHistory) {
    merged.statusHistory = rec1.statusHistory || rec2.statusHistory;
  }
  return merged;
}

function deduplicateRecords(records) {
  const master = [];
  const borderline = [];

  for (const incoming of records) {
    let matched = false;

    for (let i = 0; i < master.length; i++) {
      const existing = master[i];

      // Match 1: ISIN
      if (incoming.isin && existing.isin && incoming.isin === existing.isin) {
        master[i] = mergeRecordPair(existing, incoming);
        matched = true;
        break;
      }

      // Match 2: Normalized symbol
      const inSym = normalizeSymbol(incoming.symbol);
      const exSym = normalizeSymbol(existing.symbol);
      if (inSym && exSym && inSym === exSym) {
        master[i] = mergeRecordPair(existing, incoming);
        matched = true;
        break;
      }

      // Match 3: Jaro-Winkler + 30-day date guard
      const inName = normalizeCompanyName(incoming.companyName);
      const exName = normalizeCompanyName(existing.companyName);
      if (inName && exName) {
        const score = jaroWinkler(inName, exName);
        if (score >= JARO_THRESHOLD) {
          if (areDatesWithin30Days(incoming.biddingStartDate, existing.biddingStartDate)) {
            master[i] = mergeRecordPair(existing, incoming);
            matched = true;
            break;
          } else {
            borderline.push({
              reason: 'fuzzy_name_match_date_guard_failed',
              score,
              record1: existing,
              record2: incoming,
            });
          }
        } else if (score >= 0.85) {
          borderline.push({
            reason: 'near_miss_below_threshold',
            score,
            record1: existing,
            record2: incoming,
          });
        }
      }
    }

    if (!matched) {
      master.push(incoming);
    }
  }

  // Apply timeline + statusHistory to every deduplicated record
  const timedMaster = master.map(rec => applyTimeline(rec));

  return { master: timedMaster, borderline };
}

module.exports = { deduplicateRecords, mergeRecordPair, areDatesWithin30Days };
