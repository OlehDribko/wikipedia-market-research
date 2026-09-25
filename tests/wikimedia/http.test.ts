import { describe, expect, it } from 'vitest';
import {
  buildUserAgent,
  createJsonClient,
  DEFAULT_CONTACT,
  WikimediaApiError,
  type HttpResponse,
} from '../../src/wikimedia/http.ts';
import { VERSION } from '../../src/version.ts';

const URL = 'https://en.wikipedia.org/w/api.php';

function scriptedClient(responses: (HttpResponse | Error)[]) {
  const delays: number[] = [];
  let calls = 0;
  const client = createJsonClient({
    transport: async () => {
      const next = responses[Math.min(calls++, responses.length - 1)];
      if (next instanceof Error) throw next;
      return next as HttpResponse;
    },
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { client, delays, calls: () => calls };
}

async function captureError(promise: Promise<unknown>): Promise<WikimediaApiError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(WikimediaApiError);
  return error as WikimediaApiError;
}

describe('buildUserAgent', () => {
  it('uses the repository issue tracker by default', () => {
    expect(buildUserAgent({})).toMatch(
      new RegExp(`^wikipedia-market-research/${VERSION} \\(${DEFAULT_CONTACT.replaceAll('.', '\\.')}\\) axios/\\d+\\.\\d+\\.\\d+$`),
    );
  });

  it('uses WMR_CONTACT and strips characters that could break the header', () => {
    expect(buildUserAgent({ WMR_CONTACT: ' dev@example.org ' })).toContain('(dev@example.org)');
    expect(buildUserAgent({ WMR_CONTACT: 'a@b.org\r\nX-Evil: 1 (x)' })).toContain('(a@b.orgX-Evil: 1 x)');
    expect(buildUserAgent({ WMR_CONTACT: '   ' })).toContain(`(${DEFAULT_CONTACT})`);
  });
});

describe('createJsonClient', () => {
  it('returns JSON objects on success', async () => {
    const { client } = scriptedClient([{ status: 200, data: { batchcomplete: true } }]);
    await expect(client.getJson(URL, {})).resolves.toEqual({ batchcomplete: true });
  });

  it('retries 5xx responses with exponential backoff', async () => {
    const { client, delays, calls } = scriptedClient([
      { status: 503, data: 'busy' },
      { status: 502, data: 'busy' },
      { status: 200, data: { ok: 1 } },
    ]);
    await expect(client.getJson(URL, {})).resolves.toEqual({ ok: 1 });
    expect(calls()).toBe(3);
    expect(delays).toEqual([500, 1000]);
  });

  it('honours Retry-After on 429 and caps the delay', async () => {
    const { client, delays } = scriptedClient([
      { status: 429, data: '', retryAfter: '2' },
      { status: 429, data: '', retryAfter: '600' },
      { status: 200, data: {} },
    ]);
    await client.getJson(URL, {});
    expect(delays).toEqual([2000, 10_000]);
  });

  it('gives up after the maximum number of attempts', async () => {
    const { client, calls } = scriptedClient([{ status: 503, data: '' }]);
    const error = await captureError(client.getJson(URL, {}));
    expect(error).toMatchObject({ kind: 'http', status: 503, url: URL });
    expect(calls()).toBe(3);
  });

  it('retries network failures and reports them', async () => {
    const { client, calls } = scriptedClient([new Error('getaddrinfo ENOTFOUND en.wikipedia.org')]);
    const error = await captureError(client.getJson(URL, {}));
    expect(error.kind).toBe('network');
    expect(error.message).toContain('ENOTFOUND');
    expect(calls()).toBe(3);
  });

  it('does not retry other 4xx responses', async () => {
    const { client, calls } = scriptedClient([{ status: 404, data: {} }]);
    expect(await captureError(client.getJson(URL, {}))).toMatchObject({ kind: 'http', status: 404 });
    expect(calls()).toBe(1);
  });

  it('reports MediaWiki error bodies delivered with HTTP 200', async () => {
    const { client } = scriptedClient([{ status: 200, data: { error: { code: 'badvalue', info: 'Unrecognized value' } } }]);
    const error = await captureError(client.getJson(URL, {}));
    expect(error).toMatchObject({ kind: 'api_error' });
    expect(error.message).toContain('badvalue: Unrecognized value');
  });

  it('rejects non-JSON bodies', async () => {
    const { client } = scriptedClient([{ status: 200, data: '<!DOCTYPE html><html>' }]);
    expect(await captureError(client.getJson(URL, {}))).toMatchObject({ kind: 'unexpected_response' });
  });
});
