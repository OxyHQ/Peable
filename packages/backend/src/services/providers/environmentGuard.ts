/**
 * The one place a merchant's ENVIRONMENT selects the provider's MODE (ADR 0017).
 *
 * ## What separating rows by environment does not do on its own
 *
 * `merchants` is unique on `(oxy_app_id, environment)` and `resolveMerchant`
 * always resolves by both, so a development credential and a production one
 * address different merchants. That is real isolation of DATA and it is not
 * isolation of MONEY: what isolates money is which provider key a call is sent
 * with. A deployment holds a test key and a live key side by side, so the
 * question "which key moves this money" has to have one answer, decided by the
 * credential and never by the caller's request.
 *
 * ## The rule
 *
 * `production` ⟺ live, and nothing else. The non-production environments are
 * grouped deliberately: Oxy's own `OXY_SERVICE_ENVIRONMENTS` may gain another,
 * and a new one must default to the side that cannot move real money.
 *
 * This module used to REFUSE a credential whose environment disagreed with the
 * deployment's single key (ADR 0009 §1). With both keys held, there is nothing
 * to disagree with: the guard selects instead, and a test credential's
 * operation is handed the test adapter — it cannot reach the live one, because
 * no path from its environment leads there.
 *
 * ## Where it is called
 *
 * Immediately before the FIRST provider call of every operation that spends,
 * moves, returns or onboards something NEW: creating a card intent, opening a
 * connected account. An operation on a STORED provider object (a refund of a
 * payment, a transfer's reversal, a dispute response, a settlement read, an
 * account refresh, a sweep) selects by that row's own `livemode` instead —
 * `selectStoredProvider` — so it always uses the key that created the object.
 * The two agree for every row a merchant can reach (a merchant's environment is
 * fixed and its `livemode` derived from it), and the row is the one that is
 * true when no credential is present at all.
 */
import type { MerchantEnvironment } from '@peable.to/shared-types';
import {
  type PaymentProvider,
  type ProviderId,
  type ProviderMode,
  providerModeOf,
} from './provider';
import { resolveCardProvider, resolveProvider } from './registry';

/** The mode a credential from this environment acts in. */
export function providerModeFor(environment: MerchantEnvironment): ProviderMode {
  return environment === 'production' ? 'live' : 'test';
}

/**
 * Whether an environment belongs to a mode — `production` ⟺ live.
 *
 * Kept as a predicate for the places that hold BOTH halves and must prove they
 * agree (a configured billing cohort, a recurring mirror).
 */
export function environmentMatchesMode(
  environment: MerchantEnvironment,
  livemode: boolean,
): boolean {
  return (environment === 'production') === livemode;
}

/** The card provider a NEW operation by this credential uses, or `undefined` when that mode is off. */
export function selectCardProvider(environment: MerchantEnvironment): PaymentProvider | undefined {
  return resolveCardProvider(providerModeFor(environment));
}

/** The named provider in the mode this credential acts in. */
export function selectProvider(
  provider: ProviderId,
  environment: MerchantEnvironment,
): PaymentProvider | undefined {
  return resolveProvider(provider, providerModeFor(environment));
}

/** The provider that acts on a STORED object: the one in the row's own mode. */
export function selectStoredProvider(
  provider: ProviderId,
  livemode: boolean,
): PaymentProvider | undefined {
  return resolveProvider(provider, providerModeOf(livemode));
}
