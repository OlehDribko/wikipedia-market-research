# Wikipedia Market Research — Agent Skill

A standalone [Agent Skill](https://agentskills.io/specification) that lets an AI agent research **audience interest in a
topic** using Wikipedia pageview statistics, across language editions and time periods. It is aimed at B2C founders
who want evidence-based hypotheses before validating a product idea.

The skill:
- resolves a topic to verified Wikipedia articles in each requested language;
- retrieves pageviews from the Wikimedia API, with data-quality checks;
- computes deterministic statistics: totals, averages, period comparisons, trends and spikes;
- produces a one-page PDF report with a chart. The model writes the conclusions in the user's language. Built-in
  labels exist for English, Ukrainian and Polish; other languages get English labels unless custom labels are given.
  The PDF font covers Latin, Cyrillic and Greek.

## Architecture and flow

```
user ──► LLM agent ──reads──► SKILL.md (+ references/METHODOLOGY.md)
             │
             ├─► node scripts/wmr.ts resolve   → verified articles / ambiguity candidates
             ├─► node scripts/wmr.ts research  → Wikimedia pageviews → data-quality classification
             │                                   → deterministic statistics → research file + compact JSON
             └─► node scripts/wmr.ts report    → conclusions validated against the research file
                                                 → one-page PDF + SVG chart
             ◄── answer / report
```

**Deterministic in TypeScript:**
- article verification;
- pageview retrieval and caching;
- data-quality statuses (missing data is never silently zero);
- all statistics;
- chart and PDF rendering;
- validation of the report input.

**Model-dependent:**
- understanding the request and choosing parameters;
- asking clarification questions;
- interpreting the results in natural language;
- writing conclusions.

**Guards:**
- every CLI input and output is validated with Zod;
- report findings must cite existing metric IDs, and every number in a finding must equal a cited metric value;
- invalid conclusions return a structured error the agent can correct.

The CLI prints one JSON object per command. See `SKILL.md` for the agent-facing contract, `references/METHODOLOGY.md`
for statistical definitions, and `PROJECT_PLAN.md` for design decisions.

## Install and run

Requires **Node.js ≥ 24**. TypeScript runs natively, with no build step.

```bash
npm ci --omit=dev                      # runtime dependencies only (axios, zod, pdfkit, fontkit)
node scripts/wmr.ts --help
node scripts/wmr.ts research --article en:Astronomy --langs uk,pl --compare 2024-01..2024-12,2025-01..2025-12
node scripts/wmr.ts report --research <artifactPath> --conclusions conclusions.json
```

A complete real example (research file, conclusions, PDF and SVG) is in `examples/astronomy-2024-vs-2025/`.

### Environment variables

| Variable | Used by | Required | Purpose |
|---|---|---|---|
| `WMR_CONTACT` | skill | no | Contact URL or email for the Wikimedia User-Agent (default: this repository's issue tracker) |
| `WMR_CACHE_DIR` | skill | no | Cache directory (default: `$XDG_CACHE_HOME` or `~/.cache/wikipedia-market-research`) |
| `OPENROUTER_API_KEY` | harness only | for live tests | OpenRouter key; never passed to the skill process or written to transcripts |
| `OPENROUTER_MODEL` | harness only | no | Model for live tests (default and live-verified: `poolside/laguna-s-2.1:free`) |
| `OPENROUTER_RATE_LIMIT_RETRIES` | harness only | no | Retries after HTTP 429 (default 3) |

Copy `.env.example` to `.env` for local settings. `.env` is git-ignored.

## Tests

```bash
npm ci                 # includes dev dependencies
npm run check          # type check (tsc) + full offline test suite (Vitest)
```

The offline suite has 319 tests: 314 run, and the 5 live tests are skipped. It needs no network, because Wikimedia
responses are mocked and report tests use a recorded real research file. It covers:
- CLI and schemas;
- resolution;
- pageviews and data quality;
- cache;
- statistics;
- charts, PDF and conclusions validation;
- the OpenRouter harness, with a scripted (mocked) model.

**Optional live tests:**

```bash
npm run test:live                          # real Wikimedia API (resolution, pageviews, end-to-end CLI)
npm run harness -- ping                    # real LLM via OpenRouter: one tool call
npm run harness -- conversation            # scenarios A, B, C, E in one conversation
npm run harness -- mercury                 # scenario D (ambiguous topic)
```

**Live LLM tests are optional.** They need an OpenRouter key. Free OpenRouter models share an upstream pool and often
return **HTTP 429**. The harness retries a few times and then reports the failure as a provider limitation. It never
switches models on its own. Details: `harness/openrouter/README.md`.

## Agent Skill vs. OpenRouter test harness

| | Agent Skill | OpenRouter harness |
|---|---|---|
| Files | `SKILL.md`, `scripts/`, `src/`, `references/`, `assets/` | `harness/openrouter/` |
| Purpose | Used by any agent that can read `SKILL.md` and run shell commands | Development test: can a lightweight model use the skill? |
| Depends on OpenRouter | No; no OpenRouter code or key | Yes (`@openrouter/sdk`, dev dependency) |

The harness runs the skill CLI as a child process, with an argument array and no shell, so the dependency goes only
one way. The skill was tested live **only** through this harness; it has not been tested in other agent products.

## What was verified live (2026-09-25/26)

- **Wikimedia (real API):** resolution of Astronomy in uk/pl/de, pageviews and statistics. The daily sums match the
  monthly values, and every total in the report equals the sum of the saved observations.
- **LLM via OpenRouter**, with `poolside/laguna-s-2.1:free`. OpenRouter reported that model as serving every call.

| Scenario | Result | Model calls | Tools, in order |
|---|---|---|---|
| Minimal tool call | ✓ | 2 | `resolve` |
| A: compare uk/pl, 2024 vs 2025 | ✓ | 3 | `resolve` → `research` |
| B: Ukrainian PDF report | ✓ (one-page PDF + SVG) | 3 | `research_metrics` → `report` |
| C: follow-up with German, 2025 only | ✓ (cache reused: 4 hits) | 3 | `resolve` → `research` |
| D: "Research Mercury." (ambiguous) | ✓ (asked for clarification, did not guess) | 2 | `resolve` |
| E: "How many people in Poland…?" | ✓ (refused to estimate people; caveats given) | 1 | none |

- **Validation recovery.** In an earlier run of B, the model's first conclusions failed validation with 10 numbers
  not backed by the cited metrics. It corrected them from the structured error and succeeded on the second attempt.
- **Provider limits.**
  - Several runs stopped with HTTP 429 from the free shared pool; these were infrastructure limits, not skill
    failures.
  - `google/gemma-4-26b-a4b-it:free` returned 429 throughout.
  - `thinkingmachines/inkling:free` returned 403, because it is gated to listed apps.

## Known limitations

- **Interpretation depends on the model.** Numbers and statistics are deterministic, but what the model *says* about
  them is not. In live runs Laguna twice described a widening gap between languages as "narrowing", and once called
  "no clear trend" "relatively stable".
- **Semantic checks are limited.** Deterministic pattern checks catch important error classes (missing caveats,
  unsupported causes, unsupported "significant", numbers not returned by tools). They cannot fully verify semantic
  claims such as the direction of a comparison.
- **The harness's semantic checks mainly target English.** Report validation (metric IDs and numbers) works in any
  language.
- **Free OpenRouter endpoints are rate-limited** and may be unavailable or restricted for long periods.
- **Manual review is still needed.** Reading transcripts remains useful for qualitative claims.
- **Scope limits:**
  - one article per language;
  - no cross-language normalization, so absolute views differ with edition size;
  - built-in PDF labels exist only for en/uk/pl;
  - the PDF font covers Latin, Cyrillic and Greek only.

## Future iterations

These are not required for the current submission.

- **Model access:**
  - a provider and model abstraction, with capability-aware model selection;
  - a configurable fallback chain (primary model → fallback A → fallback B), e.g. using OpenRouter's ordered model
    routing;
  - a better free/paid reliability strategy: bring-your-own provider keys, cost and availability policies.
- **Answer quality:**
  - stronger semantic verification of comparative claims against the research file;
  - an optional evaluator or critic pass for qualitative conclusions;
  - semantic safeguards in more languages.
- **Efficiency and measurement:**
  - token and context efficiency: smaller tool results and prompt caching;
  - recording and comparing model quality across repeated evaluation runs.

## License

MIT (code). Noto Sans fonts in `assets/fonts/` are under the SIL Open Font License 1.1.
