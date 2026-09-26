import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Environment passed to the skill: only what the CLI needs. The OpenRouter key is never forwarded. */
const FORWARDED_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'WMR_CONTACT', 'WMR_CACHE_DIR', 'XDG_CACHE_HOME'] as const;

export function skillEnvironment(env: Record<string, string | undefined>, overrides: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of FORWARDED_ENV) {
    const value = env[name];
    if (value !== undefined) result[name] = value;
  }
  return { ...result, ...overrides };
}

export interface CliResult {
  exitCode: number;
  /** Parsed JSON envelope from stdout, or null when stdout was not JSON. */
  envelope: unknown;
  stdout: string;
  stderr: string;
}

export type CliRunner = (args: string[]) => Promise<CliResult>;

/** Runs `node scripts/wmr.ts <args>` without a shell; arguments are passed as an array, never interpolated. */
export function createCliRunner(options: { env: Record<string, string>; timeoutMs?: number }): CliRunner {
  return (args) =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        ['scripts/wmr.ts', ...args],
        { cwd: REPO_ROOT, env: options.env, timeout: options.timeoutMs ?? 180_000, maxBuffer: 16 * 1024 * 1024, shell: false },
        (error, stdout, stderr) => {
          const exitCode = error && typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code as number) : error ? -1 : 0;
          let envelope: unknown = null;
          try {
            envelope = JSON.parse(stdout);
          } catch {
            envelope = null;
          }
          resolve({ exitCode, envelope, stdout, stderr: stderr.slice(0, 2000) });
        },
      );
    });
}
