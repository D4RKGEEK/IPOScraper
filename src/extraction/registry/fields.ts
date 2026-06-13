/**
 * fields.ts — THE Field Registry (PRD §3.5, §10). All knowledge about WHAT to
 * extract lives here; the pipeline iterates the registry and never names a field.
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export type DocType = 'DRHP' | 'RHP' | 'PROSPECTUS' | 'ADDENDUM';

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

export const FIELDS: FieldDef[] = [
  {
    key: 'price_band',
    section: 'offer_structure',
    schema: z.object({ low: z.number().positive(), high: z.number().positive() }),
    description: 'IPO price band in INR per equity share',
    expectedIn: ['RHP', 'PROSPECTUS'],
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
    key: 'lot_size',
    section: 'offer_structure',
    schema: z.number().int().positive(),
    description: 'Minimum bid lot (shares per retail application)',
    expectedIn: ['RHP', 'PROSPECTUS'],
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
    expectedIn: ['DRHP', 'RHP', 'PROSPECTUS'],
    rules: [(v) => ([1, 2, 5, 10].includes(v as number) ? null : `face value ${String(v)} ∉ {1,2,5,10} — misread denomination?`)],
  },
  {
    key: 'issue_open_date',
    section: 'offer_structure',
    schema: isoDate,
    description: 'Bid/offer opening date (YYYY-MM-DD)',
    expectedIn: ['RHP', 'PROSPECTUS'],
  },
  {
    key: 'issue_close_date',
    section: 'offer_structure',
    schema: isoDate,
    description: 'Bid/offer closing date (YYYY-MM-DD)',
    expectedIn: ['RHP', 'PROSPECTUS'],
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
    key: 'listing_date',
    section: 'offer_structure',
    schema: isoDate,
    description: 'Expected listing date on the stock exchanges (YYYY-MM-DD)',
    expectedIn: ['RHP', 'PROSPECTUS'],
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
    schema: z.number().nonnegative(),
    description: 'Fresh issue size in INR crore (₹ Cr)',
    expectedIn: ['DRHP', 'RHP', 'PROSPECTUS'],
  },
  {
    key: 'offer_for_sale_cr',
    section: 'offer_structure',
    schema: z.number().nonnegative(),
    description: 'Offer-for-sale size in INR crore (₹ Cr)',
    expectedIn: ['DRHP', 'RHP', 'PROSPECTUS'],
  },
  {
    key: 'total_issue_cr',
    section: 'offer_structure',
    schema: z.number().positive(),
    description: 'Total issue size in INR crore (₹ Cr)',
    expectedIn: ['DRHP', 'RHP', 'PROSPECTUS'],
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
    key: 'promoter_pct',
    section: 'capital_structure',
    schema: z.number().min(0).max(100),
    description: 'Pre-issue promoter & promoter-group holding %',
    expectedIn: ['DRHP', 'RHP', 'PROSPECTUS'],
  },
  {
    key: 'isin',
    section: 'general_info',
    schema: z.string().regex(/^INE[A-Z0-9]{9}$/),
    description: 'ISIN of the equity shares (format INExxxxxxxxx)',
    expectedIn: ['RHP', 'PROSPECTUS'],
  },
  {
    key: 'registrar',
    section: 'general_info',
    schema: z.string().min(3),
    description: 'Registrar to the offer (company name)',
    expectedIn: ['DRHP', 'RHP', 'PROSPECTUS'],
  },
  {
    key: 'lead_managers',
    section: 'general_info',
    schema: z.array(z.string().min(3)).min(1),
    description: 'Book running lead managers (list of company names)',
    expectedIn: ['DRHP', 'RHP', 'PROSPECTUS'],
  },
  {
    key: 'objects_of_issue',
    section: 'objects',
    schema: z.array(z.string().min(5)).min(1),
    description: 'Objects of the offer/issue — the stated uses of proceeds',
    expectedIn: ['DRHP', 'RHP', 'PROSPECTUS'],
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
