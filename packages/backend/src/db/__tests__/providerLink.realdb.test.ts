/**
 * The provider link on `payment_intents`, against a real server.
 *
 * The invariant being defended is narrow and expensive: a provider event names
 * an object, the drain turns that into a state change on the intent that owns
 * it, and if two intents could name one object a single
 * `payment_intent.succeeded` would settle a payment that was never charged.
 * None of that is visible to a mocked insert.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxy.so/db';
import { paymentIntents } from '../schema';
import {
  findIntentByProviderObject,
  insertPaymentIntent,
  linkProviderObject,
  type InsertPaymentIntentParams,
} from '../payments/paymentIntentRepository';
import { insertMerchant, type MerchantRow } from '../merchants/merchantRepository';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  dropSuiteDatabase,
  type SuiteDatabase,
} from '../testDatabase';
import { testXpubFor } from '../../__tests__/helpers/gatewayTestDatabase';

let suite: SuiteDatabase | undefined;
let merchant: MerchantRow;

function cardIntent(overrides: Partial<InsertPaymentIntentParams> = {}): InsertPaymentIntentParams {
  const unique = uuidv7();
  return {
    publicId: `pi_${unique}`,
    merchantId: merchant.id,
    rail: 'card',
    amount: '2500',
    currency: 'EUR',
    network: null,
    address: null,
    provider: 'stripe',
    clientSecret: `pi_${unique}_secret_x`,
    idempotencyKey: unique,
    metadata: {},
    expiresAt: new Date(Date.now() + 900_000),
    ...overrides,
  };
}

function faircoinIntent(
  overrides: Partial<InsertPaymentIntentParams> = {}
): InsertPaymentIntentParams {
  const unique = uuidv7();
  return {
    publicId: `pi_${unique}`,
    merchantId: merchant.id,
    rail: 'faircoin',
    amount: '100000000',
    currency: 'FAIR',
    network: merchant.network,
    address: `T${unique}`,
    provider: null,
    clientSecret: `pi_${unique}_secret_x`,
    idempotencyKey: unique,
    metadata: {},
    expiresAt: new Date(Date.now() + 900_000),
    ...overrides,
  };
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('the provider link on payment_intents', () => {
  beforeAll(async () => {
    suite = await createSuiteDatabase();
    const seeded = await insertMerchant(suite.db, {
      publicId: `merch_${uuidv7()}`,
      oxyAppId: `app_${uuidv7()}`,
      environment: 'development',
      network: 'testnet',
      xpub: testXpubFor('testnet'),
    });
    if (!seeded) throw new Error('could not seed the merchant');
    merchant = seeded;
  });

  afterAll(async () => {
    await dropSuiteDatabase(suite);
    suite = undefined;
  });

  it('mints a card intent unlinked, then links it once', async () => {
    const intent = await insertPaymentIntent(suite!.db, cardIntent());
    // The window the two-step create depends on: the row exists, the provider
    // object does not yet.
    expect(intent?.provider).toBe('stripe');
    expect(intent?.providerObjectId).toBeNull();

    const linked = await linkProviderObject(suite!.db, intent!.id, 'stripe', 'pi_stripe_a');
    expect(linked).toBe(true);

    const found = await findIntentByProviderObject(suite!.db, 'stripe', 'pi_stripe_a');
    expect(found?.id).toBe(intent!.id);
  });

  /**
   * A link is filled, never repointed.
   *
   * A second provider call for an intent that already has an object is a bug —
   * a duplicate charge, or a recovery that raced — and silently moving the row
   * to the new object would orphan the first charge with nothing anywhere
   * recording that it exists.
   */
  it('refuses to repoint an intent that is already linked, and says so', async () => {
    const intent = await insertPaymentIntent(suite!.db, cardIntent());
    expect(await linkProviderObject(suite!.db, intent!.id, 'stripe', 'pi_stripe_b')).toBe(true);
    expect(await linkProviderObject(suite!.db, intent!.id, 'stripe', 'pi_stripe_c')).toBe(false);

    // The FIRST object still owns the row.
    const found = await findIntentByProviderObject(suite!.db, 'stripe', 'pi_stripe_b');
    expect(found?.id).toBe(intent!.id);
    expect(await findIntentByProviderObject(suite!.db, 'stripe', 'pi_stripe_c')).toBeNull();
  });

  /**
   * Concurrent recovery. Two workers finishing the same interrupted create both
   * get the same object back from Stripe (the idempotency key is derived from
   * the intent's public id) and both try to link it. Exactly one may win, or
   * the second would silently believe it did the linking.
   */
  it('lets exactly one of two concurrent links win', async () => {
    const intent = await insertPaymentIntent(suite!.db, cardIntent());
    const results = await Promise.all([
      linkProviderObject(suite!.db, intent!.id, 'stripe', 'pi_stripe_race'),
      linkProviderObject(suite!.db, intent!.id, 'stripe', 'pi_stripe_race'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  /**
   * THE reason the index is UNIQUE. Two intents naming one Stripe object would
   * make a single `payment_intent.succeeded` ambiguous, and the drain would
   * settle whichever it happened to read.
   */
  it('refuses to let a second intent claim the same provider object', async () => {
    const first = await insertPaymentIntent(suite!.db, cardIntent());
    const second = await insertPaymentIntent(suite!.db, cardIntent());
    await linkProviderObject(suite!.db, first!.id, 'stripe', 'pi_stripe_shared');

    let raised: unknown;
    try {
      await suite!.db
        .update(paymentIntents)
        .set({ providerObjectId: 'pi_stripe_shared' })
        .where(eq(paymentIntents.id, second!.id));
    } catch (error) {
      raised = error;
    }
    expect(isUniqueViolation(raised, 'payment_intents_provider_object_key')).toBe(true);
  });

  /** ...while any number of card intents may sit UNLINKED at the same time. */
  it('lets many unlinked card intents coexist', async () => {
    const minted = await Promise.all([
      insertPaymentIntent(suite!.db, cardIntent()),
      insertPaymentIntent(suite!.db, cardIntent()),
      insertPaymentIntent(suite!.db, cardIntent()),
    ]);
    expect(minted.every((row) => row !== null)).toBe(true);
  });

  it('refuses a card intent with no provider', async () => {
    let raised: unknown;
    try {
      await insertPaymentIntent(suite!.db, cardIntent({ provider: null }));
    } catch (error) {
      raised = error;
    }
    expect(isCheckViolation(raised, 'payment_intents_card_requires_provider_check')).toBe(true);
  });

  /**
   * The dangerous direction. A faircoin intent carrying a provider would be
   * reachable by the event drain's lookup, so a Stripe event could transition a
   * payment whose money is on a blockchain.
   */
  it('refuses a faircoin intent that names a provider', async () => {
    let raised: unknown;
    try {
      await insertPaymentIntent(suite!.db, faircoinIntent({ provider: 'stripe' }));
    } catch (error) {
      raised = error;
    }
    expect(isCheckViolation(raised, 'payment_intents_faircoin_has_no_provider_check')).toBe(true);
  });

  /**
   * NOT tested here, and worth saying why: that the lookup is scoped BY provider
   * cannot be exercised while `PROVIDER_IDS` has one member. The scoping is real
   * (`findIntentByProviderObject` takes the provider, and the unique index is on
   * the pair), and the case that would prove it becomes writable the day a
   * second provider is added — which is also the day it starts to matter.
   */
});
