---
name: wikipedia-market-research
description: Analyzes Wikipedia pageview statistics for a topic across language editions and time periods to gauge audience interest for B2C product research. Resolves the topic to verified Wikipedia articles, compares periods and languages, runs deterministic trend statistics with data-quality checks, and produces a chart and one-page PDF report. Use when the user asks about interest in a topic, market or product idea, Wikipedia pageviews, attention trends, or comparing interest between languages or periods.
license: MIT
compatibility: Requires Node.js >= 24 and npm, plus internet access to Wikimedia APIs (wikipedia.org, wikimedia.org).
metadata:
  version: "0.1.0"
  repository: https://github.com/OlehDribko/wikipedia-market-research
---

# Wikipedia Market Research

> **Development status (v0.1.0):** `resolve` works. `research` and `report` validate input but return
> `NOT_IMPLEMENTED`. Do not present pageview results to the user yet.

## Setup

Run once in the skill directory:

```bash
npm ci --omit=dev
```

Optional: set `WMR_CONTACT` (URL or email) to identify yourself to Wikimedia. See `.env.example`.

## Commands

All commands run from the skill directory and print one JSON object to stdout.
Check `ok`. On failure, read `error.code`, `error.message` and `error.hint`, then act on the hint.

| Command | Purpose |
|---|---|
| `node scripts/wmr.ts research ...` | Main command: resolve articles, fetch pageviews, analyze. Saves the full result file and prints a compact summary. |
| `node scripts/wmr.ts resolve ...` | List candidate articles when a topic is ambiguous. |
| `node scripts/wmr.ts report ...` | Build the PDF from a saved research file and your conclusions. Makes no API calls. |

Run `node scripts/wmr.ts <command> --help` for all options and examples.

## Resolving topics

`resolve` returns `data.status`:

- `resolved`: `data.source` is the verified source article. `data.articles` lists one entry per requested
  language, each with its own `status`. Only `verified` entries are usable. Report every language in
  `data.missingLanguages` as unavailable. Never replace it with a translated title or a search result.
- `ambiguous`: `data.candidates` lists possible articles. Ask the user which one they mean, then run
  `resolve` again with `--topic` set to that candidate's exact `title`.
- `not_found`: ask the user to rephrase the topic or name another source language.

Always follow `data.nextStep`. Article titles must come from CLI output. Never invent titles or assume
that a translated title exists. If a redirect warning shows the article is broader than the user's topic
(`REDIRECT_FOLLOWED`, `REDIRECT_TO_SECTION`), tell the user.

## Workflow

1. **Clarify the topic.** If the topic could mean several things (e.g. "Mercury"), run `resolve` and
   ask the user which article they mean, or choose only when the context makes it unambiguous.
2. **Choose languages.** `--langs` is required. Take the languages from the user's request or the
   conversation. If you cannot tell which languages they mean, **ask the user**. Never choose languages arbitrarily.
3. **Choose the period.** Use the user's dates:
   - A single range: pass `--start` and `--end`.
   - Periods to compare: pass `--compare`. Only those periods are analyzed.
   - No period at all: omit these flags. The CLI uses the **last 12 completed calendar months**.
     Tell the user you assumed this.
4. **Run `research`.** Read `warnings` and each language's data quality before interpreting anything.
5. **Interpret.** Explain the numbers the CLI returned. Do not compute or invent new statistics.
6. **Report (optional).** Write conclusions JSON in the user's language, then run `report`.
7. **Follow-ups.** For changed parameters (languages, dates, comparisons), run `research` again with
   the new flags. Cached data is reused automatically.

## Interpretation rules

- Pageviews are **not** unique people, visitors or customers.
- A Wikipedia language edition is **not** a country.
- Absolute views are not directly comparable across language editions (edition sizes differ).
- Use only numbers from CLI output. Every finding in a report must cite metric IDs from the research file.
- Treat trends marked `insufficient_data` as undetermined. You may still report the factual totals.
- Always tell the user about data-quality warnings and uncertain statuses.
- No forecasts: describe what happened in completed periods only.
