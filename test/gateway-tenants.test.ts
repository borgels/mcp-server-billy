import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_KEY_HEADER, BillyClient } from '../src/billy/client.js';
import { createBillyGateway, billyGatewayTools, billyToolCatalog, type GatewayJsonObject } from '../src/gateway.js';
import { BILLY_TOOLS, pseudonym } from '../src/tools/billy.js';
import { BASE, auditLines, connect, stubFetch, texts } from './helpers.js';

const originalEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'billy-mcp-'));
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('BILLY_')) {
      delete process.env[name];
    }
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(dir, { recursive: true, force: true });
});

/** Placeholder credentials, built at runtime: long enough to be redacted by value. */
const fakeKey = (label: string) => `${label}-${'x'.repeat(12)}`;
// Keys with no piece of six characters in common: the redactor also removes any such piece of its own key.
const KEY_A = 'alpha-0123456789-kq';
const KEY_B = 'bravo-zyxwvutsrq-MP';
const ENV_KEY = 'envkey-ABCDEFGHIJ-77';

/** Upstream that answers every request with an error body echoing `echo`. */
function echoingFetch(echo: string) {
  return vi.fn(
    async () =>
      new Response(`upstream rejected credentials ${echo}`, { status: 400, headers: { 'content-type': 'text/plain' } }),
  ) as unknown as typeof fetch;
}

function headersOf(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

describe('explicit gateway credentials', () => {
  it('requires accessToken and ignores the environment', () => {
    process.env.BILLY_ACCESS_TOKEN = ENV_KEY;
    process.env.BILLY_BASE_URL = BASE;

    expect(() => createBillyGateway({ baseUrl: BASE } as never)).toThrow(/requires options\.accessToken/);
    expect(() => createBillyGateway({ accessToken: '  ', baseUrl: BASE })).toThrow(/requires options\.accessToken/);
    expect(() => createBillyGateway(undefined as never)).toThrow(/requires options\.accessToken/);
  });

  it('never reads credential variables from process.env, even when they are set', async () => {
    const reads = new Set<string>();
    const env = { ...process.env, BILLY_ACCESS_TOKEN: ENV_KEY, BILLY_BASE_URL: BASE };
    process.env = new Proxy(env, {
      get(target, property, receiver) {
        if (typeof property === 'string') {
          reads.add(property);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => createBillyGateway({ baseUrl: BASE } as never)).toThrow(/requires options\.accessToken/);

    const fetchImpl = stubFetch({ [`GET ${BASE}/contacts/i1`]: { body: { contact: { id: 'i1' } } } });
    const gw = createBillyGateway({ accessToken: KEY_A, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await gw.callTool('get_contact', { contactId: 'i1' });
    expect(result.isError).toBeUndefined();
    expect(headersOf(fetchImpl.mock.calls[0]?.[1])[API_KEY_HEADER]).toBe(KEY_A);

    expect(reads.has('BILLY_ACCESS_TOKEN')).toBe(false);
    expect(reads.has('BILLY_BASE_URL')).toBe(false);
  });

  it('still reads credentials from the environment in the standalone client', async () => {
    process.env.BILLY_ACCESS_TOKEN = ENV_KEY;
    process.env.BILLY_BASE_URL = BASE;
    const fetchImpl = vi.fn(async () => Response.json({})) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    await new BillyClient({ fetchImpl }).get('/contacts/1');
    expect(headersOf(fetchImpl.mock.calls[0]?.[1] as RequestInit)[API_KEY_HEADER]).toBe(ENV_KEY);
  });
});

describe('per-instance redaction', () => {
  it('redacts each instance’s own key in its tool results', async () => {
    const a = createBillyGateway({ accessToken: KEY_A, baseUrl: BASE, fetchImpl: echoingFetch(KEY_A) });
    const b = createBillyGateway({ accessToken: KEY_B, baseUrl: BASE, fetchImpl: echoingFetch(KEY_B) });

    const resultA = texts(await a.callTool('get_contact', { contactId: 'i1' })).join(' ');
    const resultB = texts(await b.callTool('get_contact', { contactId: 'i1' })).join(' ');
    // The echoing error body is never read into the result; the key is not there in any form.
    expect(resultA).not.toContain(KEY_A);
    expect(resultB).not.toContain(KEY_B);
  });

  it('keeps redactors separate: an instance holds only its own secrets', () => {
    const a = new BillyClient({ accessToken: KEY_A, baseUrl: BASE, credentialEnv: {} });
    const b = new BillyClient({ accessToken: KEY_B, baseUrl: BASE, credentialEnv: {} });
    expect(a.redactor.hasSecret(KEY_A)).toBe(true);
    expect(a.redactor.hasSecret(KEY_B)).toBe(false);
    expect(b.redactor.hasSecret(KEY_B)).toBe(true);
    expect(b.redactor.hasSecret(KEY_A)).toBe(false);
    // B neither knows nor needs A's key: its text is only redacted for its own.
    expect(b.redactor.redact(`a=${KEY_A} b ${KEY_B}`)).toBe(`a=${KEY_A} b ‹redacted›`);
  });

  it('does not accumulate keys of earlier instances', () => {
    for (let index = 0; index < 200; index += 1) {
      createBillyGateway({ accessToken: `short-lived-key-${index}`, baseUrl: BASE });
    }
    const fresh = new BillyClient({ accessToken: KEY_A, baseUrl: BASE, credentialEnv: {} });
    expect(fresh.redactor.redact('short-lived-key-7')).toBe('short-lived-key-7');
  });

  it('redacts audit records with the key of the instance that ran the call', async () => {
    process.env.BILLY_AUDIT_LOG = join(dir, 'audit.jsonl');
    const failing = (key: string) =>
      vi.fn(async () => {
        throw new TypeError(`connection refused while sending ${key}`);
      }) as unknown as typeof fetch;
    const a = createBillyGateway({ accessToken: KEY_A, baseUrl: BASE, fetchImpl: failing(KEY_A), maxAttempts: 1 });
    const b = createBillyGateway({ accessToken: KEY_B, baseUrl: BASE, fetchImpl: failing(KEY_B), maxAttempts: 1 });
    await a.callTool('get_contact', { contactId: 'i1' }, { requestId: 'a' });
    await b.callTool('get_contact', { contactId: 'i1' }, { requestId: 'b' });

    const errors = auditLines(process.env.BILLY_AUDIT_LOG).filter(line => line.action === 'error');
    expect(errors.map(line => line.requestId)).toEqual([pseudonym('a'), pseudonym('b')]);
    const log = JSON.stringify(errors);
    expect(log).not.toContain(KEY_A);
    expect(log).not.toContain(KEY_B);
  });

  it('redacts with the server client’s key on the MCP path', async () => {
    const tool = BILLY_TOOLS.find(t => t.name === 'billy_get_contact')!;
    const original = tool.handler;
    tool.handler = async () => {
      throw new Error('failed with test-api-key');
    };
    try {
      const { mcpClient } = await connect();
      const result = await mcpClient.callTool({ name: 'billy_get_contact', arguments: { contactId: 'i1' } });
      expect(texts(result).join(' ')).not.toContain('test-api-key');
    } finally {
      tool.handler = original;
    }
  });

  it('lets a dropped instance and its key be garbage collected', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    let gateway: ReturnType<typeof createBillyGateway> | undefined = createBillyGateway({
      accessToken: fakeKey('collectable'),
      baseUrl: BASE,
    });
    const ref = new WeakRef(gateway);
    gateway = undefined;
    for (let attempt = 0; attempt < 10 && ref.deref(); attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
      gc();
    }
    expect(ref.deref()).toBeUndefined();
  });
});

/** Sample input per tool, used to check each tool's declared upstream requests. */
const SAMPLE_INPUTS: Record<string, GatewayJsonObject> = {
  check_connection: {},
  get_organization: {},
  list_contacts: { kind: 'customer', query: 'a' },
  get_contact: { contactId: 'c1' },
  list_products: {},
  get_product: { productId: 'p1' },
  list_invoices: { state: 'approved', isPaid: false },
  get_invoice: { invoiceId: 'i1' },
  list_bills: { isPaid: false },
  get_bill: { billId: 'b1' },
  list_accounts: { bankAccountsOnly: true },
  list_postings: { accountId: 'a1' },
  list_daybooks: {},
  list_daybook_transactions: { state: 'draft' },
  list_tax_rates: {},
  create_contact: { name: 'New contact', countryId: 'DK', isCustomer: true, paymentTermsDays: 8 },
  update_contact: { contactId: 'c1', phone: '12345678' },
  create_product: { name: 'New product', prices: [{ currencyId: 'DKK', unitPrice: 100 }] },
  update_product: { productId: 'p1', name: 'Renamed' },
  create_draft_invoice: { contactId: 'c1', entryDate: '2026-11-19', currencyId: 'DKK', paymentTermsDays: 8, lines: [{ productId: 'p1', unitPrice: 100 }] },
  approve_invoice: { invoiceId: 'i1' },
  register_payment: { billId: 'b1', cashAccountId: 'a1', amount: 100, entryDate: '2026-11-19' },
  create_daybook_transaction: { entryDate: '2026-11-19', lines: [{ accountId: 'a1', amount: 10, side: 'debit' }] },
  send_invoice: { invoiceId: 'i2', contactPersonId: 'cp1', emailSubject: 'Invoice', emailBody: 'Here is the invoice.' },
  delete_draft_invoice: { invoiceId: 'i1' },
  create_draft_bill: {
    contactId: 'c1',
    entryDate: '2026-11-19',
    currencyId: 'DKK',
    lines: [{ accountId: 'a1', taxRateId: 't1', description: 'Paper', amount: 100 }],
  },
  attach_bill_file: { billId: 'b2', fileName: 'receipt.pdf', contentBase64: Buffer.from('%PDF-1.4 test').toString('base64') },
  approve_bill: { billId: 'b2' },
  delete_draft_bill: { billId: 'b2' },
};

/** Answers that let every tool run to its end: a draft invoice, an approved unpaid bill and a payment account. */
async function catalogFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const path = new URL(String(input)).pathname;
  if (init?.method === 'DELETE') return Response.json({ meta: { deletedRecords: { invoices: ['i1'], bills: ['b2'] } } });
  if (path.endsWith('/emails')) return Response.json({});
  if (path.endsWith('/invoices/i2')) return Response.json({ invoice: { id: 'i2', state: 'approved', contactId: 'c1' } });
  if (path.includes('/invoices/')) return Response.json({ invoice: { id: 'i1', state: 'draft' }, invoices: [{ id: 'i1' }] });
  if (path.includes('/contactPersons/')) return Response.json({ contactPerson: { id: 'cp1', contactId: 'c1', email: 'buyer@example.test' } });
  if (path.endsWith('/bills/b2')) return Response.json({ bill: { id: 'b2', state: 'draft' }, bills: [{ id: 'b2' }] });
  if (path.includes('/bills/')) return Response.json({ bill: { id: 'b1', organizationId: 'x1', type: 'bill', state: 'approved', isPaid: false, balance: 100, currencyId: 'DKK' } });
  if (path.includes('/accounts/')) return Response.json({ account: { id: 'a1', isPaymentEnabled: true, currencyId: 'DKK' } });
  // Every list and record root key the tools read, and one changed record for every write.
  const roots = ['organization', 'contact', 'product'];
  const lists = ['contacts', 'products', 'invoices', 'bills', 'accounts', 'postings', 'daybooks', 'daybookTransactions', 'taxRates', 'bankPayments', 'files', 'attachments'];
  // A record asked for by id answers with that id; the company and lists with x1.
  const asked = /\/(?:contacts|products)\/([^/]+)$/.exec(path)?.[1];
  return Response.json({
    ...Object.fromEntries(roots.map(key => [key, { id: asked && key !== 'organization' ? decodeURIComponent(asked) : 'x1' }])),
    ...Object.fromEntries(lists.map(key => [key, [{ id: asked ? decodeURIComponent(asked) : 'x1' }]])),
  });
}

describe('tool catalog', () => {
  it('lists every registered tool, matching the gateway definitions', async () => {
    expect(billyToolCatalog.map(entry => entry.name)).toEqual(billyGatewayTools.map(tool => tool.name));
    for (const entry of billyToolCatalog) {
      const { upstream, broad, requiresConfirmation, change, ...definition } = entry;
      expect(typeof requiresConfirmation).toBe('boolean');
      expect(change === undefined).toBe(entry.riskLevel === 'read');
      if (requiresConfirmation) expect(entry.riskLevel).toBe('write');
      expect(typeof broad).toBe('boolean');
      if (broad) expect(entry.riskLevel).toBe('read');
      expect(definition).toEqual(billyGatewayTools.find(tool => tool.name === entry.name));
      expect(upstream.length).toBeGreaterThan(0);
      for (const operation of upstream) {
        expect(operation.access === 'read' ? operation.method === 'GET' : true).toBe(true);
        if (entry.riskLevel === 'read') {
          expect(operation.access).toBe('read');
        }
      }
    }

    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(
      billyToolCatalog.map(entry => `billy_${entry.name}`).sort(),
    );
    for (const tool of tools) {
      const entry = billyToolCatalog.find(e => `billy_${e.name}` === tool.name)!;
      expect(entry.title).toBe(tool.title);
      expect(entry.description).toBe(tool.description);
      expect(Object.keys(entry.inputSchema.properties as object).sort()).toEqual(
        Object.keys(tool.inputSchema.properties ?? {}).sort(),
      );
    }
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(billyToolCatalog)).toBe(true);
    const visit = (value: unknown) => {
      if (typeof value === 'object' && value !== null) {
        expect(Object.isFrozen(value)).toBe(true);
        Object.values(value).forEach(visit);
      }
    };
    visit(billyToolCatalog);
    expect(() => {
      (billyToolCatalog[0] as { name: string }).name = 'changed';
    }).toThrow(TypeError);
  });

  it('declares exactly the upstream requests each tool makes', async () => {
    process.env.BILLY_ENABLE_WRITES = 'true';
    for (const entry of billyToolCatalog) {
      const input = SAMPLE_INPUTS[entry.name];
      expect(input, `sample input for ${entry.name}`).toBeDefined();
      const fetchImpl = vi.fn(catalogFetch);
      const gw = createBillyGateway({ accessToken: KEY_A, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
      const result = await gw.callTool(entry.name, input!);
      expect(result.isError, texts(result).join(' ')).toBeUndefined();

      const declared = entry.upstream.map(op => ({
        method: op.method,
        path: op.path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(String(input![name] ?? ''))),
      }));
      const made = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>).map(([url, init]) => ({
        method: init.method,
        path: new URL(url).pathname.slice(new URL(BASE).pathname.length),
      }));
      for (const request of made) {
        expect(declared, `${entry.name} made ${request.method} ${request.path}`).toContainEqual(request);
      }
    }
  });
});
