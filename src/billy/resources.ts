import { nestedFailuresAsStatus } from '../errors.js';
import { encodePathParam } from '../path-params.js';
import type { QueryValue, UpstreamClient } from './client.js';
import { isCurrency, lastFour } from './values.js';

/**
 * Calls to Billy's API v2 (https://www.billy.dk/api). Conventions from the
 * documentation, "Conventions" and "Relationships":
 *
 * - GET /v2/<plural>/:id answers `{ <singular>: {...} }`; GET /v2/<plural>
 *   answers `{ <plural>: [...], meta: { paging } }`.
 * - POST and PUT take `{ <singular>: {...} }` and answer every record that
 *   changed, under plural root keys; the created or updated record is among
 *   them.
 * - `include=<resource>.<property>:embed` puts has-many children in the
 *   record. Paging is `page` and `pageSize` (at most 1000).
 * - Unknown query parameters are ignored, not refused, so only documented
 *   filters are sent.
 *
 * Every caller-supplied path segment goes through encodePathParam. Every
 * body passes nestedFailuresAsStatus before it is shaped.
 */

export const MAX_PAGE_SIZE = 1000;
/** Lists that are read to the end and filtered here stop at this many records and say so. */
export const MAX_SCAN_RECORDS = 5000;

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? (value.map(asRecord).filter(Boolean) as Json[]) : [];
}

/** The fields of `record` that are listed, in that order, leaving out absent ones. */
function pick(record: Json, fields: readonly string[]): Json {
  const out: Json = {};
  for (const field of fields) {
    if (Object.hasOwn(record, field) && record[field] !== undefined) out[field] = record[field];
  }
  return out;
}

/** An answer from Billy that is not shaped as the documentation says: our own text, nothing of the answer. */
export class UnexpectedAnswerError extends Error {
  constructor() {
    super('Billy answered without the expected data. Nothing in the answer was used.');
    this.name = 'UnexpectedAnswerError';
  }
}

/** The record under a singular root key (`{ invoice: {...} }`). Anything else is refused. */
function single(body: unknown, key: string): Json {
  const record = asRecord(asRecord(body)?.[key]);
  if (!record) throw new UnexpectedAnswerError();
  return record;
}

/** The list under a plural root key (`{ invoices: [...] }`). Anything else is refused. */
function list(body: unknown, key: string): Json[] {
  const value = asRecord(body)?.[key];
  if (!Array.isArray(value)) throw new UnexpectedAnswerError();
  return asArray(value);
}

/**
 * The record a create or update made, from the plural root key of the
 * answer: the first one with a string id. An answer without one is refused,
 * so a write is never reported as done without the record it made.
 */
function firstChanged(body: unknown, key: string): Json {
  const changed = list(body, key).find(record => typeof record.id === 'string' && record.id !== '');
  if (!changed) throw new UnexpectedAnswerError();
  return changed;
}

function paging(body: unknown): Json | undefined {
  const meta = asRecord(asRecord(body)?.meta);
  const page = asRecord(meta?.paging);
  return page ? pick(page, ['page', 'pageCount', 'pageSize', 'total']) : undefined;
}

async function get(client: UpstreamClient, path: string, query?: Record<string, QueryValue>): Promise<unknown> {
  return nestedFailuresAsStatus(await client.get(path, query));
}

function idPath(resource: string, id: string, name: string): string {
  return `/${resource}/${encodePathParam(id, name)}`;
}

// ---------------------------------------------------------------------------
// Organization

const ORGANIZATION_FIELDS = [
  'id',
  'name',
  'street',
  'zipcode',
  'city',
  'countryId',
  'phone',
  'email',
  'registrationNo',
  'baseCurrencyId',
  'localeId',
  'fiscalYearEndMonth',
  'firstFiscalYearStart',
  'firstFiscalYearEnd',
  'hasVat',
  'vatPeriod',
  'defaultTaxMode',
  'paymentTermsMode',
  'paymentTermsDays',
  'isTrial',
  'isLocked',
  'isTerminated',
] as const;

/**
 * The company the token belongs to: GET /v2/organization, as Billy's own
 * code examples use it ("Gets the id of organization associated with the API
 * token"). Subscription, card and bank fields are left out.
 */
export async function getOrganization(client: UpstreamClient): Promise<Json> {
  return pick(single(await get(client, '/organization'), 'organization'), ORGANIZATION_FIELDS);
}

export async function checkConnection(client: UpstreamClient): Promise<Json> {
  const organization = single(await get(client, '/organization'), 'organization');
  return { connected: true, organization: pick(organization, ['id', 'name', 'isLocked']) };
}

// ---------------------------------------------------------------------------
// Read every page of a list and filter here (for resources without documented filters).

async function scanAll(
  client: UpstreamClient,
  path: string,
  key: string,
  query: Record<string, QueryValue> = {},
): Promise<{ records: Json[]; complete: boolean }> {
  const records: Json[] = [];
  for (let page = 1; records.length < MAX_SCAN_RECORDS; page += 1) {
    const body = await get(client, path, { ...query, page, pageSize: MAX_PAGE_SIZE });
    const page_ = list(body, key);
    records.push(...page_);
    const meta = paging(body);
    const pageCount = typeof meta?.pageCount === 'number' ? meta.pageCount : page;
    if (page_.length === 0 || page >= pageCount) return { records, complete: true };
  }
  return { records: records.slice(0, MAX_SCAN_RECORDS), complete: false };
}

function textMatches(record: Json, fields: readonly string[], query: string | undefined): boolean {
  if (!query) return true;
  const needle = query.toLocaleLowerCase('da');
  return fields.some(field => typeof record[field] === 'string' && (record[field] as string).toLocaleLowerCase('da').includes(needle));
}

// ---------------------------------------------------------------------------
// Contacts

const CONTACT_ROW = [
  'id',
  'type',
  'name',
  'contactNo',
  'registrationNo',
  'countryId',
  'zipcodeText',
  'cityText',
  'isCustomer',
  'isSupplier',
  'isArchived',
] as const;

const CONTACT_FIELDS = [
  ...CONTACT_ROW,
  'createdTime',
  'street',
  'stateText',
  'phone',
  'fax',
  'currencyId',
  'ean',
  'localeId',
  'paymentTermsMode',
  'paymentTermsDays',
  'emailAttachmentDeliveryMode',
] as const;

const CONTACT_PERSON_FIELDS = ['id', 'name', 'email', 'isPrimary'] as const;

export async function listContacts(
  client: UpstreamClient,
  input: { kind?: 'customer' | 'supplier' | 'all'; query?: string; includeArchived?: boolean; limit?: number },
): Promise<Json> {
  const { records, complete } = await scanAll(client, '/contacts', 'contacts');
  const kind = input.kind ?? 'all';
  const matches = records.filter(
    contact =>
      (input.includeArchived || contact.isArchived !== true) &&
      (kind === 'all' || (kind === 'customer' ? contact.isCustomer === true : contact.isSupplier === true)) &&
      textMatches(contact, ['name', 'contactNo', 'registrationNo'], input.query),
  );
  const limit = input.limit ?? 100;
  return {
    contacts: matches.slice(0, limit).map(contact => pick(contact, CONTACT_ROW)),
    matched: matches.length,
    shown: Math.min(limit, matches.length),
    complete,
  };
}

/**
 * One contact with its contact persons. `accessCode` (which makes the
 * customer portal address) is left out.
 */
export async function getContact(client: UpstreamClient, input: { contactId: string }): Promise<Json> {
  const contact = single(
    await get(client, idPath('contacts', input.contactId, 'contactId'), { include: 'contact.contactPersons:embed' }),
    'contact',
  );
  const persons = asArray(contact.contactPersons).map(person => pick(person, CONTACT_PERSON_FIELDS));
  return { ...pick(contact, CONTACT_FIELDS), ...(Array.isArray(contact.contactPersons) ? { contactPersons: persons } : {}) };
}

export interface ContactInput {
  type?: 'company' | 'person';
  name?: string;
  countryId?: string;
  street?: string;
  zipcodeText?: string;
  cityText?: string;
  contactNo?: string;
  phone?: string;
  registrationNo?: string;
  ean?: string;
  isCustomer?: boolean;
  isSupplier?: boolean;
  paymentTermsDays?: number;
}

const CONTACT_WRITABLE = [
  'type',
  'name',
  'countryId',
  'street',
  'zipcodeText',
  'cityText',
  'contactNo',
  'phone',
  'registrationNo',
  'ean',
  'isCustomer',
  'isSupplier',
  'paymentTermsDays',
] as const;

export async function createContact(
  client: UpstreamClient,
  input: ContactInput & { contactPersons?: Array<{ name?: string; email?: string; isPrimary?: boolean }> },
): Promise<Json> {
  const contact: Json = pick(input as unknown as Json, CONTACT_WRITABLE);
  if (input.contactPersons?.length) {
    contact.contactPersons = input.contactPersons.map(person => pick(person as unknown as Json, ['name', 'email', 'isPrimary']));
  }
  const body = nestedFailuresAsStatus(await client.post('/contacts', { contact }));
  return pick(firstChanged(body, 'contacts'), CONTACT_FIELDS);
}

/** Only the fields given are changed (PUT with a partial record, as the documentation describes). */
export async function updateContact(client: UpstreamClient, input: ContactInput & { contactId: string }): Promise<Json> {
  const contact = pick(input as unknown as Json, CONTACT_WRITABLE);
  const body = nestedFailuresAsStatus(await client.put(idPath('contacts', input.contactId, 'contactId'), { contact }));
  return pick(firstChanged(body, 'contacts'), CONTACT_FIELDS);
}

// ---------------------------------------------------------------------------
// Products

const PRODUCT_FIELDS = [
  'id',
  'name',
  'productNo',
  'suppliersProductNo',
  'description',
  'accountId',
  'salesTaxRulesetId',
  'isArchived',
] as const;

function shapeProduct(product: Json): Json {
  const prices = asArray(product.prices).map(price => pick(price, ['currencyId', 'unitPrice']));
  return { ...pick(product, PRODUCT_FIELDS), ...(Array.isArray(product.prices) ? { prices } : {}) };
}

export async function listProducts(
  client: UpstreamClient,
  input: { query?: string; includeArchived?: boolean; limit?: number },
): Promise<Json> {
  const { records, complete } = await scanAll(client, '/products', 'products', { include: 'product.prices:embed' });
  const matches = records.filter(
    product =>
      (input.includeArchived || product.isArchived !== true) &&
      textMatches(product, ['name', 'productNo', 'description'], input.query),
  );
  const limit = input.limit ?? 100;
  return {
    products: matches.slice(0, limit).map(shapeProduct),
    matched: matches.length,
    shown: Math.min(limit, matches.length),
    complete,
  };
}

export async function getProduct(client: UpstreamClient, input: { productId: string }): Promise<Json> {
  return shapeProduct(
    single(await get(client, idPath('products', input.productId, 'productId'), { include: 'product.prices:embed' }), 'product'),
  );
}

export interface ProductInput {
  name?: string;
  description?: string;
  productNo?: string;
  accountId?: string;
  salesTaxRulesetId?: string;
  prices?: Array<{ currencyId: string; unitPrice: number }>;
}

const PRODUCT_WRITABLE = ['name', 'description', 'productNo', 'accountId', 'salesTaxRulesetId'] as const;

function productBody(input: ProductInput): Json {
  const product = pick(input as unknown as Json, PRODUCT_WRITABLE);
  if (input.prices) product.prices = input.prices.map(price => ({ currencyId: price.currencyId, unitPrice: price.unitPrice }));
  return product;
}

export async function createProduct(client: UpstreamClient, input: ProductInput): Promise<Json> {
  const body = nestedFailuresAsStatus(await client.post('/products', { product: productBody(input) }));
  return shapeProduct(firstChanged(body, 'products'));
}

export async function updateProduct(client: UpstreamClient, input: ProductInput & { productId: string }): Promise<Json> {
  const body = nestedFailuresAsStatus(
    await client.put(idPath('products', input.productId, 'productId'), { product: productBody(input) }),
  );
  return shapeProduct(firstChanged(body, 'products'));
}

// ---------------------------------------------------------------------------
// Invoices and bills

const INVOICE_ROW = [
  'id',
  'type',
  'invoiceNo',
  'state',
  'sentState',
  'contactId',
  'entryDate',
  'dueDate',
  'currencyId',
  'amount',
  'tax',
  'balance',
  'isPaid',
  'lineDescription',
  'creditedInvoiceId',
  'approvedTime',
] as const;

const INVOICE_FIELDS = [
  ...INVOICE_ROW,
  'createdTime',
  'attContactPersonId',
  'paymentTermsMode',
  'paymentTermsDays',
  'taxMode',
  'exchangeRate',
  'contactMessage',
] as const;

const INVOICE_LINE_FIELDS = [
  'id',
  'productId',
  'description',
  'quantity',
  'unitPrice',
  'amount',
  'tax',
  'taxRateId',
  'discountText',
  'discountMode',
  'discountValue',
  'priority',
] as const;

function shapeInvoice(invoice: Json): Json {
  return {
    ...pick(invoice, INVOICE_FIELDS),
    ...(Array.isArray(invoice.lines) ? { lines: asArray(invoice.lines).map(line => pick(line, INVOICE_LINE_FIELDS)) } : {}),
  };
}

export interface ListQuery {
  page?: number;
  pageSize?: number;
  sortProperty?: string;
  sortDirection?: 'ASC' | 'DESC';
}

function listQuery(input: Json, filters: readonly string[]): Record<string, QueryValue> {
  const query: Record<string, QueryValue> = {};
  for (const name of [...filters, 'page', 'pageSize', 'sortProperty', 'sortDirection']) {
    const value = input[name];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') query[name] = value;
  }
  if (query.pageSize === undefined) query.pageSize = 100;
  return query;
}

export const INVOICE_FILTERS = [
  'contactId',
  'state',
  'isPaid',
  'invoiceNo',
  'minEntryDate',
  'maxEntryDate',
  'minDueDate',
  'maxDueDate',
  'q',
] as const;

export async function listInvoices(client: UpstreamClient, input: Json): Promise<Json> {
  const body = await get(client, '/invoices', listQuery(input, INVOICE_FILTERS));
  return {
    invoices: list(body, 'invoices').map(invoice => pick(invoice, INVOICE_ROW)),
    paging: paging(body) ?? null,
  };
}

export async function getInvoice(client: UpstreamClient, input: { invoiceId: string }): Promise<Json> {
  return shapeInvoice(
    single(await get(client, idPath('invoices', input.invoiceId, 'invoiceId'), { include: 'invoice.lines:embed' }), 'invoice'),
  );
}

const BILL_ROW = [
  'id',
  'type',
  'state',
  'contactId',
  'contactName',
  'suppliersInvoiceNo',
  'voucherNo',
  'entryDate',
  'dueDate',
  'currencyId',
  'amount',
  'tax',
  'balance',
  'isPaid',
  'lineDescription',
  'creditedBillId',
  'approvedTime',
] as const;

const BILL_FIELDS = [...BILL_ROW, 'createdTime', 'taxMode', 'exchangeRate', 'isBare', 'paymentDate'] as const;
const BILL_LINE_FIELDS = ['id', 'accountId', 'taxRateId', 'description', 'amount', 'tax', 'priority'] as const;

export const BILL_FILTERS = [
  'contactId',
  'state',
  'isPaid',
  'suppliersInvoiceNo',
  'minEntryDate',
  'maxEntryDate',
  'minDueDate',
  'maxDueDate',
  'q',
] as const;

export async function listBills(client: UpstreamClient, input: Json): Promise<Json> {
  const body = await get(client, '/bills', listQuery(input, BILL_FILTERS));
  return { bills: list(body, 'bills').map(bill => pick(bill, BILL_ROW)), paging: paging(body) ?? null };
}

export async function getBill(client: UpstreamClient, input: { billId: string }): Promise<Json> {
  const bill = single(await get(client, idPath('bills', input.billId, 'billId'), { include: 'bill.lines:embed' }), 'bill');
  return {
    ...pick(bill, BILL_FIELDS),
    ...(Array.isArray(bill.lines) ? { lines: asArray(bill.lines).map(line => pick(line, BILL_LINE_FIELDS)) } : {}),
  };
}

export interface InvoiceDraftInput {
  contactId: string;
  entryDate: string;
  currencyId?: string;
  paymentTermsDays?: number;
  taxMode?: 'incl' | 'excl';
  contactMessage?: string;
  lines: Array<{ productId: string; description?: string; quantity?: number; unitPrice: number }>;
}

/**
 * A new invoice as a draft: `state` is always "draft", whatever the input.
 * Nothing is booked, emailed or sent as an e-invoice.
 */
export async function createDraftInvoice(client: UpstreamClient, input: InvoiceDraftInput): Promise<Json> {
  const invoice: Json = {
    ...pick(input as unknown as Json, ['contactId', 'entryDate', 'currencyId', 'paymentTermsDays', 'taxMode', 'contactMessage']),
    state: 'draft',
    lines: input.lines.map((line, index) => ({
      ...pick(line as unknown as Json, ['productId', 'description', 'quantity', 'unitPrice']),
      priority: index + 1,
    })),
  };
  const body = nestedFailuresAsStatus(await client.post('/invoices', { invoice }));
  return shapeInvoice(firstChanged(body, 'invoices'));
}

/**
 * Approve (book) a draft invoice: reads it first and refuses, without
 * sending anything, unless it is a draft. The documentation: "Currently the
 * only state change possible is from draft to approved. Once an invoice has
 * been approved, its state can't be changed." Approval does not email the
 * invoice or send it as an e-invoice; those are separate endpoints this
 * server does not call.
 */
export async function approveInvoice(client: UpstreamClient, input: { invoiceId: string }): Promise<Json> {
  const path = idPath('invoices', input.invoiceId, 'invoiceId');
  const current = single(await get(client, path), 'invoice');
  if (current.state !== 'draft') {
    throw new Error('Refused: only a draft invoice can be approved, and this invoice is not a draft. Nothing was sent.');
  }
  const body = nestedFailuresAsStatus(await client.put(path, { invoice: { state: 'approved' } }));
  return shapeInvoice(firstChanged(body, 'invoices'));
}

// ---------------------------------------------------------------------------
// Payments (registered in the books; no money is moved)

export interface PaymentInput {
  invoiceId?: string;
  billId?: string;
  cashAccountId: string;
  amount: number;
  entryDate: string;
}

/**
 * Register a payment of an approved invoice (money in) or bill (money out)
 * with POST /v2/bankPayments, as in the documentation's "Posting a payment
 * for an invoice". It records the payment in the books; it moves no money.
 *
 * Read first, and refused without sending anything when: the invoice or bill
 * is not approved or is already paid, the amount is more than its balance,
 * or the account is not a payment account (isPaymentEnabled) in the same
 * currency (a foreign-currency payment needs an exchange rate, which this
 * tool does not take).
 */
export async function registerPayment(client: UpstreamClient, input: PaymentInput): Promise<Json> {
  const isInvoice = input.invoiceId !== undefined;
  const subjectId = (isInvoice ? input.invoiceId : input.billId) as string;
  const kind = isInvoice ? 'invoice' : 'bill';
  // One registration at a time per company and document in this process: the balance is read again after the
  // previous one has finished, so two calls cannot both pass the check against the same balance.
  return serialised(`${client.lockScope()}:${kind}:${subjectId}`, async () => {
    const subject = isInvoice
      ? single(await get(client, idPath('invoices', subjectId, 'invoiceId')), 'invoice')
      : single(await get(client, idPath('bills', subjectId, 'billId')), 'bill');
    if (subject.state !== 'approved') throw new Error(`Refused: the ${kind} is not approved. Nothing was sent.`);
    if (subject.isPaid === true) throw new Error(`Refused: the ${kind} is already paid. Nothing was sent.`);
    // Credit notes are refused: a payment here is always money in for an invoice and money out for a bill.
    if (isInvoice ? subject.type !== 'invoice' : subject.type !== undefined && subject.type !== 'bill') {
      throw new Error(`Refused: this is not an ordinary ${kind} (a credit note, or a type this server does not know). Nothing was sent.`);
    }
    if (typeof subject.balance !== 'number' || !Number.isFinite(subject.balance) || subject.balance <= 0) {
      throw new Error(`Refused: the ${kind} has no positive outstanding balance. Nothing was sent.`);
    }
    if (input.amount > subject.balance + 0.005) {
      throw new Error(`Refused: the amount is more than the ${kind}'s outstanding balance. Nothing was sent.`);
    }
    const account = single(await get(client, idPath('accounts', input.cashAccountId, 'cashAccountId')), 'account');
    if (account.isPaymentEnabled !== true) {
      throw new Error('Refused: the account is not set up for payments in Billy (isPaymentEnabled). Nothing was sent.');
    }
    if (!isCurrency(account.currencyId) || !isCurrency(subject.currencyId)) {
      throw new Error(`Refused: the currency of the account or the ${kind} is not known. Nothing was sent.`);
    }
    if (account.currencyId !== subject.currencyId) {
      throw new Error(`Refused: the account and the ${kind} are in different currencies. Nothing was sent.`);
    }
    const bankPayment = {
      entryDate: input.entryDate,
      cashAmount: input.amount,
      cashSide: isInvoice ? 'debit' : 'credit',
      cashAccountId: input.cashAccountId,
      associations: [{ subjectReference: `${kind}:${subjectId}` }],
    };
    const body = nestedFailuresAsStatus(await client.post('/bankPayments', { bankPayment }));
    return {
      bankPayment: pick(firstChanged(body, 'bankPayments'), [
        'id',
        'contactId',
        'entryDate',
        'cashAmount',
        'cashSide',
        'cashAccountId',
        'subjectCurrencyId',
        'isVoided',
      ]),
    };
  });
}

/** Work in flight per key, in this process only. A key holds no secret (see lockScope) and is dropped when done. */
const inFlight = new Map<string, Promise<unknown>>();

async function serialised<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = inFlight.get(key) ?? Promise.resolve();
  const run = before.catch(() => undefined).then(work);
  const tail = run.catch(() => undefined);
  inFlight.set(key, tail);
  try {
    return await run;
  } finally {
    if (inFlight.get(key) === tail) inFlight.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Chart of accounts, postings, daybooks, tax rates (read only, except draft daybook transactions)

const ACCOUNT_FIELDS = [
  'id',
  'accountNo',
  'name',
  'description',
  'groupId',
  'natureId',
  'systemRole',
  'currencyId',
  'taxRateId',
  'isPaymentEnabled',
  'isBankAccount',
  'isArchived',
] as const;

/** An account, with its bank details reduced to the last four characters of the account number and IBAN. */
function shapeAccount(account: Json): Json {
  const out = pick(account, ACCOUNT_FIELDS);
  const accountNo = lastFour(account.bankAccountNo);
  const iban = lastFour(account.bankIban);
  if (accountNo) out.bankAccountNoLast4 = accountNo;
  if (iban) out.bankIbanLast4 = iban;
  return out;
}

export async function listAccounts(
  client: UpstreamClient,
  input: { bankAccountsOnly?: boolean; paymentEnabledOnly?: boolean; includeArchived?: boolean; query?: string },
): Promise<Json> {
  // isBankAccount is the filter the documentation names under bank lines ("GET /v2/accounts?isBankAccount=true").
  const { records, complete } = await scanAll(client, '/accounts', 'accounts', input.bankAccountsOnly ? { isBankAccount: true } : {});
  const accounts = records.filter(
    account =>
      (input.includeArchived || account.isArchived !== true) &&
      (!input.bankAccountsOnly || account.isBankAccount === true) &&
      (!input.paymentEnabledOnly || account.isPaymentEnabled === true) &&
      (!input.query || textMatches(account, ['name', 'description'], input.query) || String(account.accountNo ?? '') === input.query),
  );
  return { accounts: accounts.map(shapeAccount), complete };
}

export const POSTING_FILTERS = ['accountId', 'transactionId', 'minEntryDate', 'maxEntryDate', 'isVoided', 'q'] as const;
const POSTING_FIELDS = [
  'id',
  'transactionId',
  'entryDate',
  'text',
  'accountId',
  'amount',
  'side',
  'currencyId',
  'isVoided',
  'isBankMatched',
] as const;

export async function listPostings(client: UpstreamClient, input: Json): Promise<Json> {
  const body = await get(client, '/postings', listQuery(input, POSTING_FILTERS));
  return { postings: list(body, 'postings').map(posting => pick(posting, POSTING_FIELDS)), paging: paging(body) ?? null };
}

export async function listDaybooks(client: UpstreamClient): Promise<Json> {
  const { records, complete } = await scanAll(client, '/daybooks', 'daybooks');
  return { daybooks: records.map(daybook => pick(daybook, ['id', 'name', 'defaultContraAccountId'])), complete };
}

export const DAYBOOK_TRANSACTION_FILTERS = ['daybookId', 'state', 'minEntryDate', 'maxEntryDate', 'q'] as const;
const DAYBOOK_TRANSACTION_FIELDS = [
  'id',
  'daybookId',
  'entryDate',
  'voucherNo',
  'description',
  'state',
  'createdTime',
] as const;
const DAYBOOK_LINE_FIELDS = ['id', 'text', 'accountId', 'contraAccountId', 'taxRateId', 'amount', 'side', 'currencyId', 'priority'] as const;

function shapeDaybookTransaction(transaction: Json): Json {
  return {
    ...pick(transaction, DAYBOOK_TRANSACTION_FIELDS),
    ...(Array.isArray(transaction.lines) ? { lines: asArray(transaction.lines).map(line => pick(line, DAYBOOK_LINE_FIELDS)) } : {}),
  };
}

export async function listDaybookTransactions(client: UpstreamClient, input: Json): Promise<Json> {
  const body = await get(client, '/daybookTransactions', {
    ...listQuery(input, DAYBOOK_TRANSACTION_FILTERS),
    include: 'daybookTransaction.lines:embed',
  });
  return {
    daybookTransactions: list(body, 'daybookTransactions').map(shapeDaybookTransaction),
    paging: paging(body) ?? null,
  };
}

export interface DaybookTransactionInput {
  daybookId?: string;
  entryDate: string;
  voucherNo?: string;
  description?: string;
  lines: Array<{
    accountId: string;
    contraAccountId?: string;
    taxRateId?: string;
    amount: number;
    side: 'debit' | 'credit';
    text?: string;
  }>;
}

/**
 * A daybook transaction (kassekladde) left as a draft: `state` is not sent,
 * and the documentation gives "draft" as its default. A person approves it in
 * Billy; this server cannot.
 */
export async function createDaybookTransaction(client: UpstreamClient, input: DaybookTransactionInput): Promise<Json> {
  const daybookTransaction: Json = {
    ...pick(input as unknown as Json, ['daybookId', 'entryDate', 'voucherNo', 'description']),
    lines: input.lines.map((line, index) => ({
      ...pick(line as unknown as Json, ['accountId', 'contraAccountId', 'taxRateId', 'amount', 'side', 'text']),
      priority: index + 1,
    })),
  };
  const body = nestedFailuresAsStatus(await client.post('/daybookTransactions', { daybookTransaction }));
  return shapeDaybookTransaction(firstChanged(body, 'daybookTransactions'));
}

export async function listTaxRates(client: UpstreamClient, input: { includeInactive?: boolean }): Promise<Json> {
  const { records, complete } = await scanAll(client, '/taxRates', 'taxRates');
  return {
    taxRates: records
      .filter(rate => input.includeInactive || rate.isActive !== false)
      .map(rate => pick(rate, ['id', 'name', 'abbreviation', 'rate', 'appliesToSales', 'appliesToPurchases', 'isActive'])),
    complete,
  };
}
