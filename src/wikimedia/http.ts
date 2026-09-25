import axios from 'axios';
import type { z } from 'zod';
import { VERSION } from '../version.ts';

export const DEFAULT_CONTACT = 'https://github.com/OlehDribko/wikipedia-market-research/issues';

export interface HttpRequest {
  url: string;
  params: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  data: unknown;
  retryAfter?: string | undefined;
}

/** Performs one GET request. Resolves for every HTTP status; rejects only on network failure. */
export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

export type WikimediaErrorKind = 'network' | 'http' | 'rate_limited' | 'api_error' | 'unexpected_response';

export class WikimediaApiError extends Error {
  readonly kind: WikimediaErrorKind;
  readonly url: string;
  readonly status: number | undefined;

  constructor(kind: WikimediaErrorKind, message: string, url: string, status?: number) {
    super(message);
    this.name = 'WikimediaApiError';
    this.kind = kind;
    this.url = url;
    this.status = status;
  }
}

/**
 * Builds a User-Agent following the Wikimedia User-Agent policy:
 * `<client>/<version> (<contact>) <library>/<version>`.
 * The contact comes from WMR_CONTACT, falling back to the repository issue tracker.
 */
export function buildUserAgent(env: Record<string, string | undefined> = process.env): string {
  const contact = (env.WMR_CONTACT ?? '').replace(/[\u0000-\u001f\u007f()]/g, '').trim() || DEFAULT_CONTACT;
  return `wikipedia-market-research/${VERSION} (${contact}) axios/${axios.VERSION}`;
}

export function createAxiosTransport(userAgent: string, timeoutMs = 15_000): HttpTransport {
  const instance = axios.create({
    timeout: timeoutMs,
    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
    responseType: 'json',
    validateStatus: () => true,
  });
  return async ({ url, params }) => {
    const response = await instance.get(url, { params });
    const retryAfter = response.headers['retry-after'];
    return {
      status: response.status,
      data: response.data,
      retryAfter: typeof retryAfter === 'string' ? retryAfter : undefined,
    };
  };
}

export interface JsonClientOptions {
  transport: HttpTransport;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface JsonClient {
  /** GETs a JSON object, retrying network failures, 429 and 5xx with exponential backoff. */
  getJson(url: string, params: Record<string, string>): Promise<Record<string, unknown>>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createJsonClient(options: JsonClientOptions): JsonClient {
  const { transport, maxAttempts = 3, baseDelayMs = 500, maxDelayMs = 10_000, sleep = defaultSleep } = options;

  function retryDelay(attempt: number, retryAfter: string | undefined): number {
    const seconds = retryAfter !== undefined ? Number(retryAfter) : Number.NaN;
    const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : baseDelayMs * 2 ** (attempt - 1);
    return Math.min(delay, maxDelayMs);
  }

  return {
    async getJson(url, params) {
      let lastError: WikimediaApiError | undefined;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let response: HttpResponse;
        try {
          response = await transport({ url, params });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          lastError = new WikimediaApiError('network', `Network error calling ${url}: ${reason}`, url);
          if (attempt < maxAttempts) await sleep(retryDelay(attempt, undefined));
          continue;
        }

        if (response.status === 429 || response.status >= 500) {
          const kind = response.status === 429 ? 'rate_limited' : 'http';
          lastError = new WikimediaApiError(kind, `Wikimedia API returned HTTP ${response.status} for ${url}.`, url, response.status);
          if (attempt < maxAttempts) await sleep(retryDelay(attempt, response.retryAfter));
          continue;
        }
        if (response.status !== 200) {
          throw new WikimediaApiError('http', `Wikimedia API returned HTTP ${response.status} for ${url}.`, url, response.status);
        }
        if (!isRecord(response.data)) {
          throw new WikimediaApiError('unexpected_response', `Wikimedia API returned a non-JSON response for ${url}.`, url, 200);
        }
        const apiError = response.data.error;
        if (apiError !== undefined) {
          const info = isRecord(apiError) ? `${String(apiError.code)}: ${String(apiError.info)}` : String(apiError);
          throw new WikimediaApiError('api_error', `MediaWiki API error (${info}).`, url, 200);
        }
        return response.data;
      }

      throw lastError ?? new WikimediaApiError('network', `Request to ${url} failed.`, url);
    },
  };
}

/** Validates an API payload, turning schema mismatches into an `unexpected_response` error. */
export function parseResponse<S extends z.ZodType>(schema: S, data: unknown, url: string): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
    throw new WikimediaApiError(
      'unexpected_response',
      `Unexpected response structure from ${url}${where}: ${issue?.message ?? 'invalid'}.`,
      url,
      200,
    );
  }
  return result.data;
}
