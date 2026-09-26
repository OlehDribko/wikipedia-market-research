import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  mentionsLanguageNotCountry,
  mentionsPageviewsNotPeople,
  mentionsSizeCaveat,
  unsupportedCausalClaims,
  unsupportedSignificance,
  ungroundedNumbers,
} from '../scenarios.ts';

// Offline checks of the harness heuristics. The fixture is the real scenario A answer of
// poolside/laguna-s-2.1:free (run 2026-09-26T15-47-25-409Z), audited manually.
const realAnswer = readFileSync(new URL('./fixtures/scenario-a-answer-v1.md', import.meta.url), 'utf8');
const realResearch = JSON.parse(readFileSync(new URL('./fixtures/scenario-a-research-result.json', import.meta.url), 'utf8'));

const goodAnswer = [
  'Ukrainian Wikipedia: daily views fell by 59.74% (69.6 → 28.02 per day); Polish Wikipedia: −24.2% (73.59 → 55.79).',
  'The Polish article showed a statistically significant decreasing trend in 2024 (p = 0.021).',
  'Pageviews are not unique people or customers, and a language edition is not a country.',
  'Language editions differ in size, so absolute views are not directly comparable between them.',
  'The causes of the spikes and of the decline are unknown; they could be tested as hypotheses.',
].join('\n');

describe('interpretation safeguards on the real scenario A answer', () => {
  it('detects the missing required limitations', () => {
    expect(mentionsPageviewsNotPeople(realAnswer)).toBe(false);
    expect(mentionsLanguageNotCountry(realAnswer)).toBe(false);
    expect(mentionsSizeCaveat(realAnswer)).toBe(false);
  });

  it('flags the unsupported causal claims found in the audit', () => {
    const flagged = unsupportedCausalClaims(realAnswer);
    expect(flagged).toHaveLength(2);
    expect(flagged[0]).toContain('accessibility issues specific to that audience');
    expect(flagged[1]).toContain('indicate occasional surges of interest');
  });

  it('flags "significant" without a p-value but accepts the quoted p = 0.021', () => {
    const flagged = unsupportedSignificance(realAnswer, [realResearch]);
    expect(flagged).toEqual([expect.stringContaining('Both languages saw significant declines')]);
  });

  it('no longer treats list markers as factual numbers', () => {
    expect(ungroundedNumbers(realAnswer, [realResearch])).toEqual([]);
  });
});

describe('interpretation safeguards on a compliant answer', () => {
  it('passes all checks', () => {
    expect(mentionsPageviewsNotPeople(goodAnswer)).toBe(true);
    expect(mentionsLanguageNotCountry(goodAnswer)).toBe(true);
    expect(mentionsSizeCaveat(goodAnswer)).toBe(true);
    expect(unsupportedCausalClaims(goodAnswer)).toEqual([]);
    expect(unsupportedSignificance(goodAnswer, [realResearch])).toEqual([]);
  });

  it('rejects p-values that are not below 0.05 or were not returned by a tool', () => {
    expect(unsupportedSignificance('The 2025 decline was significant (p = 0.737).', [realResearch])).toHaveLength(1);
    expect(unsupportedSignificance('The change is significant (p = 0.01).', [realResearch])).toHaveLength(1);
    expect(unsupportedSignificance('The change is not statistically significant.', [realResearch])).toEqual([]);
  });

  it('accepts hedged or explicitly unknown causes, and hypotheses', () => {
    expect(unsupportedCausalClaims('The drop may reflect a shift in audience behaviour; this is a hypothesis to validate.')).toEqual([]);
    expect(unsupportedCausalClaims('Causes of the spike are unknown.')).toEqual([]);
    expect(unsupportedCausalClaims('The decline was driven by new school curricula.')).toHaveLength(1);
    expect(unsupportedCausalClaims('The data indicates a 24.2% decline.')).toEqual([]);
  });
});

describe('grounding heuristic keeps checking real numbers', () => {
  it('ignores list markers but still flags invented numbers anywhere, including inside list items', () => {
    const answer = '1. Daily views: 69.6\n2) Roughly 12 000 people read it\n## 3. Summary\n- 4 languages grew by 40%';
    // "4 languages" after a bullet is a claim, not a list marker (only 2 languages were analysed).
    expect(ungroundedNumbers(answer, [realResearch])).toEqual(['12 000', '4', '40']);
  });
});

// Recorded answer of the controlled re-run (run 2026-09-26T17-20-31-825Z); by manual review it follows every rule.
const rerunAnswer = readFileSync(new URL('./fixtures/scenario-a-answer-v2.md', import.meta.url), 'utf8');

describe('former false positives on the re-run answer', () => {
  it('accepts equivalent "language ≠ country" wordings', () => {
    expect(mentionsLanguageNotCountry(rerunAnswer)).toBe(true);
    expect(mentionsLanguageNotCountry('Languages are not countries.')).toBe(true);
    expect(mentionsLanguageNotCountry('Wikipedia language editions include readers from many countries.')).toBe(true);
    // Controls: a statement that does not deny the equation is not accepted.
    expect(mentionsLanguageNotCountry('Polish Wikipedia is very popular in Poland.')).toBe(false);
    expect(mentionsLanguageNotCountry(realAnswer)).toBe(false);
  });

  it('does not treat methodological "due to" as a causal explanation', () => {
    expect(unsupportedCausalClaims('Both comparisons have limitations due to unequal period lengths (366 vs 365 days) and spikes present in the data.')).toEqual([]);
    expect(unsupportedCausalClaims('Totals are not comparable because of the leap year.')).toEqual([]);
    expect(unsupportedCausalClaims(rerunAnswer)).toEqual([]);
  });

  it('still flags causal explanations of the observed data', () => {
    expect(unsupportedCausalClaims('The decline was due to school holidays.')).toHaveLength(1);
    expect(unsupportedCausalClaims('Views dropped because readers moved to other platforms.')).toHaveLength(1);
    expect(unsupportedCausalClaims('Interest fell due to unequal access to education.')).toHaveLength(1);
    expect(unsupportedCausalClaims(realAnswer)).toHaveLength(2);
  });

  it.each(['p = 0.021', 'p=0.021', 'trendPValue: 0.021', 'p-value 0.021'])('recognises the p-value format "%s"', (format) => {
    expect(unsupportedSignificance(`The Polish 2024 trend was statistically significant (${format}).`, [realResearch])).toEqual([]);
  });

  it('lets a later trend sentence rely on a valid p-value stated earlier in the answer', () => {
    expect(unsupportedSignificance(rerunAnswer, [realResearch])).toEqual([]);
    const text = 'Polish 2024: decreasing trend (p = 0.021). In summary, the Polish edition showed a statistically significant decreasing trend in 2024.';
    expect(unsupportedSignificance(text, [realResearch])).toEqual([]);
  });

  it('still flags unsupported significance', () => {
    // A valid trend p-value earlier does not support "significant" for a period comparison (no test exists).
    const comparison = 'Polish 2024: decreasing trend (p = 0.021). Both languages saw significant declines from 2024 to 2025.';
    expect(unsupportedSignificance(comparison, [realResearch])).toEqual(['Both languages saw significant declines from 2024 to 2025.']);
    // Without any valid p-value, a trend sentence is unsupported.
    expect(unsupportedSignificance('The Ukrainian decreasing trend was significant.', [realResearch])).toHaveLength(1);
    // p-values at or above 0.05, or not returned by any tool, are rejected in every format.
    expect(unsupportedSignificance('The 2025 trend was significant (trendPValue: 0.737).', [realResearch])).toHaveLength(1);
    expect(unsupportedSignificance('The trend was significant (p=0.01).', [realResearch])).toHaveLength(1);
    // The recorded old answer keeps its real error: "significant declines" comes after the valid p=0.021.
    expect(unsupportedSignificance(realAnswer, [realResearch])).toEqual([expect.stringContaining('Both languages saw significant declines')]);
  });
});
