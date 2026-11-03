/**
 * The drain routes a stored event by its OWN mode (ADR 0017).
 *
 * `provider_events.livemode` is a fact about the endpoint secret that verified
 * the delivery (`ingress.ts`). Two refusals follow from it, and both leave the
 * event visible in the drain's set rather than marking it handled:
 *
 *  - an event whose mode this deployment holds no key for — every follow-up a
 *    processor makes (a payment re-read, an account refresh) would need that
 *    key, and processing it through the other mode's would be the one thing the
 *    split exists to prevent;
 *  - an event that names an object of the OTHER mode — a live event must never
 *    move a test payment, nor the reverse.
 */
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  insertProviderEvent,
  findProviderEventById,
} from '../../db/providers/providerEventRepository';
import {
  findIntentByPublicId,
  linkProviderObject,
} from '../../db/payments/paymentIntentRepository';
import { processProviderEvent } from '../providers/eventProcessor';
import {
  gatewayDb,
  seedIntent,
  seedMerchant,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { setStripeModes, stripeModeFixture } from '../../__tests__/helpers/stripeModes';
import { POSTGRES_TESTS_ENABLED } from '../../db/testDatabase';

let counter = 0;
let restore: () => void = () => undefined;

async function storeEvent(objectId: string, livemode: boolean) {
  counter += 1;
  const id = await insertProviderEvent(gatewayDb(), {
    provider: 'stripe',
    providerEventId: `evt_modes_${String(counter)}`,
    providerAccountId: null,
    type: 'payment_intent.succeeded',
    livemode,
    apiVersion: '2026-07-29.dahlia',
    objectIds: { payment_intent: objectId },
    payload: { id: `evt_modes_${String(counter)}`, object: 'event' },
  });
  const row = id ? await findProviderEventById(gatewayDb(), id) : null;
  if (!row) throw new Error('the event was not stored');
  return row;
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('the drain routes an event by its own mode', () => {
  useGatewayDatabase();

  let testIntentPublicId = '';

  beforeAll(async () => {
    // A development merchant: its payments are TEST objects.
    const merchant = await seedMerchant({ environment: 'development' });
    const intent = await seedIntent(merchant, { rail: 'card', currency: 'EUR', amount: '2500' });
    await linkProviderObject(gatewayDb(), intent.id, 'stripe', 'pi_stripe_modes_test');
    testIntentPublicId = intent.publicId;
  });

  afterEach(() => {
    restore();
  });

  it('refuses an event whose mode holds no key, and leaves it to finish later', async () => {
    restore = setStripeModes({ test: stripeModeFixture('test', { cardRail: false }) });
    const event = await storeEvent('pi_stripe_modes_test', true);

    const outcome = await processProviderEvent(event);
    expect(outcome.kind).toBe('failed');
    const stored = await findProviderEventById(gatewayDb(), event.id);
    expect(stored?.processedAt).toBeNull();
    expect(stored?.processingError).toContain('no live stripe key');
    expect((await findIntentByPublicId(gatewayDb(), testIntentPublicId))?.status).toBe(
      'requires_payment_method',
    );
  });

  it('refuses a live event that names a TEST payment', async () => {
    restore = setStripeModes({
      test: stripeModeFixture('test', { cardRail: false }),
      live: stripeModeFixture('live', { cardRail: false }),
    });
    const event = await storeEvent('pi_stripe_modes_test', true);

    const outcome = await processProviderEvent(event);
    expect(outcome).toEqual({
      kind: 'failed',
      error: 'a live event names a test object',
    });
    expect((await findIntentByPublicId(gatewayDb(), testIntentPublicId))?.status).toBe(
      'requires_payment_method',
    );
  });

  it('applies an event of the payment’s own mode', async () => {
    restore = setStripeModes({ test: stripeModeFixture('test', { cardRail: false }) });
    const event = await storeEvent('pi_stripe_modes_test', false);

    const outcome = await processProviderEvent(event);
    expect(outcome.kind).toBe('applied');
    expect((await findIntentByPublicId(gatewayDb(), testIntentPublicId))?.status).toBe('succeeded');
  });
});
