# Changelog

## 0.4.0

- License changed from Apache-2.0 to the Functional Source License, Version 1.1,
  ALv2 Future License (FSL-1.1-ALv2). You may read, run, modify and use the code
  internally and contribute changes; offering it as a competing commercial
  product or service is not allowed. Each version becomes Apache-2.0 two years
  after its release. Versions released before 0.4.0 remain under Apache-2.0
  (see `NOTICE`).

## 0.3.0

- Gateway error results carry failure metadata: when the upstream API
  answered with an HTTP error (or a redirect, which is refused), the result has `failure: { httpStatus,
  requestId? }`, so a host can count failures by status without reading
  their text. `requestId` is the vendor's own id from a response header
  (`REQUEST_ID_HEADERS`, the vendor's documented header first), kept only
  when it is a hex id of 8 to 64 characters (one run of hex digits,
  or groups of four or more joined by single hyphens, as in a UUID) and does not hold the
  shape of a personal number. It is checked again after redaction, so an id
  that shared a piece with the key is dropped. Never the body, the vendor's
  error code or message. The shared helpers are in `src/errors.ts`
  (`vendorRequestId`, `requestIdFrom`, `failureMetadata`).

## 0.2.1

- `register_payment` is no longer marked `requiresConfirmation`. It records a
  payment in the books and moves no money, so a host carries it out as its
  role allows, like any other write. The mark is meant for a call that moves
  money, and no tool here does; `requiresConfirmation` is now false for every
  tool. Nothing else changes: the same checks before the payment is
  registered, and the same `change` with `movesMoney: false`.

## 0.2.0

Bookkeeper's everyday work (#9), after Billy's API documentation
(https://www.billy.dk/api: "Creating and using attachments", "Sending emails
for invoices", "Deleting a record", and the bills, billLines, files,
attachments and contactPersons resources). Not tried against a live company.

- `create_draft_bill`: a bill (purchase voucher) as a draft, with lines of
  account, VAT rate, text and amount.
- `attach_bill_file`: the supplier's invoice or a receipt (PDF, PNG, JPEG, at
  most 10 MB, base64) to a bill that is not voided: `POST /files` with the raw
  bytes, then `POST /attachments` with `ownerReference: bill:<id>`. The type
  is read from the file's first bytes; the name is plain ASCII and its ending
  must match. Only `/files` takes a file's bytes, and only a file is sent
  there. The download address and the file name are never returned.
- `approve_bill`: approve (book) a draft bill; anything else is refused.
- `create_draft_bill` sends no `paymentDate` or `paymentAccount` (a bill paid
  at once); the documentation marks `paymentDate` required, as it marks fields
  Billy fills itself. Not tried against a live company.
- `send_invoice`: e-mail an approved invoice to a contact person of its
  customer who has an e-mail address. Not an e-invoice.
- `delete_draft_invoice` and `delete_draft_bill`: only a draft that was never
  approved or sent (an invoice's sent state exactly `unsent`), read first; Billy's answer must name the record under
  `meta.deletedRecords`. The client's only DELETEs are these two paths. In the
  gateway they are ordinary writes (`riskLevel: write`, a new optional
  `riskLevel` on a tool definition); their MCP annotations say
  `destructiveHint`.
- `change` actions `send`, `attach`, `delete` and the record `bill`; the
  e-mail's subject and the file name are hashed in the server's own audit, the
  contact person's id is a pseudonym, and the file and the e-mail's text are
  never logged.

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
- After the fifth review: the pseudonym key is at least 32 characters or
  bytes, admitted like the access token, and known to the error guard before
  anything is validated; integer fields must be whole numbers; records read
  to the end (products with their prices) are checked before they are
  filtered or cut at the limit; registering the pseudonym key cannot throw
  (text that is not valid UTF-16 included); record ids are logged in
  the audit only as pseudonyms.
- Not yet run against a live Billy company: the tests use answers shaped as
  the documentation shows them.
