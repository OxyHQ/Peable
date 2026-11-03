import { useEffect, useRef, useState } from 'react';
import type { BillingFaircoinFxQuote, PaymentIntent } from '@peable.to/shared-types';
import { useLiveIntent } from '../lib/useLiveIntent';
import { useI18n } from '../i18n';
import { formatAmount } from '../lib/money';
import { CardPayment, isPayableCardIntent } from './CardPayment';
import { PayWithPeable, isChainIntent } from './PayWithPeable';
import { StatusPanel } from './StatusPanel';

export interface CheckoutViewProps {
  /** The initial REST snapshot; the realtime subscription supplies every update after it. */
  intent: PaymentIntent;
  /** A FairCoin billing invoice's frozen quote, when the session carries one. */
  billingQuote?: BillingFaircoinFxQuote | undefined;
  /** The provider's Elements `appearance` (the merchant's branding). */
  providerAppearance?: Record<string, unknown> | undefined;
  /** The card Pay button's label. */
  submitLabel?: string | undefined;
  /**
   * Told every time the GATEWAY reports the payment moved — the session page
   * re-reads its session then, because the session's completion is the
   * session's to report, not this view's to infer.
   */
  onIntentChange?: ((intent: PaymentIntent) => void) | undefined;
}

/** A FairCoin payment waits for the payer's broadcast in `requires_action` (ADR 0019). */
const AWAITING_PAYMENT_STATUSES: ReadonlySet<PaymentIntent['status']> = new Set([
  'requires_action',
]);

/**
 * Paying ONE payment: the card form, the FairCoin deep link/QR, or the
 * payment's status — always as the gateway last said it was.
 */
export function CheckoutView({
  intent: initialIntent,
  billingQuote,
  providerAppearance,
  submitLabel,
  onIntentChange,
}: CheckoutViewProps) {
  const { t, locale } = useI18n();
  const intent = useLiveIntent(initialIntent);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!billingQuote) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [billingQuote]);

  // Report a moved payment (not the first snapshot) to whoever owns the session.
  const reported = useRef(`${initialIntent.id}:${initialIntent.status}`);
  useEffect(() => {
    const key = `${intent.id}:${intent.status}`;
    if (key === reported.current) return;
    reported.current = key;
    onIntentChange?.(intent);
  }, [intent, onIntentChange]);

  const quoteExpired =
    billingQuote &&
    (!Number.isSafeInteger(billingQuote.expires_at) ||
      billingQuote.expires_at * 1000 <= now ||
      billingQuote.amount_base_units !== initialIntent.amount);
  const awaitingPayment = AWAITING_PAYMENT_STATUSES.has(intent.status);

  return (
    <div className="checkout-view">
      {billingQuote && (
        <div className="billing-quote">
          <p>
            {t('quoteCatalogue', {
              amount: formatAmount(String(billingQuote.gross_minor_units), 'USD', locale),
            })}
          </p>
          <p>
            {t('quotePayment', {
              amount: formatAmount(billingQuote.amount_base_units, 'FAIR', locale),
            })}
          </p>
          <p>{t('quoteRate', { rate: billingQuote.usd_per_fair })}</p>
          <p>
            {t('quoteExpires', {
              time: new Date(billingQuote.expires_at * 1000).toLocaleString(locale),
            })}
          </p>
        </div>
      )}
      {awaitingPayment && quoteExpired ? (
        <p role="alert">{t('quoteExpired')}</p>
      ) : awaitingPayment && isChainIntent(intent) ? (
        <PayWithPeable intent={intent} />
      ) : isPayableCardIntent(intent) ? (
        /**
         * `isPayableCardIntent` and not `awaitingPayment`: the two rails wait
         * in different statuses, and a DECLINED card payment is back in
         * `requires_payment_method` — still payable, with another card.
         */
        <CardPayment
          intent={intent}
          providerAppearance={providerAppearance}
          submitLabel={submitLabel}
        />
      ) : (
        <StatusPanel intent={intent} />
      )}
    </div>
  );
}
