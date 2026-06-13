/**
 * fields.ts — THE Field Registry (PRD §3.5, §10). All knowledge about WHAT to
 * extract lives here; the pipeline iterates the registry and never names a field.
 *
 * Placeholder model (user rule): every field is expected in every doc type. When a
 * value isn't present in this document (e.g. a DRHP carries "₹ [●]" for price band),
 * the field is stored as a PLACEHOLDER ('[.]'), NOT a failure — and a stronger
 * document (RHP → Prospectus) overwrites the placeholder with the real value.
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export type DocType = 'DRHP' | 'RHP' | 'PROSPECTUS' | 'ADDENDUM';

/** Marker stored as the value of a not-yet-available field (replaced by a stronger doc). */
export const PLACEHOLDER = '[.]';

/** Evidence envelope: every value carries a verbatim quote + page number. */
export const envelope = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ value, evidence: z.string().min(8), page: z.number().int().positive() });

export interface FieldDef {
  key: string;
  section: string;
  schema: z.ZodTypeAny;
  description: string;
  expectedIn: Array<'DRHP' | 'RHP' | 'PROSPECTUS'>;
  rules?: Array<(v: unknown, all: Record<string, unknown>) => string | null>;
  highStakes?: boolean;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const dateMs = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};
const num = (all: Record<string, unknown>, key: string): number | null => {
  const v = (all[key] as { value?: unknown } | undefined)?.value ?? all[key];
  return typeof v === 'number' ? v : null;
};

// Every field is expected in every (non-addendum) doc type — missing ⇒ placeholder.
const ALL: Array<'DRHP' | 'RHP' | 'PROSPECTUS'> = ['DRHP', 'RHP', 'PROSPECTUS'];

// ── reusable scalar builders ────────────────────────────────────────────────
const shares = z.number().int().nonnegative();   // a share count
const crore = z.number().nonnegative();           // an amount in ₹ crore
const pct = z.number().min(0).max(100);

// ── nested table schemas (value of a single enveloped field) ─────────────────
const investorSplit = z.object({
  qib_shares: shares.nullable(),
  qib_pct_of_net: pct.nullable(),
  nii_shares: shares.nullable(),
  nii_pct_of_net: pct.nullable(),
  retail_shares: shares.nullable(),
  retail_pct_of_net: pct.nullable(),
  anchor_shares: shares.nullable(),
  employee_shares: shares.nullable(),
  market_maker_shares: shares.nullable(),
  total_shares: shares.nullable(),
});

const anchorBlock = z.object({
  bid_date: isoDate.nullable(),
  shares_offered: shares.nullable(),
  portion_cr: crore.nullable(),
  lockin_50pct_end_date: isoDate.nullable(),
  lockin_90pct_end_date: isoDate.nullable(),
});

const lotTier = z.object({
  category: z.string(),                 // e.g. "Retail (Min)", "S-HNI (Max)"
  lots: z.number().int().nullable(),
  shares: z.number().int().nullable(),
  amount: z.number().nullable(),        // ₹ (absolute, not crore)
});

const financialPeriod = z.object({
  period: z.string(),                   // e.g. "31 Dec 2025"
  assets: z.number().nullable(),
  total_income: z.number().nullable(),
  profit_after_tax: z.number().nullable(),
  ebitda: z.number().nullable(),
  net_worth: z.number().nullable(),
  reserves_and_surplus: z.number().nullable(),
  total_borrowing: z.number().nullable(),
});

const kpiBlock = z.object({
  roce_pct: z.number().nullable(),
  debt_to_equity: z.number().nullable(),
  ronw_pct: z.number().nullable(),
  pat_margin_pct: z.number().nullable(),
  ebitda_margin_pct: z.number().nullable(),
  price_to_book: z.number().nullable(),
  eps_pre: z.number().nullable(),
  eps_post: z.number().nullable(),
  pe_pre: z.number().nullable(),
  pe_post: z.number().nullable(),
});

const objectItem = z.object({ object: z.string(), amount_cr: z.number().nullable() });
const expenseItem = z.object({ item: z.string(), amount_cr: z.number().nullable() });

export const FIELDS: FieldDef[] = [
  // ───────────────────────── offer_structure ─────────────────────────────────
  {
    key: 'price_band',
    section: 'offer_structure',
    schema: z.object({ low: z.number().positive(), high: z.number().positive() }),
    description: 'IPO price band in INR per equity share (low/high). Null if the document shows "[●]".',
    expectedIn: ALL,
    highStakes: true,
    rules: [
      (v) => ((v as { low: number; high: number }).low < (v as { high: number }).high ? null : 'low must be < high'),
      (v) =>
        (v as { high: number }).high <= (v as { low: number }).low * 1.25
          ? null
          : 'wider than SEBI 25% cap — garbled?',
    ],
  },
  {
    key: 'issue_price',
    section: 'offer_structure',
    schema: z.number().positive(),
    description: 'Final issue / cut-off price in INR per equity share (set in the RHP/Prospectus).',
    expectedIn: ALL,
    highStakes: true,
  },
  {
    key: 'lot_size',
    section: 'offer_structure',
    schema: z.number().int().positive(),
    description: 'Minimum bid lot (shares per retail application)',
    expectedIn: ALL,
    highStakes: true,
    rules: [
      (v, all) => {
        const b = (all['price_band'] as { value?: { high?: number } } | undefined)?.value;
        if (!b || typeof b.high !== 'number') return null;
        const a = (v as number) * b.high;
        return a >= 13000 && a <= 16000 ? null : `lot×price ₹${a} outside retail window`;
      },
    ],
  },
  {
    key: 'face_value',
    section: 'offer_structure',
    schema: z.number().positive(),
    description: 'Face value per equity share in INR',
    expectedIn: ALL,
    rules: [(v) => ([1, 2, 5, 10].includes(v as number) ? null : `face value ${String(v)} ∉ {1,2,5,10} — misread denomination?`)],
  },
  {
    key: 'sale_type',
    section: 'offer_structure',
    schema: z.string().min(3),
    description: 'Nature of the offer, e.g. "Fresh issue only", "Offer for sale", or "Fresh issue and OFS"',
    expectedIn: ALL,
  },
  {
    key: 'issue_type',
    section: 'offer_structure',
    schema: z.string().min(3),
    description: 'Issue mechanism, e.g. "Book Built Issue" or "Fixed Price Issue"',
    expectedIn: ALL,
  },
  {
    key: 'listing_at',
    section: 'offer_structure',
    schema: z.string().min(2),
    description: 'Exchange/platform the shares list on, e.g. "NSE SME", "BSE SME", "NSE, BSE"',
    expectedIn: ALL,
  },
  {
    key: 'employee_discount',
    section: 'offer_structure',
    schema: z.number().nonnegative(),
    description: 'Employee discount in INR per share (0 or null if none)',
    expectedIn: ALL,
  },
  {
    key: 'issue_open_date',
    section: 'offer_structure',
    schema: isoDate,
    description: 'Bid/offer opening date (YYYY-MM-DD)',
    expectedIn: ALL,
  },
  {
    key: 'issue_close_date',
    section: 'offer_structure',
    schema: isoDate,
    description: 'Bid/offer closing date (YYYY-MM-DD)',
    expectedIn: ALL,
    rules: [
      (v, all) => {
        const open = dateMs((all['issue_open_date'] as { value?: unknown } | undefined)?.value);
        const close = dateMs(v);
        if (open === null || close === null) return null;
        if (close <= open) return 'close date must be after open date';
        return close - open <= 15 * 864e5 ? null : 'open→close span > 15 days — date confusion?';
      },
    ],
  },
  {
    key: 'anchor_bid_date',
    section: 'offer_structure',
    schema: isoDate,
    description: 'Anchor investor bid date (usually one working day before issue open)',
    expectedIn: ALL,
  },
  {
    key: 'allotment_date',
    section: 'offer_structure',
    schema: isoDate,
    description: 'Expected basis-of-allotment finalisation date (YYYY-MM-DD)',
    expectedIn: ALL,
  },
  {
    key: 'refund_date',
    section: 'offer_structure',
    schema: isoDate,
    description: 'Expected initiation-of-refunds date (YYYY-MM-DD)',
    expectedIn: ALL,
  },
  {
    key: 'credit_date',
    section: 'offer_structure',
    schema: isoDate,
    description: 'Expected credit-of-shares-to-demat date (YYYY-MM-DD)',
    expectedIn: ALL,
  },
  {
    key: 'listing_date',
    section: 'offer_structure',
    schema: isoDate,
    description: 'Expected listing date on the stock exchanges (YYYY-MM-DD)',
    expectedIn: ALL,
    rules: [
      (v, all) => {
        const close = dateMs((all['issue_close_date'] as { value?: unknown } | undefined)?.value);
        const listing = dateMs(v);
        if (close === null || listing === null) return null;
        return listing > close ? null : 'listing date must be after close date';
      },
    ],
  },
  {
    key: 'fresh_issue_cr',
    section: 'offer_structure',
    schema: crore,
    description: 'Fresh issue size in INR crore (₹ Cr) — the ₹ amount, NOT the number of shares',
    expectedIn: ALL,
  },
  {
    key: 'offer_for_sale_cr',
    section: 'offer_structure',
    schema: crore,
    description: 'Offer-for-sale size in INR crore (₹ Cr). 0 if the offer is fresh-issue only',
    expectedIn: ALL,
  },
  {
    key: 'total_issue_cr',
    section: 'offer_structure',
    schema: z.number().positive(),
    description: 'Total issue size in INR crore (₹ Cr) — the ₹ amount, NOT the number of shares',
    expectedIn: ALL,
    rules: [
      (v, all) => {
        const fresh = num(all, 'fresh_issue_cr');
        const ofs = num(all, 'offer_for_sale_cr');
        if (fresh === null || ofs === null) return null;
        const total = v as number;
        const sum = fresh + ofs;
        return Math.abs(sum - total) <= total * 0.01
          ? null
          : `fresh(${fresh}) + OFS(${ofs}) = ${sum} ≠ total(${total}) ±1% — unit error (₹ Cr vs ₹ lakh)?`;
      },
    ],
  },
  {
    key: 'market_maker_shares',
    section: 'offer_structure',
    schema: shares,
    description: 'Number of equity shares reserved for the market maker (SME issues)',
    expectedIn: ALL,
  },
  {
    key: 'net_offer_shares',
    section: 'offer_structure',
    schema: shares,
    description: 'Net number of equity shares offered to the public (after market-maker/employee reservation)',
    expectedIn: ALL,
  },
  {
    key: 'investor_split',
    section: 'offer_structure',
    schema: investorSplit,
    description: 'Issue reservation: shares and % of net issue allocated to QIB, NII (HNI), Retail, Anchor, Employee, Market Maker',
    expectedIn: ALL,
  },
  {
    key: 'anchor',
    section: 'offer_structure',
    schema: anchorBlock,
    description: 'Anchor investor block: bid date, shares offered, ₹ Cr portion, and 30-day / 90-day lock-in end dates',
    expectedIn: ALL,
  },
  {
    key: 'lot_tiers',
    section: 'offer_structure',
    schema: z.array(lotTier).min(1),
    description: 'Application lot table: per investor category (Retail/S-HNI/B-HNI/Employee, Min/Max) the lots, shares and ₹ amount',
    expectedIn: ALL,
  },

  // ───────────────────────── capital_structure ───────────────────────────────
  {
    key: 'promoter_pct',
    section: 'capital_structure',
    schema: pct,
    description: 'Pre-issue promoter & promoter-group holding %',
    expectedIn: ALL,
  },
  {
    key: 'promoter_holding_post_pct',
    section: 'capital_structure',
    schema: pct,
    description: 'Post-issue promoter & promoter-group holding %',
    expectedIn: ALL,
  },
  {
    key: 'promoter_names',
    section: 'capital_structure',
    schema: z.array(z.string().min(2)).min(1),
    description: 'Names of the promoters of the company',
    expectedIn: ALL,
  },
  {
    key: 'shares_pre_issue',
    section: 'capital_structure',
    schema: shares,
    description: 'Total equity shares outstanding before the issue (pre-issue paid-up capital, in shares)',
    expectedIn: ALL,
  },
  {
    key: 'shares_post_issue',
    section: 'capital_structure',
    schema: shares,
    description: 'Total equity shares outstanding after the issue (post-issue paid-up capital, in shares)',
    expectedIn: ALL,
  },

  // ───────────────────────── general_info ────────────────────────────────────
  {
    key: 'isin',
    section: 'general_info',
    schema: z.string().regex(/^INE[A-Z0-9]{9}$/),
    description: 'ISIN of the equity shares (format INExxxxxxxxx)',
    expectedIn: ALL,
  },
  {
    key: 'nse_symbol',
    section: 'general_info',
    schema: z.string().min(2),
    description: 'Stock exchange ticker symbol assigned to the company (e.g. NSE symbol)',
    expectedIn: ALL,
  },
  {
    key: 'registrar',
    section: 'general_info',
    schema: z.string().min(3),
    description: 'Registrar to the offer (company name)',
    expectedIn: ALL,
  },
  {
    key: 'lead_managers',
    section: 'general_info',
    schema: z.array(z.string().min(3)).min(1),
    description: 'Book running lead managers (list of company names)',
    expectedIn: ALL,
  },

  // ───────────────────────── objects ─────────────────────────────────────────
  {
    key: 'objects_of_issue',
    section: 'objects',
    schema: z.array(z.string().min(5)).min(1),
    description: 'Objects of the offer/issue — the stated uses of proceeds (list of descriptions)',
    expectedIn: ALL,
  },
  {
    key: 'objects_with_amounts',
    section: 'objects',
    schema: z.array(objectItem).min(1),
    description: 'Objects of the issue with the estimated amount (₹ Cr) for each object',
    expectedIn: ALL,
  },
  {
    key: 'issue_expenses',
    section: 'objects',
    schema: z.array(expenseItem).min(1),
    description: 'Breakdown of issue expenses (item + estimated ₹ Cr): BRLM fees, advertising, legal, registrar, etc.',
    expectedIn: ALL,
  },

  // ───────────────────────── financials ──────────────────────────────────────
  {
    key: 'financials',
    section: 'financials',
    schema: z.array(financialPeriod).min(1),
    description: 'Restated financials per period (₹ Cr): assets, total income, PAT, EBITDA, net worth, reserves, total borrowing',
    expectedIn: ALL,
  },

  // ───────────────────────── basis_for_price ─────────────────────────────────
  {
    key: 'kpis',
    section: 'basis_for_price',
    schema: kpiBlock,
    description: 'Key performance indicators: ROCE %, debt/equity, RoNW %, PAT margin %, EBITDA margin %, price/book, EPS & P/E (pre & post issue)',
    expectedIn: ALL,
  },
];

export const fieldByKey = (key: string): FieldDef | undefined => FIELDS.find((f) => f.key === key);

/** Sections that actually carry registry fields (drives the locator + ladder). */
export const REGISTRY_SECTIONS = [...new Set(FIELDS.map((f) => f.section))];

/**
 * Build the JSON schema sent to Firecrawl/DeepSeek: each field wrapped in the
 * evidence envelope. `$refStrategy: 'none'` is REQUIRED — the envelope is reused
 * across fields, so the default emits a `$ref`, and Firecrawl silently returns NO
 * json when the schema contains `$ref`. Inlining every field fixes extraction.
 */
export function schemaFor(defs: FieldDef[]): object {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const d of defs) {
    shape[d.key] = envelope(d.schema.nullable()).describe(d.description);
  }
  return zodToJsonSchema(z.object(shape), { $refStrategy: 'none' });
}
