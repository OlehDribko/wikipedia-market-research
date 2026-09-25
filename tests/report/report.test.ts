import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandDeps } from '../../src/cli/commands.ts';
import { main } from '../../src/cli/main.ts';
import { ReportError, runReport } from '../../src/report/report.ts';
import { EnvelopeSchema } from '../../src/schemas/envelope.ts';
import type { Conclusions } from '../../src/schemas/conclusions.ts';
import { polishConclusions, pdfText, REAL_ARTIFACT_PATH, ukrainianConclusions } from './helpers.ts';

const NOW = new Date('2026-09-25T20:00:00Z');
let dir: string;
let researchPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wmr-report-'));
  researchPath = join(dir, 'research-73b5a58c3327.json');
  await copyFile(REAL_ARTIFACT_PATH, researchPath);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConclusions(conclusions: unknown, name = 'conclusions.json'): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(conclusions), 'utf8');
  return path;
}

async function report(conclusions: unknown, outPath: string | null = null) {
  return runReport({ researchPath, conclusionsPath: await writeConclusions(conclusions), outPath }, { now: () => NOW });
}

async function reportError(conclusions: unknown): Promise<ReportError> {
  const error = await report(conclusions).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ReportError);
  return error as ReportError;
}

/** PDF text extraction joins glyph runs with various spaces; compare on normalized whitespace. */
const normalize = (text: string) => text.replace(/[\s  ]+/g, ' ');

describe('report from real research data', () => {
  it('creates a one-page Ukrainian PDF and an SVG chart next to the research file', async () => {
    const { result, warnings } = await report(ukrainianConclusions());
    expect(result).toMatchObject({ pages: 1, language: 'uk', labelsLanguage: 'uk', findings: 2, hypotheses: 1 });
    expect(result.reportPath).toBe(join(dir, 'report-73b5a58c3327-uk.pdf'));
    expect(result.chartPath).toBe(join(dir, 'report-73b5a58c3327-uk-chart.svg'));
    expect(warnings).toEqual([]);

    const { pages, text } = await pdfText(await readFile(result.reportPath));
    const content = normalize(text);
    expect(pages).toBe(1);
    for (const expected of [
      'Звіт про інтерес аудиторії у Вікіпедії: Астрономія',
      'КЛЮЧОВІ ПОКАЗНИКИ',
      'В українському розділі перегляди за день впали з 69,6 до 28,02',
      'Перегляди сторінки — це відвідування, а не унікальні люди чи клієнти.',
      'uk (українська): Астрономія',
      'pl (polski): Astronomia',
      '25 473', // uk 2024 total, from the artifact
      '-59,74%',
      'Wikimedia Pageviews API',
    ]) {
      expect(content).toContain(expected);
    }
    const svg = await readFile(result.chartPath, 'utf8');
    expect(svg).toContain('uk · Астрономія');
  });

  it('creates a Polish PDF with Polish diacritics', async () => {
    const { result } = await report(polishConclusions(), join(dir, 'out', 'raport.pdf'));
    expect(result.reportPath).toBe(join(dir, 'out', 'raport.pdf'));
    expect(result.chartPath).toBe(join(dir, 'out', 'raport-chart.svg'));
    const content = normalize((await pdfText(await readFile(result.reportPath))).text);
    for (const expected of ['KLUCZOWE WSKAŹNIKI', 'Zażółć gęślą jaźń', 'Odsłony to wizyty na stronie', 'Porównanie okresów'.toUpperCase(), '26 935']) {
      expect(content).toContain(expected);
    }
  });

  it('falls back to English labels for other languages and says so', async () => {
    const conclusions: Conclusions = { ...ukrainianConclusions(), language: 'de', labels: { findings: 'Ergebnisse' } };
    conclusions.headline = 'Das Interesse an Astronomie sank 2025.';
    const { result, warnings } = await report(conclusions);
    expect(result).toMatchObject({ language: 'de', labelsLanguage: 'en' });
    expect(warnings.map((warning) => warning.code)).toEqual(['REPORT_LABELS_FALLBACK']);
    const content = normalize((await pdfText(await readFile(result.reportPath))).text);
    expect(content).toContain('ERGEBNISSE');
    expect(content).toContain('KEY METRICS');
  });

  it('never modifies the research file', async () => {
    const before = await readFile(researchPath);
    const beforeStat = await stat(researchPath);
    await report(ukrainianConclusions());
    await report(polishConclusions());
    expect(createHash('sha256').update(await readFile(researchPath)).digest('hex')).toBe(createHash('sha256').update(before).digest('hex'));
    expect((await stat(researchPath)).mtimeMs).toBe(beforeStat.mtimeMs);
  });
});

describe('report input errors', () => {
  it('rejects unknown metric references with suggestions', async () => {
    const conclusions = ukrainianConclusions();
    conclusions.findings[0]!.evidence = ['uk.main.averageDaily'];
    const error = await reportError(conclusions);
    expect(error.code).toBe('INVALID_CONCLUSIONS');
    expect(error.hint).toContain('<lang>.<periodId>.<metric>');
    const issues = (error.details as { issues: { code: string; suggestions?: string[] }[] }).issues;
    expect(issues[0]).toMatchObject({ code: 'UNKNOWN_METRIC' });
    expect(issues[0]?.suggestions).toContain('uk.compare-1.averageDaily');
  });

  it('rejects conclusions that do not match the schema', async () => {
    const error = await reportError({ language: 'uk', headline: 'x', findings: [], limitations: [], forecast: 'up' });
    expect(error.code).toBe('INVALID_CONCLUSIONS');
    const paths = (error.details as { issues: { path: string }[] }).issues.map((issue) => issue.path);
    expect(paths).toEqual(expect.arrayContaining(['findings', 'hypotheses', 'limitations', '(root)']));
  });

  it('rejects malformed JSON and missing files', async () => {
    const conclusionsPath = join(dir, 'broken.json');
    await writeFile(conclusionsPath, '{"language": "uk",', 'utf8');
    await expect(runReport({ researchPath, conclusionsPath, outPath: null }, { now: () => NOW })).rejects.toMatchObject({ code: 'INVALID_CONCLUSIONS' });
    await expect(runReport({ researchPath: join(dir, 'missing.json'), conclusionsPath, outPath: null }, { now: () => NOW })).rejects.toMatchObject({
      code: 'INVALID_RESEARCH_FILE',
    });
  });

  it('rejects research files from older formats', async () => {
    const artifact = JSON.parse(await readFile(researchPath, 'utf8'));
    await writeFile(researchPath, JSON.stringify({ ...artifact, format: 1, analysis: null }), 'utf8');
    const error = await reportError(ukrainianConclusions());
    expect(error.code).toBe('INVALID_RESEARCH_FILE');
  });

  it('refuses content that cannot fit on one page instead of truncating it', async () => {
    const long = (seed: string, length: number) => `${seed} `.repeat(Math.ceil(length / (seed.length + 1))).slice(0, length).trim();
    const conclusions: Conclusions = {
      language: 'en',
      headline: long('Interest in astronomy declined', 160),
      findings: Array.from({ length: 8 }, () => ({ statement: long('The Ukrainian edition shows a clear decline', 500), evidence: ['uk.compare-1.averageDaily'] })),
      hypotheses: Array.from({ length: 5 }, () => ({ hypothesis: long('Readers moved elsewhere', 300), validationIdea: long('Interview potential users', 300) })),
      limitations: Array.from({ length: 8 }, () => long('Only one article per edition was analysed', 300)),
    };
    const error = await reportError(conclusions);
    expect(error.code).toBe('REPORT_DOES_NOT_FIT');
    expect(error.hint).toContain('Nothing is truncated');
    expect((error.details as { overflowPoints: number }).overflowPoints).toBeGreaterThan(0);
  });
});

describe('report command', () => {
  const offline: CommandDeps = {
    wikimedia: () => {
      throw new Error('The report command must not access Wikimedia.');
    },
    cache: () => {
      throw new Error('The report command must not use the pageview cache.');
    },
    now: () => NOW,
  };

  async function run(argv: string[]) {
    let output = '';
    const exitCode = await main(argv, { write: (text) => (output += text), now: () => NOW }, offline);
    return { exitCode, envelope: EnvelopeSchema.parse(JSON.parse(output)) };
  }

  it('generates the report without any network or cache access', async () => {
    const conclusionsPath = await writeConclusions(ukrainianConclusions());
    const { exitCode, envelope } = await run(['report', '--research', researchPath, '--conclusions', conclusionsPath]);
    expect(exitCode).toBe(0);
    expect(envelope).toMatchObject({ ok: true, command: 'report', data: { pages: 1, language: 'uk' } });
  });

  it('returns INVALID_CONCLUSIONS with exit code 1 and a correction hint', async () => {
    const conclusions = ukrainianConclusions();
    conclusions.findings[1]!.statement = 'Польський розділ: 99 переглядів.';
    const conclusionsPath = await writeConclusions(conclusions);
    const { exitCode, envelope } = await run(['report', '--research', researchPath, '--conclusions', conclusionsPath]);
    expect(exitCode).toBe(1);
    expect(envelope).toMatchObject({ ok: false, error: { code: 'INVALID_CONCLUSIONS', details: { issues: [{ code: 'UNSUPPORTED_NUMBER' }] } } });
  });
});
