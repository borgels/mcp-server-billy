import { z } from 'zod/v4';
import { UNTRUSTED_CONTENT_NOTE } from './billy/annotations.js';
import { BillyClient, DEFAULT_BASE_URL, type BillyClientOptions } from './billy/client.js';
import {
  isToolDisabled,
  resolveInstancePolicy,
  runInCallScope,
  TOOL_PREFIX,
  type InstancePolicy,
} from './billy/policy.js';
import { ConfigError } from './config-env.js';
import { formatUnknownError, redactDeep, SecretRedactor } from './errors.js';
import { fixedOutputs, withheldResult } from './fallbacks.js';
import { admitsKey, keyRefusedText, leaksSecret, sealedError } from './key-admission.js';
import {
  auditRejectedCall,
  BILLY_TOOLS,
  executeTool,
  findTool,
  logFieldValue,
  validateStartupConfig,
  type BillyChangeAction,
  type BillyChangeRecord,
  type BillyChangeSpec,
  type CallContext,
  type ToolDefinition,
  type UpstreamOperation,
} from './tools/billy.js';

/**
 * Embeddable entry point (package export `./gateway`): an embedding host,
 * such as an MCP gateway that does its own per-user authorization, lists
 * `tools` and invokes `callTool`. Tool definitions, input validation,
 * instance policy and audit are shared with the MCP server in
 * src/tools/billy.ts.
 *
 * One instance per Billy company: a Billy access token is tied to one
 * company ("The tokens you create under Settings -> Access tokens are tied
 * to that company only", https://www.billy.dk/api). Several instances can
 * run in one process. Each instance uses only the credentials passed to
 * createBillyGateway (never BILLY_ACCESS_TOKEN or BILLY_BASE_URL from the
 * environment) and redacts errors with its own secrets only.
 *
 * Instance policy (writes, disabled tools, audit) comes from the host when it
 * passes `policy`: that instance then reads none of BILLY_ENABLE_WRITES,
 * BILLY_DISABLED_TOOLS, BILLY_AUDIT_LOG or BILLY_ALLOW_CUSTOM_BASE_URL,
 * so two tenants in one process can have different settings. Without
 * `policy` the instance uses the environment, as the MCP server does. Limits
 * (timeouts, retries) are still read from the environment and apply to every
 * instance.
 *
 * What no policy can turn on: a request outside the client's fixed list of
 * writes (src/billy/client.ts, ALLOWED_WRITES). There is no DELETE, and no
 * tool that changes the chart of accounts, VAT rates, the company's details
 * or bank details, sends an invoice (e-mail or e-invoice) or moves money.
 */

export type { AuditSink, InstancePolicy } from './billy/policy.js';
export type {
  BillyChangeAction,
  BillyChangeRecord,
  BillyChangeSpec,
  BillyLogField,
  BillyLogFieldType,
} from './tools/billy.js';

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue = string | number | boolean | null | GatewayJsonValue[] | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
}

export type GatewayCallContext = CallContext;

/** Deeply read-only JSON, as found in the frozen tool catalog. */
export type GatewayReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly GatewayReadonlyJsonValue[]
  | { readonly [key: string]: GatewayReadonlyJsonValue };

/** One upstream request a tool may make (method and path template relative to the base URL). */
export type GatewayUpstreamOperation = Readonly<UpstreamOperation>;

/** A tool catalog entry: the gateway definition plus the upstream requests the tool may make. */
export interface GatewayToolCatalogEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly riskLevel: GatewayRiskLevel;
  readonly enabledByDefault: boolean;
  readonly inputSchema: { readonly [key: string]: GatewayReadonlyJsonValue };
  readonly upstream: readonly GatewayUpstreamOperation[];
  /**
   * True when the tool can read more than its name says (anything in the
   * system, chosen by the input). A host that grants tools per role gives a
   * broad tool only to roles that may read everything. From the tool table
   * (`broad`), false unless a tool declares it.
   */
  readonly broad: boolean;
  /**
   * True for a tool a person should confirm outside the chat before it runs:
   * registering a payment (it records a payment in the books; no money moves).
   */
  readonly requiresConfirmation: boolean;
  /**
   * Write tools only: what the change does, for a host that logs a change
   * before it is sent. `logFields` are the input fields that identify it,
   * each with the one type its value must have (Billy record ids, amounts,
   * currency codes, dates, counts, flags and kinds in clear; numbers the
   * company chose only as pseudonyms; never names or free text).
   * `resolveBillyChange` returns their values.
   */
  readonly change?: BillyChangeSpec;
}

export interface BillyGatewayOptions extends Omit<BillyClientOptions, 'accessToken' | 'baseUrl' | 'credentialEnv'> {
  /** The company's access token (Billy: Settings -> Access tokens). Required; never read from the environment. */
  accessToken: string;
  /**
   * API base URL. Optional: Billy's documented endpoint
   * (https://api.billysbilling.com/v2) by default; only Billy's own hosts
   * are accepted under a host policy. Never read from the environment.
   */
  baseUrl?: string;
  /**
   * Instance policy from the host. When given, the instance reads no policy
   * or audit variables from the environment (see InstancePolicy). A host
   * serving several tenants should always pass it.
   */
  policy?: InstancePolicy;
}

/**
 * JSON Schema for a gateway tool, derived from the tool's zod schema.
 * `format` is dropped: validators such as Ajv reject unknown formats in
 * strict mode unless format plugins are installed, and zod already checks
 * these values when the call runs.
 */
function toGatewayJsonSchema(tool: ToolDefinition): GatewayJsonObject {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.inputSchema, {
    io: 'input',
    override: ctx => {
      delete (ctx.jsonSchema as Record<string, unknown>).format;
    },
  }) as Record<string, unknown>;
  return schema as GatewayJsonObject;
}

function stripPrefix(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

function toGatewayDefinition(tool: ToolDefinition): GatewayToolDefinition {
  return {
    name: stripPrefix(tool.name),
    title: tool.title,
    description: tool.description,
    riskLevel: tool.annotations.readOnlyHint ? 'read' : tool.annotations.destructiveHint ? 'destructive' : 'write',
    enabledByDefault: tool.annotations.readOnlyHint,
    inputSchema: toGatewayJsonSchema(tool),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

/** All tools, as gateway definitions (names without the prefix). */
export const billyGatewayTools: GatewayToolDefinition[] = BILLY_TOOLS.map(toGatewayDefinition);

/**
 * The tool catalog: every tool with its gateway definition and the upstream
 * requests it may make. Generated from the same tool table as the MCP server
 * and `billyGatewayTools`, and deeply frozen. Hosts can use it to build
 * their own permission model without creating a gateway instance.
 */
export const billyToolCatalog: readonly GatewayToolCatalogEntry[] = deepFreeze(
  BILLY_TOOLS.map(tool => ({
    ...toGatewayDefinition(tool),
    upstream: tool.upstream.map(operation => ({ ...operation })),
    broad: tool.broad === true,
    requiresConfirmation: tool.requiresConfirmation === true,
    ...(tool.change
      ? { change: { ...tool.change, logFields: tool.change.logFields.map(field => ({ ...field })) } }
      : {}),
  })),
);

/** What a write tool call will change, resolved from its input before anything is sent. */
export interface BillyChange {
  readonly tool: string;
  readonly action: BillyChangeAction;
  readonly record: BillyChangeRecord;
  readonly movesMoney: false;
  readonly requiresConfirmation: boolean;
  /**
   * The values of the tool's `logFields` that are present and have their
   * field's type. A value of the wrong type is left out, so a name or a free
   * text can never reach the values.
   */
  readonly values: Readonly<Record<string, string | number | boolean>>;
}

export type BillyChangeResolution =
  | { readonly ok: true; readonly change: BillyChange }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolves what a write tool call will change, for a host that logs the
 * change before the call runs: the action, the record kind and the values of
 * the tool's `logFields`. A number the company chose (contact, product or
 * voucher number) comes back only as a pseudonym: HMAC-SHA-256 with
 * `options.pseudonymKey` when the host gives one, otherwise SHA-256. Refuses
 * read tools, unknown tools and invalid input, as callTool does.
 */
export function resolveBillyChange(
  toolName: string,
  input: GatewayJsonObject = {},
  options: { pseudonymKey?: string | Uint8Array } = {},
): BillyChangeResolution {
  const name = typeof toolName === 'string' ? toolName.trim() : '';
  const tool = name ? findTool(`${TOOL_PREFIX}${stripPrefix(name)}`) : undefined;
  if (!tool) return { ok: false, reason: 'Unsupported Billy gateway tool.' };
  if (!tool.change) return { ok: false, reason: `${stripPrefix(tool.name)} is not a write tool.` };
  const parsed = tool.inputSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, reason: `Invalid input for ${stripPrefix(tool.name)}.` };
  const data = parsed.data as Record<string, unknown>;
  const values: Record<string, string | number | boolean> = {};
  for (const field of tool.change.logFields) {
    const value = logFieldValue(field.type, data[field.name], options.pseudonymKey);
    if (value !== undefined) values[field.name] = value;
  }
  return {
    ok: true,
    change: Object.freeze({
      tool: stripPrefix(tool.name),
      action: tool.change.action,
      record: tool.change.record,
      movesMoney: false as const,
      requiresConfirmation: tool.requiresConfirmation === true,
      values: Object.freeze(values),
    }),
  };
}

function requiredCredential(options: BillyGatewayOptions, name: 'accessToken'): string {
  const value: unknown = (options as Partial<BillyGatewayOptions> | undefined)?.[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(
      `createBillyGateway requires options.${name}. Embedded instances do not read credentials from the environment.`,
    );
  }
  // Key admission (src/key-admission.ts): printable ASCII of 16 characters or more, sharing no piece with any text of
  // ours. Checked before anything is built from the key; the refusal is a fixed text that holds no piece of it.
  if (!admitsKey(value.trim())) {
    throw new ConfigError(keyRefusedText(value.trim()));
  }
  return value.trim();
}

/**
 * Create one gateway instance for one Billy company. `accessToken` is
 * required and is the only credential the instance uses; a missing value
 * fails here.
 */
export function createBillyGateway(options: BillyGatewayOptions) {
  let accessToken: string | undefined;
  let guard: SecretRedactor | undefined;
  // What the host gave, admitted or not: every error is masked against it.
  const given: unknown = (options as Partial<BillyGatewayOptions> | undefined)?.accessToken;
  const secrets = typeof given === 'string' ? [given, given.trim()] : [];
  try {
    // Admission first, before a redactor is built from the key.
    accessToken = requiredCredential(options, 'accessToken');
    guard = new SecretRedactor().addSecret(accessToken);
    // The fixed outputs of the sink check (src/fallbacks.ts) must hold no piece of the key.
    if (leaksSecret(fixedOutputs(), guard)) {
      throw new ConfigError(keyRefusedText(accessToken));
    }
    const gateway = buildGateway(options, accessToken);
    // The tool list leaves the gateway as it is: a key that shares a piece with it is refused.
    if (leaksSecret(gateway.tools, guard)) {
      throw new ConfigError(keyRefusedText(accessToken));
    }
    return gateway;
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    let message = raw;
    if (guard && accessToken !== undefined) {
      // Redacted, then checked whole as the very last step: a message that still holds a piece of the key becomes
      // the fixed refusal.
      message = guard.redact(raw);
      if (leaksSecret(message, guard)) message = keyRefusedText(accessToken);
    }
    // A fresh error in final form (src/key-admission.ts, sealedError): no cause, a stack without frames, and name,
    // message and stack masked against the key. Then the sink check on the finished object.
    const final = sealedError(error instanceof ConfigError ? new ConfigError(message) : new Error(message), ...secrets);
    if (guard && accessToken !== undefined && leaksSecret(final, guard)) {
      throw sealedError(new ConfigError(keyRefusedText(accessToken)), ...secrets);
    }
    throw final;
  }
}

function buildGateway(options: BillyGatewayOptions, accessToken: string) {
  const { policy: hostPolicy, ...clientOptions } = options;
  const baseUrl = typeof options.baseUrl === 'string' && options.baseUrl.trim() !== '' ? options.baseUrl.trim() : DEFAULT_BASE_URL;
  const policy =
    hostPolicy === undefined ? undefined : resolveInstancePolicy(hostPolicy, BILLY_TOOLS.map(tool => tool.name));
  if (policy === undefined) {
    // In a scope of its own: a gateway created from inside another instance's call (its audit sink or its fetch)
    // validates against the environment, never against that instance's policy.
    runInCallScope({}, () => validateStartupConfig());
  }
  const client = new BillyClient({
    ...clientOptions,
    accessToken,
    baseUrl,
    credentialEnv: {},
    // Under a host's policy nothing is read from the environment, this switch included.
    ...(policy ? { allowCustomBaseUrl: clientOptions.allowCustomBaseUrl ?? false } : {}),
  });
  const redactor: SecretRedactor = client.redactor;
  // Every call in a scope of its own, with or without a host policy: a call made from inside another
  // instance's call (its audit sink or its fetch) never runs under that instance's policy, sink or redactor.
  const underPolicy = <T>(work: () => T): T => runInCallScope(policy ? { policy, redactor } : { redactor }, work);

  return {
    /** Tools enabled on this instance (the policy's or BILLY_DISABLED_TOOLS' disabled tools are left out). */
    tools: underPolicy(() => billyGatewayTools.filter(tool => !isToolDisabled(tool.name))),
    callTool(toolName: string, input: GatewayJsonObject = {}, context?: GatewayCallContext): Promise<GatewayToolResult> {
      // The whole result, text and data (keys included, numbers by their string form), with this instance's secrets
      // redacted: upstream data can echo the key, and so can an error. Redacted first, as data and depth-limited, and
      // only then copied as JSON, so no key is serialised and no deep value can exhaust the stack.
      return underPolicy(() =>
        runCall(toolName, input, context).then(
          // A second pass covers what the first one inserted (the depth placeholder). Then the sink check, as the very
          // last step: a result that holds a piece of the key anywhere, outer fields included, is withheld whole.
          result => {
            // The data also goes into the text, built from this final, redacted copy, so the sink check covers it.
            const final = withDataInText(
              JSON.parse(JSON.stringify(redactDeep(redactDeep(result, redactor), redactor))) as GatewayToolResult,
            );
            return leaksSecret(final, redactor) ? withheldResult() : final;
          },
        ),
      );
    },
  };

  async function runCall(
    toolName: string,
    input: GatewayJsonObject,
    context: GatewayCallContext | undefined,
  ): Promise<GatewayToolResult> {
    try {
      const name = typeof toolName === 'string' ? toolName.trim() : '';
      const tool = name ? findTool(`${TOOL_PREFIX}${stripPrefix(name)}`) : undefined;
      if (!tool) {
        // Redacted before it is cut short: a cut key would no longer match the redactor.
        const reason = `Unsupported Billy gateway tool: ${redactor.redact(String(toolName)).slice(0, 100)}`;
        await auditRejectedCall(String(toolName), input, reason, context);
        return errorResult(redactor.redact(reason));
      }

      const parsed = tool.inputSchema.safeParse(input ?? {});
      if (!parsed.success) {
        const reason = `Invalid input for ${name}: ${z.prettifyError(parsed.error)}`;
        await auditRejectedCall(tool.name, input, 'invalid input', context);
        return errorResult(redactor.redact(reason));
      }

      const data = await executeTool(tool, client, parsed.data as Record<string, unknown>, context ?? undefined);
      const text = tool.returnsUpstreamContent ? `${tool.summary} ${UNTRUSTED_CONTENT_NOTE}` : tool.summary;
      return jsonResult(text, data);
    } catch (error) {
      return errorResult(formatUnknownError(error, redactor));
    }
  }
}

/** One gateway instance, as returned by createBillyGateway. */
export type BillyGateway = ReturnType<typeof createBillyGateway>;

/** The data as it came; callTool redacts it and only then copies it as JSON. */
function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: (structuredContent ?? null) as GatewayJsonValue,
  };
}

/**
 * The redacted data, also as compact JSON in the text block after the summary, as the MCP spec asks of a tool
 * that returns structured content: many clients read only the text. Built from the final, redacted copy, so the
 * text holds exactly `structuredContent` and nothing more. Error results have no data and are left as they are.
 */
function withDataInText(result: GatewayToolResult): GatewayToolResult {
  if (result.isError || result.structuredContent === undefined) return result;
  const [first, ...rest] = result.content;
  const summary = first?.text ?? '';
  return {
    ...result,
    content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(result.structuredContent)}` }, ...rest],
  };
}

function errorResult(text: string): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}
