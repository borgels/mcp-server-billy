import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHmac, createHash } from 'node:crypto';
import { z } from 'zod/v4';
import {
  READ_TOOL_ANNOTATIONS,
  UNTRUSTED_CONTENT_NOTE,
  UNTRUSTED_RESULT_NOTE,
  WRITE_TOOL_ANNOTATIONS,
} from '../billy/annotations.js';
import { assertAuditLogWritable, auditTarget, newRequestId, writeAuditEvent } from '../billy/audit.js';
import { readOnlyClient, type UpstreamClient } from '../billy/client.js';
import { formatUnknownError, redactDeep, type SecretRedactor } from '../errors.js';
import { withheldResult } from '../fallbacks.js';
import { leaksSecret } from '../key-admission.js';
import {
  approveInvoice,
  BILL_FILTERS,
  checkConnection,
  createContact,
  createDaybookTransaction,
  createDraftInvoice,
  createProduct,
  getBill,
  getContact,
  getInvoice,
  getOrganization,
  getProduct,
  listAccounts,
  listBills,
  listContacts,
  listDaybooks,
  listDaybookTransactions,
  listInvoices,
  listPostings,
  listProducts,
  listTaxRates,
  MAX_PAGE_SIZE,
  MAX_SCAN_RECORDS,
  registerPayment,
  updateContact,
  updateProduct,
} from '../billy/resources.js';
import { checkInputPolicy, checkToolPolicy, currentInstancePolicy, isToolDisabled, redactInScope, runInCallScope, validatePolicyConfig } from '../billy/policy.js';
import {
  COUNTRY_PATTERN,
  CURRENCY_PATTERN,
  isAmount,
  isCurrency,
  isIsoDate,
  isRecordId,
  MAX_AMOUNT,
  RECORD_ID_PATTERN,
} from '../billy/values.js';

type ToolAnnotations = typeof READ_TOOL_ANNOTATIONS | typeof WRITE_TOOL_ANNOTATIONS;

/**
 * One upstream request a tool may make: `read` or `write`, the HTTP method
 * and the path template relative to the base URL (`{name}` marks a
 * caller-supplied segment). Published in the gateway tool catalog so a host
 * can see what each tool touches; keep it in step with the handler.
 */
export interface UpstreamOperation {
  access: 'read' | 'write';
  method: 'GET' | 'POST' | 'PUT';
  path: string;
}

/** A client that carries the redactor of its instance (BillyClient does). */
export interface RedactingClient extends UpstreamClient {
  readonly redactor: SecretRedactor;
}

/** What a write tool does. */
export type BillyChangeAction = 'create' | 'update' | 'approve' | 'register_payment';

/** The kind of record a write tool touches. */
export type BillyChangeRecord = 'contact' | 'product' | 'invoice' | 'payment' | 'daybook_transaction';

/**
 * The type a logged value must have; anything else is left out of the values.
 *   recordId  a Billy record id (opaque, chosen by Billy), in clear
 *   amount    a positive amount of at most two decimals, in clear
 *   currency  an ISO 4217 code, in clear
 *   date      a date YYYY-MM-DD, in clear
 *   count     the number of entries in a list (lines), never the entries
 *   flag      true or false, in clear
 *   kind      one value from a fixed list the tool's schema allows, in clear
 *   pseudonym a number the company chose (contact number, product number,
 *             voucher number). It can be any text, so it is never logged in
 *             clear: "sha256:" and 16 hex characters, or "hmac:" with a key
 *             from the host.
 * Names, addresses, descriptions and other free text are never log fields.
 */
export type BillyLogFieldType = 'recordId' | 'amount' | 'currency' | 'date' | 'count' | 'flag' | 'kind' | 'pseudonym';

export interface BillyLogField {
  readonly name: string;
  readonly type: BillyLogFieldType;
}

/**
 * Write tools only: what the change does, for a host that logs a change
 * before it is sent. `logFields` are the input fields that identify it, each
 * with the one type its value must have.
 */
export interface BillyChangeSpec {
  readonly action: BillyChangeAction;
  readonly record: BillyChangeRecord;
  /** Always false: no tool moves money. A registered payment is an entry in the books. */
  readonly movesMoney: false;
  readonly logFields: readonly BillyLogField[];
}

/**
 * One definition per tool, shared by the MCP server and the gateway entry
 * point: same input schema, same handler, same policy and audit path.
 */
export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  /** MCP tool name (`billy_*`). The gateway exposes it without the prefix. */
  name: string;
  title: string;
  description: string;
  inputShape: S;
  /** Strict object built from inputShape: unknown arguments are rejected. */
  inputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  /** Whether the result carries upstream content (vs. server metadata). */
  returnsUpstreamContent: boolean;
  /** Short human-readable summary used by the gateway result text. */
  summary: string;
  /** Every upstream request the handler may make. */
  upstream: readonly UpstreamOperation[];
  /**
   * True when the tool can read more than its name says: anything in the
   * system, chosen by the input. None of these tools does.
   */
  broad?: boolean;
  /** Write tools: what the change does. */
  change?: BillyChangeSpec;
  /**
   * True when a person should confirm each call outside the chat before it
   * runs: registering a payment. Published in the gateway catalog.
   */
  requiresConfirmation?: boolean;
  /** Cross-field checks the schema shape cannot express. Returns a refusal or undefined. */
  check?: (input: Record<string, unknown>) => string | undefined;
  /**
   * Read-only tools (readOnlyHint) receive a client view that refuses
   * non-GET requests, so a mis-annotated tool cannot write.
   */
  handler: (client: UpstreamClient, input: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

function defineTool<S extends z.ZodRawShape>(definition: Omit<ToolDefinition<S>, 'inputSchema'>): ToolDefinition {
  const description = definition.returnsUpstreamContent
    ? `${definition.description} ${UNTRUSTED_CONTENT_NOTE}`
    : definition.description;
  return {
    ...definition,
    description,
    inputSchema: z.strictObject(definition.inputShape),
  } as unknown as ToolDefinition;
}

const change = (
  action: BillyChangeAction,
  record: BillyChangeRecord,
  logFields: Record<string, BillyLogFieldType>,
): BillyChangeSpec => ({
  action,
  record,
  movesMoney: false,
  logFields: Object.entries(logFields).map(([name, type]) => ({ name, type })),
});

// ---------------------------------------------------------------------------
// Schemas

const recordId = (what: string) => z.string().trim().regex(RECORD_ID_PATTERN).describe(what);
const dateSchema = z.string().trim().refine(isIsoDate, 'must be a date written YYYY-MM-DD');
const amountSchema = z
  .number()
  .refine(isAmount, `must be more than 0 and at most ${MAX_AMOUNT}, with at most two decimals`)
  .describe('Amount in the currency, e.g. 1250.50 for 1.250,50 kr.');
const currencySchema = z.string().trim().regex(CURRENCY_PATTERN).describe('ISO 4217 currency code, e.g. DKK.');
const text = (max: number) => z.string().trim().min(1).max(max);
const limitSchema = z.number().int().min(1).max(500).optional().describe('Most records to return (default 100, at most 500).');
const pageShape = {
  page: z.number().int().min(1).max(10_000).optional().describe('Page number, from 1 (default 1).'),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional().describe(`Records per page (default 100, at most ${MAX_PAGE_SIZE}).`),
  sortDirection: z.enum(['ASC', 'DESC']).optional().describe('ASC (default) or DESC.'),
};
const entryDateShape = {
  minEntryDate: dateSchema.optional().describe('Only entries dated on or after this date, YYYY-MM-DD.'),
  maxEntryDate: dateSchema.optional().describe('Only entries dated on or before this date, YYYY-MM-DD.'),
};
const dueDateShape = {
  minDueDate: dateSchema.optional().describe('Only those due on or after this date, YYYY-MM-DD.'),
  maxDueDate: dateSchema.optional().describe('Only those due on or before this date, YYYY-MM-DD.'),
};
const stateSchema = z.enum(['draft', 'approved', 'voided']);

const contactFieldsShape = {
  type: z.enum(['company', 'person']).optional().describe('company (default) or person.'),
  countryId: z.string().trim().regex(COUNTRY_PATTERN).optional().describe('ISO country code, e.g. DK.'),
  street: text(255).optional(),
  zipcodeText: text(20).optional().describe('Postal code.'),
  cityText: text(100).optional().describe('City.'),
  contactNo: text(50).optional().describe("The company's own number for the contact."),
  phone: text(50).optional(),
  registrationNo: text(50).optional().describe('CVR number in Denmark, EU VAT number abroad.'),
  ean: z.string().trim().regex(/^\d{13}$/).optional().describe('EAN (GLN) number for e-invoices, 13 digits.'),
  isCustomer: z.boolean().optional().describe('The contact is a customer (can have invoices).'),
  isSupplier: z.boolean().optional().describe('The contact is a supplier (can have bills).'),
};

/** Billy documents paymentTermsDays as required, with no default: required when a contact is created. */
const paymentTermsDaysSchema = z.number().int().min(-365).max(365).describe('Payment terms in days, e.g. 8.');

const productFieldsShape = {
  description: text(1000).optional().describe('Default text on invoice lines with the product.'),
  productNo: text(50).optional().describe("The company's own product number."),
  accountId: recordId('The revenue account sales are booked to (from list_accounts).').optional(),
  salesTaxRulesetId: recordId('The VAT ruleset of the product.').optional(),
  prices: z
    .array(z.strictObject({ currencyId: currencySchema, unitPrice: z.number().min(0).max(MAX_AMOUNT) }))
    .max(20)
    .optional()
    .describe('Unit price per currency. On update, the list replaces the prices the product has.'),
};

function atLeastOneChange(fields: readonly string[]) {
  return (input: Record<string, unknown>): string | undefined =>
    fields.some(field => input[field] !== undefined) ? undefined : 'Nothing to change: give at least one field.';
}

const WRITE_NOTE = 'Off unless writes are enabled (BILLY_ENABLE_WRITES, or the gateway host policy enableWrites).';
const LIST_NOTE = `Reads every page (at most ${MAX_SCAN_RECORDS} records) and filters here; complete is false when there were more.`;

export const BILLY_TOOLS: ToolDefinition[] = [
  defineTool({
    name: 'billy_check_connection',
    title: 'Check Billy connection',
    description: 'Check that the access token works. Returns the company id and name the token belongs to.',
    inputShape: {},
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Checked the connection.',
    upstream: [{ access: 'read', method: 'GET', path: '/organization' }],
    handler: async client => checkConnection(client),
  }),
  defineTool({
    name: 'billy_get_organization',
    title: 'Company details (Billy)',
    description:
      "The company's own details in Billy: name, address, CVR number, base currency, fiscal year, VAT period and default payment terms. Subscription, payment card and bank details are left out.",
    inputShape: {},
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched the company details.',
    upstream: [{ access: 'read', method: 'GET', path: '/organization' }],
    handler: async client => getOrganization(client),
  }),
  defineTool({
    name: 'billy_list_contacts',
    title: 'List contacts (Billy)',
    description: `Customers and suppliers: id, name, number, CVR number, postal code and city. Filter by kind and by text in name, number or CVR number. ${LIST_NOTE}`,
    inputShape: {
      kind: z.enum(['customer', 'supplier', 'all']).optional().describe('customer, supplier or all (default).'),
      query: text(100).optional().describe('Text in the name, contact number or CVR number.'),
      includeArchived: z.boolean().optional().describe('Also archived contacts (default false).'),
      limit: limitSchema,
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed contacts.',
    upstream: [{ access: 'read', method: 'GET', path: '/contacts' }],
    handler: async (client, input) => listContacts(client, input),
  }),
  defineTool({
    name: 'billy_get_contact',
    title: 'Get contact (Billy)',
    description: 'One customer or supplier with address, payment terms and contact persons (name and e-mail).',
    inputShape: { contactId: recordId('The contact id, from list_contacts.') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched contact.',
    upstream: [{ access: 'read', method: 'GET', path: '/contacts/{contactId}' }],
    handler: async (client, input) => getContact(client, input),
  }),
  defineTool({
    name: 'billy_list_products',
    title: 'List products (Billy)',
    description: `Products with number, description, revenue account and prices. Filter by text in name, number or description. ${LIST_NOTE}`,
    inputShape: {
      query: text(100).optional().describe('Text in the name, product number or description.'),
      includeArchived: z.boolean().optional().describe('Also archived products (default false).'),
      limit: limitSchema,
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed products.',
    upstream: [{ access: 'read', method: 'GET', path: '/products' }],
    handler: async (client, input) => listProducts(client, input),
  }),
  defineTool({
    name: 'billy_get_product',
    title: 'Get product (Billy)',
    description: 'One product with its prices per currency.',
    inputShape: { productId: recordId('The product id, from list_products.') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched product.',
    upstream: [{ access: 'read', method: 'GET', path: '/products/{productId}' }],
    handler: async (client, input) => getProduct(client, input),
  }),
  defineTool({
    name: 'billy_list_invoices',
    title: 'List invoices (Billy)',
    description:
      'Invoices and credit notes, one page at a time: number, state (draft, approved, voided), customer, dates, amount, VAT, what is still owed (balance) and whether it is paid. Filters as Billy documents them.',
    inputShape: {
      contactId: recordId('Only invoices to this customer.').optional(),
      state: stateSchema.optional().describe('draft, approved or voided.'),
      isPaid: z.boolean().optional().describe('Only paid (true) or unpaid (false) invoices.'),
      invoiceNo: text(50).optional().describe('One invoice number.'),
      ...entryDateShape,
      ...dueDateShape,
      q: text(100).optional().describe('Search in invoice number, customer name, line text and amount.'),
      sortProperty: z.enum(['entryDate', 'dueDate', 'createdTime', 'invoiceNo', 'amount', 'balance', 'approvedTime']).optional(),
      ...pageShape,
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed invoices.',
    upstream: [{ access: 'read', method: 'GET', path: '/invoices' }],
    handler: async (client, input) => listInvoices(client, input),
  }),
  defineTool({
    name: 'billy_get_invoice',
    title: 'Get invoice (Billy)',
    description: 'One invoice or credit note with its lines, amounts, balance and payment state.',
    inputShape: { invoiceId: recordId('The invoice id, from list_invoices.') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched invoice.',
    upstream: [{ access: 'read', method: 'GET', path: '/invoices/{invoiceId}' }],
    handler: async (client, input) => getInvoice(client, input),
  }),
  defineTool({
    name: 'billy_list_bills',
    title: 'List bills (Billy)',
    description:
      "Bills from suppliers (purchases), one page at a time: state, supplier, the supplier's invoice number, dates, amount, VAT, balance and whether it is paid.",
    inputShape: {
      contactId: recordId('Only bills from this supplier.').optional(),
      state: stateSchema.optional().describe('draft, approved or voided.'),
      isPaid: z.boolean().optional().describe('Only paid (true) or unpaid (false) bills.'),
      suppliersInvoiceNo: text(50).optional().describe("The supplier's invoice number."),
      ...entryDateShape,
      ...dueDateShape,
      q: text(100).optional().describe('Search in supplier name, line text, voucher number, amount and invoice number.'),
      sortProperty: z.enum(['entryDate', 'dueDate', 'createdTime', 'amount', 'balance', 'voucherNo']).optional(),
      ...pageShape,
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed bills.',
    upstream: [{ access: 'read', method: 'GET', path: '/bills' }],
    handler: async (client, input) => listBills(client, input),
  }),
  defineTool({
    name: 'billy_get_bill',
    title: 'Get bill (Billy)',
    description: 'One bill from a supplier with its lines (account, VAT rate, amount).',
    inputShape: { billId: recordId('The bill id, from list_bills.') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched bill.',
    upstream: [{ access: 'read', method: 'GET', path: '/bills/{billId}' }],
    handler: async (client, input) => getBill(client, input),
  }),
  defineTool({
    name: 'billy_list_accounts',
    title: 'Chart of accounts (Billy)',
    description: `The chart of accounts: number, name, group, VAT rate, and whether the account is a bank or payment account. Bank account numbers and IBANs are shown only as their last four characters. Read only: nothing here can change the chart of accounts. ${LIST_NOTE}`,
    inputShape: {
      bankAccountsOnly: z.boolean().optional().describe('Only bank accounts.'),
      paymentEnabledOnly: z.boolean().optional().describe('Only accounts payments can be registered on.'),
      includeArchived: z.boolean().optional().describe('Also archived accounts (default false).'),
      query: text(100).optional().describe('Text in the name or description, or an account number.'),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed accounts.',
    upstream: [{ access: 'read', method: 'GET', path: '/accounts' }],
    handler: async (client, input) => listAccounts(client, input),
  }),
  defineTool({
    name: 'billy_list_postings',
    title: 'List postings (Billy)',
    description:
      'Postings in the books, one page at a time: date, text, account, amount, debit or credit. Filter by account, transaction, dates and text.',
    inputShape: {
      accountId: recordId('Only postings on this account (from list_accounts).').optional(),
      transactionId: recordId('Only postings of this transaction.').optional(),
      ...entryDateShape,
      isVoided: z.boolean().optional().describe('Only voided (true) or not voided (false) postings.'),
      q: text(100).optional().describe('Search in the posting text.'),
      sortProperty: z.enum(['entryDate', 'priority']).optional(),
      ...pageShape,
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed postings.',
    upstream: [{ access: 'read', method: 'GET', path: '/postings' }],
    handler: async (client, input) => listPostings(client, input),
  }),
  defineTool({
    name: 'billy_list_daybooks',
    title: 'List daybooks (Billy)',
    description: 'The daybooks (kassekladder) of the company, with their default contra account.',
    inputShape: {},
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed daybooks.',
    upstream: [{ access: 'read', method: 'GET', path: '/daybooks' }],
    handler: async client => listDaybooks(client),
  }),
  defineTool({
    name: 'billy_list_daybook_transactions',
    title: 'List daybook transactions (Billy)',
    description: 'Daybook transactions with their lines, one page at a time. Filter by daybook, state, dates and text.',
    inputShape: {
      daybookId: recordId('Only this daybook (from list_daybooks).').optional(),
      state: stateSchema.optional().describe('draft, approved or voided.'),
      ...entryDateShape,
      q: text(100).optional().describe('Search in description and voucher number.'),
      sortProperty: z.enum(['priority', 'entryDate', 'createdTime']).optional(),
      ...pageShape,
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed daybook transactions.',
    upstream: [{ access: 'read', method: 'GET', path: '/daybookTransactions' }],
    handler: async (client, input) => listDaybookTransactions(client, input),
  }),
  defineTool({
    name: 'billy_list_tax_rates',
    title: 'List VAT rates (Billy)',
    description: 'The VAT rates of the company, with rate and whether they apply to sales or purchases.',
    inputShape: { includeInactive: z.boolean().optional().describe('Also inactive rates (default false).') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed VAT rates.',
    upstream: [{ access: 'read', method: 'GET', path: '/taxRates' }],
    handler: async (client, input) => listTaxRates(client, input),
  }),

  // -------------------------------------------------------------------------
  // Writes. No tool deletes, sends an e-mail or an e-invoice, changes the chart of accounts, VAT rates, the
  // company's details or any bank details, or moves money.

  defineTool({
    name: 'billy_create_contact',
    title: 'Create contact (Billy)',
    description: `Create a customer or supplier, optionally with contact persons. Contacts in Billy have no bank details. ${WRITE_NOTE}`,
    inputShape: {
      name: text(255).describe('Company or person name.'),
      ...contactFieldsShape,
      countryId: z.string().trim().regex(COUNTRY_PATTERN).describe('ISO country code, e.g. DK.'),
      paymentTermsDays: paymentTermsDaysSchema,
      contactPersons: z
        .array(
          z.strictObject({
            name: text(255).optional(),
            email: z.email().max(255).optional(),
            isPrimary: z.boolean().optional(),
          }),
        )
        .max(10)
        .optional()
        .describe('Contact persons; each needs a name or an e-mail. The e-mail is where Billy sends invoices.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Created contact.',
    upstream: [{ access: 'write', method: 'POST', path: '/contacts' }],
    change: change('create', 'contact', {
      type: 'kind',
      countryId: 'kind',
      isCustomer: 'flag',
      isSupplier: 'flag',
      contactNo: 'pseudonym',
      contactPersons: 'count',
    }),
    check: input => {
      const persons = (input.contactPersons as Array<Record<string, unknown>> | undefined) ?? [];
      return persons.some(person => !person.name && !person.email) ? 'Each contact person needs a name or an e-mail.' : undefined;
    },
    handler: async (client, input) => createContact(client, input),
  }),
  defineTool({
    name: 'billy_update_contact',
    title: 'Update contact (Billy)',
    description: `Change the fields given on a customer or supplier; fields left out stay as they are. Contact persons are not changed here. ${WRITE_NOTE}`,
    inputShape: {
      contactId: recordId('The contact id, from list_contacts.'),
      name: text(255).optional(),
      ...contactFieldsShape,
      paymentTermsDays: paymentTermsDaysSchema.optional(),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Updated contact.',
    upstream: [{ access: 'write', method: 'PUT', path: '/contacts/{contactId}' }],
    change: change('update', 'contact', { contactId: 'recordId', isCustomer: 'flag', isSupplier: 'flag' }),
    check: atLeastOneChange(['name', 'paymentTermsDays', ...Object.keys(contactFieldsShape)]),
    handler: async (client, input) => updateContact(client, input),
  }),
  defineTool({
    name: 'billy_create_product',
    title: 'Create product (Billy)',
    description: `Create a product with prices. Without accountId and salesTaxRulesetId, Billy uses the company's defaults. ${WRITE_NOTE}`,
    inputShape: { name: text(255).describe('Product name.'), ...productFieldsShape },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Created product.',
    upstream: [{ access: 'write', method: 'POST', path: '/products' }],
    change: change('create', 'product', { productNo: 'pseudonym', accountId: 'recordId', prices: 'count' }),
    handler: async (client, input) => createProduct(client, input),
  }),
  defineTool({
    name: 'billy_update_product',
    title: 'Update product (Billy)',
    description: `Change the fields given on a product; fields left out stay as they are. Prices, when given, replace the product's prices. ${WRITE_NOTE}`,
    inputShape: { productId: recordId('The product id, from list_products.'), name: text(255).optional(), ...productFieldsShape },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Updated product.',
    upstream: [{ access: 'write', method: 'PUT', path: '/products/{productId}' }],
    change: change('update', 'product', { productId: 'recordId', accountId: 'recordId', prices: 'count' }),
    check: atLeastOneChange(['name', ...Object.keys(productFieldsShape)]),
    handler: async (client, input) => updateProduct(client, input),
  }),
  defineTool({
    name: 'billy_create_draft_invoice',
    title: 'Create draft invoice (Billy)',
    description: `Create an invoice as a draft, with lines from products. It is not approved (booked), e-mailed or sent; a draft can still be changed or deleted in Billy. Billy gives it a number from the company's invoice number model when it is created. ${WRITE_NOTE}`,
    inputShape: {
      contactId: recordId('The customer id, from list_contacts.'),
      entryDate: dateSchema.describe('Invoice date, YYYY-MM-DD.'),
      currencyId: currencySchema.describe('ISO 4217 currency code of the invoice, e.g. DKK (get_organization gives the base currency).'),
      paymentTermsDays: z.number().int().min(-365).max(365).describe('Payment terms in days (get_contact gives the customer\'s).'),
      taxMode: z.enum(['incl', 'excl']).optional().describe('Unit prices include (incl) or exclude (excl) VAT. Default: the company setting.'),
      contactMessage: text(2000).optional().describe('Message to the customer at the top of the invoice.'),
      lines: z
        .array(
          z.strictObject({
            productId: recordId('The product id, from list_products.'),
            description: text(1000).optional().describe('Text under the product name on the line.'),
            quantity: z.number().positive().max(1_000_000).optional().describe('Quantity (default 1).'),
            unitPrice: z.number().min(0).max(MAX_AMOUNT).describe('Price per unit in the invoice currency.'),
          }),
        )
        .min(1)
        .max(100)
        .describe('Invoice lines, at least one.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Created draft invoice.',
    upstream: [{ access: 'write', method: 'POST', path: '/invoices' }],
    change: change('create', 'invoice', { contactId: 'recordId', entryDate: 'date', currencyId: 'currency', lines: 'count' }),
    handler: async (client, input) => createDraftInvoice(client, input),
  }),
  defineTool({
    name: 'billy_approve_invoice',
    title: 'Approve draft invoice (Billy)',
    description: `Approve (book) a draft invoice. Reads it first and refuses unless it is a draft. Billy then books it; an approved invoice cannot be returned to draft, only credited. It is not e-mailed or sent as an e-invoice. ${WRITE_NOTE}`,
    inputShape: { invoiceId: recordId('The id of the draft invoice.') },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Approved invoice.',
    upstream: [
      { access: 'read', method: 'GET', path: '/invoices/{invoiceId}' },
      { access: 'write', method: 'PUT', path: '/invoices/{invoiceId}' },
    ],
    change: change('approve', 'invoice', { invoiceId: 'recordId' }),
    handler: async (client, input) => approveInvoice(client, input),
  }),
  defineTool({
    name: 'billy_register_payment',
    title: 'Register payment (Billy)',
    description: `Register in the books that an approved invoice was paid (money in) or a bill was paid (money out), on a payment account. It moves no money. Reads the invoice or bill and the account first, and refuses when it is not approved, already paid, a credit note, has no positive balance, the amount is more than what is owed, the currency is unknown, or the account is not a payment account in the same currency. Registrations of one document run one at a time in this server; a payment registered in Billy by someone else at the same moment is not seen. A person should confirm each call. ${WRITE_NOTE}`,
    inputShape: {
      invoiceId: recordId('The invoice that was paid. Give this or billId.').optional(),
      billId: recordId('The bill that was paid. Give this or invoiceId.').optional(),
      cashAccountId: recordId('The account the money went into or out of (list_accounts with paymentEnabledOnly).'),
      amount: amountSchema,
      entryDate: dateSchema.describe('Date of the payment, YYYY-MM-DD.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Registered payment.',
    upstream: [
      { access: 'read', method: 'GET', path: '/organization' },
      { access: 'read', method: 'GET', path: '/invoices/{invoiceId}' },
      { access: 'read', method: 'GET', path: '/bills/{billId}' },
      { access: 'read', method: 'GET', path: '/accounts/{cashAccountId}' },
      { access: 'write', method: 'POST', path: '/bankPayments' },
    ],
    change: change('register_payment', 'payment', {
      invoiceId: 'recordId',
      billId: 'recordId',
      cashAccountId: 'recordId',
      amount: 'amount',
      entryDate: 'date',
    }),
    requiresConfirmation: true,
    check: input =>
      (input.invoiceId === undefined) === (input.billId === undefined) ? 'Give exactly one of invoiceId and billId.' : undefined,
    handler: async (client, input) => registerPayment(client, input as never),
  }),
  defineTool({
    name: 'billy_create_daybook_transaction',
    title: 'Create draft daybook transaction (Billy)',
    description: `Put a transaction with lines in a daybook (kassekladde) as a draft. It is not approved (booked): a person approves it in Billy. ${WRITE_NOTE}`,
    inputShape: {
      daybookId: recordId('The daybook (from list_daybooks).').optional(),
      entryDate: dateSchema.describe('Date of the transaction, YYYY-MM-DD.'),
      voucherNo: text(50).optional().describe('Voucher number.'),
      description: text(255).optional().describe('Description of the transaction.'),
      lines: z
        .array(
          z.strictObject({
            accountId: recordId('The account (from list_accounts).'),
            contraAccountId: recordId('The contra account.').optional(),
            taxRateId: recordId('The VAT rate (from list_tax_rates).').optional(),
            amount: amountSchema,
            side: z.enum(['debit', 'credit']),
            text: text(255).optional().describe('Line text.'),
          }),
        )
        .min(1)
        .max(50)
        .describe('Lines, at least one.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Created draft daybook transaction.',
    upstream: [{ access: 'write', method: 'POST', path: '/daybookTransactions' }],
    change: change('create', 'daybook_transaction', {
      daybookId: 'recordId',
      entryDate: 'date',
      voucherNo: 'pseudonym',
      lines: 'count',
    }),
    handler: async (client, input) => createDaybookTransaction(client, input),
  }),
];

/**
 * Validate a write call's input exactly as executeTool does before it sends
 * anything: the strict schema, then the tool's own cross-field check. Used
 * by the change resolution, so a call it accepts is one that would run.
 */
export function validateCall(tool: ToolDefinition, input: unknown): { ok: true; data: Record<string, unknown> } | { ok: false } {
  const parsed = tool.inputSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false };
  const data = parsed.data as Record<string, unknown>;
  return tool.check?.(data) ? { ok: false } : { ok: true, data };
}

export function findTool(name: string): ToolDefinition | undefined {
  return BILLY_TOOLS.find(tool => tool.name === name);
}

/** The pseudonym of a value: HMAC-SHA-256 with the host's key, else SHA-256; 16 hex characters with a prefix. */
export function pseudonym(value: string, key?: string | Uint8Array): string {
  if (key !== undefined && key.length > 0) {
    return `hmac:${createHmac('sha256', key).update(value).digest('hex').slice(0, 16)}`;
  }
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

const KIND_VALUES = /^[A-Za-z][A-Za-z_-]{0,19}$/;

/**
 * The value of one log field when it has exactly the field's type; otherwise
 * undefined. A number the company chose comes back only as a pseudonym.
 */
export function logFieldValue(
  type: BillyLogFieldType,
  value: unknown,
  pseudonymKey?: string | Uint8Array,
): string | number | boolean | undefined {
  switch (type) {
    case 'recordId':
      return isRecordId(value) ? value : undefined;
    case 'amount':
      return isAmount(value) ? value : undefined;
    case 'currency':
      return isCurrency(value) ? value : undefined;
    case 'date':
      return isIsoDate(value) ? value : undefined;
    case 'count':
      return Array.isArray(value) ? value.length : undefined;
    case 'flag':
      return typeof value === 'boolean' ? value : undefined;
    case 'kind':
      return typeof value === 'string' && KIND_VALUES.test(value) ? value : undefined;
    case 'pseudonym':
      return typeof value === 'string' && value.length > 0 && value.length <= 100 ? pseudonym(value, pseudonymKey) : undefined;
    default:
      return undefined;
  }
}

/** Validate the tool policy environment. Cheap; runs for every server instance. */
export function validateToolConfig(): void {
  validatePolicyConfig(BILLY_TOOLS.map(tool => tool.name));
}

/**
 * Startup checks for entry points (transports, gateway): tool policy plus a
 * writable audit log. The audit check is not repeated per HTTP request, so
 * read tools keep working if the log becomes unwritable later; write tools
 * then fail closed when their start record cannot be written.
 */
export function validateStartupConfig(): void {
  validateToolConfig();
  assertAuditLogWritable();
}

/** Tools enabled on this instance (BILLY_DISABLED_TOOLS removes them entirely). */
export function enabledTools(): ToolDefinition[] {
  return BILLY_TOOLS.filter(tool => !isToolDisabled(tool.name));
}

export function registerTools(server: McpServer, client: RedactingClient): void {
  validateToolConfig();
  for (const tool of enabledTools()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (input: Record<string, unknown>) => {
        let result: { content: Array<{ type: 'text'; text: string }>; isError?: true };
        try {
          // In a scope with this server's redactor, like a gateway call: audit records and context are redacted.
          const data = await runInCallScope({ redactor: client.redactor }, () => executeTool(tool, client, input));
          // Billy data can echo the token, in values or in object keys: redacted as data before it is serialised (a
          // serialised token is escaped and no longer matches), as on the gateway.
          result = mcpToolResult(tool, redactDeep(redactDeep(data, client.redactor), client.redactor));
        } catch (error) {
          // Central redaction with this instance's secrets: no error text reaches the client unredacted.
          result = { isError: true, content: [{ type: 'text' as const, text: formatUnknownError(error, client.redactor) }] };
        }
        // The same last check as the gateway: a result that still holds a piece of the token is withheld whole.
        return leaksSecret(result, client.redactor) ? withheldResult() : result;
      },
    );
  }
}

/** Optional call context supplied by an embedding host. */
export interface CallContext {
  /** Caller identity, recorded in audit events. */
  caller?: string;
  /** Request id to reuse in audit events, for correlation with the host's own log. */
  requestId?: string;
}

function contextString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  // Redacted before it is cut short: a cut key would no longer match the redactor.
  const trimmed = redactInScope(value).trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/**
 * The audit's view of a call context. Nothing the host sends is kept in
 * clear: a request id may be any text (a name, a phone number, an address),
 * so the audit keeps its pseudonym, which still ties the lines of one call
 * together for the host that knows the key; without a request id the audit
 * makes one. The caller becomes a pseudonym the same way. Both are keyed
 * with the host's policy.pseudonymKey when given.
 */
export function normaliseCallContext(context: unknown): { requestId: string; caller?: string } {
  const value = (context && typeof context === 'object' ? context : {}) as Record<string, unknown>;
  const key = currentInstancePolicy()?.pseudonymKey;
  const given = typeof value.requestId === 'string' && value.requestId.length > 0 ? value.requestId.slice(0, 1000) : undefined;
  const requestId = given === undefined ? newRequestId() : pseudonym(given, key);
  const caller = contextString(value.caller, 320);
  return {
    requestId,
    ...(caller === undefined ? {} : { caller: pseudonym(caller, key) }),
  };
}

/**
 * Run one validated tool call through the instance policy and the audit
 * log. Used by both the MCP server and the gateway entry point.
 */
export async function executeTool(
  tool: ToolDefinition,
  client: RedactingClient,
  input: Record<string, unknown>,
  context?: CallContext,
): Promise<unknown> {
  const { requestId, caller } = normaliseCallContext(context);
  const target = auditTarget(input);
  const { redactor } = client;

  const policy = checkToolPolicy(tool.name, tool.annotations.readOnlyHint);
  const inputPolicy = policy.allowed ? checkInputPolicy(tool.name, input) : policy;
  const refusal = inputPolicy.allowed ? tool.check?.(input) : undefined;
  if (!inputPolicy.allowed || refusal) {
    const reason = inputPolicy.allowed ? (refusal as string) : inputPolicy.reason;
    await writeAuditEvent({ requestId, tool: tool.name, caller, action: 'policy_denied', target, reason }, { redactor });
    throw new Error(reason);
  }

  // Write tools fail closed: no write runs without its start record.
  await writeAuditEvent(
    { requestId, tool: tool.name, caller, action: 'start', target, reason: policy.reason },
    { required: !tool.annotations.readOnlyHint, redactor },
  );
  const startedAt = performance.now();

  try {
    const handlerClient = tool.annotations.readOnlyHint ? readOnlyClient(client, tool.name) : client;
    const result = await tool.handler(handlerClient, input as never);
    await writeAuditEvent({
      requestId,
      tool: tool.name,
      caller,
      action: 'finish',
      target,
      status: 'ok',
      durationMs: Math.round(performance.now() - startedAt),
    }, { redactor });
    return result;
  } catch (error) {
    await writeAuditEvent({
      requestId,
      tool: tool.name,
      caller,
      action: 'error',
      target,
      status: 'error',
      durationMs: Math.round(performance.now() - startedAt),
      error,
    }, { redactor });
    throw error;
  }
}

/** Why a call was rejected before it ran: a fixed code, never text from the caller. */
export type RejectionCode = 'unknown_tool' | 'invalid_input';

/**
 * Audit a call rejected before execution (unknown tool or invalid input).
 * The record holds only what we wrote: a known tool name (an unknown one is
 * recorded as `unknown` with a pseudonym of what was given), the argument
 * names that the tool's schema knows, the number of other arguments, and a
 * fixed code. A caller can put a name or a text anywhere, so nothing it
 * chose is logged in clear.
 */
export async function auditRejectedCall(
  toolName: string,
  input: unknown,
  code: RejectionCode,
  context?: unknown,
): Promise<void> {
  const { requestId, caller } = normaliseCallContext(context);
  const tool = typeof toolName === 'string' ? findTool(toolName) : undefined;
  const known = new Set(tool ? Object.keys(tool.inputShape) : []);
  const keys = input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input) : [];
  const fields = keys.filter(key => known.has(key)).sort();
  await writeAuditEvent({
    requestId,
    tool: tool ? tool.name : 'unknown',
    caller,
    action: 'rejected',
    target: {
      ...(tool ? {} : { toolPseudonym: pseudonym(String(toolName).slice(0, 200)) }),
      fields,
      otherFields: keys.length - fields.length,
    },
    reason: code,
  });
}

/** Compact JSON (no pretty-printing): indentation only costs tokens. */
export function compactJson(data: unknown): string {
  return JSON.stringify(data ?? null);
}

function mcpToolResult(tool: ToolDefinition, data: unknown) {
  const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: compactJson(data) }];
  if (tool.returnsUpstreamContent) {
    content.push({ type: 'text', text: UNTRUSTED_RESULT_NOTE });
  }
  return { content };
}
