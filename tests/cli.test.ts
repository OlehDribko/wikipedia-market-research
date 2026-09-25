import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { CommandDeps } from '../src/cli/commands.ts';
import { main } from '../src/cli/main.ts';
import { EnvelopeSchema } from '../src/schemas/envelope.ts';
import { ResolveResultSchema } from '../src/schemas/resolve.ts';
import { createJsonClient, type HttpTransport } from '../src/wikimedia/http.ts';
import packageJson from '../package.json' with { type: 'json' };
import { createFakeWikimedia } from './helpers/fakeWikimedia.ts';

const FIXED_NOW = new Date('2026-01-15T10:00:00.000Z');

/** Fails loudly if a test unexpectedly reaches the network. */
const offlineDeps: CommandDeps = {
  wikimedia: () => {
    throw new Error('Network access is not expected in this test.');
  },
};

function depsFor(transport: HttpTransport): CommandDeps {
  return { wikimedia: () => createJsonClient({ transport, sleep: async () => {} }) };
}

async function run(argv: string[], deps: CommandDeps = offlineDeps) {
  let output = '';
  const exitCode = await main(argv, { write: (text) => (output += text), now: () => FIXED_NOW }, deps);
  return { exitCode, output };
}

async function runJson(argv: string[], deps?: CommandDeps) {
  const { exitCode, output } = await run(argv, deps);
  const envelope = EnvelopeSchema.parse(JSON.parse(output));
  return { exitCode, envelope };
}

describe('help and version', () => {
  it('prints the version from package.json', async () => {
    expect(await run(['--version'])).toEqual({ exitCode: 0, output: `${packageJson.version}\n` });
  });

  it('prints general help listing all commands', async () => {
    const { exitCode, output } = await run(['--help']);
    expect(exitCode).toBe(0);
    for (const command of ['research', 'resolve', 'report']) expect(output).toContain(command);
  });

  it('prints command help even with otherwise invalid flags', async () => {
    const { exitCode, output } = await run(['research', '--bogus', '-h']);
    expect(exitCode).toBe(0);
    expect(output).toContain('--langs <value>');
    expect(output).toContain('required');
  });
});

describe('dispatch errors', () => {
  it('reports a missing command', async () => {
    const { exitCode, envelope } = await runJson([]);
    expect(exitCode).toBe(1);
    expect(envelope).toMatchObject({ ok: false, command: null, error: { code: 'MISSING_COMMAND' } });
  });

  it('reports an unknown command with the valid choices', async () => {
    const { exitCode, envelope } = await runJson(['forecast']);
    expect(exitCode).toBe(1);
    expect(envelope).toMatchObject({ ok: false, error: { code: 'UNKNOWN_COMMAND', hint: 'Use one of: research, resolve, report.' } });
  });

  it('rejects options before the command', async () => {
    const { envelope } = await runJson(['--langs', 'en']);
    expect(envelope).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } });
  });

  it('rejects unknown options and positionals', async () => {
    for (const argv of [['resolve', '--topic', 'x', '--lang', 'en', '--verbose'], ['resolve', 'extra']]) {
      const { exitCode, envelope } = await runJson(argv);
      expect(exitCode).toBe(1);
      expect(envelope).toMatchObject({ ok: false, command: 'resolve', error: { code: 'INVALID_ARGUMENTS' } });
    }
  });

  it('rejects a string option without a value', async () => {
    const { envelope } = await runJson(['research', '--article', 'en:X', '--langs']);
    expect(envelope).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } });
  });
});

describe('input validation', () => {
  it('returns INVALID_INPUT with per-option details', async () => {
    const { exitCode, envelope } = await runJson(['research', '--article', 'en:Pilates']);
    expect(exitCode).toBe(1);
    expect(envelope).toMatchObject({
      ok: false,
      command: 'research',
      error: {
        code: 'INVALID_INPUT',
        message: '--langs: --langs is required, e.g. --langs en,de,uk.',
        details: [{ option: '--langs' }],
      },
      meta: { version: packageJson.version, generatedAt: FIXED_NOW.toISOString() },
    });
  });

  it.each([
    ['research', ['--topic', 'Pilates', '--lang', 'en', '--langs', 'en,uk', '--start', '2024-01', '--end', '2024-12', '--no-cache']],
    ['report', ['--research', 'output/r.json', '--conclusions', 'output/c.json']],
  ])('validates %s input, then reports NOT_IMPLEMENTED', async (command, args) => {
    const { exitCode, envelope } = await runJson([command, ...args]);
    expect(exitCode).toBe(4);
    expect(envelope).toMatchObject({ ok: false, command, error: { code: 'NOT_IMPLEMENTED' } });
    if (!envelope.ok) expect(envelope.error.details).toHaveProperty('validatedInput');
  });
});

describe('resolve command', () => {
  const wikis = {
    en: {
      pages: [
        { title: 'Astronomy', pageid: 1, wikidata: 'Q333', langlinks: { pl: 'Astronomia' } },
        { title: 'Mercury', pageid: 2, disambiguation: true },
        { title: 'Mercury (planet)', pageid: 3 },
      ],
      search: { Mercury: ['Mercury', 'Mercury (planet)'] },
    },
    pl: { pages: [{ title: 'Astronomia', pageid: 10, wikidata: 'Q333' }] },
  };

  it('prints a resolved result in the success envelope', async () => {
    const { transport } = createFakeWikimedia({ wikis });
    const { exitCode, envelope } = await runJson(['resolve', '--topic', 'Astronomy', '--lang', 'en', '--langs', 'pl,uk'], depsFor(transport));

    expect(exitCode).toBe(0);
    if (!envelope.ok) throw new Error('expected success');
    const data = ResolveResultSchema.parse(envelope.data);
    expect(data).toMatchObject({ status: 'resolved', missingLanguages: ['uk'] });
    expect(envelope.warnings).toEqual([expect.objectContaining({ code: 'LANGUAGE_ARTICLE_MISSING', language: 'uk' })]);
    expect(envelope.limitations.length).toBeGreaterThan(0);
  });

  it('reports ambiguity as a successful result with candidates', async () => {
    const { transport } = createFakeWikimedia({ wikis });
    const { exitCode, envelope } = await runJson(['resolve', '--topic', 'Mercury', '--lang', 'en'], depsFor(transport));
    expect(exitCode).toBe(0);
    expect(envelope).toMatchObject({ ok: true, data: { status: 'ambiguous', candidates: [{ title: 'Mercury (planet)' }] } });
  });

  it('returns INVALID_LANGUAGE for unknown editions', async () => {
    const { transport } = createFakeWikimedia({ wikis });
    const { exitCode, envelope } = await runJson(['resolve', '--topic', 'Astronomy', '--lang', 'en', '--langs', 'pl,xx'], depsFor(transport));
    expect(exitCode).toBe(1);
    expect(envelope).toMatchObject({ ok: false, error: { code: 'INVALID_LANGUAGE', details: { invalidCodes: ['xx'] } } });
  });

  it('returns UPSTREAM_ERROR when Wikimedia is unavailable', async () => {
    const { exitCode, envelope } = await runJson(
      ['resolve', '--topic', 'Astronomy', '--lang', 'en'],
      depsFor(async () => ({ status: 503, data: '' })),
    );
    expect(exitCode).toBe(3);
    expect(envelope).toMatchObject({ ok: false, error: { code: 'UPSTREAM_ERROR', details: { kind: 'http', status: 503 } } });
  });

  it('returns UNEXPECTED_RESPONSE for malformed API data', async () => {
    const { exitCode, envelope } = await runJson(
      ['resolve', '--topic', 'Astronomy', '--lang', 'en'],
      depsFor(async () => ({ status: 200, data: { unexpected: true } })),
    );
    expect(exitCode).toBe(3);
    expect(envelope).toMatchObject({ ok: false, error: { code: 'UNEXPECTED_RESPONSE' } });
  });
});

describe('native TypeScript execution', () => {
  it('runs scripts/wmr.ts with plain node and prints one JSON object', async () => {
    const exec = promisify(execFile);
    const version = await exec(process.execPath, ['scripts/wmr.ts', '--version']);
    expect(version.stdout).toBe(`${packageJson.version}\n`);

    const failure = await exec(process.execPath, ['scripts/wmr.ts', 'unknown']).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 1 });
    const { stdout } = failure as { stdout: string };
    expect(EnvelopeSchema.parse(JSON.parse(stdout))).toMatchObject({ ok: false, error: { code: 'UNKNOWN_COMMAND' } });
  });
});
