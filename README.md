# mcp-server-billy

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Billy](https://www.billy.dk), the Danish online accounting system (now part of Shine). It lets an MCP client (Claude or any other MCP-capable assistant) read a company's contacts, products, invoices, bills, chart of accounts, postings and daybooks, and, when enabled, create drafts, approve a draft invoice and register payments in the books.

> This is an independent, unofficial project. It is not developed, endorsed or supported by Billy or Shine.

- Read-only by default; writes are opt-in per instance.
- One Billy company per server instance: a Billy access token is tied to one company.
- No tool deletes anything, sends an invoice (e-mail or e-invoice), moves money, or changes the chart of accounts, VAT rates, the company's details or bank details. The client sends only a fixed list of writes and has no DELETE.
- Two transports: stdio for local clients, stateless streamable HTTP for containers and gateways.
- Embeddable: the `./gateway` export exposes the same tools, validation, policy and audit to a host application.

Built against Billy's public API documentation (<https://www.billy.dk/api>, API v2). The tests use answers shaped as that documentation shows them; they have not been run against a live Billy company.

## Tools

Reads (on by default):

| Tool | Purpose |
|---|---|
| `billy_check_connection` | Check the token; returns the company id and name. |
| `billy_get_organization` | The company's details: name, address, CVR number, base currency, fiscal year, VAT period. Subscription, card and bank fields are left out. |
| `billy_list_contacts` | Customers and suppliers, filtered by kind and text. |
| `billy_get_contact` | One contact with its contact persons. The customer portal access code is left out. |
| `billy_list_products` / `billy_get_product` | Products with prices per currency. |
| `billy_list_invoices` / `billy_get_invoice` | Invoices and credit notes, with Billy's documented filters; one with its lines. |
| `billy_list_bills` / `billy_get_bill` | Bills from suppliers; one with its lines. |
| `billy_list_accounts` | The chart of accounts. Bank account numbers and IBANs only as their last four characters. |
| `billy_list_postings` | Postings, by account, transaction, dates and text. |
| `billy_list_daybooks` / `billy_list_daybook_transactions` | Daybooks (kassekladder) and their transactions with lines. |
| `billy_list_tax_rates` | VAT rates. |

Writes (off unless `BILLY_ENABLE_WRITES=true`, or `enableWrites` in a host's policy):

| Tool | What it does |
|---|---|
| `billy_create_contact` / `billy_update_contact` | Create a customer or supplier (with contact persons), or change the fields given. Payment terms (`paymentTermsDays`) are required on create, as Billy documents the field as required without a default. Contacts in Billy have no bank details. |
| `billy_create_product` / `billy_update_product` | Create a product, or change the fields given; prices, when given, replace the product's prices. |
| `billy_create_draft_invoice` | Create an invoice as a draft, with currency and payment terms given explicitly. Billy gives it a number from the company's number model when it is created. It is not approved, e-mailed or sent. |
| `billy_approve_invoice` | Approve (book) a draft invoice. Refuses anything but a draft. It cannot return to draft, only be credited. Not e-mailed or sent. |
| `billy_register_payment` | Register that an approved invoice or bill was paid, on a payment account. Moves no money. Refuses an amount above the positive outstanding balance, a paid or unapproved invoice or bill, a document that does not carry the company's id (`organizationId`), anything but an ordinary invoice (`type: invoice`) or bill (`type: bill`, not crediting another bill) so a credit note or a missing or unknown type is refused, an unknown currency, an account that is not a payment account, or another currency. Billy's documentation lists the bill `type` as an enum without its values; `bill` is assumed by analogy with invoices and has not been checked against a live company, so a bill payment may be refused until it is. Registrations of one document run one at a time in this process, keyed on the company's Billy id (from `GET /organization`) and the document id, so two tokens or API hosts of the same company share the lock; a payment registered in Billy by someone else at the same moment is not seen, and Billy may then put an overpayment on the contact's balance. Marked `requiresConfirmation` for hosts. |
| `billy_create_daybook_transaction` | Put a transaction with lines in a daybook as a draft. A person approves it in Billy. |

An answer without the root key the documentation describes (`{ invoice: ... }`, `{ invoices: [...] }`), a record without an id or with another id than the one asked for, an object or a list where Billy's documentation has a single value, a list (also an embedded one: lines, contact persons, prices) with any entry that is not a record, or a write answer without the changed record, is an error, not an empty or partial result.

Lists without documented filters in Billy (contacts, products, accounts, daybooks, VAT rates) are read to the end, at most 5,000 records, and filtered by the server; `complete` is false when there were more. Billy ignores unknown query parameters rather than refusing them, so the server sends only the filters Billy documents.

## Getting an access token

In Billy, go to **Settings -> Access tokens**, click **Create access token**, give it a name and save. Billy's documentation: "The tokens you create under Settings -> Access tokens are tied to that company only. If you have multiple companies, you'll need a separate token for each one. Tokens are permanent." Delete the token in the same place to revoke access.

## Quick start

Requires Node.js 22 or later and a Billy access token.

```bash
npx mcp-server-billy
```

Or build from source:

```bash
git clone https://github.com/borgels/mcp-server-billy.git
cd mcp-server-billy
npm ci
npm run build
```

Claude Code:

```bash
claude mcp add billy --env BILLY_ACCESS_TOKEN=<token> -- npx -y mcp-server-billy
```

Claude Desktop (`claude_desktop_config.json`), or any client that launches stdio servers:

```json
{
  "mcpServers": {
    "billy": {
      "command": "npx",
      "args": ["-y", "mcp-server-billy"],
      "env": {
        "BILLY_ACCESS_TOKEN": "<token>"
      }
    }
  }
}
```

### Docker and HTTP

Images are published to `ghcr.io/borgels/mcp-server-billy`: `latest` and the commit SHA from `main`, and `vX.Y.Z` for release tags. The container serves streamable HTTP at `/mcp` on port 3000, plus an unauthenticated `GET /healthz`.

```bash
TOKEN=$(openssl rand -hex 32); echo "$TOKEN"
docker run -d --name billy-mcp -p 127.0.0.1:3000:3000 \
  -e BILLY_ACCESS_TOKEN=<token> \
  -e MCP_HTTP_TOKEN="$TOKEN" \
  ghcr.io/borgels/mcp-server-billy:latest

claude mcp add --transport http billy http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer $TOKEN"
```

To keep an audit log in the container, mount a writable directory and point `BILLY_AUDIT_LOG` into it (e.g. `-v billy-audit:/audit -e BILLY_AUDIT_LOG=/audit/audit.jsonl`); the image runs as the `node` user and `/app` is not writable.

Clients send `Authorization: Bearer <MCP_HTTP_TOKEN>`. The server will not start on a non-loopback address without a token of at least 32 characters. It does not terminate TLS; run it behind a reverse proxy or gateway that does.

## Configuration

Configuration is read from the environment (see `.env.example`). Invalid numbers, booleans, URLs and unknown tool names stop the server at startup. Booleans accept `true`/`false`, `1`/`0`, `yes`/`no` and `on`/`off`.

### Billy API

| Variable | Default | Description |
|---|---|---|
| `BILLY_ACCESS_TOKEN` | – | **Required.** Access token of one Billy company, sent as `X-Access-Token`. |
| `BILLY_BASE_URL` | `https://api.billysbilling.com/v2` | Base URL of the API. Only exactly `api.billysbilling.com` and `api.billy.dk` (the hosts in Billy's documentation, no subdomains) are accepted, over `https` (loopback `http` is allowed for local mocks). |
| `BILLY_ALLOW_CUSTOM_BASE_URL` | `false` | Allow another host. |
| `BILLY_TIMEOUT_MS` | `30000` | Timeout per request attempt. |
| `BILLY_MAX_CONCURRENCY` | `4` | Maximum concurrent upstream requests. |
| `BILLY_MAX_RESPONSE_BYTES` | `10485760` | Largest response body read (at most 100 MB). |

### Access control

| Variable | Default | Description |
|---|---|---|
| `BILLY_ENABLE_WRITES` | `false` | Enable the write tools. |
| `BILLY_DISABLED_TOOLS` | – | Comma-separated tool names to disable, with or without the `billy_` prefix. |
| `BILLY_AUDIT_LOG` | – | Path of a JSONL audit log: one record per tool call start, finish and error, with record ids as pseudonyms, states, dates and amounts in clear text, free text (names, numbers, descriptions, searches) hashed, lists counted, duration, status and the caller passed by an embedding host. Write tools refuse to run if the log cannot be written. |

### HTTP transport

| Variable | Default | Description |
|---|---|---|
| `MCP_HTTP_TOKEN` | – | Bearer token, at least 32 printable ASCII characters (also on loopback). Required unless bound to loopback. |
| `MCP_HTTP_HOST` or `HOST` | `127.0.0.1` (`0.0.0.0` in the image) | Bind address; `MCP_HTTP_HOST` takes precedence. |
| `PORT` | `3000` | Listen port. |
| `MCP_ALLOWED_ORIGINS` | localhost origins | Comma-separated browser origins allowed to call the server. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow any origin; requires a token. |
| `MCP_ALLOWED_HOSTS` | loopback names on a loopback bind | Comma-separated accepted `Host` header names. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Maximum request body. |
| `MCP_AUTH_FAILURE_LIMIT`, `MCP_AUTH_FAILURE_WINDOW_MS` | `20`, `60000` | Failed-authentication limit per client address; `0` disables it. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Permit a non-loopback bind without a token. Only for isolated networks. |

## Embedding (`./gateway`)

A host application can run the tools in-process instead of over MCP, one instance per Billy company:

```ts
import { createBillyGateway, billyToolCatalog, resolveBillyChange } from 'mcp-server-billy/gateway';

const gateway = createBillyGateway({
  accessToken: company.billyToken,
  policy: { enableWrites: true, disabledTools: [], audit: record => log(record) },
});
const result = await gateway.callTool('list_invoices', { isPaid: false }, { caller: 'person-1' });
```

- **Explicit credentials.** `accessToken` is required; a missing value throws when the gateway is created. `baseUrl` is optional (Billy's documented endpoint by default). A gateway never reads `BILLY_ACCESS_TOKEN` or `BILLY_BASE_URL` from the environment. The stdio and HTTP transports still read them from the environment.
- **Several companies in one process.** Create one gateway per token. Each instance redacts error text, tool results and audit records with its own token only; no secret is kept in a process-wide registry, and a dropped instance releases its token.
- **Instance policy from the host.** Pass `policy` to `createBillyGateway`: `enableWrites` (default false), `disabledTools` (must name known tools) and `audit`, a function that receives each audit record instead of `BILLY_AUDIT_LOG` (without it the instance writes no audit; a write tool does not run if the sink throws on its start record). An instance with `policy` reads none of `BILLY_ENABLE_WRITES`, `BILLY_DISABLED_TOOLS`, `BILLY_AUDIT_LOG` or `BILLY_ALLOW_CUSTOM_BASE_URL`. Each call runs in a scope of its own. The limits (`BILLY_TIMEOUT_MS`, ...) are still read from the environment and apply to every gateway in the process. Per-user authorization is the host's job.
- **Result format.** A successful `callTool` result has `structuredContent` and one text block: a short summary, a blank line, and the same data as compact JSON. An error result has only its text.
- **Tool catalog.** `billyToolCatalog` is a frozen list of every tool: `name` (without the `billy_` prefix), `title`, `description`, `riskLevel` (`read` or `write`; no tool is `destructive`), `enabledByDefault`, `inputSchema` (JSON Schema), `broad` (false for every tool), `upstream` (the API requests the tool may make), `requiresConfirmation` (true for `register_payment` only: a host should have a person confirm it outside the chat) and, for write tools, `change`: the action (`create`, `update`, `approve`, `register_payment`), the record kind and `logFields`.
- **Change resolution.** `resolveBillyChange(tool, input, { pseudonymKey })` (or `gateway.resolveChange`, which also leaves out any value holding a piece of that instance's token) validates the input exactly as the call would, the tool's own checks included, and returns what a write call will change before it is sent, for a host that logs the change first: Billy record ids, amounts, currency codes, dates, flags and the number of lines in clear; a number the company chose (contact, product or voucher number) only as a pseudonym (HMAC-SHA-256 with the host's key, else SHA-256); never a name, an address or a text.

## Threat model

What this server guarantees about the access token, and what it does not. It is
the yardstick for every change that touches errors, results or audit.

**Scope.** Guarantees (a), (b) and (c) apply to the embeddable gateway
(`./gateway`), the surface a multi-tenant host uses. The standalone MCP
server, configured from the environment for one key, applies the same
redaction and the same last leak check to its results and errors.

**Guaranteed:**

- **(a) The key never reaches anything persisted or shared:** audit sinks and
  the audit log file, logs, error texts, export hooks or files. Errors are
  our own texts; audit records and everything a gateway instance returns are
  redacted with the instance's own key before they leave it.
- **(b) No vendor-controlled free text in errors.** An error carries our own
  fixed text, the HTTP status, numbers we parse (Retry-After), and codes from
  a fixed list we wrote down; never a response body, a vendor message or
  code, a redirect's `Location`, a type or field name from the vendor, or
  the message of an error thrown while reading a response. A failure kept
  inside an otherwise returned result is the status or a fixed text as well.
  Errors never quote the key, the configured address or a refused configuration value (a timeout names its limit in milliseconds).
- **(c) Results go only to the tenant whose key it is.** One gateway
  instance per tenant; every call runs in a scope of its own; nothing about a
  tenant is kept in process-wide state. The MCP server serves one key.

**Not guaranteed (residual risk):** a vendor that deliberately echoes the
customer's own key back in data. Results are redacted on a best-effort
basis: the exact key, its URL- and JSON-encoded forms and any piece of it of
6 characters or more, in strings, object keys and the string form of
numbers and booleans, are replaced by `"‹redacted›"` before anything is
serialised. A key that comes back otherwise transformed (split into pieces
shorter than 6 characters, reversed, re-encoded, hashed) is not recognised.
Such data reaches only the tenant whose key it is, which already holds the
key. **What leaves a gateway holds no piece of the key.** This is checked at
the sink, not inferred from our texts: every output is checked in its final
form, and one that holds a piece of 6 characters of the key (or of one of
its encoded forms) is replaced by a fixed fallback. The outputs are the tool
list, every tool result as a whole (outer fields such as `isError`
included), audit records and stderr lines, and construction errors. A result becomes a fixed
"withheld" error, an audit record or line becomes a fixed one, and a
construction error becomes the fixed refusal. Every error a gateway throws is a fresh error in final form: no `cause`, a `stack` of only `name: message` (no frames, paths or function names), and name, message and stack masked against the secret. The fallbacks are a small,
closed set (`src/fallbacks.ts`), and a key that shares a piece with any of
them, or with the tool list, is refused when the gateway is created.

**Key admission.** Every key is a secret the vendor issues. A gateway
accepts only printable ASCII (0x21-0x7E) of at least 16 characters, checked
before anything is built from the key. As a cheap first filter it also
refuses a key that shares a piece of 6 characters with a string literal in
`src/` (`src/fixed-corpus.generated.ts`, kept up to date by a test). The
refusal is a fixed text that never repeats the key. The standalone MCP server redacts its results, errors and audit records
with its token and withholds a result that still holds a piece of it, as
the gateway does.

**Call context in the audit.** The `caller` a host passes is never logged in clear: it becomes a pseudonym (HMAC-SHA-256 with `policy.pseudonymKey`, else SHA-256). The key is at least 32 random printable characters or 32 random bytes and is admitted like the access token: a key that shares a piece of six characters with any text of this server is refused, so no error, fallback or tool description can carry part of it. Record ids are logged as pseudonyms the same way, since the input cannot tell an id from a name. Nor is a `requestId`: any text can hold a name, a phone number or an address, so the audit keeps its pseudonym the same way, which still ties the lines of one call together for a host that knows the key; without one the audit makes its own id. The pseudonym key is a secret of the instance like the access token: it is redacted from results, audit records and errors.

**Rejected calls.** A call refused before it runs (an unknown tool or
invalid input) is audited with a fixed code (`unknown_tool`,
`invalid_input`), the argument names the tool's schema knows and the number
of other arguments. An unknown tool name is recorded only as a pseudonym.

## Security model

- **One shared identity.** Every caller acts with the rights of the configured access token. Give it the least rights that work and rotate it regularly.
- **Per-user authorization belongs in front of the server.** The server checks a single bearer token and does not know the end user. For multi-user use, run it behind an identity-aware gateway that decides which users may call which tools, holds the bearer token, and is the only network path to the server. Hosts can also embed the tools through the `./gateway` module export and pass the caller identity into the audit log.
- **Tool access is not data access.** A gateway controls who may call which tool; every permitted caller still sees everything the access token can see. To separate data, run several instances with different keys.
- **Writes are off by default.** Write tools are not annotated destructive (none deletes anything), but they change the company's books; a client should ask before running them, and `register_payment` is marked for a person's confirmation. Read-only tools get a client that refuses non-GET requests. When `BILLY_AUDIT_LOG` is set, a write tool does not run unless its start record is written; without it there is no audit record.
- **Upstream content is untrusted input.** Data returned by the API may be written by anyone with access to it. Tool results label it as data; clients that combine this server with other tools should treat it accordingly.
- **The access token stays on the API origin.** Redirects are never followed, the base URL must use `https`, and error messages and audit records are redacted (by each instance, with that instance's key) and size-capped. See the threat model above for what is and is not guaranteed.
- **The HTTP transport fails closed.** It refuses to start on a non-loopback address or with any origin allowed unless a token is set, compares tokens in constant time, throttles failed authentication per client address, checks `Origin` and `Host` (DNS rebinding), and caps request bodies.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Development

```bash
npm run dev          # stdio transport
npm run dev:http     # HTTP transport on 127.0.0.1:3000
npm run typecheck
npm test
npm run build
```

Project layout:

| Path | Contents |
|---|---|
| `src/tools/billy.ts` | Shared tool table (MCP and gateway), policy and audit wrapper. |
| `src/billy/` | Upstream client, API calls, policy, audit, tool annotations. |
| `src/transports/` | stdio and HTTP entry points; HTTP auth, origin and host checks. |
| `src/gateway.ts` | Embeddable entry point (`./gateway` export). |
| `src/config-env.ts` | Validated environment readers. |

## Releasing

1. Bump the version in `package.json`, `server.json` (`version` and the npm package `version`) and `src/version.ts`; tests and CI check that they agree. Update `CHANGELOG.md`. Merge.
2. Tag the merged commit and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `release.yml` tests, packs and publishes the tarball to npm through trusted publishing (no stored token; npm adds provenance when the repository is public), then publishes `server.json` to the MCP Registry. Versions already on npm or in the registry are skipped, so a failed run can be re-run. Pre-release tags (`vX.Y.Z-rc.1`) go to the npm dist-tag `next` and not to the registry. `publish.yml` pushes the `vX.Y.Z` image.

The first version of a new package is published by hand; see the header of `.github/workflows/release.yml`.

## License

Apache-2.0
