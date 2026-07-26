import { afterAll, beforeAll } from 'bun:test';
import { getTableName, is, sql, Table } from 'drizzle-orm';
import * as schema from '../../db/schema';
import { deriveKeyFromSeed, getNetwork, mnemonicToSeed } from '@fairco.in/core';
import type { NetworkType } from '@fairco.in/core';
import type { OxyServiceEnvironment } from '@oxyhq/core/server';
import { uuidv7 } from '@oxyhq/db';
import type { WebhookEventType } from '@peable.to/shared-types';
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
  insertWebhookDelivery,
  type WebhookDeliveryRow,
} from '../../db/webhooks/webhookDeliveryRepository';
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
 * Empty every table, for a suite that used to call `Model.deleteMany({})`
 * between cases.
 *
 * One statement in dependency order rather than seven — `truncate ... cascade`
 * would also reach tables a future migration adds and silently empty them, so
 * the list is explicit and a new table has to be added here on purpose.
 */
export async function resetGatewayTables(): Promise<void> {
  await gatewayDb().execute(sql.raw(`truncate ${gatewayTableNames()} restart identity`));
}

/**
 * Every table in the schema, comma-joined, for the truncate above.
 *
 * Derived from `db/schema`'s barrel rather than written out. The list used to
 * be literal, and a table added without editing it was silently NOT truncated —
 * state leaked into the next test in the file and the failure surfaced as a
 * wrong assertion somewhere unrelated. A hand-maintained list that nothing
 * checks reports the same thing whether or not it is complete, which makes it
 * no check at all.
 *
 * `truncate` takes them in one statement so it does not matter that they
 * reference each other; `restart identity` is kept for the same reason it was
 * there before.
 */
function gatewayTableNames(): string {
  const tables = Object.values(schema).filter((value) => is(value, Table));
  if (tables.length === 0) {
    throw new Error('resetGatewayTables: no tables found in db/schema');
  }
  return tables.map((table) => `"${getTableName(table)}"`).join(', ');
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
  readonly amount?: string;
  readonly network?: NetworkType;
  readonly address?: string;
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
  const row = await insertPaymentIntent(gatewayDb(), {
    publicId: values.publicId ?? `pi_${unique}`,
    merchantId: merchant.id,
    amount: values.amount ?? '100000000',
    // Defaults to the MERCHANT's network, never a literal: the composite
    // reference refuses a mismatch, so a hard-coded default here would make
    // every mainnet-merchant suite fail on a foreign key instead of its subject.
    network: values.network ?? merchant.network,
    address: values.address ?? `T${unique}`,
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
  readonly amount?: string;
  readonly network?: NetworkType;
  readonly metadata?: Record<string, string>;
  readonly successUrl?: string;
}

export async function seedLink(
  merchant: MerchantRow,
  values: SeedLinkValues = {}
): Promise<PaymentLinkRow> {
  const unique = uuidv7();
  return insertPaymentLink(gatewayDb(), {
    publicId: values.publicId ?? `link_${unique}`,
    merchantId: merchant.id,
    // The identity triple comes from the merchant, never from a literal — the
    // composite reference refuses any other combination.
    oxyAppId: merchant.oxyAppId,
    environment: merchant.environment,
    amount: values.amount ?? '100000000',
    network: values.network ?? merchant.network,
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
    network: merchant.network,
    metadata: values.metadata ?? {},
    successUrl: values.successUrl,
    cancelUrl: values.cancelUrl,
  });
  if (!row) {
    throw new Error(`seedSession: intent ${intent.publicId} is already wrapped by a session`);
  }
  return row;
}

export interface SeedDeliveryValues {
  readonly eventId?: string;
  readonly eventType?: WebhookEventType;
  readonly url?: string;
  readonly attempts?: number;
  readonly delivered?: boolean;
}

export async function seedDelivery(
  merchant: MerchantRow,
  intent: PaymentIntentRow,
  values: SeedDeliveryValues = {}
): Promise<WebhookDeliveryRow> {
  return insertWebhookDelivery(gatewayDb(), {
    merchantId: merchant.id,
    paymentIntentId: intent.id,
    eventId: values.eventId ?? `evt_${uuidv7()}`,
    eventType: values.eventType ?? 'payment_intent.settled',
    url: values.url ?? merchant.webhookUrl ?? 'https://merchant.example/hook',
    attempts: values.attempts ?? 1,
    delivered: values.delivered ?? true,
  });
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
