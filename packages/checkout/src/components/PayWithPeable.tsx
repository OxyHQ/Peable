import type { PaymentIntent } from '@peable.to/shared-types';
import { formatFair } from '@fairco.in/core';
import { buildPayDeepLink } from '../lib/deepLink';
import { Qr } from './Qr';
import { DisplayCurrency } from './DisplayCurrency';

// Heuristic, not a hard guarantee — good enough to decide "can this device
// plausibly handle a custom URL scheme via a same-tab navigation" for the
// mobile-vs-desktop split this button needs. Session-stable, so a plain read
// (not state) is fine.
function isMobileDevice(): boolean {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/**
 * A payment intent that actually has a chain payment behind it.
 *
 * The narrowing is the component's PROP TYPE rather than a check inside it, so
 * `CheckoutView` cannot hand it a card intent and get an empty `address=` in a
 * deep link. `isChainIntent` below is the one place that narrowing is decided
 * (gateway ADR 0001 D6 made both fields nullable).
 */
export type ChainPaymentIntent = PaymentIntent & {
  rail: 'faircoin';
  address: string;
  network: NonNullable<PaymentIntent['network']>;
};

export function isChainIntent(intent: PaymentIntent): intent is ChainPaymentIntent {
  return intent.rail === 'faircoin' && intent.address !== null && intent.network !== null;
}

// Mode A: pay through the Peable wallet app. Mobile opens the `peable://`
// deep link directly; desktop shows a QR of the same link for the payer to
// scan with their phone.
export function PayWithPeable({ intent }: { intent: ChainPaymentIntent }) {
  const deepLink = buildPayDeepLink({
    intentId: intent.id,
    clientSecret: intent.clientSecret,
    address: intent.address,
    amount: intent.amount,
    network: intent.network,
  });

  return (
    <div className="pay-with-peable">
      <p className="pay-with-peable__amount">{formatFair(BigInt(intent.amount))} FAIR</p>
      <DisplayCurrency amount={intent.amount} />
      {isMobileDevice() ? (
        <button
          type="button"
          className="pay-with-peable__button"
          onClick={() => {
            window.location.href = deepLink;
          }}
        >
          Pay with Peable
        </button>
      ) : (
        <div className="pay-with-peable__qr">
          <Qr text={deepLink} size={200} />
          <p className="pay-with-peable__hint">Scan with the Peable app</p>
        </div>
      )}
    </div>
  );
}
