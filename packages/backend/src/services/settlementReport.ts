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
 *
 * ## A payment, a refund, a dispute — one movement each
 *
 * Each read reports ONE movement of the settlement balance in the same shape
 * and the same signs (`ProviderSettlement`): `gross` the magnitude, `fee` the
 * provider's fee on that movement, `net` its signed effect — positive for a
 * payment, negative for a refund or a dispute withdrawal. A marketplace books
 * a refund or a dispute in the currency the money actually moved in, which is
 * the settlement currency, not the payment's.
 */
import type { DisputeRow } from '../db/disputes/disputeRepository';
import type { PaymentIntentRow } from '../db/payments/paymentIntentRepository';
import type { RefundRow } from '../db/refunds/refundRepository';
import {
  isSettlementReportingProvider,
  type ProviderId,
  type ProviderSettlement,
  type SettlementReportingProvider,
  UNKNOWN_SETTLEMENT,
} from './providers/provider';
import { selectStoredProvider } from './providers/environmentGuard';

/**
 * The ONE read every settlement figure goes through: the stored object's own
 * provider, in the row's own mode (ADR 0017), asked once.
 *
 * Answers `unknown` — never throws and never guesses — when the row names no
 * provider object, the rail is switched off on this deployment or cannot
 * report, or the provider cannot be reached.
 *
 * Those are genuinely different situations and this collapses them into one
 * answer deliberately: the merchant-visible fact is the same in all of them —
 * the figures are not available — and distinguishing "off" from "unreachable"
 * on a merchant's reconciliation endpoint would leak the deployment's own
 * state without telling them anything they can act on.
 */
async function readSettlement(
  stored: {
    readonly provider: ProviderId;
    readonly livemode: boolean;
    readonly providerObjectId: string | null;
  },
  read: (provider: SettlementReportingProvider, objectId: string) => Promise<ProviderSettlement>,
): Promise<ProviderSettlement> {
  if (!stored.providerObjectId) return UNKNOWN_SETTLEMENT;
  const provider = selectStoredProvider(stored.provider, stored.livemode);
  if (!provider || !isSettlementReportingProvider(provider)) return UNKNOWN_SETTLEMENT;
  try {
    return await read(provider, stored.providerObjectId);
  } catch {
    // A provider that cannot be reached knows the answer; we do not. Saying
    // `unknown` is the only honest response, and it is also what keeps a
    // reconciliation read from failing because of an outage elsewhere.
    return UNKNOWN_SETTLEMENT;
  }
}

/**
 * What the provider says this payment settled to.
 *
 * `unknown` for a FairCoin payment, which takes no fee and has no acquirer
 * balance, and for a card payment that has not produced a charge yet — plus
 * every reason {@link readSettlement} gives.
 */
export function reportSettlement(intent: PaymentIntentRow): Promise<ProviderSettlement> {
  if (intent.rail !== 'card' || !intent.provider) {
    // The chain rail. Coins arrive at the merchant's own address, this gateway
    // never holds them and takes nothing, so there is no fee to report — and
    // reporting `0` would be a claim about a settlement that does not work that
    // way at all.
    return Promise.resolve(UNKNOWN_SETTLEMENT);
  }
  // No charge means no balance transaction: the payment has not been captured,
  // or the two-step create never linked. Not a fee of zero.
  return readSettlement(
    {
      provider: intent.provider,
      livemode: intent.livemode,
      providerObjectId: intent.providerChargeId,
    },
    (provider, chargeId) => provider.getSettlement(chargeId),
  );
}

/**
 * What a refund took off the settlement balance, as the provider reports it.
 *
 * `unknown` for a refund the provider never acknowledged (no provider object:
 * the call failed or has not returned) and for one that failed or was
 * canceled — it took nothing in the end — plus every reason
 * {@link readSettlement} gives.
 */
export function reportRefundSettlement(refund: RefundRow): Promise<ProviderSettlement> {
  return readSettlement(refund, (provider, refundId) => provider.getRefundSettlement(refundId));
}

/**
 * What a dispute withdrew from the settlement balance — principal and dispute
 * fee — as the provider reports it. `unknown` for an inquiry, which moves no
 * money, plus every reason {@link readSettlement} gives.
 */
export function reportDisputeSettlement(dispute: DisputeRow): Promise<ProviderSettlement> {
  return readSettlement(
    {
      // The column is text; the drain only ever writes a provider it knows.
      provider: dispute.provider as ProviderId,
      livemode: dispute.livemode,
      providerObjectId: dispute.providerObjectId,
    },
    (provider, disputeId) => provider.getDisputeSettlement(disputeId),
  );
}
