import { and, desc, eq, inArray, or } from 'drizzle-orm';
import type { NetworkType } from '@fairco.in/core';
import { isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { socialSendAttributions } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';

/**
 * Reads and writes for `social_send_attributions` — which social-receive
 * address was minted for which sender → recipient payment.
 *
 * Read by `POST /v1/enrich` (via `services/enrichment.ts`) and by
 * `GET /v1/social/me/payments`.
 */

export interface SocialSendAttributionRow {
  readonly id: string;
  readonly address: string;
  readonly network: NetworkType;
  readonly senderUserId: string;
  readonly recipientUserId: string;
  readonly derivationIndex: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const ATTRIBUTION_COLUMNS = {
  id: socialSendAttributions.id,
  address: socialSendAttributions.address,
  network: socialSendAttributions.network,
  senderUserId: socialSendAttributions.senderUserId,
  recipientUserId: socialSendAttributions.recipientUserId,
  derivationIndex: socialSendAttributions.derivationIndex,
  createdAt: socialSendAttributions.createdAt,
  updatedAt: socialSendAttributions.updatedAt,
} as const;

function toAttributionRow(row: { network: string; [key: string]: unknown }): SocialSendAttributionRow {
  return { ...row, network: row.network as NetworkType } as unknown as SocialSendAttributionRow;
}

export interface InsertAttributionParams {
  readonly address: string;
  readonly network: NetworkType;
  readonly senderUserId: string;
  readonly recipientUserId: string;
  readonly derivationIndex: number;
}

/**
 * Record that an address was minted for one payment relationship.
 *
 * @returns the row, or `null` when `(address, network)` is already attributed.
 *   Every non-default social-receive address is single-use, so a second
 *   attribution for one address would mean two payment relationships claiming
 *   it — the unique index refuses that, and converging on it rather than
 *   reading first keeps a concurrent repeat from producing a second row.
 */
export async function insertSendAttribution(
  db: DatabaseOrTransaction,
  params: InsertAttributionParams
): Promise<SocialSendAttributionRow | null> {
  try {
    const [row] = await db
      .insert(socialSendAttributions)
      .values({
        id: uuidv7(),
        address: params.address,
        network: params.network,
        senderUserId: params.senderUserId,
        recipientUserId: params.recipientUserId,
        derivationIndex: params.derivationIndex,
      })
      .returning(ATTRIBUTION_COLUMNS);
    return row ? toAttributionRow(row) : null;
  } catch (error) {
    if (isUniqueViolation(error, 'social_send_attributions_address_network_key')) {
      return null;
    }
    throw error;
  }
}

/**
 * The attributions among `addresses` that THIS viewer is a party to.
 *
 * The viewer predicate is not an optimisation and must not be dropped: an
 * attribution names two Oxy users, and returning one to anybody else would tell
 * a stranger who paid whom. It is expressed in the WHERE clause rather than
 * filtered after the read, so a row the viewer may not see never leaves
 * Postgres.
 *
 * `inArray`, not a `sql` template holding the array — a bare `${array}` renders
 * as a row constructor, which Postgres rejects. The empty case short-circuits to
 * save a round trip, not to avoid an error: measured on drizzle-orm 0.45.2
 * against a real server, `inArray(col, [])` renders `where false` and returns no
 * rows.
 */
export async function findAttributionsForViewer(
  db: DatabaseOrTransaction,
  addresses: readonly string[],
  viewerUserId: string
): Promise<SocialSendAttributionRow[]> {
  if (addresses.length === 0) return [];
  const rows = await db
    .select(ATTRIBUTION_COLUMNS)
    .from(socialSendAttributions)
    .where(
      and(
        inArray(socialSendAttributions.address, [...addresses]),
        or(
          eq(socialSendAttributions.senderUserId, viewerUserId),
          eq(socialSendAttributions.recipientUserId, viewerUserId)
        )
      )
    );
  return rows.map(toAttributionRow);
}

/**
 * Every payment the viewer is party to on one network, newest first.
 *
 * The address-free sibling of `findAttributionsForViewer`. That one exists for
 * a caller that already derived its own addresses and is asking which of THOSE
 * are attributed; this one exists for a caller that cannot derive anything —
 * the web build holds no key, so it cannot know which addresses are its, and
 * the only thing it can prove is who it is signed in as.
 *
 * The viewer predicate is the security property, not a filter: an attribution
 * names two Oxy users, so a missing `or(...)` would hand a stranger the record
 * of who paid whom. `limit` is a bound, not a page — a viewer with more history
 * than this sees the newest slice, which is what a balance-and-recent-activity
 * surface needs; a real pager belongs with a cursor, not an offset.
 */
export async function listAttributionsForViewer(
  db: DatabaseOrTransaction,
  viewerUserId: string,
  network: NetworkType,
  limit = 100
): Promise<SocialSendAttributionRow[]> {
  const rows = await db
    .select(ATTRIBUTION_COLUMNS)
    .from(socialSendAttributions)
    .where(
      and(
        eq(socialSendAttributions.network, network),
        or(
          eq(socialSendAttributions.senderUserId, viewerUserId),
          eq(socialSendAttributions.recipientUserId, viewerUserId)
        )
      )
    )
    .orderBy(desc(socialSendAttributions.createdAt))
    .limit(limit);
  return rows.map(toAttributionRow);
}
