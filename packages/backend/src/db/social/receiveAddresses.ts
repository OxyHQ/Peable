import { and, asc, eq, gt, isNotNull, lte, sql } from 'drizzle-orm';
import type { NetworkType } from '@fairco.in/core';
import { paymentIntentOutputs, socialSendAttributions } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';

/**
 * Every FairCoin address the gateway handed out in one account's Peable wallet
 * (ADR 0021 D9, amended 2026-11-06) — the set the wallet watches.
 *
 * There is no third table: an address is handed out by exactly two writers,
 * and each records it in the transaction that reserved its index on the
 * account's cursor —
 *
 *  - a PAYMENT output (`payment_intent_outputs`): a merchant's, a seller's, an
 *    invoice's, a raw intent's, or one output of a split payment, all through
 *    `createIntent` → `reservePlannedAddresses`;
 *  - an `@username` request (`social_send_attributions`), through
 *    `reserveSocialSendAddress`.
 *
 * Both rows carry the recipient, the network, the index and the key, so the
 * set is their union. Index 0, the stable default address, is never handed out
 * and is the wallet's own.
 *
 * ## The sync cursor is the index
 *
 * The cursor's `INSERT … ON CONFLICT DO UPDATE` takes the cursor row's lock and
 * holds it until the reserving transaction ends, and the address's row is
 * written in that same transaction. So for one account and network a
 * reservation at index `i + 1` cannot commit before the one at `i` has
 * committed or rolled back (and a rollback returns `i` to the cursor): the
 * committed indices only ever grow. A reader that has seen everything up to
 * index `n` misses nothing by asking for `> n` — which is what makes an
 * incremental sync by index exact, with no clock and no commit-order window.
 * (Migration 0113 moved every cursor above the indices already recorded, so
 * this holds for rows written before it too.)
 */

export interface ReceiveAddressRow {
  readonly address: string;
  readonly derivationIndex: number;
  /** Lowercase hex of the key it derives from; `null` on rows written before keys were recorded. */
  readonly identityPublicKey: string | null;
  readonly network: NetworkType;
  readonly createdAt: Date;
}

export interface ReceiveAddressPage {
  readonly addresses: readonly ReceiveAddressRow[];
  readonly hasMore: boolean;
  /** The highest index in the page, or `after` when it is empty. */
  readonly syncCursor: number;
}

type Range = { readonly after: number; readonly through: number | null };

function outputsIn(
  db: DatabaseOrTransaction,
  accountId: string,
  network: NetworkType,
  range: Range,
  limit?: number,
) {
  const query = db
    .select({
      address: paymentIntentOutputs.address,
      derivationIndex: paymentIntentOutputs.derivationIndex,
      identityPublicKey: paymentIntentOutputs.identityPublicKey,
      createdAt: paymentIntentOutputs.createdAt,
    })
    .from(paymentIntentOutputs)
    .where(
      and(
        eq(paymentIntentOutputs.recipientAccountId, accountId),
        eq(paymentIntentOutputs.network, network),
        // An output written before indices were recorded (0105) cannot be
        // derived or signed for from the wallet's key; it has no place here.
        isNotNull(paymentIntentOutputs.derivationIndex),
        gt(paymentIntentOutputs.derivationIndex, range.after),
        range.through === null
          ? undefined
          : lte(paymentIntentOutputs.derivationIndex, range.through),
      ),
    )
    .orderBy(asc(paymentIntentOutputs.derivationIndex), asc(paymentIntentOutputs.address));
  return limit === undefined ? query : query.limit(limit);
}

function attributionsIn(
  db: DatabaseOrTransaction,
  accountId: string,
  network: NetworkType,
  range: Range,
  limit?: number,
) {
  const query = db
    .select({
      address: socialSendAttributions.address,
      derivationIndex: socialSendAttributions.derivationIndex,
      identityPublicKey: socialSendAttributions.identityPublicKey,
      createdAt: socialSendAttributions.createdAt,
    })
    .from(socialSendAttributions)
    .where(
      and(
        eq(socialSendAttributions.recipientUserId, accountId),
        eq(socialSendAttributions.network, network),
        gt(socialSendAttributions.derivationIndex, range.after),
        range.through === null
          ? undefined
          : lte(socialSendAttributions.derivationIndex, range.through),
      ),
    )
    .orderBy(asc(socialSendAttributions.derivationIndex), asc(socialSendAttributions.address));
  return limit === undefined ? query : query.limit(limit);
}

type RawRow = {
  address: string;
  derivationIndex: number | null;
  identityPublicKey: string | null;
  createdAt: Date;
};

/**
 * One page of the account's handed-out addresses with an index above `after`,
 * in ascending index, each address once — at most `limit`, except that a page
 * never ends between two rows of one index (only rows written before keys and
 * cursors were recorded share one), so `sync_cursor` never splits an index.
 *
 * Each table is read by its `(recipient, network, derivation_index)` index,
 * bounded by the page, so a page costs the same at the millionth address as
 * at the first.
 */
export async function listReceiveAddresses(
  db: DatabaseOrTransaction,
  accountId: string,
  network: NetworkType,
  after: number,
  limit: number,
): Promise<ReceiveAddressPage> {
  const open: Range = { after, through: null };
  const [outputs, attributions] = await Promise.all([
    outputsIn(db, accountId, network, open, limit + 1),
    attributionsIn(db, accountId, network, open, limit + 1),
  ]);
  const head = [...outputs, ...attributions].sort(byIndex);
  // The `limit`-th lowest index of the two heads bounds the page. With no more
  // rows than that, neither head was cut, and there is nothing beyond them.
  const bound = head.length > limit ? (head[limit - 1]?.derivationIndex ?? null) : null;
  const rows: RawRow[] =
    bound === null
      ? head
      : (
          await Promise.all([
            outputsIn(db, accountId, network, { after, through: bound }),
            attributionsIn(db, accountId, network, { after, through: bound }),
          ])
        )
          .flat()
          .sort(byIndex);

  const seen = new Set<string>();
  const addresses: ReceiveAddressRow[] = [];
  for (const row of rows) {
    if (row.derivationIndex === null || seen.has(row.address)) continue;
    seen.add(row.address);
    addresses.push({
      address: row.address,
      derivationIndex: row.derivationIndex,
      identityPublicKey: row.identityPublicKey,
      network,
      createdAt: row.createdAt,
    });
  }
  const last = addresses[addresses.length - 1];
  const syncCursor = last?.derivationIndex ?? after;
  const hasMore = bound !== null && (await recordedAbove(db, accountId, network, syncCursor));
  return { addresses, hasMore, syncCursor };
}

/** The index order, then the address (a total order: the page is deterministic). */
function byIndex(a: RawRow, b: RawRow): number {
  const ai = a.derivationIndex ?? -1;
  const bi = b.derivationIndex ?? -1;
  if (ai !== bi) return ai - bi;
  return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
}

/** Whether any address of the account is recorded at an index above `index`. */
async function recordedAbove(
  db: DatabaseOrTransaction,
  accountId: string,
  network: NetworkType,
  index: number,
): Promise<boolean> {
  const range: Range = { after: index, through: null };
  const [outputs, attributions] = await Promise.all([
    outputsIn(db, accountId, network, range, 1),
    attributionsIn(db, accountId, network, range, 1),
  ]);
  return outputs.length > 0 || attributions.length > 0;
}

/**
 * Whether `address` was ever handed out on `network` — as a payment output or
 * an `@username` address. The reservation asks before it hands an index's
 * address out, so an address is never handed out twice even where history
 * left a cursor behind an address it already derived (ADR 0021 D9).
 */
export async function isAddressRecorded(
  db: DatabaseOrTransaction,
  address: string,
  network: NetworkType,
): Promise<boolean> {
  const [row] = await db.execute<{ recorded: boolean }>(
    sql`select (exists (select 1 from ${paymentIntentOutputs} where ${and(eq(paymentIntentOutputs.network, network), eq(paymentIntentOutputs.address, address))}) or exists (select 1 from ${socialSendAttributions} where ${and(eq(socialSendAttributions.network, network), eq(socialSendAttributions.address, address))})) as recorded`,
  );
  return Boolean(row?.recorded);
}
