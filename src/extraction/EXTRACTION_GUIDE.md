# Extraction Guide — Adding Fields & Sections

This is the playbook for evolving the IPO extraction pipeline: adding a new
**field** to the output, adding a new **section** to read from the PDF, and
understanding how the three engines (Firecrawl / Gemini / DeepSeek) return data.

> **The golden rule:** the output format lives in **one file** —
> [`llm/schema.js`](./llm/schema.js). Edit the `FIELDS` object there and the new
> field flows automatically to every engine, the merge step, and the
> normalizer. You almost never touch anything else to add a field.

---

## 0. START HERE — before you ask for a new field

Whenever you (or Claude) want to add/extract something new, **provide these three
things first**. Without them the work is guesswork.

```
1. SAMPLE PDF
   A link or local path to a real DRHP/RHP PDF that contains the data.
   e.g. https://.../leapfrog-rhp.pdf   or   data/pdfs/leapfrog.pdf

2. WHAT DATA YOU WANT
   Describe the field(s) in plain words + a real example value.
   e.g. "Market Maker name" → "Anant Securities"
        "EBITDA per period" → "20.18 (₹ Cr)"

3. WHERE IT LIVES IN THE PDF
   Which section / page heading it appears under (if you know).
   e.g. "in the 'Basis for Offer Price' section" or "on the cover page"
   If you don't know, say so — we can locate it.
```

Paste that as the request. Everything below explains what happens next.

---

## 1. How the pipeline works (30-second tour)

```
PDF
 │
 ├─ 1. LOCATE      locate/index.js   → find page ranges for target sections
 │                 (regex ToC → LLM ToC → offset correction → LLM page-scan)
 │
 ├─ 2. CONVERT     convert/pdf-bridge.js (pymupdf4llm) → per-section markdown
 │
 ├─ 3. EXTRACT     one of:
 │     • Firecrawl  extract/firecrawl.js  — per-section calls, JSON schema
 │     • Gemini     extract/gemini.js     — one big call (1M context), response_schema
 │     • DeepSeek   index.js              — JSON schema embedded in the prompt
 │
 ├─ 4. MERGE       extract/merge.js       → fold Firecrawl's per-section results into one
 │
 └─ 5. NORMALIZE   llm/schema.js normalize() → force EXACT shape + fill defaults + canonicalize
```

All four engines read the **same schema** derived from `FIELDS`. The cascade
(default `pipeline: 'cascade'`) tries Firecrawl → Gemini → DeepSeek and keeps the
first "proper" result, then normalizes it.

---

## 2. Adding a new FIELD (the common case)

### Step 1 — add one line to `FIELDS` in [`llm/schema.js`](./llm/schema.js)

Pick a `type` and (optionally) a `format`:

| `type`        | Use for…                                  | Output shape           |
|---------------|-------------------------------------------|------------------------|
| `'string'`    | a single value                            | `"…"`                  |
| `'list'`      | a list of text values                     | `["…", "…"]`           |
| `'objectList'`| a table (rows with sub-fields)            | `[{…}, {…}]`           |

| `format`      | Forces the value into…                    | Example                |
|---------------|-------------------------------------------|------------------------|
| `'date'`      | ISO date                                  | `2025-05-31`           |
| `'period'`    | ISO date OR fiscal label                  | `2025-12-31`, `9M FY2025` |
| `'percent'`   | trimmed percentage                        | `21.03%`               |
| `'currency'`  | ₹ symbol + standard units                 | `₹326.12 Cr`           |
| `'category'`  | canonical investor category               | `QIB`, `NII (HNI)`     |
| *(omitted)*   | free text — only trimmed                  | `"…"`                  |

**Example — a simple string field:**
```js
// in FIELDS
order_book: { type: 'string', format: 'currency', description: 'Order book value as of latest date (e.g., "₹384.03 Cr")' },
```

**Example — a new table (objectList):**
```js
shareholding_pattern: {
  type: 'objectList',
  description: 'Shareholding by holder category',
  fields: {
    holder:  { type: 'string', description: 'Holder/category name' },
    pct_pre: { type: 'string', format: 'percent', description: '% holding pre-issue' },
    pct_post:{ type: 'string', format: 'percent', description: '% holding post-issue' },
  },
},
```

### Step 2 — that's usually it.

Adding the line automatically updates:
- `IPO_DETAILS_SCHEMA` / `GEMINI_SCHEMA` (what the LLMs are told to return)
- `STRING_FIELDS` / `LIST_FIELDS` / `OBJECT_LIST_FIELDS` (what merge.js handles)
- `normalize()` (shape enforcement + default `[-]` + canonicalization)

### Step 3 — only if it's a keyed table

If your new `objectList` should **merge rows across sections** by a key (like
`financials` merges by `period`, `reservations` by `category`), add a rule in
[`extract/merge.js`](./extract/merge.js) → `OBJECT_LIST_MERGE`:

```js
const OBJECT_LIST_MERGE = {
  financials:   { key: 'period',   match: 'similar' },   // fuzzy period match
  kpis:         { key: 'period',   match: 'similar' },
  reservations: { key: 'category', match: 'category' },  // synonym match
  subscription: { key: 'category', match: 'category' },
  // shareholding_pattern: { key: 'holder', match: 'similar' },  // ← add here
};
```
If you don't add a rule, rows are just de-duplicated (exact duplicates removed) —
fine for most tables.

### Step 4 — make sure the data is actually SENT (recall)

A field can only be filled if the **section containing it is converted and sent
to the engine**. See §4. If the relevant section isn't in `TARGET_SECTIONS`, the
field will correctly come back as `[-]` — the shape is right, but the data was
never seen.

---

## 3. Which field comes from which PDF section

Use this when adding a field, to know which section must be enabled in
`TARGET_SECTIONS`. Section keys are defined in
[`config.js`](./config.js) → `SECTION_ALIASES`.

| Field(s)                                              | Prospectus section (key)                          |
|-------------------------------------------------------|---------------------------------------------------|
| company_name, description, incorporation, office, website | ABOUT_THE_COMPANY / HISTORY_AND_CERTAIN_CORPORATE_MATTERS / cover |
| sector, services, competitive_strengths, business_strategies, employee_count | OUR_BUSINESS |
| promoters, promoter_holding_pre/post                  | OUR_PROMOTERS_AND_PROMOTER_GROUP, CAPITAL_STRUCTURE |
| issue_type, sale_type, listing_at, face_value, price_band, lot_size | cover pages / GENERAL_INFORMATION |
| total/fresh/OFS issue sizes, market_maker, net_offer, shareholding pre/post | CAPITAL_STRUCTURE / ISSUE_STRUCTURE |
| reservations, lot_size_options                        | ISSUE_STRUCTURE / ISSUE_PROCEDURE                 |
| objects_of_the_offer                                  | OBJECTS_OF_THE_OFFER                              |
| financials (assets, income, PAT, EBITDA, net worth, borrowings) | RESTATED_FINANCIAL_STATEMENTS / OTHER_FINANCIAL_INFORMATION |
| kpis (ROE, ROCE, D/E, margins), eps_pre/post, pe_pre/post | BASIS_FOR_OFFER_PRICE                         |
| lead_managers, registrar, contact_*                   | GENERAL_INFORMATION / cover                       |
| risk_factors                                          | RISK_FACTORS                                      |
| **dates, GMP, subscription, listing_gain, peer_comparison, recommendations, review, market_cap** | **NOT in the prospectus — market/aggregator data; fill from another source** |

---

## 4. Adding a new SECTION to read

If a field needs a section we don't currently extract:

### Step 1 — make sure the section is known
Check [`config.js`](./config.js) → `SECTION_ALIASES`. Each key maps to lowercase
heading aliases matched against the PDF's Table of Contents. If your section
isn't there, add it:
```js
// in SECTION_ALIASES
DIVIDEND_POLICY: ["dividend policy"],
```
Add every realistic heading spelling — the ToC matcher does substring matching.

### Step 2 — turn it on
Add the key to `TARGET_SECTIONS` in [`config.js`](./config.js):
```js
const TARGET_SECTIONS = ["RISK_FACTORS", "CAPITAL_STRUCTURE", "OBJECTS_OF_THE_OFFER", "OUR_BUSINESS", "DIVIDEND_POLICY"];
```

### Step 3 — understand the cost
Each section = more pages converted to markdown and sent to the engine:
- **Firecrawl**: one extra API call per section (more credits).
- **Gemini**: more tokens in the single call (1M context — usually fine).
- **DeepSeek**: more tokens in the merged prompt.

So enable only the sections you actually need fields from.

### How sections get located (FYI)
[`locate/index.js`](./locate/index.js) runs a cheapest-first cascade:
1. **Regex ToC** ([`locate/toc-regex.js`](./locate/toc-regex.js)) — free; parses the Table of Contents.
2. **LLM ToC** ([`locate/toc-llm.js`](./locate/toc-llm.js)) — for sections regex missed.
3. **Offset correction** ([`locate/offset.js`](./locate/offset.js)) — printed page ≠ PDF index.
4. **LLM page-scan** ([`locate/page-scan.js`](./locate/page-scan.js)) — last resort, scans the whole doc.

---

## 5. How each engine returns the schema

All three are told to return the **same `FIELDS`-derived schema**. They differ in
*how* the schema is delivered:

### Firecrawl — [`extract/firecrawl.js`](./extract/firecrawl.js)
- Converts each section's markdown → styled HTML → uploads to `/v2/parse`.
- Passes `IPO_DETAILS_SCHEMA` in the request `options.formats[].schema`.
- Runs **per section** (4–5 calls), so each call returns *partial* data.
- Results are combined by [`extract/merge.js`](./extract/merge.js) `mergeSectionResponses()`.

### Gemini — [`extract/gemini.js`](./extract/gemini.js)
- Merges **all** section markdown into one text (1M context window).
- Passes `GEMINI_SCHEMA` as the model's `response_schema` (type-enforced JSON).
- **One call** → one complete object. No merge needed.

### DeepSeek — [`index.js`](./index.js) `runDeepSeekExtraction()`
- Reads `merged.md` (or concatenates section files).
- Embeds `JSON.stringify(IPO_DETAILS_SCHEMA)` directly in the prompt and asks
  for raw JSON back.
- Used as the final fallback in the cascade.

### After any engine → NORMALIZE
Whatever comes back is passed through `normalize()` in
[`llm/schema.js`](./llm/schema.js) before saving. This guarantees:
- every field present (extra keys dropped),
- missing scalars → `[-]`, missing lists → `[]`,
- values canonicalized per their `format` (dates → ISO, etc.).

> Tip: missing fields are **not** counted as "found" by `isExtractionProper()`
> in [`index.js`](./index.js) — `[-]` / `N/A` / `null` are treated as empty, so
> the Firecrawl→Gemini→DeepSeek fallback still triggers correctly.

---

## 6. Quick checklist for "add a new field X"

1. [ ] Got a **sample PDF**, an **example value**, and the **section** it's in? (§0)
2. [ ] Add one line to `FIELDS` in `llm/schema.js` — pick `type` + `format`. (§2.1)
3. [ ] New keyed table? Add an `OBJECT_LIST_MERGE` rule in `merge.js`. (§2.3)
4. [ ] Is the field's section in `TARGET_SECTIONS`? If not, add it + its aliases. (§4)
5. [ ] Run an extraction on the sample PDF and confirm the field is populated.
6. [ ] If it's `[-]`, the data wasn't seen → check section coverage / aliases / prompt.

That's the whole loop. The format is one file; the recall is `TARGET_SECTIONS`.
