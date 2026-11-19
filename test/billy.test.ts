// Billy-specific behaviour, against answers shaped as Billy's API documentation shows them
// (https://www.billy.dk/api: root keys, include=...:embed, meta.paging). These are recorded from the documentation,
// not from a live company: no Billy account was used.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { billyToolCatalog, createBillyGateway, resolveBillyChange, type GatewayJsonObject } from '../src/gateway.js';
import { BASE } from './helpers.js';

const TOKEN = 'tttt-gggg-wwww-vvvv-1';
const originalEnv = { ...process.env };

beforeEach(() => {
  for (const name of Object.keys(process.env)) if (name.startsWith('BILLY_')) delete process.env[name];
});
afterEach(() => {
  process.env = { ...originalEnv };
});

type Handler = (url: URL, init: RequestInit) => unknown;

/** A Billy stand-in: routes by "METHOD /path" (path relative to /v2). An unknown route answers 404. */
function billy(routes: Record<string, Handler | unknown>) {
  const calls: Array<{ method: string; path: string; query: URLSearchParams; body: unknown }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.slice(new URL(BASE).pathname.length);
    calls.push({ method, path, query: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[`${method} ${path}`];
    if (route === undefined) return Response.json({ errorMessage: 'not found' }, { status: 404 });
    const body = typeof route === 'function' ? (route as Handler)(url, init ?? {}) : route;
    return Response.json(body);
  });
  const gw = createBillyGateway({
    accessToken: TOKEN,
    baseUrl: BASE,
    maxAttempts: 1,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    policy: { enableWrites: true },
  });
  return { gw, calls, fetchImpl };
}

const call = async (gw: ReturnType<typeof billy>['gw'], tool: string, input: GatewayJsonObject = {}) => {
  const result = await gw.callTool(tool, input);
  return result;
};

describe('reads', () => {
  it('sends the token in X-Access-Token to the documented endpoint', async () => {
    const { gw, fetchImpl } = billy({ 'GET /organization': { organization: { id: 'o1', name: 'Demo ApS', isLocked: false } } });
    const result = await call(gw, 'check_connection');
    expect(result.structuredContent).toEqual({ connected: true, organization: { id: 'o1', name: 'Demo ApS', isLocked: false } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/organization`);
    expect((init.headers as Record<string, string>)['X-Access-Token']).toBe(TOKEN);
  });

  it('leaves subscription, card and bank fields out of the company details', async () => {
    const { gw } = billy({
      'GET /organization': {
        organization: {
          id: 'o1',
          name: 'Demo ApS',
          registrationNo: '12345678',
          baseCurrencyId: 'DKK',
          subscriptionCardNumber: '4111',
          subscriptionCardType: 'visa',
          subscriptionPrice: 99,
          defaultInvoiceBankAccountId: 'acc-1',
          billEmailAddress: 'bills@example.test',
        },
      },
    });
    const result = await call(gw, 'get_organization');
    expect(result.structuredContent).toEqual({ id: 'o1', name: 'Demo ApS', registrationNo: '12345678', baseCurrencyId: 'DKK' });
  });

  it('reads every page of contacts, filters here, and says when it stopped early', async () => {
    const page = (n: number) => ({
      contacts: [
        { id: `c${n}a`, name: `Kunde ${n}`, isCustomer: true, isSupplier: false, accessCode: 'secret-portal' },
        { id: `c${n}b`, name: `Leverandør ${n}`, isCustomer: false, isSupplier: true },
        { id: `c${n}c`, name: `Arkiveret ${n}`, isCustomer: true, isArchived: true },
      ],
      meta: { paging: { page: n, pageCount: 2, pageSize: 1000, total: 6, nextUrl: 'https://api.billysbilling.com/v2/contacts?page=2' } },
    });
    const { gw, calls } = billy({ 'GET /contacts': (url: URL) => page(Number(url.searchParams.get('page'))) });
    const result = await call(gw, 'list_contacts', { kind: 'customer' });
    expect(calls.map(c => c.query.get('page'))).toEqual(['1', '2']);
    expect(calls[0]?.query.get('pageSize')).toBe('1000');
    expect(result.structuredContent).toEqual({
      contacts: [
        { id: 'c1a', name: 'Kunde 1', isCustomer: true, isSupplier: false },
        { id: 'c2a', name: 'Kunde 2', isCustomer: true, isSupplier: false },
      ],
      matched: 2,
      shown: 2,
      complete: true,
    });
    expect(JSON.stringify(result)).not.toContain('secret-portal');
  });

  it('gets a contact with its contact persons embedded, without the portal access code', async () => {
    const { gw, calls } = billy({
      'GET /contacts/c1': {
        contact: {
          id: 'c1',
          name: 'Kunde ApS',
          accessCode: 'secret-portal',
          contactPersons: [{ id: 'p1', contactId: 'c1', name: 'Anna', email: 'anna@example.test', isPrimary: true }],
        },
      },
    });
    const result = await call(gw, 'get_contact', { contactId: 'c1' });
    expect(calls[0]?.query.get('include')).toBe('contact.contactPersons:embed');
    expect(result.structuredContent).toEqual({
      id: 'c1',
      name: 'Kunde ApS',
      contactPersons: [{ id: 'p1', name: 'Anna', email: 'anna@example.test', isPrimary: true }],
    });
  });

  it('sends only documented invoice filters, one page at a time', async () => {
    const { gw, calls } = billy({
      'GET /invoices': {
        invoices: [{ id: 'i1', invoiceNo: '42', state: 'approved', amount: 1000, tax: 250, balance: 1250, isPaid: false, downloadUrl: 'x' }],
        meta: { paging: { page: 1, pageCount: 1, pageSize: 100, total: 1, firstUrl: 'u' } },
      },
    });
    const result = await call(gw, 'list_invoices', { state: 'approved', isPaid: false, minEntryDate: '2026-01-01', sortProperty: 'dueDate' });
    expect(Object.fromEntries(calls[0]!.query)).toEqual({
      state: 'approved',
      isPaid: 'false',
      minEntryDate: '2026-01-01',
      sortProperty: 'dueDate',
      pageSize: '100',
    });
    expect(result.structuredContent).toEqual({
      invoices: [{ id: 'i1', invoiceNo: '42', state: 'approved', amount: 1000, tax: 250, balance: 1250, isPaid: false }],
      paging: { page: 1, pageCount: 1, pageSize: 100, total: 1 },
    });
  });

  it('refuses an invalid date or an unknown filter before sending anything', async () => {
    const { gw, fetchImpl } = billy({});
    expect((await call(gw, 'list_invoices', { minEntryDate: '2026-02-30' })).isError).toBe(true);
    expect((await call(gw, 'list_invoices', { organizationId: 'other' })).isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('shows bank numbers on accounts only as their last four characters', async () => {
    const { gw, calls } = billy({
      'GET /accounts': {
        accounts: [
          { id: 'a1', accountNo: 5820, name: 'Bank', isBankAccount: true, isPaymentEnabled: true, bankAccountNo: '1234 5678901234', bankIban: 'DK5000400440116243', bankSwift: 'NDEADKKK', bankRoutingNo: '1234' },
        ],
        meta: { paging: { page: 1, pageCount: 1 } },
      },
    });
    const result = await call(gw, 'list_accounts', { bankAccountsOnly: true });
    expect(calls[0]?.query.get('isBankAccount')).toBe('true');
    expect(result.structuredContent).toEqual({
      accounts: [
        { id: 'a1', accountNo: 5820, name: 'Bank', isBankAccount: true, isPaymentEnabled: true, bankAccountNoLast4: '••••1234', bankIbanLast4: '••••6243' },
      ],
      complete: true,
    });
    const text = JSON.stringify(result);
    for (const secret of ['5678901234', 'DK5000400440', 'NDEADKKK']) expect(text).not.toContain(secret);
  });
});

describe('writes', () => {
  it('creates an invoice as a draft, whatever is asked', async () => {
    const { gw, calls } = billy({ 'POST /invoices': { invoices: [{ id: 'i9', state: 'draft', contactId: 'c1' }] } });
    const result = await call(gw, 'create_draft_invoice', {
      contactId: 'c1',
      entryDate: '2026-11-19',
      lines: [
        { productId: 'p1', unitPrice: 100, quantity: 2 },
        { productId: 'p2', unitPrice: 50, description: 'Kørsel' },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(calls[0]?.body).toEqual({
      invoice: {
        contactId: 'c1',
        entryDate: '2026-11-19',
        state: 'draft',
        lines: [
          { productId: 'p1', unitPrice: 100, quantity: 2, priority: 1 },
          { productId: 'p2', unitPrice: 50, description: 'Kørsel', priority: 2 },
        ],
      },
    });
    expect((await call(gw, 'create_draft_invoice', { contactId: 'c1', entryDate: '2026-11-19', lines: [], state: 'approved' })).isError).toBe(true);
  });

  it('approves only a draft invoice, and sends nothing for another', async () => {
    const draft = billy({
      'GET /invoices/i1': { invoice: { id: 'i1', state: 'draft' } },
      'PUT /invoices/i1': { invoices: [{ id: 'i1', state: 'approved', invoiceNo: '43' }] },
    });
    const ok = await call(draft.gw, 'approve_invoice', { invoiceId: 'i1' });
    expect(ok.structuredContent).toEqual({ id: 'i1', state: 'approved', invoiceNo: '43' });
    expect(draft.calls.at(-1)).toMatchObject({ method: 'PUT', path: '/invoices/i1', body: { invoice: { state: 'approved' } } });

    const approved = billy({ 'GET /invoices/i1': { invoice: { id: 'i1', state: 'approved' } } });
    const refused = await call(approved.gw, 'approve_invoice', { invoiceId: 'i1' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain('not a draft');
    expect(approved.calls.map(c => c.method)).toEqual(['GET']);
  });

  const paymentRoutes = (invoice: Record<string, unknown>, account: Record<string, unknown>) => ({
    'GET /invoices/i1': { invoice: { id: 'i1', state: 'approved', isPaid: false, balance: 1250, currencyId: 'DKK', ...invoice } },
    'GET /accounts/a1': { account: { id: 'a1', isPaymentEnabled: true, currencyId: 'DKK', ...account } },
    'POST /bankPayments': { bankPayments: [{ id: 'bp1', cashAmount: 1250, cashSide: 'debit', cashAccountId: 'a1', entryDate: '2026-11-19' }] },
  });

  it('registers an invoice payment as the documentation shows it', async () => {
    const { gw, calls } = billy(paymentRoutes({}, {}));
    const result = await call(gw, 'register_payment', { invoiceId: 'i1', cashAccountId: 'a1', amount: 1250, entryDate: '2026-11-19' });
    expect(result.isError).toBeUndefined();
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/bankPayments',
      body: {
        bankPayment: {
          entryDate: '2026-11-19',
          cashAmount: 1250,
          cashSide: 'debit',
          cashAccountId: 'a1',
          associations: [{ subjectReference: 'invoice:i1' }],
        },
      },
    });
  });

  it('registers a bill payment as money out', async () => {
    const { gw, calls } = billy({
      'GET /bills/b1': { bill: { id: 'b1', state: 'approved', isPaid: false, balance: 300, currencyId: 'DKK' } },
      'GET /accounts/a1': { account: { id: 'a1', isPaymentEnabled: true, currencyId: 'DKK' } },
      'POST /bankPayments': { bankPayments: [{ id: 'bp2' }] },
    });
    await call(gw, 'register_payment', { billId: 'b1', cashAccountId: 'a1', amount: 300, entryDate: '2026-11-19' });
    expect(calls.at(-1)?.body).toMatchObject({ bankPayment: { cashSide: 'credit', associations: [{ subjectReference: 'bill:b1' }] } });
  });

  it.each([
    ['more than the balance', {}, {}, 1250.01],
    ['a draft invoice', { state: 'draft' }, {}, 100],
    ['a paid invoice', { isPaid: true, balance: 0 }, {}, 100],
    ['an account without payments', {}, { isPaymentEnabled: false }, 100],
    ['another currency', {}, { currencyId: 'EUR' }, 100],
  ])('refuses a payment of %s without sending it', async (_name, invoice, account, amount) => {
    const { gw, calls } = billy(paymentRoutes(invoice, account));
    const result = await call(gw, 'register_payment', { invoiceId: 'i1', cashAccountId: 'a1', amount, entryDate: '2026-11-19' });
    expect(result.isError).toBe(true);
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });

  it('wants exactly one of invoiceId and billId, and an amount of at most two decimals', async () => {
    const { gw, fetchImpl } = billy({});
    for (const input of [
      { cashAccountId: 'a1', amount: 10, entryDate: '2026-11-19' },
      { invoiceId: 'i1', billId: 'b1', cashAccountId: 'a1', amount: 10, entryDate: '2026-11-19' },
      { invoiceId: 'i1', cashAccountId: 'a1', amount: 10.005, entryDate: '2026-11-19' },
      { invoiceId: 'i1', cashAccountId: 'a1', amount: -5, entryDate: '2026-11-19' },
    ]) {
      expect((await call(gw, 'register_payment', input as GatewayJsonObject)).isError, JSON.stringify(input)).toBe(true);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('puts a daybook transaction in as a draft, without a state', async () => {
    const { gw, calls } = billy({ 'POST /daybookTransactions': { daybookTransactions: [{ id: 't1', state: 'draft' }] } });
    await call(gw, 'create_daybook_transaction', {
      daybookId: 'd1',
      entryDate: '2026-11-19',
      lines: [{ accountId: 'a1', contraAccountId: 'a2', amount: 100, side: 'debit', text: 'Husleje' }],
    });
    expect(calls[0]?.body).toEqual({
      daybookTransaction: {
        daybookId: 'd1',
        entryDate: '2026-11-19',
        lines: [{ accountId: 'a1', contraAccountId: 'a2', amount: 100, side: 'debit', text: 'Husleje', priority: 1 }],
      },
    });
  });

  it('changes only the fields given on a contact, never its contact persons', async () => {
    const { gw, calls } = billy({ 'PUT /contacts/c1': { contacts: [{ id: 'c1', phone: '12345678' }] } });
    await call(gw, 'update_contact', { contactId: 'c1', phone: '12345678' });
    expect(calls[0]?.body).toEqual({ contact: { phone: '12345678' } });
    expect((await call(gw, 'update_contact', { contactId: 'c1' })).isError).toBe(true);
    expect((await call(gw, 'update_contact', { contactId: 'c1', contactPersons: [] })).isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('has no tool that deletes, sends, or changes accounts, VAT rates or the company', () => {
    for (const entry of billyToolCatalog) {
      expect(entry.riskLevel).not.toBe('destructive');
      for (const operation of entry.upstream) {
        expect(['GET', 'POST', 'PUT']).toContain(operation.method);
        if (operation.access === 'write') {
          expect(operation.path).toMatch(/^\/(contacts|products|invoices|bankPayments|daybookTransactions)(\/\{\w+\})?$/);
        }
      }
    }
  });
});

describe('change resolution for a host log', () => {
  it('gives ids, amounts, dates and counts in clear, numbers the company chose as pseudonyms, and no names', () => {
    const payment = resolveBillyChange('register_payment', { invoiceId: 'i1', cashAccountId: 'a1', amount: 1250.5, entryDate: '2026-11-19' });
    expect(payment).toEqual({
      ok: true,
      change: {
        tool: 'register_payment',
        action: 'register_payment',
        record: 'payment',
        movesMoney: false,
        requiresConfirmation: true,
        values: { invoiceId: 'i1', cashAccountId: 'a1', amount: 1250.5, entryDate: '2026-11-19' },
      },
    });

    const contact = resolveBillyChange(
      'create_contact',
      { name: 'Jens Jensen', countryId: 'DK', contactNo: 'K-100', isCustomer: true, contactPersons: [{ email: 'jens@example.test' }] },
      { pseudonymKey: 'host-key' },
    );
    expect(contact.ok && contact.change.values).toEqual({
      countryId: 'DK',
      isCustomer: true,
      contactNo: expect.stringMatching(/^hmac:[0-9a-f]{16}$/),
      contactPersons: 1,
    });
    expect(JSON.stringify(contact)).not.toMatch(/Jens|jens@|K-100/);
    expect(contact.ok && contact.change.requiresConfirmation).toBe(false);

    expect(resolveBillyChange('list_contacts', {})).toEqual({ ok: false, reason: 'list_contacts is not a write tool.' });
    expect(resolveBillyChange('create_contact', { name: 'x' })).toEqual({ ok: false, reason: 'Invalid input for create_contact.' });
    expect(resolveBillyChange('delete_contact', {}).ok).toBe(false);
  });

  it('marks only register_payment as needing a person to confirm', () => {
    expect(billyToolCatalog.filter(entry => entry.requiresConfirmation).map(entry => entry.name)).toEqual(['register_payment']);
  });
});
