/**
 * The one place a merchant's ENVIRONMENT is checked against the provider's MODE.
 *
 * ## What separating rows by environment does not do
 *
 * `merchants` is unique on `(oxy_app_id, environment)` and `resolveMerchant`
 * always resolves by both, so a development credential and a production one
 * address different merchants. That is real isolation of DATA and it is not
 * isolation of MONEY: the provider registry answers with one process-wide
 * adapter built from one `STRIPE_SECRET_KEY`, and nothing between the resolved
 * merchant and that adapter ever compared the two. A deployment holding a live
 * key therefore created LIVE charges, refunds, transfers and connected accounts
 * for a merchant registered by a `development` credential — the credential
 * being the weaker one is the whole point of having two.
 *
 * ## Why a guard and not a per-mode client
 *
 * Two clients keyed by environment is the other legitimate model, and it is a
 * bigger change than it looks: the webhook endpoints, their secrets, the stored
 * `provider_events` and every connected account would each need a mode beside
 * them, and a deployment would hold both keys at once. This deployment holds
 * ONE key and serves ONE mode — that is the model ADR 0009 records — so the
 * correct behaviour for a credential from the other environment is a refusal,
 * before any provider call, with a message naming both sides.
 *
 * ## Where it is called
 *
 * Immediately before the FIRST provider call of every operation that spends,
 * moves, returns or onboards: creating a card intent, refunding, transferring,
 * reversing a transfer, and opening or reading a connected account. Not in the
 * registry, because the registry does not know whose credential is asking, and
 * not in the routes alone, because the services are also reached from the
 * dashboard path.
 */
import type { MerchantEnvironment } from "@peable.to/shared-types";
import { config } from "../../config";

/**
 * A credential from one environment reaching a deployment serving the other.
 *
 * Its own error type, and NOT a `ProviderError`: nothing was sent to the
 * provider and nothing is retryable. Routes answer 403 — the request is
 * well-formed and the caller is authenticated, they are simply not authorized
 * to move money in this mode.
 */
export class EnvironmentModeMismatchError extends Error {
  readonly environment: MerchantEnvironment;
  readonly livemode: boolean;

  constructor(environment: MerchantEnvironment, livemode: boolean) {
    super(
      `a '${environment}' credential cannot act on a deployment running in ` +
        `${livemode ? "live" : "test"} mode`,
    );
    this.name = "EnvironmentModeMismatchError";
    this.environment = environment;
    this.livemode = livemode;
  }
}

/**
 * Whether an environment may act on a deployment in this mode.
 *
 * `production` ⟺ live, and nothing else. The three non-production
 * environments are grouped deliberately: Oxy's own `OXY_SERVICE_ENVIRONMENTS`
 * may gain another, and a new one must default to the side that cannot move
 * real money.
 */
export function environmentMatchesMode(
  environment: MerchantEnvironment,
  livemode: boolean,
): boolean {
  return (environment === "production") === livemode;
}

/**
 * Refuse, before anything is sent, when the credential and the deployment
 * disagree about which money is real.
 *
 * @throws {EnvironmentModeMismatchError}
 */
export function assertEnvironmentMatchesProvider(environment: MerchantEnvironment): void {
  if (environmentMatchesMode(environment, config.stripe.livemode)) return;
  throw new EnvironmentModeMismatchError(environment, config.stripe.livemode);
}
