/**
 * Harness configuration from the environment. The key is never logged, printed or written to transcripts.
 * There is no automatic fallback model: if the configured model fails, the run fails and says why.
 */
export const PREFERRED_MODEL = 'google/gemma-4-26b-a4b-it:free';

export interface HarnessConfig {
  apiKey: string;
  model: string;
  /** Model calls allowed per user turn before the turn is stopped. */
  maxModelCallsPerTurn: number;
  /** Report attempts per turn; failed validations beyond this stop the turn. */
  maxReportAttempts: number;
  /** Retries of the same model after HTTP 429 (shared free pools are intermittently available). */
  rateLimitRetries: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): HarnessConfig {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigError('OPENROUTER_API_KEY is not set. Add it to .env (see .env.example); it is only read by the harness.');
  }
  const model = env.OPENROUTER_MODEL?.trim() || PREFERRED_MODEL;
  const retries = Number(env.OPENROUTER_RATE_LIMIT_RETRIES ?? 3);
  if (!Number.isInteger(retries) || retries < 0 || retries > 20) throw new ConfigError('OPENROUTER_RATE_LIMIT_RETRIES must be an integer from 0 to 20.');
  return { apiKey, model, maxModelCallsPerTurn: 12, maxReportAttempts: 3, rateLimitRetries: retries };
}
