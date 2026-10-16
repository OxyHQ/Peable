/**
 * Reads and writes for `connected_account_links` — the FairCoin onboarding
 * links a SELLER follows to register their key (ADR 0012 D3).
 *
 * Every function takes the token's HASH, never the token. The plaintext exists
 * in one API response and in the seller's address bar; nothing here can store
 * or log it, because nothing here ever receives it.
 */
import { and, eq, gt, isNull } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { connectedAccountLinks } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';

export interface AccountLinkRow {
  readonly id: string;
  readonly connectedAccountId: string;
  readonly returnUrl: string;
  readonly refreshUrl: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly createdAt: Date;
}

/** `token_hash` is deliberately not selected: a caller already holds it, and no reader needs it back. */
const LINK_COLUMNS = {
  id: connectedAccountLinks.id,
  connectedAccountId: connectedAccountLinks.connectedAccountId,
  returnUrl: connectedAccountLinks.returnUrl,
  refreshUrl: connectedAccountLinks.refreshUrl,
  expiresAt: connectedAccountLinks.expiresAt,
  consumedAt: connectedAccountLinks.consumedAt,
  createdAt: connectedAccountLinks.createdAt,
} as const;

export interface InsertAccountLinkParams {
  readonly connectedAccountId: string;
  /** SHA-256 of the token, lowercase hex — the CHECK refuses anything else. */
  readonly tokenHash: string;
  readonly returnUrl: string;
  readonly refreshUrl: string;
  readonly expiresAt: Date;
}

export async function insertAccountLink(
  db: DatabaseOrTransaction,
  params: InsertAccountLinkParams,
): Promise<AccountLinkRow> {
  const [row] = await db
    .insert(connectedAccountLinks)
    .values({
      id: uuidv7(),
      connectedAccountId: params.connectedAccountId,
      tokenHash: params.tokenHash,
      returnUrl: params.returnUrl,
      refreshUrl: params.refreshUrl,
      expiresAt: params.expiresAt,
    })
    .returning(LINK_COLUMNS);
  if (!row) throw new Error('account link insert returned no row');
  return row;
}

/**
 * The link a presented token names, whatever its state.
 *
 * Expired and consumed links are RETURNED, not filtered: the caller answers
 * them differently from an unknown token — 410 with the platform's
 * `refreshUrl`, so the seller is sent back to ask for a fresh one — and a
 * filter here would make every stale link look like a forged one.
 *
 * `forUpdate` locks the row for the registration path, so two tabs submitting
 * one link serialize on it and only one of them consumes it.
 */
export async function findLinkByTokenHash(
  db: DatabaseOrTransaction,
  tokenHash: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<AccountLinkRow | null> {
  const query = db
    .select(LINK_COLUMNS)
    .from(connectedAccountLinks)
    .where(eq(connectedAccountLinks.tokenHash, tokenHash));
  const [row] = await (options.forUpdate ? query.for('update') : query);
  return row ?? null;
}

/**
 * Use the link up. Single-use: `WHERE consumed_at IS NULL AND expires_at > now`,
 * so a link that was already used — or ran out between the read and this
 * write — consumes nothing and the caller refuses.
 *
 * @returns whether THIS call consumed it.
 */
export async function consumeAccountLink(
  db: DatabaseOrTransaction,
  linkId: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(connectedAccountLinks)
    .set({ consumedAt: now })
    .where(
      and(
        eq(connectedAccountLinks.id, linkId),
        isNull(connectedAccountLinks.consumedAt),
        gt(connectedAccountLinks.expiresAt, now),
      ),
    )
    .returning({ id: connectedAccountLinks.id });
  return rows.length === 1;
}
