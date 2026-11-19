// The rest of the threat model (README, "Threat model"), through callTool: a key that is a number and pieces of it in
// numbers, an error while reading a successful body, failures reported inside a successful body, and a result too
// deep to serialise naively. Every result must still be valid JSON.
import { describe, expect, it, vi } from 'vitest';
import { createBillyGateway } from '../src/gateway.js';
import { BASE } from './helpers.js';

const KEY = `tenant"a\\kEy-${'Q7'.repeat(10)}-ZZtop-0123456789`;
const DEEP = 20_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const failingBody = (message: string) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
        controller.error(new Error(message));
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

function stub(key: string): typeof fetch {
  return async input => {
    const path = (String(input).split('?')[0] ?? '').slice(BASE.length);
    switch (path) {
      case '/contacts/numbers':
        return json({ contact: { name: { echo: Number(key), nested: { n: [Number(key.slice(1, 7)), Number(`${key}9`)] }, ok: true, count: 3 } } });
      case '/contacts/body-fails':
        // The vendor's text and a piece of the key shorter than six characters.
        return failingBody(`Vendor diagnostic ${key.slice(0, 5)}`);
      case '/contacts/nested':
        return json({
          contact: {
            name: {
              metadata: { status: 401, error: `Vendor diagnostic ${key}` },
              failures: [{ status: 403, error: 'Vendor detail' }, { error: 'Vendor text' }],
            },
          },
        });
      case '/contacts/deep':
        return new Response(`{"contact":{"name":${'['.repeat(DEEP)}1${']'.repeat(DEEP)}}}`, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      default:
        return json({ message: 'no stub' }, 404);
    }
  };
}

describe('the threat model, through callTool', () => {
  it('redacts a numeric key and its pieces in numbers, and the result stays valid JSON', async () => {
    const key = '1234567890123456';
    const records: unknown[] = [];
    const gw = createBillyGateway({ accessToken: key, baseUrl: BASE, fetchImpl: stub(key), maxAttempts: 1, policy: { audit: r => void records.push(r) } });
    const result = await gw.callTool('get_contact', { contactId: 'numbers' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      name: { echo: '‹redacted›', nested: { n: ['‹redacted›', '‹redacted›'] }, ok: true, count: 3 },
    });
    const serialised = JSON.stringify(result);
    expect(JSON.parse(serialised)).toEqual(result);
    expect(serialised).not.toMatch(/234567|12345678/);
    expect(JSON.stringify(records)).not.toMatch(/234567|12345678/);
  });

  it('turns an error while reading a successful body into a fixed text, for the host and the audit', async () => {
    const records: unknown[] = [];
    const gw = createBillyGateway({ accessToken: KEY, baseUrl: BASE, fetchImpl: stub(KEY), maxAttempts: 1, policy: { audit: r => void records.push(r) } });
    const result = await gw.callTool('get_contact', { contactId: 'body-fails' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('The Billy API response could not be read.');
    for (const value of [result, records]) {
      expect(JSON.stringify(value)).not.toContain('Vendor');
      expect(JSON.stringify(value)).not.toContain(JSON.stringify(KEY.slice(0, 5)).slice(1, -1));
    }
  });

  it('reduces failures reported inside a successful body to status-only text', async () => {
    const gw = createBillyGateway({ accessToken: KEY, baseUrl: BASE, fetchImpl: stub(KEY), maxAttempts: 1 });
    const result = await gw.callTool('get_contact', { contactId: 'nested' });
    expect(result.structuredContent).toEqual({
      name: {
        metadata: { status: 401, error: 'Billy API request failed with HTTP 401' },
        failures: [{ status: 403, message: 'Billy API request failed with HTTP 403' }, { message: 'Billy API request failed.' }],
      },
    });
    expect(JSON.stringify(result)).not.toContain('Vendor');
  });

  it('answers a very deep result without exhausting the stack', async () => {
    const gw = createBillyGateway({ accessToken: KEY, baseUrl: BASE, fetchImpl: stub(KEY), maxAttempts: 1, maxResponseBytes: 1_000_000 });
    const result = await gw.callTool('get_contact', { contactId: 'deep' });
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result)).toContain('[nested too deep]');
  });
});

describe('round 5 of the threat model, through callTool', () => {
  function pieces(value: string): string[] {
    const out: string[] = [];
    for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
    return out;
  }

  it('refuses a key that overlaps the redaction marker, and redacts one that looks like the old marker', async () => {
    for (const accessToken of ['‹redacted›-0123456789', 'my-redacted-value', 'xx-dacted›-yy']) {
      expect(() => createBillyGateway({ accessToken, baseUrl: BASE }), accessToken).toThrow(/key was refused/);
    }
    const LOOKALIKE = '[REDACTED]-0123456789';
    const records: unknown[] = [];
    const gw = createBillyGateway({
      accessToken: LOOKALIKE,
      baseUrl: BASE,
      maxAttempts: 1,
      fetchImpl: async () => json({ echo: LOOKALIKE, [LOOKALIKE]: 1 }),
      policy: { audit: r => void records.push(r) },
    });
    const result = await gw.callTool('get_contact', { contactId: LOOKALIKE }, { caller: LOOKALIKE });
    const text = JSON.stringify([result, records]);
    for (const piece of pieces(LOOKALIKE)) expect(text, piece).not.toContain(piece);
  });

  it('keeps only the status of a failure object, on reads and on create_contact', async () => {
    const body = {
      metadata: { status: 401, error: 'Vendor diagnostic', message: 'Vendor message', code: 'VENDOR_CODE', detail: { more: 'Vendor' } },
      failures: [{ error: 'Vendor text', hint: 'Vendor hint' }],
    };
    const gw = createBillyGateway({
      accessToken: KEY,
      baseUrl: BASE,
      maxAttempts: 1,
      fetchImpl: async (_input, init) =>
        init?.method === 'POST' ? json({ contacts: [{ name: body }] }, 201) : json({ contact: { name: body } }),
      policy: { enableWrites: true },
    });
    for (const result of [await gw.callTool('get_contact', { contactId: 'x' }), await gw.callTool('create_contact', { name: 'n', countryId: 'DK' })]) {
      expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
      expect(result.structuredContent).toEqual({
        name: {
          metadata: { status: 401, error: 'Billy API request failed with HTTP 401' },
          failures: [{ message: 'Billy API request failed.' }],
        },
      });
    }
  });

  it('gives our own text when the body of a failed response cannot be read', async () => {
    const records: unknown[] = [];
    const gw = createBillyGateway({
      accessToken: KEY,
      baseUrl: BASE,
      maxAttempts: 1,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(`Vendor diagnostic ${KEY.slice(0, 5)}`));
            },
          }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        ),
      policy: { audit: r => void records.push(r) },
    });
    const result = await gw.callTool('get_contact', { contactId: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^Billy API request failed with HTTP 500/);
    expect(JSON.stringify([result, records])).not.toContain('Vendor');
  });

  it('redacts an audit sink failure before it reaches stderr', async () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      written.push(String(chunk));
      return true;
    });
    try {
      const gw = createBillyGateway({
        accessToken: KEY,
        baseUrl: BASE,
        maxAttempts: 1,
        fetchImpl: async () => json({ name: 'ok' }),
        policy: {
          audit: () => {
            throw new Error(`sink failed for ${KEY}`);
          },
        },
      });
      const result = await gw.callTool('get_contact', { contactId: 'x' });
      expect(result.isError).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    const text = written.join('');
    expect(text).toContain('audit log write failed');
    for (const piece of pieces(KEY)) expect(text, piece).not.toContain(piece);
  });
});

describe('round 6 of the threat model', () => {
  function pieces(value: string): string[] {
    const out: string[] = [];
    for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
    return out;
  }

  it('refuses keys that collide with our own texts, without repeating them', () => {
    for (const accessToken of ['[nested too deep]-0123456789', 'billy-mcp-0123456789', 'BILLY_BASE_URL-0123456789']) {
      let message = '';
      try {
        createBillyGateway({ accessToken, baseUrl: BASE });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, accessToken).toMatch(/key was refused/);
      for (const piece of pieces(accessToken)) expect(message, piece).not.toContain(piece);
    }
  });

  it('sends a construction error through the redactor, configuration values included', () => {
    const HOSTLIKE = 'qz7hn4vb8lw2jx6pz9';
    let message = '';
    try {
      createBillyGateway({ accessToken: HOSTLIKE, baseUrl: `https://${HOSTLIKE}.vendor.invalid/x?y=${HOSTLIKE}`, policy: {} });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    for (const piece of pieces(HOSTLIKE)) expect(message, piece).not.toContain(piece);
  });

  it('reduces failures without an error field, by status or in a failure context', async () => {
    const gw = createBillyGateway({
      accessToken: KEY,
      baseUrl: BASE,
      maxAttempts: 1,
      fetchImpl: async () =>
        json({
          contact: {
            name: {
              failures: [{ status: 403, message: 'Vendor diagnostic' }],
              metadata: { status: 401, error: null, message: 'Vendor diagnostic' },
              errors: [{ message: 'Vendor diagnostic' }],
              rows: [{ status: 200, message: 'kept' }],
            },
          },
        }),
    });
    const result = await gw.callTool('get_contact', { contactId: 'x' });
    expect(result.structuredContent).toEqual({
      name: {
        failures: [{ status: 403, message: 'Billy API request failed with HTTP 403' }],
        metadata: { status: 401, error: 'Billy API request failed with HTTP 401' },
        errors: [{ message: 'Billy API request failed.' }],
        rows: [{ status: 200, message: 'kept' }],
      },
    });
  });

  it('names a network error code only from the fixed list', async () => {
    const gw = createBillyGateway({
      accessToken: KEY,
      baseUrl: BASE,
      maxAttempts: 1,
      fetchImpl: async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'VENDOR_DIAGNOSTIC' }) });
      },
    });
    const result = await gw.callTool('get_contact', { contactId: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain('VENDOR_DIAGNOSTIC');
  });
});
