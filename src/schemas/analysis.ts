import { z } from 'zod';

export const ANALYSIS_METHODOLOGY_VERSION = 1;

/** Why a metric is null instead of a number. */
export const NullReasonSchema = z.enum([
  'NO_DATA', // no unit in the period can hold data (e.g. all before creation or unavailable)
  'MISSING_UNITS', // some expected units have no value (unavailable / api_error)
  'PERIOD_INCOMPLETE', // the period extends into days or months that are not over yet
  'INSUFFICIENT_COVERAGE', // coverage below the minimum for averages
  'DAILY_GRANULARITY', // monthly average requested from daily data
  'BASELINE_ZERO', // percentage change from zero is undefined
]);
export type NullReason = z.infer<typeof NullReasonSchema>;

const Nullable = z.number().nullable();
const UnitValueSchema = z.object({ period: z.iso.date(), views: z.number().int().nonnegative(), inferred: z.boolean() }).strict();

export const PeriodMetricsSchema = z
  .object({
    durationDays: z.number().int().positive(),
    units: z
      .object({
        total: z.number().int().nonnegative(),
        expected: z.number().int().nonnegative(),
        counted: z.number().int().nonnegative(),
        observed: z.number().int().nonnegative(),
        inferredZero: z.number().int().nonnegative(),
        missing: z.number().int().nonnegative(),
        incomplete: z.number().int().nonnegative(),
        beforeCreation: z.number().int().nonnegative(),
      })
      .strict(),
    coverage: Nullable,
    /** Sum over the period; only when every expected unit is counted and the period is complete. */
    total: Nullable,
    /** Sum of counted units, always available; a lower bound when units are missing. */
    countedSum: z.number().int().nonnegative(),
    /** Calendar days represented by counted units (the denominator of averageDaily). */
    countedDays: z.number().int().nonnegative(),
    averageDaily: Nullable,
    averageMonthly: Nullable,
    min: UnitValueSchema.nullable(),
    max: UnitValueSchema.nullable(),
    /** Share of `countedSum` in the single largest unit (0–1). */
    largestUnitShare: Nullable,
    nullReasons: z.record(z.string(), NullReasonSchema),
  })
  .strict();
export type PeriodMetrics = z.infer<typeof PeriodMetricsSchema>;

export const TrendDirectionSchema = z.enum(['increasing', 'decreasing', 'stable', 'no_clear_trend', 'insufficient_data']);
export type TrendDirection = z.infer<typeof TrendDirectionSchema>;

export const TrendSchema = z
  .object({
    direction: TrendDirectionSchema,
    /** Series the test ran on: months, or 7-day blocks of daily data. */
    basis: z.enum(['monthly', 'weekly_blocks']),
    points: z.number().int().nonnegative(),
    droppedBlocks: z.number().int().nonnegative(),
    /** Theil–Sen slope in views per month or per 7-day block. */
    slopePerPoint: Nullable,
    /**
     * Theil–Sen slope × (points − 1) as % of the median level: how far the fitted line moves over the span,
     * relative to a typical point. Not a percentage change of views; values beyond ±100 % are possible.
     */
    slopeSpanPercentOfMedian: Nullable,
    /** Median of the second half vs the first half, in %. */
    halfMedianChangePercent: Nullable,
    /** Robust coefficient of variation: 1.4826 × MAD / median. */
    robustCv: Nullable,
    mannKendall: z
      .object({ s: z.number().int(), pValue: z.number().min(0).max(1), method: z.enum(['exact', 'normal_approximation']) })
      .strict()
      .nullable(),
    /** Whether the direction survives removing flagged spikes; null when not applicable. */
    robustToSpikes: z.boolean().nullable(),
    issues: z.array(z.enum(['LOW_COVERAGE', 'TOO_FEW_POINTS', 'ZERO_LEVEL', 'INFERRED_ZEROS', 'SPIKE_DRIVEN', 'HALVES_DISAGREE', 'HIGH_VARIABILITY', 'SHORT_SPAN'])),
    explanation: z.string(),
  })
  .strict();
export type Trend = z.infer<typeof TrendSchema>;

export const AnomalySchema = z
  .object({
    period: z.iso.date(),
    views: z.number().int().nonnegative(),
    baselineMedian: z.number(),
    baselineSpread: z.number(),
    threshold: z.number(),
    ratioToBaseline: Nullable,
    shareOfCountedSum: Nullable,
    reason: z.string(),
  })
  .strict();
export type Anomaly = z.infer<typeof AnomalySchema>;

export const AnomalyResultSchema = z
  .object({
    method: z.literal('rolling_median_mad'),
    checked: z.boolean(),
    notCheckedReason: z.string().nullable(),
    anomalies: z.array(AnomalySchema),
    /** Counted sum without flagged units; spikes are never removed from the main metrics. */
    countedSumExcludingAnomalies: z.number().int().nonnegative(),
  })
  .strict();
export type AnomalyResult = z.infer<typeof AnomalyResultSchema>;

export const PeriodAnalysisSchema = z
  .object({
    periodId: z.string(),
    start: z.iso.date(),
    end: z.iso.date(),
    metrics: PeriodMetricsSchema,
    trend: TrendSchema,
    anomalies: AnomalyResultSchema,
  })
  .strict();
export type PeriodAnalysis = z.infer<typeof PeriodAnalysisSchema>;

export const ComparisonIssueSchema = z.enum([
  'UNEQUAL_DURATION',
  'BASELINE_ZERO',
  'PERIOD_INCOMPLETE',
  'MISSING_UNITS',
  'INSUFFICIENT_COVERAGE',
  'BEFORE_CREATION',
  'INFERRED_ZEROS',
  'SEASONALITY_NOT_ALIGNED',
  'PERIODS_OVERLAP',
  'SPIKES_PRESENT',
]);
export type ComparisonIssue = z.infer<typeof ComparisonIssueSchema>;

const ComparisonSideSchema = z
  .object({
    periodId: z.string(),
    start: z.iso.date(),
    end: z.iso.date(),
    durationDays: z.number().int().positive(),
    total: Nullable,
    averageDaily: Nullable,
    coverage: Nullable,
  })
  .strict();

export const ComparisonSchema = z
  .object({
    id: z.string(),
    lang: z.string(),
    baseline: ComparisonSideSchema,
    current: ComparisonSideSchema,
    absoluteChange: Nullable,
    percentChange: Nullable,
    averageDailyChange: Nullable,
    averageDailyPercentChange: Nullable,
    equalDuration: z.boolean(),
    /** Measure to lead with: totals only for equal, complete periods; otherwise average daily views. */
    primaryMeasure: z.enum(['total', 'averageDaily']).nullable(),
    status: z.enum(['comparable', 'comparable_with_limitations', 'insufficient_data']),
    issues: z.array(ComparisonIssueSchema),
    nullReasons: z.record(z.string(), NullReasonSchema),
  })
  .strict();
export type Comparison = z.infer<typeof ComparisonSchema>;

export const MetricEntrySchema = z
  .object({
    value: z.union([z.number(), z.string()]).nullable(),
    unit: z.enum(['views', 'views_per_day', 'views_per_month', 'percent', 'ratio', 'days', 'count', 'p_value', 'label']),
    lang: z.string(),
    periodId: z.string().nullable(),
    comparisonId: z.string().nullable(),
  })
  .strict();
export type MetricEntry = z.infer<typeof MetricEntrySchema>;

export const AnalysisSchema = z
  .object({
    methodologyVersion: z.literal(ANALYSIS_METHODOLOGY_VERSION),
    methodology: z.string(),
    languages: z.array(
      z
        .object({
          lang: z.string(),
          title: z.string(),
          url: z.string(),
          wikidataId: z.string().nullable(),
          periods: z.array(PeriodAnalysisSchema),
        })
        .strict(),
    ),
    comparisons: z.array(ComparisonSchema),
    crossLanguage: z.array(
      z
        .object({
          periodId: z.string(),
          /** Ordered by average daily views (absolute; editions differ in size). */
          ranking: z.array(
            z
              .object({ lang: z.string(), title: z.string(), averageDaily: Nullable, total: Nullable, trend: TrendDirectionSchema })
              .strict(),
          ),
        })
        .strict(),
    ),
    /** Flat index of citable metrics: `<lang>.<periodId>.<metric>` or `<lang>.<baseline>_vs_<current>.<metric>`. */
    metrics: z.record(z.string(), MetricEntrySchema),
    limitations: z.array(z.string()),
  })
  .strict();
export type Analysis = z.infer<typeof AnalysisSchema>;
