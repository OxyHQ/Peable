import { useEffect, useRef, useState } from 'react';
import type { PaymentIntent } from '@peable.to/shared-types';
import { getClientAction } from '../lib/intentClient';
import {
  loadProviderSdk,
  mountCardElements,
  readRedirectReturn,
  withoutRedirectParams,
  type CardElementsHandle,
} from '../lib/providerJs';

/**
 * The card rail's payer surface: wallets, then the payment fields.
 *
 * `CheckoutView` used to fall a card intent through to `StatusPanel`, with a
 * comment saying "this page has no card surface yet". So a merchant could
 * create a card checkout, send the link, and the payer would arrive at a page
 * showing them the status of a payment they had no way to make.
 *
 * ## What is offered is the intent's, not this page's
 *
 * The gateway created the provider's payment with the merchant's payment
 * method configuration (or the types the merchant named), filtered by
 * currency. The provider's Express Checkout element shows the wallets this
 * device can run — and its slot stays hidden when it runs none, because an
 * empty box reads as a broken page — and its Payment Element the card and
 * local methods the intent offers. Nothing here turns a method on.
 *
 * ## The PAN never touches this app
 *
 * Every field is the provider's own iframe, served from its origin
 * (`lib/providerJs.ts`). This component holds a confirmation credential and two
 * DOM nodes to mount into; it never sees a card number, an IBAN or a bank
 * login, and neither does this bundle, its error reports or its logs.
 *
 * ## Success is not what this component decides
 *
 * `confirmPayment` resolving means the provider accepted the confirmation. It
 * does NOT mean the payment settled — 3-D Secure can still be pending, a bank
 * redirect can bring the payer back before the webhook lands, and a SEPA Debit
 * stays `processing` for days. So this reports what it did and then gets out of
 * the way: the authoritative status arrives over the socket that `CheckoutView`
 * is already subscribed to, driven by a verified webhook.
 */
export function CardPayment({ intent }: { intent: PaymentIntent }) {
  const walletsRef = useRef<HTMLDivElement | null>(null);
  const fieldsRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<CardElementsHandle | null>(null);

  /**
   * A return from a bank's page (iDEAL, Bancontact, EPS) or a 3-D Secure
   * challenge. Read once, on the first render: it says the payer CAME BACK,
   * which is not a payment, so the page shows "confirming" until the socket
   * delivers the gateway's status.
   */
  const [redirectReturn] = useState(() =>
    typeof window === 'undefined' ? null : readRedirectReturn(window.location.search),
  );
  const [phase, setPhase] = useState<'loading' | 'ready' | 'confirming' | 'unavailable'>('loading');
  const [walletsShown, setWalletsShown] = useState(false);
  const [error, setError] = useState<string | null>(
    redirectReturn?.outcome === 'failed'
      ? 'The payment was not completed. You can try again.'
      : null,
  );
  /**
   * The gateway's word on the last attempt (`last_payment_error`, ADR 0019) —
   * shown when this page has nothing more recent, so a payer returning to a
   * declined payment learns why before they try another method.
   */
  const declined =
    intent.status === 'requires_payment_method'
      ? (intent.last_payment_error?.message ?? null)
      : null;
  /**
   * Back from a bank and waiting for the gateway — until the gateway says the
   * attempt failed (`requires_payment_method` with `last_payment_error`), when
   * the form is offered again on the same payment.
   */
  const awaitingReturn =
    redirectReturn?.outcome === 'returned' &&
    !(intent.status === 'requires_payment_method' && intent.last_payment_error !== null);
  const shownPhase = awaitingReturn ? 'confirming' : phase;

  /**
   * The provider appends its own client secret to the return URL. It leaves
   * the address bar, the history and any link the payer copies.
   */
  useEffect(() => {
    if (redirectReturn === null) return;
    window.history.replaceState(
      window.history.state,
      '',
      withoutRedirectParams(window.location.href),
    );
  }, [redirectReturn]);

  /**
   * Fetch the credential and mount the provider's elements.
   *
   * Keyed on the intent's id AND its client secret: `CheckoutView` swaps the
   * whole intent when a link mints a new one, and a form still mounted against
   * the previous payment would confirm the wrong one.
   */
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
          // A redirect-style action, or a deployment with no publishable key
          // configured. Neither is something this component can render, and
          // saying so beats mounting an empty box.
          setPhase('unavailable');
          setError('This payment cannot be completed on this page.');
          return;
        }
        if (!fieldsRef.current) return;

        handleRef.current = mountCardElements({
          sdk: factory(action.publishable_key),
          clientSecret: action.value,
          paymentTarget: fieldsRef.current,
          walletTarget: walletsRef.current,
          /**
           * A method that redirects (a bank, a 3-D Secure challenge) comes back
           * to THIS page, never to the merchant's success URL: that URL is for a
           * payer whose payment this gateway has confirmed, and a return proves
           * only that they came back.
           */
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
        setError(
          cause instanceof Error
            ? cause.message
            : 'The payment form could not be prepared. Please try again.',
        );
      }
    })();

    return () => {
      cancelled = true;
      // The provider's frames are destroyed explicitly: React removes OUR
      // nodes, and an iframe left on a detached parent is a live frame per
      // navigation.
      handleRef.current?.destroy();
      handleRef.current = null;
    };
  }, [intent.id, intent.client_secret, awaitingReturn]);

  async function confirm(): Promise<void> {
    const handle = handleRef.current;
    if (!handle) return;

    setPhase('confirming');
    setError(null);
    try {
      const outcome = await handle.confirm();
      if (outcome.kind === 'declined') {
        // A declined card, an incomplete field, a bank page the payer left.
        // All recoverable: the form stays mounted and they can try again on
        // the same payment, which the provider returns to a confirmable state.
        setPhase('ready');
        setError(outcome.message);
      }
      // Accepted — and deliberately NOT announced as success. Until the
      // gateway's status arrives the payer sees "confirming", which is what is
      // true.
    } catch (cause) {
      setPhase('ready');
      setError(cause instanceof Error ? cause.message : 'This payment could not be confirmed.');
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
        <p className="card-payment__divider">Or pay another way</p>
      </div>

      <div
        ref={fieldsRef}
        className="card-payment__fields"
        data-testid="card-fields"
        hidden={awaitingReturn}
      />

      {shownPhase === 'loading' && (
        <p className="card-payment__hint" aria-live="polite">
          Preparing secure payment fields…
        </p>
      )}

      {awaitingReturn && (
        <p className="card-payment__hint" aria-live="polite">
          Confirming your payment…
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
          className="card-payment__button"
          // Disabled while the form is being prepared and while a confirmation
          // is in flight: a second click during confirmation is the ordinary
          // way a payer creates a duplicate authorization attempt.
          disabled={shownPhase !== 'ready'}
          onClick={() => {
            void confirm();
          }}
        >
          {shownPhase === 'confirming' ? 'Confirming…' : 'Pay'}
        </button>
      )}
    </div>
  );
}

/**
 * Whether this page should render a card form for an intent.
 *
 * Exported so `CheckoutView` asks ONE question rather than re-deriving the
 * condition, the same way `isChainIntent` owns the other rail's.
 *
 * A declined attempt is included: it returns the payment to
 * `requires_payment_method` with `last_payment_error` (ADR 0019), and the payer
 * can try another card on the same payment. Dropping them onto a dead status
 * panel because their first card was declined would lose a sale the payer was
 * still trying to make.
 */
export function isPayableCardIntent(intent: PaymentIntent): boolean {
  return (
    intent.rail === 'card' &&
    (intent.status === 'requires_payment_method' ||
      intent.status === 'requires_confirmation' ||
      intent.status === 'requires_action')
  );
}
