/**
 * What a payment actually came to — gross, fee, net — and the honest `unknown`.
 *
 * ## What this is, and the much larger thing it is not
 *
 * Issue #70 §13 asks for two different things and they have different owners.
 *
 * The first is a **decision**: which entity bears which cost, and what Peable
 * charges on top. A fee paid by the operator of this deployment is not
 * automatically an expense of the marketplace running on it, and no code can
 * settle that. It is not settled here, and nothing below pretends it is.
 *
 * The second is a **fact**: the provider knows what the charge grossed, what it
 * took, when the money becomes available, and at what rate it converted. That
 * fact was not exposed at all, so a marketplace reconciling its own ledger had
 * nothing from this gateway to reconcile against — which is why Mercaria's
 * router records a successful payment without the processor's cost and
 * therefore cannot answer what the sale earned.
 *
 * Reporting the fact does not prejudge the decision. Attributing it would.
 *
 * ## `unknown` is not zero, and that is the point
 *
 * §13 names this exactly: *"Representar `unknown/pending` frente a cero
 * conocido"*. A settlement report that renders a not-yet-known fee as `0` is
 * one a merchant reconciles against and cannot explain — and zero is a number
 * somebody will subtract. Every figure here is nullable and `status` says which
 * of the three situations produced it.
 *
 * ## Read live, not stored
 *
 * There is no settlement table. A per-merchant journal with balances and
 * reserves is the rest of §13 and needs the decision above first; a table built
 * now would be a second home for figures the provider owns, and the two
 * disagree the first time a write is lost. This reads through, so what a
 * merchant sees is what the provider says right now.
 */
import type { PaymentIntentRow } from "../db/payments/paymentIntentRepository";
import {
  isSettlementReportingProvider,
  UNKNOWN_SETTLEMENT,
  type ProviderSettlement,
} from "./providers/provider";
import { resolveProvider } from "./providers/registry";

/**
 * What the provider says this payment settled to.
 *
 * Answers `unknown` — never throws and never guesses — for every reason a
 * figure might be missing: a FairCoin payment, which takes no fee and has no
 * acquirer balance; a card payment that has not produced a charge yet; a rail
 * this deployment has switched off; a provider that cannot be reached.
 *
 * Those are genuinely different situations and this collapses them into one
 * answer deliberately: the merchant-visible fact is the same in all of them —
 * the figures are not available — and distinguishing "off" from "unreachable"
 * on a merchant's reconciliation endpoint would leak the deployment's own
 * state without telling them anything they can act on.
 */
export async function reportSettlement(
  intent: PaymentIntentRow,
): Promise<ProviderSettlement> {
  if (intent.rail !== "card" || !intent.provider) {
    // The chain rail. Coins arrive at the merchant's own address, this gateway
    // never holds them and takes nothing, so there is no fee to report — and
    // reporting `0` would be a claim about a settlement that does not work that
    // way at all.
    return UNKNOWN_SETTLEMENT;
  }
  // No charge means no balance transaction: the payment has not been captured,
  // or the two-step create never linked. Not a fee of zero.
  if (!intent.providerChargeId) return UNKNOWN_SETTLEMENT;

  const provider = resolveProvider(intent.provider);
  if (!provider || !isSettlementReportingProvider(provider)) return UNKNOWN_SETTLEMENT;

  try {
    return await provider.getSettlement(intent.providerChargeId);
  } catch {
    // A provider that cannot be reached knows the answer; we do not. Saying
    // `unknown` is the only honest response, and it is also what keeps a
    // reconciliation read from failing because of an outage elsewhere.
    return UNKNOWN_SETTLEMENT;
  }
}
