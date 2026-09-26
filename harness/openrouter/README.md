# OpenRouter integration test harness

This directory is **development and testing infrastructure**. It is not part of the Agent Skill.

| | Agent Skill | This harness |
|---|---|---|
| Defined by | `SKILL.md` + `scripts/wmr.ts` + `src/` | `harness/openrouter/` |
| Needs | Node.js ≥ 24, `npm ci --omit=dev` | Dev dependencies, an OpenRouter API key |
| Used by | Any agent that can read `SKILL.md` and run shell commands | Maintainers, to check that a lightweight model can use the skill |
| Knows about OpenRouter | No | Yes |

**The dependency goes one way:** harness → skill CLI (as a child process).
- `src/`, `scripts/` and `SKILL.md` never import or mention OpenRouter.
- The OpenRouter SDK is a dev dependency, so `npm ci --omit=dev` doesn't install it.

## How it works

1. **System prompt.** `run.ts` loads `SKILL.md` as the system prompt, with a short preamble that maps CLI commands to
   tools (`agent.ts`).
2. **Tools** (`tools.ts`). The model sees four small tools:
   - `resolve`, `research` and `report` map 1:1 to `node scripts/wmr.ts <command>`. `report` takes the conclusions
     as an object, and the harness writes the file.
   - `research_metrics` is read-only. It returns metric IDs and values from a saved research file (never raw
     observations), so the model can cite exact evidence.
3. **Execution** (`cli.ts`):
   - Commands run with `execFile(process.execPath, ['scripts/wmr.ts', …])`: an argument array and no shell.
   - The skill process gets a filtered environment without `OPENROUTER_API_KEY`.
   - Files can be read only inside the run's own directory.
4. **Agent loop** (`agent.ts`).
   - It keeps the whole conversation, so follow-ups work.
   - A turn stops after 12 model calls.
   - Report validation errors go back to the model unchanged. After **3** invalid report attempts in a turn, the
     turn stops with `report_validation_failed`. Validation is never bypassed.
5. **Model** (`model.ts`).
   - The official `@openrouter/sdk`, with non-streaming chat completions and function tools.
   - Only rate limits (429) are retried.
   - The model is **never switched** automatically.
   - Failures are classified as `model_unavailable`, `rate_limited`, `payment_required`, `unauthorized`,
     `bad_request`, `provider_error` or `network`.
6. **Evidence** (`transcript.ts`, `run.ts`).
   - Every run writes `runs/<timestamp>/` (git-ignored), containing `summary.json`, `transcript.md`,
     `transcript.json`, research files, conclusions, PDFs and SVGs.
   - The key is redacted. The run also aborts if any output file contains the key.

## Running

```bash
cp .env.example .env         # then set OPENROUTER_API_KEY (and optionally OPENROUTER_MODEL)
npm run harness -- ping          # minimal tool-calling test (one tool call, result fed back)
npm run harness -- short         # short 2-turn conversation (about 4 model calls)
npm run harness -- scenario-a    # scenario A alone, for controlled re-runs
npm run harness -- conversation  # scenarios A, B, C, E in one conversation (C and E depend on A's context)
npm run harness -- mercury       # scenario D (ambiguous topic) in a fresh conversation
npm run harness -- all
```

- **Default model:** `OPENROUTER_MODEL` defaults to `poolside/laguna-s-2.1:free`, the model used for the live runs.
  The originally preferred `google/gemma-4-26b-a4b-it:free` returned HTTP 429 throughout testing; set it explicitly
  to try it again.
- **Rate limits:** `OPENROUTER_RATE_LIMIT_RETRIES` (default 3) sets how often the same model is retried after HTTP 429.
  A turn that still fails is recorded as `model_error: rate_limited`. Free endpoints share an upstream pool, so this
  is a provider limitation, not a skill failure.
- **Per-call evidence:** `summary.json` records, for each model call, the HTTP status, the model OpenRouter actually
  served, the latency and the finish reason.
- **Other models:** to use another model, set `OPENROUTER_MODEL` explicitly. The harness never changes it by itself.
- **Separate cache:** each run uses its own cache directory, so cache reuse between turns is visible in the results.

## Tests

- **`harness/openrouter/tests/` (part of `npm test`):**
  - The model is **mocked**: a scripted model client drives the real tools, the real CLI child process and real
    report validation.
  - These tests verify the harness mechanics. They are **not** evidence that a live model can use the skill.
- **Live evidence** comes only from `npm run harness`, with the model ID and date recorded in `summary.json`.
  Results of the 2026-09-25/26 live runs are summarized in the root `README.md`.
- **Automatic checks are heuristics** (`scenarios.ts`): they cover tool use, required caveats, unsupported causes,
  unsupported "significant" and numbers not returned by tools. They are tested against recorded real answers in
  `tests/fixtures/`, mainly target English, and cannot verify every semantic claim (e.g. the direction of a
  comparison). Read `transcript.md` for qualitative review.
