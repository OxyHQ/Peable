import { beforeEach, describe, expect, it } from 'bun:test';
import { gatewayDb, POSTGRES_TESTS_ENABLED, resetGatewayTables, seedMerchant, useGatewayDatabase } from '../../../__tests__/helpers/gatewayTestDatabase';
import { faircoinRenewalAuthorizations } from '../../../db/schema';
import { createPostgresFaircoinRenewalRepository } from '../../../db/billing/faircoinRenewalRepository';
import { createFaircoinRenewalAuthorization, faircoinRenewalNamespace, type FaircoinRenewalActor } from '../faircoin-renewal';

if (POSTGRES_TESTS_ENABLED) useGatewayDatabase();
describe.skipIf(!POSTGRES_TESTS_ENABLED)('durable Faircoin scheduling / real PostgreSQL', () => {
  beforeEach(resetGatewayTables);
  const now = new Date('2026-10-07T12:00:00.000Z');
  const service = () => createFaircoinRenewalAuthorization({ repository: createPostgresFaircoinRenewalRepository(gatewayDb()),
    verifyConsent: async () => true, verifyRevocation: async () => true, now: () => now });
  async function fixture() {
    const merchant = await seedMerchant({ publicId: 'merch_fixture', oxyAppId: 'app_fixture' });
    const actor: FaircoinRenewalActor = { payerAccountId: 'payer_fixture', merchantId: merchant.publicId,
      appId: merchant.oxyAppId, mode: 'test', environment: 'development' };
    const consent = { ...actor, authorizationId: 'authorization_fixture', subscriptionId: 'subscription_fixture', planId: 'plan_fixture',
      explicitConsent: true as const, consentEvidenceId: 'consent_fixture', maximumAmountBaseUnits: '10000', interval: 'month' as const,
      intervalCount: 1 as const, startsAt: '2026-10-01T00:00:00.000Z', expiresAt: '2027-10-01T00:00:00.000Z', acceptedAt: '2026-09-30T12:00:00.000Z' };
    const instruction = { authorizationId: consent.authorizationId, subscriptionId: consent.subscriptionId, planId: consent.planId,
      amountBaseUnits: '9999', periodStart: consent.startsAt, periodEnd: '2026-11-01T00:00:00.000Z', idempotencyKey: 'renewal_fixture' };
    return { merchant, actor, consent, instruction };
  }
  it('serializes first consent inserts and exact monthly replays across repository instances', async () => {
    const { actor, consent, instruction, merchant } = await fixture();
    const first = service(), second = service();
    expect(await Promise.all([first.accept(actor, consent), second.accept(actor, consent)])).toEqual([consent, consent]);
    const [row] = await gatewayDb().select().from(faircoinRenewalAuthorizations);
    expect(row?.merchantId).toBe(merchant.id); expect(row?.consent).toEqual(consent);
    expect(await Promise.all([first.prepareAutomaticRenewal(actor, instruction), second.prepareAutomaticRenewal(actor, instruction)])).toEqual([instruction, instruction]);
    expect((await gatewayDb().select().from(faircoinRenewalAuthorizations))[0]?.instructions).toHaveLength(1);
    // A newly composed service simulates recovery after a process restart;
    // PostgreSQL JSONB has reordered object keys at this point.
    expect(await service().accept(actor, consent)).toEqual(consent);
    expect(await service().prepareAutomaticRenewal(actor, instruction)).toEqual(instruction);
    expect(await service().assertExecutionAuthorized(actor, instruction)).toEqual(instruction);
  });
  it('persists revocation across restart and blocks concurrent reserved work and reactivation', async () => {
    const { actor, consent, instruction } = await fixture(); await service().accept(actor, consent);
    const revocation = { authorizationId: consent.authorizationId, revokedAt: now.toISOString(), revocationEvidenceId: 'revoke_fixture' };
    const results = await Promise.allSettled([service().prepareAutomaticRenewal(actor, instruction), service().revoke(actor, revocation)]);
    expect(results[1]?.status).toBe('fulfilled');
    expect((await gatewayDb().select().from(faircoinRenewalAuthorizations))[0]?.revocation).toEqual(revocation);
    await expect(service().assertExecutionAuthorized(actor, instruction)).rejects.toThrow('identity_conflict');
    await expect(service().prepareAutomaticRenewal(actor, instruction)).rejects.toThrow('identity_conflict');
    await expect(service().accept(actor, consent)).rejects.toThrow('idempotency_conflict');
    expect(await service().revoke(actor, revocation)).toEqual(revocation);
    const repository = createPostgresFaircoinRenewalRepository(gatewayDb());
    await expect(repository.transaction(faircoinRenewalNamespace(actor), consent.authorizationId, async (record) => {
      if (!record) throw new Error('Expected record');
      return { record: { ...record, revocation: null }, result: 'remove-revocation' };
    })).rejects.toThrow('identity_conflict');
    expect((await gatewayDb().select().from(faircoinRenewalAuthorizations))[0]?.revocation).toEqual(revocation);
  });
  it('keeps actor namespaces separate and refuses nonexistent merchant ownership', async () => {
    const { actor, consent, instruction } = await fixture(); await service().accept(actor, consent);
    await expect(service().prepareAutomaticRenewal({ ...actor, payerAccountId: 'another_payer' }, instruction)).rejects.toThrow('not_found');
    await expect(service().accept({ ...actor, merchantId: 'merch_unknown' }, { ...consent, merchantId: 'merch_unknown' })).rejects.toThrow('not_found');
    expect(await gatewayDb().select().from(faircoinRenewalAuthorizations)).toHaveLength(1);
    await seedMerchant({ publicId: 'merch_other', oxyAppId: 'app_other' });
    const anotherActor = { ...actor, merchantId: 'merch_other', appId: 'app_other' };
    await service().accept(anotherActor, { ...consent, ...anotherActor });
    expect(await gatewayDb().select().from(faircoinRenewalAuthorizations)).toHaveLength(2);
  });
  it('rolls back thrown callbacks and refuses mutation of verified consent or recorded instructions', async () => {
    const { actor, consent, instruction } = await fixture(); await service().accept(actor, consent); await service().prepareAutomaticRenewal(actor, instruction);
    const repository = createPostgresFaircoinRenewalRepository(gatewayDb());
    await expect(repository.transaction(faircoinRenewalNamespace(actor), consent.authorizationId, async (record) => {
      if (!record) throw new Error('Expected record');
      record.consent.maximumAmountBaseUnits = '999999';
      return { record, result: 'mutate-limit' };
    })).rejects.toThrow('identity_conflict');
    await expect(repository.transaction(faircoinRenewalNamespace(actor), consent.authorizationId, async (record) => {
      if (!record) throw new Error('Expected record');
      return { record: { ...record, instructions: [] }, result: 'remove-instruction' };
    })).rejects.toThrow('identity_conflict');
    await expect(repository.transaction(faircoinRenewalNamespace(actor), 'new_authorization', async () => { throw new Error('fixture failure'); })).rejects.toThrow('fixture failure');
    const rows = await gatewayDb().select().from(faircoinRenewalAuthorizations);
    expect(rows).toHaveLength(1); expect(rows[0]?.consent.maximumAmountBaseUnits).toBe('10000'); expect(rows[0]?.instructions).toHaveLength(1);
  });
});
