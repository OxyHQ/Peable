import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { isCheckViolation, isForeignKeyViolation, uuidv7 } from '@oxy.so/db';
import { insertMerchant, type MerchantRow } from '../merchants/merchantRepository';
import { insertPaymentIntent } from '../payments/paymentIntentRepository';
import {
  findLinkByPublicId,
  findLinkForMerchant,
  insertPaymentLink,
  listLinksForMerchant,
  updatePaymentLink,
} from '../payments/paymentLinkRepository';
import {
  findSessionByPublicId,
  findSessionForMerchant,
  insertCheckoutSession,
  listSessionsForMerchant,
} from '../payments/checkoutSessionRepository';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  dropSuiteDatabase,
  type SuiteDatabase,
} from '../testDatabase';

const XPUB =
  'DRKVrRr8WgU4mARJnCLAp77sKJ5h5K79VH8sredx2qPY8BUKogTYqoAXdTAzzvS5MgBDGGWb2Zoa2AwzoLRsbGGkBm1q2r7QSfRYWCizWfvMfPZn';

let suite: SuiteDatabase | undefined;

async function makeMerchant(): Promise<MerchantRow> {
  const unique = uuidv7();
  return (await insertMerchant(suite!.db, {
    oxyAppId: `app_${unique}`,
    environment: 'development',
    network: 'testnet',
    xpub: XPUB,
    publicId: `merch_${unique}`,
  }))!;
}

function linkParams(merchant: MerchantRow, overrides: Record<string, unknown> = {}) {
  const unique = uuidv7();
  return {
    publicId: `link_${unique}`,
    merchantId: merchant.id,
    oxyAppId: merchant.oxyAppId,
    environment: merchant.environment,
    rail: 'faircoin' as const,
    amount: '250000000',
    currency: 'FAIR' as const,
    network: merchant.network,
    metadata: {},
    ...overrides,
  };
}

async function makeIntent(merchant: MerchantRow) {
  const unique = uuidv7();
  return (await insertPaymentIntent(suite!.db, {
    publicId: `pi_${unique}`,
    merchantId: merchant.id,
    rail: 'faircoin' as const,
    amount: '250000000',
    currency: 'FAIR' as const,
    network: merchant.network,
    address: `T${unique}`,
    provider: null,
    clientSecret: `pi_${unique}_secret_x`,
    idempotencyKey: unique,
    metadata: {},
    expiresAt: new Date(Date.now() + 900_000),
  }))!;
}

function sessionParams(merchant: MerchantRow, intentId: string, overrides: Record<string, unknown> = {}) {
  const unique = uuidv7();
  return {
    publicId: `cs_${unique}`,
    merchantId: merchant.id,
    oxyAppId: merchant.oxyAppId,
    environment: merchant.environment,
    paymentIntentId: intentId,
    rail: 'faircoin' as const,
    amount: '250000000',
    currency: 'FAIR' as const,
    network: merchant.network,
    metadata: {},
    ...overrides,
  };
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('payment link and checkout session repositories', () => {
  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await dropSuiteDatabase(suite);
    suite = undefined;
  });

  it('creates a link with its merchant identity', async () => {
    const merchant = await makeMerchant();
    const link = await insertPaymentLink(suite!.db, linkParams(merchant));

    expect(link.active).toBe(true);
    expect(link.oxyAppId).toBe(merchant.oxyAppId);
    expect(link.successUrl).toBeNull();
  });

  /**
   * The denormalized identity cannot drift, because the composite reference
   * carries all four columns. A caller passing a triple that does not belong to
   * the merchant is refused by the DATABASE — not by a check the application
   * could forget, which is the whole reason the reference exists.
   */
  it('refuses a link whose claimed application does not belong to its merchant', async () => {
    const merchant = await makeMerchant();
    const stranger = await makeMerchant();

    let raised: unknown;
    try {
      await insertPaymentLink(suite!.db, linkParams(merchant, { oxyAppId: stranger.oxyAppId }));
    } catch (error) {
      raised = error;
    }
    expect(isForeignKeyViolation(raised, 'payment_links_merchant_identity_fkey')).toBe(true);
  });

  it('refuses a link whose network disagrees with its merchant', async () => {
    const merchant = await makeMerchant();
    let raised: unknown;
    try {
      await insertPaymentLink(suite!.db, linkParams(merchant, { network: 'mainnet' }));
    } catch (error) {
      raised = error;
    }
    expect(isForeignKeyViolation(raised, 'payment_links_merchant_identity_fkey')).toBe(true);
  });

  it('refuses a non-canonical link amount', async () => {
    const merchant = await makeMerchant();
    let raised: unknown;
    try {
      await insertPaymentLink(suite!.db, linkParams(merchant, { amount: '1.5' }));
    } catch (error) {
      raised = error;
    }
    expect(isCheckViolation(raised, 'payment_links_amount_check')).toBe(true);
  });

  /** The public checkout page has no session; the merchant read is scoped. Two functions, one wall. */
  it('scopes the merchant link read but not the public one', async () => {
    const owner = await makeMerchant();
    const stranger = await makeMerchant();
    const link = await insertPaymentLink(suite!.db, linkParams(owner));

    expect((await findLinkForMerchant(suite!.db, link.publicId, owner.id))?.id).toBe(link.id);
    expect(await findLinkForMerchant(suite!.db, link.publicId, stranger.id)).toBeNull();
    expect((await findLinkByPublicId(suite!.db, link.publicId))?.id).toBe(link.id);
  });

  /**
   * A patch is scoped to the owner in the SAME statement. Asserted by a
   * stranger's patch changing nothing — not merely by it returning null, which
   * a no-op update would also do if the predicate were missing but the row
   * happened not to match.
   */
  it('never lets one merchant patch another merchant\'s link', async () => {
    const owner = await makeMerchant();
    const stranger = await makeMerchant();
    const link = await insertPaymentLink(suite!.db, linkParams(owner));

    expect(await updatePaymentLink(suite!.db, link.publicId, stranger.id, { active: false })).toBeNull();
    expect((await findLinkByPublicId(suite!.db, link.publicId))?.active).toBe(true);

    const patched = await updatePaymentLink(suite!.db, link.publicId, owner.id, {
      active: false,
      successUrl: 'https://shop.example/thanks',
    });
    expect(patched?.active).toBe(false);
    expect(patched?.successUrl).toBe('https://shop.example/thanks');
    // The price is untouched: it is not in the patch type at all.
    expect(patched?.amount).toBe('250000000');
  });

  it('filters a link page by active and excludes other merchants', async () => {
    const merchant = await makeMerchant();
    const stranger = await makeMerchant();
    const live = await insertPaymentLink(suite!.db, linkParams(merchant));
    const retired = await insertPaymentLink(suite!.db, linkParams(merchant));
    await updatePaymentLink(suite!.db, retired.publicId, merchant.id, { active: false });
    await insertPaymentLink(suite!.db, linkParams(stranger));

    const page = await listLinksForMerchant(suite!.db, { merchantId: merchant.id, active: true, limit: 10 });
    expect(page.data.map((row) => row.publicId)).toEqual([live.publicId]);
    expect(page.hasMore).toBe(false);
  });

  it('creates a session around an intent', async () => {
    const merchant = await makeMerchant();
    const intent = await makeIntent(merchant);
    const session = await insertCheckoutSession(suite!.db, sessionParams(merchant, intent.id));

    expect(session?.paymentIntentId).toBe(intent.id);
    // The client secret lives on the intent and nowhere else — there is no
    // column here to copy it into.
    expect(Object.keys(session ?? {})).not.toContain('clientSecret');
  });

  /**
   * "Wraps exactly ONE payment intent" is a unique index, not a sentence. Two
   * sessions pointing at one payment is what it forbids, and nothing in the
   * current code path attempts it — which is exactly why the constraint has to
   * carry the rule rather than a comment.
   */
  it('refuses a second session around the same intent', async () => {
    const merchant = await makeMerchant();
    const intent = await makeIntent(merchant);
    expect(await insertCheckoutSession(suite!.db, sessionParams(merchant, intent.id))).not.toBeNull();
    expect(await insertCheckoutSession(suite!.db, sessionParams(merchant, intent.id))).toBeNull();
  });

  it('refuses a session pointing at an intent that does not exist', async () => {
    const merchant = await makeMerchant();
    let raised: unknown;
    try {
      await insertCheckoutSession(suite!.db, sessionParams(merchant, uuidv7()));
    } catch (error) {
      raised = error;
    }
    expect(
      isForeignKeyViolation(raised, 'checkout_sessions_payment_intent_id_payment_intents_id_fk')
    ).toBe(true);
  });

  it('scopes the merchant session read but not the public one', async () => {
    const owner = await makeMerchant();
    const stranger = await makeMerchant();
    const intent = await makeIntent(owner);
    const session = await insertCheckoutSession(suite!.db, sessionParams(owner, intent.id));

    expect((await findSessionForMerchant(suite!.db, session!.publicId, owner.id))?.id).toBe(session!.id);
    expect(await findSessionForMerchant(suite!.db, session!.publicId, stranger.id)).toBeNull();
    expect((await findSessionByPublicId(suite!.db, session!.publicId))?.id).toBe(session!.id);
  });

  it('lists only the caller\'s sessions', async () => {
    const merchant = await makeMerchant();
    const stranger = await makeMerchant();
    const mine = await insertCheckoutSession(
      suite!.db,
      sessionParams(merchant, (await makeIntent(merchant)).id)
    );
    await insertCheckoutSession(suite!.db, sessionParams(stranger, (await makeIntent(stranger)).id));

    const rows = await listSessionsForMerchant(suite!.db, merchant.id, 10);
    expect(rows.map((row) => row.publicId)).toEqual([mine!.publicId]);
  });
});
