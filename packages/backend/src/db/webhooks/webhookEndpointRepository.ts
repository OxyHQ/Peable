import { and, eq, sql } from 'drizzle-orm';
import {
  WEBHOOK_ENDPOINTS_MAX_PER_MERCHANT,
  type WebhookEnabledEvent,
  type WebhookEndpointDisabledReason,
  type WebhookEndpointStatus,
} from '@peable.to/shared-types';
import { uuidv7 } from '@oxy.so/db';
import { merchants, webhookEndpoints } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';
import { keyset, type KeysetPage } from '../keyset';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import { mergedMetadata, metadataWithinLimit, type MetadataPatch } from '../metadata';

/**
 * Reads and writes for `webhook_endpoints` (ADR 0014 D4).
 *
 * `secret` and `previous_secret` are protected columns: no row type here
 * carries them. The two paths that need them name them explicitly —
 * `findEndpointSigningTarget` (the dispatcher, to sign) and the writers that
 * store a freshly generated one, which return it once to the route that shows
 * it.
 */

/**
 * How long an endpoint may fail every delivery before it is disabled — the
 * same three days the retry schedule spans, so a delivery that exhausts its
 * budget against a dead endpoint is also what disables it.
 */
export const WEBHOOK_ENDPOINT_FAILING_DAYS = 3;

export interface WebhookEndpointRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  /** The merchant's mode (ADR 0017). */
  readonly livemode: boolean;
  readonly url: string;
  readonly description: string | null;
  readonly enabledEvents: WebhookEnabledEvent[];
  readonly metadata: Record<string, string>;
  readonly apiVersion: string;
  readonly status: WebhookEndpointStatus;
  readonly disabledReason: WebhookEndpointDisabledReason | null;
  readonly failingSince: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const ENDPOINT_COLUMNS = {
  livemode: merchantLivemodeOf(webhookEndpoints.merchantId),
  id: webhookEndpoints.id,
  publicId: webhookEndpoints.publicId,
  merchantId: webhookEndpoints.merchantId,
  url: webhookEndpoints.url,
  description: webhookEndpoints.description,
  enabledEvents: webhookEndpoints.enabledEvents,
  metadata: webhookEndpoints.metadata,
  apiVersion: webhookEndpoints.apiVersion,
  status: webhookEndpoints.status,
  disabledReason: webhookEndpoints.disabledReason,
  failingSince: webhookEndpoints.failingSince,
  createdAt: webhookEndpoints.createdAt,
  updatedAt: webhookEndpoints.updatedAt,
} as const;

function toEndpointRow(row: {
  enabledEvents: string[];
  status: string;
  disabledReason: string | null;
  [key: string]: unknown;
}): WebhookEndpointRow {
  return {
    ...row,
    enabledEvents: row.enabledEvents as WebhookEnabledEvent[],
    status: row.status as WebhookEndpointStatus,
    disabledReason: row.disabledReason as WebhookEndpointDisabledReason | null,
  } as unknown as WebhookEndpointRow;
}

export interface InsertEndpointParams {
  readonly publicId: string;
  readonly merchantId: string;
  readonly url: string;
  readonly description?: string | undefined;
  readonly enabledEvents: readonly WebhookEnabledEvent[];
  readonly metadata: Record<string, string>;
  readonly apiVersion: string;
  readonly secret: string;
}

/**
 * Create an endpoint, unless the merchant already holds the maximum.
 *
 * The count and the insert are serialized per merchant by locking the
 * merchant's row first: two concurrent creates at fifteen would otherwise both
 * count fifteen and both insert. The lock is the merchant row's, which every
 * other writer of it takes briefly anyway.
 */
export async function insertEndpoint(
  db: DatabaseOrTransaction,
  params: InsertEndpointParams,
): Promise<WebhookEndpointRow | 'limit_reached'> {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: merchants.id })
      .from(merchants)
      .where(eq(merchants.id, params.merchantId))
      .for('update');
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.merchantId, params.merchantId));
    if ((count?.n ?? 0) >= WEBHOOK_ENDPOINTS_MAX_PER_MERCHANT) return 'limit_reached';
    const [row] = await tx
      .insert(webhookEndpoints)
      .values({
        id: uuidv7(),
        publicId: params.publicId,
        merchantId: params.merchantId,
        url: params.url,
        description: params.description ?? null,
        enabledEvents: [...params.enabledEvents],
        metadata: params.metadata,
        apiVersion: params.apiVersion,
        secret: params.secret,
      })
      .returning(ENDPOINT_COLUMNS);
    if (!row) throw new Error('webhook endpoint insert returned no row');
    return toEndpointRow(row);
  });
}

/** One endpoint by its public `we_…`, scoped to the merchant. */
export async function findEndpointForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<WebhookEndpointRow | null> {
  const [row] = await db
    .select(ENDPOINT_COLUMNS)
    .from(webhookEndpoints)
    .where(
      and(eq(webhookEndpoints.publicId, publicId), eq(webhookEndpoints.merchantId, merchantId)),
    );
  return row ? toEndpointRow(row) : null;
}

/** How many endpoints a merchant has, enabled or not. */
export async function countEndpointsForMerchant(
  db: DatabaseOrTransaction,
  merchantId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.merchantId, merchantId));
  return row?.n ?? 0;
}

/** One page of a merchant's endpoints, newest first. */
export async function listEndpointsForMerchant(
  db: DatabaseOrTransaction,
  params: { readonly merchantId: string; readonly page: KeysetPage },
): Promise<{ data: WebhookEndpointRow[]; hasMore: boolean }> {
  const walk = keyset(webhookEndpoints.id, webhookEndpoints.createdAt, params.page);
  const rows = await db
    .select(ENDPOINT_COLUMNS)
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.merchantId, params.merchantId), walk.where))
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toEndpointRow));
}

export interface EndpointPatch {
  readonly url?: string | undefined;
  /** `null` clears it. */
  readonly description?: string | null | undefined;
  readonly enabledEvents?: readonly WebhookEnabledEvent[] | undefined;
  /** `true` disables (by the merchant); `false` re-enables, whatever disabled it. */
  readonly disabled?: boolean | undefined;
  readonly metadata?: MetadataPatch | undefined;
}

/**
 * Apply an update in one statement, re-reading the row it wrote.
 *
 * Re-enabling clears `failing_since` with the reason: the three-day clock
 * starts again from the merchant's decision, not from the failures that
 * disabled it.
 */
export async function updateEndpoint(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
  patch: EndpointPatch,
): Promise<WebhookEndpointRow | 'missing' | 'limit_exceeded'> {
  const scope = and(
    eq(webhookEndpoints.publicId, publicId),
    eq(webhookEndpoints.merchantId, merchantId),
  );
  const values: Partial<typeof webhookEndpoints.$inferInsert> = {};
  if (patch.url !== undefined) values.url = patch.url;
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.enabledEvents !== undefined) values.enabledEvents = [...patch.enabledEvents];
  if (patch.disabled === true) {
    values.status = 'disabled';
    values.disabledReason = 'disabled_by_merchant';
  } else if (patch.disabled === false) {
    values.status = 'enabled';
    values.disabledReason = null;
    values.failingSince = null;
  }
  const merged = patch.metadata ? mergedMetadata(webhookEndpoints.metadata, patch.metadata) : null;
  const [row] = await db
    .update(webhookEndpoints)
    .set({
      ...values,
      ...(merged ? { metadata: merged } : {}),
      // Always touched, so an update that changes nothing still answers the row.
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(merged ? and(scope, metadataWithinLimit(merged)) : scope)
    .returning(ENDPOINT_COLUMNS);
  if (row) return toEndpointRow(row);
  const [exists] = await db.select({ id: webhookEndpoints.id }).from(webhookEndpoints).where(scope);
  return exists ? 'limit_exceeded' : 'missing';
}

/**
 * Delete an endpoint. Its deliveries go with it (`cascade`), pending ones
 * included — which is what deleting an endpoint means.
 */
export async function deleteEndpoint(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<boolean> {
  const rows = await db
    .delete(webhookEndpoints)
    .where(
      and(eq(webhookEndpoints.publicId, publicId), eq(webhookEndpoints.merchantId, merchantId)),
    )
    .returning({ id: webhookEndpoints.id });
  return rows.length > 0;
}

/**
 * Replace the signing secret, keeping the current one signing beside it until
 * `previousExpiresAt` — or dropping it at once when that is `null`.
 *
 * One statement, and the current secret is moved by the database rather than
 * read and written back: two concurrent rolls must not both keep the same
 * "previous" and lose the secret the first one issued.
 */
export async function rollEndpointSecret(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
  params: { readonly secret: string; readonly previousExpiresAt: Date | null },
): Promise<WebhookEndpointRow | null> {
  const keep = params.previousExpiresAt !== null;
  const [row] = await db
    .update(webhookEndpoints)
    .set({
      secret: params.secret,
      previousSecret: keep ? sql`${webhookEndpoints.secret}` : null,
      previousSecretExpiresAt: params.previousExpiresAt,
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(
      and(eq(webhookEndpoints.publicId, publicId), eq(webhookEndpoints.merchantId, merchantId)),
    )
    .returning(ENDPOINT_COLUMNS);
  return row ? toEndpointRow(row) : null;
}

/** Where a delivery is sent, and every secret that signs it right now. */
export interface EndpointSigningTarget {
  readonly url: string;
  readonly status: WebhookEndpointStatus;
  /** The current secret first, then the rolled one while it is still inside its window. */
  readonly secrets: readonly string[];
  /** The merchant's mode (ADR 0017): a live endpoint's URL must be https. */
  readonly livemode: boolean;
  /**
   * The merchant's VERIFIED first-party authority (`merchants.first_party`,
   * mirrored from the credential by `resolveMerchant`) — never branding. Only
   * such a merchant's endpoint may be sent through Oxy's own transport.
   */
  readonly firstParty: boolean;
}

/**
 * The one read allowed to select the secrets. The previous one is included
 * only while `previous_secret_expires_at` is in the future, judged by the
 * database's clock — the one the roll wrote it with.
 */
export async function findEndpointSigningTarget(
  db: DatabaseOrTransaction,
  endpointId: string,
): Promise<EndpointSigningTarget | null> {
  const [row] = await db
    .select({
      url: webhookEndpoints.url,
      status: webhookEndpoints.status,
      livemode: merchants.livemode,
      firstParty: merchants.firstParty,
      secret: webhookEndpoints.secret,
      previousSecret: sql<
        string | null
      >`case when ${webhookEndpoints.previousSecretExpiresAt} > now() then ${webhookEndpoints.previousSecret} end`,
    })
    .from(webhookEndpoints)
    .innerJoin(merchants, eq(merchants.id, webhookEndpoints.merchantId))
    .where(eq(webhookEndpoints.id, endpointId));
  if (!row) return null;
  return {
    url: row.url,
    status: row.status as WebhookEndpointStatus,
    secrets: row.previousSecret ? [row.secret, row.previousSecret] : [row.secret],
    livemode: row.livemode,
    firstParty: row.firstParty,
  };
}

/**
 * Disable an ENABLED endpoint for `reason`, in one guarded statement: an
 * endpoint already disabled keeps the reason it has. The row stays — its
 * deliveries are the record of what was (not) sent.
 *
 * @returns `true` when this call disabled it.
 */
export async function disableEndpoint(
  db: DatabaseOrTransaction,
  endpointId: string,
  reason: WebhookEndpointDisabledReason,
): Promise<boolean> {
  const rows = await db
    .update(webhookEndpoints)
    .set({
      status: 'disabled',
      disabledReason: reason,
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.status, 'enabled')))
    .returning({ id: webhookEndpoints.id });
  return rows.length > 0;
}

/**
 * Fold one attempt into the endpoint's failure run, in ONE statement.
 *
 * A delivered attempt ends the run. A failed one starts it (if none is open)
 * and, when the run is already {@link WEBHOOK_ENDPOINT_FAILING_DAYS} days old,
 * disables the endpoint with `delivery_failures`. Doing the comparison and the
 * write together is what keeps two dispatchers from disagreeing about it.
 *
 * Writes nothing in the common case — a success on an endpoint with no open
 * run — so the busiest path does not touch the row.
 *
 * @returns `true` when this attempt disabled the endpoint.
 */
export async function recordEndpointAttempt(
  db: DatabaseOrTransaction,
  endpointId: string,
  params: { readonly delivered: boolean; readonly now: Date },
): Promise<boolean> {
  if (params.delivered) {
    await db
      .update(webhookEndpoints)
      .set({ failingSince: null })
      .where(
        and(eq(webhookEndpoints.id, endpointId), sql`${webhookEndpoints.failingSince} is not null`),
      );
    return false;
  }
  const since = sql`coalesce(${webhookEndpoints.failingSince}, ${params.now.toISOString()}::timestamptz)`;
  const expired = sql`${since} <= ${params.now.toISOString()}::timestamptz - make_interval(days => ${WEBHOOK_ENDPOINT_FAILING_DAYS})`;
  const rows = await db
    .update(webhookEndpoints)
    .set({
      failingSince: sql`${since}`,
      status: sql`case when ${expired} then 'disabled' else ${webhookEndpoints.status} end`,
      disabledReason: sql`case when ${expired} then 'delivery_failures' else ${webhookEndpoints.disabledReason} end`,
    })
    .where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.status, 'enabled')))
    .returning({ status: webhookEndpoints.status });
  return rows[0]?.status === 'disabled';
}
