# Orbit by Peable — Stripe parity

Orbit by Peable is the merchant platform (dashboard, API, SDKs, hosted checkout).
Peable is the personal payment app. Stripe is one *internal* fiat provider behind
Orbit, not the product (`docs/integrations/payment-provider-boundary.md`).

This is the living checklist of what Orbit has and lacks against Stripe's
merchant-facing surface. It records **source capability**; readiness states
(externally tested, deployed, live) follow `docs/PEABLE-ROADMAP.md` and need their
own dated evidence. Update a row in the PR that changes it.

Decisions: [0014](../adr/0014-orbit-api-conventions-and-versioning.md) conventions
and versioning · [0015](../adr/0015-orbit-funds-flow.md) funds flow ·
[0016](../adr/0016-orbit-owns-its-objects.md) native objects ·
[0017](../adr/0017-test-and-live-in-one-deployment.md) test and live ·
[0018](../adr/0018-native-billing-engine.md) billing engine ·
[0019](../adr/0019-stripe-payment-intent-model.md) PaymentIntent model.

Legend: ✅ present · 🟡 partial · ❌ absent · ⛔ out of scope

Baseline: `main` at `5e75bc5` (2026-11-03).

## Phase 0 — API foundations (ADR 0014)

| Capability | State | Today | Target |
|---|---|---|---|
| Prefixed public ids, `object` field | 🟡 | Most resources; `WebhookDelivery.id` is the internal id; social/enrich/contributions lack `object` | Every object |
| Single field style | ✅ | snake_case everywhere, root change (no legacy) | |
| Unix timestamps | ✅ | `created` and every instant as integer seconds | |
| `livemode` on objects | ✅ | Every merchant-scoped DTO (intent, link, session, refund, transfer, reversal, dispute, connected account, account link, settlement, webhook delivery, merchant) and the event envelope; derived from the merchant's environment (ADR 0017) | |
| One wire, clean cut | ✅ | Handlers, types, SDK, checkout and app speak ADR 0014 D1; stored wire JSON migrated (`0036`) | |
| Error envelope | 🟡 | `{type, code?, param?, message, request_id}`; 400 validation; strict bodies; no leak | + `doc_url` once docs.peable.to exists |
| `Request-Id` | ✅ | Header on every response and `request_id` in every error | |
| Generic idempotency | ✅ | Optional `Idempotency-Key` on every merchant POST (`idempotency_keys`, `lib/idempotency.ts`): stored 2xx/4xx replayed with `Idempotent-Replayed: true` for 24 h per merchant, 400/409 `idempotency_error`, 5xx released; PI unique key and `external_ref` stay beneath it. Not on registration, `client_action` (a read) or billing (own operation ledger) | |
| List pagination | ✅ | One helper (`lib/list.ts` + `db/keyset.ts`) for every list, sub-lists included: `{object, data, has_more, url}`, `limit` 1–100 (default 10), `starting_after` / `ending_before` (newest first both ways), `created[gt\|gte\|lt\|lte]`, scoped cursors (400 `resource_missing`), strict query. Tax codes/registrations/products are complete sets (`has_more: false`) | |
| `expand[]` | 🟡 | Registry (`lib/expand.ts`), dot paths ≤ 4, `data.` on lists, merchant-scoped, one query per level. Expandable references are named without `_id`: `payment_intent`, `connected_account` on PI, session, refund, transfer, dispute, settlement | `expand` on create bodies; more objects as they become resources |
| Metadata | 🟡 | Stripe limits on every create/update that takes it; updates are patches (`""` unsets), merged in SQL; updatable on PI, link, session | Refunds, transfers, connected accounts, disputes need a `metadata` column |
| Update verb | ✅ | `POST /v1/<objects>/:id` for PI, link, session, contribution, `merchants/me`; no `PATCH` on the merchant API | Dashboard owner routes (`…/merchant`, `…/tax/settings`) still `PATCH` |
| Search API | ❌ | — | Phase 8 |
| OpenAPI | 🟡 | Contributions only | Whole API from `packages/contracts` |
| Request logs | ✅ | `api_request_logs`: one row per service-authenticated merchant `/v1` request (method, path without query, status, duration, `Idempotency-Key`; never bodies, headers or query strings), 30-day retention (sweeper + read horizon); `GET /v1/request_logs` (`status` code or class, `method`, `created`) and `/:id` by `Request-Id`; `GET /v1/request_logs/stream` (test mode); dashboard `…/request_logs`; SDK `requestLogs` | Orbit Logs page |

## Phase 1 — Keys, modes, events, webhooks

| Capability | State | Today | Target |
|---|---|---|---|
| Secret credentials | 🟡 | Oxy application credentials; 2 scopes | Managed from Orbit over Oxy authority; per-resource scopes |
| Publishable key | ❌ | Provider key of the payment's own mode returned inside `client_action` | `pk_test_` / `pk_live_` |
| Test + live in one deployment | ✅ | `STRIPE_*_TEST` / `STRIPE_*_LIVE` side by side; credential selects the mode, stored rows resolve by their own; webhooks verified per mode on the same paths (ADR 0017) | |
| Events API | ✅ | `evt_` stored in the transaction of its change (ADR 0014 D4); `GET /v1/events` (`type` exact or `prefix.*`, `created`, `delivery_success`) and `/v1/events/:id`; 30-day retention (sweeper + read horizon); envelope carries `api_version`, `previous_attributes`, `request {id, idempotency_key}`; SDK `events` | `types[]` filter; `pending_webhooks` |
| Webhook endpoints | ✅ | `we_` resource (create/list/retrieve/update/delete), ≤ 16 per merchant, `enabled_events` incl. `*`, generated `whsec_` shown once, `roll_secret` with ≤ 24h dual-signature overlap, per-endpoint `api_version`, URL checked by the dispatcher's SSRF rules; `POST /v1/webhook_endpoints/:id/test` (Orbit's "send test event" for an integration, SDK `sendTestEvent`); `merchants.webhook_*` removed; SDK `webhookEndpoints` | Endpoint pinned to an older `api_version` once dated versions exist |
| Event catalog | 🟡 | Stripe's names (ADR 0019): `payment_intent.created\|requires_action\|processing\|amount_capturable_updated\|succeeded\|payment_failed\|canceled`, `charge.refunded`, `charge.dispute.*`, `refund.*`, `customer.*`, `payment_method.*`, `setup_intent.*`, `connected_account.updated`, the catalog's `product.created\|updated\|deleted`, `price.created\|updated`, `coupon.created\|updated\|deleted`, `promotion_code.created\|updated` (ADR 0018), `account.updated`, `application_fee.*`, `payout.*`, `balance.available` (ADR 0015) + `webhook_endpoint.test` | `charge.succeeded\|captured\|updated`, Billing |
| Retry schedule | ✅ | ~3 days exponential with ±20% jitter; an endpoint failing continuously for 3 days is disabled (`disabled_reason: delivery_failures`) | |
| Delivery log + redeliver | ✅ | One delivery per (event, endpoint); `GET /v1/webhook_deliveries` (`event`, `webhook_endpoint`), redeliver; Orbit dashboard: endpoints CRUD + roll + "send test event", events, deliveries; SDK `webhookDeliveries` | Prefixed delivery ids |

## Phase 2 — Payments core

| Capability | State | Today | Target |
|---|---|---|---|
| PaymentIntent create/retrieve/list | ✅ | | |
| PaymentIntent status model | ✅ | Stripe's seven statuses on both rails, `cancellation_reason`/`canceled_at`, `last_payment_error`, `next_action` (`faircoin_payment`, `use_peable_sdk`), refunds as `amount_refunded` (ADR 0019); data migrated (`0043`) | |
| PI update / confirm (server) / capture / cancel | ✅ | `POST /v1/payment_intents/:id` (metadata, description, receipt_email, shipping); `/confirm` (saved `payment_method`, 402 `card_error` on decline, `requires_action` for 3DS); `/capture` (`amount_to_capture`); `/cancel` (`cancellation_reason`, cancels at the provider first); `/reject` removed | `increment_authorization` |
| Manual capture | ✅ | `capture_method: manual` → `requires_capture` (`amount_capturable`) → `/capture`, partial | |
| Customers | ✅ | Native `cus_` (ADR 0016): CRUD, list (`email`), tombstone delete, `invoice_settings.default_payment_method`; provider customer a lazy per-mode binding | Billing (`/v1/billing/*`) still on provider ids until ADR 0018 |
| PaymentMethods | ✅ | Native `pm_` created by a succeeded SetupIntent or a `setup_future_usage` payment; retrieve, list (`customer=`), update (billing details, metadata), permanent detach | Re-attach; non-card types |
| SetupIntents / off-session | ✅ | `seti_` (create/retrieve/list/cancel, payer `client_action`), `setup_future_usage`, `off_session` confirm | Payer-side `confirmSetup` in `@peable.to/sdk/checkout` |
| PI fields (receipt email, descriptor, shipping, description) | ✅ | All four; `statement_descriptor_suffix` card only and the one forwarded to the provider | Peable-sent receipts (Phase 3) |
| Charges | 🟡 | Read-only `ch_` per succeeded card authorization: retrieve, list (`payment_intent=`), expandable `latest_charge`; `outcome`, `payment_method_details.card`, `amount_captured/refunded`, `captured`, `refunded`, `disputed`, `balance_transaction`, `application_fee(_amount)` | `receipt_url` (Peable receipts, Phase 3) |
| Refunds | ✅ | Create (`reason`, `metadata`, `refund_application_fee`, `reverse_transfer`); retrieve; update (`metadata`); cancel where the provider allows; list (global, `payment_intent=`, per intent) | |
| Disputes | ✅ | Stripe's object: retrieve (with `evidence`, read live), list (`payment_intent=`, `charge=`, per intent); `POST /v1/disputes/:id` stages a draft at the provider (`submit: false`, no words stored here) or submits once (`submit: true`, second refused 409); 17 text + 9 file fields (`file_…` of purpose `dispute_evidence`, bytes uploaded to the provider at submission only); `…/close` accepts (lost); `evidence_details {due_by, has_evidence, past_due, submission_count, submitted_at}`, `charge` (expandable), `is_charge_refundable`, `metadata`, `reason` as Stripe's enum; `charge.dispute.created\|updated\|closed\|funds_withdrawn\|funds_reinstated` | `balance_transactions` (ledger, Phase 5); `enhanced_evidence`, `duplicate_charge_id` |
| Files | ✅ | `file_` over Oxy Files: `POST /v1/files` (multipart bytes, or `oxy_file` for a merchant-owned logo through the one ownership check), retrieve, list (`purpose=`); purposes `dispute_evidence`, `business_logo`, `identity_document`, `additional_verification` with per-purpose type (sniffed from the bytes) and size limits; Peable-owned private storage (public for logos), reference sync in the row's transaction, nightly reconciliation; file events withhold/remove; `url` only for an available logo | File links; `identity_document` consumed by Peable-hosted onboarding |
| Wallets (Apple/Google Pay) | ✅ | `payment_method_domains` (`pmd_`: create with validation, list, retrieve, update `enabled`, `…/validate`) registered at the provider; wallets per configuration; Express Checkout in the hosted checkout and `@peable.to/sdk/checkout` (Apple Pay and Google Pay only) | |
| Local methods (SEPA, iDEAL, Bancontact, EPS; Bizum) | 🟡 | `payment_method_configurations` (`pmc_`: default per merchant, create, update with merged preferences, list) bound to the provider's configuration, pushed per version; PI create honours `payment_method_types` or `payment_method_configuration`, filtered by currency, stored on the intent; Payment Element shows them; unavailable methods carry `unavailable_reason` | Bizum (`provider_unsupported`: the processing provider does not offer it); non-card saved methods (SEPA mandates) |
| Currencies | ✅ | FAIR; EUR, USD, GBP, CHF, SEK, NOK, DKK, PLN, CZK, CAD, AUD, JPY (JPY zero-decimal) on the card rail, CHECKs widened (`0049`/`0050`, validated `0051`) | More as the provider and methods need |
| Transfers list/retrieve | ✅ | Global (`payment_intent=`, `connected_account=`) and per intent; retrieve | |

## Phase 3 — Checkout, Links, Elements, portal, emails

| Capability | State | Today | Target |
|---|---|---|---|
| Hosted checkout | ✅ | One amount per session | |
| Checkout `mode` payment/subscription/setup | ❌ | Payment only; subscriptions via Stripe-hosted Checkout | All three on Peable checkout |
| Line items, quantity | ❌ | — | `line_items`, `adjustable_quantity` |
| Discounts / promo codes | ❌ | — | Present |
| Collect email/address/phone/tax id/custom fields | ❌ | — | Present |
| Tax shown at checkout | 🟡 | FairCoin `billingQuote` only | `automatic_tax` for every rail |
| `success_url` redirect / `cancel_url` | 🟡 | Success CTA only; cancel stored, unused | Redirect with `{CHECKOUT_SESSION_ID}`; cancel rendered |
| Session list/expire/line_items | 🟡 | List (`payment_intent=`); metadata update | expire, line_items |
| Locales | 🟡 | Checkout English only; UI kit en/es | es/en/fr/de/it/pt |
| Merchant branding | 🟡 | Avatar (square icon), `business_logo` (a `file_`, the wordmark — `MerchantDisplay.logo_url`, shown by the hosted checkout), name, description; Orbit uploads the logo | Colours, font |
| Payment Links | 🟡 | Single amount; contributions | On Prices; quantity, promos, `after_completion` |
| Embedded components | 🟡 | FairCoin button; RN/Bloom sheet with split card fields | Payment Element, Express Checkout, Address Element; `appearance` API |
| Customer portal | 🟡 | Stripe Billing Portal | Orbit-hosted portal + configurations |
| Receipts and billing emails | ❌ | — | Via Oxy outbound mail relay |

## Phase 4 — Billing (ADR 0018)

| Capability | State | Today | Target |
|---|---|---|---|
| Products / Prices | ✅ | Native `prod_` / `price_` (ADR 0016/0018): products CRUD (`active`, `ids[]`, `created`; delete only with no prices and no coupon naming it), `default_price` (expandable, an active price of the product; `default_price_data` on create), `tax_code` checked against Peable Tax codes; prices per-unit or tiered (`graduated`/`volume`), `transform_quantity`, one-time or recurring (≤ 3 years), `tax_behavior`, `lookup_key` unique per merchant with `transfer_lookup_key`; immutable but `active`/`nickname`/`metadata`/`lookup_key`/unset `tax_behavior`; list `product`, `active`, `type`, `currency`, `lookup_keys[]`, `recurring[interval\|usage_type]`; shared `price_data` validator; pure pricing module (`services/catalog/pricing.ts`). JSON offers / provider prices still serve billing until the engine | `custom_unit_amount`, `currency_options`, `unit_amount_decimal`, metered prices (need meters), `product_data`, Search |
| Coupons / Promotion codes | ✅ | Coupons: merchant-chosen or `coupon_` id (never reused), `percent_off` (2 decimals, basis points) xor `amount_off`+`currency`, `duration` once/repeating/forever, `max_redemptions`, `redeem_by`, `applies_to.products`, `valid`; update name/metadata; delete (tombstone). Promotion codes `promo_`: case-insensitive `code` unique among active codes (generated when absent), `customer`, `max_redemptions`, `expires_at` (≤ coupon `redeem_by`), `restrictions` (first-time, minimum amount); update `active`/`metadata`; list `code`/`coupon`/`customer`/`active`. Discount math (half-up percent, capped amount) and every refusal in `pricing.ts`; nothing redeems yet | Redemption counting at checkout/invoices; `currency_options`; restrictions on update |
| Subscriptions | 🟡 | Stripe Billing via Checkout; FairCoin native | Native engine |
| Plan change / proration / quantity | ❌ | Refused | Supported |
| Pause / cancel now | ❌ | Cancel at period end only | Supported |
| Trials | 🟡 | `trialDays` on Stripe Checkout | Native |
| Invoices | 🟡 | Read from Stripe; FairCoin native rows | Native lifecycle, PDF, hosted page, numbering |
| Credit notes | ❌ | Observed only | Native |
| Dunning | ❌ | Stripe defaults | Configurable |
| Usage-based billing | ❌ | — | Meters + meter events |
| Test clocks | ❌ | Internal verification scripts only | `clock_` |
| Entitlements | ❌ | — | Features + active entitlements |
| Tax on invoices | ✅ | Peable Tax, renewal repricing | Computed before finalize |

## Phase 5 — Connect and money (ADR 0015)

| Capability | State | Today | Target |
|---|---|---|---|
| Connected accounts | ✅ | Marketplace sellers (card + FairCoin halves) and the merchant's OWN account (`role = 'merchant'`, Accounts v2, `dashboard: none`); requirements as identifier lists (Stripe's shape) | |
| Account resource | ✅ | `GET/POST /v1/account` (`business_profile`, `capabilities`, `requirements`, `charges_enabled`, `payouts_enabled`, `settings` payouts schedule / descriptors / branding), opened with `country` + `business_type`, settings written to the provider and read back; `account.updated`; `merchants/me` kept as the registration (ADR 0015 as built) | |
| Onboarding | 🟡 | Hosted account links (`POST /v1/account_links`, `account_onboarding` / `account_update`) for the merchant and per seller; Peable FairCoin link | Embedded onboarding in Orbit |
| Separate charges & transfers | ✅ | Marketplaces without an own account | |
| Destination charges / `on_behalf_of` | ✅ | Automatic for a merchant with an onboarded account; `transfer_data {destination, amount}`, `on_behalf_of`, `application_fee_amount` on PI create for a platform's sellers; first-party merchants stay platform charges with no fee | |
| Application fees | ✅ | `fee_schedules` (bps + fixed per currency, `card`) or the deployment default; `fee_…` / `fr_…` from the provider's own fee object; list/retrieve/refunds list; `application_fee.created\|refunded`; refunds take `refund_application_fee`, `reverse_transfer` | Fee schedule management in Orbit (operator data today) |
| `Peable-Account` header | ✅ | On account, account links, balance, balance transactions, payouts and the payout reconciliation report; 400 elsewhere; SDK `peableAccount` | |
| Ledger / balance transactions | ✅ | Double-entry `ledger_entries` (every journal sums to zero), `txn_…` mirrored verbatim from the provider, idempotent ingestion, releases; list (`type`, `payout`, `source`, `currency`, `created`) and retrieve; `Charge.balance_transaction` | `expand` of `source` |
| Balance | ✅ | `GET /v1/balance` available / pending / informational (FairCoin) from the ledger; 404 `account_missing` without an account; `balance.available` | |
| Payouts | ✅ | `po_…` mirrored from `payout.*`, `POST /v1/payouts` on a manual schedule (the provider executes), cancel, schedule in `/v1/account` settings; `payout.created\|updated\|paid\|failed\|canceled` | Instant payout eligibility |
| Reconciliation | ✅ | Daily per account (7-day window): mismatches recorded, warned, listed in Orbit, never auto-corrected; `GET /v1/reports/payout_reconciliation?payout=` | Scheduled report exports |
| Live release gate | ✅ | `ORBIT_THIRD_PARTY_LIVE_PAYMENTS=false` by default: no live account, destination charge or payout for a non-Oxy merchant (403 `live_payments_gated`) | Opened after the ADR 0015 legal review |

## Phase 6 — Orbit app (`packages/orbit`)

| Capability | State | Today | Target |
|---|---|---|---|
| Merchant dashboard | 🟡 | `packages/orbit`: Expo web + Bloom, Oxy sign-in, organization/application picker, Rail navigation; Tax and Contributions ported (still also in the wallet until removed there) | Deployed at orbit.peable.to; every area below |
| Payments / refunds / disputes UI | 🟡 | Payments list (status filter, `starting_after` paging) and detail (amount by currency decimals, timeline from the intent's own fields, metadata); Home counts/volume computed client-side from the first page. Disputes list (status, reason, amount by currency decimals, respond-by deadline with past due) and detail: 17 text + 9 file evidence fields (file fields upload `dispute_evidence` files), Save draft, Submit once behind a one-shot confirmation, Accept (close) behind its own; read-only once submitted, closed, under review or past due. No refunds UI | Refunds |
| Payment methods settings | ✅ | Settings → Payment methods: per-method on/off for the selected `pmc_` (default first), availability, currencies and the capability reason for anything unavailable (shown disabled, never hidden); Wallet domains (add, check again, enable/disable, Apple Pay / Google Pay status with its detail) | |
| Customers / catalog / subscriptions / invoices UI | 🟡 | Products: list (active/archived), create with a first price, edit, archive, delete, prices per product (add, archive, set default) over the dashboard catalog routes | Coupons and promotion codes, customers, subscriptions, invoices |
| Payment Links builder | ❌ | — | Present |
| Balances / payouts / reports | 🟡 | Balances (available / pending / FairCoin informational, balance transactions, open reconciliation mismatches), Payouts (list, detail with its reconciliation report, manual payout, cancel, schedule), Account (onboarding status, requirements, start/resume onboarding) | Reports beyond payout reconciliation |
| Developers (keys, webhooks, events, logs) | 🟡 | Webhook delivery log (status, attempts, last error, next attempt) with Redeliver; merchant webhook URL/secret in Settings; backend routes for request logs (`/v1/dashboard/applications/:id/request_logs`) | Keys, endpoints, events, request logs UI |
| Team and roles | 🟡 | Oxy membership checks on dashboard routes | Orbit settings over Oxy membership |
| Test/live toggle | ✅ | Orbit's Test / Live toggle maps to `?environment=` (`development` / `production`) on every dashboard call | |

## Phase 7 — Developer experience

| Capability | State | Today | Target |
|---|---|---|---|
| Server SDK | 🟡 | Resources above; typed errors; `constructEvent` | 1.0 generated from OpenAPI |
| Auto-pagination | ✅ | `list()` is a page promise and an async iterable on every list; `autoPagingEach`, `autoPagingToArray({ limit })`; `expand` option | |
| Auto idempotency keys / retries / default timeout | 🟡 | A uuid key on every POST (0.8.0); one 401 retry under the same key; no network retries; no default timeout | Retries with backoff; default timeout |
| Version pinning in SDK | ❌ | — | `apiVersion` |
| CLI (`listen`, `trigger`, `logs tail`) | ✅ | `@peable.to/cli` 0.1.0 (`private` until its npm trusted publisher is configured): `login`/`logout`/`whoami` (0600 profiles, test/live), `listen --forward-to` (per-session `whsec_`, the gateway's own signing; fed by `GET /v1/events/stream`, SSE signalled by `NOTIFY` in the event's transaction, test mode), `trigger` (fixtures over the public API + test helpers), `logs tail`, `events`, `payment_intents`, `checkout_sessions create`, `webhook_endpoints` | `trigger` for card-only events (needs provider-confirmed test cards) |
| Test helpers / documented test data | ✅ | `POST /v1/test_helpers/payment_intents/:id/simulate_faircoin_payment` (the watcher's own decision, synthetic txid, no chain) and `/v1/test_helpers/checkout_sessions/:id/expire` (the sweep's own step), test mode only; SDK `testHelpers`; `docs/integrating-peable.md` › Local development links the provider's test cards and documents testnet | Card test helpers (Stripe's `test_clocks`, refund/dispute simulation) |
| Docs site + API reference | 🟡 | `docs/integrating-peable.md` | docs.peable.to |
| Sample apps | ❌ | — | `examples/` |

## Phase 8 and out of scope

| Capability | State |
|---|---|
| Search, scheduled reports, risk rules, Quotes, Identity, Terminal, multi-provider routing | ❌ later |
| Issuing, Treasury, Capital | ⛔ need banking authorisation (ADR 0015) |
| Buying or selling FairCoin | ⛔ product boundary (`AGENTS.md`) |
| Peable-held fiat balances | ⛔ ADR 0015 |
