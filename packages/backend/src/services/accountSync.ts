/**
 * The account sync sweep: what makes a missed `account.updated` converge.
 *
 * `handleAccountEvent` in the drain keeps readiness fresh when the provider's
 * delivery arrives. This exists for when it does not — an endpoint
 * misconfigured for a week, an event Stripe dropped, an account whose
 * capability was granted before this gateway ever subscribed. Without it, a
 * seller who completed onboarding during any of that stays unpayable forever
 * and nothing anywhere says why.
 *
 * **Least-recently-synced first, never-synced ahead of everything.** That
 * ordering is the whole design: the accounts nothing is known about are the
 * ones most likely to be wrong, and PostgreSQL's default `ASC` puts NULLs
 * LAST — which would have queued them behind every account already known to be
 * fine. `findAccountsToSync` says `NULLS FIRST` explicitly for that reason.
 *
 * Deliberately slow. A batch of a few accounts every few minutes is enough to
 * clear a backlog in an hour and cannot become a stampede against the
 * provider's rate limit — which, unlike this gateway's own, is shared with
 * every real payment in flight.
 */
import {
  type ConnectedAccountRow,
  findAccountsToSync,
} from '../db/accounts/connectedAccountRepository';
import { getDb } from '../db/postgres';
import { refreshConnectedAccount } from './accounts/connectedAccountService';
import { AccountsUnavailableError } from './accounts/connectedAccountService';
import { redactProviderMessage } from './providers/redact';
import type { ProviderId } from './providers/provider';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Small on purpose. Each account is one provider round trip, and the queue is
 * ordered so that a backlog drains oldest-first across passes rather than in
 * one burst.
 */
const DEFAULT_BATCH_SIZE = 10;

export interface SyncPassOptions {
  readonly batchSize?: number;
  readonly provider?: ProviderId;
}

export interface SyncPassResult {
  readonly examined: number;
  readonly refreshed: number;
  readonly failed: number;
}

/**
 * One pass.
 *
 * A failure on one account does not stop the rest: a single seller whose
 * account the provider refuses to read would otherwise hold up every account
 * behind it, permanently, because the queue is ordered by sync time and a
 * never-synced failure stays at the front.
 */
export async function runAccountSyncPass(options: SyncPassOptions = {}): Promise<SyncPassResult> {
  const provider = options.provider ?? 'stripe';
  let accounts: readonly ConnectedAccountRow[];
  try {
    accounts = await findAccountsToSync(getDb(), provider, options.batchSize ?? DEFAULT_BATCH_SIZE);
  } catch {
    return { examined: 0, refreshed: 0, failed: 0 };
  }

  let refreshed = 0;
  let failed = 0;

  for (const account of accounts) {
    try {
      await refreshConnectedAccount(account);
      refreshed += 1;
    } catch (error) {
      if (error instanceof AccountsUnavailableError) {
        // The rail is off. Every account in the batch would fail the same way,
        // so stopping is honest rather than logging the same line ten times.
        return { examined: accounts.length, refreshed, failed };
      }
      failed += 1;
      process.emitWarning(
        `Peable account sync failed for ${account.publicId}: ${
          error instanceof Error ? redactProviderMessage(error.message) : 'unknown error'
        }`,
      );
    }
  }

  return { examined: accounts.length, refreshed, failed };
}

let timer: ReturnType<typeof setInterval> | null = null;

export interface StartSyncOptions extends SyncPassOptions {
  readonly intervalMs?: number;
}

export function startAccountSync(options: StartSyncOptions = {}): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    void runAccountSyncPass(options).catch((error: unknown) => {
      process.emitWarning(
        `Peable account sync tick failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  // Same as every other loop in this service: it must never be the reason a
  // process or a test run refuses to exit.
  timer.unref?.();
}

export function stopAccountSync(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
