import { afterAll, beforeAll } from 'bun:test';
import { getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { deriveKeyFromSeed, getNetwork, mnemonicToSeed } from '@fairco.in/core';
import type { NetworkType } from '@fairco.in/core';
import type { OxyServiceEnvironment } from '@oxyhq/core/server';
import { uuidv7 } from '@oxyhq/db';
import type { ProviderId } from '../../services/providers/provider';
import type {
  CurrencyCode,
  PaymentIntent,
  PaymentIntentRail,
  WebhookEventPayload,
  WebhookEventType,
} from '@peable.to/shared-types';
import { insertMerchant, type MerchantRow } from '../../db/merchants/merchantRepository';
import {
  insertCheckoutSession,
  type CheckoutSessionRow,
} from '../../db/payments/checkoutSessionRepository';
import {
  insertPaymentIntent,
  type PaymentIntentRow,
} from '../../db/payments/paymentIntentRepository';
import { insertPaymentLink, type PaymentLinkRow } from '../../db/payments/paymentLinkRepository';
import { insertSendAttribution } from '../../db/social/sendAttribution';
import type { SocialSendAttributionRow } from '../../db/social/sendAttribution';
import {
  findDeliveryForMerchant,
  type WebhookDeliveryRow,
} from '../../db/webhooks/webhookDeliveryRepository';
import {
  enqueueWebhook,
  recordDeliveryAttempt,
} from '../../db/webhooks/webhookOutboxRepository';
import { toPaymentIntentDTO } from '../../lib/serialize';
import * as schema from '../../db/schema';
import type { Database } from '../../db/postgres';
import {
  createSuiteDatabase,
  dropSuiteDatabase,
  POSTGRES_TESTS_ENABLED,
  type SuiteDatabase,
} from '../../db/testDatabase';

/**
 * The gateway suites' database, and the seeds they build state with.
 *
 * ## Why this exists
 *
 * Before this, twenty test files each created their own `MongoMemoryServer` and
 * each carried the same three-line create/connect/stop dance. Nineteen copies of
 * a setup block is how one of them quietly stops tearing down — or, once the
 * store changes, stops getting a fresh database — and nothing fails loudly when
 * it does.
 *
 * ## Why the seed signatures look like `Model.create(...)`
 *
 * Deliberately. Each `seedX({...})` takes the same object shape the Mongoose
 * call it replaces took, with every required field defaulted, so the switch is
 * ONE uniform textual transformation across twenty files rather than twenty
 * bespoke rewrites. A reviewer scanning them can check "every one of these is
 * the same change", and a suite that is NOT that change stands out — which is
 * the property that makes a large diff reviewable at all.
 *
 * This file references no production code path and no route. It is test
 * infrastructure only: nothing in `src/` outside `__tests__` imports it.
 */

/** The canonical all-"abandon" + "art" test mnemonic. */
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

const xpubCache = new Map<NetworkType, string>();

/**
 * A watch-only account xpub for `network`, derived rather than pasted.
 *
 * **An xpub is network-specific and the firewall enforces it.** A testnet xpub
 * handed to a mainnet merchant fails `deriveIntentAddress` with `Version
 * mismatch` — the extended key's version bytes disagree with the network — so
 * `assertWatchOnly` refuses it, correctly. A single hard-coded testnet constant
 * would therefore make every mainnet suite fail inside `seedMerchant`, with an
 * error naming the non-custody firewall rather than the fixture.
 *
 * Measured: that is exactly what happened the first time this harness ran, which
 * is the argument for testing a harness before twenty suites depend on it.
 */
export function testXpubFor(network: NetworkType): string {
  const cached = xpubCache.get(network);
  if (cached) return cached;

  const config = getNetwork(network);
  const root = deriveKeyFromSeed(mnemonicToSeed(TEST_MNEMONIC), config);
  const account = root.derive(`m/44'/${config.bip44CoinType}'/0'`);
  const xpub = account.hdKey.publicExtendedKey;
  xpubCache.set(network, xpub);
  return xpub;
}

/** The testnet vector, kept as a named export for suites that assert on it directly. */
export const TEST_XPUB = testXpubFor('testnet');

/** Re-exported so a suite can gate itself without importing two modules. */
export { POSTGRES_TESTS_ENABLED };

let suite: SuiteDatabase | undefined;

/**
 * The suite's live handle.
 *
 * A function rather than an exported binding, because the database does not
 * exist until `beforeAll` has run — an exported `db` would be `undefined` at
 * module scope and would capture that value in any helper closing over it.
 */
export function gatewayDb(): Database {
  if (!suite) {
    throw new Error(
      'gatewayDb() called before the database was created — did the suite call useGatewayDatabase() at top level?'
    );
  }
  return suite.db;
}

/**
 * Register the per-suite database lifecycle. Call once, at a test file's top
 * level, and it replaces the whole `MongoMemoryServer` block.
 *
 * Registration happens while the file is being evaluated, which is what lets a
 * helper own `beforeAll`/`afterAll` on the caller's behalf.
 */
export function useGatewayDatabase(): void {
  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await dropSuiteDatabase(suite);
    suite = undefined;
  });
}

/**
 * Every table this application owns, DERIVED from the schema barrel rather than
 * listed.
 *
 * This used to be a hand-written list with a comment saying a new table "has to
 * be added here on purpose". It did not: `disputes` was added and nothing said
 * so. Postgres caught that one only because `disputes` carries a foreign key
 * into `payment_intents`, so truncating the referenced table without it is an
 * error — a new table with NO foreign key into the list would instead have kept
 * its rows across every reset, and the first symptom would have been a suite
 * failing on state a different case left behind.
 *
 * The barrel is the right source because it is the SAME module drizzle-kit
 * generates DDL from, so a table that exists in the database and not here is a
 * table no migration in this repo created.
 */
const OWNED_TABLES: readonly string[] = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableName(table));

/**
 * Empty every table, for a suite that used to call `Model.deleteMany({})`
 * between cases.
 *
 * ONE statement, not one per table: `truncate a, b, c` satisfies the foreign
 * key check by emptying referencing and referenced tables together, which is
 * why no dependency ordering is needed and why `cascade` — which would reach
 * outside the set — is not used.
 */
export async function resetGatewayTables(): Promise<void> {
  if (OWNED_TABLES.length === 0) {
    throw new Error(
      'resetGatewayTables: the schema barrel exported no tables, so a reset would silently empty nothing'
    );
  }
  await gatewayDb().execute(
    sql`truncate ${sql.join(
      OWNED_TABLES.map((name) => sql.identifier(name)),
      sql`, `
    )} restart identity`
  );
}

/** Values a seed accepts, matching the `Model.create(...)` object it replaces. */
export interface SeedMerchantValues {
  readonly publicId?: string;
  readonly oxyAppId?: string;
  readonly environment?: OxyServiceEnvironment;
  readonly network?: NetworkType;
  readonly xpub?: string;
  readonly webhookUrl?: string;
  readonly webhookSecret?: string;
  readonly requiredConfirmations?: number;
}

/**
 * A merchant. Every field is defaulted, so a caller supplies only what its
 * assertions actually depend on.
 *
 * Goes through `insertMerchant`, NOT a raw insert — which means the non-custody
 * firewall runs on every seeded merchant. A suite that seeds a private extended
 * key is refused here exactly as production would refuse it.
 */
export async function seedMerchant(values: SeedMerchantValues = {}): Promise<MerchantRow> {
  const unique = uuidv7();
  const network = values.network ?? 'testnet';
  const row = await insertMerchant(gatewayDb(), {
    publicId: values.publicId ?? `merch_${unique}`,
    oxyAppId: values.oxyAppId ?? `app_${unique}`,
    environment: values.environment ?? 'development',
    network,
    // Follows the NETWORK, never a fixed constant — see `testXpubFor`.
    xpub: values.xpub ?? testXpubFor(network),
    webhookUrl: values.webhookUrl,
    webhookSecret: values.webhookSecret,
    requiredConfirmations: values.requiredConfirmations,
  });
  if (!row) {
    throw new Error(
      `seedMerchant: a merchant already exists for (${values.oxyAppId ?? '<generated>'}, ${values.environment ?? 'development'})`
    );
  }
  return row;
}

export interface SeedIntentValues {
  readonly publicId?: string;
  readonly rail?: PaymentIntentRail;
  readonly amount?: string;
  readonly currency?: CurrencyCode;
  readonly network?: NetworkType | null;
  readonly address?: string | null;
  readonly provider?: ProviderId | null;
  readonly clientSecret?: string;
  readonly idempotencyKey?: string;
  readonly metadata?: Record<string, string>;
  readonly expiresAt?: Date;
}

/** Default intent lifetime, matching `createIntent`'s own 15 minutes. */
const DEFAULT_EXPIRY_MS = 15 * 60 * 1000;

export async function seedIntent(
  merchant: MerchantRow,
  values: SeedIntentValues = {}
): Promise<PaymentIntentRow> {
  const unique = uuidv7();
  // The rail decides whether the chain fields mean anything, so it is resolved
  // FIRST and the two chain defaults follow from it. Defaulting them
  // independently would seed a card intent carrying an address, which
  // `payment_intents_card_has_no_chain_fields_check` refuses — a fixture that
  // fails on a constraint instead of on its subject.
  const rail = values.rail ?? 'faircoin';
  const row = await insertPaymentIntent(gatewayDb(), {
    publicId: values.publicId ?? `pi_${unique}`,
    merchantId: merchant.id,
    rail,
    amount: values.amount ?? '100000000',
    currency: values.currency ?? (rail === 'faircoin' ? 'FAIR' : 'EUR'),
    // Defaults to the MERCHANT's network, never a literal: the composite
    // reference refuses a mismatch, so a hard-coded default here would make
    // every mainnet-merchant suite fail on a foreign key instead of its subject.
    network: values.network !== undefined ? values.network : rail === 'faircoin' ? merchant.network : null,
    address: values.address !== undefined ? values.address : rail === 'faircoin' ? `T${unique}` : null,
    // Follows the rail for the same reason the chain fields do:
    // `payment_intents_card_requires_provider_check` refuses a card intent with
    // no provider, and `..._faircoin_has_no_provider_check` refuses a chain one
    // that has one.
    provider: values.provider !== undefined ? values.provider : rail === 'card' ? 'stripe' : null,
    clientSecret: values.clientSecret ?? `pi_${unique}_secret_${unique.slice(0, 8)}`,
    idempotencyKey: values.idempotencyKey ?? unique,
    metadata: values.metadata ?? {},
    expiresAt: values.expiresAt ?? new Date(Date.now() + DEFAULT_EXPIRY_MS),
  });
  if (!row) {
    throw new Error(`seedIntent: idempotency key ${values.idempotencyKey ?? unique} already used`);
  }
  return row;
}

export interface SeedLinkValues {
  readonly publicId?: string;
  readonly rail?: PaymentIntentRail;
  readonly amount?: string;
  readonly currency?: CurrencyCode;
  readonly network?: NetworkType | null;
  readonly metadata?: Record<string, string>;
  readonly successUrl?: string;
}

export async function seedLink(
  merchant: MerchantRow,
  values: SeedLinkValues = {}
): Promise<PaymentLinkRow> {
  const unique = uuidv7();
  const rail = values.rail ?? 'faircoin';
  return insertPaymentLink(gatewayDb(), {
    publicId: values.publicId ?? `link_${unique}`,
    merchantId: merchant.id,
    // The identity triple comes from the merchant, never from a literal — the
    // composite reference refuses any other combination.
    oxyAppId: merchant.oxyAppId,
    environment: merchant.environment,
    rail,
    amount: values.amount ?? '100000000',
    currency: values.currency ?? (rail === 'faircoin' ? 'FAIR' : 'EUR'),
    network:
      values.network !== undefined ? values.network : rail === 'faircoin' ? merchant.network : null,
    metadata: values.metadata ?? {},
    successUrl: values.successUrl,
  });
}

export interface SeedSessionValues {
  readonly publicId?: string;
  readonly amount?: string;
  readonly metadata?: Record<string, string>;
  readonly successUrl?: string;
  readonly cancelUrl?: string;
}

export async function seedSession(
  merchant: MerchantRow,
  intent: PaymentIntentRow,
  values: SeedSessionValues = {}
): Promise<CheckoutSessionRow> {
  const unique = uuidv7();
  const row = await insertCheckoutSession(gatewayDb(), {
    publicId: values.publicId ?? `cs_${unique}`,
    merchantId: merchant.id,
    oxyAppId: merchant.oxyAppId,
    environment: merchant.environment,
    paymentIntentId: intent.id,
    amount: values.amount ?? intent.amount,
    // Denormalized from the WRAPPED INTENT, never chosen here: a session whose
    // rail disagreed with its intent's would render a card form over a FairCoin
    // payment, and no constraint spans the two tables to catch it.
    currency: intent.currency,
    rail: intent.rail,
    network: intent.network,
    metadata: values.metadata ?? {},
    successUrl: values.successUrl,
    cancelUrl: values.cancelUrl,
  });
  if (!row) {
    throw new Error(`seedSession: intent ${intent.publicId} is already wrapped by a session`);
  }
  return row;
}

/**
 * The event types that carry a PaymentIntent — DERIVED from the contract's own
 * `WebhookEventPayload`, not listed.
 *
 * `seedDelivery` takes an intent, so it can only seed an event that carries
 * one. Before `WebhookEventPayload` existed this parameter was the whole
 * `WebhookEventType`, and seeding `payment_intent.disputed` here would have
 * built an envelope whose `data.object` was a settlement — a fixture that
 * disagrees with production while looking exactly like it.
 */
type IntentWebhookEventType = {
  [K in WebhookEventType]: WebhookEventPayload[K] extends PaymentIntent ? K : never;
}[WebhookEventType];

export interface SeedDeliveryValues {
  readonly eventId?: string;
  readonly eventType?: IntentWebhookEventType;
  readonly url?: string;
  /**
   * Leave a seeded delivery `pending` instead of settling it.
   *
   * The default is a DELIVERED row, because most suites want a delivery that
   * already happened and must not have the outbox dispatcher pick their fixture
   * up mid-test. A suite exercising the queue asks for `pending: true`.
   */
  readonly pending?: boolean;
}

/**
 * Seed a delivery.
 *
 * Two writes, not one, and that is the outbox's shape rather than an
 * inefficiency: `enqueueWebhook` is the only way a row is created, and
 * `recordDeliveryAttempt` is the only way one reaches a terminal status. A
 * helper that inserted a delivered row directly would be a second writer with
 * no attempt behind it — exactly the shape `insertWebhookDelivery` had, and the
 * reason it is gone.
 */
export async function seedDelivery(
  merchant: MerchantRow,
  intent: PaymentIntentRow,
  values: SeedDeliveryValues = {}
): Promise<WebhookDeliveryRow> {
  const url = values.url ?? merchant.webhookUrl ?? 'https://merchant.example/hook';
  const eventType = values.eventType ?? 'payment_intent.settled';
  const eventId = values.eventId ?? `evt_${uuidv7()}`;

  const id = await enqueueWebhook(gatewayDb(), {
    merchantId: merchant.id,
    paymentIntentId: intent.id,
    event: {
      id: eventId,
      object: 'event',
      type: eventType,
      created: new Date().toISOString(),
      data: { object: toPaymentIntentDTO(intent) },
    },
    url,
  });

  if (values.pending !== true) {
    await recordDeliveryAttempt(gatewayDb(), {
      id,
      outcome: { kind: 'delivered' },
      url,
      nextAttemptAt: null,
    });
  }

  const row = await findDeliveryForMerchant(gatewayDb(), id, merchant.id);
  if (!row) throw new Error(`seedDelivery: delivery ${id} vanished after enqueue`);
  return row;
}

export interface SeedAttributionValues {
  readonly address?: string;
  readonly network?: NetworkType;
  readonly senderUserId?: string;
  readonly recipientUserId?: string;
  readonly derivationIndex?: number;
}

export async function seedAttribution(
  values: SeedAttributionValues = {}
): Promise<SocialSendAttributionRow> {
  const unique = uuidv7();
  const row = await insertSendAttribution(gatewayDb(), {
    address: values.address ?? `T${unique}`,
    network: values.network ?? 'testnet',
    senderUserId: values.senderUserId ?? `user_${unique}`,
    recipientUserId: values.recipientUserId ?? `user_r_${unique}`,
    // 1, never 0: index 0 is the recipient's on-device default address and the
    // CHECK refuses it, so a zero default would make every seed fail.
    derivationIndex: values.derivationIndex ?? 1,
  });
  if (!row) {
    throw new Error(`seedAttribution: address ${values.address ?? unique} is already attributed`);
  }
  return row;
}
