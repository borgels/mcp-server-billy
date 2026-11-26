import { nestedFailuresAsStatus } from '../errors.js';
import { encodePathParam } from '../path-params.js';
import type { QueryValue, UploadContentType, UpstreamClient } from './client.js';
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

/**
 * The records of an embedded list (lines, contact persons, prices) when the
 * answer has one: undefined when the field is absent or null, the records
 * when it is a list. Anything else in its place (an object, a text), or an
 * entry that is not a record, refuses the answer: a list is never left out
 * without a word.
 */
function embedded(value: unknown): Json[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new UnexpectedAnswerError();
  const records = value.map(asRecord);
  if (records.some(entry => entry === undefined)) throw new UnexpectedAnswerError();
  return records as Json[];
}

/**
 * The type of each field this server passes on, from the property tables of
 * Billy's API v2 documentation (https://www.billy.dk/api): amounts, rates,
 * counts and paging are numbers, `is*`, `has*` and `appliesTo*` are
 * booleans, an account's `accountNo` is an integer, everything else (ids,
 * dates, numbers the company chose, states, modes, names, texts) is a
 * string. `invoiceNo` is a string in the property table and an integer in
 * the examples, so both are taken. Any field may be null.
 */
const STRING_OR_NUMBER_FIELDS = new Set(['invoiceNo']);
const NUMBER_FIELDS = new Set([
  'cashAmount',
  'fileSize',
  'cashExchangeRate',
  'feeAmount',
  'accountNo',
  'amount',
  'balance',
  'tax',
  'unitPrice',
  'quantity',
  'discountValue',
  'exchangeRate',
  'rate',
  'priority',
  'paymentTermsDays',
  'fiscalYearEndMonth',
  'page',
  'pageCount',
  'pageSize',
  'total',
]);
const BOOLEAN_FIELDS = new Set([
  'hasVat',
  'isActive',
  'isArchived',
  'isBankAccount',
  'isBankMatched',
  'isBare',
  'isCustomer',
  'isLocked',
  'isPaid',
  'isPaymentEnabled',
  'isPrimary',
  'isSupplier',
  'isTerminated',
  'isTrial',
  'isVoided',
  'appliesToPurchases',
  'appliesToSales',
]);

/** The number fields that are integers in the property tables (`integer`, not `float`), and the paging counts. */
const INTEGER_FIELDS = new Set(['accountNo', 'fileSize', 'priority', 'paymentTermsDays', 'fiscalYearEndMonth', 'page', 'pageCount', 'pageSize', 'total']);

/** Whether `value` has the documented type of `field` (or is null). */
function hasFieldType(field: string, value: unknown): boolean {
  if (value === null) return true;
  if (INTEGER_FIELDS.has(field)) return Number.isSafeInteger(value);
  if (STRING_OR_NUMBER_FIELDS.has(field)) return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
  if (NUMBER_FIELDS.has(field)) return typeof value === 'number' && Number.isFinite(value);
  if (BOOLEAN_FIELDS.has(field)) return typeof value === 'boolean';
  return typeof value === 'string';
}

/**
 * The fields of `record` that are listed, in that order, leaving out absent
 * ones. A field of another type than documented (an amount as text, a flag
 * as text, a state as a number, an object anywhere) refuses the answer.
 */
function pick(record: Json, fields: readonly string[]): Json {
  const out: Json = {};
  for (const field of fields) {
    if (!Object.hasOwn(record, field) || record[field] === undefined) continue;
    const value = record[field];
    if (!hasFieldType(field, value)) throw new UnexpectedAnswerError();
    out[field] = value;
  }
  return out;
}

/** The `lines` of a record, shaped, when the answer has them (see embedded). */
function lines(value: unknown, fields: readonly string[]): { lines?: Json[] } {
  const records = embedded(value);
  return records ? { lines: records.map(line => pick(line, fields)) } : {};
}

/** An answer from Billy that is not shaped as the documentation says: our own text, nothing of the answer. */
export class UnexpectedAnswerError extends Error {
  constructor() {
    super('Billy answered without the expected data. Nothing in the answer was used.');
    this.name = 'UnexpectedAnswerError';
  }
}

/** A record with an id: Billy's ids are non-empty strings. */
function hasId(record: Json | undefined): record is Json {
  return record !== undefined && typeof record.id === 'string' && record.id !== '';
}

/**
 * The record under a singular root key (`{ invoice: {...} }`), with an id;
 * with `expectedId`, the id that was asked for. Anything else is refused.
 */
function single(body: unknown, key: string, expectedId?: string): Json {
  const record = asRecord(asRecord(body)?.[key]);
  if (!hasId(record) || (expectedId !== undefined && record.id !== expectedId)) throw new UnexpectedAnswerError();
  return record;
}

/**
 * The list under a plural root key (`{ invoices: [...] }`). Every entry must
 * be a record with an id: one entry that is not refuses the whole answer,
 * rather than leaving it out without a word.
 */
function list(body: unknown, key: string): Json[] {
  const value = asRecord(body)?.[key];
  if (!Array.isArray(value)) throw new UnexpectedAnswerError();
  const records = value.map(asRecord);
  if (!records.every(hasId)) throw new UnexpectedAnswerError();
  return records as Json[];
}

/**
 * The record a create or update made, from the plural root key of the
 * answer: the first one with a string id. An answer without one is refused,
 * so a write is never reported as done without the record it made.
 */
function firstChanged(body: unknown, key: string, expectedId?: string): Json {
  const [changed] = list(body, key);
  if (!changed || (expectedId !== undefined && changed.id !== expectedId)) throw new UnexpectedAnswerError();
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
  fields: readonly string[],
  query: Record<string, QueryValue> = {},
): Promise<{ records: Json[]; complete: boolean }> {
  const records: Json[] = [];
  for (let page = 1; records.length < MAX_SCAN_RECORDS; page += 1) {
    const body = await get(client, path, { ...query, page, pageSize: MAX_PAGE_SIZE });
    const page_ = list(body, key);
    // Every record is checked before it is filtered or counted: a field of another type than documented (a flag
    // as text, say) refuses the answer rather than leaving the record out of the matches without a word.
    for (const record of page_) pick(record, fields);
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
  const { records, complete } = await scanAll(client, '/contacts', 'contacts', CONTACT_FIELDS);
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
  const contact = single(await get(client, idPath('contacts', input.contactId, 'contactId'), { include: 'contact.contactPersons:embed' }), 'contact', input.contactId);
  const persons = embedded(contact.contactPersons)?.map(person => pick(person, CONTACT_PERSON_FIELDS));
  return { ...pick(contact, CONTACT_FIELDS), ...(persons ? { contactPersons: persons } : {}) };
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
  return pick(firstChanged(body, 'contacts', input.contactId), CONTACT_FIELDS);
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
  const prices = embedded(product.prices)?.map(price => pick(price, ['currencyId', 'unitPrice']));
  return { ...pick(product, PRODUCT_FIELDS), ...(prices ? { prices } : {}) };
}

export async function listProducts(
  client: UpstreamClient,
  input: { query?: string; includeArchived?: boolean; limit?: number },
): Promise<Json> {
  const { records, complete } = await scanAll(client, '/products', 'products', PRODUCT_FIELDS, { include: 'product.prices:embed' });
  // Every product is shaped, its embedded prices included, before it is searched, filtered or cut at the limit:
  // an invalid price on a product that is not shown refuses the answer too.
  const shaped = records.map(product => ({ product, row: shapeProduct(product) }));
  const matches = shaped.filter(
    ({ product }) =>
      (input.includeArchived || product.isArchived !== true) &&
      textMatches(product, ['name', 'productNo', 'description'], input.query),
  );
  const limit = input.limit ?? 100;
  return {
    products: matches.slice(0, limit).map(({ row }) => row),
    matched: matches.length,
    shown: Math.min(limit, matches.length),
    complete,
  };
}

export async function getProduct(client: UpstreamClient, input: { productId: string }): Promise<Json> {
  return shapeProduct(
    single(await get(client, idPath('products', input.productId, 'productId'), { include: 'product.prices:embed' }), 'product', input.productId),
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
  return shapeProduct(firstChanged(body, 'products', input.productId));
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
    ...lines(invoice.lines, INVOICE_LINE_FIELDS),
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
    single(await get(client, idPath('invoices', input.invoiceId, 'invoiceId'), { include: 'invoice.lines:embed' }), 'invoice', input.invoiceId),
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
  const bill = single(await get(client, idPath('bills', input.billId, 'billId'), { include: 'bill.lines:embed' }), 'bill', input.billId);
  return {
    ...pick(bill, BILL_FIELDS),
    ...lines(bill.lines, BILL_LINE_FIELDS),
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
  const current = single(await get(client, path), 'invoice', input.invoiceId);
  if (current.state !== 'draft') {
    throw new Error('Refused: only a draft invoice can be approved, and this invoice is not a draft. Nothing was sent.');
  }
  const body = nestedFailuresAsStatus(await client.put(path, { invoice: { state: 'approved' } }));
  return shapeInvoice(firstChanged(body, 'invoices', input.invoiceId));
}

export interface InvoiceDraftUpdateInput {
  invoiceId: string;
  entryDate?: string;
  paymentTermsDays?: number;
  taxMode?: 'incl' | 'excl';
  contactMessage?: string;
  lines?: InvoiceDraftInput['lines'];
}

/**
 * Change a draft invoice with PUT /v2/invoices/:id: only the fields given
 * ("Only properties that you set in the `invoice` hash will be updated").
 * Lines, when given, replace the invoice's lines ("If this parameter is set,
 * any existing lines for this invoice will be deleted before adding the new
 * ones"). The documentation also says of `entryDate` and `lines` that they
 * "must not be set if the invoice has already been created", but marks
 * neither immutable; they are sent, and Billy's status is returned if it
 * refuses them. The customer is not changed: the documentation marks
 * `contact` immutable. Read just before the PUT, and refused without sending anything
 * unless it is an ordinary invoice (not a credit note) in state "draft" with
 * no approval time. `state` is never sent, so the draft stays a draft.
 */
export async function updateInvoiceDraft(client: UpstreamClient, input: InvoiceDraftUpdateInput): Promise<Json> {
  const path = idPath('invoices', input.invoiceId, 'invoiceId');
  const current = single(await get(client, path), 'invoice', input.invoiceId);
  if (current.state !== 'draft' || !neverApproved(current)) {
    throw new Error('Refused: only a draft invoice can be changed, and this invoice is not a draft. Nothing was sent.');
  }
  if (current.type !== 'invoice') {
    throw new Error(
      'Refused: only an ordinary draft invoice can be changed here, not a draft credit note. Delete the draft credit note and make a new one. Nothing was sent.',
    );
  }
  const invoice: Json = pick(input as unknown as Json, ['entryDate', 'paymentTermsDays', 'taxMode', 'contactMessage']);
  if (input.lines) {
    invoice.lines = input.lines.map((line, index) => ({
      ...pick(line as unknown as Json, ['productId', 'description', 'quantity', 'unitPrice']),
      priority: index + 1,
    }));
  }
  const body = nestedFailuresAsStatus(await client.put(path, { invoice }));
  return shapeInvoice(firstChanged(body, 'invoices', input.invoiceId));
}

export interface CreditNoteInput {
  invoiceId: string;
  entryDate: string;
  contactMessage?: string;
  lines?: Array<{ lineId: string; quantity?: number; unitPrice?: number }>;
}

/** A line of the invoice being credited, with the fields a credit note line is made from. */
function creditableLine(line: Json): Json & { id: string; productId: string; quantity: number; unitPrice: number } {
  const quantity = line.quantity === undefined || line.quantity === null ? 1 : line.quantity;
  if (
    typeof line.id !== 'string' ||
    typeof line.productId !== 'string' ||
    line.productId === '' ||
    typeof quantity !== 'number' ||
    !Number.isFinite(quantity) ||
    typeof line.unitPrice !== 'number' ||
    !Number.isFinite(line.unitPrice)
  ) {
    throw new UnexpectedAnswerError();
  }
  return { ...line, id: line.id, productId: line.productId, quantity, unitPrice: line.unitPrice };
}

/** Whether a line carries a discount (a discount mode is set). */
function hasDiscount(line: Json): boolean {
  return typeof line.discountMode === 'string' && line.discountMode !== '';
}

/**
 * A credit note for an approved invoice, as a draft: POST /v2/invoices with
 * `type: "creditNote"` and `creditedInvoiceId` (the invoices resource:
 * "Whether to create an invoice or a credit note", and the `creditedInvoice`
 * belongs-to). The documentation does not give the type's literal values;
 * "creditNote" is assumed. The customer, currency, VAT mode, exchange rate
 * and payment terms (mode and days) are those of the invoice. Lines are copied from the invoice's lines
 * with positive quantities and prices, as on the invoice: the credit note's
 * type is what makes them a credit.
 *
 * Without `lines` the whole invoice is credited; that is refused when the
 * invoice already has a credit note that is not voided. With `lines`, only
 * those lines of the invoice, each with at most its quantity and unit price; a
 * line with a discount can only be credited whole. Read first, and refused
 * without sending anything unless the invoice is an ordinary invoice (not a
 * credit note) in state "approved". `state` is always "draft": it is approved
 * with approve_invoice and e-mailed with send_invoice, as an invoice is.
 */
export async function createCreditNote(client: UpstreamClient, input: CreditNoteInput): Promise<Json> {
  const source = single(
    await get(client, idPath('invoices', input.invoiceId, 'invoiceId'), { include: 'invoice.lines:embed' }),
    'invoice',
    input.invoiceId,
  );
  if (source.state !== 'approved') {
    throw new Error('Refused: only an approved (booked) invoice can be credited, and this invoice is not approved. Nothing was sent.');
  }
  if (source.type !== 'invoice') {
    throw new Error('Refused: only an ordinary invoice can be credited, not a credit note. Nothing was sent.');
  }
  const sourceLines = (embedded(source.lines) ?? []).map(creditableLine);
  if (sourceLines.length === 0) throw new UnexpectedAnswerError();

  let creditLines: Json[];
  if (input.lines === undefined) {
    // The documented filter on the invoices list: "Filter by creditedInvoiceId belonging to a specific Invoice". Every
    // page is read; when there are more than MAX_SCAN_RECORDS, the credit is refused rather than judged on a part.
    const { records: earlier, complete } = await scanAll(client, '/invoices', 'invoices', ['id', 'type', 'state', 'creditedInvoiceId'], {
      creditedInvoiceId: input.invoiceId,
    });
    if (!complete) {
      throw new Error('Refused: this invoice has too many credit notes to check them all. Credit selected lines instead. Nothing was sent.');
    }
    if (earlier.some(note => note.creditedInvoiceId === input.invoiceId && note.state !== 'voided')) {
      throw new Error(
        'Refused: this invoice already has a credit note. Credit selected lines instead, or void the earlier credit note in Billy. Nothing was sent.',
      );
    }
    creditLines = sourceLines.map(line => creditLine(line));
  } else {
    creditLines = input.lines.map(selection => {
      const line = sourceLines.find(candidate => candidate.id === selection.lineId);
      if (!line) throw new Error('Refused: a line given is not a line of this invoice. Nothing was sent.');
      const quantity = selection.quantity ?? line.quantity;
      const unitPrice = selection.unitPrice ?? line.unitPrice;
      if (quantity > line.quantity || unitPrice > line.unitPrice) {
        throw new Error("Refused: a line's quantity or unit price is more than on the invoice. Nothing was sent.");
      }
      if (hasDiscount(line) && (quantity !== line.quantity || unitPrice !== line.unitPrice)) {
        throw new Error('Refused: a line with a discount can only be credited whole. Nothing was sent.');
      }
      return creditLine(line, quantity, unitPrice);
    });
  }

  const invoice: Json = {
    type: 'creditNote',
    creditedInvoiceId: input.invoiceId,
    ...pick(source, ['contactId', 'currencyId', 'paymentTermsMode', 'paymentTermsDays', 'taxMode', 'exchangeRate']),
    entryDate: input.entryDate,
    ...(input.contactMessage === undefined ? {} : { contactMessage: input.contactMessage }),
    state: 'draft',
    lines: creditLines.map((line, index) => ({ ...line, priority: index + 1 })),
  };
  const body = nestedFailuresAsStatus(await client.post('/invoices', { invoice }));
  return shapeInvoice(firstChanged(body, 'invoices'));
}

/** A credit note line from an invoice line: product, text, quantity, unit price and any discount. */
function creditLine(line: Json & { quantity: number; unitPrice: number }, quantity = line.quantity, unitPrice = line.unitPrice): Json {
  return {
    ...pick(line, ['productId', 'description']),
    quantity,
    unitPrice,
    ...(hasDiscount(line) ? pick(line, ['discountText', 'discountMode', 'discountValue']) : {}),
  };
}

// ---------------------------------------------------------------------------
// Sending an approved invoice, bills and their files, deleting drafts

/**
 * E-mail an approved invoice to one of its customer's contact persons, with
 * POST /v2/invoices/:id/emails as the documentation's "Sending emails for
 * invoices" shows it ({ email: { contactPersonId, emailSubject, emailBody } }).
 * Read first, and refused without sending anything unless the invoice is an
 * approved invoice or credit note and the contact person belongs to the
 * invoice's customer and has an e-mail address. The documentation gives no
 * answer shape, so only the invoice's id and the contact person's id are
 * returned.
 */
export async function sendInvoiceEmail(
  client: UpstreamClient,
  input: { invoiceId: string; contactPersonId: string; emailSubject: string; emailBody: string },
): Promise<Json> {
  const path = idPath('invoices', input.invoiceId, 'invoiceId');
  const invoice = single(await get(client, path), 'invoice', input.invoiceId);
  if (invoice.state !== 'approved') {
    throw new Error('Refused: only an approved invoice can be sent, and this invoice is not approved. Nothing was sent.');
  }
  const person = single(
    await get(client, idPath('contactPersons', input.contactPersonId, 'contactPersonId')),
    'contactPerson',
    input.contactPersonId,
  );
  if (typeof invoice.contactId !== 'string' || invoice.contactId === '' || person.contactId !== invoice.contactId) {
    throw new Error("Refused: the contact person does not belong to the invoice's customer. Nothing was sent.");
  }
  if (typeof person.email !== 'string' || !person.email.includes('@')) {
    throw new Error('Refused: the contact person has no e-mail address in Billy. Nothing was sent.');
  }
  const email = { contactPersonId: input.contactPersonId, emailSubject: input.emailSubject, emailBody: input.emailBody };
  nestedFailuresAsStatus(await client.post(`${path}/emails`, { email }));
  return { sent: true, invoiceId: input.invoiceId, contactPersonId: input.contactPersonId };
}

export interface BillDraftInput {
  contactId: string;
  entryDate: string;
  dueDate?: string;
  currencyId: string;
  suppliersInvoiceNo?: string;
  voucherNo?: string;
  taxMode?: 'incl' | 'excl';
  lines: Array<{ accountId: string; taxRateId: string; description: string; amount: number }>;
}

function shapeBill(bill: Json): Json {
  return { ...pick(bill, BILL_FIELDS), ...lines(bill.lines, BILL_LINE_FIELDS) };
}

/**
 * A new bill (purchase voucher) as a draft: `state` is always "draft",
 * whatever the input. Each line has the account, the VAT rate, a text and the
 * amount: the required fields of a bill line in the documentation (billLines).
 *
 * `paymentDate` and `paymentAccount` are not sent. In the bills table they
 * describe a bill paid at once from a payment account (a payment, which this
 * server registers only with register_payment).
 * The table marks paymentDate "immutable, required", as it marks fields Billy
 * fills itself (an invoice's invoiceNo and sentState); the web app makes an
 * unpaid bill without it. If Billy refuses a bill without it, the call fails
 * with Billy's status and nothing is created.
 */
export async function createDraftBill(client: UpstreamClient, input: BillDraftInput): Promise<Json> {
  const bill: Json = {
    ...pick(input as unknown as Json, ['contactId', 'entryDate', 'dueDate', 'currencyId', 'suppliersInvoiceNo', 'voucherNo', 'taxMode']),
    state: 'draft',
    lines: input.lines.map((line, index) => ({
      ...pick(line as unknown as Json, ['accountId', 'taxRateId', 'description', 'amount']),
      priority: index + 1,
    })),
  };
  const body = nestedFailuresAsStatus(await client.post('/bills', { bill }));
  return shapeBill(firstChanged(body, 'bills'));
}

/**
 * Approve (book) a draft bill: reads it first and refuses, without sending
 * anything, unless it is a draft. A PUT with only the state, as the
 * documentation describes an update.
 */
export async function approveBill(client: UpstreamClient, input: { billId: string }): Promise<Json> {
  const path = idPath('bills', input.billId, 'billId');
  const current = single(await get(client, path), 'bill', input.billId);
  if (current.state !== 'draft') {
    throw new Error('Refused: only a draft bill can be approved, and this bill is not a draft. Nothing was sent.');
  }
  const body = nestedFailuresAsStatus(await client.put(path, { bill: { state: 'approved' } }));
  return shapeBill(firstChanged(body, 'bills', input.billId));
}

/** The file types a bill's file may have: by the first bytes of the file, never by the name given. */
const FILE_TYPES: ReadonlyArray<{ type: UploadContentType; extensions: readonly string[]; magic: readonly number[] }> = [
  { type: 'application/pdf', extensions: ['pdf'], magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { type: 'image/png', extensions: ['png'], magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'image/jpeg', extensions: ['jpg', 'jpeg'], magic: [0xff, 0xd8, 0xff] },
];

/** Largest file a bill takes through this server, in bytes. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Attach a file (the supplier's invoice or a receipt: PDF, PNG or JPEG) to a
 * bill. The file is checked first (size, type by its first bytes, a name
 * ending that matches), then the bill is read and must not be voided. Then
 * the file is uploaded with POST /v2/files (the raw bytes, the name in
 * X-Filename) and attached with POST /v2/attachments
 * ({ ownerReference: "bill:<id>", fileId }), an attachment's owner and file
 * in the documentation. The file's download address is never returned: it
 * carries a token.
 */
export async function attachBillFile(
  client: UpstreamClient,
  input: { billId: string; fileName: string; contentBase64: string },
): Promise<Json> {
  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) {
    throw new Error(`Refused: the file must be between 1 byte and ${MAX_FILE_BYTES} bytes. Nothing was sent.`);
  }
  const kind = FILE_TYPES.find(entry => entry.magic.every((byte, index) => bytes[index] === byte));
  if (!kind) throw new Error('Refused: the file is not a PDF, PNG or JPEG. Nothing was sent.');
  const extension = input.fileName.toLowerCase().split('.').pop() ?? '';
  if (!kind.extensions.includes(extension)) {
    throw new Error("Refused: the file name's ending does not match the file's type (pdf, png, jpg). Nothing was sent.");
  }
  const bill = single(await get(client, idPath('bills', input.billId, 'billId')), 'bill', input.billId);
  if (bill.state === 'voided') throw new Error('Refused: the bill is voided. Nothing was sent.');
  const uploaded = firstChanged(
    nestedFailuresAsStatus(await client.upload('/files', new Uint8Array(bytes), kind.type, input.fileName)),
    'files',
  );
  const attachment = { ownerReference: `bill:${input.billId}`, fileId: uploaded.id };
  const created = firstChanged(nestedFailuresAsStatus(await client.post('/attachments', { attachment })), 'attachments');
  return {
    attachment: pick(created, ['id', 'fileId', 'ownerReference']),
    // Not the file name: it was chosen by the caller and may say anything.
    file: pick(uploaded, ['id', 'fileSize', 'fileType']),
  };
}

/** Whether Billy's answer to a DELETE names the record as deleted (meta.deletedRecords.<plural>). */
function deletedRecord(body: unknown, plural: string, id: string): boolean {
  const deleted = asRecord(asRecord(asRecord(body)?.meta)?.deletedRecords)?.[plural];
  return Array.isArray(deleted) && deleted.includes(id);
}

/** Never approved: no approval time. */
function neverApproved(record: Json): boolean {
  return record.approvedTime === undefined || record.approvedTime === null;
}

/**
 * Delete a draft invoice that was never approved or sent: read first, and
 * refused without sending anything unless its state is "draft", it has no
 * approval time and its sent state is exactly "unsent". Billy answers
 * a DELETE with the deleted ids under meta.deletedRecords; an answer without
 * this invoice is an error.
 */
export async function deleteDraftInvoice(client: UpstreamClient, input: { invoiceId: string }): Promise<Json> {
  const path = idPath('invoices', input.invoiceId, 'invoiceId');
  const current = single(await get(client, path), 'invoice', input.invoiceId);
  // Billy documents sentState as required (default "unsent"): an invoice that does not say "unsent" is not deleted.
  const unsent = current.sentState === 'unsent';
  if (current.state !== 'draft' || !unsent || !neverApproved(current)) {
    throw new Error('Refused: only a draft invoice that was never approved or sent can be deleted. Nothing was deleted.');
  }
  const body = nestedFailuresAsStatus(await client.delete(path));
  if (!deletedRecord(body, 'invoices', input.invoiceId)) throw new UnexpectedAnswerError();
  return { deleted: true, invoiceId: input.invoiceId };
}

/** Delete a draft bill that was never approved, as deleteDraftInvoice does for an invoice. */
export async function deleteDraftBill(client: UpstreamClient, input: { billId: string }): Promise<Json> {
  const path = idPath('bills', input.billId, 'billId');
  const current = single(await get(client, path), 'bill', input.billId);
  if (current.state !== 'draft' || !neverApproved(current)) {
    throw new Error('Refused: only a draft bill that was never approved can be deleted. Nothing was deleted.');
  }
  const body = nestedFailuresAsStatus(await client.delete(path));
  if (!deletedRecord(body, 'bills', input.billId)) throw new UnexpectedAnswerError();
  return { deleted: true, billId: input.billId };
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
  // The company the token belongs to, by its Billy id: the same for every token and API host of the company.
  const organizationId = single(await get(client, '/organization'), 'organization').id as string;
  // One registration at a time per company and document in this process, whichever token or host the call came
  // through: the balance is read again after the previous one has finished, so two calls cannot both pass the check
  // against the same balance.
  return serialised(`${organizationId}:${kind}:${subjectId}`, async () => {
    const subject = isInvoice
      ? single(await get(client, idPath('invoices', subjectId, 'invoiceId')), 'invoice', subjectId)
      : single(await get(client, idPath('bills', subjectId, 'billId')), 'bill', subjectId);
    // The lock holds only if the document is the company's (organizationId, the documented belongs-to of each).
    if (subject.organizationId !== organizationId) {
      throw new Error(`Refused: the ${kind} does not show that it belongs to this company. Nothing was sent.`);
    }
    if (subject.state !== 'approved') throw new Error(`Refused: the ${kind} is not approved. Nothing was sent.`);
    if (subject.isPaid === true) throw new Error(`Refused: the ${kind} is already paid. Nothing was sent.`);
    // Only an ordinary invoice or bill, by its type: a payment here is always money in for an invoice and money out
    // for a bill. A credit note, a missing type or a type this server does not know is refused. A bill that credits
    // another (creditedBillId) is refused as well.
    const ordinary = isInvoice
      ? subject.type === 'invoice'
      : subject.type === 'bill' && (subject.creditedBillId === undefined || subject.creditedBillId === null);
    if (!ordinary) {
      throw new Error(`Refused: this is not an ordinary ${kind} (a credit note, or no type this server knows). Nothing was sent.`);
    }
    if (typeof subject.balance !== 'number' || !Number.isFinite(subject.balance) || subject.balance <= 0) {
      throw new Error(`Refused: the ${kind} has no positive outstanding balance. Nothing was sent.`);
    }
    if (input.amount > subject.balance + 0.005) {
      throw new Error(`Refused: the amount is more than the ${kind}'s outstanding balance. Nothing was sent.`);
    }
    const account = single(await get(client, idPath('accounts', input.cashAccountId, 'cashAccountId')), 'account', input.cashAccountId);
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

/** Work in flight per key (company id, kind, document id), in this process only. A key is dropped when done. */
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
  const { records, complete } = await scanAll(client, '/accounts', 'accounts', ACCOUNT_FIELDS, input.bankAccountsOnly ? { isBankAccount: true } : {});
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
  const fields = ['id', 'name', 'defaultContraAccountId'];
  const { records, complete } = await scanAll(client, '/daybooks', 'daybooks', fields);
  return { daybooks: records.map(daybook => pick(daybook, fields)), complete };
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
    ...lines(transaction.lines, DAYBOOK_LINE_FIELDS),
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
  const fields = ['id', 'name', 'abbreviation', 'rate', 'appliesToSales', 'appliesToPurchases', 'isActive'];
  const { records, complete } = await scanAll(client, '/taxRates', 'taxRates', fields);
  return {
    taxRates: records.filter(rate => input.includeInactive || rate.isActive !== false).map(rate => pick(rate, fields)),
    complete,
  };
}
