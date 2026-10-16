/**
 * The reference sync loop and the scheduled reconciliation (ADR 0043 D4, D6),
 * against a real database and an in-memory Oxy.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { oxyFileEvents, oxyFileReconciliationRuns, oxyFileReferenceSyncs } from '../../db/schema';
import {
  claimDueReferenceSyncs,
  completeReferenceSync,
  enqueueReferenceSync,
} from '../../db/oxyFiles/referenceSyncRepository';
import { updateMerchantSettings } from '../../db/merchants/merchantRepository';
import { referenceSyncBackoffMs, runReferenceSyncPass } from '../oxyFiles/referenceSync';
import { runReferenceReconciliation } from '../oxyFiles/referenceReconciliation';
import {
  FILE_EVENT_RETENTION_MS,
  RECONCILIATION_RETRY_AFTER_MS,
  RECONCILIATION_STALE_AFTER_MS,
} from '../../db/oxyFiles/reconciliationRunRepository';
import {
  gatewayDb,
  resetGatewayTables,
  seedMerchant,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { createFakeOxyFiles, referenceKey } from '../../__tests__/helpers/fakeOxyFiles';
import { POSTGRES_TESTS_ENABLED } from '../../db/testDatabase';

async function syncRows() {
  return gatewayDb().select().from(oxyFileReferenceSyncs);
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('Oxy file reference sync', () => {
  useGatewayDatabase();
  beforeEach(async () => {
    await resetGatewayTables();
  });

  test('the write queues it; the pass ADDS a wanted reference and removes the row', async () => {
    const files = createFakeOxyFiles([{ id: 'file_logo', ownerApplicationId: 'app' }]);
    const merchant = await seedMerchant({ avatarFileId: 'file_logo' });
    expect(await syncRows()).toHaveLength(1);

    const result = await runReferenceSyncPass({ files });
    expect(result).toEqual({ claimed: 1, added: 1, removed: 0, failed: 0 });
    expect([...files.held]).toEqual([`file_logo|merchant_avatar|${merchant.publicId}`]);
    expect(await syncRows()).toEqual([]);
  });

  test('a cleared avatar is REMOVED; a pair set again before the pass runs stays referenced', async () => {
    const files = createFakeOxyFiles([
      { id: 'file_a', ownerApplicationId: 'app' },
      { id: 'file_b', ownerApplicationId: 'app' },
    ]);
    const merchant = await seedMerchant({ avatarFileId: 'file_a' });
    await runReferenceSyncPass({ files });

    // a → b → a, all before any pass: the queue holds both pairs once each,
    // and each is decided by what the merchant uses NOW.
    await updateMerchantSettings(gatewayDb(), merchant.id, { avatarFileId: 'file_b' });
    await updateMerchantSettings(gatewayDb(), merchant.id, { avatarFileId: 'file_a' });
    expect(await syncRows()).toHaveLength(2);

    await runReferenceSyncPass({ files });
    expect([...files.held].sort()).toEqual([`file_a|merchant_avatar|${merchant.publicId}`]);
    expect(files.removed.map(referenceKey)).toEqual([
      `file_b|merchant_avatar|${merchant.publicId}`,
    ]);

    await updateMerchantSettings(gatewayDb(), merchant.id, { avatarFileId: null });
    await runReferenceSyncPass({ files });
    expect(files.held.size).toBe(0);
  });

  test('a change queued WHILE a pass holds the pair keeps the row for another run', async () => {
    const key = {
      fileId: 'file_race',
      entityType: 'merchant_avatar',
      entityId: 'merch_race',
    } as const;
    await enqueueReferenceSync(gatewayDb(), key);
    const [claimed] = await claimDueReferenceSyncs(gatewayDb(), { limit: 10, leaseMs: 60_000 });
    if (!claimed) throw new Error('nothing claimed');

    // A second, live claimant sees nothing: the lease holds the pair.
    expect(await claimDueReferenceSyncs(gatewayDb(), { limit: 10, leaseMs: 60_000 })).toEqual([]);

    await enqueueReferenceSync(gatewayDb(), key);
    expect(await completeReferenceSync(gatewayDb(), claimed)).toBe(false);
    const [row] = await syncRows();
    expect(row?.version).toBe(1);
    expect(row?.leaseExpiresAt).toBeNull();
  });

  test('a failure is recorded and backed off, never dropped', async () => {
    const files = createFakeOxyFiles([], { failReferences: true });
    const merchant = await seedMerchant({ avatarFileId: 'file_down' });
    const now = new Date();
    const result = await runReferenceSyncPass({ files, now: () => now });
    expect(result.failed).toBe(1);
    const [row] = await syncRows();
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain('unreachable');
    expect(row?.nextAttemptAt.getTime()).toBe(now.getTime() + referenceSyncBackoffMs(1));
    expect(row?.entityId).toBe(merchant.publicId);

    // Not due yet: the next pass leaves it alone.
    expect((await runReferenceSyncPass({ files, now: () => now })).claimed).toBe(0);
    expect(referenceSyncBackoffMs(99)).toBe(6 * 60 * 60_000);
  });
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('Oxy file reference reconciliation', () => {
  useGatewayDatabase();
  beforeEach(async () => {
    await resetGatewayTables();
  });

  async function runs() {
    return gatewayDb().select().from(oxyFileReconciliationRuns);
  }

  test('sends every avatar in use as the inventory, and records the counts', async () => {
    const a = await seedMerchant({ avatarFileId: 'file_one' });
    const b = await seedMerchant({ avatarFileId: 'file_two' });
    await seedMerchant();
    const files = createFakeOxyFiles();
    files.held.add('file_stale|merchant_avatar|merch_gone');

    const [result] = await runReferenceReconciliation({ files, dryRun: false });
    expect(result).toEqual({
      entityType: 'merchant_avatar',
      outcome: 'succeeded',
      dryRun: false,
      added: 2,
      removed: 1,
      unchanged: 0,
      refused: 0,
    });
    expect(files.reconciliations[0]?.items.map((item) => item.entityId).sort()).toEqual(
      [a.publicId, b.publicId].sort(),
    );
    expect(files.held.has('file_stale|merchant_avatar|merch_gone')).toBe(false);
    const [run] = await runs();
    expect([run?.status, run?.added, run?.removed, run?.dryRun]).toEqual([
      'succeeded',
      2,
      1,
      false,
    ]);
  });

  test('dry run: Oxy is asked not to change anything', async () => {
    await seedMerchant({ avatarFileId: 'file_dry' });
    const files = createFakeOxyFiles();
    await runReferenceReconciliation({ files, dryRun: true });
    expect(files.reconciliations[0]?.dryRun).toBe(true);
    expect(files.held.size).toBe(0);
  });

  test('at most once a day; a failure is retried after an hour; force runs by hand', async () => {
    const files = createFakeOxyFiles();
    const now = new Date();
    await runReferenceReconciliation({ files, dryRun: false, now: () => now });
    const [notDue] = await runReferenceReconciliation({ files, dryRun: false, now: () => now });
    expect(notDue?.outcome).toBe('not_due');
    const [forced] = await runReferenceReconciliation({
      files,
      dryRun: false,
      force: true,
      now: () => now,
    });
    expect(forced?.outcome).toBe('succeeded');

    await resetGatewayTables();
    const failing = createFakeOxyFiles([], { failReconcile: true });
    const [failed] = await runReferenceReconciliation({
      files: failing,
      dryRun: false,
      now: () => now,
    });
    expect(failed?.outcome).toBe('failed');
    expect((await runs())[0]?.error).toContain('refused');
    const soon = new Date(now.getTime() + 60_000);
    expect(
      (await runReferenceReconciliation({ files, dryRun: false, now: () => soon }))[0]?.outcome,
    ).toBe('not_due');
    const later = new Date(now.getTime() + RECONCILIATION_RETRY_AFTER_MS + 1);
    expect(
      (await runReferenceReconciliation({ files, dryRun: false, now: () => later }))[0]?.outcome,
    ).toBe('succeeded');
  });

  test('one run at a time: a live claim blocks the next, a dead one is abandoned', async () => {
    const files = createFakeOxyFiles();
    const now = new Date();
    await gatewayDb().insert(oxyFileReconciliationRuns).values({
      id: 'run_live',
      entityType: 'merchant_avatar',
      dryRun: false,
      status: 'running',
      startedAt: now,
    });
    const [blocked] = await runReferenceReconciliation({
      files,
      dryRun: false,
      force: true,
      now: () => now,
    });
    expect(blocked?.outcome).toBe('not_due');

    const later = new Date(now.getTime() + RECONCILIATION_STALE_AFTER_MS + 1);
    const [recovered] = await runReferenceReconciliation({
      files,
      dryRun: false,
      now: () => later,
    });
    expect(recovered?.outcome).toBe('succeeded');
    const [stale] = await gatewayDb()
      .select()
      .from(oxyFileReconciliationRuns)
      .where(eq(oxyFileReconciliationRuns.id, 'run_live'));
    expect(stale?.status).toBe('abandoned');
  });

  test('prunes event dedupe rows Oxy can no longer redeliver', async () => {
    const now = new Date();
    await gatewayDb()
      .insert(oxyFileEvents)
      .values([
        {
          eventId: 'evt_old',
          eventType: 'file.deleted',
          fileId: 'f',
          occurredAt: now,
          receivedAt: new Date(now.getTime() - FILE_EVENT_RETENTION_MS - 1),
        },
        { eventId: 'evt_new', eventType: 'file.deleted', fileId: 'f', occurredAt: now },
      ]);
    await runReferenceReconciliation({
      files: createFakeOxyFiles(),
      dryRun: false,
      now: () => now,
    });
    const left = await gatewayDb().select().from(oxyFileEvents);
    expect(left.map((row) => row.eventId)).toEqual(['evt_new']);
  });
});
