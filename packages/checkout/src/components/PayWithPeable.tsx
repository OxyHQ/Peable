import type { PaymentIntent } from '@peable.to/shared-types';
import { formatFair } from '@fairco.in/core';
import { payDeepLinkFor } from '../lib/deepLink';
import { Qr } from './Qr';
import { DisplayCurrency } from './DisplayCurrency';
import { useI18n } from '../i18n';
import { formatAmount } from '../lib/money';

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
 * (a card intent's `faircoin` is `null` — gateway ADR 0001 D6, ADR 0019).
 */
export type ChainPaymentIntent = PaymentIntent & {
  rail: 'faircoin';
  faircoin: NonNullable<PaymentIntent['faircoin']>;
};

export function isChainIntent(intent: PaymentIntent): intent is ChainPaymentIntent {
  return intent.rail === 'faircoin' && intent.faircoin !== null;
}

// Mode A: pay through the Peable wallet app. Mobile opens the `peable://`
// deep link directly; desktop shows a QR of the same link for the payer to
// scan with their phone.
export function PayWithPeable({ intent }: { intent: ChainPaymentIntent }) {
  const { t, locale } = useI18n();
  const quote = intent.faircoin.quote;
  // Every output of the payment (ADR 0021 D6): one address, or each seller's
  // share in ONE transaction — only the Peable wallet can sign the latter.
  const deepLink = payDeepLinkFor(intent);

  return (
    <div className="pay-with-peable">
      <p className="pay-with-peable__amount">{formatFair(BigInt(intent.amount))} FAIR</p>
      {quote ? (
        // A fiat order paid in FairCoin (ADR 0021): the price it was quoted at,
        // and until when — not a live estimate.
        <div className="pay-with-peable__quote">
          <p>
            {t('faircoinQuote', {
              amount: formatAmount(quote.amount, quote.currency, locale),
              rate: quote.rate,
              currency: quote.currency,
            })}
          </p>
          <p className="pay-with-peable__hint">
            {t('faircoinQuoteValid', {
              time: new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(
                new Date(quote.expires_at * 1000),
              ),
            })}
          </p>
        </div>
      ) : (
        <DisplayCurrency amount={intent.amount} />
      )}
      {isMobileDevice() ? (
        <button
          type="button"
          className="pay-with-peable__button"
          onClick={() => {
            window.location.href = deepLink;
          }}
        >
          {t('payWithPeable')}
        </button>
      ) : (
        <div className="pay-with-peable__qr">
          <Qr text={deepLink} size={200} />
          <p className="pay-with-peable__hint">{t('scanWithPeable')}</p>
        </div>
      )}
    </div>
  );
}
