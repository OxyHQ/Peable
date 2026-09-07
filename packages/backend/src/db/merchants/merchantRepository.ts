import { and, eq, inArray } from 'drizzle-orm';
import { getNetwork, type NetworkType } from '@fairco.in/core';
import type { OxyServiceEnvironment } from '@oxyhq/core/server';
import { isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { deriveIntentAddress } from '../../services/derivation';
import { merchants } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';

/**
 * Reads and writes for `merchants`.
 *
 * NOT WIRED TO ANY ROUTE YET, and that is deliberate rather than dead code.
 * The route switch is the change that makes `DATABASE_URL` required at boot,
 * which cannot merge until the genesis migration has been applied to the
 * `peable` database — so the repositories land first, unused, and the switch is
 * one small reviewable change afterwards. Do not delete this as unreferenced.
 */

/** A merchant row as every caller here reads it. `webhook_secret` is never selected. */
export interface MerchantRow {
  readonly id: string;
  readonly publicId: string;
  readonly oxyAppId: string;
  readonly environment: OxyServiceEnvironment;
  readonly network: NetworkType;
  readonly xpub: string;
  readonly webhookUrl: string | null;
  readonly requiredConfirmations: number;
  readonly livemode: boolean;
  readonly displayName: string | null;
  readonly avatarFileId: string | null;
  readonly description: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const MERCHANT_COLUMNS = {
  id: merchants.id,
  publicId: merchants.publicId,
  oxyAppId: merchants.oxyAppId,
  environment: merchants.environment,
  network: merchants.network,
  xpub: merchants.xpub,
  webhookUrl: merchants.webhookUrl,
  requiredConfirmations: merchants.requiredConfirmations,
  livemode: merchants.livemode,
  displayName: merchants.displayName,
  avatarFileId: merchants.avatarFileId,
  description: merchants.description,
  createdAt: merchants.createdAt,
  updatedAt: merchants.updatedAt,
} as const;

/**
 * Raised when the extended key handed in is not a spend-incapable watch-only
 * key. Callers translate it into the same refusal the Mongo path produced.
 */
export class WatchOnlyViolationError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'invalid watch-only xpub');
    this.name = 'WatchOnlyViolationError';
  }
}

/**
 * The non-custody firewall, re-implemented because Postgres has no counterpart
 * to a Mongoose hook.
 *
 * ## Read this before touching `insertMerchant`
 *
 * `models/Merchant.ts` enforces this in a `pre('validate')` hook, which runs on
 * EVERY save regardless of the call site — and the repository AGENTS.md calls
 * it "the legal firewall": if a merchant ever hands over an `xprv`, the gateway
 * refuses it rather than silently gaining the ability to spend their funds.
 *
 * A schema has no hooks. There is no CHECK constraint that can express it
 * either — deciding it requires deriving a child key, which is a secp256k1
 * operation and not something SQL can perform. So the guarantee moves from
 * "true of every write by construction" to "true of every write that goes
 * through this function", and the only thing keeping that honest is that
 * `insertMerchant` is the single writer.
 *
 * Nothing fails if this is removed. Every existing test still passes, because
 * a test has to hand in a PRIVATE extended key to notice — which is exactly
 * why `merchantRepository.realdb.test.ts` does.
 */
function assertWatchOnly(xpub: string, network: NetworkType): void {
  try {
    // Deriving index 0 proves the key is usable AND public-only:
    // `deriveIntentAddress` throws on an extended key carrying a private key.
    deriveIntentAddress(xpub, 0, 0, getNetwork(network));
  } catch (error) {
    throw new WatchOnlyViolationError(error);
  }
}

export interface InsertMerchantParams {
  readonly oxyAppId: string;
  readonly environment: OxyServiceEnvironment;
  readonly network: NetworkType;
  readonly xpub: string;
  readonly publicId: string;
  readonly webhookUrl?: string | undefined;
  readonly webhookSecret?: string | undefined;
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
 * @throws {WatchOnlyViolationError} when `xpub` is not a watch-only key.
 */
export async function insertMerchant(
  db: DatabaseOrTransaction,
  params: InsertMerchantParams
): Promise<MerchantRow | null> {
  assertWatchOnly(params.xpub, params.network);

  try {
    // Explicit field list, never a spread of caller input. `livemode` and
    // `next_derivation_index` take their column defaults; `xpub`, `network`
    // and `environment` are immutable afterwards.
    const [row] = await db
      .insert(merchants)
      .values({
        id: uuidv7(),
        publicId: params.publicId,
        oxyAppId: params.oxyAppId,
        environment: params.environment,
        network: params.network,
        xpub: params.xpub,
        webhookUrl: params.webhookUrl ?? null,
        webhookSecret: params.webhookSecret ?? null,
        ...(params.requiredConfirmations === undefined
          ? {}
          : { requiredConfirmations: params.requiredConfirmations }),
        displayName: params.displayName ?? null,
        avatarFileId: params.avatarFileId ?? null,
        description: params.description ?? null,
      })
      .returning(MERCHANT_COLUMNS);

    return row ? toMerchantRow(row) : null;
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
  environment: OxyServiceEnvironment
): Promise<MerchantRow | null> {
  const [row] = await db
    .select(MERCHANT_COLUMNS)
    .from(merchants)
    .where(and(eq(merchants.oxyAppId, oxyAppId), eq(merchants.environment, environment)));
  return row ? toMerchantRow(row) : null;
}

export async function findMerchantById(
  db: DatabaseOrTransaction,
  id: string
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
  ids: readonly string[]
): Promise<MerchantRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select(MERCHANT_COLUMNS)
    .from(merchants)
    .where(inArray(merchants.id, [...ids]));
  return rows.map(toMerchantRow);
}

/**
 * The webhook target, read explicitly because `webhook_secret` is a protected
 * column — see `db/protectedColumns.ts`. Named separately from the merchant
 * reads so a delivery path is the only thing that ever loads a signing key, and
 * so the load stays greppable.
 */
export async function findWebhookTarget(
  db: DatabaseOrTransaction,
  merchantId: string
): Promise<{ url: string; secret: string } | null> {
  const [row] = await db
    .select({ url: merchants.webhookUrl, secret: merchants.webhookSecret })
    .from(merchants)
    .where(eq(merchants.id, merchantId));
  if (!row?.url || !row.secret) return null;
  return { url: row.url, secret: row.secret };
}

export interface MerchantPatch {
  readonly webhookUrl?: string | null | undefined;
  readonly webhookSecret?: string | null | undefined;
  readonly requiredConfirmations?: number | undefined;
  /**
   * Branding is mutable, unlike `xpub`/`network`/`environment`: it names the
   * merchant to a payer and nothing derives from it. `null` clears the field,
   * absent leaves it alone — the same contract `webhookUrl` already has.
   */
  readonly displayName?: string | null | undefined;
  readonly avatarFileId?: string | null | undefined;
  readonly description?: string | null | undefined;
}

/**
 * Apply the MUTABLE merchant fields, and only those.
 *
 * `xpub`, `network`, `environment` and `oxy_app_id` are absent from this
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
  patch: MerchantPatch
): Promise<MerchantRow | null> {
  const values: Record<string, string | number | null> = {};
  if (patch.webhookUrl !== undefined) values.webhookUrl = patch.webhookUrl;
  if (patch.webhookSecret !== undefined) values.webhookSecret = patch.webhookSecret;
  if (patch.requiredConfirmations !== undefined) {
    values.requiredConfirmations = patch.requiredConfirmations;
  }
  if (patch.displayName !== undefined) values.displayName = patch.displayName;
  if (patch.avatarFileId !== undefined) values.avatarFileId = patch.avatarFileId;
  if (patch.description !== undefined) values.description = patch.description;
  if (Object.keys(values).length === 0) {
    return findMerchantById(db, id);
  }

  const [row] = await db
    .update(merchants)
    .set(values)
    .where(eq(merchants.id, id))
    .returning(MERCHANT_COLUMNS);
  return row ? toMerchantRow(row) : null;
}

/**
 * Narrow the two `text` columns the database already constrains to closed sets.
 * The casts are where the CHECK constraints meet TypeScript; they are not
 * widenings, and there is nowhere else in this module they could live.
 */
function toMerchantRow(row: {
  environment: string;
  network: string;
  [key: string]: unknown;
}): MerchantRow {
  return {
    ...row,
    environment: row.environment as OxyServiceEnvironment,
    network: row.network as NetworkType,
  } as MerchantRow;
}
