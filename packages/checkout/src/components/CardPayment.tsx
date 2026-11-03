import { useEffect, useRef, useState } from 'react';
import type { PaymentIntent } from '@peable.to/shared-types';
import { useI18n } from '../i18n';
import { getClientAction } from '../lib/intentClient';
import {
  type CardElementsHandle,
  loadProviderSdk,
  mountCardElements,
  readRedirectReturn,
  withoutRedirectParams,
} from '../lib/providerJs';

/**
 * The card rail's payer surface: wallets, then the payment fields — the SDK's
 * one card surface (`mountCardElements`), shared with the embeddable widget.
 *
 * ## What is offered is the intent's, not this page's
 *
 * The gateway created the provider's payment when the payer confirmed the
 * checkout session, with the merchant's payment method configuration filtered
 * by currency. The Express Checkout element shows the wallets this device can
 * run — its slot stays hidden when it runs none — and the Payment Element the
 * card and local methods the intent offers. Nothing here turns a method on.
 *
 * ## The PAN never touches this app
 *
 * Every field is the provider's own iframe, served from its origin. This
 * component holds a confirmation credential and two DOM nodes to mount into;
 * it never sees a card number, an IBAN or a bank login.
 *
 * ## Success is not what this component decides
 *
 * `confirmPayment` resolving means the provider accepted the confirmation. It
 * does NOT mean the payment settled, and it certainly does not complete the
 * checkout session: the authoritative status arrives over the socket
 * `CheckoutView` holds, and the session page redirects only once the gateway
 * says the SESSION is complete.
 */
export function CardPayment({
  intent,
  providerAppearance,
  submitLabel,
}: {
  intent: PaymentIntent;
  /** The provider's Elements `appearance` — the merchant's branding. */
  providerAppearance?: Record<string, unknown> | undefined;
  submitLabel?: string | undefined;
}) {
  const { t, locale } = useI18n();
  const walletsRef = useRef<HTMLDivElement | null>(null);
  const fieldsRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<CardElementsHandle | null>(null);

  /**
   * A return from a bank's page or a 3-D Secure challenge. Read once: it says
   * the payer CAME BACK, which is not a payment, so the page shows
   * "confirming" until the socket delivers the gateway's status.
   */
  const [redirectReturn] = useState(() =>
    typeof window === 'undefined' ? null : readRedirectReturn(window.location.search),
  );
  const [phase, setPhase] = useState<'loading' | 'ready' | 'confirming' | 'unavailable'>('loading');
  const [walletsShown, setWalletsShown] = useState(false);
  const [error, setError] = useState<string | null>(
    redirectReturn?.outcome === 'failed' ? t('paymentNotCompleted') : null,
  );
  /** The gateway's word on the last attempt (`last_payment_error`, ADR 0019). */
  const declined =
    intent.status === 'requires_payment_method'
      ? (intent.last_payment_error?.message ?? null)
      : null;
  /** Back from a bank and waiting for the gateway — until it says the attempt failed. */
  const awaitingReturn =
    redirectReturn?.outcome === 'returned' &&
    !(intent.status === 'requires_payment_method' && intent.last_payment_error !== null);
  const shownPhase = awaitingReturn ? 'confirming' : phase;

  // The appearance is read when the fields mount; a change while mounted is
  // applied with `elements.update` rather than a remount.
  const appearanceRef = useRef(providerAppearance);
  appearanceRef.current = providerAppearance;

  /** The provider appends its own client secret to the return URL; it leaves the address bar. */
  useEffect(() => {
    if (redirectReturn === null) return;
    window.history.replaceState(
      window.history.state,
      '',
      withoutRedirectParams(window.location.href),
    );
  }, [redirectReturn]);

  // Keyed on the intent's id AND client secret: a form mounted against a
  // previous payment would confirm the wrong one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the fields mount once per payment; `t`, the locale and the appearance are read at mount (the appearance is updated in place below)
  useEffect(() => {
    // A payer back from the bank waits for the gateway; mounting a fresh form
    // would invite a second attempt on a payment that may already be paid.
    if (awaitingReturn) return;
    let cancelled = false;
    setPhase('loading');
    setWalletsShown(false);

    void (async () => {
      try {
        const [action, factory] = await Promise.all([
          getClientAction(intent.id, intent.client_secret),
          loadProviderSdk(),
        ]);
        if (cancelled) return;
        if (action.kind !== 'client_secret' || !action.publishable_key) {
          setPhase('unavailable');
          setError(t('cardUnavailable'));
          return;
        }
        if (!fieldsRef.current) return;
        handleRef.current = mountCardElements({
          sdk: factory(action.publishable_key, { locale }),
          clientSecret: action.value,
          paymentTarget: fieldsRef.current,
          walletTarget: walletsRef.current,
          ...(appearanceRef.current ? { appearance: appearanceRef.current } : {}),
          // A redirecting method comes back to THIS page, never to the
          // merchant's success URL: that is for a session the gateway completed.
          returnUrl: withoutRedirectParams(window.location.href),
          onWalletsChange: (wallets) => {
            if (!cancelled) setWalletsShown(wallets.length > 0);
          },
          onWalletOutcome: (outcome) => {
            if (cancelled) return;
            if (outcome.kind === 'declined') {
              setPhase('ready');
              setError(outcome.message);
            } else {
              setPhase('confirming');
              setError(null);
            }
          },
        });
        setPhase('ready');
      } catch (cause) {
        if (cancelled) return;
        setPhase('unavailable');
        setError(cause instanceof Error ? cause.message : t('cardFormFailed'));
      }
    })();

    return () => {
      cancelled = true;
      // The iframes are the provider's; one left on a detached parent is a
      // live frame per navigation.
      handleRef.current?.destroy();
      handleRef.current = null;
    };
  }, [intent.id, intent.client_secret, awaitingReturn]);

  useEffect(() => {
    if (providerAppearance)
      handleRef.current?.elements.update?.({ appearance: providerAppearance });
  }, [providerAppearance]);

  async function confirm(): Promise<void> {
    const handle = handleRef.current;
    if (!handle) return;
    setPhase('confirming');
    setError(null);
    try {
      const outcome = await handle.confirm();
      if (outcome.kind === 'declined') {
        // Recoverable: the form stays and the payer tries again on the same payment.
        setPhase('ready');
        setError(outcome.message || t('cardDeclined'));
      }
      // Accepted — deliberately NOT announced as success.
    } catch (cause) {
      setPhase('ready');
      setError(cause instanceof Error ? cause.message : t('confirmFailed'));
    }
  }

  return (
    <div className="card-payment">
      <div
        className="card-payment__wallets"
        data-testid="wallet-fields"
        hidden={!walletsShown}
        aria-hidden={!walletsShown}
      >
        <div ref={walletsRef} />
        <p className="card-payment__divider">{t('payAnotherWay')}</p>
      </div>

      <div
        ref={fieldsRef}
        className="card-payment__fields"
        data-testid="card-fields"
        hidden={awaitingReturn}
      />

      {shownPhase === 'loading' && (
        <p className="card-payment__hint" aria-live="polite">
          {t('cardPreparing')}
        </p>
      )}

      {awaitingReturn && (
        <p className="card-payment__hint" aria-live="polite">
          {t('confirmingReturn')}
        </p>
      )}

      {(error ?? declined) !== null && (
        <p className="card-payment__error" role="alert">
          {error ?? declined}
        </p>
      )}

      {shownPhase !== 'unavailable' && (
        <button
          type="button"
          className="checkout-button"
          // A second click during confirmation is the ordinary way a payer
          // creates a duplicate authorization attempt.
          disabled={shownPhase !== 'ready'}
          onClick={() => {
            void confirm();
          }}
        >
          {shownPhase === 'confirming' ? t('confirming') : (submitLabel ?? t('pay'))}
        </button>
      )}
    </div>
  );
}

/**
 * Whether this page should render a card form for an intent. A declined
 * attempt is included: it returns the payment to `requires_payment_method`
 * (ADR 0019), and the payer can try another card on the same payment.
 */
export function isPayableCardIntent(intent: PaymentIntent): boolean {
  return (
    intent.rail === 'card' &&
    (intent.status === 'requires_payment_method' ||
      intent.status === 'requires_confirmation' ||
      intent.status === 'requires_action')
  );
}
