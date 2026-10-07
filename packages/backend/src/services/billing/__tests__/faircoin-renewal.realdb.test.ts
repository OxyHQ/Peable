import { createDatabase } from '@oxy.so/db';
import * as schema from '../../../db/schema';
import { consumeFaircoinRenewalPass, startFaircoinRenewalWorker } from '../faircoin-renewal-worker';
import { sql } from 'drizzle-orm';
import { createFaircoinRenewalConsumer } from '../faircoin-renewal-consumer';
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
  it('deduplicates concurrent consumers and acknowledges already-authorized dispatch at revocation', async () => {
    const { actor, consent, instruction } = await fixture();
    await service().accept(actor, consent); await service().prepareAutomaticRenewal(actor, instruction);
    let release: () => void = () => {}; let entered: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let executions = 0; let revoked = false; let dispatched = false;
    const executor = { domain: 'fixture-provider-v1', recover: async () => dispatched ? ({ kind: 'indeterminate' as const }) : ({ kind: 'not_found' as const }), execute: async () => {
      dispatched = true; executions++; entered(); await gate; return { kind: 'accepted' as const, operationRef: 'operation_fixture' };
    } };
    const consumer = () => createFaircoinRenewalConsumer({ repository: createPostgresFaircoinRenewalRepository(gatewayDb()), executor, now: () => now });
    const pending = consumer().consume(actor, instruction); await started;
    const revocation = service().revokeWithDispatchAcknowledgement(actor, { authorizationId: consent.authorizationId, revokedAt: now.toISOString(), revocationEvidenceId: 'revoke_fixture' }).then(() => { revoked = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); expect(revoked).toBe(true);
    release(); expect((await pending).status).toBe('accepted'); await revocation;
    const replay = await Promise.all([consumer().consume(actor, instruction), consumer().consume(actor, instruction)]);
    expect(replay.every(value => value.status === 'accepted')).toBe(true); expect(executions).toBe(1);
  });
  it('recovers remote acceptance after rollback and revocation without another dispatch', async () => {
    const { actor, consent, instruction } = await fixture();
    await service().accept(actor, consent); await service().prepareAutomaticRenewal(actor, instruction);
    let accepted = false; let executions = 0; const keys: string[] = [];
    const executor = { domain: 'fixture-provider-v1', recover: async (input: { idempotencyKey: string }) => {
      keys.push(input.idempotencyKey); return accepted ? { kind: 'accepted' as const, operationRef: 'operation_fixture' } : { kind: 'not_found' as const };
    }, execute: async () => { accepted = true; executions++; return { kind: 'accepted' as const, operationRef: 'operation_fixture' }; } };
    const consumer = () => createFaircoinRenewalConsumer({ repository: createPostgresFaircoinRenewalRepository(gatewayDb()), executor, now: () => now });
    await gatewayDb().execute(sql`CREATE FUNCTION reject_execution_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.executions) item WHERE item->>'status' = 'accepted') THEN RAISE EXCEPTION 'fixture rollback'; END IF; RETURN NEW; END $$`);
    await gatewayDb().execute(sql`CREATE TRIGGER reject_execution_fixture BEFORE UPDATE ON faircoin_renewal_authorizations FOR EACH ROW EXECUTE FUNCTION reject_execution_fixture()`);
    await expect(consumer().consume(actor, instruction)).rejects.toThrow();
    await gatewayDb().execute(sql`DROP TRIGGER reject_execution_fixture ON faircoin_renewal_authorizations`);
    await gatewayDb().execute(sql`DROP FUNCTION reject_execution_fixture()`);
    let incompatibleCalls = 0;
    const replacement = { ...executor, domain: 'fixture-other-store', recover: async () => { incompatibleCalls++; return { kind: 'not_found' as const }; } };
    await expect(createFaircoinRenewalConsumer({ repository: createPostgresFaircoinRenewalRepository(gatewayDb()), executor: replacement, now: () => now }).consume(actor, instruction)).rejects.toThrow('idempotency_conflict');
    expect(incompatibleCalls).toBe(0);
    const stored = (await gatewayDb().select().from(faircoinRenewalAuthorizations))[0]?.executions[0];
    expect(stored?.executorDomain).toBe(executor.domain); expect(stored?.status).toBe('authorized'); expect(stored?.permitRef).toBeDefined();
    await service().revoke(actor, { authorizationId: consent.authorizationId, revokedAt: now.toISOString(), revocationEvidenceId: 'revoke_fixture' });
    expect((await consumer().consume(actor, instruction)).status).toBe('accepted'); expect(executions).toBe(1);
    expect(new Set(keys).size).toBe(1);
  });
  it('fails closed without executor and never dispatches revoked work or unknown recovery', async () => {
    const { actor, consent, instruction } = await fixture();
    await service().accept(actor, consent); await service().prepareAutomaticRenewal(actor, instruction);
    const repository = createPostgresFaircoinRenewalRepository(gatewayDb());
    await expect(createFaircoinRenewalConsumer({ repository }).consume(actor, instruction)).rejects.toThrow('provider_unavailable');
    let calls = 0;
    const executor = { domain: 'fixture-provider-v1', recover: async () => { throw new Error('unavailable'); }, execute: async () => { calls++; return { kind: 'accepted' as const, operationRef: 'operation_fixture' }; } };
    expect((await createFaircoinRenewalConsumer({ repository, executor, now: () => now }).consume(actor, instruction)).status).toBe('indeterminate');
    await service().revoke(actor, { authorizationId: consent.authorizationId, revokedAt: now.toISOString(), revocationEvidenceId: 'revoke_fixture' });
    executor.recover = async () => { throw new Error('still unknown'); };
    expect((await createFaircoinRenewalConsumer({ repository, executor, now: () => now }).consume(actor, instruction)).status).toBe('indeterminate');
    expect(calls).toBe(0);
    const resolved = { ...executor, recover: async () => ({ kind: 'not_found' as const }) };
    expect((await createFaircoinRenewalConsumer({ repository, executor: resolved, now: () => now }).consume(actor, instruction)).status).toBe('cancelled');
    expect(calls).toBe(0);
  });

  it('recovers a bounded actor-scoped durable queue across worker restarts', async () => {
    const { actor, consent, instruction } = await fixture();
    await service().accept(actor, consent); await service().prepareAutomaticRenewal(actor, instruction);
    let executions = 0;
    const executor = { domain: 'fixture-provider-v1', recover: async () => executions ? ({ kind: 'accepted' as const, operationRef: 'operation_fixture' }) : ({ kind: 'not_found' as const }), execute: async () => { if (!executions) executions++; return { kind: 'accepted' as const, operationRef: 'operation_fixture' }; } };
    const options = { db: gatewayDb(), actors: [actor], executor, now: () => now, limit: 1 };
    expect(await consumeFaircoinRenewalPass({ ...options, actors: [{ ...actor, payerAccountId: 'another_payer' }] })).toBe(0);
    expect(await Promise.all([consumeFaircoinRenewalPass(options), consumeFaircoinRenewalPass(options)])).toEqual([1, 1]);
    expect(executions).toBe(1); expect(await consumeFaircoinRenewalPass(options)).toBe(0);
    let passes = 0;
    const stop = startFaircoinRenewalWorker(options, { intervalMs: 5, pass: async () => { passes++; await new Promise(resolve => setTimeout(resolve, 10)); return 0; } });
    await new Promise(resolve => setTimeout(resolve, 30)); await stop(); const stoppedCount = passes;
    await new Promise(resolve => setTimeout(resolve, 15)); expect(passes).toBe(stoppedCount); expect(passes).toBeGreaterThan(0);
  });

  it('rotates bounded scans so unresolved work cannot starve later instructions', async () => {
    const { actor, consent, instruction } = await fixture();
    await service().accept(actor, consent); await service().prepareAutomaticRenewal(actor, instruction);
    const nextConsent = { ...consent, authorizationId: 'authorization_second', subscriptionId: 'subscription_second' };
    const nextInstruction = { ...instruction, authorizationId: nextConsent.authorizationId, subscriptionId: nextConsent.subscriptionId, idempotencyKey: 'renewal_second' };
    await service().accept(actor, nextConsent); await service().prepareAutomaticRenewal(actor, nextInstruction);
    let executions = 0;
    const executor = { domain: 'fixture-provider-v1', recover: async (input: { instruction: { authorizationId: string } }) => input.instruction.authorizationId === consent.authorizationId ? { kind: 'indeterminate' as const } : { kind: 'not_found' as const },
      execute: async () => { executions++; return { kind: 'accepted' as const, operationRef: 'operation_second' }; } };
    const options = { db: gatewayDb(), actors: [actor], executor, now: () => now, limit: 1, cursors: new Map<string, number>() };
    await consumeFaircoinRenewalPass(options); await consumeFaircoinRenewalPass(options);
    expect(executions).toBe(1);
    await consumeFaircoinRenewalPass(options); await consumeFaircoinRenewalPass(options);
    expect(executions).toBe(1);
  });

  it('never dispatches a reserved instruction after its period expires', async () => {
    const { actor, consent, instruction } = await fixture();
    await service().accept(actor, consent); await service().prepareAutomaticRenewal(actor, instruction);
    let executions = 0;
    const executor = { domain: 'fixture-provider-v1', recover: async () => ({ kind: 'not_found' as const }), execute: async () => { executions++; return { kind: 'indeterminate' as const }; } };
    const consumer = createFaircoinRenewalConsumer({ repository: createPostgresFaircoinRenewalRepository(gatewayDb()), executor, now: () => new Date(instruction.periodEnd) });
    expect((await consumer.consume(actor, instruction)).status).toBe('cancelled'); expect(executions).toBe(0);
  });

  it('rechecks durable revocation after the prior database session is terminated during recovery', async () => {
    const { actor, consent, instruction } = await fixture();
    await service().accept(actor, consent); await service().prepareAutomaticRenewal(actor, instruction);
    const [database] = await gatewayDb().execute(sql`select current_database() as name`);
    const adminUrl = process.env.TEST_DATABASE_URL;
    if (!adminUrl || !database || typeof database.name !== 'string') throw new Error('Expected disposable database');
    const url = new URL(adminUrl); url.pathname = '/' + database.name;
    const dedicated = createDatabase({ databaseUrl: url.toString(), schema, client: { max: 1 } });
    const [backend] = await dedicated.db.execute(sql`select pg_backend_pid() as pid`);
    if (!backend || typeof backend.pid !== 'number') throw new Error('Expected dedicated backend');
    let executions = 0; let recovered = false;
    let finishRecovery: () => void = () => {};
    const recoveryFinished = new Promise<void>(resolve => { finishRecovery = resolve; });
    const executor = { domain: 'fixture-provider-v1', recover: async () => {
      try {
      const [terminated] = await gatewayDb().execute(sql`select pg_terminate_backend(${backend.pid}) as terminated`);
      expect(terminated?.terminated).toBe(true);
      await service().revoke(actor, { authorizationId: consent.authorizationId, revokedAt: now.toISOString(), revocationEvidenceId: 'revoke_session' });
      recovered = true; return { kind: 'not_found' as const };
      } finally { finishRecovery(); }
    }, execute: async () => { executions++; return { kind: 'accepted' as const, operationRef: 'operation_session' }; } };
    const consumer = createFaircoinRenewalConsumer({ repository: createPostgresFaircoinRenewalRepository(dedicated.db), executor, now: () => now });
    await consumer.consume(actor, instruction).catch(() => undefined);
    await recoveryFinished;
    await new Promise(resolve => setTimeout(resolve, 10));
    await dedicated.client.end({ timeout: 1 });
    expect(recovered).toBe(true); expect(executions).toBe(0);
  });

  it('keeps an issued permit recoverable when revocation wins before its delayed dispatch', async () => {
    const { actor, consent, instruction } = await fixture();
    await service().accept(actor, consent); await service().prepareAutomaticRenewal(actor, instruction);
    const durable = createPostgresFaircoinRenewalRepository(gatewayDb());
    let release: () => void = () => {}; let entered: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const issued = new Promise<void>(resolve => { entered = resolve; });
    let transactions = 0;
    const delayedRepository = { async transaction<T>(namespace: string, id: string, action: Parameters<typeof durable.transaction<T>>[2]) {
      const result = await durable.transaction(namespace, id, action);
      if (++transactions === 2) { entered(); await gate; }
      return result;
    } };
    let accepted = false; let executions = 0;
    const executor = { domain: 'fixture-provider-v1', recover: async () => accepted ? { kind: 'accepted' as const, operationRef: 'operation_delayed' } : { kind: 'not_found' as const },
      execute: async () => { accepted = true; executions++; return { kind: 'accepted' as const, operationRef: 'operation_delayed' }; } };
    const pending = createFaircoinRenewalConsumer({ repository: delayedRepository, executor, now: () => now }).consume(actor, instruction);
    await issued;
    const acknowledgement = await service().revokeWithDispatchAcknowledgement(actor, { authorizationId: consent.authorizationId, revokedAt: now.toISOString(), revocationEvidenceId: 'revoke_delayed' });
    expect(acknowledgement.alreadyAuthorized).toHaveLength(1);
    const restarted = createFaircoinRenewalConsumer({ repository: durable, executor, now: () => now });
    expect((await restarted.consume(actor, instruction)).status).toBe('indeterminate'); expect(executions).toBe(0);
    release(); expect((await pending).status).toBe('accepted'); expect(executions).toBe(1);
    expect((await restarted.consume(actor, instruction)).status).toBe('accepted');
  });
  it('performs no remote calls unless initial binding and dispatch permit commits are confirmed', async () => {
    const { actor, consent, instruction } = await fixture();
    await service().accept(actor, consent); await service().prepareAutomaticRenewal(actor, instruction);
    const durable = createPostgresFaircoinRenewalRepository(gatewayDb());
    let recoveries = 0; let executions = 0;
    const executor = { domain: 'fixture-provider-v1', recover: async () => { recoveries++; return { kind: 'not_found' as const }; },
      execute: async () => { executions++; return { kind: 'accepted' as const, operationRef: 'operation_commit' }; } };
    const lostBinding = { async transaction<T>() : Promise<T> { throw new Error('unconfirmed binding'); } };
    await expect(createFaircoinRenewalConsumer({ repository: lostBinding, executor, now: () => now }).consume(actor, instruction)).rejects.toThrow('unconfirmed binding');
    expect(recoveries).toBe(0); expect(executions).toBe(0);
    let transactions = 0;
    const uncertainPermit = { async transaction<T>(namespace: string, id: string, action: Parameters<typeof durable.transaction<T>>[2]) {
      const result = await durable.transaction(namespace, id, action);
      if (++transactions === 2) throw new Error('unconfirmed permit');
      return result;
    } };
    await expect(createFaircoinRenewalConsumer({ repository: uncertainPermit, executor, now: () => now }).consume(actor, instruction)).rejects.toThrow('unconfirmed permit');
    expect(recoveries).toBe(1); expect(executions).toBe(0);
    expect((await gatewayDb().select().from(faircoinRenewalAuthorizations))[0]?.executions[0]?.status).toBe('authorized');
  });

});
