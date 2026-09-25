# Wikipedia Market Research — Project Plan

Status: **Stage 5 (charts + PDF report) — in review.** Stages 1–4 accepted; decisions recorded in §9.

## 1. Project goal

A portable [Agent Skill](https://agentskills.io/specification) that lets an AI agent analyze
Wikipedia pageview statistics across topics and language editions, helping B2C product founders
gauge audience interest and form hypotheses for further product validation.

The deliverable is a public GitHub repository whose root is the skill directory
`wikipedia-market-research` (valid skill name; must match the directory name).

**Division of labour**

| Deterministic TypeScript (CLI) | Language model (agent) |
|---|---|
| Article verification, redirects, language links | Understanding user intent |
| Pageview retrieval, caching | Resolving meaningful ambiguities (choosing among candidates) |
| Period logic, data-quality classification | Selecting research parameters (languages, dates, comparisons) |
| All statistics | Interpreting statistical results |
| Chart and PDF rendering | Explaining limitations, writing structured conclusions |

The core skill never depends on OpenRouter or any specific model.

## 2. MVP scope

**In scope**

1. Topic identification and validation.
2. Wikipedia article resolution across languages — one verified article per language edition.
3. Pageview retrieval (Wikimedia Analytics API, `agent=user`, `access=all-access`).
4. Analysis of user-defined date ranges (exact dates or calendar months).
   Default when the user gives no period: **the last 12 completed calendar months** — the agent must state this assumption.
5. Cross-language comparison of absolute pageviews and trends (no normalization).
6. Deterministic statistical trend analysis.
7. Data-quality checks and explicit limitations.
8. Chart generation.
9. One-page PDF report in the user's language, including structured AI-generated conclusions.
10. Follow-up requests with changed parameters (re-run with new flags; cache avoids refetching).
11. Basic file-based cache.

**Out of scope (MVP)**

Forecasting · share-of-edition normalization · advanced/LRU cache management · permanent research
history · geographic audience estimation · additional data sources · multiple articles per language ·
a localization framework.

**Non-negotiable interpretation rules** (enforced in `SKILL.md`, and carried in every output as `limitations`)

- Pageviews ≠ unique people ≠ customers.
- A language edition ≠ a country.
- Absolute views across editions are not directly comparable (edition sizes differ).
- No fabricated statistics; every number in conclusions must come from CLI output.
- Factual comparisons use completed periods only.
- Languages are never chosen arbitrarily: the agent derives them from the request/context or asks the user.

## 3. Architecture

### 3.1 Execution mechanism

No bundler, no committed build output, no compile step.

- Node.js **≥ 24** runs `.ts` files directly via native type stripping.
- Entry point: `node scripts/wmr.ts <command> [flags]` (also `npm run wmr -- <command> …`).
- Setup: `npm ci --omit=dev` installs runtime dependencies from the committed `package-lock.json`.
- TypeScript is restricted to erasable syntax (`erasableSyntaxOnly`, `verbatimModuleSyntax`,
  `.ts` import extensions; no enums/namespaces/parameter properties). `tsc` is used only for type checking.
- Configuration via environment variables, documented in `.env.example`:
  - `WMR_CONTACT` — contact URL or email placed in the Wikimedia `User-Agent`
    (default: `https://github.com/OlehDribko/wikipedia-market-research/issues`).
  - `WMR_CACHE_DIR` — optional cache location.
  - `OPENROUTER_*` — harness only; never read by the skill.

### 3.2 Directory layout (end state; files are created only when their stage needs them)

```
wikipedia-market-research/        ← repo root = skill directory
├── SKILL.md                      ← agent workflow, rules, CLI usage (< 500 lines)
├── PROJECT_PLAN.md
├── README.md                     ← human docs: setup, development, testing
├── LICENSE                       ← MIT
├── .env.example
├── package.json / package-lock.json / tsconfig.json / vitest.config.ts
├── scripts/
│   └── wmr.ts                    ← thin CLI entry, delegates to src/cli
├── references/                   ← loaded on demand by the agent
│   ├── CLI.md                    ← full command and JSON contracts
│   └── METHODOLOGY.md            ← metrics, data-quality statuses, interpretation rules
├── assets/fonts/                 ← Noto Sans Regular/Bold (SIL OFL 1.1, OFL.txt) embedded in PDFs
├── examples/                     ← real example research files, conclusions and reports
├── src/
│   ├── cli/                      ← arg parsing (node:util parseArgs), dispatch, JSON envelope, errors
│   ├── schemas/                  ← Zod schemas: single source of truth for all contracts
│   ├── wikimedia/                ← HTTP client, article resolution, pageview retrieval
│   ├── periods/                  ← date ranges, granularity selection, completeness
│   ├── quality/                  ← per-observation status classification, warnings
│   ├── analysis/                 ← pure statistics
│   ├── research/                 ← orchestration used by the `research` command
│   ├── report/                   ← chart (SVG) + one-page PDF
│   └── cache/                    ← file-based JSON cache
├── tests/                        ← Vitest; network replaced by recorded fixtures
└── harness/openrouter/           ← DEV-ONLY integration test harness (see 3.4)
```

### 3.3 Module responsibilities

| Module | Responsibility | Must not |
|---|---|---|
| `cli` | Parse flags, validate with Zod, call one service, print one JSON envelope, set exit code | Contain business logic |
| `schemas` | Zod schemas + inferred types for inputs, artifacts, conclusions, envelope | Perform I/O |
| `wikimedia` | Axios client (User-Agent with `WMR_CONTACT`, timeout, retry/backoff on 429/5xx); MediaWiki Action API (search, redirects, disambiguation via `pageprops`, `langlinks`, first-revision timestamp); Analytics API per-article pageviews | Compute statistics or fill gaps |
| `periods` | Parse user ranges, default period, granularity selection, last complete period, data availability bounds | Perform I/O |
| `quality` | Classify every expected observation (see §5), coverage, warnings | Invent values |
| `analysis` | Pure deterministic statistics over classified series | Perform I/O or access the network |
| `research` | Orchestrate resolve → fetch → classify → analyze; write the research artifact | Duplicate module logic |
| `report` | Render chart + one-page PDF from a saved research artifact and validated conclusions | Call Wikimedia, recompute statistics, or generate text |
| `cache` | Read/write JSON responses keyed by request hash with TTL | Decide data correctness |

Every module except `cli`/`research` is independently unit-testable; `wikimedia` is tested with recorded fixtures.

### 3.4 Skill vs. OpenRouter harness independence

- `harness/openrouter/` lives in the repository as development and integration-testing infrastructure only.
- Dependency direction is one-way: **harness → CLI process**. `src/` and `scripts/` never import harness code,
  never read OpenRouter variables, never name a model. `SKILL.md` does not reference the harness.
- The harness loads `SKILL.md` as the system prompt, exposes one tool per CLI command
  (`research`, `resolve`, `report`, plus a file-writing tool for conclusions), executes them via
  `child_process`, runs the tool-calling loop, and saves transcripts.
- Harness uses native `fetch` and `node --env-file` — no extra dependencies.
- Model: `OPENROUTER_MODEL` (default `google/gemma-4-26b-a4b-it:free`). **No silent model switching**:
  if the model is unavailable or rate-limited, the harness fails with a clear error.
- The API key is read from `OPENROUTER_API_KEY` only at request time; it is never logged, printed,
  or written to transcripts.

### 3.5 Cache

- **Location:** `WMR_CACHE_DIR`, else `$XDG_CACHE_HOME/wikipedia-market-research`, else `~/.cache/wikipedia-market-research`.
  It is never inside the skill directory, which may be read-only.
- **Layout:** `v1/<namespace>/<hh>/<sha256>.json`, one JSON file per entry, written atomically (temporary file + rename).
  The key is the SHA-256 of the namespace plus the canonical (sorted) key parts. Entries also store their key parts,
  which are compared on read.
- **Entry contents:** key parts, source URL, `fetchedAt`, `expiresAt`, `meta` (e.g. outcome and number of observations),
  and the value.
- **What is cached:** only source data, never analysis results.

| Namespace | Key parts | Value | TTL |
|---|---|---|---|
| `pageviews` | project, article, granularity, start, end, agent, access | rows, or `no_data` (HTTP 404 stored as a raw fact) | 30 days if the range ends more than 45 days before today (UTC), otherwise 6 h |
| `first-revision` | project, pageId | first revision timestamp or null | 7 days |
| `publication-horizon` | project, granularity, window, agent, access | last published day | 1 h |

- **Request windows:** pageviews are requested in calendar-year chunks, clipped only to 2015-07-01 and to the last
  complete day or month. Different ranges within the same year therefore share cache entries, which makes
  follow-up requests cheap.
- **Never cached:** errors and invalid responses.
- **Invalid entries:** corrupt, mismatching or expired entries are cache misses. There is no automatic cleanup
  (LRU is on the roadmap).
- **`--no-cache`:** skips cache reads, but still writes the fresh responses, so it also refreshes the cache.
- **Write failures:** a failure to write the cache produces a `CACHE_WRITE_FAILED` warning and never fails research.
- **Not cached:** article resolution (site matrix, lookups, search) is repeated on every run.

## 4. CLI input/output contracts

### 4.1 Common envelope

Every command writes exactly one JSON object to stdout. Exceptions: `--help` and `--version` print plain text.

```json
{
  "ok": true,
  "command": "research",
  "data": {},
  "warnings": [{ "code": "INCOMPLETE_PERIOD_EXCLUDED", "message": "...", "language": "de" }],
  "limitations": ["Pageviews are not unique visitors or customers.", "..."],
  "meta": { "version": "0.1.0", "generatedAt": "2026-09-25T12:00:00.000Z" }
}
```

Error form:

```json
{ "ok": false, "command": "research",
  "error": { "code": "INVALID_INPUT", "message": "...", "hint": "...", "details": [{ "path": "langs", "message": "..." }] },
  "meta": { "version": "0.1.0", "generatedAt": "..." } }
```

Exit codes: `0` success · `1` invalid usage/input/output directory · `2` resolution failure/ambiguity · `3` upstream API failure ·
`4` internal error or not implemented.
Stdout is kept compact (summary metrics + artifact paths); full series live in artifact files.

### 4.2 `resolve` — handle ambiguous topics

```
node scripts/wmr.ts resolve --topic "Intermittent fasting" --lang en [--langs en,de,uk] [--limit 5]
```

`data`:

```json
{
  "topic": "Astronomy",
  "status": "resolved | ambiguous | not_found",
  "reason": "exact_title | disambiguation_page | no_exact_match | no_results",
  "sourceLanguage": "en",
  "source": { "lang", "title", "pageId", "url", "description", "wikidataId", "normalizedFrom", "redirectedFrom", "redirectFragment" },
  "articles": [{ "lang", "edition": { "requestedCode", "code", "name", "autonym", "url", "closed" },
                 "status": "verified | missing | link_broken | disambiguation", "via": "source | language_link",
                 "title", "pageId", "url", "wikidataId", "redirectedFrom" }],
  "missingLanguages": ["uk"],
  "candidates": [{ "lang", "title", "pageId", "url", "description" }],
  "nextStep": "instruction for the agent"
}
```

- `source` is non-null and `articles` is non-empty only when `status` is `resolved`.
- Ambiguous and not-found results are successful responses (exit 0), because the agent needs the candidates.
- Warning codes:
  - `REDIRECT_FOLLOWED`, `REDIRECT_TO_SECTION`
  - `LANGUAGE_ARTICLE_MISSING`, `LANGUAGE_LINK_BROKEN`, `LANGUAGE_LINK_DISAMBIGUATION`
  - `WIKIDATA_MISMATCH`, `EDITION_CLOSED`, `LANGUAGE_CODE_MAPPED`
- Error codes: `INVALID_LANGUAGE` (exit 1), `UPSTREAM_ERROR` and `UNEXPECTED_RESPONSE` (exit 3).

**Resolution algorithm**

1. Validate every language code against the Wikimedia site matrix. Unknown codes are an error, never skipped.
   Site-matrix codes are mapped to edition subdomains (e.g. `gsw` → `als`).
2. Look up the topic as an exact title in the source edition. MediaWiki normalizes it and follows one redirect.
   Titles with characters that are illegal in titles (e.g. `|`) skip this step.
3. Search the source edition for candidates. Disambiguation pages and the resolved article are excluded.
4. The outcome depends on what was found:
   - An existing main-namespace article that is not a disambiguation page → `resolved`.
   - A disambiguation page, or no exact title but some search results → `ambiguous`.
   - Nothing at all → `not_found`.
5. When `resolved`, follow the source article's interlanguage links to each requested edition, then verify
   the target page: existence, redirect, disambiguation and Wikidata item.
   An edition without a link is `missing`. It is never filled from search.

### 4.3 `research` — main command

```
node scripts/wmr.ts research
  (--topic "Intermittent fasting" --lang en | --article en:Intermittent_fasting)
  --langs en,de,uk,pl                          # REQUIRED, explicit
  [--start 2024-01-01 --end 2025-06-30]        # or YYYY-MM for whole months; both or neither
  [--compare 2024-01..2024-06,2025-01..2025-06]
  [--granularity auto|daily|monthly]           # default auto
  [--out ./output] [--no-cache]
```

- Period selection (`request.period.mode`):
  - `explicit`: `--start/--end` given (optionally with `--compare`).
  - `comparisons`: only `--compare` given. Exactly those ranges are analyzed; no default period is added.
  - `default`: nothing given. The last 12 completed calendar months are used, and the agent must state this assumption.
- **Pipeline:**
  1. Plan the periods and granularity.
  2. Resolve the topic. This fails with exit code 2 and candidates on `AMBIGUOUS_TOPIC`, `TOPIC_NOT_FOUND`,
     `ARTICLE_NOT_FOUND` or `NO_VERIFIED_ARTICLES`.
  3. For each verified language: get the creation date, fetch pageviews (with cache), probe the publication
     horizon, and classify the observations.
  4. Analyze all datasets (`src/analysis/`, pure functions).
  5. Write the artifact.
  6. Print the compact summary.
- **`data` (compact; it never contains individual observations; about 5–8 KB for 2 languages and 2 periods):**
  `{ artifactPath, source, periodMode, periods: [{ id, start, end }], granularity: { selected, reason },
  languages: [{ lang, title, url, wikidataId, createdAt, publishedThrough, units, counts, uncertain, coverage: [{ periodId, coverage }] }],
  unavailableLanguages, cache: { enabled, hits, misses, bypassed, writeFailures }, analysis, nextStep }`, where
  `analysis` is a digest:
  `{ metricIdPattern, periods: [{ lang, periodId, total, averageDaily, averageMonthly, coverage, trend,
  trendSlopeSpanPercentOfMedian, trendPValue, spikes, largestUnitShare }], comparisons: [{ id, lang, percentChange,
  averageDailyPercentChange, primaryMeasure, status, issues }], topSpikes (≤ 5), crossLanguage: [{ periodId, byAverageDaily }] }`.
- **Artifact** `research-<id>.json` (`id` = hash of subject, languages, periods and granularity; validated by Zod
  before writing, written atomically):
  - format, tool version, request, plan, full resolution
  - `datasets[]`: lang, project, title, pageId, URL, Wikidata ID, `createdAt`, agent/access, `publishedThrough`,
    per-request provenance (URL, outcome, rows, cache status, `fetchedAt`), classified observations, quality summary
  - `unavailableLanguages`, warnings, limitations, sources
  - `analysis` (artifact format 2): per-language period analyses (metrics, trend, anomalies), comparisons,
    cross-language rankings, a flat citable `metrics` index, and interpretation limitations

**Granularity `auto`:** monthly when every requested range (main + comparisons) covers whole calendar months;
otherwise daily. Explicit `monthly` with a non-month-aligned range is rejected as invalid input.

**Statistics:** defined in [references/METHODOLOGY.md](references/METHODOLOGY.md) (methodology version 1).

- **Per period:** total, counted sum, average daily and monthly views, min/max, concentration, coverage and unit
  counts. Metrics are null with a `nullReason` when they cannot be calculated reliably.
- **Comparisons:** consecutive `--compare` periods in the user's order.
  - Totals and average daily views, as absolute and % change.
  - A zero baseline gives null percentages.
  - Unequal durations lead with average daily views.
  - Issues are listed and statuses assigned without numerical confidence scores.
- **Trend:** Mann–Kendall test (exact for small tie-free samples), Theil–Sen slope, half-median change and robust
  CV, applied to months or to complete 7-day blocks of daily data. Labels: `increasing`, `decreasing`, `stable`,
  `no_clear_trend`, `insufficient_data`.
- **Spikes:** rolling median/MAD. Spikes are reported with their baseline, never removed, and no cause is inferred.
- **Cross-language:** separate indicators per edition and a ranking by absolute average daily views
  (no normalization).

**Trend thresholds.** Factual metrics are returned whenever they can be calculated correctly, even when trend
interpretation is withheld.

| Granularity | Minimum points for a trend label | Minimum coverage |
|---|---|---|
| monthly | 6 months | 90 % |
| daily | 8 complete 7-day blocks (56 days) | 90 % |

**Metric IDs:** `<lang>.<periodId>.<metric>` and `<lang>.<baselineId>_vs_<currentId>.<metric>`, for example
`uk.main.averageDaily` or `pl.compare-1_vs_compare-2.averageDailyPercentChange`. The full list is in METHODOLOGY §8.

### 4.4 `report` — render from saved research data, no Wikimedia calls

```
node scripts/wmr.ts report --research ./output/research-<id>.json --conclusions ./conclusions.json [--out ./report.pdf]
```

**Inputs.**
- The research file (artifact format 2), validated by Zod.
- The conclusions file, validated by `ConclusionsSchema`. Its `language` is the report language.

`report` reads files only. It never calls Wikimedia, never recalculates statistics and never writes to the research
file (a test checks the file's hash and mtime).

**Conclusions schema** (written by the model):

```json
{
  "language": "uk",
  "headline": "string (≤ 160 chars)",
  "findings": [{ "statement": "string", "evidence": ["de.compare-1_vs_compare-2.averageDailyPercentChange"] }],
  "hypotheses": [{ "hypothesis": "string", "validationIdea": "string" }],
  "limitations": ["string"],
  "labels": { "findings": "…", "hypotheses": "…", "limitations": "…", "metrics": "…", "dataQuality": "…", "title": "…" }
}
```

**Validation** (`src/report/validate.ts`). Any failure returns `INVALID_CONCLUSIONS` with per-field issues and a
correction hint.
- Evidence IDs must exist in `analysis.metrics`. Unknown IDs come with the 3 closest IDs as suggestions.
- Numbers in a finding must equal a value of a metric it cites. Rounding to the written precision is allowed, and
  locale formats are understood (`25 473`, `25,473`, `59,74`).
- The headline, hypotheses and limitations may contain only research-setup numbers (years, period lengths, counts).
  Statistics need evidence. `validationIdea` may contain planning numbers.
- ISO dates must lie within the research periods.
- Every character must be renderable by the report font.

**Output.**
- A one-page A4 PDF, by default `report-<id>-<lang>.pdf` next to the research file.
- The chart as SVG, `<name>-chart.svg`.
- `data`: `{ reportPath, chartPath, pages: 1, language, labelsLanguage, findings, hypotheses, layout }`.

**PDF content.** In order:
1. Title and headline.
2. Source article, periods, granularity and generation date.
3. Verified articles, with language, autonym, title, Wikidata ID and a clickable URL.
4. Chart.
5. Metrics table: total, per day, per month, trend, coverage, spikes.
6. Comparison table, with the primary measure in bold.
7. Findings, each followed by its evidence line showing the cited IDs and their artifact values.
8. Hypotheses.
9. Limitations: 4 fixed ones plus the model's.
10. Data-quality counts and warning codes.
11. Sources.

**One page.**
- The layout is measured and drawn by the same code, and up to 6 progressively more compact layouts are tried
  (scale 1 → 0.76, chart 215 → 135 pt).
- If none fits, the command fails with `REPORT_DOES_NOT_FIT` and the overflow in points. Nothing is truncated.
- At most 8 language editions are supported (the size of the validated palette).

**Language.**
- Built-in labels and fixed limitations exist for `en`, `uk` and `pl`; other languages use English plus optional
  `labels` overrides (`REPORT_LABELS_FALLBACK` warning).
- Numbers are formatted with `Intl.NumberFormat` for the report language.
- Unicode is handled by the embedded Noto Sans (Latin, Cyrillic, Greek).

**Chart** (`src/report/chart.ts`, rendered to SVG and PDF from one layout):
- Small multiples, one panel per period, with a shared y-axis and one line per language (fixed palette order,
  validated for colour-blind safety).
- Missing units break the line.
- Inferred zeros are hollow markers on dashed segments, while observed zeros are plotted normally.
- Incomplete periods are shaded, and spikes flagged by the analysis are ringed.
- A legend is always shown, with direct end labels for up to 4 languages.

## 5. Data-quality rules

Missing data is **never silently converted to zero**. Each expected observation (one per day or month)
carries `views: number | null`, a `status`, and a `certainty` (`established` or `uncertain`) with a `reason`.

**Classification order** (the first matching rule wins; implemented in `src/quality/classify.ts`):

| # | Condition | Status | Value | Certainty | Evidence |
|---|---|---|---|---|---|
| 1 | Unit ends today or later (UTC) | `incomplete` | `null` | established | Clock |
| 2 | Unit before 2015-07-01 | `unavailable` | `null` | established | Documented data start |
| 3 | Row present in the API response (including explicit `views: 0` rows) | `observed` | number | established | API row |
| 4 | Unit after the project's publication horizon | `unavailable` | `null` | established | Aggregate endpoint |
| 5 | Unit ends before the article's first revision | `before_creation` | `null` | established | MediaWiki first revision (**never a 404**) |
| 6a | Request failed (network, 5xx, exhausted 429, invalid response) | `api_error` | `null` | established | Transport result |
| 6b | Request returned HTTP 404 | `unavailable` | `null` | uncertain | 404 means "zero views" **or** "no data" |
| 6c | Creation date unknown, and the unit is before the first observed row | `unavailable` | `null` | uncertain | Could precede the article |
| 6d | Omitted from a successful response | `zero_omitted` | `0` | uncertain | See the empirical findings below |

Rules:

1. An HTTP 404 alone never implies zero views, non-existence, or a creation date.
2. **Coverage** = (`observed` + `zero_omitted`) / expected units, where expected units exclude `before_creation`
   and `incomplete`. Zero-view omissions are not missing data. Coverage is reported per period;
   coverage below 90 % raises `LOW_COVERAGE`.
3. Factual metrics are computed from counted units whenever they can be computed correctly. Trend interpretation
   is gated by the thresholds in §4.3.
4. Incomplete units have no value, even when Wikimedia returns one, and produce `INCOMPLETE_PERIOD_EXCLUDED`.
5. Warnings are preserved end-to-end: API → artifact → `research` stdout → PDF report. Clock-based warnings
   are reported once; per-language warnings carry `language`.
   - Quality warnings: `INCOMPLETE_PERIOD_EXCLUDED`, `DATA_NOT_YET_PUBLISHED`, `BEFORE_DATA_AVAILABILITY`,
     `CREATION_DATE_UNKNOWN`, `BEFORE_ARTICLE_CREATION`, `ZERO_VIEWS_INFERRED`, `PAGEVIEWS_NO_DATA`,
     `PAGEVIEWS_API_ERROR`, `LOW_COVERAGE`, `CACHE_WRITE_FAILED`
   - Resolution warnings: see §4.2
6. The artifact records provenance for reproducibility.

**Empirical findings (verified against the live API during Stage 3):**

- **Omitted days vs explicit zeros.** Days omitted from a `user` response had no rows for any agent. Explicit
  `views: 0` user rows are days with bot traffic only. An omission therefore means no recorded traffic at all.
  This is still an inference per unit, so `zero_omitted` stays `uncertain`.
- **Partial-month sums.** Monthly per-article requests with mid-month bounds return **partial-month sums labelled as
  full months**, e.g. 15–31 January reported as "January". Monthly requests are therefore always whole-month
  (enforced in code), and a range with no full month is rejected by the API with HTTP 400.
- **Current month.** Monthly per-article responses **include the current, incomplete month**. Rule 1 discards it.
- **Horizon probe.** The project aggregate endpoint always has views for published days, so its last row marks the
  publication horizon. This separates "not yet published" from "zero views".
- **Ambiguous 404s.** An HTTP 404 has the same body for "no data", "project not loaded" and "unknown project".
- **Pre-creation omissions.** Days before an article's creation are omitted exactly like zero-traffic days
  (ChatGPT, 2022-12-05). Creation dates are required to tell them apart.
- **Unicode and slashes.** Titles are sent with spaces as underscores and full percent-encoding (`AC/DC` → `AC%2FDC`).
  Unicode titles are echoed back unchanged in the `article` field.

## 6. Development stages

Each stage ends with tests passing and a review before the next begins.

| # | Stage | Output |
|---|---|---|
| 0 | Planning | This document ✅ |
| 1 | Scaffold | `package.json`, `tsconfig.json`, Vitest, `SKILL.md` skeleton, `scripts/wmr.ts` with `--help`/`--version`, argument parsing, dispatch, envelope, error model, input validation, core Zod schemas, `.env.example`, MIT license ✅ |
| 2 | Resolution | `wikimedia` client (User-Agent, retries), `resolve` command, editions, disambiguation, redirects, langlinks, mocked + live tests ✅ |
| 3 | Pageviews + quality | `periods`, article creation dates, pageview retrieval, publication horizon, `quality` classification, file cache, `research` collects data and saves the artifact ✅ |
| 4 | Analysis + `research` | `analysis` pure functions (metrics, comparisons, trend, spikes, cross-language), metric index, digest, METHODOLOGY.md ✅ |
| 5 | Charts + `report` | SVG/PDF chart from one layout, PDFKit + Noto Sans, conclusions validation, one-page layout, real example reports (in review) |
| 6 | OpenRouter harness | Tool loop, scenario scripts (single topic, multi-language, ambiguous topic, missing languages → clarification, follow-up, report), transcripts |
| 7 | Hardening | `references/` docs, follow-up flows, `skills-ref validate`, README, release |

## 7. Definition of Done (MVP)

- `skills-ref validate .` passes; `SKILL.md` < 500 lines with name matching the directory.
- Fresh clone → `npm ci --omit=dev` → `node scripts/wmr.ts research …` works on Node ≥ 24 with no build step.
- `npm test` and `npm run typecheck` pass; unit tests run offline using fixtures; `npm run test:live` passes against real Wikimedia APIs.
- All CLI outputs validate against Zod schemas; errors include actionable `hint`s.
- Every data-quality status and certainty in §5 is covered by tests; no missing value is silently zero-filled;
  no zero or creation date is inferred from a 404 alone.
- `report` renders a one-page PDF from a saved artifact without network access, in the user's language,
  including Ukrainian and Polish text.
- Same artifact + same conclusions → identical report content (deterministic).
- Harness scenarios complete end-to-end with the configured model; the model is never switched silently.
- No OpenRouter code, keys, or model names inside `src/`, `scripts/`, or `SKILL.md`.
- Limitations (pageviews ≠ people, language ≠ country) appear in CLI output and in every report.

## 8. Future roadmap (post-MVP)

- Cross-language normalization (article views as share of the edition's total views).
- Aggregating views across redirects and renamed titles.
- Multiple articles per language / topic clusters.
- Seasonality decomposition and more robust trend tests (e.g. Mann–Kendall).
- Forecasting.
- Advanced cache management (size limits, LRU eviction).
- Persistent research history.
- Access-type breakdown (desktop vs. mobile).
- Broader script coverage in reports (CJK, Arabic, Indic fonts) and a localization system.
- Additional data sources — only with a clear methodological reason.

## 9. Decision log

| # | Decision |
|---|---|
| D1 | No bundler / no committed build output; Node ≥ 24 native TypeScript execution. |
| D2 | Three commands: `research` (main, orchestrates), `resolve` (ambiguity), `report` (from saved data only). |
| D3 | Cross-language normalization moved to roadmap. |
| D4 | Missing observations are classified, never auto-zeroed; statuses carry certainty. |
| D5 | User-defined ranges; daily vs. monthly selected by the requested analysis. |
| D6 | Report accepts structured AI conclusions; statistics stay deterministic. |
| D7 | OpenRouter harness is dev/test only, inside the repo, no silent model switching, key never exposed. |
| D8 | `WMR_CONTACT` configures the User-Agent; default is the repository issues URL. |
| D9 | Default period: last 12 completed calendar months, stated explicitly by the agent. |
| D10 | `--langs` is required; agent derives languages from context or asks. |
| D11 | Granularity-specific trend thresholds; factual metrics always returned when calculable. |
| D12 | PDF follows the user's language; Unicode support; no localization framework. |
| D13 | MIT license. |
| D14 | Trend = Mann–Kendall + Theil–Sen + half-median check + spike robustness; daily data tested on 7-day blocks; "stable" also requires robust CV ≤ 0.5; fifth label `no_clear_trend`. |
| D16 | Stages reordered at the user's request: report (5) before the OpenRouter harness (6). |
| D17 | PDF via `pdfkit`, glyph checks and text measurement via `fontkit`, bundled Noto Sans (OFL); no SVG-to-PDF library, since one chart layout renders to both. Test-only: `unpdf` for PDF text extraction. |
| D18 | Conclusions may contain statistics only in findings backed by cited metrics; report labels built in for en/uk/pl only. |
| D15 | Totals only for complete periods with all expected units; averages need coverage ≥ 90 %; comparisons use unrounded values and lead with average daily views when durations differ. |
