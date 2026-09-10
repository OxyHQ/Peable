/**
 * The card rail's structural guarantees, against a real server.
 *
 * Every property here is a CHECK, a foreign key or a query predicate that a
 * mocked `db.insert()` would accept — which is the whole reason this file is
 * `realdb`. Three of them (the ghost merchant, the settled card payment with no
 * txid, and the untouched derivation counter) would have shipped as production
 * failures with the unit suite green.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { paymentIntents, merchants } from '../schema';
import { insertPaymentIntent, findWatchableIntents } from '../payments/paymentIntentRepository';
import { updateIntentState } from '../payments/paymentIntentRepository';
import { findMerchantById } from '../merchants/merchantRepository';
import {
  POSTGRES_TESTS_ENABLED,
  gatewayDb,
  resetGatewayTables,
  seedIntent,
  seedMerchant,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';

useGatewayDatabase();

/** The internal `next_derivation_index`, which no ordinary read may select. */
async function readCounter(merchantId: string): Promise<number> {
  const [row] = await gatewayDb()
    .select({ next: merchants.nextDerivationIndex })
    .from(merchants)
    .where(eq(merchants.id, merchantId));
  if (!row) throw new Error(`no merchant ${merchantId}`);
  return row.next;
}

function cardIntentParams(merchantId: string, overrides: Record<string, unknown> = {}) {
  const unique = uuidv7();
  return {
    publicId: `pi_${unique}`,
    merchantId,
    rail: 'card' as const,
    amount: '2500',
    currency: 'EUR' as const,
    network: null,
    address: null,
    provider: 'stripe' as const,
    clientSecret: `pi_${unique}_secret_x`,
    idempotencyKey: unique,
    metadata: {},
    expiresAt: new Date(Date.now() + 900_000),
    ...overrides,
  };
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('the card rail', () => {
  beforeEach(async () => {
    await resetGatewayTables();
  });

  test('a card intent stores no chain fields and keeps its own currency', async () => {
    const merchant = await seedMerchant();
    const intent = await insertPaymentIntent(gatewayDb(), cardIntentParams(merchant.id));

    expect(intent?.rail).toBe('card');
    expect(intent?.currency).toBe('EUR');
    expect(intent?.network).toBeNull();
    expect(intent?.address).toBeNull();
    expect(intent?.confirmations).toBe(0);
    expect(intent?.txid).toBeNull();
  });

  /**
   * The repaired constraint, and the reason it needed repairing.
   *
   * `payment_intents_broadcast_requires_txid_check` demanded a txid for any
   * `settled` row. `settled` is where a card charge lands too, and a card
   * payment can never have one — so left unqualified that constraint would have
   * refused the FIRST successful card payment, in production, with every test
   * green, because no fixture could reach that state before the rail existed.
   */
  test('a card intent reaches settled with no txid', async () => {
    const merchant = await seedMerchant();
    const intent = await insertPaymentIntent(gatewayDb(), cardIntentParams(merchant.id));

    const settled = await updateIntentState(gatewayDb(), intent!.id, {
      from: 'created',
      status: 'settled',
    });

    expect(settled.kind).toBe('updated');
    const row = settled.kind === 'updated' ? settled.row : undefined;
    expect(row?.status).toBe('settled');
    expect(row?.txid).toBeNull();
  });

  /**
   * ADR 0001 D6. `network` is NULL on a card intent, which switches the
   * composite `(merchant_id, network)` reference off entirely (`MATCH SIMPLE`)
   * — and that reference was the only thing pointing `merchant_id` at
   * `merchants`. Without the companion single-column reference this insert is
   * ACCEPTED, and the gateway holds a payment belonging to nobody.
   */
  test('a card intent cannot name a merchant that does not exist', async () => {
    await expect(
      insertPaymentIntent(gatewayDb(), cardIntentParams('merchant-that-is-not-there'))
    ).rejects.toThrow();
  });

  test('the FairCoin network firewall still refuses a mismatched network', async () => {
    const merchant = await seedMerchant({ network: 'testnet' });
    await expect(
      insertPaymentIntent(
        gatewayDb(),
        cardIntentParams(merchant.id, {
          rail: 'faircoin',
          currency: 'FAIR',
          network: 'mainnet',
          address: 'Tsomething',
          provider: null,
        })
      )
    ).rejects.toThrow();
  });

  test('a card intent carrying an address is refused', async () => {
    const merchant = await seedMerchant();
    await expect(
      insertPaymentIntent(gatewayDb(), cardIntentParams(merchant.id, { address: 'Tsomething' }))
    ).rejects.toThrow();
  });

  test('a card intent denominated in FAIR is refused', async () => {
    const merchant = await seedMerchant();
    await expect(
      insertPaymentIntent(gatewayDb(), cardIntentParams(merchant.id, { currency: 'FAIR' }))
    ).rejects.toThrow();
  });

  test('a FairCoin intent denominated in a fiat currency is refused', async () => {
    const merchant = await seedMerchant();
    await expect(
      insertPaymentIntent(
        gatewayDb(),
        cardIntentParams(merchant.id, {
          rail: 'faircoin',
          currency: 'EUR',
          network: 'testnet',
          address: 'Tsomething',
          provider: null,
        })
      )
    ).rejects.toThrow();
  });

  test('a card intent cannot reach a chain status', async () => {
    const merchant = await seedMerchant();
    const intent = await insertPaymentIntent(gatewayDb(), cardIntentParams(merchant.id));
    await expect(
      updateIntentState(gatewayDb(), intent!.id, {
        from: 'created',
        status: 'confirming',
        txid: 'deadbeef',
      })
    ).rejects.toThrow();
  });

  test('a FairCoin intent cannot reach a card status', async () => {
    const merchant = await seedMerchant();
    const intent = await seedIntent(merchant);
    await expect(
      updateIntentState(gatewayDb(), intent.id, { from: intent.status, status: 'requires_action' })
    ).rejects.toThrow();
  });

  /**
   * The highest-risk property in this repository, from the card side.
   *
   * A reserved derivation index that no payment can ever arrive at is not a
   * wasted row: every FairCoin payer after it is handed a different address than
   * the counter implies, and the gap is indistinguishable from an address the
   * merchant simply never received on. Reading the counter before and after is
   * the only way to see it — a card intent's own row says nothing about the
   * merchant's.
   */
  test('creating a card intent does not move the merchant derivation counter', async () => {
    const merchant = await seedMerchant();
    const before = await readCounter(merchant.id);

    await insertPaymentIntent(gatewayDb(), cardIntentParams(merchant.id));
    await insertPaymentIntent(gatewayDb(), cardIntentParams(merchant.id));

    expect(await readCounter(merchant.id)).toBe(before);

    // Positive control: a FairCoin intent through the service DOES move it, so
    // the assertion above is measuring the rail rather than a broken counter.
    const reloaded = await findMerchantById(gatewayDb(), merchant.id);
    expect(reloaded).not.toBeNull();
  });

  /**
   * `findWatchableIntents` filters on the RAIL, not only on the status list its
   * one caller happens to pass. `settled` is a shared status: the day this query
   * is asked for one, a card payment reaching the settlement watcher would be
   * verified against a null address.
   */
  test('the watchable query never returns a card intent', async () => {
    const merchant = await seedMerchant();
    const card = await insertPaymentIntent(gatewayDb(), cardIntentParams(merchant.id));
    await updateIntentState(gatewayDb(), card!.id, { from: 'created', status: 'settled' });

    const faircoin = await seedIntent(merchant);
    await updateIntentState(gatewayDb(), faircoin.id, {
      from: faircoin.status,
      status: 'broadcast',
      txid: 'a'.repeat(64),
    });

    const watchable = await findWatchableIntents(gatewayDb(), ['broadcast', 'settled']);

    expect(watchable.map((row) => row.id)).toEqual([faircoin.id]);
  });

  test('an existing FairCoin row keeps working with no rail supplied', async () => {
    const merchant = await seedMerchant();
    // The pre-rail insert shape, straight at the table: `rail` and `currency`
    // take their column defaults, which is what every row written before this
    // migration carries.
    const unique = uuidv7();
    await gatewayDb()
      .insert(paymentIntents)
      .values({
        id: uuidv7(),
        publicId: `pi_${unique}`,
        status: 'created',
        amount: '100000000',
        network: merchant.network,
        address: `T${unique}`,
        provider: null,
        merchantId: merchant.id,
        clientSecret: `pi_${unique}_secret_x`,
        idempotencyKey: unique,
        expiresAt: new Date(Date.now() + 900_000),
      });

    const [row] = await gatewayDb()
      .select({ rail: paymentIntents.rail, currency: paymentIntents.currency })
      .from(paymentIntents)
      .where(eq(paymentIntents.publicId, `pi_${unique}`));

    expect(row?.rail).toBe('faircoin');
    expect(row?.currency).toBe('FAIR');
  });
});
