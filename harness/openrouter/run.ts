/**
 * Live OpenRouter test harness for the Wikipedia Market Research skill (development/testing only).
 *
 *   node --env-file-if-exists=.env harness/openrouter/run.ts [ping|short|scenario-a|conversation|mercury|all]
 *
 * Needs OPENROUTER_API_KEY; OPENROUTER_MODEL defaults to poolside/laguna-s-2.1:free.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent, buildSystemPrompt } from './agent.ts';
import { createCliRunner, REPO_ROOT, skillEnvironment } from './cli.ts';
import { ConfigError, loadConfig } from './config.ts';
import { OpenRouterModelClient } from './model.ts';
import { SESSIONS, type Check, type SessionState } from './scenarios.ts';
import { Transcript } from './transcript.ts';

async function allFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

async function main(): Promise<number> {
  const selection = (process.argv[2] ?? 'all') as keyof typeof SESSIONS;
  if (!(selection in SESSIONS)) {
    console.error(`Unknown selection "${selection}". Use: ${Object.keys(SESSIONS).join(', ')}.`);
    return 1;
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }

  const startedAt = new Date();
  const runDir = join(REPO_ROOT, 'harness', 'openrouter', 'runs', startedAt.toISOString().replace(/[:.]/g, '-'));
  const skill = await readFile(join(REPO_ROOT, 'SKILL.md'), 'utf8');
  const systemPrompt = buildSystemPrompt(skill, startedAt.toISOString().slice(0, 10));
  const runCli = createCliRunner({ env: skillEnvironment(process.env, { WMR_CACHE_DIR: join(runDir, 'cache') }) });
  const model = new OpenRouterModelClient({ apiKey: config.apiKey, model: config.model, rateLimitRetries: config.rateLimitRetries });

  console.log(`Model: ${config.model}\nRun directory: ${runDir}`);
  const summary: Record<string, unknown>[] = [];
  let failed = false;

  for (const session of SESSIONS[selection]) {
    const transcript = new Transcript(
      { session: session.id, description: session.description, model: config.model, date: startedAt.toISOString(), node: process.version },
      [config.apiKey],
    );
    const workDir = join(runDir, session.id);
    const agent = new Agent({ model, context: { runCli, workDir, reportCount: 0 }, transcript, systemPrompt, limits: config });
    const state: SessionState = { researchFiles: [] };
    const turns: Record<string, unknown>[] = [];

    for (const turn of session.turns) {
      console.log(`\n▶ ${session.id} / ${turn.id}: ${turn.prompt}`);
      const result = await agent.ask(turn.id, turn.prompt);
      const checks: Check[] = turn.checks(result, state);
      const passed = checks.every((item) => item.passed || item.informational);
      failed ||= !passed;
      console.log(`  status ${result.status}, model calls ${result.modelCalls}, tools: ${result.toolCalls.map((call) => `${call.name}${call.ok ? '' : `(${call.errorCode})`}`).join(', ') || 'none'}`);
      for (const [index, call] of result.calls.entries()) {
        console.log(`  call ${index + 1}: HTTP ${call.httpStatus ?? '?'}, served ${call.servedModel ?? '?'}, ${call.latencyMs ?? '?'} ms, finish ${call.finishReason ?? '?'}, tool calls ${call.toolCalls}`);
      }
      for (const item of checks) console.log(`  ${item.informational ? 'ℹ' : item.passed ? '✓' : '✗'} ${item.name} — ${item.detail}`);
      if (result.error) console.log(`  error: ${result.error}`);
      turns.push({
        id: turn.id,
        prompt: turn.prompt,
        status: result.status,
        passed,
        modelCalls: result.modelCalls,
        toolCalls: result.toolCalls.map((call) => ({ name: call.name, ok: call.ok, errorCode: call.errorCode ?? null, arguments: call.arguments })),
        reportAttempts: result.reportAttempts,
        reportFailures: result.reportFailures,
        calls: result.calls,
        checks,
        answer: result.answer,
        error: result.error ?? null,
      });
      if (result.status === 'model_error') break;
    }

    const saved = await transcript.save(workDir);
    summary.push({ session: session.id, transcript: saved.markdown, turns });
  }

  const summaryPath = join(runDir, 'summary.json');
  await writeFile(summaryPath, `${JSON.stringify({ model: config.model, date: startedAt.toISOString(), sessions: summary }, null, 2)}\n`, 'utf8');

  // Defence in depth: no file of the run may contain the API key.
  for (const file of await allFiles(runDir)) {
    if (!/\.(json|md|txt|svg)$/.test(file)) continue;
    if ((await readFile(file, 'utf8')).includes(config.apiKey)) throw new Error(`Secret found in ${file}; run aborted.`);
  }

  console.log(`\nSummary: ${summaryPath}\nOverall: ${failed ? 'FAILED checks (see summary)' : 'all checks passed'}`);
  return failed ? 1 : 0;
}

process.exitCode = await main();
