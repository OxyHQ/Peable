import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { NetworkType } from '@fairco.in/core';
import type { OxyServiceEnvironment } from '@oxy.so/core/server';
import { isUniqueViolation, uuidv7 } from '@oxy.so/db';
import { merchantAvatarAudit, merchants } from '../schema';
import type { MerchantAvatarAuditAction, MerchantAvatarWithheldReason } from '../schema/valueSets';
import type { DatabaseOrTransaction } from '../postgres';
import { enqueueReferenceSync } from '../oxyFiles/referenceSyncRepository';

/**
 * Reads and writes for `merchants`.
 *
 * NOT WIRED TO ANY ROUTE YET, and that is deliberate rather than dead code.
 * The route switch is the change that makes `DATABASE_URL` required at boot,
 * which cannot merge until the genesis migration has been applied to the
 * `peable` database — so the repositories land first, unused, and the switch is
 * one small reviewable change afterwards. Do not delete this as unreferenced.
 */

/** A merchant row as every caller here reads it. */
export interface MerchantRow {
  readonly id: string;
  readonly publicId: string;
  readonly oxyAppId: string;
  readonly environment: OxyServiceEnvironment;
  /**
   * The FairCoin network this merchant's payments use — its environment's
   * (ADR 0021 D5). Every order offers FairCoin.
   */
  readonly network: NetworkType;
  /**
   * The Oxy account that owns the merchant's application, whose Peable wallet
   * receives its FairCoin (ADR 0021 D5); `null` until a request mirrored it.
   */
  readonly ownerAccountId: string | null;
  readonly requiredConfirmations: number;
  readonly livemode: boolean;
  readonly displayName: string | null;
  readonly avatarFileId: string | null;
  /** Why the avatar is not shown to a payer right now, or `null` when it is. */
  readonly avatarWithheld: MerchantAvatarWithheldReason | null;
  /** The logo File's PUBLIC `file_…`, or `null`. */
  readonly businessLogo: string | null;
  /**
   * The logo's Oxy file id, ONLY while the File is available (not withheld,
   * not removed) — what a payer surface may render. `null` otherwise.
   */
  readonly businessLogoOxyFileId: string | null;
  readonly description: string | null;
  /** Oxy's own product (ADR 0015 §2) — the verified authority of the last credential. */
  readonly firstParty: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Mirror the verified authority of the credential (or dashboard application
 * read) acting for this merchant onto the row, when it differs: whether it is
 * Oxy's own product (`authority: 'first_party'`, Oxy ADR 0049) and which Oxy
 * account OWNS its application — the account whose Peable wallet receives its
 * FairCoin (ADR 0021 D5). One conditional statement; a steady state writes
 * nothing. An unknown owner (`undefined`) leaves the stored one.
 */
export async function syncMerchantAuthority(
  db: DatabaseOrTransaction,
  merchant: MerchantRow,
  authority: {
    readonly firstParty?: boolean | undefined;
    readonly ownerAccountId?: string | undefined;
  },
): Promise<MerchantRow> {
  const firstParty = authority.firstParty ?? merchant.firstParty;
  const ownerAccountId = authority.ownerAccountId || merchant.ownerAccountId;
  if (merchant.firstParty === firstParty && merchant.ownerAccountId === ownerAccountId) {
    return merchant;
  }
  const [row] = await db
    .update(merchants)
    .set({ firstParty, ownerAccountId })
    .where(eq(merchants.id, merchant.id))
    .returning(MERCHANT_COLUMNS);
  return row ? toMerchantRow(row) : { ...merchant, firstParty, ownerAccountId };
}

const MERCHANT_COLUMNS = {
  id: merchants.id,
  publicId: merchants.publicId,
  oxyAppId: merchants.oxyAppId,
  environment: merchants.environment,
  network: merchants.network,
  ownerAccountId: merchants.ownerAccountId,
  requiredConfirmations: merchants.requiredConfirmations,
  livemode: merchants.livemode,
  firstParty: merchants.firstParty,
  displayName: merchants.displayName,
  avatarFileId: merchants.avatarFileId,
  avatarWithheld: merchants.avatarWithheld,
  // Table-qualified raw SQL: drizzle renders RETURNING columns unqualified, and
  // an unqualified `"id"` inside a subquery over `files` would bind to the
  // FILE's id (CONVENTIONS.md §Payments core).
  businessLogo: sql<
    string | null
  >`(select "files"."public_id" from "files" where "files"."id" = "merchants"."business_logo_file_id")`,
  businessLogoOxyFileId: sql<
    string | null
  >`(select "files"."oxy_file_id" from "files" where "files"."id" = "merchants"."business_logo_file_id" and "files"."removed_at" is null and "files"."withheld" is null)`,
  description: merchants.description,
  createdAt: merchants.createdAt,
  updatedAt: merchants.updatedAt,
} as const;

/**
 * The confirmations a MAINNET merchant's FairCoin payment needs when the
 * merchant names none (ADR 0021 D10): FairCoin's own coinbase maturity on
 * mainnet (`coinbaseMaturity: 6` in `@fairco.in/core`), about 12 minutes of
 * 2-minute blocks. One confirmation is a single staker's say-so.
 */
export const MAINNET_DEFAULT_REQUIRED_CONFIRMATIONS = 6;

export interface InsertMerchantParams {
  readonly oxyAppId: string;
  readonly environment: OxyServiceEnvironment;
  /** The application's owner account, when the registering caller knows it. */
  readonly ownerAccountId?: string | undefined;
  readonly publicId: string;
  readonly requiredConfirmations?: number | undefined;
  readonly displayName?: string | undefined;
  readonly avatarFileId?: string | undefined;
  readonly description?: string | undefined;
}

/**
 * Register a merchant.
 *
 * @returns the new row, or `null` when one already exists for this application
 *   and environment — the `23505` the partial unique raises, converged on
 *   rather than read first, so two concurrent registrations cannot both win.
 */
export async function insertMerchant(
  db: DatabaseOrTransaction,
  params: InsertMerchantParams,
): Promise<MerchantRow | null> {
  try {
    return await db.transaction(async (tx) => {
      // Explicit field list, never a spread of caller input.
      // `network` follows the environment (ADR 0021 D5) and, like
      // `environment`, is immutable afterwards.
      //
      // `livemode` is DERIVED from `environment` here rather than defaulted.
      // Until this line existed, every row carried `false` including every
      // production merchant — a published field that looked like a test/live
      // guarantee and participated in no decision, which is worse than not
      // having it: an integrator reading `livemode: false` off a production
      // merchant has been told something untrue. `merchants_livemode_agrees_check`
      // now refuses the pair disagreeing, so a second writer cannot reintroduce
      // the drift.
      const [row] = await tx
        .insert(merchants)
        .values({
          id: uuidv7(),
          publicId: params.publicId,
          oxyAppId: params.oxyAppId,
          environment: params.environment,
          livemode: params.environment === 'production',
          network: params.environment === 'production' ? 'mainnet' : 'testnet',
          ownerAccountId: params.ownerAccountId ?? null,
          // ADR 0021 D10: a mainnet merchant that names no threshold settles
          // at 6 confirmations; testnet keeps the column's default of 1.
          ...(params.requiredConfirmations !== undefined
            ? { requiredConfirmations: params.requiredConfirmations }
            : params.environment === 'production'
              ? { requiredConfirmations: MAINNET_DEFAULT_REQUIRED_CONFIRMATIONS }
              : {}),
          displayName: params.displayName ?? null,
          avatarFileId: params.avatarFileId ?? null,
          avatarFileEventAt: params.avatarFileId ? new Date() : null,
          description: params.description ?? null,
        })
        .returning(MERCHANT_COLUMNS);
      if (!row) return null;

      // The avatar's Oxy reference, queued in the SAME transaction as the row
      // that uses the file (ADR 0043 D4) — see `enqueueReferenceSync`.
      if (row.avatarFileId) {
        await enqueueReferenceSync(tx, {
          fileId: row.avatarFileId,
          entityType: 'merchant_avatar',
          entityId: row.publicId,
        });
      }
      return toMerchantRow(row);
    });
  } catch (error) {
    if (isUniqueViolation(error, 'merchants_oxy_app_id_environment_key')) {
      return null;
    }
    throw error;
  }
}

/** Resolve by the pair the test/live firewall is expressed in. Never by app alone. */
export async function findMerchantByAppEnvironment(
  db: DatabaseOrTransaction,
  oxyAppId: string,
  environment: OxyServiceEnvironment,
): Promise<MerchantRow | null> {
  const [row] = await db
    .select(MERCHANT_COLUMNS)
    .from(merchants)
    .where(and(eq(merchants.oxyAppId, oxyAppId), eq(merchants.environment, environment)));
  return row ? toMerchantRow(row) : null;
}

export async function findMerchantById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<MerchantRow | null> {
  const [row] = await db.select(MERCHANT_COLUMNS).from(merchants).where(eq(merchants.id, id));
  return row ? toMerchantRow(row) : null;
}

/**
 * Several merchants in ONE round trip — address enrichment's second lookup.
 *
 * `services/enrichment.ts` resolves up to `ENRICH_MAX_ADDRESSES` (50) addresses
 * to their intents and then to the merchants behind them, and it batches on
 * purpose: the loop that would call {@link findMerchantById} once per address is
 * a 50-query N+1 on a path a wallet calls to render a transaction list.
 *
 * `inArray`, not a `sql` template holding the array — for the reason
 * `findIntentsByAddresses` states: a bare `${array}` inside a `sql` template
 * renders as a ROW CONSTRUCTOR, which Postgres rejects outright, and `tsc`
 * cannot see it.
 *
 * The empty input short-circuits to save a round trip, and NOT to avoid an
 * error — measured on drizzle-orm 0.45.2, against a real server:
 * `inArray(col, [])` renders `where false` and returns no rows. It does not
 * emit `in ()` and does not throw. The three sibling batch reads say otherwise
 * in their own comments; they were written from the older drizzle behaviour and
 * are corrected alongside this one. What the guard buys is one fewer query on a
 * path called once per enrichment batch — worth keeping, worth describing
 * honestly, and not something a mutation test can kill, because removing it
 * changes no observable answer.
 *
 * Returns the merchants that exist, in no promised order, and says nothing about
 * the ids that matched nothing. The caller indexes the result by id — every
 * consumer of a batch read has to handle a missing member anyway, and returning
 * a padded array of nulls would only move that check without removing it.
 */
export async function findMerchantsByIds(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<MerchantRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select(MERCHANT_COLUMNS)
    .from(merchants)
    .where(inArray(merchants.id, [...ids]));
  return rows.map(toMerchantRow);
}

export interface MerchantPatch {
  readonly requiredConfirmations?: number | undefined;
  /**
   * Branding is mutable, unlike `network`/`environment`: it names the
   * merchant to a payer and nothing derives from it. `null` clears the field,
   * absent leaves it alone.
   */
  readonly displayName?: string | null | undefined;
  readonly avatarFileId?: string | null | undefined;
  /**
   * The INTERNAL id of a File of purpose `business_logo` owned by this
   * merchant — resolved and checked by the one writer
   * (`routes/merchants.ts`'s `applyMerchantPatch`); `null` clears it.
   */
  readonly businessLogoFileId?: string | null | undefined;
  readonly description?: string | null | undefined;
}

/**
 * Apply the MUTABLE merchant fields, and only those.
 *
 * `network`, `environment` and `oxy_app_id` are absent from this
 * function's parameter type rather than filtered out of it: changing the
 * derivation key after intents have already derived addresses from it would
 * make every existing address unattributable, and network and environment ARE
 * the test/live firewall. The database agrees — the composite references from
 * `payment_intents`, `checkout_sessions` and `payment_links` carry an implicit
 * `ON UPDATE RESTRICT`, so a write that got past this function would still be
 * refused once any child row exists.
 *
 * An empty patch is a no-op read: drizzle refuses an `update` with no `set`
 * values, and a caller sending `{}` means "change nothing", not "fail".
 */
export async function updateMerchantSettings(
  db: DatabaseOrTransaction,
  id: string,
  patch: MerchantPatch,
): Promise<MerchantRow | null> {
  const values: Record<string, string | number | Date | null> = {};
  if (patch.requiredConfirmations !== undefined) {
    values.requiredConfirmations = patch.requiredConfirmations;
  }
  if (patch.displayName !== undefined) values.displayName = patch.displayName;
  if (patch.avatarFileId !== undefined) values.avatarFileId = patch.avatarFileId;
  if (patch.businessLogoFileId !== undefined) values.businessLogoFileId = patch.businessLogoFileId;
  if (patch.description !== undefined) values.description = patch.description;
  if (Object.keys(values).length === 0) {
    return findMerchantById(db, id);
  }

  return db.transaction(async (tx) => {
    // The avatar is a use of an Oxy file, so changing it changes TWO
    // references: the old file's ends and the new one's begins. The current
    // value is read under the row lock, so two concurrent changes each queue
    // the file the OTHER one replaced rather than both queuing the same stale
    // value — a reference left behind would keep a file "in use" forever.
    if (patch.avatarFileId !== undefined) {
      const [current] = await tx
        .select({ publicId: merchants.publicId, avatarFileId: merchants.avatarFileId })
        .from(merchants)
        .where(eq(merchants.id, id))
        .for('update');
      if (!current) return null;
      if (current.avatarFileId === patch.avatarFileId) {
        delete values.avatarFileId;
      } else {
        // A new file starts with nothing withheld; events about it from before
        // this moment describe a file nobody here was using.
        values.avatarWithheld = null;
        values.avatarFileEventAt = patch.avatarFileId === null ? null : new Date();
        for (const fileId of [current.avatarFileId, patch.avatarFileId]) {
          if (fileId) {
            await enqueueReferenceSync(tx, {
              fileId,
              entityType: 'merchant_avatar',
              entityId: current.publicId,
            });
          }
        }
      }
      if (Object.keys(values).length === 0) return findMerchantById(tx, id);
    }

    const [row] = await tx
      .update(merchants)
      .set(values)
      .where(eq(merchants.id, id))
      .returning(MERCHANT_COLUMNS);
    return row ? toMerchantRow(row) : null;
  });
}

/** The effect of one Oxy file event on the merchants whose avatar it is. */
export interface AvatarFileEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly fileId: string;
  readonly occurredAt: Date;
}

export interface AvatarEventChange {
  readonly merchantId: string;
  readonly action: MerchantAvatarAuditAction;
}

/**
 * The file can never come back (deleted, or blocked on a rights claim): stop
 * using it. Clears the avatar of every merchant using it, writes one audit row
 * each and queues the reference sync that tells Oxy the use ended.
 *
 * Takes a TRANSACTION — the caller's, which also records the event as received,
 * so a redelivery cannot clear twice and a failure clears nothing.
 */
export async function clearMerchantAvatarsForFile(
  tx: DatabaseOrTransaction,
  event: AvatarFileEvent,
): Promise<AvatarEventChange[]> {
  const cleared = await tx
    .update(merchants)
    .set({ avatarFileId: null, avatarWithheld: null, avatarFileEventAt: null })
    .where(eq(merchants.avatarFileId, event.fileId))
    .returning({ id: merchants.id, publicId: merchants.publicId });

  for (const merchant of cleared) {
    await recordAvatarAudit(tx, merchant.id, 'cleared', event);
    await enqueueReferenceSync(tx, {
      fileId: event.fileId,
      entityType: 'merchant_avatar',
      entityId: merchant.publicId,
    });
  }
  return cleared.map((merchant) => ({ merchantId: merchant.id, action: 'cleared' }));
}

/**
 * The file still exists but its owner changed whether Peable can show it
 * (trash, restore, visibility). Sets `avatar_withheld` to `withheld` on every
 * merchant whose CURRENT avatar is the file — unless that merchant already
 * applied a newer event, or set the avatar after this event occurred — and
 * audits each merchant whose display actually changed.
 */
export async function setMerchantAvatarWithheldForFile(
  tx: DatabaseOrTransaction,
  event: AvatarFileEvent,
  withheld: MerchantAvatarWithheldReason | null,
): Promise<AvatarEventChange[]> {
  const candidates = await tx
    .select({ id: merchants.id, avatarWithheld: merchants.avatarWithheld })
    .from(merchants)
    .where(
      and(
        eq(merchants.avatarFileId, event.fileId),
        or(isNull(merchants.avatarFileEventAt), lt(merchants.avatarFileEventAt, event.occurredAt)),
      ),
    )
    .for('update');

  const changes: AvatarEventChange[] = [];
  for (const candidate of candidates) {
    await tx
      .update(merchants)
      .set({ avatarWithheld: withheld, avatarFileEventAt: event.occurredAt })
      .where(eq(merchants.id, candidate.id));
    if (candidate.avatarWithheld === withheld) continue;
    const action: MerchantAvatarAuditAction = withheld === null ? 'released' : 'withheld';
    await recordAvatarAudit(tx, candidate.id, action, event);
    changes.push({ merchantId: candidate.id, action });
  }
  return changes;
}

async function recordAvatarAudit(
  tx: DatabaseOrTransaction,
  merchantId: string,
  action: MerchantAvatarAuditAction,
  event: AvatarFileEvent,
): Promise<void> {
  await tx.insert(merchantAvatarAudit).values({
    id: uuidv7(),
    merchantId,
    fileId: event.fileId,
    action,
    eventId: event.eventId,
    eventType: event.eventType,
  });
}

/**
 * Every (avatar file, merchant public id) pair this database uses, in pages
 * ordered by primary key — the inventory `OxyServer.assets.references.reconcile`
 * compares Oxy's references against. A generator, so a large table is streamed
 * a page at a time rather than read whole.
 */
export async function* listMerchantAvatarUses(
  db: DatabaseOrTransaction,
  pageSize = 500,
): AsyncGenerator<{ fileId: string; entityId: string }> {
  let after: string | null = null;
  for (;;) {
    const page: { id: string; publicId: string; avatarFileId: string | null }[] = await db
      .select({
        id: merchants.id,
        publicId: merchants.publicId,
        avatarFileId: merchants.avatarFileId,
      })
      .from(merchants)
      .where(
        after === null
          ? sql`${merchants.avatarFileId} is not null`
          : and(sql`${merchants.avatarFileId} is not null`, sql`${merchants.id} > ${after}`),
      )
      .orderBy(merchants.id)
      .limit(pageSize);
    for (const row of page) {
      if (row.avatarFileId) yield { fileId: row.avatarFileId, entityId: row.publicId };
    }
    const last = page.at(-1);
    if (!last || page.length < pageSize) return;
    after = last.id;
  }
}

/**
 * Narrow the two `text` columns the database already constrains to closed sets.
 * The casts are where the CHECK constraints meet TypeScript; they are not
 * widenings, and there is nowhere else in this module they could live.
 */
function toMerchantRow(row: {
  environment: string;
  network: string | null;
  [key: string]: unknown;
}): MerchantRow {
  return {
    ...row,
    environment: row.environment as OxyServiceEnvironment,
    // `merchants_avatar_withheld_check` keeps it in the closed set.
    avatarWithheld: (row.avatarWithheld ?? null) as MerchantAvatarWithheldReason | null,
    // `merchants_network_check` keeps the text in the closed set, and
    // `merchants_network_present_check` (0092 backfilled) present.
    network: (row.network ??
      (row.environment === 'production' ? 'mainnet' : 'testnet')) as NetworkType,
  } as MerchantRow;
}
