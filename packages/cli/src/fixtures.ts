import type { Peable, WebhookEventType } from '@peable.to/sdk';

/**
 * `peable trigger <event>`: real test-mode objects, created through the public
 * API, whose changes RECORD the event — never a synthetic event. Each fixture
 * names every event it causes, so `peable trigger payment_intent.succeeded`
 * also shows a developer the `created` and `processing` that come before it.
 *
 * A FairCoin fixture makes a testnet payment and finishes it with the test
 * helper `simulate_faircoin_payment`, which drives the real state machine
 * without touching the chain. A Terminal fixture collects a `card_present`
 * payment on a simulated reader and taps it with `present_payment_method`. Events not listed here (refunds, disputes,
 * charges, setup intents) need a card payment confirmed at the provider and
 * cannot be caused from the API alone.
 */

export interface FixtureContext {
  readonly peable: Peable;
  /** One line describing a request the fixture made. */
  readonly log: (line: string) => void;
}

export interface Fixture {
  /** What the fixture does, in a phrase. */
  readonly description: string;
  /** Every event it causes, in order. */
  readonly causes: readonly WebhookEventType[];
  run(context: FixtureContext): Promise<void>;
}

/** 1 FAIR, in base units. */
const TEST_AMOUNT = '100000000';
const METADATA = { created_by: 'peable trigger' };

async function testnetIntent({ peable, log }: FixtureContext) {
  const intent = await peable.paymentIntents.create({
    amount: TEST_AMOUNT,
    network: 'testnet',
    metadata: METADATA,
  });
  log(`POST /v1/payment_intents → ${intent.id} (${intent.status})`);
  return intent;
}

async function simulated(context: FixtureContext, outcome: 'settled' | 'underpaid') {
  const intent = await testnetIntent(context);
  const after = await context.peable.testHelpers.paymentIntents.simulateFaircoinPayment(intent.id, {
    outcome,
  });
  context.log(
    `POST /v1/test_helpers/payment_intents/${intent.id}/simulate_faircoin_payment → ${after.status}`,
  );
}

async function testProduct({ peable, log }: FixtureContext) {
  const product = await peable.products.create({
    name: 'Peable CLI test product',
    metadata: METADATA,
  });
  log(`POST /v1/products → ${product.id}`);
  return product;
}

async function testCustomer({ peable, log }: FixtureContext) {
  const customer = await peable.customers.create({
    name: 'Peable CLI test customer',
    email: 'test-customer@example.com',
    metadata: METADATA,
  });
  log(`POST /v1/customers → ${customer.id}`);
  return customer;
}

/**
 * A simulated reader to collect on: one this command registered before, or a
 * new location and reader (Terminal must be enabled in test mode).
 */
async function simulatedReader({ peable, log }: FixtureContext) {
  const readers = await peable.terminal.readers.list({ limit: 100 });
  const known = readers.data.find(
    (reader) =>
      reader.metadata.created_by === METADATA.created_by && reader.action?.status !== 'in_progress',
  );
  if (known) return known;
  const location = await peable.terminal.locations.create({
    display_name: 'Peable CLI test location',
    address: {
      line1: '1272 Valencia Street',
      city: 'San Francisco',
      state: 'CA',
      postal_code: '94110',
      country: 'US',
    },
    metadata: METADATA,
  });
  log(`POST /v1/terminal/locations → ${location.id}`);
  const reader = await peable.terminal.readers.create({
    registration_code: 'simulated-wpe',
    location: location.id,
    label: 'Peable CLI test reader',
    metadata: METADATA,
  });
  log(`POST /v1/terminal/readers → ${reader.id}`);
  return reader;
}

/**
 * A card_present payment collected on a simulated reader, the card tapped by
 * the test helper. The provider's test amounts decide: `…05` is declined.
 */
async function tapped(context: FixtureContext, amount: string) {
  const reader = await simulatedReader(context);
  const intent = await context.peable.paymentIntents.create({
    amount,
    currency: 'USD',
    rail: 'card',
    payment_method_types: ['card_present'],
    metadata: METADATA,
  });
  context.log(`POST /v1/payment_intents → ${intent.id} (card_present)`);
  await context.peable.terminal.readers.processPaymentIntent(reader.id, {
    payment_intent: intent.id,
  });
  context.log(`POST /v1/terminal/readers/${reader.id}/process_payment_intent`);
  const after = await context.peable.testHelpers.terminal.readers.presentPaymentMethod(reader.id);
  context.log(
    `POST /v1/test_helpers/terminal/readers/${reader.id}/present_payment_method → ${after.action?.status ?? 'no action'}`,
  );
}

const settledPayment: Fixture = {
  description: 'a FairCoin testnet payment, paid and confirmed by the test helper',
  causes: ['payment_intent.created', 'payment_intent.processing', 'payment_intent.succeeded'],
  run: (context) => simulated(context, 'settled'),
};

export const FIXTURES = {
  'payment_intent.created': {
    description: 'a FairCoin testnet payment intent',
    causes: ['payment_intent.created'],
    run: async (context) => {
      await testnetIntent(context);
    },
  },
  'payment_intent.processing': settledPayment,
  'payment_intent.succeeded': settledPayment,
  'payment_intent.payment_failed': {
    description: 'a FairCoin testnet payment the test helper underpays',
    causes: [
      'payment_intent.created',
      'payment_intent.processing',
      'payment_intent.payment_failed',
      'payment_intent.canceled',
    ],
    run: (context) => simulated(context, 'underpaid'),
  },
  'payment_intent.canceled': {
    description: 'a FairCoin testnet payment intent, then cancelled',
    causes: ['payment_intent.created', 'payment_intent.canceled'],
    run: async (context) => {
      const intent = await testnetIntent(context);
      const canceled = await context.peable.paymentIntents.cancel(intent.id, {
        cancellation_reason: 'requested_by_customer',
      });
      context.log(`POST /v1/payment_intents/${intent.id}/cancel → ${canceled.status}`);
    },
  },
  'terminal.reader.action_succeeded': {
    description: 'a card_present payment collected on a simulated reader',
    causes: [
      'payment_intent.created',
      'terminal.reader.action_succeeded',
      'payment_intent.succeeded',
    ],
    run: (context) => tapped(context, '1000'),
  },
  'terminal.reader.action_failed': {
    description: 'a card_present payment declined on a simulated reader',
    causes: [
      'payment_intent.created',
      'terminal.reader.action_failed',
      'payment_intent.payment_failed',
    ],
    run: (context) => tapped(context, '1005'),
  },
  'customer.created': {
    description: 'a customer',
    causes: ['customer.created'],
    run: async (context) => {
      await testCustomer(context);
    },
  },
  'customer.updated': {
    description: 'a customer, then updated',
    causes: ['customer.created', 'customer.updated'],
    run: async (context) => {
      const customer = await testCustomer(context);
      await context.peable.customers.update(customer.id, {
        description: 'updated by peable trigger',
      });
      context.log(`POST /v1/customers/${customer.id}`);
    },
  },
  'customer.deleted': {
    description: 'a customer, then deleted',
    causes: ['customer.created', 'customer.deleted'],
    run: async (context) => {
      const customer = await testCustomer(context);
      await context.peable.customers.del(customer.id);
      context.log(`DELETE /v1/customers/${customer.id}`);
    },
  },
  'product.created': {
    description: 'a catalog product',
    causes: ['product.created'],
    run: async (context) => {
      await testProduct(context);
    },
  },
  'product.updated': {
    description: 'a catalog product, then updated',
    causes: ['product.created', 'product.updated'],
    run: async (context) => {
      const product = await testProduct(context);
      await context.peable.products.update(product.id, {
        description: 'updated by peable trigger',
      });
      context.log(`POST /v1/products/${product.id}`);
    },
  },
  'product.deleted': {
    description: 'a catalog product, then deleted',
    causes: ['product.created', 'product.deleted'],
    run: async (context) => {
      const product = await testProduct(context);
      await context.peable.products.del(product.id);
      context.log(`DELETE /v1/products/${product.id}`);
    },
  },
  'price.created': {
    description: 'a catalog product and a one-time EUR 10.00 price for it',
    causes: ['product.created', 'price.created'],
    run: async (context) => {
      const product = await testProduct(context);
      const price = await context.peable.prices.create({
        product: product.id,
        currency: 'EUR',
        unit_amount: '1000',
        metadata: METADATA,
      });
      context.log(`POST /v1/prices → ${price.id}`);
    },
  },
  'coupon.created': {
    description: 'a 10%-off, once coupon',
    causes: ['coupon.created'],
    run: async ({ peable, log }) => {
      const coupon = await peable.coupons.create({
        name: 'Peable CLI test coupon',
        percent_off: 10,
        duration: 'once',
        metadata: METADATA,
      });
      log(`POST /v1/coupons → ${coupon.id}`);
    },
  },
  'webhook_endpoint.test': {
    description: 'a test event sent to your first enabled webhook endpoint',
    causes: ['webhook_endpoint.test'],
    run: async ({ peable, log }) => {
      const endpoints = await peable.webhookEndpoints.list({ limit: 100 });
      const endpoint = endpoints.data.find((candidate) => candidate.status === 'enabled');
      if (!endpoint) {
        throw new FixtureUnavailableError(
          'no enabled webhook endpoint: create one with `peable webhook_endpoints create --url <https url>`',
        );
      }
      const delivery = await peable.webhookEndpoints.sendTestEvent(endpoint.id);
      log(`POST /v1/webhook_endpoints/${endpoint.id}/test → delivery ${delivery.last_status}`);
    },
  },
} as const satisfies Partial<Record<WebhookEventType, Fixture>>;

export type TriggerableEvent = keyof typeof FIXTURES;

/** A fixture that cannot run for this merchant, with the reason a developer can act on. */
export class FixtureUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureUnavailableError';
  }
}

export function isTriggerable(event: string): event is TriggerableEvent {
  return Object.hasOwn(FIXTURES, event);
}

export const TRIGGERABLE_EVENTS = Object.keys(FIXTURES).sort() as TriggerableEvent[];
