import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { writeFileAtomic } from '../cache/atomicWrite.ts';
import { ConclusionsSchema, type Conclusions } from '../schemas/conclusions.ts';
import type { Warning } from '../schemas/envelope.ts';
import type { ReportRequest } from '../schemas/inputs.ts';
import { ResearchArtifactSchema, type ResearchArtifact } from '../schemas/research.ts';
import { buildChart, MAX_CHART_SERIES } from './chart.ts';
import { NumberFormatter } from './format.ts';
import { BUILT_IN_LABEL_LANGUAGES, labelsFor } from './labels.ts';
import { buildReportModel } from './model.ts';
import { renderReportPdf, ReportDoesNotFitError } from './pdf.ts';
import { renderSvg } from './svg.ts';
import { validateConclusions, type ConclusionIssue } from './validate.ts';

export type ReportErrorCode = 'INVALID_RESEARCH_FILE' | 'INVALID_CONCLUSIONS' | 'REPORT_DOES_NOT_FIT';

export class ReportError extends Error {
  readonly code: ReportErrorCode;
  readonly hint: string;
  readonly details: unknown;

  constructor(code: ReportErrorCode, message: string, hint: string, details?: unknown) {
    super(message);
    this.name = 'ReportError';
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

export const CONCLUSIONS_HINT =
  'Fix the listed fields in the conclusions file and run report again. Evidence IDs must exist in the research file (analysis.metrics, ' +
  'pattern <lang>.<periodId>.<metric>). Numbers in text must equal a cited metric value (rounding allowed); otherwise remove them.';

export interface ReportResult {
  reportPath: string;
  chartPath: string;
  pages: number;
  language: string;
  labelsLanguage: string;
  findings: number;
  hypotheses: number;
  layout: { scale: number; chartHeight: number };
}

async function readJson(path: string, code: ReportErrorCode, what: string, hint: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new ReportError(code, `Cannot read the ${what} file ${path}: ${error instanceof Error ? error.message : String(error)}`, hint);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ReportError(code, `The ${what} file ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, hint);
  }
}

async function loadArtifact(path: string): Promise<ResearchArtifact> {
  const hint = 'Pass the artifactPath returned by the research command, or run research again to create a current research file.';
  const parsed = ResearchArtifactSchema.safeParse(await readJson(path, 'INVALID_RESEARCH_FILE', 'research', hint));
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    throw new ReportError('INVALID_RESEARCH_FILE', `${path} is not a valid research file (format 2).`, hint, { issues });
  }
  return parsed.data;
}

async function loadConclusions(path: string): Promise<Conclusions> {
  const parsed = ConclusionsSchema.safeParse(await readJson(path, 'INVALID_CONCLUSIONS', 'conclusions', CONCLUSIONS_HINT));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join('.') || '(root)', message: issue.message }));
    throw new ReportError('INVALID_CONCLUSIONS', `The conclusions file does not match the schema (${issues.length} issue(s)).`, CONCLUSIONS_HINT, { issues });
  }
  return parsed.data;
}

/**
 * report: saved research file + AI conclusions → one-page PDF and SVG chart.
 * Reads files only; never calls Wikimedia, never recalculates statistics, never writes to the research file.
 */
export async function runReport(request: ReportRequest, deps: { now: () => Date }): Promise<{ result: ReportResult; warnings: Warning[] }> {
  const researchPath = resolve(request.researchPath);
  const artifact = await loadArtifact(researchPath);
  const conclusions = await loadConclusions(resolve(request.conclusionsPath));

  const issues: ConclusionIssue[] = validateConclusions(conclusions, artifact);
  if (issues.length > 0) {
    throw new ReportError('INVALID_CONCLUSIONS', `The conclusions have ${issues.length} problem(s) against the research file.`, CONCLUSIONS_HINT, { issues });
  }
  if (artifact.datasets.length > MAX_CHART_SERIES) {
    throw new ReportError(
      'REPORT_DOES_NOT_FIT',
      `The research file has ${artifact.datasets.length} language editions; a one-page report supports at most ${MAX_CHART_SERIES}.`,
      `Run research again with at most ${MAX_CHART_SERIES} languages in --langs.`,
    );
  }

  const generatedAt = deps.now();
  const { labels, builtIn } = labelsFor(conclusions.language, conclusions.labels);
  const format = new NumberFormatter(conclusions.language);
  const model = buildReportModel(artifact, conclusions, { labels, format, generatedAt });
  const chartFor = (layout: { chartHeight: number }) => buildChart(artifact, { width: 523.28, height: layout.chartHeight, labels, format });

  let rendered: Awaited<ReturnType<typeof renderReportPdf>>;
  try {
    rendered = await renderReportPdf(model, chartFor, generatedAt);
  } catch (error) {
    if (error instanceof ReportDoesNotFitError) {
      throw new ReportError(
        'REPORT_DOES_NOT_FIT',
        error.message,
        'Shorten the conclusions: fewer or shorter findings, hypotheses and limitations. Nothing is truncated automatically.',
        { overflowPoints: Math.ceil(error.overflow) },
      );
    }
    throw error;
  }

  const primaryLanguage = conclusions.language.toLowerCase().split('-')[0] as string;
  const reportPath = resolve(request.outPath ?? join(dirname(researchPath), `report-${artifact.id}-${primaryLanguage}.pdf`));
  const chartPath = join(dirname(reportPath), `${basename(reportPath, '.pdf')}-chart.svg`);
  if (reportPath === researchPath || chartPath === researchPath) {
    throw new ReportError('INVALID_CONCLUSIONS', 'The output path would overwrite the research file.', 'Choose a different --out path.');
  }
  await writeFileAtomic(chartPath, renderSvg(chartFor(rendered.layout)));
  await writeFileAtomic(reportPath, rendered.pdf);

  const warnings: Warning[] = [];
  if (!builtIn) {
    warnings.push({
      code: 'REPORT_LABELS_FALLBACK',
      message: `Built-in report labels exist for ${BUILT_IN_LABEL_LANGUAGES.join(', ')}; other headings and fixed texts are in English unless provided in conclusions.labels.`,
    });
  }
  return {
    result: {
      reportPath,
      chartPath,
      pages: rendered.pages,
      language: conclusions.language,
      labelsLanguage: builtIn ? primaryLanguage : 'en',
      findings: conclusions.findings.length,
      hypotheses: conclusions.hypotheses.length,
      layout: { scale: rendered.layout.scale, chartHeight: rendered.layout.chartHeight },
    },
    warnings,
  };
}
