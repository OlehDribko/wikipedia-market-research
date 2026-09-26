import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent, buildSystemPrompt } from '../agent.ts';
import { createCliRunner, skillEnvironment, type CliRunner } from '../cli.ts';
import { ConfigError, loadConfig, PREFERRED_MODEL } from '../config.ts';
import { classifyModelError, ModelError, type AssistantReply, type Message, type ModelClient } from '../model.ts';
import { MERCURY, ungroundedNumbers } from '../scenarios.ts';
import { executeTool, researchCliArgs, TOOL_DEFINITIONS, type ToolContext } from '../tools.ts';
import { Transcript } from '../transcript.ts';

// All tests in this file use a SCRIPTED model. They exercise the real harness, tools, CLI child process and
// report validation, but they are not live model tests.

const FIXTURE = new URL('../../../tests/fixtures/research-astronomy-uk-pl-2024-vs-2025.json', import.meta.url);
const SECRET = 'sk-or-v1-test-secret-do-not-leak-0123456789';

let workDir: string;
let researchFile: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'wmr-harness-'));
  await mkdir(join(workDir, 'output'), { recursive: true });
  researchFile = join(workDir, 'output', 'research-73b5a58c3327.json');
  await copyFile(FIXTURE, researchFile);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Replies are produced by functions of the conversation so far, like a model would. */
class ScriptedModel implements ModelClient {
  readonly model = 'scripted/test-model';
  calls = 0;
  readonly #steps: ((messages: readonly Message[]) => AssistantReply)[];

  constructor(steps: ((messages: readonly Message[]) => AssistantReply)[]) {
    this.#steps = steps;
  }

  async complete(messages: readonly Message[]): Promise<AssistantReply> {
    const step = this.#steps[Math.min(this.calls, this.#steps.length - 1)];
    this.calls++;
    if (!step) throw new Error('No scripted step');
    return step(messages);
  }
}

const toolCall = (name: string, args: unknown, id = `call-${name}-${Math.random()}`): AssistantReply => ({
  content: '',
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  finishReason: 'tool_calls',
});
const answer = (content: string): AssistantReply => ({ content, toolCalls: [], finishReason: 'stop' });
const lastToolResult = (messages: readonly Message[]) => {
  const last = [...messages].reverse().find((message) => message.role === 'tool');
  return JSON.parse(String((last as { content: string }).content));
};

const validConclusions = {
  language: 'uk',
  headline: 'Інтерес до астрономії у 2025 році знизився',
  findings: [{ statement: 'Перегляди за день в українському розділі змінилися на −59,74 %.', evidence: ['uk.compare-1_vs_compare-2.averageDailyPercentChange'] }],
  hypotheses: [],
  limitations: ['Одна стаття на мовний розділ.'],
};

function context(runCli: CliRunner = createCliRunner({ env: skillEnvironment(process.env) })): ToolContext {
  return { runCli, workDir, reportCount: 0 };
}

function agentWith(model: ModelClient, transcript = new Transcript({}, [SECRET]), maxReportAttempts = 3) {
  return new Agent({ model, context: context(), transcript, systemPrompt: buildSystemPrompt('# Skill', '2026-09-25'), limits: { maxModelCallsPerTurn: 8, maxReportAttempts } });
}

describe('tools (mocked model)', () => {
  it('exposes exactly the approved operations with small schemas', () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.function.name)).toEqual(['resolve', 'research', 'research_metrics', 'report']);
    expect(JSON.stringify(TOOL_DEFINITIONS).length).toBeLessThan(5000);
  });

  it('maps research arguments to separate argv entries (no shell interpretation)', () => {
    const argv = researchCliArgs({ topic: 'Astronomy"; rm -rf ~ #', lang: 'en', langs: 'uk,pl', compare: '2024-01..2024-12,2025-01..2025-12' }, '/work/output');
    expect(argv).toEqual(['research', '--topic', 'Astronomy"; rm -rf ~ #', '--lang', 'en', '--langs', 'uk,pl', '--compare', '2024-01..2024-12,2025-01..2025-12', '--out', '/work/output']);
  });

  it('rejects invalid JSON, unknown fields, unknown tools and files outside the session', async () => {
    const noCli: CliRunner = async () => {
      throw new Error('must not run');
    };
    const ctx = context(noCli);
    expect((await executeTool('research', '{langs: uk', ctx)).errorCode).toBe('INVALID_TOOL_ARGUMENTS');
    expect((await executeTool('research', JSON.stringify({ langs: 'uk', out: '/etc' }), ctx)).errorCode).toBe('INVALID_TOOL_ARGUMENTS');
    expect((await executeTool('shell', '{}', ctx)).errorCode).toBe('UNKNOWN_TOOL');
    expect((await executeTool('research_metrics', JSON.stringify({ research_file: '/etc/passwd' }), ctx)).errorCode).toBe('FILE_NOT_ALLOWED');
    expect((await executeTool('report', JSON.stringify({ research_file: '../../x.json', conclusions: {} }), ctx)).errorCode).toBe('FILE_NOT_ALLOWED');
  });

  it('returns metric IDs and values, not raw observations', async () => {
    const outcome = await executeTool('research_metrics', JSON.stringify({ research_file: researchFile, prefix: 'uk.compare-1_vs' }), context());
    const content = outcome.content as { metrics: Record<string, { value: unknown }>; warnings: string[] };
    expect(content.metrics['uk.compare-1_vs_compare-2.averageDailyPercentChange']?.value).toBe(-59.74);
    expect(Object.keys(content.metrics).every((id) => id.startsWith('uk.compare-1_vs'))).toBe(true);
    expect(JSON.stringify(content)).not.toContain('observations');
  });

  it('never forwards the OpenRouter key to the skill process', () => {
    const env = skillEnvironment({ PATH: '/bin', HOME: '/home/u', OPENROUTER_API_KEY: SECRET, OPENROUTER_MODEL: 'x', WMR_CONTACT: 'dev@example.org' }, { WMR_CACHE_DIR: '/c' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/u', WMR_CONTACT: 'dev@example.org', WMR_CACHE_DIR: '/c' });
  });
});

describe('agent loop (mocked model, real CLI report)', () => {
  it('lets the model correct invalid conclusions after a structured validation error', async () => {
    const invalid = { ...validConclusions, findings: [{ statement: 'Спад −59,74 %.', evidence: ['uk.main.percentChange'] }] };
    const model = new ScriptedModel([
      () => toolCall('report', { research_file: researchFile, conclusions: invalid }),
      (messages) => {
        const error = lastToolResult(messages).error;
        expect(error.code).toBe('INVALID_CONCLUSIONS');
        expect(error.details.issues[0].suggestions.length).toBeGreaterThan(0);
        return toolCall('report', { research_file: researchFile, conclusions: validConclusions });
      },
      (messages) => answer(`Звіт готовий: ${lastToolResult(messages).data.reportPath}`),
    ]);
    const result = await agentWith(model).ask('B', 'Згенеруй звіт');

    expect(result).toMatchObject({ status: 'answered', modelCalls: 3, reportAttempts: 2 });
    expect(result.reportFailures).toEqual([expect.objectContaining({ errorCode: 'INVALID_CONCLUSIONS' })]);
    const files = await readdir(join(workDir, 'reports'));
    expect(files.sort()).toEqual(['conclusions-1.json', 'conclusions-2.json', 'report-2-uk-chart.svg', 'report-2-uk.pdf']);
  });

  it('stops with a clear failure when conclusions stay invalid, without bypassing validation', async () => {
    const invalid = { ...validConclusions, findings: [{ statement: 'Спад на 99 %.', evidence: ['uk.compare-1_vs_compare-2.averageDailyPercentChange'] }] };
    const model = new ScriptedModel([() => toolCall('report', { research_file: researchFile, conclusions: invalid })]);
    const result = await agentWith(model).ask('B', 'Згенеруй звіт');

    expect(result.status).toBe('report_validation_failed');
    expect(result.reportAttempts).toBe(3);
    expect(model.calls).toBe(3);
    expect(result.error).toContain('3 report attempts');
    const files = await readdir(join(workDir, 'reports'));
    expect(files.filter((file) => file.endsWith('.pdf'))).toEqual([]);
  });

  it('keeps conversation context across turns', async () => {
    const model = new ScriptedModel([
      () => answer('Перша відповідь.'),
      (messages) => {
        expect(messages.filter((message) => message.role === 'user')).toHaveLength(2);
        return answer('Друга відповідь.');
      },
    ]);
    const agent = agentWith(model);
    await agent.ask('1', 'Перше питання');
    expect((await agent.ask('2', 'Друге питання')).answer).toBe('Друга відповідь.');
    expect(agent.messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant']);
  });

  it('reports model failures with their category instead of switching models', async () => {
    const failing: ModelClient = {
      model: 'scripted/unavailable',
      complete: async () => {
        throw new ModelError('model_unavailable', 'OpenRouter returned HTTP 404 for model scripted/unavailable', 404);
      },
    };
    const result = await agentWith(failing).ask('ping', 'hi');
    expect(result).toMatchObject({ status: 'model_error', modelCalls: 0 });
    expect(result.error).toContain('model_unavailable');
    expect(classifyModelError(new Error('socket hang up'), 'm').kind).toBe('network');
    const { OpenRouterError } = await import('@openrouter/sdk/models/errors');
    const providerError = new OpenRouterError('Too Many Requests', {
      response: new Response('', { status: 429 }),
      request: new Request('https://openrouter.ai/api/v1/chat/completions'),
      body: '{"error":{"code":429},"user_id":"user_ABC123secret"}',
    });
    const classified = classifyModelError(providerError, 'm');
    expect(classified.kind).toBe('rate_limited');
    expect(classified.message).not.toContain('user_ABC123secret');
  });
});

describe('configuration and transcripts (mocked model)', () => {
  it('requires the key, defaults to the preferred model and honours an explicit alternative', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(loadConfig({ OPENROUTER_API_KEY: SECRET }).model).toBe(PREFERRED_MODEL);
    expect(loadConfig({ OPENROUTER_API_KEY: SECRET, OPENROUTER_MODEL: 'google/gemma-4-31b-it:free' }).model).toBe('google/gemma-4-31b-it:free');
    expect(loadConfig({ OPENROUTER_API_KEY: SECRET }).rateLimitRetries).toBe(3);
    expect(loadConfig({ OPENROUTER_API_KEY: SECRET, OPENROUTER_RATE_LIMIT_RETRIES: '10' }).rateLimitRetries).toBe(10);
    expect(() => loadConfig({ OPENROUTER_API_KEY: SECRET, OPENROUTER_RATE_LIMIT_RETRIES: 'many' })).toThrow(ConfigError);
  });

  it('never writes the API key to transcripts', async () => {
    const transcript = new Transcript({ model: 'x' }, [SECRET]);
    transcript.record({ kind: 'user', turn: 't', text: `please use ${SECRET}` });
    transcript.record({ kind: 'error', turn: 't', message: `Bearer ${SECRET}` });
    const saved = await transcript.save(join(workDir, 'transcript'));
    for (const file of [saved.json, saved.markdown]) {
      const text = await readFile(file, 'utf8');
      expect(text).not.toContain(SECRET);
      expect(text).toContain('[REDACTED]');
    }
  });
});

describe('scenario checks (mocked model)', () => {
  it('flags numbers that no tool returned', () => {
    const results = [{ data: { analysis: { periods: [{ averageDaily: 69.6, total: 25473 }] } } }];
    expect(ungroundedNumbers('Daily views fell from 69,6 (25 473 in 2024) to about 70.', results)).toEqual([]);
    expect(ungroundedNumbers('Roughly 12 000 people read it.', results)).toEqual(['12 000']);
  });

  it('fails scenario D when the model silently researches one meaning of Mercury', () => {
    const turn = MERCURY.turns[0]!;
    const checks = turn.checks(
      {
        status: 'answered',
        answer: 'Here are the statistics for the planet Mercury.',
        modelCalls: 2,
        reportAttempts: 0,
        reportFailures: [],
        calls: [],
        toolCalls: [{ name: 'research', arguments: JSON.stringify({ article: 'en:Mercury (planet)', langs: 'en' }), ok: true, result: { ok: true, data: {} } }],
      },
      { researchFiles: [] },
    );
    expect(checks.find((item) => item.name === 'did not silently pick a meaning')?.passed).toBe(false);
    expect(checks.find((item) => item.name === 'asks a clarification question')?.passed).toBe(false);
  });
});
