import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FileCache, resolveCacheDir } from '../../src/cache/fileCache.ts';

const HOUR = 3_600_000;
const parts = {
  project: 'uk.wikipedia',
  article: 'Астрономія',
  granularity: 'daily',
  start: '2025-01-01',
  end: '2025-12-31',
  agent: 'user',
  access: 'all-access',
};
const Value = z.object({ rows: z.number() });

let dir: string;
let now: Date;
let cache: FileCache;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wmr-cache-'));
  now = new Date('2026-01-10T12:00:00Z');
  cache = new FileCache({ dir, now: () => now });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

describe('FileCache', () => {
  it('misses when nothing is stored', async () => {
    expect(await cache.get('pageviews', parts, Value)).toBeNull();
  });

  it('hits after a write and returns the fetch timestamp', async () => {
    await cache.set('pageviews', parts, { rows: 42 }, { ttlMs: HOUR, source: 'https://example.org', meta: { observations: 42 } });
    expect(await cache.get('pageviews', parts, Value)).toEqual({ value: { rows: 42 }, fetchedAt: now.toISOString() });
  });

  it('stores key parameters, source and metadata in the entry', async () => {
    await cache.set('pageviews', parts, { rows: 1 }, { ttlMs: HOUR, source: 'https://example.org/x', meta: { observations: 1 } });
    const entry = JSON.parse(await readFile(cache.pathFor('pageviews', parts), 'utf8'));
    expect(entry).toMatchObject({
      namespace: 'pageviews',
      key: parts,
      source: 'https://example.org/x',
      fetchedAt: '2026-01-10T12:00:00.000Z',
      expiresAt: '2026-01-10T13:00:00.000Z',
      meta: { observations: 1 },
    });
  });

  it('expires entries after their TTL', async () => {
    await cache.set('pageviews', parts, { rows: 1 }, { ttlMs: HOUR, source: 's' });
    now = new Date(now.getTime() + HOUR - 1);
    expect(await cache.get('pageviews', parts, Value)).not.toBeNull();
    now = new Date(now.getTime() + 1);
    expect(await cache.get('pageviews', parts, Value)).toBeNull();
  });

  it.each(Object.keys(parts))('distinguishes entries by %s', async (key) => {
    await cache.set('pageviews', parts, { rows: 1 }, { ttlMs: HOUR, source: 's' });
    expect(await cache.get('pageviews', { ...parts, [key]: 'other' }, Value)).toBeNull();
  });

  it('distinguishes namespaces and ignores key order', async () => {
    await cache.set('pageviews', parts, { rows: 1 }, { ttlMs: HOUR, source: 's' });
    expect(await cache.get('first-revision', parts, Value)).toBeNull();
    const reversed = Object.fromEntries(Object.entries(parts).reverse());
    expect(await cache.get('pageviews', reversed, Value)).not.toBeNull();
  });

  it('treats corrupt or mismatching entries as misses', async () => {
    await cache.set('pageviews', parts, { rows: 1 }, { ttlMs: HOUR, source: 's' });
    expect(await cache.get('pageviews', parts, z.object({ other: z.string() }))).toBeNull();

    await writeFile(cache.pathFor('pageviews', parts), '{"format":1,"namesp', 'utf8');
    expect(await cache.get('pageviews', parts, Value)).toBeNull();
  });

  it('overwrites entries atomically without leaving temporary files', async () => {
    await cache.set('pageviews', parts, { rows: 1 }, { ttlMs: HOUR, source: 's' });
    await Promise.all([1, 2, 3, 4, 5].map((rows) => cache.set('pageviews', parts, { rows }, { ttlMs: HOUR, source: 's' })));
    expect((await cache.get('pageviews', parts, Value))?.value.rows).toBeGreaterThan(0);
    const files = await listFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
  });
});

describe('resolveCacheDir', () => {
  it('prefers WMR_CACHE_DIR, then XDG_CACHE_HOME, then ~/.cache', () => {
    expect(resolveCacheDir({ WMR_CACHE_DIR: '/custom' }, '/home/u')).toBe('/custom');
    expect(resolveCacheDir({ XDG_CACHE_HOME: '/xdg' }, '/home/u')).toBe(join('/xdg', 'wikipedia-market-research'));
    expect(resolveCacheDir({ WMR_CACHE_DIR: '  ' }, '/home/u')).toBe(join('/home/u', '.cache', 'wikipedia-market-research'));
  });
});
