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
import { OXY_SERVICE_ENVIRONMENTS } from '@oxyhq/core/server';
import type {
  PaymentIntentRail,
  PaymentIntentStatus,
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
type AssertAllListed<TUnion extends TListed, TListed> = true;

/** FairCoin networks. */
export const NETWORK_TYPES = ['mainnet', 'testnet'] as const satisfies readonly NetworkType[];
export type NetworkTypesAreComplete = AssertAllListed<
  NetworkType,
  (typeof NETWORK_TYPES)[number]
>;

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
  'created',
  'awaiting_approval',
  'approved',
  'broadcast',
  'confirming',
  'requires_action',
  'processing',
  'settled',
  'refunded',
  'partially_refunded',
  'expired',
  'failed',
  'rejected',
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
export type ProvidersAreComplete = AssertAllListed<
  ProviderId,
  (typeof PROVIDER_IDS)[number]
>;

/**
 * Which rail moves a payment (ADR 0001 D1). The discriminator every
 * rail-conditional CHECK in `schema/payments.ts` reads.
 */
export const RAIL_VALUES = ['faircoin', 'card'] as const satisfies readonly PaymentIntentRail[];
export type RailsAreComplete = AssertAllListed<
  PaymentIntentRail,
  (typeof RAIL_VALUES)[number]
>;

/**
 * The statuses only the FairCoin rail can reach, and the statuses only the card
 * rail can reach (ADR 0001 D5).
 *
 * Re-exported from the contract rather than re-listed, because a second list
 * here would be a second thing to keep in step with the transition table — and
 * the failure mode of a drift is a CHECK refusing a status the application
 * considers legal, in production, on the first payment that reaches it.
 */
export { CHAIN_ONLY_STATUSES, CARD_ONLY_STATUSES } from '@peable.to/shared-types';

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
export const REFUND_STATUSES = ['pending', 'succeeded', 'failed'] as const;

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
export const DISPUTE_STATUSES = [
  'needs_response',
  'under_review',
  'won',
  'lost',
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

/** Stripe-parity dotted webhook event types. */
export const WEBHOOK_EVENT_TYPES = [
  'payment_intent.confirming',
  'payment_intent.settled',
  'payment_intent.failed',
  'payment_intent.rejected',
  'payment_intent.expired',
  'payment_intent.refunded',
  'payment_intent.partially_refunded',
  'payment_intent.disputed',
  'payment_intent.dispute_closed',
] as const satisfies readonly WebhookEventType[];
export type WebhookEventTypesAreComplete = AssertAllListed<
  WebhookEventType,
  (typeof WEBHOOK_EVENT_TYPES)[number]
>;

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
