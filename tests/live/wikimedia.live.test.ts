/// <reference types="vite/client" />
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileCache } from '../../src/cache/fileCache.ts';
import { runResearch } from '../../src/research/research.ts';
import { EnvelopeSchema } from '../../src/schemas/envelope.ts';
import { ResearchInputSchema } from '../../src/schemas/inputs.ts';
import { ResearchArtifactSchema } from '../../src/schemas/research.ts';
import { ResolveResultSchema } from '../../src/schemas/resolve.ts';
import { buildUserAgent, createAxiosTransport, createJsonClient } from '../../src/wikimedia/http.ts';
import { resolveTopic } from '../../src/wikimedia/resolve.ts';

// Real Wikimedia requests. Skipped by `npm test`; run with `npm run test:live`.
describe.skipIf(import.meta.env.MODE !== 'live')('live Wikimedia API', () => {
  const api = createJsonClient({ transport: createAxiosTransport(buildUserAgent()) });

  it('resolves Astronomy to verified Ukrainian and Polish articles', { timeout: 30_000 }, async () => {
    const { result, warnings } = await resolveTopic(api, { topic: 'Astronomy', lang: 'en', languages: ['en', 'uk', 'pl'], limit: 3 });

    ResolveResultSchema.parse(result);
    expect(result.status).toBe('resolved');
    expect(result.source).toMatchObject({ title: 'Astronomy', wikidataId: 'Q333' });
    expect(result.articles.map((article) => [article.lang, article.status, article.title, article.wikidataId])).toEqual([
      ['en', 'verified', 'Astronomy', 'Q333'],
      ['uk', 'verified', 'Астрономія', 'Q333'],
      ['pl', 'verified', 'Astronomia', 'Q333'],
    ]);
    expect(result.missingLanguages).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('reports the English disambiguation page for Mercury as ambiguous', { timeout: 30_000 }, async () => {
    const { result } = await resolveTopic(api, { topic: 'Mercury', lang: 'en', languages: ['uk'], limit: 5 });
    expect(result).toMatchObject({ status: 'ambiguous', reason: 'disambiguation_page' });
    expect(result.candidates.length).toBeGreaterThan(0);
  });
});

describe.skipIf(import.meta.env.MODE !== 'live')('live Wikimedia pageviews', () => {
  const api = createJsonClient({ transport: createAxiosTransport(buildUserAgent()) });
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wmr-live-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const research = (flags: Record<string, unknown>) =>
    runResearch(ResearchInputSchema.parse({ out: join(dir, 'out'), ...flags }), {
      api,
      cache: new FileCache({ dir: join(dir, 'cache') }),
      now: () => new Date(),
    });

  it('collects the default 12 completed months for Astronomy in Ukrainian and Polish', { timeout: 60_000 }, async () => {
    const { artifact, summary } = await research({ topic: 'Astronomy', lang: 'en', langs: 'uk,pl' });

    expect(summary.periodMode).toBe('default');
    expect(summary.granularity.selected).toBe('monthly');
    expect(artifact.datasets.map((dataset) => [dataset.lang, dataset.project, dataset.title])).toEqual([
      ['uk', 'uk.wikipedia', 'Астрономія'],
      ['pl', 'pl.wikipedia', 'Astronomia'],
    ]);
    for (const dataset of artifact.datasets) {
      expect(dataset.createdAt).not.toBeNull();
      expect(dataset.observations).toHaveLength(12);
      // A long-established article has views every month; any gap must be explained, never zero-filled.
      for (const observation of dataset.observations) {
        if (observation.status !== 'observed') expect(['unavailable', 'incomplete']).toContain(observation.status);
        if (observation.status === 'observed') expect(observation.views).toBeGreaterThan(0);
      }
    }

    const again = await research({ topic: 'Astronomy', lang: 'en', langs: 'uk,pl' });
    expect(again.summary.cache.misses).toBe(0);
    expect(again.summary.cache.hits).toBeGreaterThan(0);
  });

  it('returns daily data whose sum matches the monthly value for a completed month', { timeout: 60_000 }, async () => {
    const daily = await research({ article: 'en:Astronomy', langs: 'uk,pl', start: '2025-03-01', end: '2025-03-31', granularity: 'daily' });
    const monthly = await research({ article: 'en:Astronomy', langs: 'uk,pl', start: '2025-03', end: '2025-03' });

    for (const lang of ['uk', 'pl']) {
      const days = daily.artifact.datasets.find((dataset) => dataset.lang === lang)?.observations ?? [];
      const month = monthly.artifact.datasets.find((dataset) => dataset.lang === lang)?.observations[0];
      expect(days).toHaveLength(31);
      expect(days.every((observation) => observation.status === 'observed' || observation.status === 'zero_omitted')).toBe(true);
      expect(month?.status).toBe('observed');
      expect(days.reduce((sum, observation) => sum + (observation.views ?? 0), 0)).toBe(month?.views);
    }
  });
});

describe.skipIf(import.meta.env.MODE !== 'live')('live end-to-end CLI analysis', () => {
  it('runs `research` via the CLI and returns consistent statistics for Astronomy (uk, pl)', { timeout: 120_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wmr-e2e-'));
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['scripts/wmr.ts', 'research', '--article', 'en:Astronomy', '--langs', 'uk,pl', '--compare', '2024-01..2024-12,2025-01..2025-12', '--out', join(dir, 'out')],
        { env: { ...process.env, WMR_CACHE_DIR: join(dir, 'cache') } },
      );
      const envelope = EnvelopeSchema.parse(JSON.parse(stdout));
      if (!envelope.ok) throw new Error(JSON.stringify(envelope.error));
      const data = envelope.data as { artifactPath: string; analysis: { comparisons: { lang: string; id: string; percentChange: number | null; status: string }[] } };
      const artifact = ResearchArtifactSchema.parse(JSON.parse(await readFile(data.artifactPath, 'utf8')));

      expect(artifact.plan.granularity).toBe('monthly');
      expect(data.analysis.comparisons.map((comparison) => comparison.lang)).toEqual(['uk', 'pl']);
      for (const language of artifact.analysis.languages) {
        const [year2024, year2025] = language.periods;
        const dataset = artifact.datasets.find((candidate) => candidate.lang === language.lang);
        // Totals must equal the sum of the saved monthly observations.
        const sumOf = (start: string, end: string) =>
          (dataset?.observations ?? []).filter((o) => o.period >= start && o.period <= end).reduce((total, o) => total + (o.views ?? 0), 0);
        expect(year2024?.metrics.total).toBe(sumOf('2024-01-01', '2024-12-01'));
        expect(year2025?.metrics.total).toBe(sumOf('2025-01-01', '2025-12-01'));
        const comparison = artifact.analysis.comparisons.find((candidate) => candidate.lang === language.lang);
        const expected = (((year2025?.metrics.total as number) - (year2024?.metrics.total as number)) / (year2024?.metrics.total as number)) * 100;
        expect(comparison?.percentChange).toBeCloseTo(expected, 2);
        expect(artifact.analysis.metrics[`${language.lang}.compare-1_vs_compare-2.percentChange`]?.value).toBe(comparison?.percentChange);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
