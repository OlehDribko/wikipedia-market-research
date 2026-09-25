import type { z } from 'zod';
import { ReportInputSchema, ResearchInputSchema, ResolveInputSchema } from '../schemas/inputs.ts';
import type { FileCache } from '../cache/fileCache.ts';
import { ReportError, runReport } from '../report/report.ts';
import { OutputWriteError, ResearchResolutionError, runResearch } from '../research/research.ts';
import { ResolveResultSchema } from '../schemas/resolve.ts';
import { WikimediaApiError, type JsonClient } from '../wikimedia/http.ts';
import { InvalidLanguageError, resolveTopic } from '../wikimedia/resolve.ts';
import type { CommandResult } from './envelope.ts';
import { CliError, ErrorCode } from './errors.ts';

/** External services, created lazily so that --help and validation never touch the network. */
export interface CommandDeps {
  wikimedia(): JsonClient;
  /** null disables caching. */
  cache(): FileCache | null;
  now(): Date;
}

export interface OptionSpec {
  name: string;
  type: 'string' | 'boolean';
  description: string;
  required?: boolean;
  defaultText?: string;
}

export interface Command {
  name: string;
  summary: string;
  usage: string;
  options: OptionSpec[];
  examples: string[];
  /** Validates raw parsed flags and runs the command. */
  run(rawInput: Record<string, unknown>, deps: CommandDeps): Promise<CommandResult>;
}

interface CommandSpec<S extends z.ZodType> extends Omit<Command, 'run'> {
  schema: S;
  handler(input: z.output<S>, deps: CommandDeps): Promise<CommandResult>;
}

function defineCommand<S extends z.ZodType>(spec: CommandSpec<S>): Command {
  const { schema, handler, ...command } = spec;
  return {
    ...command,
    run: async (rawInput, deps) => {
      const input = validateInput(command.name, schema, rawInput);
      try {
        return await handler(input, deps);
      } catch (error) {
        throw toCliError(error);
      }
    },
  };
}

/** Maps domain errors to CLI errors; anything unrecognized is rethrown and reported as internal. */
export function toCliError(error: unknown): unknown {
  if (error instanceof InvalidLanguageError) {
    return new CliError(ErrorCode.INVALID_LANGUAGE, error.message, {
      hint: 'Use Wikipedia language edition codes such as en, uk, pl or de. List: https://meta.wikimedia.org/wiki/List_of_Wikipedias',
      details: { invalidCodes: error.codes },
    });
  }
  if (error instanceof ResearchResolutionError) {
    const hints: Record<typeof error.code, string> = {
      AMBIGUOUS_TOPIC: 'Show the candidates to the user, then run research with --article LANG:Title using the chosen candidate.',
      TOPIC_NOT_FOUND: 'Ask the user to rephrase the topic or to name another source language.',
      ARTICLE_NOT_FOUND: 'Run resolve with the topic to find the exact article title, then retry.',
      NO_VERIFIED_ARTICLES: 'Tell the user no requested language has this article; ask which other languages to use.',
    };
    return new CliError(ErrorCode[error.code], error.message, { hint: hints[error.code], details: error.details });
  }
  if (error instanceof ReportError) {
    return new CliError(ErrorCode[error.code], error.message, { hint: error.hint, ...(error.details !== undefined && { details: error.details }) });
  }
  if (error instanceof OutputWriteError) {
    return new CliError(ErrorCode.OUTPUT_ERROR, error.message, { hint: 'Choose a writable directory with --out.' });
  }
  if (error instanceof WikimediaApiError) {
    const unexpected = error.kind === 'unexpected_response' || error.kind === 'api_error';
    return new CliError(unexpected ? ErrorCode.UNEXPECTED_RESPONSE : ErrorCode.UPSTREAM_ERROR, error.message, {
      hint: unexpected
        ? 'The Wikimedia API answered in an unexpected way. Do not guess the missing data; report the problem to the user.'
        : 'The Wikimedia API is unreachable or overloaded. Wait a minute and retry the same command.',
      details: { kind: error.kind, url: error.url, ...(error.status !== undefined && { status: error.status }) },
    });
  }
  return error;
}

/** Parses raw flags with the command schema, converting Zod issues into an INVALID_INPUT error. */
export function validateInput<S extends z.ZodType>(command: string, schema: S, rawInput: unknown): z.output<S> {
  const result = schema.safeParse(rawInput);
  if (result.success) return result.data;

  const details = result.error.issues.map((issue) => {
    const key = issue.path[0];
    return { option: typeof key === 'string' ? `--${key}` : null, message: issue.message };
  });
  const first = details[0];
  const message = first ? (first.option ? `${first.option}: ${first.message}` : first.message) : 'Invalid input.';
  throw new CliError(ErrorCode.INVALID_INPUT, message, {
    hint: `Run \`node scripts/wmr.ts ${command} --help\` for usage.`,
    details,
  });
}

export const COMMANDS: readonly Command[] = [
  defineCommand({
    name: 'research',
    summary: 'Resolve articles, collect pageviews with quality checks and run the statistical analysis (main command).',
    usage: 'research (--topic <text> --lang <code> | --article <lang:Title>) --langs <codes> [options]',
    options: [
      { name: 'topic', type: 'string', description: 'Topic text to resolve to a Wikipedia article (requires --lang).' },
      { name: 'lang', type: 'string', description: 'Language edition of the --topic text, e.g. en.' },
      { name: 'article', type: 'string', description: 'Verified article as LANG:Title, e.g. en:Intermittent_fasting. Alternative to --topic.' },
      { name: 'langs', type: 'string', required: true, description: 'Comma-separated language editions to analyze, e.g. en,de,uk,pl.' },
      { name: 'start', type: 'string', description: 'Period start: YYYY-MM-DD, or YYYY-MM (first day of that month).' },
      {
        name: 'end',
        type: 'string',
        description:
          'Period end: YYYY-MM-DD, or YYYY-MM (last day of that month). Without --start/--end: the --compare ranges if given, otherwise the last 12 completed calendar months.',
      },
      { name: 'compare', type: 'string', description: 'Comma-separated ranges START..END to compare (2-4), e.g. 2024-01..2024-06,2025-01..2025-06.' },
      {
        name: 'granularity',
        type: 'string',
        defaultText: 'auto',
        description: 'auto | daily | monthly. auto = monthly when all ranges are whole calendar months, otherwise daily.',
      },
      { name: 'out', type: 'string', defaultText: 'output', description: 'Directory for the full research JSON file.' },
      { name: 'no-cache', type: 'boolean', description: 'Fetch fresh Wikimedia data instead of reading the cache (the cache is refreshed).' },
    ],
    examples: [
      'research --topic "Intermittent fasting" --lang en --langs en,de,uk',
      'research --article en:Intermittent_fasting --langs en,pl --start 2024-01 --end 2025-06',
      'research --article en:Pilates --langs en,uk --compare 2024-01..2024-06,2025-01..2025-06',
    ],
    schema: ResearchInputSchema,
    handler: async (request, deps) => {
      const outcome = await runResearch(request, { api: deps.wikimedia(), cache: deps.cache(), now: () => deps.now() });
      return { data: outcome.summary, warnings: outcome.warnings, limitations: outcome.limitations };
    },
  }),
  defineCommand({
    name: 'resolve',
    summary: 'Find candidate Wikipedia articles for an ambiguous topic.',
    usage: 'resolve --topic <text> --lang <code> [--langs <codes>] [--limit <n>]',
    options: [
      { name: 'topic', type: 'string', required: true, description: 'Topic text to look up.' },
      { name: 'lang', type: 'string', required: true, description: 'Language edition to search in, e.g. en.' },
      { name: 'langs', type: 'string', description: 'Comma-separated language editions to report article links for.' },
      { name: 'limit', type: 'string', defaultText: '5', description: 'Maximum number of candidates (1-10).' },
    ],
    examples: ['resolve --topic "Mercury" --lang en --langs en,de,uk', 'resolve --topic "Астрономія" --lang uk --langs uk,pl,en'],
    schema: ResolveInputSchema,
    handler: async (request, deps) => {
      const outcome = await resolveTopic(deps.wikimedia(), request);
      return { data: ResolveResultSchema.parse(outcome.result), warnings: outcome.warnings, limitations: outcome.limitations };
    },
  }),
  defineCommand({
    name: 'report',
    summary: 'Render a one-page PDF from saved research data and AI conclusions (no API calls).',
    usage: 'report --research <file.json> --conclusions <file.json> [--out <file.pdf>]',
    options: [
      { name: 'research', type: 'string', required: true, description: 'Research JSON file written by the research command.' },
      { name: 'conclusions', type: 'string', required: true, description: 'Conclusions JSON file; its "language" sets the report language (see SKILL.md).' },
      { name: 'out', type: 'string', description: 'Output PDF path. Default: report-<id>-<lang>.pdf next to the research file. The chart SVG is written beside it.' },
    ],
    examples: ['report --research output/research-1a2b3c.json --conclusions output/conclusions.json'],
    schema: ReportInputSchema,
    handler: async (request, deps) => {
      const { result, warnings } = await runReport(request, { now: () => deps.now() });
      return { data: result, warnings };
    },
  }),
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((command) => command.name === name);
}
