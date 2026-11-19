# Changelog

## 0.1.0

First version, built from `mcp-server-template` after Billy's public API
documentation (https://www.billy.dk/api, API v2).

- Access with one company's access token (`X-Access-Token`), only to
  `api.billysbilling.com` and `api.billy.dk`. One gateway instance per
  company; the token is never read from the environment by a gateway.
- Read tools: connection check, company details (without subscription, card
  and bank fields), contacts, products, invoices, bills, chart of accounts
  (bank numbers as the last four characters), postings, daybooks and their
  transactions, VAT rates.
- Write tools, off by default: create and update contacts and products,
  create a draft invoice, approve a draft invoice, register a payment of an
  invoice or a bill in the books (no money moves; refused above the balance,
  for a paid or unapproved invoice or bill, a non-payment account or another
  currency), and put a draft transaction in a daybook.
- No DELETE, no sending of invoices (e-mail or e-invoice), no changes to the
  chart of accounts, VAT rates, the company or bank details: the client
  sends only a fixed list of writes.
- Gateway catalog with `requiresConfirmation` (register_payment) and
  `change` per write tool, and `resolveBillyChange` for a host that logs a
  change before it is sent.
- After review: the standalone MCP server redacts results like the
  gateway; payment registrations are serialised per company and document,
  refuse credit notes, non-positive balances and unknown currencies; rejected
  calls are audited with fixed codes and known field names only; the change
  resolution runs the tool's own checks (`gateway.resolveChange` also drops
  values holding the token); exact host match; answers without the
  documented root key or changed record are errors; a draft invoice takes
  currency and payment terms explicitly.
- After the second review: payment registrations are serialised per company
  (its Billy id from `GET /organization`) and document, whatever token or
  host the call uses, and the document must carry that company id; a bill
  must have type `bill` and credit no other bill; records must have an id and
  a list with an invalid entry is refused whole; `create_contact` requires
  `paymentTermsDays`.
- After the third review: a record must have the id asked for; an object
  where a value should be, or an embedded entry that is not a record,
  refuses the answer; the audit keeps the caller only as a pseudonym
  (`policy.pseudonymKey`).
- After the fourth review: the request id is kept only as a pseudonym too,
  and the pseudonym key is redacted like the access token. An embedded list
  (lines, contact persons, prices) that is there but is not a list refuses
  the answer instead of being left out, and every field passed on must have
  the type of Billy's property tables (amounts and counts numbers, flags
  booleans, the rest strings; null allowed).
- Not yet run against a live Billy company: the tests use answers shaped as
  the documentation shows them.
