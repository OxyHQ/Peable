/**
 * A FairCoin address is bound to the identity key it was derived from (ADR
 * 0002, amended 2026-11-06) — the ONE place that asks whether that key is
 * still the recipient's.
 *
 * Every address the gateway hands out records the key behind it
 * (`payment_intents.faircoin_identity_public_key`,
 * `payment_intent_outputs.identity_public_key`). When the recipient's DID
 * `#key-1` is no longer that key — a person rotated, an organization replaced
 * the key a departed admin may hold — the address is in a tree the recipient's
 * wallet no longer derives, and paying it sends money to whoever holds the
 * previous key. So:
 *
 * - a payment still waiting for the payer (`requires_action`, nothing
 *   broadcast) is never offered again: it is canceled through
 *   `transitionIntent` with `cancellation_reason: recipient_key_changed`, and
 *   the order wrapping it (a Checkout Session, an invoice) forgets it and stays
 *   open for a fresh reservation under the new key — the path a lapsed quote
 *   already takes (ADR 0021 D3). The payer surfaces check before they answer
 *   (`retireIfRecipientKeyReplaced`) and a periodic sweep catches the rest;
 * - a payment the payer already broadcast is NOT canceled — the coins are on
 *   chain at the reserved address and nothing Peable does moves them — but it is
 *   stamped (`faircoin.recipient_key_replaced_at`) in the transition's own
 *   statement, so the merchant and the recipient see it on the intent and on
 *   every event after, `payment_intent.succeeded` included. The watcher checks
 *   the keys again, fresh, before it ever writes `succeeded`.
 *
 * A payment written before keys were recorded (`unrecorded`) cannot show which
 * key it belongs to: one still waiting for the payer is retired the same way,
 * because "cannot prove it is the current key" is not "current"; a broadcast one
 * is not stamped, because nothing says its key changed. A payment to a
 * registered xpub (no recipient account) is outside identity receive entirely.
 *
 * When Oxy cannot be asked (`unknown`) nothing is changed: a payer read answers
 * the payment as it is and the next sweep looks again; the watcher defers the
 * settlement to its next poll.
 */
import { applyEvent } from '../intentState';
import {
  faircoinOutputsOf,
  findIntentById,
  findKeyBoundFaircoinIntents,
  type PaymentIntentRow,
} from '../../db/payments/paymentIntentRepository';
import { getDb } from '../../db/postgres';
import { announceIntentChange, transitionIntent } from '../intentTransition';
import { resolveIdentityPublicKeyHex } from '../socialReceive';

/** What a FairCoin payment's recorded keys say against the recipients' current `#key-1`. */
export type RecipientKeyCheck =
  /** Not an identity payment: a card, or a FairCoin payment to a registered xpub. */
  | 'not_applicable'
  /** Every output's recorded key is its recipient's current `#key-1`. */
  | 'current'
  /** At least one recipient's current key is not the one its address derives from. */
  | 'replaced'
  /** Written before keys were recorded: which key it belongs to is not known. */
  | 'unrecorded'
  /** Oxy could not be asked. */
  | 'unknown';

/** The current `#key-1` of an account (lowercase hex, `null` keyless). */
export type CurrentKeyReader = (accountId: string) => Promise<string | null>;

/**
 * A payer read may reuse a key read this recent. A reservation never does (it
 * resolves fresh, `services/socialReceive.ts`), and neither does the watcher
 * before `succeeded`; this bound only spares Oxy one read per poll of a
 * checkout page, and every read of the DID refreshes it.
 */
const PAYER_READ_REUSE_MS = 5_000;
const recentKeys = new Map<string, { readonly at: number; readonly key: string | null }>();
const inFlight = new Map<string, Promise<string | null>>();

/** The account's current key read fresh, shared by concurrent callers, remembered briefly. */
async function freshKey(accountId: string): Promise<string | null> {
  const pending = inFlight.get(accountId);
  if (pending) return pending;
  const read = resolveIdentityPublicKeyHex(accountId)
    .then((key) => {
      recentKeys.set(accountId, { at: Date.now(), key });
      return key;
    })
    .finally(() => inFlight.delete(accountId));
  inFlight.set(accountId, read);
  return read;
}

/** Reads `#key-1` with no reuse at all — settlement and the sweep. */
export const readCurrentKeyFresh: CurrentKeyReader = freshKey;

/** Reads `#key-1` for a payer surface: a read up to {@link PAYER_READ_REUSE_MS} old is reused. */
export const readCurrentKeyForPayer: CurrentKeyReader = async (accountId) => {
  const recent = recentKeys.get(accountId);
  if (recent && Date.now() - recent.at < PAYER_READ_REUSE_MS) return recent.key;
  return freshKey(accountId);
};

/** Forget every remembered key read (tests). */
export function forgetRecentIdentityKeys(): void {
  recentKeys.clear();
}

/** Check every output of `intent` against its recipient's current `#key-1`. */
export async function checkRecipientKeys(
  intent: PaymentIntentRow,
  readKey: CurrentKeyReader = readCurrentKeyForPayer,
): Promise<RecipientKeyCheck> {
  if (intent.rail !== 'faircoin') return 'not_applicable';
  const outputs = faircoinOutputsOf(intent).filter((output) => output.recipientAccountId !== null);
  if (outputs.length === 0) return 'not_applicable';
  if (outputs.some((output) => !output.identityPublicKey)) return 'unrecorded';
  const current = new Map<string, string | null>();
  try {
    for (const output of outputs) {
      const account = output.recipientAccountId as string;
      if (!current.has(account)) current.set(account, await readKey(account));
    }
  } catch {
    return 'unknown';
  }
  const replaced = outputs.some(
    (output) => current.get(output.recipientAccountId as string) !== output.identityPublicKey,
  );
  return replaced ? 'replaced' : 'current';
}

/** Whether a check means a payment still waiting for its payer must not be offered. */
function mustRetire(check: RecipientKeyCheck): boolean {
  return check === 'replaced' || check === 'unrecorded';
}

/** A FairCoin payment the payer has not broadcast: the only kind a key change can retire. */
function awaitingPayer(intent: PaymentIntentRow): boolean {
  return intent.rail === 'faircoin' && intent.status === 'requires_action' && intent.txid === null;
}

/**
 * Cancel a FairCoin payment still waiting for the payer whose recipient key was
 * replaced, through `transitionIntent` (`recipient_key_changed`): its order
 * forgets it in the same transaction. Answers the row as it stands afterwards —
 * the canceled one, the unchanged one, or whatever a racing write made it.
 */
export async function retireIfRecipientKeyReplaced(
  intent: PaymentIntentRow,
  readKey: CurrentKeyReader = readCurrentKeyForPayer,
): Promise<PaymentIntentRow> {
  if (!awaitingPayer(intent)) return intent;
  if (!mustRetire(await checkRecipientKeys(intent, readKey))) return intent;
  return retire(intent);
}

async function retire(intent: PaymentIntentRow): Promise<PaymentIntentRow> {
  const result = await transitionIntent(intent.id, {
    from: intent.status,
    status: applyEvent(intent.status, 'cancel', intent.rail),
    cancellationReason: 'recipient_key_changed',
  });
  if (result.kind === 'updated') {
    announceIntentChange(result.row);
    return result.row;
  }
  // The payer broadcast meanwhile (or it expired): answer what is true now.
  return (await findIntentById(getDb(), intent.id)) ?? intent;
}

/**
 * Stamp a broadcast payment found under a replaced key — a same-status write
 * through `transitionIntent`, so the stamp is a compare-and-swap on
 * `processing` like every other write of the row.
 */
async function stampReplaced(intent: PaymentIntentRow): Promise<boolean> {
  const result = await transitionIntent(intent.id, {
    from: 'processing',
    status: 'processing',
    confirmations: intent.confirmations,
    recipientKeyReplaced: true,
  });
  if (result.kind === 'updated') announceIntentChange(result.row);
  return result.kind === 'updated';
}

// ---- The sweep ----------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 60_000;
const PAGE_SIZE = 200;
/** Rows one pass looks at, at most; the next pass resumes after the last. */
const DEFAULT_MAX_PER_PASS = 2_000;

export interface RecipientKeySweepResult {
  readonly examined: number;
  /** `requires_action` payments canceled `recipient_key_changed`. */
  readonly retired: number;
  /** `processing` payments stamped `recipient_key_replaced_at`. */
  readonly stamped: number;
  /** Rows left as they were because Oxy could not be asked. */
  readonly unknown: number;
}

let resumeAfter: string | null = null;

/**
 * One pass over the open identity FairCoin payments: retire the ones waiting
 * for a payer under a replaced (or unrecorded) key, stamp the broadcast ones
 * under a replaced key. Each recipient's key is read once per pass, fresh.
 */
export async function runRecipientKeySweep(
  options: { readonly maxPerPass?: number; readonly readKey?: CurrentKeyReader } = {},
): Promise<RecipientKeySweepResult> {
  const max = options.maxPerPass ?? DEFAULT_MAX_PER_PASS;
  const base = options.readKey ?? readCurrentKeyFresh;
  const perPass = new Map<string, Promise<string | null>>();
  const readKey: CurrentKeyReader = (account) => {
    let read = perPass.get(account);
    if (!read) {
      read = base(account);
      perPass.set(account, read);
    }
    return read;
  };
  const result = { examined: 0, retired: 0, stamped: 0, unknown: 0 };
  while (result.examined < max) {
    const page = await findKeyBoundFaircoinIntents(
      getDb(),
      resumeAfter,
      Math.min(PAGE_SIZE, max - result.examined),
    );
    if (page.length === 0) {
      resumeAfter = null;
      break;
    }
    for (const intent of page) {
      result.examined += 1;
      resumeAfter = intent.id;
      const check = await checkRecipientKeys(intent, readKey);
      if (check === 'unknown') {
        result.unknown += 1;
      } else if (awaitingPayer(intent)) {
        if (mustRetire(check) && (await retire(intent)).status === 'canceled') result.retired += 1;
      } else if (intent.status === 'processing' && check === 'replaced') {
        if (await stampReplaced(intent)) result.stamped += 1;
      }
    }
    if (page.length < PAGE_SIZE) {
      resumeAfter = null;
      break;
    }
  }
  return result;
}

/** Restart the sweep from the first row (tests). */
export function resetRecipientKeySweep(): void {
  resumeAfter = null;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the background sweep. Idempotent; the timer never holds the process open. */
export function startRecipientKeySweeper(options: { readonly intervalMs?: number } = {}): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    void runRecipientKeySweep().catch((error: unknown) => {
      process.emitWarning(
        `Peable recipient key sweep tick failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
}

export function stopRecipientKeySweeper(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
