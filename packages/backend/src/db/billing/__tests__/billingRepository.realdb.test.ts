import { beforeEach, describe, expect, it } from 'bun:test';
import { gatewayDb, POSTGRES_TESTS_ENABLED, resetGatewayTables, seedMerchant, useGatewayDatabase } from '../../../__tests__/helpers/gatewayTestDatabase';
import { bindBillingObject, claimBillingOperation, completeBillingOperation, markBillingOperationIndeterminate, requireBillingBinding, type BillingClaim } from '../billingRepository';
import { billingObjectBindings, billingOperations } from '../../schema';
import type { BillingOwner } from '../../../services/billing/contracts';
const deployment = { provider: 'stripe' as const, platformAccountId: 'acct_platform', livemode: false };
const now = new Date('2026-10-03T12:00:00Z');
const input = { operation: 'portal' as const, idempotencyKey: 'checkout:one', requestDigest: 'a'.repeat(64) };
async function owner() { const m = await seedMerchant(); return { merchantId: m.id, oxyAppId: m.oxyAppId, environment: m.environment }; }
async function binding(merchant: BillingOwner, kind: 'customer' | 'price' = 'customer', ref = kind === 'customer' ? 'cus_one' : 'price_one') {
  return bindBillingObject(gatewayDb(), deployment, merchant, { kind, providerRef: ref,
    ...(kind === 'customer' ? { externalSubjectRef: 'store:one' } : { planRef: 'plan:one' }), bindingEvidenceRef: 'fixture:verified' });
}
function claimed(value: BillingClaim) { if (value.kind !== 'claimed') throw new Error('Expected new claim'); return value; }
const hosted = { url: 'https://checkout.stripe.com/c/pay/synthetic', expiresAt: '2026-10-03T13:00:00Z' };

describe.skipIf(!POSTGRES_TESTS_ENABLED)('billing ownership and durable claims / real PostgreSQL', () => {
  useGatewayDatabase(); beforeEach(resetGatewayTables);
  it('converges verified binding and refuses different owner or environment', async () => {
    const a = await owner(); const b = await owner(); const first = await binding(a);
    expect((await binding(a)).id).toBe(first.id);
    await expect(binding(b)).rejects.toThrow('identity_conflict');
    await expect(bindBillingObject(gatewayDb(), deployment, { ...a, environment: 'staging' }, { kind: 'customer', providerRef: 'cus_other', externalSubjectRef: 'store:one', bindingEvidenceRef: 'fixture:verified' })).rejects.toThrow('identity_conflict');
    expect(await gatewayDb().select().from(billingObjectBindings)).toHaveLength(1);
  });
  it('requires subscription customer and price of exact same owner and store/plan', async () => {
    const a = await owner(); const b = await owner(); const c = await binding(a); const p = await binding(a, 'price');
    const foreign = await binding(b, 'price', 'price_foreign');
    const sub = { kind: 'subscription' as const, providerRef: 'sub_one', externalSubjectRef: 'store:one', planRef: 'plan:one', customerBindingId: c.id, priceBindingId: p.id, bindingEvidenceRef: 'fixture:checkout' };
    for (const change of [{ priceBindingId: foreign.id }, { externalSubjectRef: 'store:other' }, { customerBindingId: p.id }, { planRef: 'plan:other' }]) {
      await expect(bindBillingObject(gatewayDb(), deployment, a, { ...sub, ...change })).rejects.toThrow('identity_conflict');
    }
    expect(await bindBillingObject(gatewayDb(), deployment, a, sub)).toMatchObject({ externalSubjectRef: 'store:one', planRef: 'plan:one' });
  });
  it('does not read foreign or unknown refs or create a second customer per store', async () => {
    const a = await owner(); const b = await owner(); await binding(a);
    await expect(requireBillingBinding(gatewayDb(), deployment, b, 'customer', 'cus_one')).rejects.toThrow('not_found');
    await expect(requireBillingBinding(gatewayDb(), deployment, a, 'subscription', 'sub_unknown')).rejects.toThrow('not_found');
    await expect(binding(a, 'customer', 'cus_two')).rejects.toThrow('identity_conflict');
  });
  it('claims once under concurrency and returns without holding a provider transaction', async () => {
    const a = await owner(); const results = await Promise.allSettled([claimBillingOperation(gatewayDb(), deployment, a, input, now), claimBillingOperation(gatewayDb(), deployment, a, input, now)]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1);
    expect(await gatewayDb().select().from(billingOperations)).toHaveLength(1);
  });
  it('globally refuses same key from another merchant, operation or payload', async () => {
    const a = await owner(); const b = await owner(); await claimBillingOperation(gatewayDb(), deployment, a, input, now);
    await expect(claimBillingOperation(gatewayDb(), deployment, b, input, now)).rejects.toThrow('idempotency_conflict');
    await expect(claimBillingOperation(gatewayDb(), deployment, a, { ...input, operation: 'cancel_at_period_end' }, now)).rejects.toThrow('idempotency_conflict');
    await expect(claimBillingOperation(gatewayDb(), deployment, a, { ...input, requestDigest: 'b'.repeat(64) }, now)).rejects.toThrow('idempotency_conflict');
  });
  it('refuses second key creating customer after unknown first result', async () => {
    const a = await owner(); const customer = { ...input, operation: 'ensure_customer' as const, subjectClaimRef: 'store:one' };
    await claimBillingOperation(gatewayDb(), deployment, a, customer, now);
    await expect(claimBillingOperation(gatewayDb(), deployment, a, { ...customer, idempotencyKey: 'other:key' }, now)).rejects.toThrow('idempotency_conflict');
    expect(await gatewayDb().select().from(billingOperations)).toHaveLength(1);
  });
  it('replays owner result but rejects an expired hosted URL', async () => {
    const a = await owner(); const first = claimed(await claimBillingOperation(gatewayDb(), deployment, a, input, now));
    await gatewayDb().transaction((tx) => completeBillingOperation(tx, first.operation, first.leaseToken, hosted, 'cs_test_one', now));
    expect(await claimBillingOperation(gatewayDb(), deployment, a, input, now)).toMatchObject({ kind: 'replay', result: hosted });
    await expect(claimBillingOperation(gatewayDb(), deployment, a, input, new Date('2026-10-03T14:00:00Z'))).rejects.toThrow('result_expired');
  });
  it('recovers expired lease with same remote key and fences stale completion', async () => {
    const a = await owner(); const first = claimed(await claimBillingOperation(gatewayDb(), deployment, a, input, now));
    const later = new Date(now.getTime() + 91_000); const second = claimed(await claimBillingOperation(gatewayDb(), deployment, a, input, later));
    expect(second.operation.remoteIdempotencyKey).toBe(first.operation.remoteIdempotencyKey); expect(second.leaseToken).not.toBe(first.leaseToken);
    await expect(gatewayDb().transaction((tx) => completeBillingOperation(tx, first.operation, first.leaseToken, hosted, 'cs_test_one', later))).rejects.toThrow('in_progress');
    expect((await gatewayDb().select().from(billingOperations))[0]?.state).toBe('pending');
  });
  it('does not blindly retry beyond bounded recovery window', async () => {
    const a = await owner(); const first = claimed(await claimBillingOperation(gatewayDb(), deployment, a, input, now));
    await markBillingOperationIndeterminate(gatewayDb(), first.operation, first.leaseToken);
    await expect(claimBillingOperation(gatewayDb(), deployment, a, input, new Date(now.getTime() + 24 * 3600_000))).rejects.toThrow('reconciliation_required');
  });
  it('rolls back binding and result together on local crash', async () => {
    const a = await owner(); const first = claimed(await claimBillingOperation(gatewayDb(), deployment, a, { ...input, operation: 'ensure_customer', subjectClaimRef: 'store:one' }, now));
    await expect(gatewayDb().transaction(async (tx) => {
      await bindBillingObject(tx, deployment, a, { kind: 'customer', providerRef: 'cus_one', externalSubjectRef: 'store:one', bindingEvidenceRef: first.operation.id });
      await completeBillingOperation(tx, first.operation, first.leaseToken, { providerCustomerId: 'cus_one' }, 'cus_one', now);
      throw new Error('fixture crash');
    })).rejects.toThrow('fixture crash');
    expect(await gatewayDb().select().from(billingObjectBindings)).toHaveLength(0);
    expect((await gatewayDb().select().from(billingOperations))[0]?.state).toBe('pending');
  });
  it('binds checkout claim to exact owned customer and price, including replay', async () => {
    const a = await owner(); const b = await owner(); const c = await binding(a); const p = await binding(a, 'price');
    const p2 = await bindBillingObject(gatewayDb(), deployment, a, { kind: 'price', providerRef: 'price_two', planRef: 'plan:two', bindingEvidenceRef: 'fixture:verified' });
    const foreign = await binding(b, 'price', 'price_foreign');
    const checkout = { ...input, operation: 'checkout' as const, customerBindingId: c.id, priceBindingId: p.id };
    await expect(claimBillingOperation(gatewayDb(), deployment, a, { ...checkout, priceBindingId: foreign.id }, now)).rejects.toThrow('identity_conflict');
    const first = claimed(await claimBillingOperation(gatewayDb(), deployment, a, checkout, now));
    await gatewayDb().transaction((tx) => completeBillingOperation(tx, first.operation, first.leaseToken, hosted, 'cs_test_one', now));
    await expect(claimBillingOperation(gatewayDb(), deployment, a, { ...checkout, priceBindingId: p2.id }, now)).rejects.toThrow('idempotency_conflict');
    expect((await claimBillingOperation(gatewayDb(), deployment, a, checkout, now)).kind).toBe('replay');
  });

});
