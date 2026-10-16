import { describe, expect, it } from 'bun:test';
import type { BillingService } from '../billingService';
import type { BillingOwner } from '../contracts';
import { createMultiRailBillingService, type BillingRail } from '../rails';

const owner: BillingOwner = { merchantId: 'm1', oxyAppId: 'app1', environment: 'production' };
const other: BillingOwner = { merchantId: 'm2', oxyAppId: 'app2', environment: 'production' };
const third: BillingOwner = { merchantId: 'm3', oxyAppId: 'app3', environment: 'production' };
const fair = (prefix: string) => `${prefix}fair${'a'.repeat(64)}`;

/** A rail whose service records which method it answered, and with what input. */
function rail(
  id: string,
  options: { namespaced?: boolean; owners?: BillingOwner[]; taxQuotes?: boolean } = {},
) {
  const calls: { method: string; args: unknown[] }[] = [];
  const service = new Proxy({} as BillingService, {
    get: (_target, method) =>
      method === 'then'
        ? undefined
        : async (...args: unknown[]) => {
            calls.push({ method: String(method), args });
            return { rail: id };
          },
  });
  const owners = options.owners ?? [owner];
  const value: BillingRail = {
    id,
    settlement: id === 'faircoin' ? 'faircoin' : 'fiat',
    renewal: id === 'faircoin' ? 'payer_initiated' : 'automatic',
    service,
    ...(options.namespaced
      ? {
          refPatterns: {
            customer: /^cus_fair[0-9a-f]{64}$/,
            subscription: /^sub_fair[0-9a-f]{64}$/,
            checkout: /^cs_(live|test)_fair[0-9a-f]{64}$/,
          },
        }
      : {}),
    serves: (candidate) => owners.some((o) => o.merchantId === candidate.merchantId),
    taxQuotes: () => options.taxQuotes ?? true,
    offers: () => null,
  };
  return { value, calls };
}
const checkout = (providerCustomerId: string, extra: Record<string, unknown> = {}) => ({
  providerCustomerId,
  providerPriceId: 'price_one',
  trialDays: 0,
  returnUrl: 'https://example.test/return',
  storeId: 'store',
  planId: 'plan',
  ...extra,
});

describe('several billing rails behind one subscription contract', () => {
  it('keeps every request that names no rail on the first rail, exactly as before', async () => {
    const stripe = rail('stripe');
    const faircoin = rail('faircoin', { namespaced: true });
    const billing = createMultiRailBillingService([stripe.value, faircoin.value]);
    await billing.ensureCustomer(owner, { storeId: 's', storeName: 'S' }, 'k1');
    await billing.createCheckoutSession(owner, checkout('cus_Abc123'), 'k2');
    await billing.retrieveSubscription(owner, 'sub_Abc123');
    await billing.cancelAtPeriodEnd(owner, 'sub_Abc123', 'k3');
    await billing.retrieveCheckout(owner, 'cs_live_Abc123');
    expect(stripe.calls.map((call) => call.method)).toEqual([
      'ensureCustomer',
      'createCheckoutSession',
      'retrieveSubscription',
      'cancelAtPeriodEnd',
      'retrieveCheckout',
    ]);
    expect(faircoin.calls).toHaveLength(0);
    // The rail field never reaches a rail, so legacy idempotency digests are unchanged.
    expect(stripe.calls[0]?.args[1]).toEqual({ storeId: 's', storeName: 'S' });
  });

  it('lets the payer choose a rail and routes its objects back to it', async () => {
    const stripe = rail('stripe');
    const faircoin = rail('faircoin', { namespaced: true });
    const billing = createMultiRailBillingService([stripe.value, faircoin.value]);
    await billing.ensureCustomer(owner, { storeId: 's', storeName: 'S', rail: 'faircoin' }, 'k');
    await billing.createCheckoutSession(owner, checkout(fair('cus_'), { rail: 'faircoin' }), 'k');
    await billing.renew?.(owner, fair('sub_'), checkout(fair('cus_')), 'k');
    await billing.retrievePaidInvoice(owner, fair('sub_'), 'in_x');
    await billing.retrieveCheckout(owner, fair('cs_live_'));
    expect(faircoin.calls.map((call) => call.method)).toEqual([
      'ensureCustomer',
      'createCheckoutSession',
      'renew',
      'retrievePaidInvoice',
      'retrieveCheckout',
    ]);
    expect(faircoin.calls[1]?.args[1]).not.toHaveProperty('rail');
    expect(stripe.calls).toHaveLength(0);
  });

  it('refuses a rail that is not configured or contradicts the object it names', async () => {
    const stripe = rail('stripe');
    const faircoin = rail('faircoin', { namespaced: true, owners: [other] });
    const billing = createMultiRailBillingService([stripe.value, faircoin.value]);
    // FairCoin does not serve this merchant: neither choosing it nor naming its objects reaches it.
    await expect(
      billing.ensureCustomer(owner, { storeId: 's', storeName: 'S', rail: 'faircoin' }, 'k'),
    ).rejects.toMatchObject({ code: 'rail_unavailable' });
    await expect(billing.retrieveSubscription(owner, fair('sub_'))).rejects.toMatchObject({
      code: 'not_found',
    });
    // A Stripe customer cannot be checked out on another rail.
    await expect(
      billing.createCheckoutSession(owner, checkout('cus_Abc', { rail: 'faircoin' }), 'k'),
    ).rejects.toMatchObject({ code: 'identity_conflict' });
    await expect(billing.retrieveSubscription(third, 'sub_x')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(faircoin.calls).toHaveLength(0);
    expect(stripe.calls).toHaveLength(0);
  });

  it('answers tax quotes from the first rail that calculates them, and lists rails default first', async () => {
    const stripe = rail('stripe', { taxQuotes: false });
    const faircoin = rail('faircoin', { namespaced: true });
    const billing = createMultiRailBillingService([stripe.value, faircoin.value]);
    await billing.createTaxQuote(owner, {
      storeId: 's',
      planId: 'p',
      customerLocationEvidenceId: 'l',
    });
    expect(faircoin.calls.map((call) => call.method)).toEqual(['createTaxQuote']);
    expect((await billing.listRails?.(owner))?.data.map((r) => [r.rail, r.default])).toEqual([
      ['stripe', true],
      ['faircoin', false],
    ]);
  });

  it('refuses a configuration two rails could both claim references in', () => {
    expect(() =>
      createMultiRailBillingService([rail('stripe').value, rail('square').value]),
    ).toThrow('opaque');
    expect(() =>
      createMultiRailBillingService([rail('stripe').value, rail('stripe').value]),
    ).toThrow('distinct');
  });
});
