import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_KEY_HEADER, BillyClient } from '../src/billy/client.js';
import { BillyHttpError, parseRetryAfterMs, redactSecrets, SecretRedactor } from '../src/errors.js';
import { USER_AGENT } from '../src/version.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

const BASE = 'https://api.billysbilling.com/v2';

type Handler = (url: string, init?: RequestInit) => Response | unknown | Promise<Response | unknown>;

function makeFetch(handler: Handler) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const result = await handler(String(input), init);
    if (result instanceof Response) {
      return result;
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function headersOf(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

const noSleep = vi.fn(async (_ms: number) => undefined);

function makeClient(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof BillyClient>[0]> = {}) {
  return new BillyClient({ accessToken: 'k', baseUrl: BASE, fetchImpl, sleep: noSleep, ...extra });
}

describe('BillyClient', () => {
  it('sends the access token and User-Agent headers and never follows redirects', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const fetchImpl = makeFetch((url, init) => {
      seenUrl = url;
      seenInit = init;
      return { id: '1' };
    });

    await new BillyClient({ accessToken: 'secret-key', baseUrl: `${BASE}/`, fetchImpl }).get('/contacts/1', { q: 'x' });

    expect(seenUrl).toBe(`${BASE}/contacts/1?q=x`);
    expect(headersOf(seenInit)[API_KEY_HEADER]).toBe('secret-key');
    expect(headersOf(seenInit)['User-Agent']).toBe(USER_AGENT);
    expect(seenInit?.redirect).toBe('manual');
  });

  it('throws before sending anything when the access token is missing, and uses the documented endpoint by default', async () => {
    const fetchImpl = makeFetch(() => ({}));
    delete process.env.BILLY_ACCESS_TOKEN;
    delete process.env.BILLY_BASE_URL;

    await expect(new BillyClient({ baseUrl: BASE, fetchImpl }).get('/x')).rejects.toThrow('BILLY_ACCESS_TOKEN');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(new BillyClient({ accessToken: 'k', fetchImpl }).baseUrl).toBe('https://api.billysbilling.com/v2');
  });

  it('pins the token to the Billy hosts', () => {
    delete process.env.BILLY_ALLOW_CUSTOM_BASE_URL;
    expect(() => new BillyClient({ accessToken: 'k', baseUrl: 'https://api.billy.dk/v2' })).not.toThrow();
    expect(() => new BillyClient({ accessToken: 'k', baseUrl: 'https://api.billysbilling.com.evil.test/v2' })).toThrow(/must be on/);
    expect(() => new BillyClient({ accessToken: 'k', baseUrl: 'https://evil.test/v2' })).toThrow(/must be on/);
  });

  it('sends only the writes on its fixed list, and never a DELETE', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({ contacts: [] }, 200));
    const client = makeClient(fetchImpl);
    await expect(client.post('/organization', {})).rejects.toThrow('Refused');
    await expect(client.put('/accounts/a1', {})).rejects.toThrow('Refused');
    await expect(client.put('/organization', {})).rejects.toThrow('Refused');
    await expect(client.post('/invoices/i1/emails', {})).rejects.toThrow('Refused');
    await expect(client.post('/invoiceDeliveries', {})).rejects.toThrow('Refused');
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(client.post('/contacts', {})).resolves.toEqual({ contacts: [] });
    await expect(client.put('/contacts/c1', {})).resolves.toEqual({ contacts: [] });
    expect('delete' in client).toBe(false);
  });

  it('refuses unsafe base URLs without echoing credentials', () => {
    expect(() => new BillyClient({ accessToken: 'k', baseUrl: 'http://api.vendor.test' })).toThrow('https://');
    expect(() => new BillyClient({ accessToken: 'k', baseUrl: 'not a url' })).toThrow('not a valid URL');
    expect(() => new BillyClient({ accessToken: 'k', baseUrl: 'http://127.0.0.1:8080/api' })).not.toThrow();
    expect(() => new BillyClient({ accessToken: 'k', baseUrl: 'http://localhost:8080/api' })).not.toThrow();
    expect(() => new BillyClient({ accessToken: 'k', baseUrl: 'http://[::1]:8080/api' })).not.toThrow();

    for (const baseUrl of [
      'https://user:hunter2@api.vendor.test/v1',
      'https://api.billysbilling.com/v2?x=1',
      'https://api.billysbilling.com/v2#frag',
    ]) {
      let message = '';
      try {
        new BillyClient({ accessToken: 'k', baseUrl });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('credentials, a query string or a fragment');
      expect(message).not.toContain('hunter2');
    }
  });

  it('validates numeric environment variables and options instead of producing NaN', () => {
    process.env.BILLY_TIMEOUT_MS = '30s';
    expect(() => new BillyClient({ accessToken: 'k' })).toThrow('BILLY_TIMEOUT_MS');
    process.env.BILLY_TIMEOUT_MS = '3000000000';
    expect(() => new BillyClient({ accessToken: 'k' })).toThrow('BILLY_TIMEOUT_MS');
    delete process.env.BILLY_TIMEOUT_MS;
    process.env.BILLY_MAX_CONCURRENCY = 'many';
    expect(() => new BillyClient({ accessToken: 'k' })).toThrow('BILLY_MAX_CONCURRENCY');
    delete process.env.BILLY_MAX_CONCURRENCY;
    process.env.BILLY_MAX_RESPONSE_BYTES = '10MB';
    expect(() => new BillyClient({ accessToken: 'k' })).toThrow('BILLY_MAX_RESPONSE_BYTES');
    delete process.env.BILLY_MAX_RESPONSE_BYTES;
    process.env.BILLY_ALLOW_CUSTOM_BASE_URL = 'perhaps';
    expect(() => new BillyClient({ accessToken: 'k', baseUrl: BASE })).toThrow('BILLY_ALLOW_CUSTOM_BASE_URL');
    delete process.env.BILLY_ALLOW_CUSTOM_BASE_URL;

    expect(() => new BillyClient({ accessToken: 'k', maxConcurrency: 0 })).toThrow('maxConcurrency');
    expect(() => new BillyClient({ accessToken: 'k', maxConcurrency: Number.NaN })).toThrow('maxConcurrency');
    expect(() => new BillyClient({ accessToken: 'k', timeoutMs: 2 ** 31 })).toThrow('timeoutMs');
    expect(() => new BillyClient({ accessToken: 'k', maxAttempts: 0 })).toThrow('maxAttempts');
  });
});

describe('error handling', () => {
  it('gives the status and our own hint, never the vendor body or code', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({ code: 'invalid_key', message: 'Unrecognized key' }, 401));
    const error = await makeClient(fetchImpl).get('/x').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BillyHttpError);
    expect((error as BillyHttpError).status).toBe(401);
    expect((error as Error).message).toContain('HTTP 401');
    expect((error as Error).message).toContain('Settings -> Access tokens');
    expect((error as Error).message).not.toContain('Unrecognized key');
    expect((error as Error).message).not.toContain('invalid_key');
  });

  it('never puts an error body in the error', async () => {
    const html = `<html>${'x'.repeat(5000)}</html>`;
    const fetchImpl = makeFetch(() => new Response(html, { status: 502, headers: { 'content-type': 'text/html' } }));
    const error = (await makeClient(fetchImpl, { maxAttempts: 1 })
      .get('/x')
      .catch((e: unknown) => e)) as BillyHttpError;
    expect(error.message).toBe('Billy API request failed with HTTP 502');
  });

  it('reads at most 64 KB of an error body', async () => {
    let pulled = 0;
    const fetchImpl = makeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(new TextEncoder().encode('e'.repeat(16 * 1024)));
            },
          }),
          { status: 500, headers: { 'content-type': 'text/html' } },
        ),
    );
    const error = (await makeClient(fetchImpl)
      .get('/x')
      .catch((e: unknown) => e)) as BillyHttpError;
    expect(error).toBeInstanceOf(BillyHttpError);
    expect(pulled).toBeLessThan(10);
    expect(error.message.length).toBeLessThan(700);
  });

  it('redacts the configured access token wherever it appears, before truncating', async () => {
    const accessToken = 'live-key-0123456789abcdef'; // gitleaks:allow (a test value, not a key)
    const respond = (body: string, type = 'text/plain') =>
      new BillyClient({
        accessToken,
        baseUrl: BASE,
        fetchImpl: makeFetch(() => new Response(body, { status: 400, headers: { 'content-type': type } })),
      });

    const echoed = (await respond(`proxy error: ${accessToken} and ${encodeURIComponent(accessToken)}`)
      .get('/x')
      .catch((e: unknown) => e)) as BillyHttpError;
    expect(echoed.message).not.toContain(accessToken);
    expect(echoed.message).not.toContain('proxy error');

    const boundary = (await respond(`${'x'.repeat(490)}${accessToken}`)
      .get('/x')
      .catch((e: unknown) => e)) as BillyHttpError;
    expect(boundary.message).not.toContain(accessToken.slice(0, 6));

    const nested = (await respond(JSON.stringify({ message: 'bad', nested: { echo: accessToken } }), 'application/json')
      .get('/x')
      .catch((e: unknown) => e)) as BillyHttpError;
    expect(JSON.stringify(nested)).not.toContain(accessToken);

    expect(redactSecrets('X-API-KEY: abc123')).not.toContain('abc123');
    expect(redactSecrets('Authorization: Bearer abc123')).not.toContain('abc123');
    expect(redactSecrets('BILLY_ACCESS_TOKEN=abc123')).not.toContain('abc123');
  });

  it('redacts the configured key header by name', () => {
    const redactor = new SecretRedactor().addHeader('X-Vendor-Token').addHeader(API_KEY_HEADER);
    const redactSecrets = (text: string) => redactor.redact(text);
    expect(redactSecrets('sent x-vendor-token: abc123, ok')).toBe('sent x-vendor-token: ‹redacted›, ok');
    expect(redactSecrets(`${API_KEY_HEADER}: abc123`)).not.toContain('abc123');
    for (const text of [
      '{"X-Vendor-Token":"abc123"}',
      "{'x-vendor-token': 'abc123'}",
      'x-vendor-token=abc123',
      `{"${API_KEY_HEADER}": "abc123"}`,
      '{"authorization":"Bearer abc123"}',
      'authorization=abc123',
      'x-api-key=abc123:def',
      'X-Vendor-Token=abc123=def',
      'authorization=abc123:pass',
      'Authorization: Basic abc123',
      'Authorization: Token abc123',
      '"Authorization": "Digest abc123"',
    ]) {
      expect(redactSecrets(text), text).not.toContain('abc123');
    }
  });

  it('keeps query strings out of error URLs', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}, 400));
    const error = (await makeClient(fetchImpl)
      .get('/contacts', { cursor: 'secret-cursor' })
      .catch((e: unknown) => e)) as BillyHttpError;
    expect(error.url).toBe(`${BASE}/contacts`);
    expect(error.message).not.toContain('secret-cursor');
  });

  it('parses Retry-After as seconds or an HTTP date', async () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfterMs('5', now)).toBe(5000);
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:10 GMT', now)).toBe(10_000);
    for (const value of ['0', 'Wed, 31 Dec 2025 23:59:00 GMT', 'soon', '1.5', '-1', '+5', '']) {
      expect(parseRetryAfterMs(value, now)).toBeUndefined();
    }
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
  });

  it('names only the system error code of a network error, never its message', async () => {
    const fetchImpl = makeFetch(() => {
      throw new TypeError('fetch failed somewhere odd', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.vendor.test'), { code: 'ENOTFOUND' }),
      });
    });
    const message = await makeClient(fetchImpl, { maxAttempts: 1 })
      .get('/x')
      .catch((e: Error) => e.message);
    expect(message).toMatch(/Network error calling the Billy API \(GET\) \(ENOTFOUND\)\./);
    expect(message).not.toMatch(/odd|getaddrinfo/);
  });

  it('reports timeouts clearly', async () => {
    const fetchImpl = makeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    await expect(makeClient(fetchImpl).get('/items?cursor=c')).rejects.toThrow(
      /timed out after \d+ ms \(GET\)/,
    );
  });

  it('caps successful response bodies', async () => {
    const big = makeFetch(
      () => new Response('x'.repeat(100), { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    await expect(makeClient(big, { maxResponseBytes: 10 }).get('/x')).rejects.toThrow('exceeds the 10 byte limit');
    await expect(makeClient(big, { maxResponseBytes: 1000 }).get('/x')).resolves.toBe('x'.repeat(100));
  });
});

describe('redirects', () => {
  it('never follows redirects and names the target without its query', async () => {
    const fetchImpl = makeFetch(
      () => new Response(null, { status: 302, headers: { location: 'https://other.vendor.test/v1/items?t=1' } }),
    );
    const message = await makeClient(fetchImpl)
      .get('/contacts')
      .catch((e: Error) => e.message);
    expect(message).toContain('redirect (HTTP 302) for GET');
    expect(message).toContain('BILLY_BASE_URL');
    // The Location is the vendor's text: never quoted.
    expect(message).not.toContain('other.vendor.test');
    await expect(makeClient(fetchImpl).post('/contacts', {})).rejects.toThrow(/redirect/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes('other.vendor.test'))).toBe(true);
  });
});

describe('retries and concurrency', () => {
  it('retries idempotent GETs on 429/502/503/504 honouring Retry-After', async () => {
    const statuses = [503, 429];
    const fetchImpl = makeFetch(() => {
      const status = statuses.shift();
      if (status === 429) {
        return jsonResponse({}, 429, { 'retry-after': '2' });
      }
      if (status) {
        return jsonResponse({}, status);
      }
      return { ok: true };
    });
    const sleep = vi.fn(async (_ms: number) => undefined);
    const client = makeClient(fetchImpl, { sleep, retryBaseDelayMs: 10 });

    await expect(client.get('/x')).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[1]).toEqual([2000]);
  });

  it('does not wait for a Retry-After beyond the retry budget and surfaces it', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}, 503, { 'retry-after': '3600' }));
    const sleep = vi.fn(async (_ms: number) => undefined);
    const error = (await makeClient(fetchImpl, { sleep })
      .get('/x')
      .catch((e: unknown) => e)) as BillyHttpError;

    expect(error).toBeInstanceOf(BillyHttpError);
    expect(error.message).toContain('retry-after=3600s');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries GETs on transient network errors only', async () => {
    let calls = 0;
    const fetchImpl = makeFetch(() => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
      }
      return { ok: true };
    });
    await expect(makeClient(fetchImpl).get('/x')).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);

    const permanent = makeFetch(() => {
      throw new TypeError('Headers.append: invalid header value');
    });
    await expect(makeClient(permanent).get('/x')).rejects.toThrow('Network error');
    expect(permanent).toHaveBeenCalledTimes(1);
  });

  it('never retries POST or PUT', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}, 503));
    const client = makeClient(fetchImpl);
    await expect(client.post('/contacts', {})).rejects.toBeInstanceOf(BillyHttpError);
    await expect(client.put('/contacts/c1', {})).rejects.toBeInstanceOf(BillyHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const failing = makeFetch(() => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    });
    await expect(makeClient(failing).post('/contacts', {})).rejects.toThrow('Network error');
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('releases the concurrency slot after failures', async () => {
    let calls = 0;
    const fetchImpl = makeFetch(() => {
      calls += 1;
      if (calls === 1) {
        throw new DOMException('timeout', 'TimeoutError');
      }
      if (calls === 2) {
        return jsonResponse({}, 500);
      }
      return { ok: true };
    });
    const client = makeClient(fetchImpl, { maxConcurrency: 1 });
    await expect(client.get('/x')).rejects.toThrow('timed out');
    await expect(client.get('/x')).rejects.toBeInstanceOf(BillyHttpError);
    await expect(client.get('/x')).resolves.toEqual({ ok: true });
  });

  it('limits concurrent requests per client', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = makeFetch(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true };
    });
    const client = makeClient(fetchImpl, { maxConcurrency: 2 });

    await Promise.all(Array.from({ length: 8 }, () => client.get('/x')));
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(peak).toBe(2);
  });
});

describe('against a local upstream (real sockets)', () => {
  let upstream: Server | undefined;

  afterEach(async () => {
    await new Promise<void>(resolve => (upstream ? upstream.close(() => resolve()) : resolve()));
    upstream = undefined;
  });

  async function startUpstream(handler: Parameters<typeof createHttpServer>[1]): Promise<string> {
    upstream = createHttpServer(handler);
    await new Promise<void>(resolve => upstream?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  }

  it('sends the key, refuses a redirect and does not contact the redirect target', async () => {
    const seen: Array<{ url?: string; key?: string }> = [];
    const base = await startUpstream((req, res) => {
      seen.push({ url: req.url, key: req.headers[API_KEY_HEADER.toLowerCase()] as string | undefined });
      if (req.url === '/v1/contacts/1') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"1"}');
        return;
      }
      res.writeHead(302, { location: `${base}/contacts/1` }).end();
    });
    const client = new BillyClient({ accessToken: 'local-key-123456', baseUrl: base });

    await expect(client.get('/contacts/1')).resolves.toEqual({ id: '1' });
    await expect(client.get('/moved')).rejects.toThrow('redirects are not followed');
    expect(seen).toEqual([
      { url: '/v1/contacts/1', key: 'local-key-123456' },
      { url: '/v1/moved', key: 'local-key-123456' },
    ]);
  });

  it('times out a stalled upstream', async () => {
    const base = await startUpstream(() => {
      // never answers
    });
    const client = new BillyClient({ accessToken: 'k', baseUrl: base, timeoutMs: 100, maxAttempts: 1 });
    await expect(client.get('/slow')).rejects.toThrow(/timed out after 100 ms/);
    upstream?.closeAllConnections();
  });
});
