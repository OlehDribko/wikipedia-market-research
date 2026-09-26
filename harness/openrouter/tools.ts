import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { CliRunner } from './cli.ts';

/**
 * Tools exposed to the model. `resolve`, `research` and `report` map 1:1 to the skill CLI commands;
 * `research_metrics` reads the metric index of a saved research file (no raw observations).
 */
export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'resolve',
      description: 'Find Wikipedia articles for a topic. Use when a topic may be ambiguous. Returns candidates or verified articles per language.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Topic text, e.g. "Mercury".' },
          lang: { type: 'string', description: 'Wikipedia language of the topic text, e.g. "en".' },
          langs: { type: 'string', description: 'Optional comma-separated languages to link, e.g. "uk,pl".' },
        },
        required: ['topic', 'lang'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'research',
      description:
        'Collect Wikipedia pageviews and compute statistics. Give either article ("en:Title") or topic+lang. langs is required. Returns a compact summary and artifactPath (the research file).',
      parameters: {
        type: 'object',
        properties: {
          article: { type: 'string', description: 'Verified article as LANG:Title, e.g. "en:Astronomy".' },
          topic: { type: 'string', description: 'Topic text (use with lang) if no article is known.' },
          lang: { type: 'string', description: 'Language of the topic text, e.g. "en".' },
          langs: { type: 'string', description: 'Comma-separated Wikipedia languages to analyze, e.g. "uk,pl".' },
          start: { type: 'string', description: 'Period start, YYYY-MM or YYYY-MM-DD.' },
          end: { type: 'string', description: 'Period end, YYYY-MM or YYYY-MM-DD.' },
          compare: { type: 'string', description: 'Periods to compare, e.g. "2024-01..2024-12,2025-01..2025-12".' },
        },
        required: ['langs'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'research_metrics',
      description: 'List metric IDs and values from a research file, for citing evidence in a report. Optional prefix filter, e.g. "uk.".',
      parameters: {
        type: 'object',
        properties: {
          research_file: { type: 'string', description: 'artifactPath returned by research.' },
          prefix: { type: 'string', description: 'Optional metric ID prefix, e.g. "pl.compare-1".' },
        },
        required: ['research_file'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'report',
      description:
        'Create a one-page PDF report from a research file. Only when the user asks for a report or PDF. Every finding must cite metric IDs; numbers in findings must equal cited metric values.',
      parameters: {
        type: 'object',
        properties: {
          research_file: { type: 'string', description: 'artifactPath returned by research.' },
          conclusions: {
            type: 'object',
            description: 'Conclusions in the user language.',
            properties: {
              language: { type: 'string', description: 'Report language, e.g. "uk".' },
              headline: { type: 'string', description: 'One sentence without statistics.' },
              findings: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    statement: { type: 'string' },
                    evidence: { type: 'array', items: { type: 'string' }, description: 'Metric IDs, e.g. "uk.main.averageDaily".' },
                  },
                  required: ['statement', 'evidence'],
                },
              },
              hypotheses: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { hypothesis: { type: 'string' }, validationIdea: { type: 'string' } },
                  required: ['hypothesis', 'validationIdea'],
                },
              },
              limitations: { type: 'array', items: { type: 'string' } },
            },
            required: ['language', 'headline', 'findings', 'hypotheses', 'limitations'],
          },
        },
        required: ['research_file', 'conclusions'],
        additionalProperties: false,
      },
    },
  },
] as const;

export type ToolName = (typeof TOOL_DEFINITIONS)[number]['function']['name'];

const Text = z.string().trim().min(1);
const ResolveArgs = z.object({ topic: Text, lang: Text, langs: Text.optional() }).strict();
const ResearchArgs = z
  .object({ article: Text.optional(), topic: Text.optional(), lang: Text.optional(), langs: Text, start: Text.optional(), end: Text.optional(), compare: Text.optional() })
  .strict();
const MetricsArgs = z.object({ research_file: Text, prefix: z.string().optional() }).strict();
const ReportArgs = z.object({ research_file: Text, conclusions: z.record(z.string(), z.unknown()) }).strict();

export interface ToolContext {
  runCli: CliRunner;
  /** Directory for research files, conclusions and reports of this run. Files outside it are not accessible. */
  workDir: string;
  /** Numbers report attempts within the session (conclusions-1.json, report-1-uk.pdf, …). */
  reportCount: number;
}

export interface ToolOutcome {
  /** JSON sent back to the model. */
  content: unknown;
  ok: boolean;
  /** Error code for bookkeeping, e.g. INVALID_CONCLUSIONS. */
  errorCode?: string;
  cliArgs?: string[];
}

function toolError(code: string, message: string, hint?: string): ToolOutcome {
  return { ok: false, errorCode: code, content: { ok: false, error: { code, message, ...(hint && { hint }) } } };
}

function insideWorkDir(context: ToolContext, path: string): string | null {
  const absolute = resolve(context.workDir, path);
  const rel = relative(context.workDir, absolute);
  return rel.startsWith('..') || isAbsolute(rel) ? null : absolute;
}

/** Converts tool arguments to CLI flags. Values are passed as separate argv entries; nothing is shell-interpreted. */
export function researchCliArgs(args: z.infer<typeof ResearchArgs>, outDir: string): string[] {
  const flags: string[] = ['research'];
  for (const key of ['article', 'topic', 'lang', 'langs', 'start', 'end', 'compare'] as const) {
    const value = args[key];
    if (value !== undefined) flags.push(`--${key}`, value);
  }
  flags.push('--out', outDir);
  return flags;
}

async function runEnvelope(context: ToolContext, cliArgs: string[]): Promise<ToolOutcome> {
  const result = await context.runCli(cliArgs);
  if (result.envelope === null) {
    return { ...toolError('CLI_OUTPUT_NOT_JSON', `The skill CLI exited with code ${result.exitCode} without a JSON result.`), cliArgs };
  }
  const envelope = result.envelope as { ok?: boolean; error?: { code?: string } };
  return { ok: envelope.ok === true, content: envelope, cliArgs, ...(envelope.ok !== true && { errorCode: envelope.error?.code ?? 'UNKNOWN' }) };
}

export async function executeTool(name: string, rawArguments: string, context: ToolContext): Promise<ToolOutcome> {
  let parsed: unknown;
  try {
    parsed = rawArguments.trim() === '' ? {} : JSON.parse(rawArguments);
  } catch {
    return toolError('INVALID_TOOL_ARGUMENTS', 'Tool arguments are not valid JSON.', 'Send a JSON object matching the tool schema.');
  }

  const invalid = (error: z.ZodError) =>
    toolError('INVALID_TOOL_ARGUMENTS', error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '), 'Fix the arguments and call the tool again.');

  switch (name) {
    case 'resolve': {
      const args = ResolveArgs.safeParse(parsed);
      if (!args.success) return invalid(args.error);
      const cliArgs = ['resolve', '--topic', args.data.topic, '--lang', args.data.lang, ...(args.data.langs ? ['--langs', args.data.langs] : [])];
      return runEnvelope(context, cliArgs);
    }
    case 'research': {
      const args = ResearchArgs.safeParse(parsed);
      if (!args.success) return invalid(args.error);
      return runEnvelope(context, researchCliArgs(args.data, join(context.workDir, 'output')));
    }
    case 'research_metrics': {
      const args = MetricsArgs.safeParse(parsed);
      if (!args.success) return invalid(args.error);
      const path = insideWorkDir(context, args.data.research_file);
      if (!path) return toolError('FILE_NOT_ALLOWED', 'Only research files created in this session can be read.', 'Use the artifactPath returned by research.');
      try {
        const artifact = JSON.parse(await readFile(path, 'utf8')) as { analysis?: { metrics?: Record<string, { value: unknown; unit: string }> }; warnings?: { code: string }[] };
        const prefix = args.data.prefix ?? '';
        const metrics = Object.fromEntries(
          Object.entries(artifact.analysis?.metrics ?? {})
            .filter(([id]) => id.startsWith(prefix))
            .map(([id, entry]) => [id, { value: entry.value, unit: entry.unit }]),
        );
        return { ok: true, content: { ok: true, metrics, warnings: [...new Set((artifact.warnings ?? []).map((warning) => warning.code))] } };
      } catch (error) {
        return toolError('RESEARCH_FILE_UNREADABLE', `Cannot read ${args.data.research_file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    case 'report': {
      const args = ReportArgs.safeParse(parsed);
      if (!args.success) return invalid(args.error);
      const researchPath = insideWorkDir(context, args.data.research_file);
      if (!researchPath) return toolError('FILE_NOT_ALLOWED', 'Only research files created in this session can be used.', 'Use the artifactPath returned by research.');
      context.reportCount++;
      const attempt = context.reportCount;
      const reportDir = join(context.workDir, 'reports');
      await mkdir(reportDir, { recursive: true });
      const conclusionsPath = join(reportDir, `conclusions-${attempt}.json`);
      await writeFile(conclusionsPath, `${JSON.stringify(args.data.conclusions, null, 2)}\n`, 'utf8');
      const language = typeof args.data.conclusions.language === 'string' ? args.data.conclusions.language.replace(/[^a-z-]/gi, '') || 'x' : 'x';
      return runEnvelope(context, ['report', '--research', researchPath, '--conclusions', conclusionsPath, '--out', join(reportDir, `report-${attempt}-${language}.pdf`)]);
    }
    default:
      return toolError('UNKNOWN_TOOL', `Unknown tool "${name}".`, 'Use one of: resolve, research, research_metrics, report.');
  }
}
