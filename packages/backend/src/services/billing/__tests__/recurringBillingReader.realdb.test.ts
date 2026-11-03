/**
 * The provider answers in Unix seconds (the wire's unit, ADR 0014), and the
 * recurring snapshot is internal storage whose periods are ISO instants
 * (`recurringSnapshotSchema`). The reader is the one place the two meet; when it
 * passed the seconds through, every owned subscription and invoice observation
 * failed `recurringSnapshotSchema` at `periods[0].start`.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import {
  gatewayDb,
  POSTGRES_TESTS_ENABLED,
  resetGatewayTables,
  seedMerchant,
  useGatewayDatabase,
} from '../../../__tests__/helpers/gatewayTestDatabase';
import { bindBillingObject } from '../../../db/billing/billingRepository';
import { recurringMirrors } from '../../../db/schema';
import { recurringSnapshotSchema } from '../../recurring/contracts';
import { createOwnedBillingRecurringReader } from '../recurringBillingReader';

type ReaderOptions = Parameters<typeof createOwnedBillingRecurringReader>[0];

const START = 1_793_707_200; // 2026-11-03T12:00:00Z
const END = START + 30 * 86_400;
const billingDeployment = {
  provider: 'stripe' as const,
  platformAccountId: 'acct_platform',
  livemode: false,
};
const deployment = {
  ...billingDeployment,
  environment: 'development' as const,
  apiVersion: '2026-07-29.dahlia',
};

async function ownedSubscription() {
  const merchant = await seedMerchant();
  const owner = {
    merchantId: merchant.id,
    oxyAppId: merchant.oxyAppId,
    environment: merchant.environment,
  };
  const evidence = { bindingEvidenceRef: 'fixture:verified' };
  const customer = await bindBillingObject(gatewayDb(), billingDeployment, owner, {
    kind: 'customer',
    providerRef: 'cus_one',
    externalSubjectRef: 'store:one',
    ...evidence,
  });
  const price = await bindBillingObject(gatewayDb(), billingDeployment, owner, {
    kind: 'price',
    providerRef: 'price_one',
    planRef: 'plan:one',
    ...evidence,
  });
  await bindBillingObject(gatewayDb(), billingDeployment, owner, {
    kind: 'subscription',
    providerRef: 'sub_one',
    externalSubjectRef: 'store:one',
    planRef: 'plan:one',
    customerBindingId: customer.id,
    priceBindingId: price.id,
    ...evidence,
  });
  for (const [kind, objectRef] of [
    ['subscription', 'sub_one'],
    ['invoice', 'in_one'],
  ] as const) {
    await gatewayDb()
      .insert(recurringMirrors)
      .values({
        ...owner,
        ...billingDeployment,
        providerAccountId: null,
        kind,
        objectRef,
        bindingEvidenceRef: 'fixture:verified',
      });
  }
}

function reader() {
  const bindings: Pick<ReaderOptions['bindings'], 'authorizeOwner' | 'retrieveInvoiceState'> = {
    authorizeOwner: async () => undefined,
    retrieveInvoiceState: async () =>
      ({
        provider_subscription_id: 'sub_one',
        currency: 'USD',
        amount_paid: '2999',
        amount_refunded: '0',
        payment_intent_id: 'pi_provider',
        charge_id: 'ch_provider',
        line_id: 'il_one',
        period_start: START,
        period_end: END,
      }) as unknown as Awaited<ReturnType<ReaderOptions['bindings']['retrieveInvoiceState']>>,
  };
  const client: Pick<ReaderOptions['client'], 'retrieveSubscription' | 'retrieveInvoice'> = {
    retrieveSubscription: async () => ({
      id: 'sub_one',
      customer: 'cus_one',
      livemode: false,
      status: 'active',
      cancel_at_period_end: false,
      trial_end: null,
      cancel_at: null,
      canceled_at: null,
      latest_invoice: null,
      items: {
        has_more: false,
        data: [
          {
            current_period_start: START,
            current_period_end: END,
            price: { id: 'price_one', recurring: { interval: 'month', interval_count: 1 } },
            quantity: 1,
          },
        ],
      },
    }),
    retrieveInvoice: async () => ({
      id: 'in_one',
      parent: { subscription_details: { subscription: 'sub_one' } },
    }),
  };
  return createOwnedBillingRecurringReader({
    db: gatewayDb(),
    bindings: bindings as ReaderOptions['bindings'],
    client: client as ReaderOptions['client'],
  });
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('owned recurring reader / real PostgreSQL', () => {
  useGatewayDatabase();
  beforeEach(resetGatewayTables);

  it('turns a subscription period in Unix seconds into the snapshot ISO instants', async () => {
    await ownedSubscription();
    const snapshot = await reader().readSnapshot({
      deployment,
      providerAccountId: null,
      kind: 'subscription',
      objectRef: 'sub_one',
      signal: new AbortController().signal,
    });
    expect(recurringSnapshotSchema.parse(snapshot).periods[0]).toMatchObject({
      start: '2026-11-03T12:00:00.000Z',
      end: new Date(END * 1000).toISOString(),
    });
  });

  it('does the same for an invoice period', async () => {
    await ownedSubscription();
    const snapshot = await reader().readSnapshot({
      deployment,
      providerAccountId: null,
      kind: 'invoice',
      objectRef: 'in_one',
      signal: new AbortController().signal,
    });
    expect(recurringSnapshotSchema.parse(snapshot).periods[0]?.start).toBe(
      '2026-11-03T12:00:00.000Z',
    );
  });
});
