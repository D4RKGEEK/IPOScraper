# IPO Document Extraction Pipeline — Architecture & PRD

**Version:** 2.1 (self-contained — supersedes v1.0 and v2.0; no other document is needed)
**Status:** Ready for implementation
**Target reader:** A developer or coding LLM implementing this system end-to-end.

**Changes from v1.0:**
- Ingest is now **API-driven**: your scraper API supplies PDF links; this service fetches them.
- **MongoDB is the database** (state machine, progress, structured IPO data, review queue). R2 is demoted to a small, clean, self-cleaning blob store.
- **Markdown-first extraction:** Firecrawl `/parse` receives locally-generated `.md` files (cheap) instead of PDFs (expensive). The mini-PDF survives only as the garbled-table fallback.
- Full **REST API** with detailed progress responses, retry, and human-review resolution endpoints.
- **R2 retention policy + janitor** — nothing lives in R2 longer than it must.
- New feature: **IPO-level merge** — DRHP/RHP/Prospectus of the same company merge into one canonical IPO record with precedence rules.

---

## 1. Problem statement

We receive Indian IPO documents (DRHP, RHP, Prospectus, Addendums) as PDF links from an upstream scraper API. Documents are 300–800 pages with inconsistent layouts. We must extract a fixed (but extensible) set of structured fields into clean, verified JSON stored in MongoDB, with the entire lifecycle driven and observable through a REST API.

Previous attempts failed for one root cause: **treating the whole 500-page document as a single extraction problem.** Regex breaks on layout variance, whole-document conversion blows LLM context, and one-shot extraction calls drown the model. v2 additionally fixes two operational problems: a messy, ever-growing R2 bucket, and Firecrawl credits burning on expensive PDF parsing when cheap text formats suffice.

### Success criteria

1. **Never silently wrong.** Every field is either extracted with verifiable evidence and passing validation, or explicitly flagged `needs_review` with a page reference and review image. A wrong value saved as correct is the only true failure of this system.
2. **Cost-minimized.** mupdf (free, local) does everything possible. Firecrawl gets small `.md` files, not PDFs, except as last-resort fallback. DeepSeek (own money) fires only on failures. R2 stays inside the free tier forever via aggressive cleanup.
3. **Runs on Railway 500 MB RAM / 1 vCPU.** No local ML, no PyTorch, no Docling.
4. **API-first.** Submit by URL, poll detailed progress (stage, per-field status, layer used, timings, errors), fetch results, retry, resolve reviews — all over HTTP. The service has no other interface.
5. **Extensible in minutes.** New field = one registry entry. New doc type = one classifier row.
6. **Crash-safe.** Any restart resumes from the last completed unit of work. Mongo is the single source of truth for state.
7. **Clean R2, always.** Fixed three-prefix layout, every object has a defined lifespan, a janitor enforces it, and a lifecycle rule is the safety net. The bucket is inspectable at a glance at any time.

---

## 2. Stack

| Component | Role | Cost |
|---|---|---|
| **Node.js + TypeScript** on Railway (500 MB / 1 vCPU) | API server + queue worker in one process. | Existing plan |
| **MongoDB** (existing) | **Source of truth**: document state machine, per-field progress, final structured IPO data, review queue, audit log. | Existing |
| **Cloudflare R2** (free tier) | **Blob store only**: original PDFs (temporarily), review PNGs (temporarily). Nothing else, nothing forever. | Free tier |
| **mupdf (npm, WASM)** | Local PDF engine: bookmarks, ToC, text, font metadata, **markdown generation**, page splitting, page→PNG. | Free |
| **Firecrawl** — `/parse` | **Primary extractor.** Receives small per-section **`.md` files** with a JSON schema. Mini-PDF only as table-rescue fallback. `/scrape` available for HTML sources (anchor circulars). | Pre-paid credits |
| **DeepSeek** (`deepseek-chat`, JSON mode) | **Fallback brain** + ToC locator fallback. | Own money — minimized |
| **zod** + `zod-to-json-schema` | Validation + schema generation for Firecrawl/DeepSeek. | Free |
| **Fastify** (or Express) | The REST API. | Free |

**Deliberately excluded:** Docling (~8 GB RAM — impossible here), local OCR, vision models (DeepSeek is text-only; Firecrawl's PDF parse covers messy layouts), Redis/queues (Mongo + a polling loop is enough at this scale).

---

## 3. Core principles

### 3.1 Locate, then extract
SEBI's ICDR format means target fields live in ~30–40 pages out of 500, under predictable section names. mupdf finds those pages locally and free. Paid services only ever see those pages. This cuts cost, latency, and failure surface by ~95%.

### 3.2 Cheapest representation first
The same section is sent up a cost ladder of *representations*, not just services:
```
local raw text (free)  →  local .md file to Firecrawl /parse (cheap credits)
                       →  raw text to DeepSeek (fractions of a cent)
                       →  mini-PDF to Firecrawl /parse (expensive credits — table rescue only)
```
PDF parsing is Firecrawl's costliest mode; a 5-page section as `.md` is a few KB of text and meters far cheaper. We only pay PDF price when the local text of a page is provably garbled.

### 3.3 Evidence or it didn't happen
Every value carries a verbatim quote + page number, verified against locally-extracted text. A model cannot fabricate a quote that string-matches the source. Unverifiable values are rejected no matter how plausible.

### 3.4 Mongo is truth, R2 is a workbench
Anything queryable (state, progress, results, reviews, stats) lives in MongoDB. R2 holds only binary blobs that Mongo can't hold, each with a declared lifespan, enforced by a janitor. If R2 were wiped tonight, you'd lose only in-flight work and unreviewed PNGs — every result and every state survives in Mongo.

### 3.5 The Field Registry
All knowledge about *what* to extract lives in one declarative file (`fields.ts`). The pipeline iterates the registry and never names a field. Adding a field never touches pipeline code.

### 3.6 Everything through the API
No manual bucket uploads, no console poking. Submit → poll → fetch → retry → resolve, all HTTP. The API responses are intentionally verbose: stage, percentage, per-field ladder position, timings, errors, costs.

---

## 4. System diagram

```
 ┌──────────────────┐   POST /documents {pdfUrl, source}
 │ YOUR SCRAPER API │ ─────────────────────────────────────┐
 │ (finds PDF links │                                       │
 │  on BSE/SEBI/…)  │                                       ▼
 └──────────────────┘                     ┌─────────────────────────────────────┐
                                          │   RAILWAY SERVICE (one process)     │
 ┌──────────────────┐  GET /documents/:id │                                     │
 │  YOU / FRONTEND  │ ◄──────────────────►│  ┌──────────┐      ┌─────────────┐  │
 │  poll progress,  │  GET /ipos/:id      │  │ REST API │      │ QUEUE WORKER│  │
 │  resolve reviews │  POST …/review      │  │ (Fastify)│◄────►│ (sequential)│  │
 └──────────────────┘                     │  └────┬─────┘      └──────┬──────┘  │
                                          └───────┼───────────────────┼─────────┘
                          state, results, reviews │                   │ blobs (pdf, png)
                                                  ▼                   ▼
                                     ┌────────────────────┐   ┌──────────────────┐
                                     │      MONGODB       │   │   R2 (3 prefixes │
                                     │ documents          │   │    only, janitor │
                                     │ ipos (merged)      │   │    cleaned)      │
                                     │ review_queue       │   │ pdf/  work/      │
                                     │ events (audit)     │   │ review/          │
                                     └────────────────────┘   └──────────────────┘
                                                  worker calls out ▼
                                          ┌───────────────┐   ┌───────────────┐
                                          │   FIRECRAWL   │   │   DEEPSEEK    │
                                          │ /parse (.md   │   │ deepseek-chat │
                                          │  primary, PDF │   │  (fallback)   │
                                          │  fallback)    │   │               │
                                          └───────────────┘   └───────────────┘
```

API server and worker run in the same Node process (a 500 MB box doesn't want two). The worker is a loop that claims the oldest queued document from Mongo; the API just reads/writes Mongo and R2.

---

## 5. R2 — clean layout, retention, and the janitor

### 5.1 The only three prefixes that may ever exist

```
pdf/{hash}.pdf                  original document        ← deleted after doc reaches a terminal state*
work/{hash}/{section}.md        section markdown          ← deleted the moment the section finishes
work/{hash}/{section}.pdf       mini-PDF (fallback only)  ← deleted the moment the section finishes
review/{hash}/{field}.png       human-review page render  ← deleted when the review is resolved
```

*Terminal states: `done`, `done_with_review` (original kept until all reviews resolved, then deleted — the PNGs are enough), `failed_poison` (original kept 7 days for debugging, then deleted; the source URL in Mongo lets you re-fetch anytime).

Nothing else is allowed in the bucket. No results, no state, no located maps, no logs — all of that is Mongo. If `list()` ever shows a fourth prefix, something is broken.

### 5.2 Retention policy table

| Object | Created at | Deleted at | Worst-case lifespan | Safety net (R2 lifecycle rule) |
|---|---|---|---|---|
| `pdf/{hash}.pdf` | ingest | terminal state (+7 d if poison) | ~10 min typical | expire after 14 days |
| `work/{hash}/*` | section start | section end (janitor sweeps doc end too) | minutes | expire after 2 days |
| `review/{hash}/*.png` | field hits review floor | review resolved via API | until you review | expire after 30 days |

Set the three lifecycle rules once in the Cloudflare dashboard (prefix-scoped expiry). They cost nothing and guarantee the bucket self-heals even if the janitor never runs — a crashed worker can't leak storage.

### 5.3 The janitor

A 30-line function, runs (a) inline at the end of every document, (b) on a timer every 6 h:

```typescript
// src/janitor.ts
export async function janitor(r2: R2, db: Db) {
  // 1. work/ for any doc in a terminal state → delete all
  // 2. pdf/  for docs done + reviews resolved, or poison older than 7d → delete
  // 3. review/ PNGs whose review_queue entry is resolved → delete
  // 4. orphans: any {hash} in R2 with no Mongo document → delete (covers manual mess)
  // 5. log freed bytes to events collection
}
```

Rule 4 is what cleans up your **existing mess**: on first deploy, run the janitor once in `--dry-run` to see what it would delete, migrate anything you want to keep into Mongo or the new layout, then run it for real. From that day the bucket is permanently tidy.

### 5.4 Free-tier math
Free tier = 10 GB. Steady state: ~1–3 in-flight PDFs (≤ 50 MB) + work files (≤ 5 MB) + pending review PNGs (≤ a few MB). You will sit under 0.1 GB forever. Class A/B operations at this volume are also comfortably free.

---

## 6. MongoDB — collections and schemas

### 6.1 `documents` — one per PDF, the state machine

```jsonc
{
  "_id": "ab3f12…",                       // SHA-256 of the PDF = identity
  "sourceUrl": "https://www.sebi.gov.in/…/xyz_rhp.pdf",
  "sourceMeta": { "scrapedBy": "your-scraper", "ipoSlug": "xyz-ltd" },
  "fileName": "xyz_rhp.pdf",
  "sizeBytes": 18234567,
  "pageCount": 512,
  "docType": "RHP",                        // DRHP | RHP | PROSPECTUS | ADDENDUM | UNKNOWN
  "isScanned": false,

  "status": "extracting",                  // queued | fetching | classifying | locating |
                                           // extracting | validating | done |
                                           // done_with_review | failed_poison
  "progress": {                            // what the API serves — always current
    "percent": 62,
    "stage": "extracting",
    "stageDetail": "section capital_structure (4/9)",
    "fieldsTotal": 20, "fieldsValidated": 11, "fieldsReview": 1,
    "fieldsPending": 8, "fieldsNotExpected": 3
  },
  "stages": {
    "fetched":    { "done": true, "at": ISODate, "ms": 4100 },
    "classified": { "done": true, "at": ISODate, "ms": 300 },
    "located":    { "done": true, "at": ISODate, "ms": 2800,
                    "map": { "capital_structure": { "start": 84, "end": 92,
                              "method": "bookmarks", "confidence": 0.97 }, … } },
    "extracted":  { "done": false },
    "validated":  { "done": false }
  },
  "fields": {
    "price_band": { "status": "validated", "layer": "firecrawl_md", "attempts": 1,
                    "value": { "low": 95, "high": 100 },
                    "evidence": "Price Band: ₹95 to ₹100 per Equity Share", "page": 312 },
    "promoter_pct": { "status": "in_ladder", "layer": "deepseek_text", "attempts": 2,
                      "lastError": "evidence_mismatch" }
  },
  "cost": { "firecrawlMdCalls": 7, "firecrawlPdfCalls": 1, "deepseekTokens": 9120 },
  "error": null,
  "lockedBy": null, "lockedAt": null,      // worker claim (single worker → trivial, but safe)
  "createdAt": ISODate, "updatedAt": ISODate, "wallDeadline": ISODate
}
```
Indexes: `{status: 1, createdAt: 1}` (queue claim), `{sourceUrl: 1}` unique (dedupe by URL), `{"sourceMeta.ipoSlug": 1}`.

### 6.2 `ipos` — one per IPO, the merged canonical record (NEW FEATURE)

A company files a DRHP, then an RHP, then a Prospectus — three documents, one IPO. After every document completes, a merge step upserts the IPO record with **precedence: PROSPECTUS > RHP > DRHP > ADDENDUM-patches**, field by field. Newer/stronger documents overwrite; gaps fall through to older ones. Every field remembers which document it came from.

```jsonc
{
  "_id": "xyz-ltd-2026",                   // ipoSlug from your scraper, or derived
  "company": "XYZ Ltd",
  "isin": "INE123A01016",
  "fields": {
    "price_band": { "value": { "low": 95, "high": 100 }, "fromDoc": "ab3f12…",
                    "fromType": "RHP", "page": 312 },
    "promoter_pct": { "value": 64.2, "fromDoc": "9c01ee…", "fromType": "DRHP", "page": 86 }
  },
  "documents": [ { "hash": "9c01ee…", "type": "DRHP", "processedAt": ISODate },
                 { "hash": "ab3f12…", "type": "RHP",  "processedAt": ISODate } ],
  "completeness": { "expected": 20, "filled": 19, "needsReview": 1 },
  "updatedAt": ISODate
}
```
This is the collection your product reads. Documents are plumbing; IPOs are the data.

### 6.3 `review_queue` — humans resolve in seconds

```jsonc
{
  "_id": ObjectId, "docHash": "ab3f12…", "field": "promoter_pct",
  "pages": [86, 87], "bestGuess": 64.2, "lastError": "source_disagreement",
  "candidates": { "firecrawl_md": 64.2, "deepseek_text": 46.2 },
  "imageKey": "review/ab3f12…/promoter_pct.png",
  "status": "open",                        // open | resolved | dismissed
  "resolvedValue": null, "resolvedBy": null, "resolvedAt": null
}
```

### 6.4 `events` — append-only audit log
Every stage transition, every ladder attempt, every janitor sweep: `{at, docHash, kind, detail}`. Capped collection (e.g. 50 MB) so it can never grow unbounded. This is what you read when you ask "why did field X end up in review?"

---

## 7. The REST API

All responses are detailed by design. Base path `/v1`. Auth: a single `X-API-Key` header (env var) — this is an internal service.

### 7.1 `POST /documents` — submit a PDF by link
```jsonc
// request
{ "pdfUrl": "https://…/xyz_rhp.pdf", "ipoSlug": "xyz-ltd-2026", "meta": { … } }
// 202 response
{ "documentId": "ab3f12…", "status": "queued", "deduped": false,
  "statusUrl": "/v1/documents/ab3f12…" }
```
Dedupe: if `sourceUrl` already exists → return the existing document with `"deduped": true` (re-submit forces nothing). If the URL is new but the fetched bytes hash to a known document → link the new URL to it, same response. **A document is never processed twice.**

### 7.2 `GET /documents/:id` — the detailed progress answer (your main poll)
Returns the full `documents` record shape from §6.1 minus internal lock fields, plus computed extras:
```jsonc
{
  "documentId": "ab3f12…", "docType": "RHP", "status": "extracting",
  "progress": { "percent": 62, "stage": "extracting",
                "stageDetail": "section capital_structure (4/9)",
                "etaSeconds": 38,
                "fields": { "total": 20, "validated": 11, "needsReview": 1,
                            "pending": 8, "notExpected": 3 } },
  "timeline": [ { "stage": "fetched", "at": "…", "ms": 4100 },
                { "stage": "classified", "at": "…", "ms": 300 },
                { "stage": "located", "at": "…", "ms": 2800, "method": "bookmarks" } ],
  "fields": { "price_band": { "status": "validated", "layer": "firecrawl_md",
                              "value": { "low": 95, "high": 100 }, "page": 312 },
              "promoter_pct": { "status": "in_ladder", "layer": "deepseek_text",
                                "attempts": 2, "lastError": "evidence_mismatch" } },
  "cost": { "firecrawlMdCalls": 7, "firecrawlPdfCalls": 1, "deepseekTokens": 9120 },
  "links": { "result": "/v1/documents/ab3f12…/result", "events": "/v1/documents/ab3f12…/events" }
}
```
Percent = stage weights (fetch 5, classify 5, locate 15, extract 65 × fieldsDone/fieldsTotal, validate+persist 10). `etaSeconds` = rolling average per remaining field.

### 7.3 The rest of the surface

| Endpoint | Purpose |
|---|---|
| `GET /documents?status=…&ipoSlug=…&page=…` | List/filter documents |
| `GET /documents/:id/result` | Final per-document fields (404-with-status if not terminal) |
| `GET /documents/:id/events` | Audit trail for debugging |
| `POST /documents/:id/retry` | Re-enqueue: only non-validated fields re-enter the ladder; `{"force": true}` wipes and redoes everything |
| `GET /ipos/:slug` | **The merged canonical IPO record** (what your product consumes) |
| `GET /ipos?completeness.needsReview=…` | List IPOs |
| `GET /reviews?status=open` | Review queue with presigned PNG URLs (15-min expiry, generated on read) |
| `POST /reviews/:id/resolve` | `{ "value": 64.2 }` → validates against the field's zod schema + rules, writes to document + ipo, deletes PNG, closes review. `{"dismiss": true}` to mark not-extractable. |
| `GET /stats` | Totals, per-layer win rates, avg cost/doc, review rate — your improvement dashboard |
| `GET /health` | Mongo ping, R2 ping, queue depth, memory RSS |
| `POST /admin/janitor` | Trigger sweep manually; `?dryRun=1` lists what would be deleted |

Optional: `webhookUrl` in the submit body → POST the §7.2 payload on every status change, so your scraper API can push instead of poll.

---

## 8. Pipeline stages

### S1 — Fetch & ingest (from your scraper API's link)
1. `POST /documents` stores a `queued` record keyed by `sourceUrl`. Worker claims it (`lockedBy` + `lockedAt`; stale locks > 15 min are reclaimable).
2. Download the PDF (stream → `/tmp`, 3 retries, 120 s timeout, max 100 MB). Dead link → `failed_poison: source_unreachable` (retryable later via `/retry` — the URL is saved).
3. SHA-256 → `_id`. Byte-level dedupe (same file, new URL) → link and stop.
4. Upload to `r2:pdf/{hash}.pdf`. Guards: opens in mupdf; not encrypted; page-1 text > 50 chars else `isScanned: true`.

### S2 — Classify

Read text of pages 1–3, uppercase it, match in priority order:

| Match | docType | Fields NOT expected (skip, don't fail) |
|---|---|---|
| `DRAFT RED HERRING` | `DRHP` | price_band, lot_size, all dates, anchor data |
| `RED HERRING PROSPECTUS` | `RHP` | final_price, total_subscription |
| `PROSPECTUS` (without RED HERRING) | `PROSPECTUS` | — (everything expected) |
| `ADDENDUM` / `CORRIGENDUM` | `ADDENDUM` | dynamic — extract only what's present |

**Why this matters:** a DRHP has no price band by law. Without classification the pipeline reports fake failures on fields that were never in the document, poisoning metrics and wasting fallback spend. Unexpected fields are marked `not_expected` — never failures.

### S3 — Locate (the cascade)

Output: a verified section → page-range map, written to `documents.stages.located.map` in Mongo (queryable state, cached forever — re-extraction never re-locates). Each layer runs only if the previous left sections unresolved.

**L-A. Embedded bookmarks** (free, instant, ~60–70% of docs)
`doc.loadOutline()` → `[{title, page}]`. Fuzzy-match titles against the alias dictionary (normalized token-sort similarity ≥ 0.82). Bookmark pages are already PDF indices — no offset problem.

**L-B. Printed ToC page** (free, fast)
Scan pages 1–8 for a page whose text has ≥ 5 lines matching `/^(.{4,80}?)\.{3,}\s*(\d{1,3})$/m` (title, dot leaders, page number). Parse into `[title, printedPage]`.
**Offset correction:** printed page numbers ≠ PDF indices (cover + roman-numeral prelims shift everything). Take the most distinctive resolved title (e.g. "BASIS FOR OFFER PRICE"), find the actual page whose first 300 chars contain it as a heading, compute `offset = pdfIndex − printedPage`, apply to all entries. One anchor fixes the whole map.

**L-C. Font-heuristic heading scan** (free, ~1–2 s for 500 pages)
For each page, read the first text block's spans via structured text. A span is a heading candidate if: bold-weight font OR all-caps, AND font size ≥ 1.25 × document median, AND y-position in the top 20% of the page. Fuzzy-match candidates against aliases.

**L-D. DeepSeek locator** (~$0.0005, fires on maybe 1 doc in 10)
Send the raw ToC text (or the heading-candidate list — both tiny, < 2K tokens) with the canonical section list. Prompt: *"Map each canonical section to its starting page number. Return strict JSON. Use null if a section is absent."* Naming weirdness the alias list has never seen gets absorbed here. Every L-D rescue logs a suggested alias line to `events`.

**L-E. Verification (mandatory, free — runs on every resolved section regardless of layer)**
Expand each range by ±2 pages (content spills past headings). Check the range's text contains the section's anchor keywords (e.g. capital structure → "PROMOTER" and "EQUITY SHARES"). Fail → drop to the next layer for that section. If all layers fail → every field in that section is born `needs_review`. **An unverified location never feeds the extractor.**

**Alias dictionary** (`aliases.yaml`) — the self-improving part:

```yaml
capital_structure:
  - CAPITAL STRUCTURE
offer_structure:
  - OFFER STRUCTURE
  - ISSUE STRUCTURE
  - TERMS OF THE OFFER
  - TERMS OF THE ISSUE
basis_for_price:
  - BASIS FOR OFFER PRICE
  - BASIS FOR ISSUE PRICE
objects:
  - OBJECTS OF THE OFFER
  - OBJECTS OF THE ISSUE
promoters:
  - OUR PROMOTERS
  - PROMOTERS AND PROMOTER GROUP
financials:
  - RESTATED FINANCIAL STATEMENTS
  - RESTATED FINANCIAL INFORMATION
  - FINANCIAL STATEMENTS
```

When a new document fails location, the fix is appending one line here — never code. The vocabulary is finite (SEBI mandates it); expect convergence within ~30 documents.

### S4 — Extract: the v2 ladder (markdown-first)

Per section with unresolved expected fields:

**Step 0 — build the section's representations locally (free):**
- `sectionText` — mupdf raw text with `--- page N ---` markers (evidence ground truth).
- `section.md` — locally generated markdown (§9): headings from font sizes, tables from mupdf's structured-text geometry where clean, page markers preserved. A few KB.

**Layer 1 — Firecrawl `/parse` with the `.md` FILE (primary — cheap credits).**
Upload nothing to R2 for this; send the markdown file directly in the multipart body with `formats: [{type:"json", schema}]` (schema = this section's fields, each wrapped in the evidence envelope). Text formats meter far cheaper than PDF pages. Verify evidence against `sectionText`, run zod + rules. Pass → done.

**Layer 2 — DeepSeek on `sectionText` (fallback 1 — fractions of a cent).**
Widened ±3 pages. If retrying, the previous failure reason is included in the prompt ("returned X, failed because Y"). Verify + validate.

**Layer 3 — mini-PDF to Firecrawl `/parse` (fallback 2 — the expensive one, used surgically).**
This fires only when local text itself is the problem (garbled table → evidence keeps failing on both L1 and L2, or `isScanned`). mupdf cuts pages [start..end] into a mini-PDF, `/parse` it — request **both** `markdown` and the JSON schema in one call (one metered parse, two outputs). If its JSON passes evidence-against-its-own-markdown + rules → done. Else feed its markdown to DeepSeek for one last structured attempt.

**Layer 4 — review floor.**
PNG of the section's first page → `r2:review/{hash}/{field}.png`, entry in `review_queue`, field `needs_review`. Never guess.

**Disagreement rule** (high-stakes fields): L1 and L2 both produced values and they differ → straight to review with both candidates. No silent tiebreak.

**Cleanup inline:** the moment a section's fields are all settled, delete `work/{hash}/{section}.*` from R2 (if anything was written) and free buffers.

### S5 — Validate

Two tiers, both free and local:

**Structural (zod):** types, formats, ranges. ISIN matches `/^INE[A-Z0-9]{9}$/`, dates parse, percentages ∈ [0, 100].

**Business rules (IPO domain knowledge — your unfair advantage):**

| Rule | Catches |
|---|---|
| `band.low < band.high` and `band.high ≤ band.low × 1.25` | swapped/garbled price band (SEBI caps band width) |
| `13000 ≤ lot_size × band.high ≤ 16000` (retail application value) | wrong lot size OR wrong price — cross-validates both |
| `Σ shareholding ≈ 100 ± 0.5` | dropped table rows |
| `open_date < close_date < listing_date`, span ≤ 15 days | date confusion |
| `fresh_issue + offer_for_sale ≈ total_issue ± 1%` | unit errors (₹ Cr vs ₹ lakh) |
| `face_value ∈ {1, 2, 5, 10}` | misread denominations |

A field implicated in a failed rule re-enters the ladder at the next layer with the rule text as feedback. The same validation code runs on human review resolutions (`POST /reviews/:id/resolve`) — nobody bypasses it.

### S6 — Persist & merge
1. Write final per-field results into `documents.fields`; status → `done` / `done_with_review`.
2. **IPO merge:** upsert `ipos/{ipoSlug}` field-by-field with precedence `PROSPECTUS > RHP > DRHP`; ADDENDUM patches only fields it explicitly contains. Record `fromDoc/fromType/page` per field.
3. Janitor sweep for this hash (work/ gone, pdf/ gone if no open reviews).
4. Fire webhook if registered.

---

## 9. Local markdown generation (the cost saver) — `src/pdf/to-markdown.ts`

The point: turn located pages into LLM-friendly markdown **locally and free**, so Firecrawl meters a tiny text file instead of PDF pages.

```typescript
import * as mupdf from "mupdf";

// Heuristics:
//  - heading: span fontSize ≥ 1.25 × page median, or bold+ALLCAPS → "## " line
//  - table-ish: ≥ 3 lines on the page whose spans share ≥ 3 x-position columns
//    (cluster span x-origins with 8px tolerance) → emit as a pipe table, cells in x-order
//  - everything else: plain paragraphs in reading order (sort blocks by y, then x)
//  - ALWAYS prefix each page with `\n--- page N ---\n` (evidence + page attribution)
export function sectionToMarkdown(doc: mupdf.Document, start: number, end: number): {
  md: string;
  tableConfidence: number;   // share of table-ish lines whose column count was consistent
} { /* …implementation per heuristics above… */ }
```

`tableConfidence` is the router: if < 0.7 (columns inconsistent → mupdf text is probably mangling a merged-cell table), **skip Layer 1 for table-bearing fields and go straight to Layer 3's mini-PDF** — don't pay for a cheap call that will fail. This keeps "cheap first" from degenerating into "pay twice".

> Why not send HTML instead? Firecrawl accepts both; markdown is smaller, easier to generate correctly from text geometry, and the page markers survive cleanly. HTML buys nothing here. (Your `.docx` idea is strictly worse: heavier to generate, parses as a binary doc — skip it.)

---

## 10. The Field Registry

One declarative file drives everything. Adding a field = adding one entry; if it lives in a new section, add aliases too. Re-running a processed document extracts **only** the new field (location map cached in Mongo, validated fields skipped).

```typescript
export const envelope = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ value, evidence: z.string().min(8), page: z.number().int().positive() });

export interface FieldDef {
  key: string; section: string; schema: z.ZodTypeAny; description: string;
  expectedIn: Array<"DRHP" | "RHP" | "PROSPECTUS">;
  rules?: Array<(v: any, all: Record<string, any>) => string | null>;
  highStakes?: boolean;
}

export const FIELDS: FieldDef[] = [
  { key: "price_band", section: "offer_structure",
    schema: z.object({ low: z.number().positive(), high: z.number().positive() }),
    description: "IPO price band in INR per equity share",
    expectedIn: ["RHP", "PROSPECTUS"], highStakes: true,
    rules: [ (v) => v.low < v.high ? null : "low must be < high",
             (v) => v.high <= v.low * 1.25 ? null : "wider than SEBI 25% cap — garbled?" ] },
  { key: "lot_size", section: "offer_structure", schema: z.number().int().positive(),
    description: "Minimum bid lot (shares per retail application)",
    expectedIn: ["RHP", "PROSPECTUS"], highStakes: true,
    rules: [ (v, all) => { const b = all["price_band"]?.value; if (!b) return null;
        const a = v * b.high; return a >= 13000 && a <= 16000 ? null
          : `lot×price ₹${a} outside retail window`; } ] },
  { key: "promoter_pct", section: "capital_structure",
    schema: z.number().min(0).max(100),
    description: "Pre-issue promoter & promoter-group holding %",
    expectedIn: ["DRHP", "RHP", "PROSPECTUS"] },
  // …your full field list, same shape
];
```

---

## 11. Code — all load-bearing pieces (self-contained)

> Style rules for the implementing LLM: TypeScript strict mode; no classes where functions do; every network call goes through `withRetry`; every mupdf object is `destroy()`ed in a `finally`; nothing global except config.

### 11.1 Config

```typescript
// src/config.ts
export const CFG = {
  mongoUrl: process.env.MONGO_URL!,
  r2: {
    endpoint: process.env.R2_ENDPOINT!,        // https://<account>.r2.cloudflarestorage.com
    bucket: process.env.R2_BUCKET!,
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET!,
  },
  firecrawl: { apiKey: process.env.FIRECRAWL_API_KEY!, base: "https://api.firecrawl.dev" },
  deepseek: { apiKey: process.env.DEEPSEEK_API_KEY!, base: "https://api.deepseek.com" },
  apiKey: process.env.SERVICE_API_KEY!,        // X-API-Key for your own REST API
  budget: { wallMsPerDoc: 600_000, maxAttemptsPerField: 4 },
  keepOriginalPdf: false,                      // flip if you ever want pdf/ retained
};
```

### 11.2 Retry wrapper (wraps EVERY network call)

```typescript
// src/util/retry.ts
export async function withRetry<T>(fn: () => Promise<T>, label: string, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await withTimeout(fn(), 90_000, label);
    } catch (e) {
      last = e;
      const wait = 1000 * 2 ** i + Math.random() * 500; // expo backoff + jitter
      console.warn(`[retry] ${label} attempt ${i + 1} failed: ${String(e)} — waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error(`[${label}] failed after ${tries} attempts: ${String(last)}`);
}

const withTimeout = <T>(p: Promise<T>, ms: number, label: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms))]);
```

### 11.3 PDF helpers (mupdf)

```typescript
// src/pdf/mupdf-helpers.ts
import * as mupdf from "mupdf";

export function openDoc(buf: Buffer) {
  return mupdf.Document.openDocument(buf, "application/pdf");
}

export function pageText(doc: mupdf.Document, idx: number): string {
  const page = doc.loadPage(idx);
  try {
    const st = page.toStructuredText("preserve-whitespace");
    try { return JSON.parse(st.asJSON()).blocks
      ?.flatMap((b: any) => b.lines ?? [])
      .map((l: any) => l.text ?? "").join("\n") ?? ""; }
    finally { st.destroy(); }
  } finally { page.destroy(); }
}

export function rangeText(doc: mupdf.Document, start: number, end: number): string {
  let out = "";
  for (let i = Math.max(0, start); i <= Math.min(doc.countPages() - 1, end); i++)
    out += `\n--- page ${i + 1} ---\n` + pageText(doc, i);
  return out;
}

// Split pages [start..end] into a standalone mini-PDF buffer (Layer 3 fallback)
export function miniPdf(srcBuf: Buffer, start: number, end: number): Buffer {
  const src = openDoc(srcBuf) as mupdf.PDFDocument;
  const dst = new mupdf.PDFDocument();
  try {
    for (let i = start; i <= end; i++) dst.graftPage(-1, src, i);
    return Buffer.from(dst.saveToBuffer("compress").asUint8Array());
  } finally { src.destroy(); dst.destroy(); }
}

// Render one page to PNG (for the human review queue)
export function pagePng(srcBuf: Buffer, idx: number, width = 1200): Buffer {
  const doc = openDoc(srcBuf);
  const page = doc.loadPage(idx);
  try {
    const scale = width / page.getBounds()[2];
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    try { return Buffer.from(pix.asPNG()); } finally { pix.destroy(); }
  } finally { page.destroy(); doc.destroy(); }
}
```

(Plus `sectionToMarkdown()` from §9 in `src/pdf/to-markdown.ts`.)

### 11.4 Firecrawl client — `.md` primary, mini-PDF fallback

```typescript
// src/clients/firecrawl.ts
import { CFG } from "../config";
import { withRetry } from "../util/retry";

async function firecrawlParseFile(file: Buffer, name: string, mime: string, formats: any[]) {
  return withRetry(async () => {
    const form = new FormData();
    form.append("file", new Blob([file], { type: mime }), name);
    form.append("formats", JSON.stringify(formats));
    const res = await fetch(`${CFG.firecrawl.base}/v2/parse`, {
      method: "POST", headers: { Authorization: `Bearer ${CFG.firecrawl.apiKey}` }, body: form });
    if (!res.ok) throw new Error(`firecrawl /parse ${res.status}: ${await res.text()}`);
    const d = await res.json(); return d?.data ?? d;     // tolerate response-shape drift
  }, `fc-parse-${name}`);
}

// LAYER 1 (primary, cheap): locally-generated markdown + JSON schema
export const parseMdJson = (md: string, name: string, schema: object) =>
  firecrawlParseFile(Buffer.from(md, "utf8"), `${name}.md`, "text/markdown",
                     [{ type: "json", schema }]);

// LAYER 3 (fallback, expensive): mini-PDF — one metered parse, two outputs
export const parsePdfBoth = (pdf: Buffer, name: string, schema: object) =>
  firecrawlParseFile(pdf, `${name}.pdf`, "application/pdf",
                     ["markdown", { type: "json", schema }]);

// HTML sources (e.g. BSE anchor circular pages) go through /scrape with the same json format
export async function scrapeJson(url: string, schema: object) {
  return withRetry(async () => {
    const res = await fetch(`${CFG.firecrawl.base}/v2/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CFG.firecrawl.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: [{ type: "json", schema }] }) });
    if (!res.ok) throw new Error(`firecrawl /scrape ${res.status}`);
    const d = await res.json(); return d?.data?.json ?? null;
  }, "fc-scrape");
}
```
> **Implementer note:** Firecrawl's exact multipart/response field names evolve. Verify against docs.firecrawl.dev at build time; keep the tolerant `??` chains.

### 11.5 DeepSeek client (fallback brain + locator)

```typescript
// src/clients/deepseek.ts
import { CFG } from "../config";
import { withRetry } from "../util/retry";

export async function deepseekJson(system: string, user: string): Promise<any> {
  return withRetry(async () => {
    const res = await fetch(`${CFG.deepseek.base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CFG.deepseek.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-chat",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`deepseek ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content ?? "{}";
    try { return JSON.parse(raw); }
    catch { return JSON.parse(raw.replace(/```json|```/g, "").trim()); } // fence tolerance
  }, "deepseek-json");
}

export const EXTRACT_SYSTEM = (schemaText: string) => `
You extract fields from Indian IPO documents (DRHP/RHP/Prospectus).
Return ONLY a JSON object matching this schema — no prose, no markdown fences:
${schemaText}
HARD RULES:
1. "evidence" must be a VERBATIM quote copied character-for-character from the provided text.
2. "page" must be the page number from the nearest "--- page N ---" marker above the evidence.
3. If a field is not present in the text, set its value to null. NEVER guess or infer.
4. Numbers: strip commas and currency symbols; "₹1,234.5 Cr" → 1234.5 with unit understood from the field description.
`;
```

### 11.6 Evidence verification + validation

```typescript
// src/validate.ts
import { FIELDS } from "./registry/fields";

const norm = (s: string) => s.replace(/\s+/g, " ").replace(/[₹,]/g, "").trim().toLowerCase();

export function verifyEvidence(evidence: string, sourceText: string): boolean {
  if (!evidence || evidence.length < 8) return false;
  return norm(sourceText).includes(norm(evidence));
}

export function validateField(key: string, payload: any, sourceText: string, all: Record<string, any>):
  { ok: true } | { ok: false; reason: string } {
  const def = FIELDS.find((f) => f.key === key)!;
  if (payload?.value === null || payload?.value === undefined)
    return { ok: false, reason: "value_null" };
  if (!verifyEvidence(payload.evidence, sourceText))
    return { ok: false, reason: "evidence_mismatch — quote not found verbatim in source" };
  const parsed = def.schema.safeParse(payload.value);
  if (!parsed.success) return { ok: false, reason: `schema: ${parsed.error.issues[0]?.message}` };
  for (const rule of def.rules ?? []) {
    const err = rule(payload.value, all);
    if (err) return { ok: false, reason: `rule: ${err}` };
  }
  return { ok: true };
}
```
The exact same function runs on `POST /reviews/:id/resolve` (with `evidence` requirements waived for human input, schema + rules NOT waived).

### 11.7 The extraction ladder (v2 — md-first)

```typescript
// src/extract.ts  (per section — fields grouped by FIELDS[].section)
import { FIELDS } from "./registry/fields";
import { parseMdJson, parsePdfBoth } from "./clients/firecrawl";
import { deepseekJson, EXTRACT_SYSTEM } from "./clients/deepseek";
import { validateField } from "./validate";
import { miniPdf, rangeText, pagePng } from "./pdf/mupdf-helpers";
import { sectionToMarkdown } from "./pdf/to-markdown";

export async function extractSection(ctx: Ctx, section: string, range: { start: number; end: number }) {
  const defs = FIELDS.filter((f) => f.section === section && f.expectedIn.includes(ctx.docType));
  if (!defs.length) return;

  const sectionText = rangeText(ctx.pdfDoc, range.start - 1, range.end + 1);  // ±1 free widening
  const { md, tableConfidence } = sectionToMarkdown(ctx.pdfDoc, range.start, range.end);
  const results: Record<string, any> = {};

  // tableConfidence router: if local text mangles this section's tables,
  // don't pay for a doomed cheap call — table-bearing fields go straight to Layer 3.
  const mdViable = tableConfidence >= 0.7 && !ctx.isScanned;

  // ── Layer 1: Firecrawl /parse on local .md (primary — cheap credits) ──
  if (mdViable) {
    const cand = await parseMdJson(md, section, schemaFor(defs)).then(d => d?.json).catch(() => null);
    settle(cand, "firecrawl_md");
  }

  // ── Layer 2: DeepSeek on raw text (fallback 1 — fractions of a cent) ──
  const open2 = defs.filter((d) => !results[d.key]);
  if (open2.length && !ctx.isScanned) {
    const feedback = open2.map((d) => ctx.fmtLastError(d.key)).filter(Boolean).join("\n");
    const cand = await deepseekJson(
      EXTRACT_SYSTEM(JSON.stringify(schemaFor(open2))),
      `${feedback ? "PREVIOUS FAILURES:\n" + feedback + "\n\n" : ""}DOCUMENT TEXT:\n${sectionText}`
    ).catch(() => null);
    settle(cand, "deepseek_text");
  }

  // ── Layer 3: mini-PDF to Firecrawl (fallback 2 — expensive, surgical) ──
  const open3 = defs.filter((d) => !results[d.key]);
  if (open3.length) {
    const mini = miniPdf(ctx.pdfBuf, range.start, range.end);
    const d3 = await parsePdfBoth(mini, section, schemaFor(open3)).catch(() => null);
    if (d3?.json) settle(d3.json, "firecrawl_pdf", (d3.markdown ?? "") + "\n" + sectionText);
    // last automated shot: Firecrawl's own markdown → DeepSeek
    const open3b = defs.filter((d) => !results[d.key]);
    if (open3b.length && d3?.markdown?.length > 100) {
      const cand = await deepseekJson(
        EXTRACT_SYSTEM(JSON.stringify(schemaFor(open3b))),
        `DOCUMENT (markdown):\n${d3.markdown}`
      ).catch(() => null);
      settle(cand, "combined", d3.markdown + "\n" + sectionText);
    }
  }

  // ── Layer 4: review floor ──
  for (const d of defs.filter((d) => !results[d.key])) {
    const png = pagePng(ctx.pdfBuf, range.start);
    await ctx.r2.put(`review/${ctx.hash}/${d.key}.png`, png);
    await ctx.db.collection("review_queue").insertOne({
      docHash: ctx.hash, field: d.key, pages: [range.start + 1, range.end + 1],
      bestGuess: ctx.lastGuess(d.key), lastError: ctx.lastError(d.key),
      candidates: ctx.allLayerValues(d.key),
      imageKey: `review/${ctx.hash}/${d.key}.png`, status: "open",
    });
    results[d.key] = { value: null, status: "needs_review" };
  }

  // High-stakes disagreement check — straight to review, no silent tiebreak
  for (const d of defs.filter((d) => d.highStakes)) {
    const vals = Object.values(ctx.allLayerValues(d.key)).filter((v) => v != null);
    if (vals.length > 1 && new Set(vals.map((v) => JSON.stringify(v))).size > 1)
      results[d.key] = { value: null, status: "needs_review", reason: "source_disagreement" };
  }

  for (const [k, v] of Object.entries(results)) await ctx.setField(k, v);  // Mongo, atomic

  function settle(cand: any, layer: string, evidenceAgainst = sectionText) {
    if (!cand) return;
    for (const d of defs) {
      if (results[d.key]) continue;
      const v = validateField(d.key, cand[d.key], evidenceAgainst, ctx.fieldValues());
      if (v.ok) { results[d.key] = { ...cand[d.key], status: "validated", layer }; ctx.bumpCost(layer); }
      else ctx.recordFailure(d.key, layer, v.reason, cand[d.key]?.value);
    }
  }
}
```

### 11.8 State manager (Mongo)

```typescript
// src/state.ts — every mutation is one atomic findOneAndUpdate; progress recomputed in the same op
export async function claimNext(db: Db): Promise<DocState | null> {
  return db.collection("documents").findOneAndUpdate(
    { status: "queued", $or: [{ lockedAt: null }, { lockedAt: { $lt: new Date(Date.now() - 15*60_000) } }] },
    { $set: { lockedBy: WORKER_ID, lockedAt: new Date(), status: "fetching" } },
    { sort: { createdAt: 1 }, returnDocument: "after" });
}
export async function setField(db: Db, hash: string, key: string, patch: object) { /* $set fields.key + recompute progress + updatedAt + push capped event */ }
export async function setStage(db: Db, hash: string, stage: string, extra?: object) { /* … */ }
```

### 11.9 Worker loop (sequential, crash-safe)

```typescript
// src/worker.ts — claim → process S1..S6 → terminal; never blocks the queue
export async function startWorkerLoop(db: Db, r2: R2) {
  for (;;) {
    const doc = await claimNext(db);
    if (!doc) { await sleep(15_000); continue; }
    const deadline = Date.now() + CFG.budget.wallMsPerDoc;
    try { await processDoc(db, r2, doc, deadline); }       // each stage idempotent (checks Mongo first)
    catch (e) { await markPoison(db, doc._id, String(e)); }
    finally { await janitorForDoc(r2, db, doc._id); }       // inline cleanup, every time
  }
}
```

### 11.10 API server skeleton

```typescript
// src/api.ts (Fastify) — thin: reads/writes Mongo, presigns R2, enqueues. No business logic.
app.addHook("onRequest", requireApiKey);
app.post("/v1/documents", h.submit);          // dedupe by sourceUrl, insert queued
app.get ("/v1/documents/:id", h.detail);      // the §7.2 payload
app.get ("/v1/documents/:id/result", h.result);
app.get ("/v1/documents/:id/events", h.events);
app.post("/v1/documents/:id/retry", h.retry); // requeue non-validated fields (force=full)
app.get ("/v1/ipos/:slug", h.ipo);
app.get ("/v1/reviews", h.reviews);           // presign PNGs on read (15-min expiry)
app.post("/v1/reviews/:id/resolve", h.resolve);
app.get ("/v1/stats", h.stats); app.get("/v1/health", h.health);
app.post("/v1/admin/janitor", h.janitor);     // ?dryRun=1 supported
app.listen({ port: Number(process.env.PORT), host: "0.0.0.0" });
startWorkerLoop(db, r2);                       // same process
```

---

## 12. Complete fallback matrix — every failure, named, with the action

| # | Failure | Detection | Action | Terminal if unrecoverable |
|---|---|---|---|---|
| 1 | Corrupt / unopenable PDF | mupdf open throws | none possible | `failed_poison: corrupt_pdf` |
| 2 | Password-protected PDF | mupdf reports encryption | none (need password) | `failed_poison: password_protected` |
| 3 | Scanned PDF (no text layer) | page 1 text < 50 chars | skip md/text layers; locate via Firecrawl-markdown of pages 1–8 + DeepSeek mapping; extract via Layer 3 only (Firecrawl OCR-parses); evidence checked against Firecrawl's markdown | fields → `needs_review` |
| 4 | No bookmarks | `loadOutline()` empty | locator L-B (printed ToC) | continue cascade |
| 5 | No printed ToC matches | < 5 regex hits in pages 1–8 | locator L-C (heading scan) | continue cascade |
| 6 | Page-offset wrong | anchor heading not found at computed page | re-anchor with 2nd distinctive section; else discard ToC result, use L-C | continue cascade |
| 7 | Section name never seen | fuzzy score < 0.82 on all aliases | locator L-D (DeepSeek); on success, alias suggestion logged to `events` | section unresolved → its fields `needs_review` |
| 8 | Section verification fails | anchor keywords absent in range | drop to next locator layer for that section only | `needs_review` |
| 9 | Firecrawl API down / 5xx | HTTP error after 3 retries (backoff) | skip to Layer 2 (DeepSeek) — pipeline continues without Firecrawl entirely | — |
| 10 | Firecrawl rate-limited (429) | status code | backoff honors `Retry-After`; if persistent, Layer 2 | — |
| 11 | Firecrawl returns junk/empty JSON | evidence/zod fails | Layer 2 with error feedback | continue ladder |
| 12 | DeepSeek API down | HTTP error after retries | Layer 3 (if Firecrawl healthy) or review floor | `needs_review` |
| 13 | DeepSeek malformed JSON | JSON.parse fails after fence-strip | one retry with parse error included in prompt | continue ladder |
| 14 | Evidence mismatch (hallucination) | verbatim check fails | reject value; next layer with "evidence was not found in text" feedback | continue ladder |
| 15 | Business rule fails | rule returns error | re-enter ladder at next layer, rule text as feedback | `needs_review` |
| 16 | High-stakes disagreement | layer values differ | no tiebreak — straight to review with all candidates | `needs_review` |
| 17 | Field genuinely absent (e.g. price band in DRHP) | docType expectedIn check | **not extracted, not failed** — marked `not_expected` | `not_expected` |
| 18 | Worker crash / Railway redeploy | process restart | stale lock reclaimed (15 min); stages idempotent via Mongo; per-field statuses preserved → resumes | no loss |
| 19 | OOM risk | sequential queue + destroy() + small pixmaps | prevention, not recovery; if killed anyway → same as 18 | no loss |
| 20 | Poison doc (infinite weirdness) | wall-time budget exceeded (10 min) | abort doc, record stage reached | `failed_poison: budget_exceeded` |
| 21 | R2 transient errors | SDK error | withRetry (3×, backoff) | doc retried next queue pass |
| 22 | Mongo write conflict / transient | driver error | withRetry; state ops are single atomic updates, safe to repeat | — |
| 23 | Source PDF link dead/403/timeout | fetch fails after retries | `failed_poison: source_unreachable`; URL kept; `/retry` later | poison (retryable) |
| 24 | Source serves HTML/login page, not PDF | magic bytes ≠ `%PDF` | poison `source_not_pdf`, body's first 500 chars logged to events | poison |
| 25 | Local markdown garbles tables | `tableConfidence < 0.7` | route table-bearing fields directly to Layer 3 (skip the doomed cheap call) | continue ladder |
| 26 | Firecrawl rejects/empty on `.md` | error or junk JSON | Layer 2 (DeepSeek) — md path simply skipped | continue ladder |
| 27 | Mongo down | driver error | API returns 503; worker loop sleeps and retries with backoff; nothing processes without state — **by design** | — |
| 28 | R2 down | put/get errors after retries | PDFs can't ingest (poison-retryable); review PNGs degrade to page-number-only entries (review still possible via the source PDF link) | degraded, not corrupt |
| 29 | Duplicate submits (same URL, racing) | unique index on sourceUrl | second insert fails → return existing doc, `deduped: true` | — |
| 30 | Worker dies holding a lock | `lockedAt` stale > 15 min | next loop reclaims; stages idempotent → resumes | no loss |
| 31 | Review PNG expired (30-d lifecycle) before human got to it | presign 404 | API regenerates the PNG from source URL on demand (re-fetch, render one page, re-upload) | — |
| 32 | Human resolves review with an invalid value | zod/rules fail on `POST /resolve` | 422 with the exact rule error — humans get validated too | — |
| 33 | IPO merge conflict (two RHPs, same slug) | duplicate type in `documents[]` | newer `processedAt` wins; event logged for inspection | — |

**Invariant the matrix guarantees:** there is no path on which an unverified value is written into `documents` or `ipos` as validated — including via human review resolution and the IPO merge step. Every row terminates in a verified value, an explicit flag, or a poison state — never silent garbage.

## 13. Cost model

Per typical RHP (~500 pages, ~10 sections, ~20 fields), healthy path:

| Item | v1 (PDF-primary) | v2 (md-primary) |
|---|---|---|
| Firecrawl: 10 sections | ~40–60 PDF pages of credits | **10 small `.md` parses** (+0–2 mini-PDF rescues) |
| DeepSeek fallback | < ₹1 | < ₹1 (fires less — md feeds cleaner than you'd think) |
| mupdf, Mongo writes, R2 ops | ₹0 | ₹0 |
| R2 storage | growing bucket | **~0 GB steady state** (janitor + lifecycle) |

The md-first switch is the single biggest credit saver in the design — most documents now consume near-zero PDF-priced parsing. The `tableConfidence` router prevents the false economy of paying cheap-then-expensive on the same section.

**Cost levers, in order of impact:** (1) the free locator deciding pages — ~95% saved vs whole-doc processing; (2) md-first — PDF credits only for genuinely hard sections; (3) alias convergence pushing everything to first-try success; (4) located-map caching — new fields never re-pay for location or old fields; (5) if Firecrawl credits run dry, flip `primary: "deepseek"` in config and the ladder reorders — total cost stays under ₹1–2/doc. The architecture doesn't care which brain is primary.

### 13.1 Performance budget (Railway 500 MB / 1 vCPU)

| Phase | Wall time | Peak RAM |
|---|---|---|
| Fetch from source URL + hash + R2 put | 3–10 s | ~40 MB |
| Classify + locate | 1–3 s | ~80 MB (mupdf WASM, 1 page at a time) |
| Extract (10 sections, sequential, network-bound) | 30–90 s | ~120 MB |
| Validate + persist + merge + janitor | < 2 s | — |
| **Total per document** | **~1–2 min** | **< 200 MB peak** |

Rules that keep this true: strictly sequential processing (one doc, one section, one network call); `destroy()` every mupdf page/pixmap in `finally`; pixmaps at 1200 px not print DPI; never hold more than one section's text/md in memory; never `Promise.all` documents. API requests are Mongo reads — they don't compete with the worker for memory.

## 14. Worst-case walkthroughs

**W1 — "The registrar from hell": no bookmarks, ToC in a weird font, sections renamed.**
L-A empty → L-B finds only 3 regex hits (< 5, rejected) → L-C heading scan finds bold-caps candidates → 7 of 10 sections fuzzy-match; 3 don't → L-D DeepSeek maps 2 of the remaining 3; 1 section unresolved → its 2 fields are born `needs_review` with PNGs. 18/20 fields validated automatically; you resolve 2 reviews via the API and append 1 alias line. Next doc from this registrar: 20/20.

**W2 — Both external APIs are down simultaneously.**
All sections fail Layers 1–3 (retries exhausted in ~5 min, inside budget). Every field → `needs_review`. Doc → `done_with_review`. Nothing corrupted, nothing lost; `POST /retry` later finds fields unresolved and re-enters the ladder with APIs healthy.

**W3 — A garbled table extracts a plausible-but-wrong lot size.**
Layer 1 returns `lot_size: 15` with evidence "Bid Lot 15 Equity Shares" — but the quote isn't verbatim in the local text (real text says 150; the model "quoted" its own output). Evidence check fails → Layer 2 reads raw text, returns 150 with a verbatim quote → passes evidence → business rule: 150 × ₹100 = ₹15,000 ✓ retail window → validated. Had evidence somehow passed, the cross-rule would still have caught it (15 × 100 = ₹1,500 → rule fail → review).

**W4 — Railway redeploys mid-document at section 6 of 10.**
Mongo shows `status: extracting`, fields 1–12 `validated`, lock goes stale. On restart the loop reclaims the doc; S1–S3 see their Mongo outputs and no-op (< 1 s); S4 skips validated fields and resumes at section 6. Total loss: the one in-flight network call.

**W5 — A scanned addendum (no text layer).**
S1 marks `isScanned`. Locator uses Firecrawl-markdown of the first pages + DeepSeek mapping. Extraction runs Layer 3 only (Firecrawl OCR-parses the mini-PDF); evidence checks run against Firecrawl's markdown instead of mupdf text. More credits spent, fields still verified or flagged — never guessed.

**W6 — Your scraper API floods 50 documents at once.** All insert as `queued` in ms (API is thin). The worker drains them sequentially, ~1–2 min each; `GET /documents?status=queued` shows the line; each doc's `progress.etaSeconds` reflects queue position. Memory never grows — one doc in flight, always.

**W7 — The bucket is full of old mess from previous experiments.** Deploy → `POST /admin/janitor?dryRun=1` → response lists every orphan key (no Mongo record) with sizes → eyeball it → run without dryRun → bucket contains exactly three prefixes and almost nothing else, forever after.

**W8 — A reviewer fat-fingers `promoter_pct: 642`.** `POST /reviews/:id/resolve` runs the same zod schema (max 100) → 422 `"rule: must be ≤ 100"`. The review stays open. Humans don't bypass validation.

**W9 — DRHP processed in March, RHP arrives in June with the price band.** RHP processes; merge upserts `ipos/xyz-ltd-2026`: price_band (RHP-only) fills in, overlapping fields flip to `fromType: "RHP"`, DRHP-only context fields remain. `GET /ipos/xyz-ltd-2026` is instantly current. No reprocessing of the DRHP.

## 15. Future extension paths (designed-in, zero refactor)

| Want | Change |
|---|---|
| New field | 1 entry in `fields.ts` (+1 alias line if new section). `POST /retry` on docs you care about — location cached, only the new field costs anything. |
| New document type (shelf prospectus, FPO…) | 1 row in the classify table + `expectedIn` tags. |
| Anchor allocation circulars (HTML pages on BSE/NSE) | They're URLs → `scrapeJson(url, schema)` (§11.4). Same evidence envelope, same validation, no PDF step. |
| Swap/add an LLM (Claude, GPT, Qwen…) | Implement the 10-line client interface (`json(system, user)`); ladder order is config. |
| Dashboard | `ipos` and `documents` collections are already clean and indexed — point any admin UI or BI tool at Mongo. The pipeline never changes. |
| Push instead of poll | register `webhookUrl` at submit; the §7.2 payload fires on every status change. |
| Scale beyond one worker | the lock-claim in §11.8 already supports N workers; bump Railway plan or add a second service — zero code change. |

## 16. Implementation checklist (ordered, for the coding LLM)

1. Scaffold TS strict; deps: `fastify`, `mongodb`, `mupdf`, `zod`, `zod-to-json-schema`, `@aws-sdk/client-s3` + presigner, `js-yaml`. Env validated by zod at boot.
2. `util/retry.ts`, `config.ts`.
3. Mongo bootstrap: collections, indexes (incl. unique `sourceUrl`, capped `events`).
4. `pdf/mupdf-helpers.ts` (§11.3) + `pdf/to-markdown.ts` (§9). Test md output by eye on 3 real sections — tables must look like tables. **Verify current mupdf.js API names.**
5. R2 wrapper (get/put/delete/list/presign) + `janitor.ts` with dryRun. Set the 3 lifecycle rules in Cloudflare dashboard.
6. Locator (§8 S3, full cascade L-A…L-E) writing to Mongo; `aliases.yaml`.
7. `registry/fields.ts` with the real field list; schema builder with evidence envelope.
8. Clients: `firecrawl.ts` (§11.4 — **verify live request/response shapes first**), `deepseek.ts` (§11.5).
9. `validate.ts` (§11.6) + unit tests (fabricated quote fails, whitespace-shuffled genuine quote passes, human-resolve path uses same code).
10. `extract.ts` ladder (§11.7) incl. tableConfidence router, disagreement rule, inline cleanup.
11. State manager (§11.8), worker loop (§11.9) with lock claim + wall-time budget + poison.
12. IPO merge step (§S6.2) with precedence + per-field provenance.
13. API (§7 full surface) — write the §7.2 detail handler first; it forces progress bookkeeping to be correct everywhere else.
14. Run 5 real docs end-to-end via the API only. Check `/stats` layer win-rates; append aliases; repeat ×10.
15. Deploy to Railway; confirm RSS < 250 MB on a full RHP; run janitor dryRun against your messy bucket, then for real.

**Definition of done:** submit a link → poll shows live stage/per-field progress → under 2 min later `GET /ipos/:slug` serves merged, evidence-backed JSON; ≥ 90% fields validated, the rest in `/reviews` with images; R2 contains nothing but the three prefixes and is near-empty at rest; kill -9 at any moment loses at most one network call.
