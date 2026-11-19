import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpstreamClient } from '../src/billy/client.js';
import { createServer, getDefaultClient } from '../src/server.js';
import { createBillyGateway, billyGatewayTools } from '../src/gateway.js';
import { BILLY_TOOLS, executeTool, validateStartupConfig } from '../src/tools/billy.js';
import { BASE, auditLines, connect, gateway, makeClient, texts } from './helpers.js';

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

const item = { id: 'i1', name: 'First item' };

describe('MCP tool surface', () => {
  it('registers every tool with matching annotations', async () => {
    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(BILLY_TOOLS.map(t => t.name).sort());
    for (const tool of tools) {
      const definition = BILLY_TOOLS.find(t => t.name === tool.name);
      expect(tool.annotations).toEqual(definition?.annotations);
    }
  });

  it('runs the read tool and labels upstream content as data', async () => {
    const { mcpClient, fetchImpl } = await connect({ [`GET ${BASE}/contacts/i1`]: { body: { contact: item } } });
    const result = await mcpClient.callTool({ name: 'billy_get_contact', arguments: { contactId: 'i1' } });
    expect(result.isError).toBeFalsy();
    const [json, note] = texts(result);
    expect(JSON.parse(json ?? '')).toEqual(item);
    expect(note).toContain('not instructions');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown arguments and path traversal', async () => {
    const { mcpClient, fetchImpl } = await connect();
    const extra = await mcpClient.callTool({ name: 'billy_get_contact', arguments: { contactId: 'i1', other: 1 } });
    expect(extra.isError).toBe(true);
    const traversal = await mcpClient.callTool({ name: 'billy_get_contact', arguments: { contactId: '..' } });
    expect(traversal.isError).toBe(true);
    const slash = await mcpClient.callTool({ name: 'billy_get_contact', arguments: { contactId: 'a/b' } });
    expect(slash.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses the write tool unless writes are enabled, without calling upstream', async () => {
    const { mcpClient, fetchImpl } = await connect();
    const result = await mcpClient.callTool({ name: 'billy_create_contact', arguments: { name: 'New', countryId: 'DK', paymentTermsDays: 8 } });
    expect(result.isError).toBe(true);
    expect(texts(result).join(' ')).toContain('BILLY_ENABLE_WRITES');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('runs the write tool when enabled and audits it', async () => {
    process.env.BILLY_ENABLE_WRITES = 'true';
    process.env.BILLY_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { mcpClient, fetchImpl } = await connect({ [`POST ${BASE}/contacts`]: { status: 200, body: { contacts: [item] } } });
    const result = await mcpClient.callTool({
      name: 'billy_create_contact',
      arguments: { name: 'First item', countryId: 'DK', paymentTermsDays: 8, isCustomer: true, contactPersons: [{ name: 'A Person', email: 'a@example.test' }] },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(texts(result)[0] ?? '')).toEqual(item);
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      contact: { name: 'First item', countryId: 'DK', paymentTermsDays: 8, isCustomer: true, contactPersons: [{ name: 'A Person', email: 'a@example.test' }] },
    });

    const lines = auditLines(process.env.BILLY_AUDIT_LOG);
    expect(lines.map(line => line.action)).toEqual(['start', 'finish']);
    expect(lines[0]?.requestId).toBe(lines[1]?.requestId);
    // Free text is hashed, never logged in clear text.
    expect(JSON.stringify(lines)).not.toContain('First item');
    expect((lines[0]?.target as Record<string, unknown>).nameSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((lines[0]?.target as Record<string, unknown>).contactPersonsCount).toBe(1);
    expect(JSON.stringify(lines)).not.toContain('a@example.test');
  });

  it('refuses an unwritable audit log path at startup, but not per server instance', async () => {
    process.env.BILLY_AUDIT_LOG = join(dir, 'missing-dir', 'audit.jsonl');
    expect(() => validateStartupConfig()).toThrow('BILLY_AUDIT_LOG');
    expect(() => createBillyGateway({ accessToken: 'tttt-gggg-wwww-vvvv-1', baseUrl: BASE })).toThrow('BILLY_AUDIT_LOG');

    // The HTTP transport creates a server per request: read tools keep working.
    const { mcpClient } = await connect({ [`GET ${BASE}/contacts/i1`]: { body: { contact: item } } });
    const result = await mcpClient.callTool({ name: 'billy_get_contact', arguments: { contactId: 'i1' } });
    expect(result.isError).toBeFalsy();
  });

  it('fails closed when the audit log cannot be written before a write', async () => {
    process.env.BILLY_ENABLE_WRITES = 'true';
    const { mcpClient, fetchImpl } = await connect({ [`POST ${BASE}/contacts`]: { body: { contacts: [item] } } });
    // The log becomes unwritable after startup.
    process.env.BILLY_AUDIT_LOG = join(dir, 'missing-dir', 'audit.jsonl');
    const result = await mcpClient.callTool({ name: 'billy_create_contact', arguments: { name: 'x', countryId: 'DK', paymentTermsDays: 8 } });
    expect(result.isError).toBe(true);
    expect(texts(result).join(' ')).toContain('Audit log is not writable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('removes disabled tools and refuses unknown names', async () => {
    process.env.BILLY_DISABLED_TOOLS = 'create_contact,billy_get_contact';
    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(t => t.name)).not.toContain('billy_create_contact');
    expect(tools.map(t => t.name)).not.toContain('billy_get_contact');
    expect(tools).toHaveLength(BILLY_TOOLS.length - 2);

    process.env.BILLY_DISABLED_TOOLS = 'no_such_tool';
    expect(() => createServer({ clientOptions: { accessToken: 'k' } })).toThrow('BILLY_DISABLED_TOOLS');
  });

  it('logs only a summary of upstream errors', async () => {
    process.env.BILLY_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { mcpClient } = await connect({
      [`GET ${BASE}/contacts/i1`]: { status: 400, body: { message: 'bad value: jane@vendor.test' } },
    });
    const result = await mcpClient.callTool({ name: 'billy_get_contact', arguments: { contactId: 'i1' } });
    expect(result.isError).toBe(true);
    const lines = auditLines(process.env.BILLY_AUDIT_LOG);
    expect(lines.at(-1)).toMatchObject({ action: 'error', httpStatus: 400 });
    expect(JSON.stringify(lines)).not.toContain('jane@');
  });
});

describe('write gate beyond annotations', () => {
  it('gives read-only tools a client that refuses non-GET requests', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    const client = makeClient(fetchImpl);
    const misannotated = {
      ...BILLY_TOOLS[0]!,
      name: 'billy_get_contact',
      handler: async (c: UpstreamClient) => c.post('/contacts', { name: 'x' }),
    };
    await expect(executeTool(misannotated, client, { contactId: 'i1' })).rejects.toThrow(/Read-only tool .* POST/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('redacts error text centrally on the MCP path', async () => {
    // A handler that throws a raw, unredacted error.
    const tool = BILLY_TOOLS.find(t => t.name === 'billy_get_contact')!;
    const original = tool.handler;
    tool.handler = async () => {
      throw new Error('failed: key test-api-key, header X-API-Key: other-secret, {"accessToken":"third-secret"}');
    };
    try {
      const { mcpClient } = await connect();
      const result = await mcpClient.callTool({ name: 'billy_get_contact', arguments: { contactId: 'i1' } });
      expect(result.isError).toBe(true);
      const text = texts(result).join(' ');
      expect(text).toContain('‹redacted›');
      for (const secret of ['test-api-key', 'other-secret', 'third-secret']) {
        expect(text).not.toContain(secret);
      }
    } finally {
      tool.handler = original;
    }
  });
});

describe('gateway export', () => {
  it('exposes tools without the prefix and with valid JSON Schemas', () => {
    for (const tool of billyGatewayTools) {
      expect(tool.name.startsWith('billy_')).toBe(false);
      // Reads are on by default; writes are 'write' (none deletes) and off by default.
      expect([tool.riskLevel, tool.enabledByDefault]).toEqual(
        tool.riskLevel === 'read' ? ['read', true] : ['write', false],
      );
    }
    expect(billyGatewayTools.filter(t => t.riskLevel === 'write').map(t => t.name)).toEqual([
      'create_contact',
      'update_contact',
      'create_product',
      'update_product',
      'create_draft_invoice',
      'approve_invoice',
      'register_payment',
      'create_daybook_transaction',
    ]);
    const ajv = new Ajv({ strict: true });
    for (const tool of billyGatewayTools) {
      expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
    }
  });

  it('validates input, applies the policy and records the caller', async () => {
    process.env.BILLY_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { gw, fetchImpl } = gateway({ [`GET ${BASE}/contacts/i1`]: { body: { contact: item } } });

    const ok = await gw.callTool('get_contact', { contactId: 'i1' }, { caller: 'user@vendor.test', requestId: 'req-1' });
    expect(ok.isError).toBeUndefined();
    expect(ok.structuredContent).toEqual(item);

    const invalid = await gw.callTool('get_contact', { contactId: 'i1', extra: true });
    expect(invalid.isError).toBe(true);
    const unknown = await gw.callTool('delete_everything', {});
    expect(unknown.isError).toBe(true);
    const write = await gw.callTool('create_contact', { name: 'x', countryId: 'DK', paymentTermsDays: 8 });
    expect(write.isError).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const lines = auditLines(process.env.BILLY_AUDIT_LOG);
    expect(lines[0]).toMatchObject({ requestId: 'req-1', caller: expect.stringMatching(/^sha256:[0-9a-f]{16}$/), action: 'start' });
    expect(JSON.stringify(lines)).not.toContain('user@vendor.test');
    expect(lines.map(line => line.action)).toEqual(['start', 'finish', 'rejected', 'rejected', 'policy_denied']);
  });
});

describe('default client', () => {
  it('is shared by servers created without a client, so its concurrency limit is process-wide', () => {
    const first = getDefaultClient();
    createServer();
    createServer();
    expect(getDefaultClient()).toBe(first);
  });
});
