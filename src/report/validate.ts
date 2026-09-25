import type { MetricEntry } from '../schemas/analysis.ts';
import type { Conclusions } from '../schemas/conclusions.ts';
import type { ResearchArtifact } from '../schemas/research.ts';
import { unsupportedCharacters } from './fonts.ts';
import { extractIsoYears, extractNumbers, isSupported } from './numbers.ts';

export interface ConclusionIssue {
  path: string;
  code: 'UNKNOWN_METRIC' | 'UNSUPPORTED_NUMBER' | 'DATE_OUTSIDE_RESEARCH' | 'UNSUPPORTED_CHARACTERS';
  message: string;
  suggestions?: string[];
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0] as number;
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j] as number;
      previous[j] = Math.min(above + 1, (previous[j - 1] as number) + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length] as number;
}

function closestIds(id: string, ids: readonly string[], count = 3): string[] {
  return [...ids].sort((x, y) => levenshtein(id, x) - levenshtein(id, y) || x.localeCompare(y)).slice(0, count);
}

/** Numbers a metric legitimately shows in text: its value, and ratios also as percentages. */
function metricNumbers(entry: MetricEntry): number[] {
  if (typeof entry.value !== 'number') return [];
  return entry.unit === 'ratio' ? [entry.value, entry.value * 100] : [entry.value];
}

/** Numbers that describe the research setup rather than results: years, period lengths, counts, title digits. */
function contextNumbers(artifact: ResearchArtifact): { numbers: number[]; years: Set<number> } {
  const years = new Set<number>();
  const numbers: number[] = [artifact.datasets.length, artifact.plan.periods.length];
  for (const period of artifact.plan.periods) {
    for (let year = Number(period.start.slice(0, 4)); year <= Number(period.end.slice(0, 4)); year++) years.add(year);
    const months = (Number(period.end.slice(0, 4)) - Number(period.start.slice(0, 4))) * 12 + Number(period.end.slice(5, 7)) - Number(period.start.slice(5, 7)) + 1;
    numbers.push(months);
  }
  for (const entry of Object.values(artifact.analysis.metrics)) if (entry.unit === 'days' && typeof entry.value === 'number') numbers.push(entry.value);
  const titles = [artifact.resolution.topic, ...artifact.datasets.map((dataset) => dataset.title)].join(' ');
  for (const token of extractNumbers(titles)) numbers.push(...token.readings.map((reading) => reading.value));
  return { numbers: [...numbers, ...years], years };
}

/**
 * Checks AI conclusions against the saved research artifact:
 * - every evidence ID exists in `analysis.metrics`;
 * - every number in a finding matches a metric the finding cites (rounding allowed) or a research-setup number;
 * - the headline, hypotheses and limitations contain only research-setup numbers (years, period lengths, counts);
 * - `validationIdea` may contain planning numbers (e.g. "interview 20 users");
 * - ISO dates lie within the research periods;
 * - every character can be rendered by the report font.
 */
export function validateConclusions(conclusions: Conclusions, artifact: ResearchArtifact): ConclusionIssue[] {
  const issues: ConclusionIssue[] = [];
  const metrics = artifact.analysis.metrics;
  const ids = Object.keys(metrics);
  const context = contextNumbers(artifact);

  const checkText = (path: string, text: string, allowed: readonly number[], allowedSource: string) => {
    for (const year of extractIsoYears(text)) {
      if (!context.years.has(year)) {
        issues.push({ path, code: 'DATE_OUTSIDE_RESEARCH', message: `${path} mentions a date in ${year}, outside the research periods.` });
      }
    }
    for (const token of extractNumbers(text)) {
      if (!isSupported(token, allowed)) {
        issues.push({
          path,
          code: 'UNSUPPORTED_NUMBER',
          message: `${path} contains the number "${token.raw}", which does not match ${allowedSource}. Use the exact metric value (rounding is allowed), cite the metric that contains it, or remove the number.`,
        });
      }
    }
  };

  // Outside findings there is no evidence to check against, so only research-setup numbers are allowed.
  const noEvidence = 'the research setup (years, period lengths, counts); statistical numbers belong in findings with evidence';
  checkText('headline', conclusions.headline, context.numbers, noEvidence);

  conclusions.findings.forEach((finding, index) => {
    const path = `findings[${index}]`;
    const cited: number[] = [];
    finding.evidence.forEach((id, evidenceIndex) => {
      const entry = metrics[id];
      if (!entry) {
        issues.push({
          path: `${path}.evidence[${evidenceIndex}]`,
          code: 'UNKNOWN_METRIC',
          message: `Metric "${id}" does not exist in the research file.`,
          suggestions: closestIds(id, ids),
        });
      } else {
        cited.push(...metricNumbers(entry));
      }
    });
    const citedIds = finding.evidence.filter((id) => metrics[id]).join(', ') || 'none';
    checkText(`${path}.statement`, finding.statement, [...cited, ...context.numbers], `its cited metrics (${citedIds})`);
  });

  conclusions.hypotheses.forEach((hypothesis, index) => {
    checkText(`hypotheses[${index}].hypothesis`, hypothesis.hypothesis, context.numbers, noEvidence);
  });
  conclusions.limitations.forEach((limitation, index) => {
    checkText(`limitations[${index}]`, limitation, context.numbers, noEvidence);
  });

  const texts: [string, string][] = [
    ['headline', conclusions.headline],
    ...conclusions.findings.map((finding, index): [string, string] => [`findings[${index}].statement`, finding.statement]),
    ...conclusions.hypotheses.flatMap((hypothesis, index): [string, string][] => [
      [`hypotheses[${index}].hypothesis`, hypothesis.hypothesis],
      [`hypotheses[${index}].validationIdea`, hypothesis.validationIdea],
    ]),
    ...conclusions.limitations.map((limitation, index): [string, string] => [`limitations[${index}]`, limitation]),
    ...Object.entries(conclusions.labels ?? {}).map(([key, value]): [string, string] => [`labels.${key}`, value]),
  ];
  for (const [path, text] of texts) {
    const missing = unsupportedCharacters(text);
    if (missing.length > 0) {
      issues.push({
        path,
        code: 'UNSUPPORTED_CHARACTERS',
        message: `${path} contains characters the report font cannot display: ${missing.map((character) => JSON.stringify(character)).join(', ')}. Remove them (emoji, symbols) or rephrase.`,
      });
    }
  }
  return issues;
}
