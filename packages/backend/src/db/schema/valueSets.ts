/**
 * The closed value sets this schema stores, as `const` tuples.
 *
 * Every one of them types a `text` column AND renders that column's CHECK
 * constraint, from the same tuple — the convention in
 * `schema/CONVENTIONS.md`. A pg `enum` would put the values in a type whose
 * every change is a migration and whose members cannot be removed at all.
 *
 * `AssertAllListed` is what stops a tuple silently falling behind the union it
 * mirrors. `satisfies` alone only proves each member IS a union member; the
 * dangerous direction is the other one — a union gaining a member no tuple
 * lists, which would type-check everywhere and then be refused by a CHECK at
 * runtime, on the first write of the new value, in production.
 */

import type { NetworkType } from '@fairco.in/core';
import { OXY_SERVICE_ENVIRONMENTS } from '@oxy.so/core/server';
import type {
  PaymentIntentCancellationReason,
  PaymentIntentCaptureMethod,
  PaymentIntentRail,
  PaymentIntentSetupFutureUsage,
  PaymentIntentStatus,
  WebhookEnabledEvent,
  SetupIntentStatus,
  WebhookEventType,
} from '@peable.to/shared-types';
// TYPE-ONLY, and it must stay that way: the module it names imports the Stripe
// SDK. `import type` is erased before `drizzle-kit generate` ever runs it.
import type { ProviderId } from '../../services/providers/provider';

/**
 * `true` when every member of `TUnion` appears in `TListed`, and a compile
 * error otherwise. Type-only, so it costs nothing at runtime and cannot be
 * left unasserted the way an unused `const` can.
 */
// biome-ignore lint/correctness/noUnusedVariables: TUnion's `extends TListed` constraint IS the assertion; it fails to compile when a member is missing
type AssertAllListed<TUnion extends TListed, TListed> = true;

/** FairCoin networks. */
export const NETWORK_TYPES = ['mainnet', 'testnet'] as const satisfies readonly NetworkType[];
export type NetworkTypesAreComplete = AssertAllListed<NetworkType, (typeof NETWORK_TYPES)[number]>;

/** Oxy service-token environments — test/live isolation, re-exported so the CHECK reads from the SDK's own tuple. */
export const SERVICE_ENVIRONMENTS = OXY_SERVICE_ENVIRONMENTS;

/**
 * The payment-intent lifecycle.
 *
 * `@peable.to/shared-types` publishes `PAYMENT_INTENT_STATUSES` as a
 * `readonly PaymentIntentStatus[]` derived from `Object.keys(...)`, which
 * carries no literal types and therefore cannot type a column. This tuple is
 * the literal form; `schema/__tests__/valueSets.test.ts` asserts the two hold
 * the same members, so the runtime source of truth still governs.
 */
export const PAYMENT_INTENT_STATUS_VALUES = [
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'requires_capture',
  'canceled',
  'succeeded',
] as const satisfies readonly PaymentIntentStatus[];
export type PaymentIntentStatusesAreComplete = AssertAllListed<
  PaymentIntentStatus,
  (typeof PAYMENT_INTENT_STATUS_VALUES)[number]
>;

/**
 * The payment providers this gateway can route a fiat payment through.
 *
 * Mirrors `services/providers/provider.ts`'s `ProviderId`. Re-listed rather
 * than imported because that module pulls in the Stripe SDK transitively, and
 * a schema file that dragged an HTTP client into `drizzle-kit generate` would
 * make migration generation depend on a payment library being installable.
 *
 * The `import type` below is erased before anything runs, so the pin costs
 * nothing at generation time — and it is the pin that matters: the dangerous
 * direction is `ProviderId` gaining a member this tuple does not list, which
 * type-checks everywhere and is then refused by the CHECK on the first write of
 * the new provider, in production. `providersAreComplete` below makes that a
 * compile error instead.
 */
export const PROVIDER_IDS = ['stripe'] as const;
export type ProvidersAreComplete = AssertAllListed<ProviderId, (typeof PROVIDER_IDS)[number]>;

/**
 * Which rail moves a payment (ADR 0001 D1). The discriminator every
 * rail-conditional CHECK in `schema/payments.ts` reads.
 */
export const RAIL_VALUES = ['faircoin', 'card'] as const satisfies readonly PaymentIntentRail[];
export type RailsAreComplete = AssertAllListed<PaymentIntentRail, (typeof RAIL_VALUES)[number]>;

/**
 * The statuses only the card rail can reach (ADR 0019): a FairCoin payment
 * requires no payment method, has nothing to confirm server-side and nothing to
 * capture. Re-exported from the contract rather than re-listed, so the CHECK
 * cannot drift from the transition table.
 */
export { CARD_ONLY_STATUSES } from '@peable.to/shared-types';

/** Why an intent was cancelled (ADR 0019). NULL when nobody said. */
export const CANCELLATION_REASON_VALUES = [
  'abandoned',
  'automatic',
  'duplicate',
  'fraudulent',
  'requested_by_customer',
  'underpaid',
] as const satisfies readonly PaymentIntentCancellationReason[];
export type CancellationReasonsAreComplete = AssertAllListed<
  PaymentIntentCancellationReason,
  (typeof CANCELLATION_REASON_VALUES)[number]
>;

/** When a card is captured. FairCoin is always `automatic`. */
export const CAPTURE_METHOD_VALUES = [
  'automatic',
  'manual',
] as const satisfies readonly PaymentIntentCaptureMethod[];
export type CaptureMethodsAreComplete = AssertAllListed<
  PaymentIntentCaptureMethod,
  (typeof CAPTURE_METHOD_VALUES)[number]
>;

/** Card only: keep the payment method for later. */
export const SETUP_FUTURE_USAGE_VALUES = [
  'on_session',
  'off_session',
] as const satisfies readonly PaymentIntentSetupFutureUsage[];
export type SetupFutureUsagesAreComplete = AssertAllListed<
  PaymentIntentSetupFutureUsage,
  (typeof SETUP_FUTURE_USAGE_VALUES)[number]
>;

/** Where a SetupIntent stands — Stripe's six. */
export const SETUP_INTENT_STATUS_VALUES = [
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'canceled',
  'succeeded',
] as const satisfies readonly SetupIntentStatus[];
export type SetupIntentStatusesAreComplete = AssertAllListed<
  SetupIntentStatus,
  (typeof SETUP_INTENT_STATUS_VALUES)[number]
>;

/**
 * How a provider reports one capability on a connected account.
 *
 * NULL is the fourth state and is deliberately NOT in this tuple: it means the
 * capability was never REQUESTED, which is a different fact from the provider
 * declining (`inactive`) or still working (`pending`). A tuple member for it
 * would make the column say "requested and unknown", which is not a thing a
 * provider ever reports.
 */
export const CAPABILITY_STATUSES = ['active', 'pending', 'inactive'] as const;

/**
 * Where one transfer stands.
 *
 *  - `pending`             — created here, not yet confirmed by the provider.
 *  - `paid`                — the provider moved it.
 *  - `partially_reversed`  — some came back. `amount_reversed` says how much,
 *                            cumulatively; a second partial reversal stays in
 *                            this status and only the amount changes.
 *  - `reversed`            — all of it came back.
 *  - `failed`              — the provider refused. Terminal, and distinct from a
 *                            reversal: nothing ever moved.
 */
export const TRANSFER_STATUSES = [
  'pending',
  'paid',
  'partially_reversed',
  'reversed',
  'failed',
] as const;

/**
 * Where one refund stands — the MONEY's own lifecycle, not the payment's.
 *
 * Deliberately not the payment's status set. `refunded` on a payment means "all
 * of it came back"; `succeeded` on a refund means "this movement completed",
 * and a payment can hold several of those. Sharing a vocabulary would make
 * "which refund failed" unaskable.
 */
export const REFUND_STATUSES = ['pending', 'succeeded', 'failed', 'canceled'] as const;

/**
 * Who created a refund.
 *
 *  - `merchant` — asked for through this API, carrying the merchant's own
 *                 `external_ref`, which is its idempotency.
 *  - `provider` — it appeared at the acquirer (a dashboard refund, a dispute
 *                 the network resolved) and was IMPORTED. There is no merchant
 *                 reference and there cannot be one: the merchant did not make
 *                 it and has no id for it.
 *
 * The distinction is not derivable from `external_ref IS NULL` even though the
 * two agree today. "Did we do this" is a question an operator asks directly,
 * and answering it from the absence of another column is how a future
 * merchant-initiated refund with no reference silently reads as imported.
 */
export const REFUND_ORIGINS = ['merchant', 'provider'] as const;

/**
 * Where one REVERSAL of a transfer stands.
 *
 * The same three words as a refund and a different subject, which is why it is
 * its own tuple rather than a reuse: a refund returns a buyer's money and a
 * reversal takes a seller's settlement back, and the day one of them grows a
 * fourth state the other must not inherit it.
 *
 * A reversal is a ROW because it needs a durable identity. The service used to
 * derive its provider idempotency key from `trr:<transfer>:<amount>`, so two
 * distinct reversals of the same transfer for the same amount — an ordinary
 * thing, two 500-cent line items refunded separately — presented one key, and
 * the provider answered the FIRST reversal to the second request. The seller
 * kept 500 that had been taken back, and nothing recorded which of the two it
 * was.
 */
export const TRANSFER_REVERSAL_STATUSES = ['pending', 'succeeded', 'failed'] as const;

/**
 * Where a dispute stands, in the gateway's own vocabulary.
 *
 * Four states, not the provider's seven. Stripe distinguishes
 * `warning_needs_response` from `needs_response`, and `warning_closed` from
 * `won`/`lost`, because it is describing its own product; a merchant on this
 * gateway needs to know only whether evidence is DUE, whether it is being
 * looked at, and how it ended. ADR 0001 D3 is the reason — the acquirer stays
 * invisible, so its vocabulary cannot leak onto the wire either.
 *
 * `needs_response` is the one with a deadline attached, which is why it is the
 * default: a dispute nobody has classified is one somebody has to act on, and
 * that is the safe direction to be wrong in.
 */
export const DISPUTE_STATUSES = ['needs_response', 'under_review', 'won', 'lost'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

/**
 * What each event is ABOUT — and therefore what it must name. This map IS the
 * event catalog: a new event type is an entry here (plus its payload in
 * `WebhookEventPayload`), and the CHECKs that list types are derived from it.
 *
 * ## Declared, not inferred from the name
 *
 * `events_intent_event_has_intent_check` (formerly on `webhook_deliveries`)
 * used to key on the
 * `payment_intent.` PREFIX: an event whose type started with it had to carry a
 * `payment_intent_id`, and one that did not had to carry none. That worked for
 * the ten events that exist and made the naming convention load-bearing in a
 * place no reader of the convention would look.
 *
 * The cost of that lands in the worst possible spot. A delivery is enqueued
 * INSIDE the transaction that advances a payment's status (ADR 0001 D7), so a
 * CHECK this constraint refuses does not fail a webhook — it rolls back the
 * money transition that was enqueueing it. An intent-scoped event named
 * something other than `payment_intent.*` (a `charge.*`, a `refund.*`, an
 * event renamed for Stripe parity) would therefore abort a settlement, and the
 * reason would be a naming rule nobody was applying on purpose.
 *
 * So the scope is stated. `satisfies Record<WebhookEventType, …>` is total in
 * both directions, which means a new event type does not compile until someone
 * says which resource it is about — and that answer, not its spelling, is what
 * the constraint enforces.
 */
export const WEBHOOK_EVENT_SCOPES = {
  'payment_intent.created': 'intent',
  'payment_intent.requires_action': 'intent',
  'payment_intent.processing': 'intent',
  'payment_intent.amount_capturable_updated': 'intent',
  'payment_intent.succeeded': 'intent',
  'payment_intent.payment_failed': 'intent',
  'payment_intent.canceled': 'intent',
  // Named for the charge, the refund or the dispute and still ABOUT a payment —
  // the case the declared scope exists for.
  'charge.refunded': 'intent',
  'charge.dispute.created': 'intent',
  'charge.dispute.updated': 'intent',
  'charge.dispute.closed': 'intent',
  'charge.dispute.funds_withdrawn': 'intent',
  'charge.dispute.funds_reinstated': 'intent',
  'refund.created': 'intent',
  'refund.updated': 'intent',
  'refund.failed': 'intent',
  // About a customer, a saved card or a seller: no payment named.
  'customer.created': 'merchant',
  'customer.updated': 'merchant',
  'customer.deleted': 'merchant',
  'payment_method.attached': 'merchant',
  'payment_method.detached': 'merchant',
  'payment_method.updated': 'merchant',
  'setup_intent.created': 'merchant',
  'setup_intent.requires_action': 'merchant',
  'setup_intent.succeeded': 'merchant',
  'setup_intent.setup_failed': 'merchant',
  'setup_intent.canceled': 'merchant',
  'billing.observation.updated': 'merchant',
  'connected_account.updated': 'merchant',
  // The catalog (ADR 0018): about the merchant's own products and offers.
  'product.created': 'merchant',
  'product.updated': 'merchant',
  'product.deleted': 'merchant',
  'price.created': 'merchant',
  'price.updated': 'merchant',
  'coupon.created': 'merchant',
  'coupon.updated': 'merchant',
  'coupon.deleted': 'merchant',
  'promotion_code.created': 'merchant',
  'promotion_code.updated': 'merchant',
  // Orbit money (ADR 0015): about the merchant's account, its fees, payouts
  // and balance — never a payment's status, so no `payment_intent_id` is
  // required of them, even the fee events that are caused by one.
  'account.updated': 'merchant',
  'application_fee.created': 'merchant',
  'application_fee.refunded': 'merchant',
  'payout.created': 'merchant',
  'payout.updated': 'merchant',
  'payout.paid': 'merchant',
  'payout.failed': 'merchant',
  'payout.canceled': 'merchant',
  'balance.available': 'merchant',
  // Checkout (Orbit Phase 3): about an order, which names a payment only once
  // the payer confirmed — and never in `setup` mode.
  'checkout.session.completed': 'merchant',
  'checkout.session.expired': 'merchant',
  'checkout.session.async_payment_succeeded': 'merchant',
  'checkout.session.async_payment_failed': 'merchant',
  'payment_link.created': 'merchant',
  'payment_link.updated': 'merchant',
  // Reporting: a report run finished, about the merchant's own report.
  'reporting.report_run.succeeded': 'merchant',
  'reporting.report_run.failed': 'merchant',
  // Sent to ONE endpoint on request; about the endpoint, never about a payment.
  'webhook_endpoint.test': 'merchant',
} as const satisfies Record<WebhookEventType, 'intent' | 'merchant'>;

/**
 * Totality is asserted over the scope map's KEYS, which is the only list now.
 *
 * `WEBHOOK_EVENT_TYPES` below is derived from it rather than written out a
 * second time: two hand-kept lists of the same ten strings is one of them
 * silently falling behind, and the one that falls behind here is a CHECK.
 */
export type WebhookEventTypesAreComplete = AssertAllListed<
  WebhookEventType,
  keyof typeof WEBHOOK_EVENT_SCOPES
>;

/** Stripe-parity dotted webhook event types. */
export const WEBHOOK_EVENT_TYPES = Object.keys(WEBHOOK_EVENT_SCOPES) as readonly WebhookEventType[];

/**
 * The events whose delivery names a payment — the CHECK's own list.
 *
 * Derived, so adding an intent-scoped event under any name widens the
 * constraint with it, and adding a seller-scoped one under a `payment_intent.`
 * name does not.
 */
export const INTENT_WEBHOOK_EVENT_TYPES = WEBHOOK_EVENT_TYPES.filter(
  (type) => WEBHOOK_EVENT_SCOPES[type] === 'intent',
);

/**
 * The event types never fanned out by subscription — sent only to the one
 * endpoint they name. A webhook endpoint cannot list them in `enabled_events`.
 */
export const TARGETED_WEBHOOK_EVENT_TYPES = [
  'webhook_endpoint.test',
] as const satisfies readonly WebhookEventType[];

/**
 * What `webhook_endpoints.enabled_events` may hold: every subscribable event
 * type, and `*` for all of them (including types added later).
 */
export const WEBHOOK_ENABLED_EVENTS: readonly WebhookEnabledEvent[] = [
  '*',
  ...WEBHOOK_EVENT_TYPES.filter(
    (type) => !(TARGETED_WEBHOOK_EVENT_TYPES as readonly string[]).includes(type),
  ),
];

/** Re-exported from the wire contract so the CHECK reads from the tuple the DTO is typed by. */
export {
  WEBHOOK_ENDPOINT_DISABLED_REASONS,
  WEBHOOK_ENDPOINT_STATUSES,
} from '@peable.to/shared-types';

/**
 * Where one webhook delivery stands.
 *
 * Was `['delivered', 'failed']` — the two outcomes an inline, best-effort
 * `deliver()` could report once it had already finished. ADR 0001 D7 makes
 * delivery a durable outbox, so a row now exists BEFORE any attempt and the set
 * has to say so.
 *
 *  - `pending`   — will be attempted. `next_attempt_at` says when; `attempts`
 *                  may be 0 (never tried) or more (a transient failure backed
 *                  off). These are the only rows the dispatcher claims.
 *  - `delivered` — terminal success.
 *  - `failed`    — terminal REFUSAL. The target answered something no retry can
 *                  fix (a 4xx, an SSRF rejection). Distinct from `dead` because
 *                  the causes need different operator responses: this one is a
 *                  merchant endpoint problem.
 *  - `dead`      — terminal EXHAUSTION. Every attempt was transient and the
 *                  budget ran out. The event is still in the row and can be
 *                  redelivered by hand.
 */
export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'dead'] as const;

/** The statuses from which no further attempt is made. */
export const TERMINAL_WEBHOOK_DELIVERY_STATUSES = ['delivered', 'failed', 'dead'] as const;

/**
 * The currencies this gateway denominates in.
 *
 * This set was `['FAIR']` alone, with a comment saying a single-member set
 * still earns a CHECK because it is "what makes adding a second currency a
 * migration with a decision behind it rather than a value that appears one day
 * in a row". ADR 0001 D4 is that decision.
 *
 * Re-exported from `@peable.to/shared-types` rather than re-listed: the wire
 * contract owns the set AND the per-currency scale (`CURRENCY_DECIMALS`), and a
 * currency this column accepted but the contract could not name would be a row
 * the API cannot describe.
 */
export { CURRENCY_CODES } from '@peable.to/shared-types';

/**
 * The catalog's closed sets (ADR 0018), re-exported from the wire contract that
 * types the DTOs, so a CHECK can never accept a value the API cannot name nor
 * refuse one it publishes.
 */
export {
  COUPON_DURATIONS,
  PRICE_BILLING_SCHEMES,
  PRICE_TAX_BEHAVIORS,
  PRICE_TIERS_MODES,
  PRICE_TYPES,
  RECURRING_INTERVALS,
  RECURRING_USAGE_TYPES,
  TRANSFORM_QUANTITY_ROUNDS,
} from '@peable.to/shared-types';

/**
 * The highest derivation index this schema can store — `int4`'s ceiling, and
 * NOT a coincidence: it is exactly the highest legal non-hardened BIP32 child
 * index, `HARDENED_OFFSET - 1`.
 *
 * Verified against both derivation paths rather than assumed. `@fairco.in/core`
 * exports the same number as `MAX_SOCIAL_RECEIVE_INDEX` and refuses anything
 * above it, and `deriveIntentAddress` derives from a public-only node, on which
 * `@scure/bip32` cannot derive a hardened child at all ("Could not derive
 * hardened child key"). So `integer` holds the whole legal space and one value
 * beyond it — which is why an overflow is a REFUSAL of an index that could not
 * have been derived anyway, rather than a limit this schema imposes.
 *
 * `db/__tests__/derivationIndexBound.test.ts` fails the build if those two
 * numbers ever stop agreeing: were the derivable space to widen, `integer`
 * would silently start refusing legal indices.
 */
export const MAX_DERIVATION_INDEX = 2147483647;

/**
 * A canonical non-negative base-unit integer string — the exact pattern
 * `isBaseUnitString` (`@peable.to/shared-types`) enforces in the application,
 * restated here because the database is where a value that skipped the
 * application guard would otherwise land unchallenged. Kept byte-identical to
 * the TypeScript source; `schema/__tests__/valueSets.test.ts` pins that.
 */
export const BASE_UNIT_STRING_PATTERN = '^(0|[1-9][0-9]*)$';

/**
 * The kinds of Peable entity that USE an Oxy file (ADR 0043 D4): the
 * `entityType` of every reference this application registers with Oxy, and the
 * unit `OxyServer.assets.references.reconcile` is run per.
 *
 *  - `merchant_avatar` — a merchant's square identity image, an Oxy file the
 *    merchant owns (`merchants.avatar_file_id`, entity = `merch_…`).
 *  - `file` — an Orbit File (`files`, entity = `file_…`): bytes Peable stored
 *    for a merchant, or an Oxy file a merchant owns imported as one. EVERY live
 *    `files` row holds its reference — an application-owned file nothing
 *    references is collected by Oxy — and whatever uses a File (a dispute's
 *    evidence, the merchant's `business_logo`) uses the row, never the Oxy
 *    file directly, so it needs no reference of its own.
 *
 * A person's profile avatar is Oxy's own, shown through `profile.avatar` and
 * never written here. A new use is a new member AND a branch in
 * `db/oxyFiles/referenceSyncRepository.ts`'s `isReferenceWanted`, in
 * `services/oxyFiles/referenceReconciliation.ts`'s inventory and in
 * `services/oxyFiles/fileEvents.ts`, which switch on this tuple exhaustively
 * so a member without them does not compile.
 */
export const OXY_FILE_ENTITY_TYPES = ['merchant_avatar', 'file'] as const;
export type OxyFileEntityType = (typeof OXY_FILE_ENTITY_TYPES)[number];

/**
 * Every file event Oxy sends (ADR 0043 D9), from the SDK's own tuple, so the
 * CHECK on `oxy_file_events.event_type` can never refuse a type the verifier
 * accepted.
 */
export { FILE_EVENT_TYPES as OXY_FILE_EVENT_TYPES } from '@oxy.so/core/server';

/**
 * Why a merchant's avatar is stored but not SHOWN to a payer.
 *
 *  - `unavailable` — Oxy says the file is no longer `active` (moved to trash
 *                    by its owner). Oxy does not serve it, so a URL to it is a
 *                    broken image on the checkout page.
 *  - `private`     — its owner made it private. Same consequence.
 *
 * Both are reversible by the owner (restore, or make it public again), which is
 * why the column is kept rather than the avatar cleared: a deleted or blocked
 * file is NOT here — that clears `avatar_file_id` outright, because it can
 * never come back.
 */
export const MERCHANT_AVATAR_WITHHELD_REASONS = ['unavailable', 'private'] as const;
export type MerchantAvatarWithheldReason = (typeof MERCHANT_AVATAR_WITHHELD_REASONS)[number];

/** What a file event did to a merchant's avatar — `merchant_avatar_audit.action`. */
export const MERCHANT_AVATAR_AUDIT_ACTIONS = ['cleared', 'withheld', 'released'] as const;
export type MerchantAvatarAuditAction = (typeof MERCHANT_AVATAR_AUDIT_ACTIONS)[number];

/**
 * What a File is for, its stored format and its standing — re-exported from the
 * wire contract, which owns the sets and the per-purpose upload policy.
 */
export { FILE_PURPOSES, FILE_STATUSES, FILE_TYPES } from '@peable.to/shared-types';

/**
 * Why a File is stored but not SERVED — the same two reversible reasons as an
 * avatar's, for the same file events. A deleted, taken-down or lost file sets
 * `files.removed_at` instead: it can never come back.
 */
export const FILE_WITHHELD_REASONS = MERCHANT_AVATAR_WITHHELD_REASONS;
export type FileWithheldReason = MerchantAvatarWithheldReason;

/** The Oxy events that remove a File for good — `files.removed_by`. */
export const FILE_REMOVAL_EVENT_TYPES = ['file.deleted', 'file.blocked', 'file.lost'] as const;
export type FileRemovalEventType = (typeof FILE_REMOVAL_EVENT_TYPES)[number];

/**
 * The dispute evidence fields that name a File — re-exported from the wire
 * contract, so the CHECK on `dispute_evidence_files.field` cannot drift from the
 * fields the route accepts and the adapter forwards.
 */
export { DISPUTE_FILE_EVIDENCE_FIELDS } from '@peable.to/shared-types';

/**
 * The methods a payment method configuration can turn on, and the card-rail
 * types a PaymentIntent can carry — the wire contract's sets.
 */
export {
  CARD_RAIL_PAYMENT_METHOD_TYPES,
  PAYMENT_METHOD_CONFIGURATION_TYPES,
} from '@peable.to/shared-types';

/** A wallet's standing on a payment method domain. */
export const PAYMENT_METHOD_DOMAIN_WALLET_STATUSES = ['active', 'inactive'] as const;
export type PaymentMethodDomainWalletStatus =
  (typeof PAYMENT_METHOD_DOMAIN_WALLET_STATUSES)[number];

/** Where one scheduled reconciliation run stands — `oxy_file_reconciliation_runs.status`. */
export const OXY_FILE_RECONCILIATION_STATUSES = [
  'running',
  'succeeded',
  'failed',
  'abandoned',
] as const;
export type OxyFileReconciliationStatus = (typeof OXY_FILE_RECONCILIATION_STATUSES)[number];

/**
 * Where one `Idempotency-Key` stands — `idempotency_keys.status` (ADR 0014 D3).
 *
 *  - `in_progress` — the first request presenting the key holds its lease and
 *                    is still running. Another request with the same key is
 *                    answered 409 `idempotency_error` until it finishes or the
 *                    lease runs out.
 *  - `completed`   — the first request finished with a 2xx or 4xx, and its
 *                    status and body are stored for replay. A 5xx is never
 *                    stored: the row is deleted so the caller can retry.
 */
export const IDEMPOTENCY_KEY_STATUSES = ['in_progress', 'completed'] as const;
export type IdempotencyKeyStatus = (typeof IDEMPOTENCY_KEY_STATUSES)[number];

/**
 * The HTTP methods a request log records — `api_request_logs.method`.
 * Re-exported from the wire contract so the CHECK reads from the tuple
 * `RequestLog.method` is typed by.
 */
export { REQUEST_LOG_METHODS } from '@peable.to/shared-types';
// ---------------------------------------------------------------------------
// Orbit money (ADR 0015): accounts, fees, the ledger, payouts, reconciliation
// ---------------------------------------------------------------------------

/**
 * What a `connected_accounts` row is to its merchant.
 *
 *  - `seller`   — one of a marketplace's sellers, addressed by the platform's
 *                 own `external_ref` (ADR 0012).
 *  - `merchant` — the merchant's OWN fiat account (ADR 0015 §1): at most one per
 *                 merchant, card half only, no `external_ref`.
 */
export const CONNECTED_ACCOUNT_ROLES = ['seller', 'merchant'] as const;
export type ConnectedAccountRole = (typeof CONNECTED_ACCOUNT_ROLES)[number];

export {
  BALANCE_TRANSACTION_STATUSES,
  BALANCE_TRANSACTION_TYPES,
  PAYOUT_STATUSES,
  RECONCILIATION_MISMATCH_KINDS,
  REFUND_REASONS,
} from '@peable.to/shared-types';

/**
 * A ledger account's balance type (ADR 0015 §4). `available` and `pending`
 * mirror the provider's balance; `informational` holds FairCoin the merchant
 * received in its own wallet (§5); `external` is the counter-account every
 * journal posts against — the world outside the mirrored balance — so each
 * journal sums to zero.
 */
export const LEDGER_BALANCE_TYPES = ['available', 'pending', 'informational', 'external'] as const;
export type LedgerBalanceType = (typeof LEDGER_BALANCE_TYPES)[number];

/**
 * Why a journal was posted: `recognized` when a balance transaction is first
 * ingested, `released` when the provider moved its funds from pending to
 * available. ONE of each per balance transaction (a unique index).
 */
export const LEDGER_JOURNAL_KINDS = ['recognized', 'released'] as const;
export type LedgerJournalKind = (typeof LEDGER_JOURNAL_KINDS)[number];

export const PAYOUT_METHODS = ['standard', 'instant'] as const;
export const PAYOUT_TYPES = ['bank_account', 'card'] as const;
/** `provider` — the account's schedule created it; `merchant` — `POST /v1/payouts`. */
export const PAYOUT_ORIGINS = ['provider', 'merchant'] as const;
export type PayoutOrigin = (typeof PAYOUT_ORIGINS)[number];

/** The payment-method types a fee schedule can price. */
export const FEE_PAYMENT_METHOD_TYPES = ['card'] as const;
export type FeePaymentMethodType = (typeof FEE_PAYMENT_METHOD_TYPES)[number];

/**
 * A SIGNED canonical base-unit integer string: a balance transaction and a
 * ledger entry move money out as well as in. One spelling per value — no `-0`,
 * no leading zero.
 */
export const SIGNED_BASE_UNIT_STRING_PATTERN = '^(0|-?[1-9][0-9]*)$';
// ---- Checkout (Orbit Phase 3) ------------------------------------------------

export {
  BRANDING_BORDER_STYLES,
  BRANDING_FONTS,
  CHECKOUT_BILLING_ADDRESS_COLLECTIONS,
  CHECKOUT_CUSTOMER_CREATIONS,
  CHECKOUT_LOCALES,
  CHECKOUT_PAYMENT_STATUSES,
  CHECKOUT_SESSION_MODES,
  CHECKOUT_SESSION_STATUSES,
  CHECKOUT_SUBMIT_TYPES,
  CHECKOUT_UI_MODES,
} from '@peable.to/shared-types';

/** `checkout_sessions.automatic_tax_status` — Peable Tax's answer for the order. */
export const AUTOMATIC_TAX_STATUSES = ['complete', 'requires_location_inputs', 'failed'] as const;
export type AutomaticTaxStatus = (typeof AUTOMATIC_TAX_STATUSES)[number];

export const AFTER_COMPLETION_TYPES = ['redirect', 'hosted_confirmation'] as const;
export type AfterCompletionType = (typeof AFTER_COMPLETION_TYPES)[number];

/** The customer emails Peable sends (`customer_emails.kind`). */
export const CUSTOMER_EMAIL_KINDS = [
  'payment_receipt',
  'refund_notice',
  'checkout_confirmation',
] as const;
export type CustomerEmailKind = (typeof CUSTOMER_EMAIL_KINDS)[number];

export const CUSTOMER_EMAIL_STATUSES = ['pending', 'sent', 'failed', 'expired'] as const;
export type CustomerEmailStatus = (typeof CUSTOMER_EMAIL_STATUSES)[number];
