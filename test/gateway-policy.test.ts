import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { pseudonym } from '../src/tools/billy.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBillyGateway } from '../src/gateway.js';
import { BASE, stubFetch, texts } from './helpers.js';

const originalEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'billy-policy-'));
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

const KEY = `tenant-${'x'.repeat(12)}`;

function routes() {
  return stubFetch({
    [`GET ${BASE}/contacts/i1`]: { body: { contact: { id: 'i1' } } },
    [`POST ${BASE}/contacts`]: { body: { contacts: [{ id: 'new' }] } },
  });
}

/** Records every environment variable read while `work` runs. */
async function envReads(work: () => Promise<void>): Promise<Set<string>> {
  const reads = new Set<string>();
  const env = { ...process.env };
  process.env = new Proxy(env, {
    get(target, property, receiver) {
      if (typeof property === 'string') {
        reads.add(property);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  try {
    await work();
  } finally {
    process.env = env;
  }
  return reads;
}

describe('instance policy from the host', () => {
  it('reads no policy or audit variable from the environment', async () => {
    process.env.BILLY_ENABLE_WRITES = 'true';
    process.env.BILLY_DISABLED_TOOLS = 'get_contact';
    process.env.BILLY_AUDIT_LOG = join(dir, 'audit.jsonl');
    process.env.BILLY_ALLOW_CUSTOM_BASE_URL = 'true';

    const reads = await envReads(async () => {
      const gw = createBillyGateway({ accessToken: KEY, baseUrl: BASE, fetchImpl: routes() as unknown as typeof fetch, policy: {} });
      expect(gw.tools.map(tool => tool.name)).toContain('get_contact');
      const read = await gw.callTool('get_contact', { contactId: 'i1' });
      expect(read.isError).toBeUndefined();
      const write = await gw.callTool('create_contact', { name: 'n', countryId: 'DK', paymentTermsDays: 8 });
      expect(write.isError).toBe(true);
      expect(texts(write).join(' ')).toMatch(/host has not enabled writes/);
    });

    for (const name of ['BILLY_ENABLE_WRITES', 'BILLY_DISABLED_TOOLS', 'BILLY_AUDIT_LOG', 'BILLY_ALLOW_CUSTOM_BASE_URL']) {
      expect(reads.has(name), name).toBe(false);
    }
    expect(existsSync(join(dir, 'audit.jsonl'))).toBe(false);
  });

  it('keeps two instances in one process apart', async () => {
    const fetchImpl = routes() as unknown as typeof fetch;
    const a = createBillyGateway({ accessToken: KEY, baseUrl: BASE, fetchImpl, policy: { disabledTools: ['get_contact'] } });
    const b = createBillyGateway({ accessToken: KEY, baseUrl: BASE, fetchImpl, policy: { enableWrites: true } });

    expect(a.tools.map(tool => tool.name)).not.toContain('get_contact');
    expect(b.tools.map(tool => tool.name)).toContain('get_contact');

    const [denied, allowed] = await Promise.all([
      a.callTool('get_contact', { contactId: 'i1' }),
      b.callTool('create_contact', { name: 'n', countryId: 'DK', paymentTermsDays: 8 }),
    ]);
    expect(denied.isError).toBe(true);
    expect(texts(denied).join(' ')).toMatch(/disabled on this instance/);
    expect(allowed.isError).toBeUndefined();
  });

  it('sends audit records to the host and refuses a write whose start record is refused', async () => {
    const records: Array<Record<string, unknown>> = [];
    const gw = createBillyGateway({
      accessToken: KEY,
      baseUrl: BASE,
      fetchImpl: routes() as unknown as typeof fetch,
      policy: { enableWrites: true, audit: record => void records.push({ ...record }) },
    });
    await gw.callTool('get_contact', { contactId: 'i1' }, { requestId: 'r1', caller: 'person-1' });
    expect(records.map(r => [r.requestId, r.action, r.caller])).toEqual([
      [pseudonym('r1'), 'start', expect.stringMatching(/^sha256:[0-9a-f]{16}$/)],
      [pseudonym('r1'), 'finish', expect.stringMatching(/^sha256:[0-9a-f]{16}$/)],
    ]);

    const fetchImpl = routes();
    const refusing = createBillyGateway({
      accessToken: KEY,
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      policy: {
        enableWrites: true,
        audit: () => {
          throw new Error('sink down');
        },
      },
    });
    const write = await refusing.callTool('create_contact', { name: 'n', countryId: 'DK', paymentTermsDays: 8 });
    expect(write.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an unclear policy when the instance is created', () => {
    const create = (policy: unknown) => () =>
      createBillyGateway({ accessToken: KEY, baseUrl: BASE, policy: policy as never });
    expect(create({ disabledTools: ['no_such_tool'] })).toThrow(/is not a known tool/);
    expect(create({ enableWrites: 'yes' })).toThrow(/enableWrites/);
    expect(create({ audit: 'file.jsonl' })).toThrow(/audit/);
    expect(create(null)).toThrow(/policy/);
  });

  it('still uses the environment without a host policy', async () => {
    process.env.BILLY_ENABLE_WRITES = 'true';
    const gw = createBillyGateway({ accessToken: KEY, baseUrl: BASE, fetchImpl: routes() as unknown as typeof fetch });
    const write = await gw.callTool('create_contact', { name: 'n', countryId: 'DK', paymentTermsDays: 8 });
    expect(write.isError).toBeUndefined();
  });
});
