import { describe, expect, it } from 'bun:test';
import { createFaircoinRenewalAuthorization, faircoinRenewalConsentSchema, type FaircoinRenewalActor, type FaircoinRenewalRecord, type FaircoinRenewalRepository } from '../faircoin-renewal';

/** Test-only serial fixture. Production requires durable row-locked transactions. */
class FixtureRepository implements FaircoinRenewalRepository {
  readonly records = new Map<string, FaircoinRenewalRecord>();
  private pending = Promise.resolve();
  async transaction<T>(namespace: string, authorizationId: string, action: (record: FaircoinRenewalRecord | null) => Promise<{ record: FaircoinRenewalRecord; result: T }>): Promise<T> {
    const previous = this.pending;
    let release = () => {};
    this.pending = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const key = `${namespace}:${authorizationId}`;
      const outcome = await action(this.records.get(key) ?? null);
      this.records.set(key, structuredClone({ ...outcome.record,
        consent: Object.fromEntries(Object.entries(outcome.record.consent).reverse()) as FaircoinRenewalRecord['consent'],
        instructions: outcome.record.instructions.map((value) => Object.fromEntries(Object.entries(value).reverse()) as typeof value),
      }));
      return structuredClone(outcome.result);
    } finally { release(); }
  }
}
function fixture() {
  const actor: FaircoinRenewalActor = { payerAccountId: 'payer_fixture', merchantId: 'merch_fixture', appId: 'app_fixture', mode: 'test', environment: 'development' };
  const consent = { ...actor, authorizationId: 'authorization_fixture', subscriptionId: 'subscription_fixture', planId: 'plan_fixture',
    explicitConsent: true as const, consentEvidenceId: 'consent_fixture', maximumAmountBaseUnits: '10000',
    interval: 'month' as const, intervalCount: 1 as const, startsAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2027-10-01T00:00:00.000Z', acceptedAt: '2026-09-30T12:00:00.000Z' };
  const instruction = { authorizationId: consent.authorizationId, subscriptionId: consent.subscriptionId, planId: consent.planId,
    amountBaseUnits: '9999', periodStart: consent.startsAt, periodEnd: '2026-11-01T00:00:00.000Z', idempotencyKey: 'renewal_fixture' };
  const repository = new FixtureRepository();
  let now = new Date('2026-10-07T12:00:00.000Z');
  const service = createFaircoinRenewalAuthorization({ repository, verifyConsent: async () => true, verifyRevocation: async () => true, now: () => now });
  return { actor, consent, instruction, repository, service, setNow: (value: string) => { now = new Date(value); } };
}

describe('Faircoin renewal scheduling authorization', () => {
  it('requires verified explicit consent, bounded positive amount and monthly cadence', async () => {
    const { service, actor, consent, repository } = fixture();
    expect(() => faircoinRenewalConsentSchema.parse({ ...consent, explicitConsent: false })).toThrow();
    expect(() => faircoinRenewalConsentSchema.parse({ ...consent, maximumAmountBaseUnits: '0' })).toThrow();
    expect(() => faircoinRenewalConsentSchema.parse({ ...consent, intervalCount: 2 })).toThrow();
    expect(() => faircoinRenewalConsentSchema.parse({ ...consent, expiresAt: consent.startsAt })).toThrow();
    expect(() => faircoinRenewalConsentSchema.parse({ ...consent, mode: 'live' })).toThrow();
    const denied = createFaircoinRenewalAuthorization({ repository, verifyConsent: async () => false, verifyRevocation: async () => true });
    await expect(denied.accept(actor, consent)).rejects.toThrow('identity_conflict');
    await expect(service.accept({ ...actor, payerAccountId: 'another' }, consent)).rejects.toThrow('not_found');
    expect(repository.records.size).toBe(0);
    expect(await service.accept(actor, consent)).toEqual(consent);
    expect(await service.accept(actor, consent)).toEqual(consent);
  });
  it('reserves one bounded monthly instruction concurrently and replays exact keys', async () => {
    const { service, actor, consent, instruction } = fixture(); await service.accept(actor, consent);
    const results = await Promise.all([service.prepareAutomaticRenewal(actor, instruction), service.prepareAutomaticRenewal(actor, instruction)]);
    expect(results).toEqual([instruction, instruction]);
    await expect(service.prepareAutomaticRenewal(actor, { ...instruction, amountBaseUnits: '10001' })).rejects.toThrow('identity_conflict');
    await expect(service.prepareAutomaticRenewal(actor, { ...instruction, amountBaseUnits: '10000' })).rejects.toThrow('idempotency_conflict');
    await expect(service.prepareAutomaticRenewal(actor, { ...instruction, idempotencyKey: 'other_key' })).rejects.toThrow('idempotency_conflict');
    await expect(service.prepareAutomaticRenewal(actor, { ...instruction, periodEnd: '2026-10-08T00:00:00.000Z' })).rejects.toThrow('identity_conflict');
    expect(await service.assertExecutionAuthorized(actor, instruction)).toEqual(instruction);
  });
  it('blocks overlapping shifted periods and permits the next monthly interval', async () => {
    const { service, actor, consent, instruction, setNow } = fixture(); await service.accept(actor, consent);
    await service.prepareAutomaticRenewal(actor, instruction); setNow('2026-11-08T12:00:00.000Z');
    await expect(service.prepareAutomaticRenewal(actor, { ...instruction, idempotencyKey: 'shifted', periodStart: '2026-10-10T00:00:00.000Z', periodEnd: '2026-11-10T00:00:00.000Z' })).rejects.toThrow('idempotency_conflict');
    const next = { ...instruction, idempotencyKey: 'next', periodStart: instruction.periodEnd, periodEnd: '2026-12-01T00:00:00.000Z' };
    expect(await service.prepareAutomaticRenewal(actor, next)).toEqual(next);
  });
  it('makes verified revocation observable and blocks reserved work, replay and reactivation', async () => {
    const { service, actor, consent, instruction, repository } = fixture(); await service.accept(actor, consent);
    await service.prepareAutomaticRenewal(actor, instruction);
    const revocation = { authorizationId: consent.authorizationId, revokedAt: '2026-10-07T11:00:00.000Z', revocationEvidenceId: 'revoke_fixture' };
    const denied = createFaircoinRenewalAuthorization({ repository, verifyConsent: async () => true, verifyRevocation: async () => false });
    await expect(denied.revoke(actor, revocation)).rejects.toThrow('identity_conflict');
    expect(await service.revoke(actor, revocation)).toEqual(revocation);
    expect(await service.revoke(actor, revocation)).toEqual(revocation);
    expect([...repository.records.values()][0]?.revocation).toEqual(revocation);
    await expect(service.assertExecutionAuthorized(actor, instruction)).rejects.toThrow('identity_conflict');
    await expect(service.prepareAutomaticRenewal(actor, instruction)).rejects.toThrow('identity_conflict');
    await expect(service.accept(actor, consent)).rejects.toThrow('idempotency_conflict');
    await expect(service.revoke({ ...actor, merchantId: 'another_merchant' }, revocation)).rejects.toThrow('not_found');
  });
  it('requires current consent at execution and keeps manual renewal outside automatic authority', async () => {
    const { service, actor, consent, instruction, setNow } = fixture(); await service.accept(actor, consent);
    await service.prepareAutomaticRenewal(actor, instruction); setNow(instruction.periodEnd);
    await expect(service.assertExecutionAuthorized(actor, instruction)).rejects.toThrow('identity_conflict');
    await expect(service.prepareAutomaticRenewal(actor, instruction)).rejects.toThrow('identity_conflict');
    setNow(consent.expiresAt);
    await expect(service.assertExecutionAuthorized(actor, instruction)).rejects.toThrow('identity_conflict');
    expect(service.manualMonthlyRenewal()).toEqual({ status: 'payer_confirmation_required', automaticallyAuthorized: false });
  });
});
