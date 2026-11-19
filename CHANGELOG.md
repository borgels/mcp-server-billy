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
- Not yet run against a live Billy company: the tests use answers shaped as
  the documentation shows them.
