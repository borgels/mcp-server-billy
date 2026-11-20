// Bills with a file, sending an approved invoice and deleting drafts (#9), against answers shaped as Billy's API
// documentation shows them (https://www.billy.dk/api: "Creating and using attachments", "Sending emails for
// invoices", "Deleting a record", and the bills, billLines, files, attachments and contactPersons resources). Recorded
// from the documentation, not from a live company: no Billy account was used.
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

type Call = { method: string; path: string; headers: Headers; body: unknown; raw?: Uint8Array };
type Handler = (call: Call) => unknown;

/** A Billy stand-in: routes by "METHOD /path" (path relative to /v2). An unknown route answers 404. */
function billy(routes: Record<string, Handler | unknown>, audit?: (record: Readonly<Record<string, unknown>>) => void) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.slice(new URL(BASE).pathname.length);
    const headers = new Headers(init?.headers);
    const isJson = headers.get('content-type') === 'application/json';
    const call: Call = {
      method,
      path,
      headers,
      body: init?.body && isJson ? JSON.parse(String(init.body)) : undefined,
      ...(init?.body && !isJson ? { raw: init.body as Uint8Array } : {}),
    };
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
    policy: { enableWrites: true, ...(audit ? { audit } : {}) },
  });
  return { gw, calls };
}

const PDF = Buffer.from('%PDF-1.7\nfake supplier invoice\n%%EOF');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('bills', () => {
  it('creates a bill as a draft with lines on accounts, whatever else is asked', async () => {
    const { gw, calls } = billy({
      'POST /bills': { bills: [{ id: 'b9', state: 'draft', contactId: 'c1', amount: 125, lines: [{ id: 'l1', accountId: 'a1', amount: 125 }] }] },
    });
    const input = {
      contactId: 'c1',
      entryDate: '2026-11-19',
      dueDate: '2026-12-03',
      currencyId: 'DKK',
      suppliersInvoiceNo: 'F-1001',
      lines: [{ accountId: 'a1', taxRateId: 't1', description: 'Printer paper', amount: 125 }],
    };
    const result = await gw.callTool('create_draft_bill', input);
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/bills',
      body: {
        bill: {
          contactId: 'c1',
          entryDate: '2026-11-19',
          dueDate: '2026-12-03',
          currencyId: 'DKK',
          suppliersInvoiceNo: 'F-1001',
          state: 'draft',
          lines: [{ accountId: 'a1', taxRateId: 't1', description: 'Printer paper', amount: 125, priority: 1 }],
        },
      },
    });
    expect(result.structuredContent).toEqual({ id: 'b9', state: 'draft', contactId: 'c1', amount: 125, lines: [{ id: 'l1', accountId: 'a1', amount: 125 }] });

    expect((await gw.callTool('create_draft_bill', { ...input, state: 'approved' })).isError).toBe(true);
    expect((await gw.callTool('create_draft_bill', { ...input, lines: [] })).isError).toBe(true);
    expect((await gw.callTool('create_draft_bill', { ...input, lines: [{ accountId: 'a1', description: 'x', amount: 1 }] })).isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('approves only a draft bill, and sends nothing for another', async () => {
    const draft = billy({
      'GET /bills/b1': { bill: { id: 'b1', state: 'draft' } },
      'PUT /bills/b1': { bills: [{ id: 'b1', state: 'approved' }] },
    });
    const ok = await draft.gw.callTool('approve_bill', { billId: 'b1' });
    expect(ok.structuredContent).toEqual({ id: 'b1', state: 'approved' });
    expect(draft.calls.at(-1)).toMatchObject({ method: 'PUT', path: '/bills/b1', body: { bill: { state: 'approved' } } });

    const approved = billy({ 'GET /bills/b1': { bill: { id: 'b1', state: 'approved' } } });
    const refused = await approved.gw.callTool('approve_bill', { billId: 'b1' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toMatch(/only a draft bill/);
    expect(approved.calls.map(c => c.method)).toEqual(['GET']);
  });

  it('uploads a file as its raw bytes to /files and attaches it to the bill, without the download address', async () => {
    const { gw, calls } = billy({
      'GET /bills/b1': { bill: { id: 'b1', state: 'draft' } },
      'POST /files': {
        files: [{ id: 'f1', fileName: 'invoice.pdf', fileSize: PDF.length, fileType: 'application/pdf', downloadUrl: 'https://download.example.test/invoice.pdf?token=zzzz' }],
      },
      'POST /attachments': { attachments: [{ id: 'att1', fileId: 'f1', ownerReference: 'bill:b1' }] },
    });
    const result = await gw.callTool('attach_bill_file', { billId: 'b1', fileName: 'invoice.pdf', contentBase64: PDF.toString('base64') });
    expect(result.isError).toBeUndefined();
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET /bills/b1', 'POST /files', 'POST /attachments']);
    const upload = calls[1]!;
    expect(upload.headers.get('content-type')).toBe('application/pdf');
    expect(upload.headers.get('x-filename')).toBe('invoice.pdf');
    expect(upload.headers.get('x-access-token')).toBe(TOKEN);
    expect(Buffer.from(upload.raw!).equals(PDF)).toBe(true);
    expect(calls[2]?.body).toEqual({ attachment: { ownerReference: 'bill:b1', fileId: 'f1' } });
    expect(result.structuredContent).toEqual({
      attachment: { id: 'att1', fileId: 'f1', ownerReference: 'bill:b1' },
      file: { id: 'f1', fileName: 'invoice.pdf', fileSize: PDF.length, fileType: 'application/pdf' },
    });
    expect(JSON.stringify(result)).not.toMatch(/download|token=/);
  });

  it('takes the type from the file itself, and refuses a mismatch, another type, a bad name or a voided bill', async () => {
    const routes = {
      'GET /bills/b1': { bill: { id: 'b1', state: 'approved' } },
      'GET /bills/b2': { bill: { id: 'b2', state: 'voided' } },
      'POST /files': { files: [{ id: 'f1' }] },
      'POST /attachments': { attachments: [{ id: 'att1', fileId: 'f1' }] },
    };
    const png = billy(routes);
    const ok = await png.gw.callTool('attach_bill_file', { billId: 'b1', fileName: 'Kvittering (1).PNG', contentBase64: PNG.toString('base64') });
    expect(ok.isError).toBeUndefined();
    expect(png.calls[1]?.headers.get('content-type')).toBe('image/png');

    const { gw, calls } = billy(routes);
    const attempts: GatewayJsonObject[] = [
      { billId: 'b1', fileName: 'invoice.png', contentBase64: PDF.toString('base64') },
      { billId: 'b1', fileName: 'invoice.pdf', contentBase64: Buffer.from('<html>not a pdf</html>').toString('base64') },
      { billId: 'b1', fileName: 'invoice.exe', contentBase64: PDF.toString('base64') },
      { billId: 'b1', fileName: 'faktura æ.pdf', contentBase64: PDF.toString('base64') },
      { billId: 'b1', fileName: 'a\r\nX-Other: 1.pdf', contentBase64: PDF.toString('base64') },
      { billId: 'b1', fileName: 'invoice.pdf', contentBase64: 'not base64!' },
      { billId: 'b1', fileName: 'invoice.pdf', contentBase64: '' },
    ];
    for (const input of attempts) {
      expect((await gw.callTool('attach_bill_file', input)).isError, JSON.stringify(input.fileName)).toBe(true);
    }
    expect(calls).toHaveLength(0);

    const voided = await gw.callTool('attach_bill_file', { billId: 'b2', fileName: 'invoice.pdf', contentBase64: PDF.toString('base64') });
    expect(voided.isError).toBe(true);
    expect(calls.map(c => c.method)).toEqual(['GET']);
  });
});

describe('sending an approved invoice', () => {
  const invoice = (fields: Record<string, unknown>) => ({ invoice: { id: 'i1', state: 'approved', contactId: 'c1', ...fields } });
  const person = (fields: Record<string, unknown>) => ({ contactPerson: { id: 'cp1', contactId: 'c1', email: 'buyer@example.test', ...fields } });
  const input = { invoiceId: 'i1', contactPersonId: 'cp1', emailSubject: 'Faktura 41', emailBody: 'Hermed fakturaen.' };

  it("e-mails it to a contact person of the invoice's customer", async () => {
    const { gw, calls } = billy({ 'GET /invoices/i1': invoice({}), 'GET /contactPersons/cp1': person({}), 'POST /invoices/i1/emails': {} });
    const result = await gw.callTool('send_invoice', input);
    expect(result.isError).toBeUndefined();
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/invoices/i1/emails',
      body: { email: { contactPersonId: 'cp1', emailSubject: 'Faktura 41', emailBody: 'Hermed fakturaen.' } },
    });
    expect(result.structuredContent).toEqual({ sent: true, invoiceId: 'i1', contactPersonId: 'cp1' });
  });

  it('refuses a draft, a contact person of another customer or one without an e-mail, and sends nothing', async () => {
    for (const [inv, per] of [
      [invoice({ state: 'draft' }), person({})],
      [invoice({ state: 'voided' }), person({})],
      [invoice({}), person({ contactId: 'c2' })],
      [invoice({ contactId: null }), person({ contactId: null })],
      [invoice({}), person({ email: null })],
      [invoice({}), person({ email: 'no address' })],
    ]) {
      const { gw, calls } = billy({ 'GET /invoices/i1': inv, 'GET /contactPersons/cp1': per, 'POST /invoices/i1/emails': {} });
      const result = await gw.callTool('send_invoice', input);
      expect(result.isError, JSON.stringify([inv, per])).toBe(true);
      expect(calls.every(c => c.method === 'GET')).toBe(true);
    }
  });
});

describe('deleting drafts', () => {
  it('deletes a draft invoice that was never approved or sent, and nothing else', async () => {
    const deleted = { meta: { deletedRecords: { invoices: ['i1'] } } };
    const draft = billy({ 'GET /invoices/i1': { invoice: { id: 'i1', state: 'draft', sentState: 'unsent' } }, 'DELETE /invoices/i1': deleted });
    const ok = await draft.gw.callTool('delete_draft_invoice', { invoiceId: 'i1' });
    expect(ok.structuredContent).toEqual({ deleted: true, invoiceId: 'i1' });
    expect(draft.calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET /invoices/i1', 'DELETE /invoices/i1']);
    expect(draft.calls[1]?.body).toBeUndefined();

    for (const current of [
      { state: 'approved' },
      { state: 'voided' },
      { state: 'draft', sentState: 'sent' },
      { state: 'draft', sentState: 'printed' },
      { state: 'draft', approvedTime: '2026-11-19T10:00:00' },
    ]) {
      const { gw, calls } = billy({ 'GET /invoices/i1': { invoice: { id: 'i1', ...current } }, 'DELETE /invoices/i1': deleted });
      const result = await gw.callTool('delete_draft_invoice', { invoiceId: 'i1' });
      expect(result.isError, JSON.stringify(current)).toBe(true);
      expect(calls.map(c => c.method)).toEqual(['GET']);
    }
  });

  it('deletes a draft bill that was never approved, and nothing else', async () => {
    const deleted = { meta: { deletedRecords: { bills: ['b1'] } } };
    const draft = billy({ 'GET /bills/b1': { bill: { id: 'b1', state: 'draft' } }, 'DELETE /bills/b1': deleted });
    expect((await draft.gw.callTool('delete_draft_bill', { billId: 'b1' })).structuredContent).toEqual({ deleted: true, billId: 'b1' });

    for (const current of [{ state: 'approved' }, { state: 'voided' }, { state: 'draft', approvedTime: '2026-11-19T10:00:00' }]) {
      const { gw, calls } = billy({ 'GET /bills/b1': { bill: { id: 'b1', ...current } }, 'DELETE /bills/b1': deleted });
      expect((await gw.callTool('delete_draft_bill', { billId: 'b1' })).isError, JSON.stringify(current)).toBe(true);
      expect(calls.map(c => c.method)).toEqual(['GET']);
    }
  });

  it('reports an error when Billy does not name the record as deleted', async () => {
    const { gw } = billy({ 'GET /bills/b1': { bill: { id: 'b1', state: 'draft' } }, 'DELETE /bills/b1': { meta: { deletedRecords: { bills: [] } } } });
    const result = await gw.callTool('delete_draft_bill', { billId: 'b1' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/without the expected data/);
  });
});

describe('catalog and logs', () => {
  it('lists the new tools as ordinary writes, deleting drafts included, none needing a confirmation', () => {
    const byName = new Map(billyToolCatalog.map(entry => [entry.name, entry]));
    for (const name of ['send_invoice', 'delete_draft_invoice', 'create_draft_bill', 'attach_bill_file', 'approve_bill', 'delete_draft_bill']) {
      const entry = byName.get(name)!;
      expect([entry.riskLevel, entry.enabledByDefault, entry.requiresConfirmation, entry.broad], name).toEqual(['write', false, false, false]);
      expect(entry.change?.movesMoney, name).toBe(false);
    }
    expect(byName.get('delete_draft_bill')?.change).toMatchObject({ action: 'delete', record: 'bill' });
    expect(byName.get('send_invoice')?.change).toMatchObject({ action: 'send', record: 'invoice' });
    expect(byName.get('attach_bill_file')?.change).toMatchObject({ action: 'attach', record: 'bill' });
  });

  it('resolves ids, dates, currencies and counts for a host log, never a text, a file name or the file', () => {
    const send = resolveBillyChange('send_invoice', { invoiceId: 'i1', contactPersonId: 'cp1', emailSubject: 'Faktura 41', emailBody: 'Hej Jens' });
    expect(send.ok && send.change.values).toEqual({ invoiceId: 'i1', contactPersonId: 'cp1' });
    const attach = resolveBillyChange('attach_bill_file', { billId: 'b1', fileName: 'invoice.pdf', contentBase64: PDF.toString('base64') });
    expect(attach.ok && attach.change.values).toEqual({ billId: 'b1' });
    const bill = resolveBillyChange('create_draft_bill', {
      contactId: 'c1',
      entryDate: '2026-11-19',
      currencyId: 'DKK',
      voucherNo: 'V-7',
      lines: [{ accountId: 'a1', taxRateId: 't1', description: 'Paper', amount: 10 }],
    });
    expect(bill.ok && bill.change.values).toEqual({
      contactId: 'c1',
      entryDate: '2026-11-19',
      currencyId: 'DKK',
      voucherNo: expect.stringMatching(/^sha256:[0-9a-f]{16}$/),
      lines: 1,
    });
    expect(JSON.stringify([send, attach, bill])).not.toMatch(/Jens|Faktura|invoice\.pdf|Paper|V-7|JVBER/);
  });

  it("keeps the file, the e-mail's text and the file name out of the server's own audit records", async () => {
    const records: Array<Readonly<Record<string, unknown>>> = [];
    const { gw } = billy(
      {
        'GET /bills/b1': { bill: { id: 'b1', state: 'draft' } },
        'POST /files': { files: [{ id: 'f1' }] },
        'POST /attachments': { attachments: [{ id: 'att1', fileId: 'f1' }] },
        'GET /invoices/i1': { invoice: { id: 'i1', state: 'approved', contactId: 'c1' } },
        'GET /contactPersons/cp1': { contactPerson: { id: 'cp1', contactId: 'c1', email: 'buyer@example.test' } },
        'POST /invoices/i1/emails': {},
      },
      record => void records.push(record),
    );
    await gw.callTool('attach_bill_file', { billId: 'b1', fileName: 'secret-name.pdf', contentBase64: PDF.toString('base64') });
    await gw.callTool('send_invoice', { invoiceId: 'i1', contactPersonId: 'cp1', emailSubject: 'Private subject', emailBody: 'Private body' });
    expect(records.length).toBeGreaterThan(3);
    expect(JSON.stringify(records)).not.toMatch(/secret-name|Private|JVBER|buyer@/);
  });
});
