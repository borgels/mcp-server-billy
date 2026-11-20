// Billy-specific behaviour, against answers shaped as Billy's API documentation shows them
// (https://www.billy.dk/api: root keys, include=...:embed, meta.paging). These are recorded from the documentation,
// not from a live company: no Billy account was used.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { billyToolCatalog, createBillyGateway, resolveBillyChange, type GatewayJsonObject } from '../src/gateway.js';
import { BASE } from './helpers.js';
import { REDACTION_MARKER } from '../src/errors.js';
import { fixedOutputs, RESULT_WITHHELD } from '../src/fallbacks.js';
import { FIXED_CORPUS } from '../src/fixed-corpus.generated.js';
import { logFieldValue } from '../src/tools/billy.js';

// Pseudonym keys: 32 or more random printable characters that share no piece with any text of ours.
const PSEUDONYM_KEY_1 = 'Qh7Vz2Lr9Xw4Nc8Tp3Yk6Bm1Fs5Jd0Ga'; // gitleaks:allow (a test value, not a key)
const PSEUDONYM_KEY_2 = 'Wy3Rk8Pq1Zt6Hv9Lc2Xn5Bg7Md4Js0Fe'; // gitleaks:allow (a test value, not a key)

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
function billy(routes: Record<string, Handler | unknown>, token = TOKEN) {
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
    accessToken: token,
    baseUrl: BASE,
    maxAttempts: 1,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    policy: { enableWrites: true },
  });
  return { gw, calls, fetchImpl };
}

/** The company of the token, as GET /organization answers it. */
const ORGANIZATION = { 'GET /organization': { organization: { id: 'o1', name: 'Demo ApS' } } };

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
      currencyId: 'DKK',
      paymentTermsDays: 8,
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
        currencyId: 'DKK',
        paymentTermsDays: 8,
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
    ...ORGANIZATION,
    'GET /invoices/i1': {
      invoice: { id: 'i1', organizationId: 'o1', type: 'invoice', state: 'approved', isPaid: false, balance: 1250, currencyId: 'DKK', ...invoice },
    },
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
      ...ORGANIZATION,
      'GET /bills/b1': { bill: { id: 'b1', organizationId: 'o1', type: 'bill', state: 'approved', isPaid: false, balance: 300, currencyId: 'DKK' } },
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

  it('has no tool that changes accounts, VAT rates, the company or users, sends an e-invoice, or deletes beyond drafts', () => {
    const deleting: string[] = [];
    for (const entry of billyToolCatalog) {
      expect(entry.riskLevel).not.toBe('destructive');
      for (const operation of entry.upstream) {
        expect(['GET', 'POST', 'PUT', 'DELETE']).toContain(operation.method);
        if (operation.access === 'write') {
          expect(operation.path).toMatch(
            /^\/(contacts|products|invoices|bills|bankPayments|daybookTransactions|files|attachments)(\/\{\w+\})?$|^\/invoices\/\{invoiceId\}\/emails$/,
          );
        }
        if (operation.method === 'DELETE') deleting.push(entry.name);
      }
    }
    expect(deleting).toEqual(['delete_draft_invoice', 'delete_draft_bill']);
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
      { name: 'Jens Jensen', countryId: 'DK', paymentTermsDays: 8, contactNo: 'K-100', isCustomer: true, contactPersons: [{ email: 'jens@example.test' }] },
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

describe('after review', () => {
  it('registers one payment at a time per document, so two calls cannot both pass the balance check', async () => {
    let balance = 100;
    const { gw, calls } = billy({
      ...ORGANIZATION,
      'GET /invoices/i1': () => ({
        invoice: { id: 'i1', organizationId: 'o1', type: 'invoice', state: 'approved', isPaid: balance <= 0, balance, currencyId: 'DKK' },
      }),
      'GET /accounts/a1': { account: { id: 'a1', isPaymentEnabled: true, currencyId: 'DKK' } },
      'POST /bankPayments': () => {
        balance -= 100;
        return { bankPayments: [{ id: `bp${balance}` }] };
      },
    });
    const input = { invoiceId: 'i1', cashAccountId: 'a1', amount: 100, entryDate: '2026-11-19' };
    const [first, second] = await Promise.all([call(gw, 'register_payment', input), call(gw, 'register_payment', input)]);
    expect([first.isError, second.isError]).toEqual([undefined, true]);
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);
  });

  it.each([
    ['a credit note', { type: 'creditNote' }, {}],
    ['a missing type', { type: undefined }, {}],
    ['a negative balance', { balance: -100 }, {}],
    ['an unknown invoice currency', { currencyId: undefined }, {}],
    ['an unknown account currency', {}, { currencyId: undefined }],
    ['an invalid currency', {}, { currencyId: 'dkk' }],
    ['another company', { organizationId: 'o2' }, {}],
    ['no company', { organizationId: undefined }, {}],
  ])('refuses a payment with %s', async (_name, invoice, account) => {
    const { gw, calls } = billy({
      ...ORGANIZATION,
      'GET /invoices/i1': {
        invoice: { id: 'i1', organizationId: 'o1', type: 'invoice', state: 'approved', isPaid: false, balance: 100, currencyId: 'DKK', ...invoice },
      },
      'GET /accounts/a1': { account: { id: 'a1', isPaymentEnabled: true, currencyId: 'DKK', ...account } },
      'POST /bankPayments': { bankPayments: [{ id: 'bp' }] },
    });
    const result = await call(gw, 'register_payment', { invoiceId: 'i1', cashAccountId: 'a1', amount: 50, entryDate: '2026-11-19' });
    expect(result.isError).toBe(true);
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });

  it('registers one payment at a time per company and document, whichever token the call came through', async () => {
    let balance = 100;
    const posts: unknown[] = [];
    const routes = {
      ...ORGANIZATION,
      'GET /invoices/i1': () => ({
        invoice: { id: 'i1', organizationId: 'o1', type: 'invoice', state: 'approved', isPaid: balance <= 0, balance, currencyId: 'DKK' },
      }),
      'GET /accounts/a1': { account: { id: 'a1', isPaymentEnabled: true, currencyId: 'DKK' } },
      'POST /bankPayments': (_url: URL, init: RequestInit) => {
        posts.push(init.body);
        balance -= 100;
        return { bankPayments: [{ id: `bp${balance}` }] };
      },
    };
    // Two tokens of the same company, as two gateway instances (two connections in a host).
    const one = billy(routes, 'tttt-gggg-wwww-vvvv-1');
    const two = billy(routes, 'kkkk-pppp-qqqq-zzzz-2');
    const input = { invoiceId: 'i1', cashAccountId: 'a1', amount: 100, entryDate: '2026-11-19' };
    const results = await Promise.all([call(one.gw, 'register_payment', input), call(two.gw, 'register_payment', input)]);
    expect(results.map(result => result.isError).sort()).toEqual([true, undefined]);
    expect(posts).toHaveLength(1);
  });

  it.each([
    ['without a type', { type: undefined }],
    ['of an unknown type', { type: 'other' }],
    ['that credits another bill', { creditedBillId: 'b0' }],
  ])('refuses a payment of a bill %s', async (_name, bill) => {
    const { gw, calls } = billy({
      ...ORGANIZATION,
      'GET /bills/b1': {
        bill: { id: 'b1', organizationId: 'o1', type: 'bill', state: 'approved', isPaid: false, balance: 300, currencyId: 'DKK', ...bill },
      },
      'GET /accounts/a1': { account: { id: 'a1', isPaymentEnabled: true, currencyId: 'DKK' } },
      'POST /bankPayments': { bankPayments: [{ id: 'bp' }] },
    });
    const result = await call(gw, 'register_payment', { billId: 'b1', cashAccountId: 'a1', amount: 300, entryDate: '2026-11-19' });
    expect(result.isError).toBe(true);
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });

  it('refuses a record without an id, and a list with an entry that is not a record with an id', async () => {
    for (const routes of [
      { 'GET /organization': { organization: {} } },
      { 'GET /organization': { organization: { id: '' } } },
    ]) {
      const { gw } = billy(routes);
      const result = await call(gw, 'check_connection');
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('without the expected data');
    }
    for (const invoices of [[null, 'bad', {}], [{ id: 'i1' }, {}], [{ id: 'i1' }, null]]) {
      const { gw } = billy({ 'GET /invoices': { invoices, meta: { paging: { page: 1 } } } });
      expect((await call(gw, 'list_invoices')).isError).toBe(true);
    }
    const { gw } = billy({ 'GET /invoices': { invoices: [], meta: { paging: { page: 1 } } } });
    expect((await call(gw, 'list_invoices')).isError).toBeUndefined();
  });

  it('requires payment terms when a contact is created, as Billy documents the field as required', async () => {
    const { gw, calls } = billy({ 'POST /contacts': { contacts: [{ id: 'c1' }] } });
    expect((await call(gw, 'create_contact', { name: 'X', countryId: 'DK' })).isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect((await call(gw, 'create_contact', { name: 'X', countryId: 'DK', paymentTermsDays: 8 })).isError).toBeUndefined();
    expect(calls.at(-1)?.body).toMatchObject({ contact: { paymentTermsDays: 8 } });
  });

  it('refuses an answer without the documented root key, and a write answer without the changed record', async () => {
    const html = createBillyGateway({
      accessToken: TOKEN,
      baseUrl: BASE,
      maxAttempts: 1,
      fetchImpl: async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
    });
    const check = await html.callTool('check_connection', {});
    expect(check.isError).toBe(true);
    expect(check.content[0]?.text).toContain('without the expected data');

    const { gw } = billy({ 'POST /contacts': { contacts: [] }, 'GET /invoices': { meta: {} } });
    expect((await call(gw, 'create_contact', { name: 'X', countryId: 'DK', paymentTermsDays: 8 })).isError).toBe(true);
    expect((await call(gw, 'list_invoices', {})).isError).toBe(true);
  });

  it('logs a rejected call with a fixed code, known field names and a pseudonym for an unknown tool', async () => {
    const records: Array<Record<string, unknown>> = [];
    const gw = createBillyGateway({
      accessToken: TOKEN,
      baseUrl: BASE,
      fetchImpl: (async () => Response.json({})) as typeof fetch,
      policy: { audit: record => void records.push({ ...record }) },
    });
    await gw.callTool('Jens Jensen', { 'Anna Hansen': 1 });
    await gw.callTool('get_contact', { contactId: 'c1', 'Anna Hansen': 1 });
    const text = JSON.stringify(records);
    expect(text).not.toMatch(/Jens|Anna/);
    expect(records[0]).toMatchObject({ tool: 'unknown', action: 'rejected', reason: 'unknown_tool', target: { fields: [], otherFields: 1 } });
    expect((records[0]?.target as Record<string, unknown>).toolPseudonym).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(records[1]).toMatchObject({ tool: 'billy_get_contact', reason: 'invalid_input', target: { fields: ['contactId'], otherFields: 1 } });
  });

  it('resolves a change only for input that would run, and an instance leaves its own token out', () => {
    expect(resolveBillyChange('register_payment', { invoiceId: 'i1', billId: 'b1', cashAccountId: 'a1', amount: 1, entryDate: '2026-11-19' }).ok).toBe(false);
    expect(resolveBillyChange('update_contact', { contactId: 'c1' }).ok).toBe(false);
    const token = 'tokenlike-0123456789abcdefXYZ';
    const gw = createBillyGateway({ accessToken: token, baseUrl: BASE });
    const resolved = gw.resolveChange('update_contact', { contactId: token, phone: '1' });
    expect(resolved.ok && resolved.change.values).toEqual({});
    expect(JSON.stringify(resolved)).not.toContain('0123456789');
  });

  it('sends the token only to the exact documented hosts, not their subdomains', () => {
    for (const baseUrl of ['https://unlisted.api.billy.dk/v2', 'https://x.api.billysbilling.com/v2']) {
      expect(() => createBillyGateway({ accessToken: TOKEN, baseUrl, policy: {} }), baseUrl).toThrow();
    }
    expect(() => createBillyGateway({ accessToken: TOKEN, baseUrl: 'https://api.billy.dk/v2', policy: {} })).not.toThrow();
  });
});

describe('after review 3', () => {
  it('refuses a record with another id than asked for, an object where a value should be, and an invalid embedded entry', async () => {
    const bad: Array<[string, GatewayJsonObject, Record<string, unknown>]> = [
      ['get_contact', { contactId: 'c1' }, { 'GET /contacts/c1': { contact: { id: 'c2', name: 'X' } } }],
      ['get_contact', { contactId: 'c1' }, { 'GET /contacts/c1': { contact: { id: 'c1', name: { nested: 'x' } } } }],
      ['get_contact', { contactId: 'c1' }, { 'GET /contacts/c1': { contact: { id: 'c1', contactPersons: [{ id: 'p1' }, null] } } }],
      ['get_contact', { contactId: 'c1' }, { 'GET /contacts/c1': { contact: { id: 'c1', contactPersons: 'nobody' } } }],
      ['get_invoice', { invoiceId: 'i1' }, { 'GET /invoices/i1': { invoice: { id: 'i2' } } }],
      ['get_invoice', { invoiceId: 'i1' }, { 'GET /invoices/i1': { invoice: { id: 'i1', lines: [{ id: 'l1' }, 'bad'] } } }],
      ['get_invoice', { invoiceId: 'i1' }, { 'GET /invoices/i1': { invoice: { id: 'i1', amount: { value: 1 } } } }],
      ['update_contact', { contactId: 'c1', phone: '1' }, { 'PUT /contacts/c1': { contacts: [{ id: 'c9' }] } }],
      ['list_invoices', {}, { 'GET /invoices': { invoices: [{ id: 'i1', state: ['approved'] }], meta: { paging: { page: 1 } } } }],
    ];
    for (const [tool, input, routes] of bad) {
      const result = await call(billy(routes).gw, tool, input);
      expect(result.isError, `${tool} ${JSON.stringify(routes)}`).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/nested|nobody/);
    }
  });

  it('keeps no name or address of the caller or the request id in the audit', async () => {
    const records: Array<Record<string, unknown>> = [];
    const gw = createBillyGateway({
      accessToken: TOKEN,
      baseUrl: BASE,
      fetchImpl: (async () => Response.json({ contact: { id: 'c1' } })) as typeof fetch,
      policy: { audit: record => void records.push({ ...record }), pseudonymKey: PSEUDONYM_KEY_1 }, // gitleaks:allow (a test constant, not a key)
    });
    await gw.callTool('get_contact', { contactId: 'c1' }, { caller: 'jens.jensen@example.test', requestId: 'Jens Jensen, Aarhus' });
    await gw.callTool('get_contact', { contactId: 'c1' }, { caller: 'jens.jensen@example.test', requestId: 'req-42' });
    expect(JSON.stringify(records)).not.toMatch(/jens|Jensen|Aarhus/i);
    expect(records[0]?.caller).toMatch(/^hmac:[0-9a-f]{16}$/);
    expect(records[0]?.requestId).toMatch(/^hmac:[0-9a-f]{16}$/);
    expect(records.at(-1)?.requestId).toMatch(/^hmac:[0-9a-f]{16}$/);
    expect(JSON.stringify(records)).not.toContain('req-42');
    expect(() => createBillyGateway({ accessToken: TOKEN, baseUrl: BASE, policy: { pseudonymKey: 'short' } })).toThrow(/pseudonymKey/);
  });
});

describe('after review 4', () => {
  const PSEUDONYM_KEY = PSEUDONYM_KEY_2; // gitleaks:allow (a test constant, not a key)
  const page = { meta: { paging: { page: 1, pageCount: 1 } } };

  it('refuses an embedded list that is not a list, instead of leaving it out', async () => {
    const bad: Array<[string, GatewayJsonObject, Record<string, unknown>]> = [
      ['get_invoice', { invoiceId: 'i1' }, { 'GET /invoices/i1': { invoice: { id: 'i1', lines: { bad: true } } } }],
      ['get_invoice', { invoiceId: 'i1' }, { 'GET /invoices/i1': { invoice: { id: 'i1', lines: 'none' } } }],
      ['get_bill', { billId: 'b1' }, { 'GET /bills/b1': { bill: { id: 'b1', lines: { bad: true } } } }],
      ['get_bill', { billId: 'b1' }, { 'GET /bills/b1': { bill: { id: 'b1', lines: 7 } } }],
      ['list_daybook_transactions', {}, { 'GET /daybookTransactions': { daybookTransactions: [{ id: 't1', lines: { bad: true } }], ...page } }],
      ['get_contact', { contactId: 'c1' }, { 'GET /contacts/c1': { contact: { id: 'c1', contactPersons: { bad: true } } } }],
      ['get_product', { productId: 'p1' }, { 'GET /products/p1': { product: { id: 'p1', prices: { bad: true } } } }],
    ];
    for (const [tool, input, routes] of bad) {
      const result = await call(billy(routes).gw, tool, input);
      expect(result.isError, `${tool} ${JSON.stringify(routes)}`).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/bad|none/);
    }
    // Absent or null lists are still fine: the record comes without them.
    for (const lines of [undefined, null]) {
      const result = await call(billy({ 'GET /invoices/i1': { invoice: { id: 'i1', lines } } }).gw, 'get_invoice', { invoiceId: 'i1' });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({ id: 'i1' });
    }
  });

  it('refuses a field of another type than documented', async () => {
    const bad: Array<[string, GatewayJsonObject, Record<string, unknown>]> = [
      ['get_invoice', { invoiceId: 'i1' }, { 'GET /invoices/i1': { invoice: { id: 'i1', amount: 'invalid' } } }],
      ['get_invoice', { invoiceId: 'i1' }, { 'GET /invoices/i1': { invoice: { id: 'i1', isPaid: 'false' } } }],
      ['get_invoice', { invoiceId: 'i1' }, { 'GET /invoices/i1': { invoice: { id: 'i1', state: 123 } } }],
      ['get_invoice', { invoiceId: 'i1' }, { 'GET /invoices/i1': { invoice: { id: 'i1', lines: [{ id: 'l1', quantity: '2' }] } } }],
      ['get_bill', { billId: 'b1' }, { 'GET /bills/b1': { bill: { id: 'b1', balance: '300.00' } } }],
      ['get_contact', { contactId: 'c1' }, { 'GET /contacts/c1': { contact: { id: 'c1', isCustomer: 1 } } }],
      ['get_contact', { contactId: 'c1' }, { 'GET /contacts/c1': { contact: { id: 'c1', name: 42 } } }],
      [
        'list_daybook_transactions',
        {},
        { 'GET /daybookTransactions': { daybookTransactions: [{ id: 't1', lines: [{ id: 'l1', amount: 'NaN' }] }], ...page } },
      ],
    ];
    for (const [tool, input, routes] of bad) {
      const result = await call(billy(routes).gw, tool, input);
      expect(result.isError, `${tool} ${JSON.stringify(routes)}`).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/invalid|NaN/);
    }
    const ok = await call(
      billy({ 'GET /invoices/i1': { invoice: { id: 'i1', invoiceNo: '41', amount: 100, isPaid: false, state: 'approved', dueDate: null } } }).gw,
      'get_invoice',
      { invoiceId: 'i1' },
    );
    expect(ok.structuredContent).toEqual({ id: 'i1', invoiceNo: '41', amount: 100, isPaid: false, state: 'approved', dueDate: null });
  });

  it('never keeps a request id from the host in clear, whatever characters it uses', async () => {
    const records: Array<Record<string, unknown>> = [];
    const gw = createBillyGateway({
      accessToken: TOKEN,
      baseUrl: BASE,
      fetchImpl: (async () => Response.json({ contact: { id: 'c1' } })) as typeof fetch,
      policy: { audit: record => void records.push({ ...record }), pseudonymKey: PSEUDONYM_KEY },
    });
    // A name with a hyphen, a phone number, a private address and an internal host name: all within the old
    // character filter. Made up for the test.
    const given = ['Anne-Marie.Hansen', '+4512345678', '10.0.0.5', 'intra-01.corp.example:8443'];
    for (const requestId of given) await gw.callTool('get_contact', { contactId: 'c1' }, { requestId });
    await gw.callTool('get_contact', { contactId: 'c1' });
    const text = JSON.stringify(records);
    for (const value of given) expect(text).not.toContain(value);
    expect(text).not.toMatch(/Anne|4512345678|10\.0\.0|corp/);
    const ids = records.map(record => record.requestId);
    for (const id of ids.slice(0, 8)) expect(id).toMatch(/^hmac:[0-9a-f]{16}$/);
    // The lines of one call share their id; another call does not.
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).not.toBe(ids[2]);
    // Without a request id the audit makes its own.
    expect(ids.at(-1)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps the pseudonym key out of results, audit records and errors', async () => {
    const records: Array<Record<string, unknown>> = [];
    const gw = createBillyGateway({
      accessToken: TOKEN,
      baseUrl: BASE,
      maxAttempts: 1,
      fetchImpl: (async (input: string | URL | Request) =>
        String(input).includes('/contacts/c1')
          ? Response.json({ contact: { id: 'c1', name: `Navn ${PSEUDONYM_KEY}` } })
          : Response.json({ errorMessage: `Fejl ${PSEUDONYM_KEY}` }, { status: 400 })) as typeof fetch,
      policy: { audit: record => void records.push({ ...record }), pseudonymKey: PSEUDONYM_KEY },
    });
    const results = [await gw.callTool('get_contact', { contactId: 'c1' }), await gw.callTool('get_contact', { contactId: 'c2' })];
    expect(results[0]?.isError).toBeUndefined();
    expect(results[1]?.isError).toBe(true);
    const text = JSON.stringify([results, records]);
    expect(text).not.toContain(PSEUDONYM_KEY);
    expect(text).not.toContain(PSEUDONYM_KEY.slice(4, 16));
  });

  it('keeps a pseudonym key given as bytes out of results', async () => {
    const bytes = new TextEncoder().encode(PSEUDONYM_KEY);
    const hex = Buffer.from(bytes).toString('hex');
    const gw = createBillyGateway({
      accessToken: TOKEN,
      baseUrl: BASE,
      fetchImpl: (async () => Response.json({ contact: { id: 'c1', name: PSEUDONYM_KEY, street: hex } })) as typeof fetch,
      policy: { pseudonymKey: bytes },
    });
    const text = JSON.stringify(await gw.callTool('get_contact', { contactId: 'c1' }));
    expect(text).not.toContain(PSEUDONYM_KEY);
    expect(text).not.toContain(hex);
  });

  it('keeps a value with a hyphen as a kind in the log values', () => {
    expect(logFieldValue('kind', 'on-hold')).toBe('on-hold');
    expect(logFieldValue('kind', '-x')).toBeUndefined();
  });
});

describe('after review 5: the pseudonym key anywhere', () => {
  /** Every piece of six characters of a key (the redactor's fragment length). */
  const pieces = (key: string) => Array.from({ length: Math.max(0, key.length - 5) }, (_, i) => key.slice(i, i + 6));
  /** The pieces of any form of the key found in any of the values, raw or serialised. */
  const leaked = (forms: string[], values: unknown[]) => {
    const texts = values.map(value => (typeof value === 'string' ? value : JSON.stringify(value) ?? ''));
    return forms.flatMap(pieces).filter(piece => texts.some(text => text.includes(piece)));
  };
  const formsOf = (key: string | Uint8Array) =>
    typeof key === 'string' ? [key] : ['hex', 'base64', 'base64url', 'latin1'].map(form => Buffer.from(key).toString(form as BufferEncoding));
  const construct = (options: Record<string, unknown>): Error | undefined => {
    try {
      createBillyGateway(options as never);
      return undefined;
    } catch (error) {
      return error as Error;
    }
  };

  // Every fixed text of ours long enough to be a key, the fallback texts joined, and texts of ours inside a key.
  const OWN_TEXTS = [
    ...FIXED_CORPUS.filter(text => text.length >= 32),
    `${RESULT_WITHHELD}${REDACTION_MARKER}`,
    `policy.enableWrites must be a boolean ${'z'.repeat(10)}`,
    `BILLY_ACCESS_TOKEN-${'7'.repeat(14)}`,
  ];
  const BROKEN: Array<Record<string, unknown>> = [
    {},
    { baseUrl: 'not a url' },
    { baseUrl: 'https://elsewhere.invalid/v2' },
    { accessToken: 'short' },
    { policy: { enableWrites: 'yes' } },
    { policy: { disabledTools: ['no_such_tool'] } },
  ];

  it('refuses a pseudonym key that shares text with ours, and no construction error shows a piece of it', () => {
    let checked = 0;
    for (const text of OWN_TEXTS) {
      for (const key of [text, new TextEncoder().encode(text)]) {
        for (const broken of BROKEN) {
          const { policy: brokenPolicy, ...rest } = broken as { policy?: Record<string, unknown> };
          const error = construct({ accessToken: TOKEN, baseUrl: BASE, ...rest, policy: { ...brokenPolicy, pseudonymKey: key } });
          expect(error, text).toBeInstanceOf(Error);
          expect(leaked(formsOf(key), [error!.message, error!.stack, error!.name, error]), text).toEqual([]);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('keeps an admitted pseudonym key out of construction errors, the tool list and every fixed output', () => {
    for (const key of [PSEUDONYM_KEY_1, Buffer.from('a7f3c91e5b2d8046f1e9c3a7b5d20864d18b6e2f4a9c07e35b1d8f62c4a09e17', 'hex')]) {
      for (const broken of BROKEN.slice(1)) {
        const { policy: brokenPolicy, ...rest } = broken as { policy?: Record<string, unknown> };
        const error = construct({ accessToken: TOKEN, baseUrl: BASE, ...rest, policy: { ...brokenPolicy, pseudonymKey: key } });
        expect(error).toBeInstanceOf(Error);
        expect(leaked(formsOf(key), [error!.message, error!.stack, error])).toEqual([]);
      }
      const gw = createBillyGateway({ accessToken: TOKEN, baseUrl: BASE, policy: { pseudonymKey: key } });
      expect(leaked(formsOf(key), [gw.tools, billyToolCatalog, fixedOutputs()])).toEqual([]);
    }
  });

  it('refuses a pseudonym key that is too short, as text or bytes', () => {
    for (const key of ['Qh7Vz2Lr9Xw4Nc8Tp3Yk6Bm', new Uint8Array(31)]) {
      const error = construct({ accessToken: TOKEN, baseUrl: BASE, policy: { pseudonymKey: key } });
      expect(error?.message).toMatch(/pseudonymKey/);
    }
  });

  it('keeps an admitted pseudonym key out of results, errors and audit records wherever Billy or the host puts it', async () => {
    const key = PSEUDONYM_KEY_1; // gitleaks:allow (a test constant, not a key)
    const records: unknown[] = [];
    const gw = createBillyGateway({
      accessToken: TOKEN,
      baseUrl: BASE,
      maxAttempts: 1,
      fetchImpl: (async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/contacts/c1')) return Response.json({ contact: { id: 'c1', name: key, street: key.slice(3, 20), cityText: `x${key}x` } });
        if (path.endsWith('/contacts/c2')) return Response.json({ errorMessage: key, errorCode: key }, { status: 400 });
        if (path.endsWith('/contacts/c3')) return new Response(null, { status: 302, headers: { location: `https://elsewhere.test/${key}` } });
        throw new TypeError(`fetch failed ${key}`);
      }) as typeof fetch,
      policy: { audit: record => void records.push(record), pseudonymKey: key },
    });
    const results = [];
    for (const contactId of ['c1', 'c2', 'c3', 'c4']) {
      results.push(await gw.callTool('get_contact', { contactId }, { caller: key, requestId: key }));
    }
    results.push(await gw.callTool(`get_${key}`, { [key]: key }, { caller: key }));
    results.push(await gw.callTool('get_contact', { contactId: 'c1', [key]: 1 }));
    results.push(await gw.callTool('get_contact', { contactId: key }));
    expect(results[0]?.isError).toBeUndefined();
    expect(leaked([key], [results, records])).toEqual([]);
  });
});

describe('after review 5: answers are checked before they are filtered', () => {
  const page = { meta: { paging: { page: 1, pageCount: 1 } } };

  it('refuses an integer field with a fraction', async () => {
    for (const [tool, input, routes] of [
      ['list_accounts', {}, { 'GET /accounts': { accounts: [{ id: 'a1', accountNo: 12.5 }], ...page } }],
      ['get_invoice', { invoiceId: 'i1' }, { 'GET /invoices/i1': { invoice: { id: 'i1', paymentTermsDays: 7.5 } } }],
    ] as Array<[string, GatewayJsonObject, Record<string, unknown>]>) {
      expect((await call(billy(routes).gw, tool, input)).isError, tool).toBe(true);
    }
  });

  it('refuses a list in which a record that would be filtered out has a field of the wrong type', async () => {
    for (const [tool, input, routes] of [
      ['list_contacts', { kind: 'customer' }, { 'GET /contacts': { contacts: [{ id: 'c1', isCustomer: 'true' }], ...page } }],
      ['list_contacts', {}, { 'GET /contacts': { contacts: [{ id: 'c1', isArchived: 'false' }], ...page } }],
      ['list_products', {}, { 'GET /products': { products: [{ id: 'p1', isArchived: 1 }], ...page } }],
      ['list_accounts', { bankAccountsOnly: true }, { 'GET /accounts': { accounts: [{ id: 'a1', isBankAccount: 'yes' }], ...page } }],
      ['list_tax_rates', {}, { 'GET /taxRates': { taxRates: [{ id: 't1', isActive: 'false' }], ...page } }],
      ['list_daybooks', {}, { 'GET /daybooks': { daybooks: [{ id: 'd1', name: 7 }], ...page } }],
    ] as Array<[string, GatewayJsonObject, Record<string, unknown>]>) {
      const result = await call(billy(routes).gw, tool, input);
      expect(result.isError, `${tool} ${JSON.stringify(routes)}`).toBe(true);
    }
  });

  it('keeps a record id in the audit only as a pseudonym, so a name given as an id is not there', async () => {
    const records: Array<Record<string, unknown>> = [];
    const gw = createBillyGateway({
      accessToken: TOKEN,
      baseUrl: BASE,
      fetchImpl: (async () => Response.json({ contact: { id: 'Anne-Marie-Hansen' } })) as typeof fetch,
      policy: { audit: record => void records.push({ ...record }), pseudonymKey: PSEUDONYM_KEY_2 }, // gitleaks:allow (a test constant, not a key)
    });
    await gw.callTool('get_contact', { contactId: 'Anne-Marie-Hansen' });
    expect(JSON.stringify(records)).not.toMatch(/Anne|Marie|Hansen/);
    expect((records[0]?.target as Record<string, unknown>).contactId).toMatch(/^hmac:[0-9a-f]{16}$/);
    expect((records[0]?.target as Record<string, unknown>).contactId).toBe((records.at(-1)?.target as Record<string, unknown>).contactId);
  });
});

describe('after review 6', () => {
  const page = { meta: { paging: { page: 1, pageCount: 1 } } };
  const products = [
    { id: 'p1', name: 'Kop', prices: [{ currencyId: 'DKK', unitPrice: 49 }] },
    { id: 'p2', name: 'Krus', prices: [null] },
    { id: 'p3', name: 'Tallerken', isArchived: true, prices: { bad: true } },
  ];

  it('refuses a product list in which a product that is not shown has an invalid price', async () => {
    for (const [label, list, input] of [
      ['search', products.slice(0, 2), { query: 'Kop' }],
      ['limit 1', products.slice(0, 2), { limit: 1 }],
      ['archived', [products[0], products[2]], {}],
    ] as Array<[string, unknown[], GatewayJsonObject]>) {
      const result = await call(billy({ 'GET /products': { products: list, ...page } }).gw, 'list_products', input);
      expect(result.isError, label).toBe(true);
    }
    const ok = await call(billy({ 'GET /products': { products: products.slice(0, 1), ...page } }).gw, 'list_products', { limit: 1 });
    expect(ok.structuredContent).toMatchObject({ products: [{ id: 'p1', prices: [{ currencyId: 'DKK', unitPrice: 49 }] }], complete: true });
  });
});

describe('after review 7', () => {
  it('refuses a pseudonym key that is not valid UTF-16, with the sealed refusal and no piece of it', () => {
    const pieces = (key: string) => Array.from({ length: key.length - 5 }, (_, i) => key.slice(i, i + 6));
    for (const key of [`Qh7Vz2Lr9Xw4Nc8T\uD800p3Yk6Bm1Fs5Jd0Ga`, `\uDC00Wy3Rk8Pq1Zt6Hv9Lc2Xn5Bg7Md4Js0Fe`, `Zr8qLw2Xv7NcT4pK9mYb3HsD6fJgQ1aE\uDBFF`]) {
      for (const broken of [{}, { baseUrl: 'not a url' }, { accessToken: 'short' }]) {
        let caught: Error | undefined;
        try {
          createBillyGateway({ accessToken: TOKEN, baseUrl: BASE, ...broken, policy: { pseudonymKey: key } } as never);
        } catch (error) {
          caught = error as Error;
        }
        expect(caught).toBeInstanceOf(Error);
        expect(caught!.name).toBe('ConfigError');
        expect(String(caught!.stack)).toBe(`${caught!.name}: ${caught!.message}`);
        const text = [caught!.message, caught!.stack, JSON.stringify(caught)].join(' ');
        for (const piece of pieces(key)) expect(text, piece).not.toContain(piece);
      }
    }
  });
});
