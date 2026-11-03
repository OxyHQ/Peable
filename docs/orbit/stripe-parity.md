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
[0018](../adr/0018-native-billing-engine.md) billing engine.

Legend: ✅ present · 🟡 partial · ❌ absent · ⛔ out of scope

Baseline: `main` at `5e75bc5` (2026-11-03).

## Phase 0 — API foundations (ADR 0014)

| Capability | State | Today | Target |
|---|---|---|---|
| Prefixed public ids, `object` field | 🟡 | Most resources; `WebhookDelivery.id` is the internal id; social/enrich/contributions lack `object` | Every object |
| Single field style | ✅ | snake_case everywhere, root change (no legacy) | |
| Unix timestamps | ✅ | `created` and every instant as integer seconds | |
| `livemode` on objects | 🟡 | Tax and billing DTOs only | Every object |
| One wire, clean cut | ✅ | Handlers, types, SDK, checkout and app speak ADR 0014 D1; stored wire JSON migrated (`0036`) | |
| Error envelope | 🟡 | `{type, code?, param?, message, request_id}`; 400 validation; strict bodies; no leak | + `doc_url` once docs.peable.to exists |
| `Request-Id` | ✅ | Header on every response and `request_id` in every error | |
| Generic idempotency | ✅ | Optional `Idempotency-Key` on every merchant POST (`idempotency_keys`, `lib/idempotency.ts`): stored 2xx/4xx replayed with `Idempotent-Replayed: true` for 24 h per merchant, 400/409 `idempotency_error`, 5xx released; PI unique key and `external_ref` stay beneath it. Not on registration, `client_action` (a read) or billing (own operation ledger) | |
| List pagination | 🟡 | `starting_after`, `limit`; three envelopes; sub-lists unpaginated | + `ending_before`, `created[...]`, `url`; one envelope everywhere |
| `expand[]` | ❌ | — | Depth 4, merchant-scoped |
| Metadata | 🟡 | PI/link/session create only; no limits; PI immutable | Every mutable resource; Stripe limits; updatable |
| Search API | ❌ | — | Phase 8 |
| OpenAPI | 🟡 | Contributions only | Whole API from `packages/contracts` |
| Request logs | ❌ | — | 30-day redacted log for Orbit and CLI |

## Phase 1 — Keys, modes, events, webhooks

| Capability | State | Today | Target |
|---|---|---|---|
| Secret credentials | 🟡 | Oxy application credentials; 2 scopes | Managed from Orbit over Oxy authority; per-resource scopes |
| Publishable key | ❌ | Provider key returned inside `client_action` | `pk_test_` / `pk_live_` |
| Test + live in one deployment | ❌ | One provider key per deployment (ADR 0009) | ADR 0017 |
| Events API | ❌ | Envelopes exist only inside deliveries | `/v1/events`, 30 days |
| Webhook endpoints | 🟡 | One URL per merchant, merchant-chosen secret, all events | `we_` resource, many per merchant, `enabled_events`, generated `whsec_`, rotation overlap, per-endpoint `api_version` |
| Event catalog | 🟡 | 11 types | Stripe-equivalent catalog across all resources |
| Retry schedule | 🟡 | ~8 h, 8 attempts | 3 days, auto-disable |
| Delivery log + redeliver | 🟡 | Dashboard list; SVC/dashboard redeliver | Per endpoint, in Orbit and SDK |

## Phase 2 — Payments core

| Capability | State | Today | Target |
|---|---|---|---|
| PaymentIntent create/retrieve/list | ✅ | | |
| PI update / confirm (server) / capture / cancel | 🟡 | `/reject` only | All, with `cancellation_reason` |
| Manual capture | ❌ | Automatic only | `capture_method: manual`, `amount_to_capture` |
| Customers | ❌ | Only `ensureCustomer` on Stripe for billing | Native `cus_` (ADR 0016) |
| PaymentMethods | ❌ | — | Native `pm_`, attach/detach/list |
| SetupIntents / off-session | ❌ | — | `seti_`, `setup_future_usage`, `off_session` |
| PI fields (receipt email, descriptor, shipping, description) | ❌ | — | Present |
| Charges | ❌ | Provider charge id internal | Read-only `ch_` with `outcome`, `receipt_url` |
| Refunds | 🟡 | Create; per-intent list; no reason | retrieve/list/update/cancel; `reason`; fee/transfer reversal flags |
| Disputes | 🟡 | Per-intent list; text evidence, one shot | retrieve/list/close; file evidence (still not stored) |
| Files | ❌ | — | `file_` over Oxy Files |
| Wallets (Apple/Google Pay) | ❌ | Possible via Payment Element config, unmodelled | Domain registration + Express Checkout |
| Local methods (SEPA, iDEAL, Bancontact, Bizum) | ❌ | — | Via provider, `payment_method_configurations` |
| Currencies | 🟡 | FAIR, EUR, USD | Provider-supported set |
| Transfers list/retrieve | 🟡 | Per intent only | Global |

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
| Session list/expire/line_items | ❌ | — | Present |
| Locales | 🟡 | Checkout English only; UI kit en/es | es/en/fr/de/it/pt |
| Merchant branding | 🟡 | Avatar, name, description | Logo, icon, colours, font |
| Payment Links | 🟡 | Single amount; contributions | On Prices; quantity, promos, `after_completion` |
| Embedded components | 🟡 | FairCoin button; RN/Bloom sheet with split card fields | Payment Element, Express Checkout, Address Element; `appearance` API |
| Customer portal | 🟡 | Stripe Billing Portal | Orbit-hosted portal + configurations |
| Receipts and billing emails | ❌ | — | Via Oxy outbound mail relay |

## Phase 4 — Billing (ADR 0018)

| Capability | State | Today | Target |
|---|---|---|---|
| Products / Prices | ❌ | Provider prices bound by script; JSON offers | Native catalog |
| Coupons / Promotion codes | ❌ | — | Native |
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
| Connected accounts | ✅ | Marketplace sellers (card + FairCoin halves) | Every fiat merchant too |
| Onboarding | 🟡 | Stripe-hosted links; Peable FairCoin link | + embedded onboarding in Orbit |
| Separate charges & transfers | ✅ | | |
| Destination charges / `on_behalf_of` | ❌ | Card `connectedAccount` refused | Per ADR 0015 |
| Application fees | ❌ | — | `application_fees`, refunds of fees |
| `Peable-Account` header | ❌ | — | Act on behalf of a connected account |
| Account resource | 🟡 | `merchants/me` | `/v1/account` with capabilities/requirements/settings |
| Ledger / balance transactions | ❌ | Per-payment settlement read | Double-entry, `txn_` |
| Balance | ❌ | — | Mirror of the merchant's provider account |
| Payouts | ❌ | `payouts_enabled` flag only | `po_` mirror, schedule, reconciliation |

## Phase 6 — Orbit app (`packages/orbit`)

| Capability | State | Today | Target |
|---|---|---|---|
| Merchant dashboard | ❌ | Tax and Contributions inside the wallet app | Expo web + Bloom at orbit.peable.to |
| Payments / refunds / disputes UI | ❌ | API only | Present |
| Customers / catalog / subscriptions / invoices UI | ❌ | — | Present |
| Payment Links builder | ❌ | — | Present |
| Balances / payouts / reports | ❌ | — | Present |
| Developers (keys, webhooks, events, logs) | ❌ | — | Present |
| Team and roles | 🟡 | Oxy membership checks on dashboard routes | Orbit settings over Oxy membership |
| Test/live toggle | 🟡 | `?environment=` on dashboard routes | UI toggle |

## Phase 7 — Developer experience

| Capability | State | Today | Target |
|---|---|---|---|
| Server SDK | 🟡 | Resources above; typed errors; `constructEvent` | 1.0 generated from OpenAPI |
| Auto-pagination | 🟡 | Contributions only | All lists |
| Auto idempotency keys / retries / default timeout | 🟡 | A uuid key on every POST (0.8.0); one 401 retry under the same key; no network retries; no default timeout | Retries with backoff; default timeout |
| Version pinning in SDK | ❌ | — | `apiVersion` |
| CLI (`listen`, `trigger`, `logs tail`) | ❌ | — | `@peable.to/cli` |
| Test helpers / documented test data | ❌ | Internal scripts | `/v1/test_helpers/*`, documented cards and testnet |
| Docs site + API reference | 🟡 | `docs/integrating-peable.md` | docs.peable.to |
| Sample apps | ❌ | — | `examples/` |

## Phase 8 and out of scope

| Capability | State |
|---|---|
| Search, scheduled reports, risk rules, Quotes, Identity, Terminal, multi-provider routing | ❌ later |
| Issuing, Treasury, Capital | ⛔ need banking authorisation (ADR 0015) |
| Buying or selling FairCoin | ⛔ product boundary (`AGENTS.md`) |
| Peable-held fiat balances | ⛔ ADR 0015 |
