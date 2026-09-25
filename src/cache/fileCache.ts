import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from './atomicWrite.ts';

const CACHE_FORMAT = 1;

export type CacheKeyParts = Record<string, string>;

const EntrySchema = z.object({
  format: z.literal(CACHE_FORMAT),
  namespace: z.string(),
  key: z.record(z.string(), z.string()),
  source: z.string(),
  fetchedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  /** Human-readable facts about the value, e.g. the number of observations. */
  meta: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  value: z.unknown(),
});

export interface CacheHit<T> {
  value: T;
  fetchedAt: string;
}

/**
 * Cache directory: WMR_CACHE_DIR, else $XDG_CACHE_HOME/wikipedia-market-research,
 * else ~/.cache/wikipedia-market-research. Never inside the skill directory.
 */
export function resolveCacheDir(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  if (env.WMR_CACHE_DIR?.trim()) return env.WMR_CACHE_DIR.trim();
  const base = env.XDG_CACHE_HOME?.trim() || join(home, '.cache');
  return join(base, 'wikipedia-market-research');
}

/** Stable JSON: keys sorted, so equal key parts always hash identically. */
function canonical(parts: CacheKeyParts): string {
  return JSON.stringify(Object.fromEntries(Object.entries(parts).sort(([a], [b]) => a.localeCompare(b))));
}

export interface FileCacheOptions {
  dir: string;
  now?: () => Date;
}

/**
 * JSON file cache with per-entry expiry. One file per entry, written atomically.
 * Expired or unreadable entries count as misses; there is no automatic cleanup.
 */
export class FileCache {
  readonly dir: string;
  readonly #now: () => Date;

  constructor(options: FileCacheOptions) {
    this.dir = options.dir;
    this.#now = options.now ?? (() => new Date());
  }

  pathFor(namespace: string, parts: CacheKeyParts): string {
    const hash = createHash('sha256').update(`${namespace}\n${canonical(parts)}`).digest('hex');
    return join(this.dir, `v${CACHE_FORMAT}`, namespace, hash.slice(0, 2), `${hash}.json`);
  }

  /** Returns the cached value, or null when absent, expired, corrupt, or not matching `schema`. */
  async get<S extends z.ZodType>(namespace: string, parts: CacheKeyParts, schema: S): Promise<CacheHit<z.output<S>> | null> {
    let raw: string;
    try {
      raw = await readFile(this.pathFor(namespace, parts), 'utf8');
    } catch {
      return null;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return null;
    }
    const entry = EntrySchema.safeParse(json);
    if (!entry.success) return null;
    // Guard against hash collisions and hand-edited files.
    if (entry.data.namespace !== namespace || canonical(entry.data.key) !== canonical(parts)) return null;
    if (Date.parse(entry.data.expiresAt) <= this.#now().getTime()) return null;

    const value = schema.safeParse(entry.data.value);
    return value.success ? { value: value.data, fetchedAt: entry.data.fetchedAt } : null;
  }

  async set(
    namespace: string,
    parts: CacheKeyParts,
    value: unknown,
    options: { ttlMs: number; source: string; fetchedAt?: Date; meta?: Record<string, string | number> },
  ): Promise<void> {
    const fetchedAt = options.fetchedAt ?? this.#now();
    const entry = {
      format: CACHE_FORMAT,
      namespace,
      key: parts,
      source: options.source,
      fetchedAt: fetchedAt.toISOString(),
      expiresAt: new Date(fetchedAt.getTime() + options.ttlMs).toISOString(),
      ...(options.meta && { meta: options.meta }),
      value,
    };
    await writeFileAtomic(this.pathFor(namespace, parts), `${JSON.stringify(entry)}\n`);
  }
}
