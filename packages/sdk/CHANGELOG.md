# Changelog

## 4.0.0 — FairCoin is always offered, into the owner's Peable wallet

Requires `@peable.to/contracts` 4.0.0 and `@peable.to/shared-types` 4.0.0.
ADR 0021: FairCoin is offered on every order surface beside the merchant's fiat
methods, nothing turns it off, and it is received into the Peable wallet of the
Oxy account that owns the merchant (or the seller's own) — no key is ever
registered.

Breaking:

- **A Checkout Session's `payment_method_types` must include `faircoin`.**
  `['card']` on a fiat order is 400 `payment_method_locked`; omit the field (or
  send `['card', 'faircoin']`). A fiat session's `payment_method_types` is now
  `['card', 'faircoin']`, and its `network` is the merchant's FairCoin network.
- **No FairCoin key anywhere (ADR 0021 D5).** `Merchant.xpub` is removed and
  `Merchant.owner_account` (the owning Oxy account) added; `Merchant.network` is
  never `null` (the environment's). Registration takes no `network`/`xpub`. The
  seller onboarding confirm (`POST /v1/connect/onboarding/{token}/faircoin`)
  takes an empty body. Errors `watch_only_violation` and `key_in_use` are gone.
- **`PAYMENT_METHOD_CONFIGURATION_TYPES` gains `faircoin`**, an always-on,
  `locked: true` entry (`PaymentMethodConfigurationEntry.locked` is new);
  `faircoin.display_preference.preference: 'off'` is 400 `payment_method_locked`.
- **`PaymentIntent.faircoin.quote`** (`FaircoinQuote | null`) and
  **`BalanceTransaction.faircoin_quote`** are new required properties of those
  wire types: a fixture that builds one needs them (`null`).

Added:

- `createPeableCheckout().confirmCheckoutSession(id, secret, { payment_method_type })`
  — the payer's choice. FairCoin on a fiat order quotes the total in FAIR for
  10 minutes (`payment_intent.faircoin.quote`: currency, fiat amount, rate, the
  Explorer and ECB sources, `expires_at`); confirming again with the other
  method replaces a payment that has not moved money.
- `CheckoutSessionPublic.payment_method_types` and `.faircoin`
  (`{ available, unavailable_reason }`, reasons `faircoin_wallet_missing`,
  `faircoin_network_closed`, `price_unavailable`, `temporarily_unavailable`);
  `PublicInvoice.faircoin`; hosted invoice `/pay` takes `payment_method_type`.
- Errors `payment_method_locked`, `faircoin_price_unavailable`,
  `faircoin_wallet_missing`, `faircoin_network_closed`; vocabulary
  `FAIRCOIN_UNAVAILABLE_REASONS`.

## 3.1.0 — the settlement of a refund and of a dispute

Requires `@peable.to/contracts` 3.1.0 and `@peable.to/shared-types` 3.1.0.
Additive: what a refund took off the settlement balance, and what a dispute
withdrew from it, read live from the provider like a payment's — so a
marketplace books them in the currency the money actually moved in.

Added:

- **`refunds.refundSettlement(id)`** — `GET /v1/refunds/{id}/settlement`: the
  refund's own movement of the settlement balance. A refund the provider never
  acknowledged, or one that failed or was canceled, is `status: 'unknown'` with
  every figure `null`.
- **`disputes.settlement(disputeId)`** — `GET /v1/disputes/{disputeId}/settlement`:
  the dispute's WITHDRAWAL, `gross` the principal and `fee` the dispute fee. An
  inquiry moves no money and is `unknown`, never zeros; the reinstatement of a
  won dispute is not this figure.
- **`Settlement.refund` and `Settlement.dispute`** — expandable (`re_…` /
  `dp_…`, or the object with `expand[]`), `null` on a payment's settlement
  (`refunds.settlement`), which is otherwise unchanged.

The signs, one rule for all three reads: `gross` is the MAGNITUDE of the
movement, `fee` the provider's fee on it as the provider signs it (positive
when charged, negative when returned — a refund's is usually `"0"`), `net` the
SIGNED effect on the balance: `net = gross − fee` for a payment,
`net = −gross − fee` for a refund or a dispute (refund `"1000"`, fee `"0"` →
net `"-1000"`; dispute `"5000"`, fee `"1500"` → net `"-6500"`). Every figure is
in the SETTLEMENT `currency`; `exchange_rate` is present only when a conversion
happened. `Settlement.fee` is now a signed amount on the wire (a payment's is
never negative).

Also first published in this release:

- **`url_refused`** in the webhook endpoint `disabled_reason` vocabulary
  (Peable#227): an endpoint whose stored `url` breaks the registration rules,
  judged before every delivery, is disabled with it; re-enable it with a `url`
  that passes.

## 3.0.0 — the Stripe-Billing proxy is retired (ADR 0018)

Requires `@peable.to/contracts` 3.0.0 and `@peable.to/shared-types` 3.0.0. A
major: the provider-id recurring billing surface is removed at the root. Use the
billing engine — catalog products and prices, `checkout.sessions.create` with
`mode: 'subscription'`, `subscriptions`, `invoices`, `billingPortal.sessions`
and `entitlements.activeEntitlements` for access.

Removed:

- **Methods.** Every `billing.*` method except `billing.meters.*` and
  `billing.meterEvents.*`: `listRails`, `createTaxQuote`, `ensureCustomer`,
  `createCheckoutSession`, `embeddedCheckoutConfiguration`,
  `createEmbeddedCheckoutSession`, `retrieveEmbeddedCheckoutAction`,
  `createPortalSession`, `retrieveCheckoutOperation`, `retrieveCheckout`,
  `retrieveFinalInvoiceAuthority`, `retrieveInvoiceState`,
  `retrievePaidInvoice`, `retrieveSubscription`, `renewSubscription`,
  `cancelAtPeriodEnd`.
- **Signed billing documents.** The `invoiceAuthorityKeys` /
  `taxQuoteAuthorityKeys` config, `BillingAuthorityKeys` and
  `PEABLE_BILLING_AUTHORITY_KEYS`.
- **Types.** `Billing*` wire types of the proxy (`BillingSubscription`,
  `BillingTaxQuote`, `BillingFinalInvoiceAuthority`, `BillingPaidInvoice`,
  `BillingInvoiceState`, `BillingRail*`, `BillingCheckout*`,
  `BillingEmbeddedCheckout*`, `BillingFaircoin*`, `BillingObservation`, …),
  `BILLING_SUBSCRIPTION_STATUSES`, `BILLING_RAIL_*`.
- **Event.** `billing.observation.updated`; `webhooks.constructEvent` refuses it.
- **Checkout.** `CheckoutSessionPublic.billing_quote`; the
  `checkoutSession` prop of the provider card fields and `CheckoutSessionAction`
  (`@peable.to/sdk/checkout/ui`).
- **Error codes.** `subscription_migrated`, `billing_not_enabled`,
  `billing_provider_unavailable`, `invalid_billing_request`,
  `idempotency_conflict`, `identity_conflict`, `invalid_provider_response`,
  `provider_unavailable`, `reconciliation_required`, `result_expired` and the
  `local_test_*` codes.

## 2.0.0 — every amount is a base-unit string (ADR 0014 D1)

Requires `@peable.to/contracts` 2.0.0 and `@peable.to/shared-types` 2.0.0. A
major: the last JSON-number amounts on the wire are base-unit integer strings
now, changed at the root — no number is accepted or answered beside them.

Breaking:

- **Peable Tax.** `TaxCalculation` (`amount_total`, `amount_net`,
  `tax_amount_exclusive`, `tax_amount_inclusive`), each line item (`amount`,
  `amount_tax`, `amount_net`) and breakdown entry (`taxable_amount`, `amount`),
  `TaxTransactionReversal` (`amount_total`, `amount_net`, `tax_amount`) and
  `TaxReportRow` (`taxable_amount`, `tax_amount`) are strings; a reversal's are
  signed (`"-600"`). Requests too: `tax.calculations.create`'s
  `line_items[].amount` and `tax.transactions.createReversal`'s `amount` take a
  string (`"2999"`); a number is a 400 `invalid_tax_request`.
- **Signed billing documents are `schema_version: 3`.** `BillingTaxQuote`
  (`quote.gross_minor_units`, `net_minor_units`, `tax_minor_units`) and
  `BillingFinalInvoiceAuthority` (`invoice.gross_minor_units`,
  `net_minor_units`, `tax_minor_units`, `merchant_fee_minor_units`, each
  `tax_lines[]` `taxable_minor_units` / `tax_minor_units`) carry strings, and
  the signature covers that encoding. `billing.createTaxQuote` and
  `billing.retrieveFinalInvoiceAuthority` accept version 3 only, and refuse a
  document whose net and tax do not add up to its gross exactly (`bigint`).
- **Billing.** `BillingRailOffer.gross_minor_units`,
  `BillingFaircoinFxQuote.gross_minor_units` and
  `BillingEmbeddedCheckoutAction.amount_minor_units` are strings;
  `BillingPaidInvoice` / `BillingInvoiceState` amounts (already strings) are
  validated as canonical base-unit strings.
- The UI's prepared Checkout Session compares the provider's JS-number total
  with the action's string exactly (`String(total) === amount_minor_units`).

## 1.0.2

Requires `@peable.to/contracts` 1.2.0 and `@peable.to/shared-types` 1.0.1.

- The browser entries no longer bundle the whole contracts vocabulary. The
  error classes imported the `@peable.to/contracts/vocabulary` barrel and the
  checkout sheet's method list the `@peable.to/shared-types` barrel, and Metro
  (Expo web, React Native) does not tree-shake, so every module behind both
  shipped. They now import the one vocabulary module each reads
  (`@peable.to/contracts/vocabulary/errors`,
  `…/vocabulary/paymentMethodConfigurations`): what the Peable packages add to
  `@peable.to/sdk/checkout` falls from 31,693 to 11,626 minified bytes (20
  modules to 1), and to `@peable.to/sdk/checkout/ui` from 46,961 to 1,072 (52
  modules to 2). `__tests__/browser-bundle.test.ts` fails a build that reaches
  any other module.
- `PEABLE_SERVICE_AUDIENCE` is `@peable.to/contracts` 1.1.0's
  (`@peable.to/contracts/vocabulary`), the same constant the gateway accepts;
  its value is unchanged.

## 1.0.1

- `webhooks.constructEvent` decodes a byte payload strictly: invalid UTF-8 (or a
  leading BOM the signer did not sign) is a `PeableSignatureVerificationError`.
  A lenient decoder could map two different byte bodies to the same string and
  let both pass one signature.

## 1.0.0 — generated from the contracts; retries, timeouts, typed errors (ADR 0014)

Requires `@peable.to/contracts` 1.0.0 and `@peable.to/shared-types` 1.0.0. A
major: the wire is ADR 0014's one wire, and the client is changed at the root —
there are no deprecated aliases.

Added:

- **Generated resource methods.** `scripts/generate-resources.ts` reads every
  route contract of `@peable.to/contracts` that names an `sdk` method and writes
  `src/generated/resources.ts` (committed; CI fails when it drifts —
  `bun run check:sdk-resources`). Each method's parameter and return types ARE
  the contract's `BodyOf` / `QueryOf` / `ResponseOf`, imported as types: no
  schema is loaded at runtime. One shape everywhere:
  `method(...pathParams, params?, options?)`, `params` optional exactly when
  nothing in it is required. Lists and searches answer the auto-paging page
  promise, bytes answer `{ bytes, contentType, filename }`, live tails answer
  the reconnecting async iterable, uploads are sent as `multipart/form-data`.
  Every merchant route is generated: 255 methods in 44 namespaces. Payer
  (`public`) and Oxy-session (`user`) routes are never server-SDK methods,
  whatever `sdk` name their contract carries.
- **Retries.** `maxNetworkRetries` (default **2**, client and per request):
  network failures, timeouts, interrupted bodies, 5xx, 429 and 409
  `idempotency_error` are retried with exponential backoff and jitter
  (0.5 s → 8 s), never sooner than `Retry-After` (honoured up to 60 s). Every
  attempt of a `POST` carries the same `Idempotency-Key`.
- **Default timeout.** `timeout` (default **80 000 ms**, client and per
  request) bounds each attempt, headers and body together, and each token mint.
- **`apiVersion`** (default `PEABLE_API_VERSION`, exported), sent as
  `Peable-Version` on every request, client and per request.
- **`peableAccount`** on the client: the default `Peable-Account`, sent only on
  routes that accept it. A request's own `peableAccount` replaces it.
- **`signal`** on every request: aborts the attempt in flight and any backoff.
- **One error class per `error.type`**: `PeableInvalidRequestError`,
  `PeableAuthenticationError`, `PeablePermissionError`, `PeableCardError`,
  `PeableIdempotencyError`, `PeableRateLimitError`, `PeableAPIError`, plus
  `PeableConnectionError` (no answer) and `PeableSignatureVerificationError`.
  Every error carries `statusCode`, `type`, `code`, `declineCode`, `param`,
  `message`, `docUrl`, `requestId` and `raw`.
- `webhooks.constructEvent` accepts the raw body as bytes (`Buffer` /
  `Uint8Array`) as well as a string; `DEFAULT_WEBHOOK_TOLERANCE_SEC` (300).
- Exported: `RequestOptions`, `IdempotencyOptions`, `AccountOptions`,
  `ApiListPromise`, `DEFAULT_TIMEOUT_MS`, `DEFAULT_MAX_NETWORK_RETRIES`, the
  generated `GeneratedResources` and its namespace interfaces
  (`CustomersResource`, `PaymentMethodsResource`, …).

### MIGRATION from 0.x

Client configuration:

| 0.x | 1.0 |
|---|---|
| `requestTimeoutMs` (no default) | `timeout` (default 80 000 ms; also per request) |
| no retries | `maxNetworkRetries: 2` by default — pass `0` to keep 0.x behaviour |
| `Peable-Version` never sent | sent on every request: `apiVersion` |
| `peableAccount` per request only | also a client default (`peableAccount`), applied where the route accepts it |

Errors:

| 0.x | 1.0 |
|---|---|
| `PeableApiError` | `PeableAPIError` |
| a network failure or timeout was a `PeableApiError` | `PeableConnectionError` (`code: 'timeout'` / `'response_interrupted'`), retried first |
| an interrupted or timed-out `POST` was never retried | retried under the same `Idempotency-Key` |
| 409 / 400 `idempotency_error` was a `PeableInvalidRequestError` | `PeableIdempotencyError` (the 409 is retried first) |
| 429 was a `PeableInvalidRequestError` | `PeableRateLimitError`, retried first |
| `err.code` fell back to `err.type` when the gateway sent no code | `err.code` is the gateway's code or `undefined`; branch on `err.type` |
| `PeableCardError.declineCode` only | `declineCode`, `docUrl` and `raw` on every error |
| `PeableErrorType` had no `rate_limit_error` / `idempotency_error` | the gateway's seven types, `api_connection_error`, `signature_verification_error` |

Webhooks:

| 0.x | 1.0 |
|---|---|
| `constructEvent(raw, header, secret, { toleranceSec })` | `constructEvent(payload, header, secret \| secret[], tolerance?)` — `tolerance` in seconds |
| `ConstructEventOptions` | removed |

Customers and payment methods (generated):

| 0.x | 1.0 |
|---|---|
| `class CustomersResource`, `class PaymentMethodsResource` | generated interfaces of the same names; reach them through `peable.customers` / `peable.paymentMethods` |
| `customers.del(id)` | `customers.del(id, options?)` |
| `paymentMethods.detach(id, { idempotencyKey })` | `paymentMethods.detach(id, params?, options?)` — `params` is the body (`{ expand }`), the key moves to the third argument |
| `CustomerListParams` | `ListCustomersParams` |
| `PaymentMethodListParams` | `ListPaymentMethodsParams` |
| `CustomerList`, `PaymentMethodList` | `List<Customer>`, `List<PaymentMethod>` (from `@peable.to/shared-types`) |

Removed:

- The `@peable.to/sdk/contributions` entry, and `ContributionsResource`,
  `ContributionScope`, `CreateContribution`, `ContributionLink`,
  `ContributionDetails` from the root. Contribution links are managed by a
  PERSON (an Oxy user session), never a merchant service token, so they do not
  belong in the server SDK; their wire is `@peable.to/contracts`
  (`/contributions`, and the route registry once contracted) — validate against
  it over your own authenticated transport, as Orbit does.

Integrating the low-level client (`createRestClient`, `GatewayClient`):

- `download(path, { query })` → `download(method, path, options)`, with the
  same attempts, deadline and retries as `request`.
- `RestClientRequestOptions` gains `apiVersion`, `maxNetworkRetries`,
  `timeout`, `signal` and `acceptsPeableAccount`.

#### Every resource is generated

All 255 merchant (`service`) routes are generated, in 44 namespaces. Every
0.x resource class (`PaymentIntentsResource`, `BillingNamespace`,
`TaxResource`, …) is gone; the generated interface of the same namespace
replaces it (`import type { PaymentIntentsResource } from '@peable.to/sdk'` is
now an interface). The SDK's own aliases of wire types (`PaymentIntentList`,
`CustomerListParams`, `CreatePaymentIntentOptions`, `BillingRequestOptions`, …)
are removed — use the contract's types (`List<T>`, `List…Params`, `Create…Params`)
and `RequestOptions & IdempotencyOptions`.

The shape is the same everywhere: `(…pathParams, params?, options?)`. Where 0.x
put options where `params` now goes, or named a method differently:

| 0.x | 1.0 |
|---|---|
| `peable.accounts.*` (alias) | `peable.connectedAccounts.*` |
| `account.createLink(params, options)` | `accountLinks.create(params, options)` |
| `accountLinks.create({ account, … })` (a seller) | `connectedAccounts.createAccountLink(account, { … })`; `accountLinks.create` is the merchant's own account (or a seller's with `{ peableAccount }`) |
| `account.retrieve({ peableAccount })` | `account.retrieve(params?, { peableAccount })` |
| `balance.retrieve({ peableAccount })` | `balance.retrieve(params?, { peableAccount })` |
| `balanceTransactions.retrieve(id, options)` | `balanceTransactions.retrieve(id, params?, options?)` |
| `payouts.retrieve(id, options)` / `payouts.cancel(id, options)` | `payouts.retrieve(id, params?, options?)` / `payouts.cancel(id, params?, options?)` |
| `disputes.close(id, { idempotencyKey })` | `disputes.close(id, params?, { idempotencyKey })` |
| `paymentMethods.detach(id, options)` | `paymentMethods.detach(id, params?, options?)` |
| `paymentMethodDomains.validate(id, options)` | `paymentMethodDomains.validate(id, params?, options?)` |
| `testHelpers.checkoutSessions.expire(id, options)` | `testHelpers.checkoutSessions.expire(id, params?, options?)` |
| `tax.products.setTaxCode(productRef, taxCode)` | `tax.products.setTaxCode(productRef, { tax_code })` |
| `billing.cancelAtPeriodEnd(ref, { idempotencyKey })` | `billing.cancelAtPeriodEnd(ref, params?, options?)` |
| `billing.retrieveCheckoutOperation({ idempotency_key, …identity })` | `billing.retrieveCheckoutOperation(idempotency_key, { …identity })` |
| `billing.retrieveFinalInvoiceAuthority(sub, inv, { include: ['tax_lines'] })` | `billing.retrieveFinalInvoiceAuthority(sub, inv, { include: 'tax_lines' })` |
| `billing.*` writes: `{ idempotencyKey }` required | optional — the SDK sends one on every `POST`; pass your own to recover the operation later with `retrieveCheckoutOperation` |
| `events.stream({ types: [...], signal, onConnect, onDisconnect })` | `events.stream({ types: 'a.*,b' }, { signal, onConnect, onDisconnect })` — `types` is the wire's comma-separated string |
| `requestLogs.stream({ status, method, signal, … })` | `requestLogs.stream({ status, method }, { signal, … })` |
| `reporting.reportTypes.download(id, params)` → a streamed `Response` | → `{ bytes, contentType, filename }` (the whole CSV) |
| `files.create({ purpose, file: Uint8Array, filename })` | `files.create({ purpose, file: new File([bytes], filename) })`; `{ purpose, oxy_file }` is unchanged |
| `applicationFees.list({ charge })` | not a filter of the route; `payment_intent` is |

Lists that answered one plain page — `billing.listRails`, `tax.products.list`,
`reporting.reportTypes.list`, `billing.meters.listEventSummaries` — now answer
the auto-paging page promise like every list (still awaitable to the page).

New in 1.0: `invoices.retrievePdf`, `setupIntents.clientAction`,
`tax.compliance.retrieveDocument` / `retrieveOperatingLocation` /
`retrieveRegistrationDeclaration` / `retrieveSalesDestination`.

Still written by hand, because no route describes them: `webhooks.constructEvent`;
the verification of `billing.createTaxQuote` and
`billing.retrieveFinalInvoiceAuthority` against your pinned keys (same signature
as the generated methods); and the `files.create` type, widened to also take the
JSON `{ purpose, oxy_file }` form the route's contract documents as a second schema.

## 0.22.0 — Peable Tax business compliance (ADR 0020)

Requires `@peable.to/shared-types` 0.20.0. Additive.

Added:

- `tax.compliance`: read the owner's business profile, operating locations,
  sales destinations, declared registration statuses, documents and document
  checklist; the versioned rule set, capabilities and deadlines; run
  (`createAssessment`), read and `replayAssessment` assessments; read the
  review queue and the action history. Recording onboarding facts and deciding
  review items are the owner's, in Orbit — no SDK method does either, and
  nothing here registers, files, pays or turns tax collection on.
- File purpose `tax_document` (private, ≤ 10 MiB PDF/PNG/JPEG).
- Webhook events `tax.assessment.created`, `tax.review_item.created`,
  `tax.review_item.updated`.

## 0.21.0 — Report downloads, more report types, transfer reversals, events of a payment

Requires `@peable.to/shared-types` 0.19.0.

- New `peable.reporting.reportTypes.download(id, parameters)`:
  `GET /v1/reporting/report_types/:id/csv`, the same report a run stores, with
  the same `parameters`, streamed at once. Answers the `Response`, whose body is
  the file as the gateway writes it; a refusal is thrown as the typed error
  before any byte. `ReportTypesResource` and `ReportingResource` now take a
  `GatewayClient`.
- Three more report types: `balance_transactions.itemized.1`,
  `refunds.itemized.1`, `disputes.itemized.1`. The existing layouts gain
  appended, non-default columns (`*_decimal` amounts in whole units,
  `connected_account_id`, `balance_transaction_id`, `metadata`); their
  `default_columns` are unchanged. The layouts are also importable from
  `@peable.to/shared-types/reporting`, which loads in a browser.
- New `peable.transfers.listReversals(transferId)`: every reversal of one
  settlement (`GET /v1/transfers/:id/reversals`), a complete list.
- `peable.events.list({ payment_intent })`: only the events about that payment.
## 0.20.0 — native billing engine: subscriptions, invoices, credit notes, entitlements (ADR 0018)

Additive. Requires `@peable.to/shared-types` 0.18.0.

- New `peable.subscriptions` (`create` / `retrieve` / `update` / `cancel` /
  `resume` / `list`) and `peable.subscriptionItems`: `sub_…` / `si_…` with
  trials, billing cycle anchors, proration (`create_prorations | none |
  always_invoice`), `pause_collection`, `cancel_at_period_end` / `cancel_at`,
  discounts, `payment_behavior` and `automatic_tax`.
- New `peable.invoices` (`create` / `retrieve` / `update` / `del` / `list` /
  `finalizeInvoice` / `pay` / `sendInvoice` / `voidInvoice` /
  `markUncollectible` / `listLineItems` / `retrieveUpcoming`) and
  `peable.invoiceItems`.
- New `peable.creditNotes` (`create` / `preview` / `retrieve` / `list` /
  `voidCreditNote`) and `peable.customerBalanceTransactions`.
- New `peable.testHelpers.testClocks` (`create` / `retrieve` / `list` /
  `advance` / `del`) and `peable.billingSettings` (numbering and dunning).
- `peable.billing` gains `meters` and `meterEvents`; every existing
  `billing.*` method is unchanged.
- New `peable.entitlements` (`features`, `productFeatures`,
  `activeEntitlements`) and `peable.billingPortal` (`configurations`,
  `sessions`).
- `Customer` gains `balance`, `currency` and `test_clock`; `PriceRecurring`
  gains `meter`.
- 34 new event types accepted by `webhooks.constructEvent`:
  `customer.subscription.*`, `invoice.*`, `invoiceitem.*`, `credit_note.*`,
  `test_helpers.test_clock.*`, `billing.meter.*`,
  `entitlements.active_entitlement_summary.updated`, `billing_portal.*`.
- `subscriptions.search` and `invoices.search` (`GET /v1/subscriptions/search`,
  `GET /v1/invoices/search`): `SEARCHABLE_RESOURCES` gains both.

## 0.19.0 — Search and report runs (Orbit Phase 8)

Requires `@peable.to/shared-types` 0.17.0.

- New `search({ query, limit, page, expand })` on `paymentIntents`, `charges`,
  `customers`, `products`, `prices` and `refunds` (`GET /v1/<resource>/search`,
  Stripe's query language): a page promise (`SearchResult<T>`: `next_page`,
  `total_count` with `expand: ['total_count']`) that is also an async iterable
  following `next_page` with the same query (`ApiSearchPromise`). Lists and
  searches share one auto-pager (`AutoPaging`).
- New `peable.reporting.reportTypes` (`list`, `retrieve`) and
  `peable.reporting.reportRuns` (`create`, `retrieve`, `list({ report_type })`):
  `payments.itemized.1`, `balance.summary.1`, `payouts.itemized.1`, produced in
  the background as a `finance_report_run` file.
- New `files.contents(id)` (`GET /v1/files/:id/contents`): a report's CSV bytes
  with its `contentType` and `filename` (`DownloadedBytes`), over the new
  `GatewayClient.download`. `FilesResource` now takes a `GatewayClient`.
- `Charge` gains `billing_details`.
- Files: purpose `finance_report_run` (CSV, written by Peable only), type `csv`;
  `FILE_UPLOAD_PURPOSES` lists what `files.create` takes, and
  `CreateFileFromOxyParams.purpose` is a `FileUploadPurpose`.
- New events `reporting.report_run.succeeded` and `reporting.report_run.failed`,
  accepted by `webhooks.constructEvent`.
- Re-exported: `SEARCHABLE_RESOURCES`, `SEARCH_QUERY_MAX_LENGTH`,
  `SEARCH_QUERY_MAX_CLAUSES`, `SEARCH_SUBSTRING_MIN_LENGTH`, `REPORT_TYPE_IDS`,
  `REPORT_TYPE_LAYOUTS`, `REPORT_RUN_STATUSES` and their types.

## 0.18.0 — checkout v2, payment links v2, Elements, branding (Orbit Phase 3, breaking)

Requires `@peable.to/shared-types` 0.16.0.

**Breaking** (the next minor; one wire, ADR 0014 D2):

- `checkout.sessions.create` takes the v2 session contract: `mode`
  (`payment` | `setup` | `subscription`), `line_items` (`price` or `price_data`
  with `product` / `product_data`, `quantity`, `adjustable_quantity`),
  `discounts` / `allow_promotion_codes`, `customer` / `customer_email` /
  `customer_creation`, address / shipping / phone / tax id / custom field /
  terms collection, `automatic_tax`, `locale`, `ui_mode`, `expires_at`,
  `client_reference_id`, `submit_type`. The single `amount` / `rail` /
  `network` session is gone.
- `CheckoutSession` is Stripe's shape: `status`, `payment_status`,
  `amount_subtotal`, `amount_total`, `total_details`, `customer_details`,
  `shipping_details`, `payment_intent` / `setup_intent` (`null` until the payer
  confirms), `url` (hosted) or `client_secret` (embedded, the SESSION's secret).
- `paymentLinks.create` takes `line_items` over catalog prices and the
  session options (`after_completion`, `restrictions.completed_sessions`,
  `custom_fields`, …); `PaymentLink` carries them instead of `amount`. A link
  starts a Checkout Session; it never mints a payment.

Added:

- `checkout.sessions.expire(id)`, `checkout.sessions.listLineItems(id)`,
  `list({ payment_link, customer, status })`; `paymentLinks.listLineItems(id)`
  and `retrieve(id, { expand })`.
- `merchants.branding.retrieve/update` and `merchants.emailSettings.retrieve/update`.
- Events accepted by `constructEvent`: `checkout.session.completed|expired|
  async_payment_succeeded|async_payment_failed`, `payment_link.created|updated`.
- `@peable.to/sdk/checkout`: `PeableCheckout.mountCheckout` (embedded checkout,
  origin-checked postMessage), `createPeableElements` (`payment`,
  `expressCheckout`, `address`; `confirmPayment` / `confirmSetup` that wait for
  the gateway's status), the `appearance` API (`resolveAppearance`,
  `toProviderAppearance`, `toCssVariables`, `appearanceFromBranding`), the embed
  protocol helpers, and payer calls for sessions, links and SetupIntents
  (`getCheckoutSession`, `updateCheckoutSession`, `confirmCheckoutSession`,
  `getPaymentLink`, `startPaymentLinkSession`, `getSetupIntent`,
  `getSetupClientAction`).
## 0.17.0 — Connect, fees, ledger, balance and payouts (breaking, ADR 0015)

Requires `@peable.to/shared-types` 0.15.0.

- New `peable.account` (`retrieve` / `update`): the merchant's own fiat
  provider account — readiness, capabilities, requirements, business profile,
  statement descriptors and the payout schedule (`settings.payouts.schedule`).
  The first `update` opens it and needs `country` and `business_type`; a
  merchant with none is a 404 `account_missing`.
- `peable.accountLinks.create` without `account` mints a hosted onboarding link
  for the merchant's own account (`POST /v1/account_links`, `type:
  'account_onboarding' | 'account_update'`). With `account` it still onboards
  that seller. `AccountLinksResource` takes an optional second
  `AccountResource` constructor argument.
- New `peable.balance.retrieve`, `peable.balanceTransactions` (`retrieve` /
  `list({ type, payout, source, currency })`), `peable.payouts` (`create` /
  `retrieve` / `list({ status })` / `cancel`), `peable.applicationFees`
  (`retrieve` / `list({ payment_intent, charge })` / `listRefunds`) and
  `peable.reports.payoutReconciliation({ payout })` (a list of the payout's
  balance transactions with `summary`, auto-paginated like every list).
- New per-request option `peableAccount` (`PeableRequestOptions`), sent as
  `Peable-Account: ca_…`, on the account, balance, balance transaction, payout
  and reconciliation methods: a platform acting on one of its connected
  accounts.
- `refunds.update(id, { metadata })` and `refunds.cancel(id)`. `refunds.create`
  takes `reason`, `metadata`, `refund_application_fee` and `reverse_transfer`;
  `CreateRefundParams` is now the wire contract's type (same public name).
- `PaymentIntent` gains `application_fee_amount`, `transfer_data` and
  `on_behalf_of` (also on `CreatePaymentIntentParams`); `Charge` gains
  `application_fee` and `application_fee_amount`.
- New events: `account.updated`, `application_fee.created`,
  `application_fee.refunded`, `payout.created`, `payout.updated`, `payout.paid`,
  `payout.failed`, `payout.canceled`, `balance.available`.
- **Breaking:** `ConnectedAccount.requirements` lists requirement identifiers
  (`currently_due`, `eventually_due`, `past_due`, `pending_verification` are
  `string[]`, not counts) and carries `disabled_reason`;
  `ConnectedAccount.disabled_reason_codes` is removed.
- **Breaking:** `Refund` gains `reason` and `metadata`, and `Refund.status` adds
  `canceled`.

## 0.16.0 — Files, complete disputes, payment method breadth (breaking)

Requires `@peable.to/shared-types` 0.14.0.

- **Breaking:** `disputes.submitEvidence` (`POST /v1/disputes/:id/evidence`) is
  removed, with no alias. Use `disputes.update(id, { evidence, metadata, submit })`
  (`POST /v1/disputes/:id`): `submit` omitted or `false` stages a draft at the
  provider; `submit: true` uploads the attached files and submits, once. New
  `disputes.close(id)` accepts a dispute (`lost`). `DisputesResource` moved from
  `resources/merchants` to `resources/disputes`.
- **Breaking:** the `Dispute` object is Stripe's: `evidence_due_at` /
  `evidence_submitted_at` are replaced by `evidence_details {due_by,
  has_evidence, past_due, submission_count, submitted_at}`; new `charge`
  (expandable), `is_charge_refundable`, `metadata`, `reason` as Stripe's enum,
  and `evidence` on live reads only. File evidence fields (`receipt`,
  `customer_communication`, `shipping_documentation`, `uncategorized_file`, …)
  take `file_…` ids. New events `charge.dispute.funds_withdrawn` and
  `charge.dispute.funds_reinstated`, accepted by `webhooks.constructEvent`.
- New `peable.files` (`create` — multipart bytes or `{ oxy_file }` — `retrieve`,
  `list({ purpose })`). `RestClient` requests take a `form` (`FormData`) beside
  `body`.
- New `peable.paymentMethodConfigurations` (`create` / `retrieve` / `update` /
  `list`) and `peable.paymentMethodDomains` (`create` / `retrieve` / `update` /
  `list` / `validate`).
- `paymentIntents.create` takes `payment_method_configuration` and card-rail
  `payment_method_types` (`card`, `sepa_debit`, `ideal`, `bancontact`, `eps`);
  `PaymentIntent.payment_method_configuration_details` is new.
- `merchants.update` takes `business_logo` (a `file_…` of purpose
  `business_logo`), beside `avatar_file_id` — the wordmark, not the icon.
- Currencies widened: GBP, CHF, SEK, NOK, DKK, PLN, CZK, CAD, AUD and JPY
  (zero-decimal) join FAIR, EUR and USD. `CURRENCY_CODES`, `CURRENCY_DECIMALS`
  and `FIAT_CURRENCY_CODES` are re-exported.
- `@peable.to/sdk/checkout`: `mountCardElements` mounts the provider's wallet
  buttons (Apple Pay and Google Pay only; the provider's own wallet is off) above
  its Payment Element, which shows the card and local methods the intent offers.
  One confirmation path; an accepted confirmation is never success.
- `@peable.to/sdk/checkout`: `availableWallets`, `readRedirectReturn`,
  `withoutRedirectParams` and `delayedProcessingNotice` (SEPA Debit takes
  business days); new `ProviderFieldEvent` type export; provider types cover
  `expressCheckout` and its `confirm` event.
- `PeableCheckout.mount`: a card intent now renders wallets, payment fields and a
  Pay button instead of the FairCoin button; it handles bank-redirect returns
  (shows "confirming", removes the secret from the URL) and shows the gateway's
  status once the payment leaves the payer's hands.
- `@peable.to/sdk/checkout/ui`: `intentMethodAvailability` and
  `intentCheckoutMethods` list a card intent's wallets and local methods for the
  Bloom sheet. A method the device or host cannot run is listed as unavailable
  with a reason, never hidden or faked. New English and Spanish `method.*`
  messages.

## 0.15.0 — live tails, request logs and test helpers

Additive. Requires `@peable.to/shared-types` 0.13.0.

- New `peable.events.stream({ types, signal, onConnect, onDisconnect })` — an
  async iterable of every event as it is recorded, rendered exactly as a
  webhook delivery carries it (`GET /v1/events/stream`, Server-Sent Events).
  **Test mode only** (a live credential throws `PeablePermissionError`, code
  `test_mode_only`). Reconnects on its own and resumes after the last event it
  yielded (`Last-Event-ID`); ends when `signal` aborts.
- New `peable.requestLogs`: `list({ status, method, created, … })` (`status` is
  a code or a class, `'4xx'`), `retrieve(requestId)` and `stream({ status,
  method })` — your own API requests of the last 30 days, `id` being the
  `Request-Id`. Method, path, status, duration and `Idempotency-Key` only.
- New `peable.testHelpers` (test mode only):
  `paymentIntents.simulateFaircoinPayment(id, { outcome })` drives a FairCoin
  test payment through the real state machine (`processing → succeeded`, or
  `canceled` when `outcome: 'underpaid'`) without touching the chain;
  `checkoutSessions.expire(id)` cancels the session's payment as `abandoned`.
- New `peable.webhookEndpoints.sendTestEvent(id)` — a `webhook_endpoint.test`
  to one endpoint, as Orbit's "send test event".
- `createRestClient` returns a `GatewayClient` (`RestClient` plus `stream`);
  `RestClient`, the interface an integrator implements, is unchanged.

## 0.14.0 — catalog: products, prices, coupons, promotion codes (ADR 0018)

Additive.

- New `peable.products` (`create` / `retrieve` / `update` / `list` / `del`):
  `prod_…` with `default_price` (expandable), `tax_code` (Peable Tax),
  `images`, `marketing_features`, `unit_label`, `statement_descriptor`, `url`;
  `default_price_data` on create; `list({ active, ids })`. A product with prices
  cannot be deleted — archive it.
- New `peable.prices` (`create` / `retrieve` / `update` / `list`): `price_…`,
  per-unit or tiered (`graduated` / `volume`), `transform_quantity`, one-time or
  `recurring` (at most three years), `tax_behavior`, `lookup_key` with
  `transfer_lookup_key`; `list({ product, active, type, currency, lookup_keys,
  recurring: { interval, usage_type } })`. Immutable except `active`,
  `nickname`, `metadata`, `lookup_key` and an `unspecified` `tax_behavior`.
- New `peable.coupons` (`create` / `retrieve` / `update` / `list` / `del`):
  `percent_off` (two decimals) or `amount_off` + `currency`, `duration`,
  `max_redemptions`, `redeem_by`, `applies_to.products`, computed `valid`.
- New `peable.promotionCodes` (`create` / `retrieve` / `update` / `list`):
  `promo_…` redeeming a coupon, case-insensitive `code` unique among active
  codes, `customer`, `max_redemptions`, `expires_at`, `restrictions`;
  `list({ code, coupon, customer, active })`.
- Ten new event types, accepted by `webhooks.constructEvent`:
  `product.created`, `product.updated`, `product.deleted`, `price.created`,
  `price.updated`, `coupon.created`, `coupon.updated`, `coupon.deleted`,
  `promotion_code.created`, `promotion_code.updated`.
- Requires `@peable.to/shared-types` 0.12.0.

## 0.13.0 — Orbit payments core: Stripe's PaymentIntent, events, Customers, PaymentMethods, SetupIntents (breaking, ADR 0019)

- `PaymentIntent.status` is Stripe's vocabulary: `requires_payment_method`,
  `requires_confirmation`, `requires_action`, `processing`, `requires_capture`,
  `succeeded`, `canceled`. The old `created`, `awaiting_approval`, `approved`,
  `broadcast`, `confirming`, `settled`, `refunded`, `partially_refunded`,
  `expired`, `failed` and `rejected` are gone. Refunds are not statuses any more
  (`amount_refunded`, and `Refund.payment_status` is removed).
- The chain side of a FairCoin payment moved under `faircoin`
  (`network`, `address`, `txid`, `confirmations`, `required_confirmations`) and
  `next_action.faircoin_payment` (address, amount, `faircoin:` URI); the
  top-level `network`, `address`, `txid` and `confirmations` are removed.
  `merchant_id` is the public `merch_…`.
- New fields: `amount_capturable`, `amount_received`, `capture_method`,
  `setup_future_usage`, `customer`, `payment_method`, `latest_charge`,
  `next_action`, `last_payment_error`, `cancellation_reason`, `canceled_at`,
  `description`, `receipt_email`, `statement_descriptor_suffix`, `shipping`,
  `payment_method_types`.
- `paymentIntents.reject` is removed; `paymentIntents.cancel(id, { cancellation_reason })`,
  `confirm(id, { payment_method, off_session, … })` and
  `capture(id, { amount_to_capture })` are new. A declined confirmation throws
  `PeableCardError` (402) carrying `paymentIntent` and `declineCode`.
- New read-only `charges.retrieve` / `charges.list({ payment_intent })`.
- `list({ customer })` on payment intents.
- Event types are Stripe's (`payment_intent.succeeded`, `payment_intent.payment_failed`,
  `payment_intent.canceled`, `charge.refunded`, `charge.dispute.created`, …);
  `webhooks.constructEvent` accepts exactly the new catalog.
- `@peable.to/sdk/checkout`: the mount's events are `processing`, `succeeded`,
  `payment_failed`, `canceled` and `error` (were `confirming`, `settled`,
  `failed`, `error`). The UI kit's FairCoin transfer states `confirming` /
  `settled` are `processing` / `succeeded`.
- New `peable.customers` (`create` / `retrieve` / `update` / `del` / `list({ email })`),
  `peable.paymentMethods` (`retrieve` / `update` / `list({ customer })` / `detach`) and
  `peable.setupIntents` (`create` / `retrieve` / `list({ customer })` / `cancel`) —
  Orbit's own `cus_` / `pm_` / `seti_` objects (ADR 0016). A `pm_…` is created
  by a SetupIntent that succeeds (or a payment with `setup_future_usage`);
  card details are collected by the provider's Elements, never sent to Peable.
- Requires `@peable.to/shared-types` 0.11.0.

## 0.12.0 — events and webhook endpoints (breaking)

Events are a resource and webhooks render them (ADR 0014 D4). An event is
stored once, in the same transaction as the change it records, and kept 30
days; each enabled webhook endpoint whose `enabled_events` match it receives
one delivery of it, retried with backoff for about three days.

- New `peable.webhookEndpoints`: `create` / `retrieve` / `update` / `list` /
  `del` / `rollSecret`. Several endpoints per merchant (at most 16), each with
  its own `enabled_events` (`'*'` for all) and its own signing secret. The
  secret (`whsec_…`) is generated by Peable and returned ONLY by `create` and
  `rollSecret`. `rollSecret(id, { expires_in_seconds })` (≤ 86 400) keeps the
  previous secret signing beside the new one until then.
- An endpoint that fails every delivery for three days is disabled
  (`status: 'disabled'`, `disabled_reason: 'delivery_failures'`);
  `update(id, { disabled: false })` re-enables it.
- New `peable.events`: `list({ type, delivery_success, created, … })` —
  `type` exact or a `prefix.*` — and `retrieve(id)`.
- New `peable.webhookDeliveries`: `list({ event, webhook_endpoint })` and
  `redeliver(id)` (a new delivery of the same stored event).
- The event envelope gains `api_version` (the wire date it was stored under),
  `data.previous_attributes` (the moved fields' prior values, when the event is
  a change) and `request: { id, idempotency_key }` (the API request that caused
  it, both `null` otherwise). **`webhooks.constructEvent` requires
  `api_version` and `request`.** New event type `webhook_endpoint.test`, sent
  by Orbit's "send test event" to one endpoint.
- `webhooks.constructEvent(raw, header, secret)` accepts a header with several
  `v1=` signatures (a rotation overlap) and a list of secrets: it verifies when
  any signature matches any secret.
- **Removed:** `webhook_url` / `webhook_secret` from `merchants.register` and
  `merchants.update`, and `webhook_url` from `Merchant`. Register an endpoint
  instead; merchants that had a webhook were migrated to one endpoint each,
  `enabled_events: ['*']`, keeping their secret.
- `WebhookDelivery` names `event_id` (`evt_…`) and `webhook_endpoint_id`
  (`we_…`); `merchant_id` and `intent_id` are gone (the event carries the
  payment).
- Requires `@peable.to/shared-types` 0.10.0.

## 0.10.0 — test and live in one deployment (breaking)

The gateway holds a test and a live provider key side by side (ADR 0017); the
credential's environment selects the mode (`production` → live, every other
environment → test), and nothing the SDK sends chooses it.

- `livemode: boolean` on every object: `PaymentIntent`, `PaymentLink` (and the
  public link), `CheckoutSession` (and the public session), `Refund`,
  `Transfer`, `TransferReversal`, `Dispute`, `ConnectedAccount`, `AccountLink`,
  `Settlement`, `WebhookDelivery`, `Merchant` and `BillingObservation`. It is
  the mode of the object's merchant and never changes for an object.
- The webhook event envelope carries `livemode` too. **`webhooks.constructEvent`
  now requires it**: a signed event without a boolean `livemode` is rejected
  with `PeableSignatureVerificationError`, and a `billing.observation.updated`
  whose observation names a different mode than its envelope is rejected as
  well. Upgrade the gateway before (or with) this SDK; events from an older
  gateway do not carry the field.
- Card operations in a mode the deployment has no key for answer `503`
  (`PeableApiError`), like any unavailable rail. The former `403` for a
  credential of "the other" mode no longer exists.
- Requires `@peable.to/shared-types` 0.8.0.

## 0.9.0 — lists, expand and metadata (breaking)

- A reference to another object is named without `_id` and is expandable:
  `payment_intent` (was `payment_intent_id`) on checkout sessions, refunds,
  transfers, disputes and settlements; `connected_account` (was
  `connected_account_id`) on payment intents, checkout sessions and transfers.
  Typed `string | Object`; `expand` returns the object. Create bodies follow:
  `refunds.create({ payment_intent })`,
  `transfers.create({ payment_intent, connected_account })`.
- Every `list()` returns an `ApiListPromise`: a promise of one page
  (`{ object, data, has_more, url }`) that is also an async iterable over every
  page, with `autoPagingEach` and `autoPagingToArray({ limit })`. Lists take
  `ending_before` and `created` beside `limit` / `starting_after`. New:
  `refunds.list/retrieve`, `transfers.list/retrieve`, `disputes.list/retrieve`,
  `checkout.sessions.list/update`, `paymentIntents.update`; `listForPaymentIntent`
  pages. `ContributionsResource.iterate` is gone — iterate `list()` instead.
- `tax.transactions.list` takes the list parameters (`created` filters the tax
  date) instead of `{ from, to }`, and is newest first.
- Updates are `POST`: `paymentLinks.update`, `merchants.update` and contribution
  `setActive` no longer send `PATCH`. `metadata` on an update is a patch (`''`
  removes a key); at most 50 keys, 40-character keys, 500-character values.

## 0.8.0 — generic idempotency (breaking)

The gateway now answers `Idempotency-Key` on every merchant `POST` (ADR 0014
D3): within 24 hours a retried request gets the stored response with
`Idempotent-Replayed: true`, the same key with a different request is a 400
`idempotency_error`, and a key still in flight is a 409 `idempotency_error`.

- Every `POST` now carries an `Idempotency-Key`. Without `{ idempotencyKey }`
  the client mints a uuid per call, reused by that call's own re-attempt, so a
  retried call cannot run twice. Pass your own key (one per order) to make a
  retry from another call converge.
- `paymentIntents.create`'s `idempotencyKey` is optional; the gateway no longer
  requires the header.
- **Breaking:** `transfers.reverse` requires `external_ref`. The
  `Idempotency-Key` is no longer accepted as a reversal's identity — it is the
  24-hour retry layer, and an automatic key would give every reversal a random
  identity.
- A key reused with different terms on `paymentIntents.create` /
  `checkout.sessions.create` is a 400 with `code: 'idempotency_error'` (was 409).

## 0.7.0 — the Orbit wire (breaking)

The gateway now speaks one Stripe-style wire (ADR 0014), changed at the root with
no legacy shape kept:

- Every request parameter, response field and webhook payload is `snake_case`
  (`success_url`, `payment_intent_id`, `connected_account_id`); `createdAt` is
  `created`.
- Every instant is integer Unix seconds (`created`, `expires_at`, …). Amounts
  remain base-unit strings and currencies stay uppercase.
- Errors are `{ error: { type, code?, param?, message, request_id } }`, validation
  answers 400 (never 422), and request bodies are strict: an unknown field is a
  400 naming it in `param`. `PeableError` exposes `param` and `requestId`.
- Contribution lists use the common list envelope with `starting_after`.
- Signed billing documents are `schema_version: 2` only.
- Client options (`idempotencyKey`, `requestTimeoutMs`, `toleranceSec`) stay
  camelCase, as in Stripe's SDKs.

Requires `@peable.to/shared-types` 0.6.0 and `@peable.to/contracts` 0.3.0.

## 0.6.0

- Add the optional `@peable.to/sdk/checkout/ui` entry with controlled Peable
  checkout, payment-method details, order details and optional reward presentation.
  Backend and anonymous headless entries remain independent of React and Bloom.
- Compose secure provider-hosted card fields inside Bloom CardForm. Preparing a
  card creates an opaque authorization; explicit confirmation remains a separate
  action, and verified backend observations establish payment completion.
- Include Peable brand/feedback assets and verify published export paths during
  the build. The UI entry requires Bloom 16.10.0 or newer and has no CommonJS entry.

The release does not activate merchant offers, tax registrations, live payment
methods or product entitlements. Hosts supply authoritative capabilities and
quotes; illustrative checkout scenarios remain development fixtures.
