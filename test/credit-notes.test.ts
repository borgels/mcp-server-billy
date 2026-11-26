// Credit notes for an approved invoice and changes to a draft invoice (#20), against answers shaped as Billy's API
// documentation shows them (https://www.billy.dk/api: the invoices and invoiceLines resources, "Updating a record").
// Recorded from the documentation, not from a live company: no Billy account was used.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { billyToolCatalog, createBillyGateway, resolveBillyChange, type GatewayJsonObject } from '../src/gateway.js';
import { ALLOWED_WRITES } from '../src/billy/client.js';
import { BASE, makeClient } from './helpers.js';

const TOKEN = 'tttt-gggg-wwww-vvvv-1';
const originalEnv = { ...process.env };

beforeEach(() => {
  for (const name of Object.keys(process.env)) if (name.startsWith('BILLY_')) delete process.env[name];
});
afterEach(() => {
  process.env = { ...originalEnv };
});

type Call = { method: string; path: string; query: URLSearchParams; body: unknown };
type Handler = (call: Call) => unknown;

/** A Billy stand-in: routes by "METHOD /path" (path relative to /v2). An unknown route answers 404. */
function billy(routes: Record<string, Handler | unknown>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.slice(new URL(BASE).pathname.length);
    const call: Call = { method, path, query: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const route = routes[`${method} ${path}`];
    if (route === undefined) return Response.json({ errorMessage: 'not found' }, { status: 404 });
    return Response.json(typeof route === 'function' ? (route as Handler)(call) : route);
  });
  const gw = createBillyGateway({
    accessToken: TOKEN,
    baseUrl: BASE,
    maxAttempts: 1,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    policy: { enableWrites: true },
  });
  return { gw, calls };
}

const call = (gw: ReturnType<typeof billy>['gw'], tool: string, input: GatewayJsonObject) => gw.callTool(tool, input);

/** An approved invoice of two lines, the second with a percentage discount. */
const APPROVED = {
  id: 'i1',
  type: 'invoice',
  state: 'approved',
  sentState: 'sent',
  contactId: 'c1',
  currencyId: 'DKK',
  paymentTermsDays: 8,
  taxMode: 'excl',
  approvedTime: '2026-11-20T10:00:00Z',
  lines: [
    { id: 'l1', productId: 'p1', description: 'Konsulenttimer', quantity: 10, unitPrice: 800, amount: 8000, priority: 1 },
    {
      id: 'l2',
      productId: 'p2',
      description: 'Licens',
      quantity: 1,
      unitPrice: 2000,
      discountMode: 'percent',
      discountValue: 10,
      discountText: 'Rabat',
      priority: 2,
    },
  ],
};

const creditRoutes = (invoice: Record<string, unknown> = {}, earlier: unknown[] = []) => ({
  'GET /invoices/i1': { invoice: { ...APPROVED, ...invoice } },
  'GET /invoices': { invoices: earlier, meta: { paging: { page: 1, pageCount: 1, pageSize: 100, total: earlier.length } } },
  'POST /invoices': (c: Call) => ({
    invoices: [{ id: 'cn1', ...((c.body as { invoice: Record<string, unknown> }).invoice), lines: undefined }],
  }),
});

describe('create_credit_note', () => {
  it('credits the whole invoice as a draft credit note with its lines, customer, currency and terms', async () => {
    const { gw, calls } = billy(creditRoutes());
    const result = await call(gw, 'create_credit_note', { invoiceId: 'i1', entryDate: '2026-11-26' });
    expect(result.isError).toBeUndefined();
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/invoices/i1' });
    expect(calls[0]?.query.get('include')).toBe('invoice.lines:embed');
    expect(calls[1]).toMatchObject({ method: 'GET', path: '/invoices' });
    expect(calls[1]?.query.get('creditedInvoiceId')).toBe('i1');
    expect(calls[2]?.method).toBe('POST');
    expect(calls[2]?.body).toEqual({
      invoice: {
        type: 'creditNote',
        creditedInvoiceId: 'i1',
        contactId: 'c1',
        currencyId: 'DKK',
        paymentTermsDays: 8,
        taxMode: 'excl',
        entryDate: '2026-11-26',
        state: 'draft',
        lines: [
          { productId: 'p1', description: 'Konsulenttimer', quantity: 10, unitPrice: 800, priority: 1 },
          {
            productId: 'p2',
            description: 'Licens',
            quantity: 1,
            unitPrice: 2000,
            discountText: 'Rabat',
            discountMode: 'percent',
            discountValue: 10,
            priority: 2,
          },
        ],
      },
    });
    expect(result.structuredContent).toMatchObject({ id: 'cn1', type: 'creditNote', state: 'draft', creditedInvoiceId: 'i1' });
  });

  it('credits chosen lines, each with at most its quantity and unit price', async () => {
    const { gw, calls } = billy(creditRoutes());
    const result = await call(gw, 'create_credit_note', {
      invoiceId: 'i1',
      entryDate: '2026-11-26',
      contactMessage: 'Kreditering af to timer',
      lines: [{ lineId: 'l1', quantity: 2 }],
    });
    expect(result.isError).toBeUndefined();
    // A partial credit does not need the earlier credit notes.
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET /invoices/i1', 'POST /invoices']);
    expect(calls[1]?.body).toMatchObject({
      invoice: {
        type: 'creditNote',
        creditedInvoiceId: 'i1',
        contactMessage: 'Kreditering af to timer',
        state: 'draft',
        lines: [{ productId: 'p1', description: 'Konsulenttimer', quantity: 2, unitPrice: 800, priority: 1 }],
      },
    });

    const lower = billy(creditRoutes());
    const ok = await call(lower.gw, 'create_credit_note', { invoiceId: 'i1', entryDate: '2026-11-26', lines: [{ lineId: 'l1', unitPrice: 100 }] });
    expect(ok.isError).toBeUndefined();
    expect(lower.calls.at(-1)?.body).toMatchObject({ invoice: { lines: [{ productId: 'p1', quantity: 10, unitPrice: 100 }] } });
  });

  it('refuses more than the line, an unknown line, a part of a discounted line and a line given twice', async () => {
    for (const lines of [
      [{ lineId: 'l1', quantity: 11 }],
      [{ lineId: 'l1', unitPrice: 800.01 }],
      [{ lineId: 'l9' }],
      [{ lineId: 'l2', quantity: 0.5 }],
    ]) {
      const { gw, calls } = billy(creditRoutes());
      const refused = await call(gw, 'create_credit_note', { invoiceId: 'i1', entryDate: '2026-11-26', lines });
      expect(refused.isError, JSON.stringify(lines)).toBe(true);
      expect(refused.content[0]?.text).toContain('Nothing was sent');
      expect(calls.map(c => c.method)).toEqual(['GET']);
    }
    const { gw, calls } = billy(creditRoutes());
    const twice = await call(gw, 'create_credit_note', { invoiceId: 'i1', entryDate: '2026-11-26', lines: [{ lineId: 'l1' }, { lineId: 'l1' }] });
    expect(twice.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('refuses to credit a draft invoice, and sends nothing', async () => {
    const { gw, calls } = billy(creditRoutes({ state: 'draft', approvedTime: null }));
    const refused = await call(gw, 'create_credit_note', { invoiceId: 'i1', entryDate: '2026-11-26' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain('not approved');
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET /invoices/i1']);
  });

  it('refuses to credit a credit note or a voided invoice', async () => {
    for (const invoice of [{ type: 'creditNote', creditedInvoiceId: 'i0' }, { state: 'voided' }]) {
      const { gw, calls } = billy(creditRoutes(invoice));
      expect((await call(gw, 'create_credit_note', { invoiceId: 'i1', entryDate: '2026-11-26' })).isError).toBe(true);
      expect(calls.every(c => c.method === 'GET')).toBe(true);
    }
  });

  it('refuses a whole credit when the invoice already has a credit note that is not voided', async () => {
    const { gw, calls } = billy(creditRoutes({}, [{ id: 'cn0', type: 'creditNote', creditedInvoiceId: 'i1', state: 'approved' }]));
    const refused = await call(gw, 'create_credit_note', { invoiceId: 'i1', entryDate: '2026-11-26' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain('already has a credit note');
    expect(calls.map(c => c.method)).toEqual(['GET', 'GET']);

    const voided = billy(creditRoutes({}, [{ id: 'cn0', type: 'creditNote', creditedInvoiceId: 'i1', state: 'voided' }]));
    expect((await call(voided.gw, 'create_credit_note', { invoiceId: 'i1', entryDate: '2026-11-26' })).isError).toBeUndefined();
  });

  it('is booked and e-mailed with the tools that exist', async () => {
    const draft = billy({
      'GET /invoices/cn1': { invoice: { id: 'cn1', type: 'creditNote', creditedInvoiceId: 'i1', state: 'draft' } },
      'PUT /invoices/cn1': { invoices: [{ id: 'cn1', type: 'creditNote', state: 'approved' }] },
    });
    const approved = await call(draft.gw, 'approve_invoice', { invoiceId: 'cn1' });
    expect(approved.structuredContent).toEqual({ id: 'cn1', type: 'creditNote', state: 'approved' });
    expect(draft.calls.at(-1)?.body).toEqual({ invoice: { state: 'approved' } });

    const sending = billy({
      'GET /invoices/cn1': { invoice: { id: 'cn1', type: 'creditNote', state: 'approved', contactId: 'c1' } },
      'GET /contactPersons/cp1': { contactPerson: { id: 'cp1', contactId: 'c1', email: 'buyer@example.test' } },
      'POST /invoices/cn1/emails': {},
    });
    const sent = await call(sending.gw, 'send_invoice', {
      invoiceId: 'cn1',
      contactPersonId: 'cp1',
      emailSubject: 'Kreditnota',
      emailBody: 'Hermed kreditnotaen.',
    });
    expect(sent.structuredContent).toEqual({ sent: true, invoiceId: 'cn1', contactPersonId: 'cp1' });
  });
});

describe('update_invoice_draft', () => {
  const DRAFT = { id: 'i5', type: 'invoice', state: 'draft', sentState: 'unsent', approvedTime: null, contactId: 'c1' };

  it('changes only the fields given on a draft, reading it just before, and never sends a state', async () => {
    const { gw, calls } = billy({
      'GET /invoices/i5': { invoice: DRAFT },
      'PUT /invoices/i5': (c: Call) => ({ invoices: [{ ...DRAFT, ...((c.body as { invoice: Record<string, unknown> }).invoice), lines: undefined }] }),
    });
    const result = await call(gw, 'update_invoice_draft', {
      invoiceId: 'i5',
      entryDate: '2026-11-27',
      paymentTermsDays: 14,
      lines: [
        { productId: 'p1', quantity: 3, unitPrice: 800 },
        { productId: 'p3', unitPrice: 150, description: 'Kørsel' },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET /invoices/i5', 'PUT /invoices/i5']);
    expect(calls[1]?.body).toEqual({
      invoice: {
        entryDate: '2026-11-27',
        paymentTermsDays: 14,
        lines: [
          { productId: 'p1', quantity: 3, unitPrice: 800, priority: 1 },
          { productId: 'p3', unitPrice: 150, description: 'Kørsel', priority: 2 },
        ],
      },
    });
    expect(result.structuredContent).toMatchObject({ id: 'i5', state: 'draft', entryDate: '2026-11-27', paymentTermsDays: 14 });

    const message = billy({ 'GET /invoices/i5': { invoice: DRAFT }, 'PUT /invoices/i5': { invoices: [DRAFT] } });
    await call(message.gw, 'update_invoice_draft', { invoiceId: 'i5', contactMessage: 'Tak for ordren' });
    expect(message.calls.at(-1)?.body).toEqual({ invoice: { contactMessage: 'Tak for ordren' } });
  });

  it('refuses to change an approved invoice, and sends nothing', async () => {
    const { gw, calls } = billy({ 'GET /invoices/i1': { invoice: APPROVED } });
    const refused = await call(gw, 'update_invoice_draft', { invoiceId: 'i1', paymentTermsDays: 30 });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain('not a draft');
    expect(calls.map(c => c.method)).toEqual(['GET']);
  });

  it('refuses a draft with an approval time, a draft credit note, a change of customer or state, and nothing to change', async () => {
    for (const invoice of [{ ...DRAFT, approvedTime: '2026-11-20T10:00:00Z' }, { ...DRAFT, type: 'creditNote' }, { ...DRAFT, state: 'voided' }]) {
      const { gw, calls } = billy({ 'GET /invoices/i5': { invoice } });
      expect((await call(gw, 'update_invoice_draft', { invoiceId: 'i5', paymentTermsDays: 30 })).isError).toBe(true);
      expect(calls.map(c => c.method)).toEqual(['GET']);
    }
    const { gw, calls } = billy({ 'GET /invoices/i5': { invoice: DRAFT } });
    const inputs: GatewayJsonObject[] = [{ invoiceId: 'i5' }, { invoiceId: 'i5', contactId: 'c2' }, { invoiceId: 'i5', state: 'approved' }, { invoiceId: 'i5', lines: [] }];
    for (const input of inputs) {
      expect((await call(gw, 'update_invoice_draft', input)).isError, JSON.stringify(input)).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('catalog, change and the fixed list of writes', () => {
  it('lists both as write tools that move no money, with what to log', () => {
    for (const name of ['create_credit_note', 'update_invoice_draft']) {
      const entry = billyToolCatalog.find(e => e.name === name)!;
      expect(entry).toMatchObject({ riskLevel: 'write', enabledByDefault: false, requiresConfirmation: false, broad: false });
      expect(entry.change).toMatchObject({ record: 'invoice', movesMoney: false });
    }
    const credit = resolveBillyChange('create_credit_note', {
      invoiceId: 'i1',
      entryDate: '2026-11-26',
      contactMessage: 'Fejl i antal',
      lines: [{ lineId: 'l1', quantity: 2 }],
    });
    expect(credit.ok && credit.change).toMatchObject({ action: 'create', values: { invoiceId: 'i1', entryDate: '2026-11-26', lines: 1 } });
    expect(JSON.stringify(credit)).not.toContain('Fejl i antal');
    const update = resolveBillyChange('update_invoice_draft', { invoiceId: 'i5', paymentTermsDays: 14 });
    expect(update.ok && update.change).toMatchObject({ action: 'update', values: { invoiceId: 'i5' } });
  });

  it('needs no new write: both use POST /invoices and PUT /invoices/{id}, and every other write is still refused', async () => {
    expect(ALLOWED_WRITES).toHaveLength(15);
    const fetchImpl = vi.fn(async () => Response.json({}));
    const client = makeClient(fetchImpl);
    const refused = [
      () => client.post('/invoices/i1/credit', {}),
      () => client.post('/invoices/i1/creditNotes', {}),
      () => client.put('/invoices', {}),
      () => client.put('/invoices/i1/lines/l1', {}),
      () => client.post('/invoiceLines', {}),
      () => client.put('/invoiceLines/l1', {}),
      () => client.delete('/invoiceLines/l1'),
      () => client.put('/accounts/a1', {}),
      () => client.post('/bankPayments/x', {}),
    ];
    for (const attempt of refused) {
      await expect(attempt()).rejects.toThrow(/not among the writes this server sends/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    await client.post('/invoices', {});
    await client.put('/invoices/i1', {});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
