# Extraction + Dashboard Roadmap

Tracks the agreed feature work across the extraction engine and dashboard.
Status: ✅ done · 🚧 in progress · ⬜ planned

## Phase 1 — Validation engine ✅ (backend)

Declarative, runtime-mutable, dashboard-editable validation rules that score every
extraction 0–100 and auto-flag low scores as `pending_review`.

- `src/extraction/validate.js` — engine + default ruleset + runtime registry.
- Rule types: `required | regex | min_items | enum | cross_check | objectlist_sum | compare`.
- `cross_check` compares extracted fields against the scraped master IPO doc
  (independent ground truth, e.g. `price_band` vs `ipo.priceBand`).
- Scoring: `score = 100·(1 − Σlost/Σweight)`; errors cost full weight, warnings 40%.
  `score ≥ threshold (default 80)` → `completed`, else → `pending_review`.
- Wired into `runExtraction` (`src/extraction/index.js`): result is scored after
  `normalize()`; `extractionStatus` derives from the score; `validation` saved on
  the extraction doc.
- Persistence: `config` collection `_id:'validation'` (`configRepository.saveValidation`/
  `resetValidation`, loaded at startup).
- APIs: `GET/PUT /validation`, `POST /validation/rule`, `DELETE /validation/rule/:id`,
  `POST /validation/reset`, `POST /extractions/:slug/validate` (re-score stored
  extractions, **no LLM call**).
- Tests: `test/extraction/validate.test.js` (13).

### Phase 1b — AI-assisted config editing + backups ✅

- `src/extraction/ai-edit.js` — edit the **schema** and the **validation ruleset**
  from a freeform natural-language instruction (same idea as PDF-Lab suggestSchema).
  - **Safety contract:** the LLM's raw output is ALWAYS run through the existing
    strict validators (`schema.validateFields` / `validate.validateRules`) before
    it is returned or applied — a malformed AI response can never reach the live
    registry that `normalize()`/`buildJsonSchema()`/`evalRule()` depend on. On
    failure → HTTP 422 with the raw output for the UI to show, nothing applied.
  - Pure core (`buildSchemaProposal`/`buildValidationProposal`) split from the LLM
    glue; unit-tested with no mocking (`test/extraction/ai-edit.test.js`, 6).
- APIs: `POST /schema/ai`, `POST /validation/ai` (body `{ instruction, apply? }` —
  preview by default; `apply:true` persists). Returns `{ explanation, proposed, diff, warnings? }`.
- **Backups:** every config change (manual or AI) snapshots the previous version to
  `config_backups` (last 25/key). `GET /config/backups?key=`, `POST /config/backups/:id/restore`.
  `configRepository.backupConfig/listBackups/restoreBackup`.

## Phase 2 — Dashboard: validation editor + review ✅

All in `src/api/public/dashboard.html` (single Alpine.js app).

- ✅ **2a — Validation review view**: Score column on the Extractions table; score
  badge + per-rule findings panel (red/amber, expected-vs-actual on hover) + a
  **Re-validate** button (no-LLM re-score) in the extraction modal.
- ✅ **2b — AI-assist box on BOTH the schema and validation editors**: freeform
  instruction → `POST /schema/ai` / `POST /validation/ai` → explanation + diff +
  warnings preview → Apply (auto-backup) or Discard. New **Validation** nav page
  with a rules editor (id/field/type/severity/weight/enabled/params), threshold,
  JSON mode, reset.
- ✅ **2c — Backups/restore UI**: "Backups" button on the schema + validation
  editors → modal listing snapshots (`GET /config/backups?key=`) with one-click
  restore (`POST /config/backups/:id/restore`).
- ✅ **2d — Data-quality widget** on the overview: avg score, scored count, needs-review
  count, and a clickable "lowest scoring" list (from `/stats` `extractions.quality`).
  *(covers Dashboard #5)*

## Phase 3 — Schema "test on an IPO" ✅  *(Extraction #6)*

- `POST /schema/test` body `{ slug, fields, docType?, pipeline?, wait? }` → runs one engine with
  the **edited, unsaved** schema against a real IPO, returns result + validation, persists nothing.
  Tracked heavy-lane job. `testSchemaOnIpo()` in `extraction/index.js`.
- Reuses cached R2 markdown when present (skips download/locate/convert); else one-off convert.
- Safe global `FIELDS` swap via `withFields(temp, fn)` in `llm/schema.js`; relies on the heavy-lane
  concurrency=1 guard so no concurrent run sees the temp schema.
- Dashboard: "Test on IPO" button in the schema editor → IPO picker → inline result + score preview.

## Phase 4 — Failure transparency ✅  *(Extraction #5)*

- `runExtraction` tracks `phase` (download/locate/convert/extract/save) + per-engine `engineErrors`.
- On a crash: persists a `failed` extraction doc (`error`, `failedPhase`, `partial`) WITHOUT
  clobbering a prior good result (annotates `lastError`/`lastFailedPhase` instead).
- Surfaced: "Failed" filter + failedPhase on the status badge in the review table; a failure panel
  in the extraction modal (failed phase, error, per-engine errors, partial sections converted).

## Phase 5 — Cross-pipeline compare + golden + eval ✅  *(Extraction #4, #3)*

- `GET /extractions/:slug/compare` → aligns stored pipeline rows field-by-field (no LLM),
  disagreements first. `compareResults()` in `extraction/eval.js`. Compare modal in the UI.
- Golden set: `POST /extractions/:slug/golden` snapshots a verified result to `golden_extractions`;
  `GET /golden`, `DELETE /golden/:slug`. "★ Golden" button in the extraction modal.
- `POST /eval/run` → re-extracts every golden with the current schema, field-level diff vs golden
  (`diffResult()`), stores accuracy report in `eval_runs`. New **Eval** nav page (run, runs list,
  run detail, golden set). Tests in `test/extraction/eval.test.js`.

## Phase 6 — Dashboard polish ✅

- PDF side-by-side review: "PDF" toggle in the extraction modal splits the view (source PDF iframe
  beside the fields), widens the modal.
- Bulk operations UI: row + select-all checkboxes on the IPO list → bulk-extract bar.
- Live job updates via SSE: `GET /jobs/:id/stream` (auth via `?token=`); dashboard `streamJob()`
  uses EventSource for the active job instead of polling.

## Deferred (by user)

- Public read-only API / consumer view, webhooks — "launch later".
- Scraper: retry/backoff + raw-response snapshotting (see scraper work).
- Telegram alerts — hook off `/sources` `unhealthy` + failed jobs.
