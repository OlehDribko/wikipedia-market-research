import type { Comparison, PeriodAnalysis } from '../schemas/analysis.ts';
import type { Conclusions } from '../schemas/conclusions.ts';
import type { ResearchArtifact } from '../schemas/research.ts';
import { VERSION } from '../version.ts';
import type { NumberFormatter } from './format.ts';
import { translateLabel, type Labels } from './labels.ts';

export interface TableCell {
  text: string;
  bold?: boolean;
}

export interface Table {
  headers: string[];
  rows: TableCell[][];
  align: ('left' | 'right')[];
}

/** Everything the PDF shows, already formatted. Numbers come only from the artifact. */
export interface ReportModel {
  language: string;
  title: string;
  headline: string;
  meta: string;
  articles: { text: string; url: string }[];
  unavailable: string[];
  metrics: Table;
  comparisons: Table | null;
  findings: { statement: string; evidence: string }[];
  hypotheses: { hypothesis: string; validation: string }[];
  limitations: string[];
  dataQuality: string[];
  footer: string;
  labels: Labels;
}

function periodLabel(period: { start: string; end: string }): string {
  return `${period.start} – ${period.end}`;
}

function periodRows(artifact: ResearchArtifact, labels: Labels, format: NumberFormatter): TableCell[][] {
  const monthly = artifact.plan.granularity === 'monthly';
  const cell = (value: number | null, render: (n: number) => string): TableCell => ({ text: value === null ? labels.notAvailable : render(value) });
  return artifact.analysis.languages.flatMap((language) =>
    language.periods.map((period: PeriodAnalysis) => [
      { text: language.lang, bold: true },
      { text: periodLabel(period) },
      cell(period.metrics.total, (n) => format.integer(n)),
      cell(period.metrics.averageDaily, (n) => format.decimal(n)),
      ...(monthly ? [cell(period.metrics.averageMonthly, (n) => format.decimal(n))] : []),
      { text: labels.trendLabels[period.trend.direction] },
      cell(period.metrics.coverage, (n) => format.ratio(n)),
      { text: period.anomalies.checked ? format.integer(period.anomalies.anomalies.length) : labels.notAvailable },
    ]),
  );
}

function comparisonRows(comparisons: readonly Comparison[], labels: Labels, format: NumberFormatter): TableCell[][] {
  const percent = (value: number | null, primary: boolean): TableCell => ({
    text: value === null ? labels.notAvailable : format.signedPercent(value),
    bold: primary && value !== null,
  });
  return comparisons.map((comparison) => [
    { text: comparison.lang, bold: true },
    { text: `${periodLabel(comparison.baseline)} ${labels.versus} ${periodLabel(comparison.current)}` },
    percent(comparison.percentChange, comparison.primaryMeasure === 'total'),
    percent(comparison.averageDailyPercentChange, comparison.primaryMeasure === 'averageDaily'),
    { text: labels.statusLabels[comparison.status] },
  ]);
}

export function buildReportModel(
  artifact: ResearchArtifact,
  conclusions: Conclusions,
  options: { labels: Labels; format: NumberFormatter; generatedAt: Date },
): ReportModel {
  const { labels, format } = options;
  const { resolution, plan, analysis } = artifact;
  const source = resolution.source;
  const metrics = analysis.metrics;
  const editions = new Map(resolution.articles.map((article) => [article.lang, article.edition]));

  const meta = [
    source ? `${labels.sourceArticle}: ${source.title} (${source.lang})` : null,
    `${labels.periods}: ${plan.periods.map(periodLabel).join('; ')}`,
    plan.granularity === 'daily' ? labels.daily : labels.monthly,
    `${labels.generated}: ${options.generatedAt.toISOString().slice(0, 10)}`,
  ]
    .filter((part) => part !== null)
    .join('  ·  ');

  const articles = artifact.datasets.map((dataset) => {
    const edition = editions.get(dataset.lang);
    const name = edition ? ` (${edition.autonym})` : '';
    return { text: `${dataset.lang}${name}: ${dataset.title}${dataset.wikidataId ? ` · ${dataset.wikidataId}` : ''}`, url: dataset.url };
  });
  const unavailable = artifact.unavailableLanguages.map((language) => {
    const edition = editions.get(language.lang);
    return `${language.lang}${edition ? ` (${edition.autonym})` : ''}: ${labels.noArticle}`;
  });

  const monthly = plan.granularity === 'monthly';
  const metricsTable: Table = {
    headers: [labels.language, labels.period, labels.total, labels.perDay, ...(monthly ? [labels.perMonth] : []), labels.trend, labels.coverage, labels.spikes],
    rows: periodRows(artifact, labels, format),
    align: ['left', 'left', 'right', 'right', ...(monthly ? (['right'] as const) : []), 'left', 'right', 'right'],
  };
  const comparisonTable: Table | null =
    analysis.comparisons.length === 0
      ? null
      : {
          headers: [labels.language, labels.period, labels.changeTotal, labels.changePerDay, labels.reliability],
          rows: comparisonRows(analysis.comparisons, labels, format),
          align: ['left', 'left', 'right', 'right', 'left'],
        };

  const findings = conclusions.findings.map((finding) => ({
    statement: finding.statement,
    evidence: `${labels.evidence}: ${finding.evidence
      .map((id) => {
        const entry = metrics[id];
        return entry ? `${id} = ${format.metric(entry, labels.notAvailable, (value) => translateLabel(labels, value))}` : id;
      })
      .join('; ')}`,
  }));

  const dataQuality = artifact.datasets.map((dataset) => {
    const counts = dataset.quality.counts;
    return `${dataset.lang}: ${format.integer(counts.observed)} ${labels.observed} · ${format.integer(counts.zero_omitted)} ${labels.inferredZeros} · ${format.integer(
      counts.unavailable + counts.api_error,
    )} ${labels.missing} · ${format.integer(counts.incomplete)} ${labels.incomplete} · ${format.integer(counts.before_creation)} ${labels.beforeCreation}`;
  });
  const warningCodes = [...new Set(artifact.warnings.map((warning) => warning.code))];
  if (warningCodes.length > 0) dataQuality.push(`${labels.warnings}: ${warningCodes.join(', ')}`);

  // Prefer the verified article in the report language for the title (e.g. "Астрономія" in a Ukrainian report).
  const primaryLanguage = conclusions.language.toLowerCase().split('-')[0];
  const topicTitle = artifact.datasets.find((dataset) => dataset.lang === primaryLanguage)?.title ?? source?.title ?? resolution.topic;
  return {
    language: conclusions.language,
    title: conclusions.labels?.title ?? `${labels.defaultTitle}: ${topicTitle}`,
    headline: conclusions.headline,
    meta,
    articles,
    unavailable,
    metrics: metricsTable,
    comparisons: comparisonTable,
    findings,
    hypotheses: conclusions.hypotheses.map((hypothesis) => ({ hypothesis: hypothesis.hypothesis, validation: `${labels.validation}: ${hypothesis.validationIdea}` })),
    limitations: [...labels.mandatoryLimitations, ...conclusions.limitations],
    dataQuality,
    footer: `${labels.sources}: ${labels.sourceText
      .replace('{id}', artifact.id)
      .replace('{methodology}', String(analysis.methodologyVersion))
      .replace('{version}', artifact.tool.version || VERSION)}`,
    labels,
  };
}
