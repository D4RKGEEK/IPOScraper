'use strict';

/**
 * lotSizeCalculator.js
 * Compute the IPO lot-size / application table (Retail / S-HNI / B-HNI) the way
 * IPO data sites present it.
 *
 * IMPORTANT: this table is DERIVED, not printed verbatim in the RHP. The
 * prospectus states only the minimum bid lot. The Retail/HNI breakdown follows
 * SEBI bidding rules applied to (lot size × cap price). Deterministic
 * computation is far more reliable than parsing it out of a PDF.
 *
 * Rules are sourced + adversarially verified — see rules/ipo_bidding_rules.json.
 * Mainboard is validated against the AMIRCHAND worked example (lot=70, ₹212).
 *
 * Thresholds (SEBI ICDR):
 *   Retail / Individual cap  ₹2,00,000
 *   S-HNI / sNII upper bound ₹10,00,000   (above => B-HNI / bNII)
 * Mainboard NII split: ICDR Amendment 2022 (issues opening after 1 Apr 2022).
 * SME NII split + "Individual = 2 lots > ₹2L": NSE Circular NSE/IPO/68604
 *   (18 Jun 2025), SME IPOs opening on/after 1 Jul 2025.
 */

const RETAIL_CAP = 200000;   // Retail / Individual application-value ceiling
const SHNI_CAP = 1000000;    // S-HNI / sNII application-value ceiling

const round = (n) => Math.round(n);

function row(category, type, lots, lotSize, price) {
  const shares = lots * lotSize;
  return { category, type, lots, shares, amount: round(shares * price) };
}

/**
 * Mainboard table: Retail 1..floor(2L), S-HNI (retailMax+1)..floor(10L), B-HNI (+1).
 */
function computeMainboard(lotSize, price) {
  const perLot = lotSize * price;
  const apps = [];
  const warnings = [];

  const retailMax = Math.floor(RETAIL_CAP / perLot);
  if (retailMax < 1) {
    // One lot already exceeds the retail cap (very high-priced lot).
    warnings.push(`one lot (₹${round(perLot)}) exceeds retail cap ₹${RETAIL_CAP}`);
  } else {
    apps.push(row('Retail', 'Min', 1, lotSize, price));
    if (retailMax > 1) apps.push(row('Retail', 'Max', retailMax, lotSize, price));
  }

  const sHniMin = Math.max(retailMax + 1, 1);
  const sHniMax = Math.floor(SHNI_CAP / perLot);
  if (sHniMax >= sHniMin) {
    apps.push(row('S-HNI', 'Min', sHniMin, lotSize, price));
    if (sHniMax > sHniMin) apps.push(row('S-HNI', 'Max', sHniMax, lotSize, price));
    apps.push(row('B-HNI', 'Min', sHniMax + 1, lotSize, price));
  } else {
    // No room for an S-HNI band; everything above retail is B-HNI.
    apps.push(row('B-HNI', 'Min', sHniMin, lotSize, price));
    warnings.push('S-HNI band empty (lot value too large); collapses into B-HNI');
  }
  return { apps, warnings, perLot };
}

/**
 * SME table (rules effective 1 Jul 2025): Individual = exactly 2 lots (value must
 * exceed ₹2L); S-HNI starts at 3 lots up to floor(10L); B-HNI above. If
 * floor(10L/perLot) < 3 there is no valid S-HNI and it collapses into B-HNI.
 */
function computeSme(lotSize, price) {
  const perLot = lotSize * price;
  const apps = [];
  const warnings = [];

  const individualLots = 2;
  apps.push(row('Individual', 'Fixed', individualLots, lotSize, price));
  if (individualLots * perLot <= RETAIL_CAP) {
    warnings.push(`SME minimum (2 lots = ₹${round(2 * perLot)}) does not exceed ₹${RETAIL_CAP}; issuer is expected to size the lot/price up`);
  }

  const sHniMax = Math.floor(SHNI_CAP / perLot);
  const sHniMin = 3; // smallest integer lots greater than the 2-lot Individual tier
  if (sHniMax >= sHniMin) {
    apps.push(row('S-HNI', 'Min', sHniMin, lotSize, price));
    if (sHniMax > sHniMin) apps.push(row('S-HNI', 'Max', sHniMax, lotSize, price));
    apps.push(row('B-HNI', 'Min', sHniMax + 1, lotSize, price));
  } else {
    apps.push(row('B-HNI', 'Min', sHniMin, lotSize, price));
    warnings.push('S-HNI band empty (SME lot value too large); collapses into B-HNI at 3 lots');
  }
  return { apps, warnings, perLot };
}

/**
 * Compute the application table.
 *
 * @param {object} input
 * @param {number} input.lotSize   shares per lot (bid increment)
 * @param {number} input.price     per-share cap / cut-off (upper band) price
 * @param {'mainboard'|'sme'} [input.marketType='mainboard']
 * @returns {object}
 */
function computeApplicationTable(input) {
  const { lotSize, price } = input;
  const marketType = input.marketType === 'sme' ? 'sme' : 'mainboard';
  if (!lotSize || !price || lotSize <= 0 || price <= 0) {
    return { ok: false, reason: 'missing_lot_or_price', lotSize, price, marketType };
  }

  const { apps, warnings, perLot } = marketType === 'sme'
    ? computeSme(lotSize, price)
    : computeMainboard(lotSize, price);

  return {
    ok: true,
    lotSize,
    price,
    marketType,
    perLot,
    minBidShares: apps.length ? apps[0].shares : null,
    thresholds: { retailCapINR: RETAIL_CAP, sHniCapINR: SHNI_CAP },
    applications: apps,
    warnings,
  };
}

module.exports = { computeApplicationTable, computeMainboard, computeSme, RETAIL_CAP, SHNI_CAP };
