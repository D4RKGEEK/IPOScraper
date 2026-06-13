'use strict';

/**
 * schema.js — SINGLE SOURCE OF TRUTH for the IPO extraction output format.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  TO CHANGE THE OUTPUT FORMAT, EDIT ONLY THE `FIELDS` OBJECT BELOW.         │
 * │                                                                           │
 * │  Add a field        → add one line to FIELDS.                             │
 * │  Remove a field     → delete its line.                                    │
 * │  Rename / re-describe→ edit it in place.                                  │
 * │                                                                           │
 * │  Everything else is DERIVED from FIELDS automatically:                    │
 * │    • the JSON Schema sent to Firecrawl & DeepSeek (IPO_DETAILS_SCHEMA)     │
 * │    • the Gemini response schema           (GEMINI_SCHEMA)                  │
 * │    • the merge logic for Firecrawl's per-section calls (merge.js)         │
 * │    • normalize(): forces every engine's output into this exact shape,     │
 * │      filling anything missing with DEFAULT_VALUE ("[-]").                  │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Field `type` is one of:
 *   'string'      → a single text value
 *   'list'        → an array of strings
 *   'objectList'  → an array of objects; declare its sub-fields under `fields`
 */

// Value used to fill any field that wasn't found in the document.
const DEFAULT_VALUE = '[-]';

// ── THE FIELD REGISTRY — the built-in DEFAULT ────────────────────────────────
// This is the seed/default schema. At runtime it can be overridden from the
// dashboard (persisted to MongoDB `config`); see getFields()/setFields() below.
// Grouped by source. Fields marked "(market data)" are NOT present in the
// DRHP/RHP prospectus — this extractor leaves them as DEFAULT_VALUE; fill them
// from a market/aggregator source or the dashboard.
//
// objectList fields may declare an optional merge rule used by merge.js when
// folding Firecrawl's per-section results:
//   mergeKey:   sub-field to group rows by (e.g. 'period', 'category')
//   mergeMatch: 'similar' (fuzzy period match) | 'category' (synonym match)
const DEFAULT_FIELDS = {
  // ── Identity & company ──────────────────────────────────────────────────
  company_name:          { type: 'string', description: 'Full legal name of the company (e.g., "Leapfrog Engineering Services Ltd.")' },
  ipo_name:              { type: 'string', description: 'Common IPO name (e.g., "Leapfrog Engineering IPO")' },
  company_description:   { type: 'string', description: 'Detailed description of the company and what it does' },
  incorporation_date:    { type: 'string', format: 'date', description: 'Date / year of incorporation (e.g., "2005")' },
  registered_office:     { type: 'string', description: 'Registered office address' },
  website:               { type: 'string', description: 'Company website URL' },
  sector:                { type: 'string', description: 'Industry/sector the company operates in' },
  employee_count:        { type: 'string', description: 'Employee headcount (e.g., "112 on payroll, 60 on contract")' },
  services:              { type: 'list',   description: 'Key services / product lines offered by the company' },
  competitive_strengths: { type: 'list',   description: 'Key competitive strengths listed in the prospectus' },
  business_strategies:   { type: 'list',   description: 'Key business strategies listed in the prospectus' },
  promoters:             { type: 'list',   description: 'Names of the promoters' },

  // ── Offer terms ─────────────────────────────────────────────────────────
  issue_type:                  { type: 'string', description: 'Type of issue (e.g., "Bookbuilding IPO", "Fixed Price")' },
  sale_type:                   { type: 'string', description: 'Sale type (e.g., "Fresh capital cum OFS", "Fresh Issue", "OFS")' },
  listing_at:                  { type: 'list',   description: 'Exchanges where shares list (e.g., ["BSE SME"], ["BSE", "NSE"])' },
  face_value:                  { type: 'string', format: 'currency', description: 'Face value per share (e.g., "₹1 per share")' },
  price_band:                  { type: 'string', format: 'currency', description: 'Price band (e.g., "₹21 to ₹23")' },
  lot_size:                    { type: 'string', description: 'Minimum lot size in shares (e.g., "6,000 Shares")' },
  total_issue_size_shares:     { type: 'string', description: 'Total issue size in shares (e.g., "3,84,84,000 shares")' },
  total_issue_amount:          { type: 'string', format: 'currency', description: 'Total issue size in rupees (e.g., "₹88.51 Crore")' },
  fresh_issue:                 { type: 'string', format: 'currency', description: 'Fresh issue total (shares and/or ₹, e.g., "3.46 cr shares / ₹79.60 Cr")' },
  fresh_issue_ex_market_maker: { type: 'string', format: 'currency', description: 'Fresh issue excluding market maker portion (e.g., "3,26,82,000 shares / ₹75 Cr")' },
  offer_for_sale:              { type: 'string', format: 'currency', description: 'Offer for sale component (e.g., "38,76,000 shares / ₹8.91 Cr")' },
  net_offer_to_public:         { type: 'string', format: 'currency', description: 'Net offer to public (e.g., "3,65,58,000 shares / ₹84 Cr")' },
  market_maker:                { type: 'string', description: 'Name of the market maker (e.g., "Anant Securities")' },
  market_maker_reservation:    { type: 'string', format: 'currency', description: 'Shares/amount reserved for the market maker (e.g., "19,26,000 shares / ₹4 Cr")' },
  shareholding_pre_issue:      { type: 'string', description: 'Total shares held pre-issue (e.g., "10,71,84,000 shares")' },
  shareholding_post_issue:     { type: 'string', description: 'Total shares held post-issue (e.g., "14,17,92,000 shares")' },

  // ── Timeline (market data — usually NOT in the prospectus) ───────────────
  ipo_open_date:         { type: 'string', format: 'date', description: '(market data) IPO open date' },
  ipo_close_date:        { type: 'string', format: 'date', description: '(market data) IPO close date' },
  allotment_date:        { type: 'string', format: 'date', description: '(market data) Allotment finalization date' },
  refund_date:           { type: 'string', format: 'date', description: '(market data) Refund initiation date' },
  credit_of_shares_date: { type: 'string', format: 'date', description: '(market data) Credit of shares to demat date' },
  listing_date:          { type: 'string', format: 'date', description: '(market data) Listing date' },

  // ── Issue reservation breakdown ──────────────────────────────────────────
  reservations: {
    type: 'objectList',
    description: 'Category-wise reservation of shares',
    mergeKey: 'category', mergeMatch: 'category',
    fields: {
      category:           { type: 'string', format: 'category', description: 'Investor category (e.g., QIB, NII/HNI, Retail, Market Maker)' },
      shares_offered:     { type: 'string', description: 'Number of shares offered to this category' },
      pct_of_net_issue:   { type: 'string', format: 'percent', description: 'Percentage of the net issue (e.g., "60.07%")' },
      pct_of_total_issue: { type: 'string', format: 'percent', description: 'Percentage of the total issue (e.g., "57.06%")' },
    },
  },

  // ── Lot size tiers ────────────────────────────────────────────────────────
  lot_size_options: {
    type: 'objectList',
    description: 'Application tiers (Retail / S-HNI / B-HNI, min and max)',
    fields: {
      application_category: { type: 'string', description: 'Application tier (e.g., "Retail (Min)", "S-HNI (Max)", "B-HNI (Min)")' },
      lots:                 { type: 'string', description: 'Number of lots' },
      shares:               { type: 'string', description: 'Number of shares' },
      amount:               { type: 'string', description: 'Amount in rupees (e.g., "₹2,76,000")' },
    },
  },

  // ── Objects of the issue ──────────────────────────────────────────────────
  objects_of_the_offer: {
    type: 'objectList',
    description: 'Stated objects/purposes of the offer with estimated amounts',
    fields: {
      object:           { type: 'string', description: 'Stated object/purpose (e.g., "Working Capital Requirements")' },
      estimated_amount: { type: 'string', description: 'Estimated amount in ₹ Cr (e.g., "36.05")' },
    },
  },

  // ── Financials (restated) ─────────────────────────────────────────────────
  financials: {
    type: 'objectList',
    description: 'Restated financial statements by period (amounts in ₹ Crore)',
    mergeKey: 'period', mergeMatch: 'similar',
    fields: {
      period:               { type: 'string', format: 'period', description: 'Financial period (e.g., "31 Dec 2025", "FY 2024")' },
      total_assets:         { type: 'string', description: 'Total assets' },
      total_income:         { type: 'string', description: 'Total income / revenue' },
      pat:                  { type: 'string', description: 'Profit After Tax' },
      ebitda:               { type: 'string', description: 'EBITDA' },
      net_worth:            { type: 'string', description: 'Net worth' },
      reserves_and_surplus: { type: 'string', description: 'Reserves and surplus' },
      total_borrowings:     { type: 'string', description: 'Total borrowings' },
    },
  },

  // ── KPIs / ratios by period ────────────────────────────────────────────────
  kpis: {
    type: 'objectList',
    description: 'Key performance indicators by period',
    mergeKey: 'period', mergeMatch: 'similar',
    fields: {
      period:         { type: 'string', format: 'period',  description: 'Period (e.g., "Dec 31, 2025", "Mar 31, 2025")' },
      roe:            { type: 'string', format: 'percent', description: 'Return on equity (e.g., "21.03%")' },
      roce:           { type: 'string', format: 'percent', description: 'Return on capital employed (e.g., "23.98%")' },
      debt_to_equity: { type: 'string', description: 'Debt-to-equity ratio (e.g., "0.48")' },
      ronw:           { type: 'string', format: 'percent', description: 'Return on net worth (e.g., "21.03%")' },
      pat_margin:     { type: 'string', format: 'percent', description: 'PAT margin (e.g., "14.04%")' },
      ebitda_margin:  { type: 'string', format: 'percent', description: 'EBITDA margin (e.g., "19.98%")' },
      price_to_book:  { type: 'string', description: 'Price to book value (e.g., "3.66")' },
    },
  },

  // ── Valuation (pre / post issue) ────────────────────────────────────────────
  eps_pre:               { type: 'string', description: 'Pre-IPO earnings per share (e.g., "1.51")' },
  eps_post:              { type: 'string', description: 'Post-IPO earnings per share (e.g., "1.33")' },
  pe_pre:                { type: 'string', description: 'Pre-IPO P/E ratio (e.g., "15.19")' },
  pe_post:               { type: 'string', description: 'Post-IPO P/E ratio (e.g., "17.24")' },
  promoter_holding_pre:  { type: 'string', format: 'percent',  description: 'Promoter shareholding before the offer (e.g., "92.59%")' },
  promoter_holding_post: { type: 'string', format: 'percent',  description: 'Promoter shareholding after the offer (e.g., "67.27%")' },
  market_cap:            { type: 'string', format: 'currency', description: '(market data) Market capitalisation (e.g., "₹326.12 Cr")' },

  // ── Intermediaries & contact ─────────────────────────────────────────────
  lead_managers:     { type: 'list',   description: 'Book Running Lead Managers (BRLMs)' },
  registrar:         { type: 'string', description: 'Registrar to the offer' },
  registrar_contact: { type: 'string', description: 'Registrar phone / email / website' },
  contact_address:   { type: 'string', description: 'Company contact address' },
  contact_phone:     { type: 'string', description: 'Company contact phone' },
  contact_email:     { type: 'string', description: 'Company contact email' },

  // ── Risk ───────────────────────────────────────────────────────────────────
  risk_factors:      { type: 'list',   description: 'Key risk factors (top 10–15, summarized)' },

  // ── Market data (NOT in the prospectus — filled from other sources) ─────────
  gmp:                  { type: 'string', description: '(market data) Grey Market Premium' },
  subscription_overall: { type: 'string', description: '(market data) Overall subscription (e.g., "12.5x")' },
  listing_gain:         { type: 'string', format: 'percent', description: '(market data) Listing day gain/loss %' },
  review_by:            { type: 'string', description: '(market data) Name of the reviewer (e.g., "Dilip Davda")' },
  review_text:          { type: 'string', description: '(market data) Analyst review text' },
  subscription: {
    type: 'objectList',
    description: '(market data) Subscription by investor category',
    mergeKey: 'category', mergeMatch: 'category',
    fields: {
      category:           { type: 'string', format: 'category', description: 'Investor category (QIB, NII, Retail, Overall)' },
      subscription_times: { type: 'string', description: 'Times subscribed (e.g., "5.2x")' },
    },
  },
  peer_comparison: {
    type: 'objectList',
    description: '(market data) Recently listed / peer IPOs comparison',
    fields: {
      company:         { type: 'string', description: 'Peer company name' },
      issue_type:      { type: 'string', description: 'Issue type (e.g., "SME")' },
      issue_size:      { type: 'string', format: 'currency', description: 'Issue size (e.g., "₹48.00 Cr")' },
      issue_price:     { type: 'string', format: 'currency', description: 'Issue price (e.g., "₹80")' },
      listing_close:   { type: 'string', format: 'currency', description: 'Listing day close price' },
      listing_gain_pct:{ type: 'string', format: 'percent',  description: 'Listing gain/loss %' },
      ltp:             { type: 'string', format: 'currency', description: 'Last traded price' },
    },
  },
  recommendations: {
    type: 'objectList',
    description: '(market data) Subscribe/Avoid recommendation counts',
    fields: {
      reviewer_type: { type: 'string', description: 'Reviewer group (e.g., "Brokers", "Members")' },
      subscribe:     { type: 'string', description: 'Count recommending Subscribe' },
      may_apply:     { type: 'string', description: 'Count recommending May Apply' },
      neutral:       { type: 'string', description: 'Count recommending Neutral' },
      avoid:         { type: 'string', description: 'Count recommending Avoid' },
    },
  },
};

// ── Placeholder detection ────────────────────────────────────────────────────
// Treats "empty-ish" model outputs (null, "N/A", "[●]", DEFAULT_VALUE, …) as
// "not found" so they get replaced by DEFAULT_VALUE / overridden during merge.
const PLACEHOLDERS = new Set([
  'null', 'none', 'n/a', 'na', 'not mentioned', 'not available',
  'not applicable', 'not disclosed', 'tba', 'tbd', 'to be announced',
  '[●]', '[-]', '-', '--', '—', '',
]);

function isPlaceholder(val) {
  if (val == null) return true;
  const cleaned = String(val).trim().toLowerCase();
  return !cleaned || PLACEHOLDERS.has(cleaned) || cleaned.includes('[●]');
}

// ── Value canonicalizers ─────────────────────────────────────────────────────
// A field can declare `format: 'date' | 'period' | 'percent' | 'currency' |
// 'category'` and its value is forced into a fixed, predictable form here.
// Free-text fields (no `format`) are only trimmed. Canonicalizers are
// conservative: if a value can't be confidently parsed, the original is kept
// (we standardize, we don't destroy data).

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const pad2 = (n) => String(n).padStart(2, '0');

/** Parse common date spellings → ISO "YYYY-MM-DD". Unparseable → trimmed input. */
function canonicalDate(raw) {
  const s = String(raw).trim();
  if (!s) return s;
  // Drop a leading weekday ("Wed, ").
  const t = s.replace(/^[a-z]{3,9},?\s+/i, '').trim();

  // Already ISO: 2025-05-31
  let m = t.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`;
  // 31 May 2025  /  31 May, 2025
  m = t.match(/\b(\d{1,2})\s+([a-z]+)\.?,?\s+(\d{4})\b/i);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${pad2(MONTHS[m[2].toLowerCase()])}-${pad2(+m[1])}`;
  // May 31, 2025  /  Dec 31 2025
  m = t.match(/\b([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})\b/i);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${pad2(MONTHS[m[1].toLowerCase()])}-${pad2(+m[2])}`;
  // 31-05-2025 or 31/05/2025  (assume DD-MM-YYYY, the Indian convention)
  m = t.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/);
  if (m) return `${m[3]}-${pad2(+m[2])}-${pad2(+m[1])}`;

  return s; // leave ranges / unknown formats untouched
}

/** Calendar dates → ISO; fiscal labels → "9M FY2025" / "FY2024". Else trimmed. */
function canonicalPeriod(raw) {
  const s = String(raw).trim();
  if (!s) return s;

  if (/fy/i.test(s)) {
    const yearM = s.match(/fy\s*'?\s*(\d{2,4})/i) || s.match(/\b(\d{4})\b/);
    if (yearM) {
      let year = yearM[1];
      if (year.length === 2) year = `20${year}`;
      const monthsM = s.match(/\b(\d{1,2})\s*M\b/i);
      const halfM = s.match(/\bH([12])\b/i);
      const quarterM = s.match(/\bQ([1-4])\b/i);
      let prefix = '';
      if (monthsM) prefix = `${monthsM[1]}M `;
      else if (halfM) prefix = `H${halfM[1]} `;
      else if (quarterM) prefix = `Q${quarterM[1]} `;
      return `${prefix}FY${year}`;
    }
  }

  return canonicalDate(s);
}

/** Normalize a percentage → "21.03%" (single symbol, no spaces). */
function canonicalPercent(raw) {
  const s = String(raw).trim();
  if (!s) return s;
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? `${m[0]}%` : s;
}

/** Light, lossless currency cleanup: ₹ symbol + standard unit words, no reflow. */
function canonicalCurrency(raw) {
  let s = String(raw).trim();
  if (!s) return s;
  s = s.replace(/\s+/g, ' ');
  // "Rs." / "Rs" / "INR" → ₹  (consume the optional trailing dot too)
  s = s.replace(/\brs\b\.?/gi, '₹').replace(/\binr\b/gi, '₹').replace(/₹\s+/g, '₹');
  s = s.replace(/\bcrores?\b/gi, 'Cr').replace(/\bcr\b\.?/gi, 'Cr');
  s = s.replace(/\b(?:lakhs?|lacs?)\b/gi, 'Lakh');
  return s.trim();
}

// Canonical investor-category labels (used by normalize AND merge grouping).
const CATEGORY_CANON = [
  { label: 'QIB', syns: ['qib', 'qualified institutional'] },
  { label: 'NII (HNI)', syns: ['nii', 'nib', 'non-institutional', 'non institutional', 'hni'] },
  { label: 'Retail', syns: ['retail', 'rii'] },
  { label: 'Market Maker', syns: ['market maker'] },
  { label: 'Anchor', syns: ['anchor'] },
  { label: 'Employee', syns: ['employee'] },
  { label: 'Overall', syns: ['overall', 'total'] },
];

function canonicalCategory(raw) {
  const s = String(raw || '').toLowerCase();
  for (const c of CATEGORY_CANON) {
    if (c.syns.some((syn) => s.includes(syn))) return c.label;
  }
  return String(raw || '').trim();
}

const CANONICALIZERS = {
  date: canonicalDate,
  period: canonicalPeriod,
  percent: canonicalPercent,
  currency: canonicalCurrency,
  category: canonicalCategory,
};

/** Apply a field's declared `format` to a (non-placeholder) value. */
function canonicalize(val, format) {
  const fn = format && CANONICALIZERS[format];
  return fn ? fn(val) : val;
}

// ── Runtime-mutable field registry ───────────────────────────────────────────
// FIELDS starts as a clone of DEFAULT_FIELDS but can be replaced at runtime via
// setFields() (from the dashboard, persisted to MongoDB). Everything downstream
// reads it through the getters below — so edits take effect on the next run
// without restarting or touching code.
const clone = (o) => JSON.parse(JSON.stringify(o));
let FIELDS = clone(DEFAULT_FIELDS);

function getFields() { return FIELDS; }
function getDefaultFields() { return clone(DEFAULT_FIELDS); }

// ── Field groupings derived from the registry (used by merge.js) ─────────────
const getStringFields = () => Object.keys(FIELDS).filter((k) => FIELDS[k].type === 'string');
const getListFields = () => Object.keys(FIELDS).filter((k) => FIELDS[k].type === 'list');
const getObjectListFields = () => Object.keys(FIELDS).filter((k) => FIELDS[k].type === 'objectList');

/** The merge rules for keyed objectList fields, derived from the registry. */
function getObjectListMerge() {
  const rules = {};
  for (const [key, def] of Object.entries(FIELDS)) {
    if (def.type === 'objectList' && def.mergeKey) {
      rules[key] = { key: def.mergeKey, match: def.mergeMatch || 'similar' };
    }
  }
  return rules;
}

// ── JSON Schema derivation (for Firecrawl / Gemini / DeepSeek) ───────────────
function fieldToJsonSchema(def) {
  if (def.type === 'string') {
    return { type: 'string', description: def.description };
  }
  if (def.type === 'list') {
    return { type: 'array', items: { type: 'string' }, description: def.description };
  }
  if (def.type === 'objectList') {
    const properties = {};
    for (const [subKey, subDef] of Object.entries(def.fields)) {
      properties[subKey] = { type: 'string', description: subDef.description };
    }
    return { type: 'array', items: { type: 'object', properties }, description: def.description };
  }
  throw new Error(`Unknown field type "${def.type}"`);
}

function buildJsonSchema() {
  const properties = {};
  for (const [key, def] of Object.entries(FIELDS)) {
    properties[key] = fieldToJsonSchema(def);
  }
  return { type: 'object', properties };
}

// Computed on demand so they always reflect the current (possibly edited) FIELDS.
const getIpoDetailsSchema = () => buildJsonSchema();
// Gemini wants the same shape (kept as a separate getter for clarity).
const getGeminiSchema = () => ({ type: 'object', properties: buildJsonSchema().properties });

// ── Normalization — force any engine's output into the canonical shape ───────

function normalizeObjectRow(item, fields) {
  if (!item || typeof item !== 'object') return null;
  const out = {};
  let hasRealValue = false;
  for (const [key, def] of Object.entries(fields)) {
    const val = item[key];
    if (isPlaceholder(val)) {
      out[key] = DEFAULT_VALUE;
    } else {
      out[key] = canonicalize(String(val).trim(), def.format);
      hasRealValue = true;
    }
  }
  // Drop rows that are entirely empty (all placeholders).
  return hasRealValue ? out : null;
}

/**
 * Coerce a raw extraction result (from any engine) into the exact canonical
 * shape defined by FIELDS:
 *   • every field present, in registry order
 *   • unknown / extra keys dropped
 *   • missing scalars  → DEFAULT_VALUE ("[-]")
 *   • missing lists    → [] (empty array)
 *   • objectList rows  → each sub-field present; all-empty rows removed
 *
 * @param {object} raw  Whatever the model / merge returned
 * @returns {object}    Canonical IPODetails
 */
function normalize(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const out = {};

  for (const [key, def] of Object.entries(FIELDS)) {
    const val = obj[key];

    if (def.type === 'string') {
      out[key] = isPlaceholder(val) ? DEFAULT_VALUE : canonicalize(String(val).trim(), def.format);
    } else if (def.type === 'list') {
      out[key] = Array.isArray(val)
        ? val.filter((v) => !isPlaceholder(v)).map((v) => String(v).trim())
        : [];
    } else if (def.type === 'objectList') {
      out[key] = Array.isArray(val)
        ? val.map((item) => normalizeObjectRow(item, def.fields)).filter(Boolean)
        : [];
    }
  }

  return out;
}

// ── Validation + mutation (used by the dashboard schema editor) ──────────────

const VALID_TYPES = new Set(['string', 'list', 'objectList']);
const VALID_FORMATS = new Set(['date', 'period', 'percent', 'currency', 'category']);
const KEY_RE = /^[a-z][a-z0-9_]*$/; // snake_case identifiers only

/**
 * Validate a candidate FIELDS object. Throws Error with a clear message on the
 * first problem found. Returns a sanitized clone on success.
 */
function validateFields(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('schema must be an object of { fieldKey: definition }');
  }
  const keys = Object.keys(candidate);
  if (!keys.length) throw new Error('schema must have at least one field');

  const out = {};
  for (const key of keys) {
    if (!KEY_RE.test(key)) throw new Error(`invalid field key "${key}" (use snake_case: a-z, 0-9, _)`);
    const def = candidate[key];
    if (!def || typeof def !== 'object') throw new Error(`field "${key}" must be an object`);
    if (!VALID_TYPES.has(def.type)) throw new Error(`field "${key}" has invalid type "${def.type}" (string | list | objectList)`);
    if (def.format && !VALID_FORMATS.has(def.format)) throw new Error(`field "${key}" has invalid format "${def.format}"`);

    const clean = { type: def.type, description: String(def.description || '') };
    if (def.format) clean.format = def.format;

    if (def.type === 'objectList') {
      const sub = def.fields;
      if (!sub || typeof sub !== 'object' || !Object.keys(sub).length) {
        throw new Error(`objectList field "${key}" must declare at least one sub-field in "fields"`);
      }
      clean.fields = {};
      for (const subKey of Object.keys(sub)) {
        if (!KEY_RE.test(subKey)) throw new Error(`invalid sub-field key "${subKey}" in "${key}"`);
        const sd = sub[subKey];
        if (!sd || sd.type !== 'string') throw new Error(`sub-field "${key}.${subKey}" must be type "string"`);
        if (sd.format && !VALID_FORMATS.has(sd.format)) throw new Error(`sub-field "${key}.${subKey}" has invalid format "${sd.format}"`);
        clean.fields[subKey] = { type: 'string', description: String(sd.description || '') };
        if (sd.format) clean.fields[subKey].format = sd.format;
      }
      if (def.mergeKey) {
        if (!clean.fields[def.mergeKey]) throw new Error(`mergeKey "${def.mergeKey}" not a sub-field of "${key}"`);
        clean.mergeKey = def.mergeKey;
        clean.mergeMatch = def.mergeMatch === 'category' ? 'category' : 'similar';
      }
    }
    out[key] = clean;
  }
  return out;
}

/** Replace the active FIELDS registry (after validation). Returns the new FIELDS. */
function setFields(candidate) {
  FIELDS = validateFields(candidate);
  return FIELDS;
}

/** Restore the built-in default registry. */
function resetFields() {
  FIELDS = clone(DEFAULT_FIELDS);
  return FIELDS;
}

module.exports = {
  // registry access (runtime-mutable)
  getFields,
  getDefaultFields,
  setFields,
  resetFields,
  validateFields,
  // derived (computed on demand)
  getStringFields,
  getListFields,
  getObjectListFields,
  getObjectListMerge,
  getIpoDetailsSchema,
  getGeminiSchema,
  // constants & helpers
  DEFAULT_VALUE,
  PLACEHOLDERS,
  isPlaceholder,
  normalize,
  canonicalDate,
  canonicalPeriod,
  canonicalCategory,
};
