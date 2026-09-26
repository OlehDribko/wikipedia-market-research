import { createHash } from 'node:crypto';
import { resolve as resolvePath, join } from 'node:path';
import { analyzeResearch } from '../analysis/analyze.ts';
import { writeFileAtomic } from '../cache/atomicWrite.ts';
import type { FileCache } from '../cache/fileCache.ts';
import { todayUtc } from '../periods/dates.ts';
import { planPeriods, unitLabel, type PeriodPlan } from '../periods/plan.ts';
import { dedupeWarnings } from '../quality/summary.ts';
import type { Analysis } from '../schemas/analysis.ts';
import type { Warning } from '../schemas/envelope.ts';
import type { ResearchRequest } from '../schemas/inputs.ts';
import { ResearchArtifactSchema, RESEARCH_ARTIFACT_FORMAT, type Dataset, type ResearchArtifact } from '../schemas/research.ts';
import type { ResolveResult } from '../schemas/resolve.ts';
import { VERSION } from '../version.ts';
import type { JsonClient } from '../wikimedia/http.ts';
import { PAGEVIEWS_API } from '../wikimedia/pageviews.ts';
import { RESOLVE_LIMITATIONS, resolveTopic } from '../wikimedia/resolve.ts';
import { collectDataset, createCollectContext, type CacheStats } from './collect.ts';

export const PAGEVIEW_LIMITATIONS: readonly string[] = [
  'Pageviews are not unique people, visitors or customers.',
  'A Wikipedia language edition is not a country; readers of one edition live in many countries.',
  'Absolute views are not directly comparable across language editions, which differ in size.',
  'Only human traffic (agent=user, all access methods) is counted; some automated traffic may still be classified as human.',
  'Views under former titles of renamed articles are not included.',
];

export type ResearchErrorCode = 'AMBIGUOUS_TOPIC' | 'TOPIC_NOT_FOUND' | 'ARTICLE_NOT_FOUND' | 'NO_VERIFIED_ARTICLES';

/** The subject could not be resolved to verified articles; carries what the agent needs to recover. */
export class ResearchResolutionError extends Error {
  readonly code: ResearchErrorCode;
  readonly details: unknown;

  constructor(code: ResearchErrorCode, message: string, details: unknown) {
    super(message);
    this.name = 'ResearchResolutionError';
    this.code = code;
    this.details = details;
  }
}

export class OutputWriteError extends Error {
  constructor(path: string, cause: unknown) {
    super(`Could not write the research file ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'OutputWriteError';
  }
}

export interface ResearchDeps {
  api: JsonClient;
  cache: FileCache | null;
  now: () => Date;
}

export interface ResearchSummary {
  artifactPath: string;
  source: { lang: string; title: string; url: string };
  periodMode: PeriodPlan['mode'];
  periods: PeriodPlan['periods'];
  granularity: { selected: PeriodPlan['granularity']; reason: string };
  languages: {
    lang: string;
    title: string;
    url: string;
    wikidataId: string | null;
    createdAt: string | null;
    publishedThrough: string;
    units: number;
    counts: Dataset['quality']['counts'];
    uncertain: number;
    coverage: { periodId: string; coverage: number | null }[];
  }[];
  unavailableLanguages: ResearchArtifact['unavailableLanguages'];
  cache: CacheStats & { enabled: boolean };
  analysis: AnalysisDigest;
  nextStep: string;
}

/** Compact view of the analysis for the CLI response; the artifact holds everything. */
export interface AnalysisDigest {
  metricIdPattern: string;
  periods: {
    lang: string;
    periodId: string;
    total: number | null;
    averageDaily: number | null;
    averageMonthly: number | null;
    coverage: number | null;
    trend: string;
    trendSlopeSpanPercentOfMedian: number | null;
    trendPValue: number | null;
    spikes: number;
    largestUnitShare: number | null;
  }[];
  comparisons: {
    id: string;
    lang: string;
    percentChange: number | null;
    averageDailyPercentChange: number | null;
    primaryMeasure: string | null;
    status: string;
    issues: string[];
  }[];
  /** `period` is a day (YYYY-MM-DD) for daily data or a whole calendar month (YYYY-MM) for monthly data. */
  topSpikes: { lang: string; periodId: string; period: string; views: number; ratioToBaseline: number | null }[];
  crossLanguage: { periodId: string; byAverageDaily: string[] }[];
}

const TOP_SPIKES = 5;

export function digestAnalysis(analysis: Analysis, granularity: PeriodPlan['granularity']): AnalysisDigest {
  const spikes = analysis.languages.flatMap((language) =>
    language.periods.flatMap((period) =>
      period.anomalies.anomalies.map((anomaly) => ({
        lang: language.lang,
        periodId: period.periodId,
        period: unitLabel(anomaly.period, granularity),
        views: anomaly.views,
        ratioToBaseline: anomaly.ratioToBaseline,
      })),
    ),
  );
  return {
    metricIdPattern: '<lang>.<periodId>.<metric> (e.g. uk.main.averageDaily) or <lang>.<baselineId>_vs_<currentId>.<metric> (e.g. uk.compare-1_vs_compare-2.percentChange)',
    periods: analysis.languages.flatMap((language) =>
      language.periods.map((period) => ({
        lang: language.lang,
        periodId: period.periodId,
        total: period.metrics.total,
        averageDaily: period.metrics.averageDaily,
        averageMonthly: period.metrics.averageMonthly,
        coverage: period.metrics.coverage,
        trend: period.trend.direction,
        trendSlopeSpanPercentOfMedian: period.trend.slopeSpanPercentOfMedian,
        trendPValue: period.trend.mannKendall?.pValue ?? null,
        spikes: period.anomalies.anomalies.length,
        largestUnitShare: period.metrics.largestUnitShare,
      })),
    ),
    comparisons: analysis.comparisons.map((comparison) => ({
      id: comparison.id,
      lang: comparison.lang,
      percentChange: comparison.percentChange,
      averageDailyPercentChange: comparison.averageDailyPercentChange,
      primaryMeasure: comparison.primaryMeasure,
      status: comparison.status,
      issues: comparison.issues,
    })),
    topSpikes: spikes.sort((a, b) => (b.ratioToBaseline ?? 0) - (a.ratioToBaseline ?? 0)).slice(0, TOP_SPIKES),
    crossLanguage: analysis.crossLanguage.map((entry) => ({ periodId: entry.periodId, byAverageDaily: entry.ranking.map((row) => row.lang) })),
  };
}

export interface ResearchOutcome {
  artifact: ResearchArtifact;
  summary: ResearchSummary;
  warnings: Warning[];
  limitations: string[];
}

function assertResolved(request: ResearchRequest, resolution: ResolveResult): asserts resolution is ResolveResult & { source: NonNullable<ResolveResult['source']> } {
  if (resolution.status === 'resolved') return;
  const details = { status: resolution.status, reason: resolution.reason, candidates: resolution.candidates };
  if (request.subject.kind === 'article') {
    throw new ResearchResolutionError(
      resolution.reason === 'disambiguation_page' ? 'AMBIGUOUS_TOPIC' : 'ARTICLE_NOT_FOUND',
      resolution.reason === 'disambiguation_page'
        ? `"${request.subject.title}" (${request.subject.lang}) is a disambiguation page, not a topic article.`
        : `No article titled "${request.subject.title}" exists in ${request.subject.lang}.wikipedia.org.`,
      details,
    );
  }
  if (resolution.status === 'ambiguous') {
    throw new ResearchResolutionError('AMBIGUOUS_TOPIC', `"${resolution.topic}" does not identify a single article.`, details);
  }
  throw new ResearchResolutionError('TOPIC_NOT_FOUND', `No Wikipedia article matches "${resolution.topic}".`, details);
}

function artifactId(request: ResearchRequest, plan: PeriodPlan): string {
  const identity = JSON.stringify({ subject: request.subject, languages: request.languages, periods: plan.periods, granularity: plan.granularity });
  return createHash('sha256').update(identity).digest('hex').slice(0, 12);
}

function nextStep(plan: PeriodPlan, datasets: readonly Dataset[]): string {
  const parts = [
    'Interpret only the metrics in `analysis`; do not calculate new statistics. Cite metrics by ID (see metricIdPattern); null values have reasons in the research file.',
    'Tell the user about every warning, especially uncertain or missing data, and that pageviews are not people and languages are not countries.',
  ];
  const main = plan.periods[0];
  if (plan.mode === 'default' && main) {
    parts.push(`State that no period was given, so the last 12 completed calendar months (${main.start} to ${main.end}) were used.`);
  }
  if (datasets.length === 0) parts.push('No dataset could be collected.');
  return parts.join(' ');
}

/**
 * research: resolve → per verified language: creation date, pageviews (cached), classification → artifact file.
 * Returns the saved artifact and a compact summary without individual observations.
 */
export async function runResearch(request: ResearchRequest, deps: ResearchDeps): Promise<ResearchOutcome> {
  const now = deps.now();
  const plan = planPeriods(request, todayUtc(now));

  const topic = request.subject.kind === 'topic' ? request.subject.topic : request.subject.title;
  const resolved = await resolveTopic(deps.api, { topic, lang: request.subject.lang, languages: request.languages, limit: 5 });
  const resolution = resolved.result;
  assertResolved(request, resolution);

  const verified = resolution.articles.filter(
    (article): article is typeof article & { title: string; pageId: number; url: string } =>
      article.status === 'verified' && article.title !== null && article.pageId !== null && article.url !== null,
  );
  const unavailableLanguages = resolution.articles
    .filter((article) => article.status !== 'verified')
    .map((article) => ({ lang: article.lang, status: article.status, title: article.title }));
  if (verified.length === 0) {
    throw new ResearchResolutionError(
      'NO_VERIFIED_ARTICLES',
      `"${resolution.source.title}" has no verified article in any requested language (${request.languages.join(', ')}).`,
      { source: resolution.source, unavailableLanguages },
    );
  }

  const context = createCollectContext({ api: deps.api, cache: deps.cache, readCache: request.useCache, now: deps.now });
  const datasets: Dataset[] = [];
  const datasetWarnings: Warning[] = [];
  for (const article of verified) {
    const { dataset, warnings } = await collectDataset(context, article, plan);
    datasets.push(dataset);
    datasetWarnings.push(...warnings);
  }

  const { analysis, warnings: analysisWarnings } = analyzeResearch(datasets, plan);
  const warnings = dedupeWarnings([...resolved.warnings, ...datasetWarnings, ...analysisWarnings, ...context.warnings]);
  const limitations = [...new Set([...PAGEVIEW_LIMITATIONS, ...RESOLVE_LIMITATIONS, ...analysis.limitations])];
  const id = artifactId(request, plan);

  const artifact = ResearchArtifactSchema.parse({
    format: RESEARCH_ARTIFACT_FORMAT,
    id,
    generatedAt: now.toISOString(),
    tool: { name: 'wikipedia-market-research', version: VERSION },
    request: {
      subject: request.subject,
      languages: request.languages,
      periodMode: plan.mode,
      requestedGranularity: request.granularity,
      useCache: request.useCache,
    },
    plan: { today: plan.today, periods: plan.periods, granularity: plan.granularity, granularityReason: plan.granularityReason },
    resolution,
    datasets,
    unavailableLanguages,
    warnings,
    limitations,
    analysis,
    sources: [PAGEVIEWS_API, 'https://meta.wikimedia.org/w/api.php (sitematrix)', ...new Set(datasets.map((dataset) => `https://${dataset.project}.org/w/api.php`))],
  } satisfies ResearchArtifact);

  const artifactPath = resolvePath(join(request.outDir, `research-${id}.json`));
  try {
    await writeFileAtomic(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  } catch (error) {
    throw new OutputWriteError(artifactPath, error);
  }

  const summary: ResearchSummary = {
    artifactPath,
    source: { lang: resolution.source.lang, title: resolution.source.title, url: resolution.source.url },
    periodMode: plan.mode,
    periods: plan.periods,
    granularity: { selected: plan.granularity, reason: plan.granularityReason },
    languages: datasets.map((dataset) => ({
      lang: dataset.lang,
      title: dataset.title,
      url: dataset.url,
      wikidataId: dataset.wikidataId,
      createdAt: dataset.createdAt,
      publishedThrough: dataset.publishedThrough,
      units: dataset.observations.length,
      counts: dataset.quality.counts,
      uncertain: dataset.quality.uncertain,
      coverage: dataset.quality.byPeriod.map((period) => ({ periodId: period.periodId, coverage: period.coverage })),
    })),
    unavailableLanguages,
    cache: { enabled: deps.cache !== null, ...context.stats },
    analysis: digestAnalysis(analysis, plan.granularity),
    nextStep: nextStep(plan, datasets),
  };

  return { artifact, summary, warnings, limitations };
}
