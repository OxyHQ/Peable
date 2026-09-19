import { useEffect, useRef, useState } from 'react';
import type { PaymentIntent } from '@peable.to/shared-types';
import { getClientAction } from '../lib/intentClient';
import {
  loadProviderSdk,
  type ProviderElements,
  type ProviderSdk,
} from '../lib/providerJs';

/**
 * The card surface — the half of this page that did not exist.
 *
 * `CheckoutView` used to fall a card intent through to `StatusPanel`, with a
 * comment saying "this page has no card surface yet". So a merchant could
 * create a card checkout, send the link, and the payer would arrive at a page
 * showing them the status of a payment they had no way to make.
 *
 * ## The PAN never touches this app
 *
 * The fields are the provider's own, in their iframe, served from their origin
 * (`lib/providerJs.ts`). This component holds a confirmation credential and a
 * DOM node to mount into; it never sees a card number, an expiry or a CVC, and
 * neither does this bundle, its error reports or its logs.
 *
 * ## Success is not what this component decides
 *
 * `confirmPayment` resolving means the provider accepted the confirmation. It
 * does NOT mean the payment settled — 3-D Secure can still be pending, a
 * processor can take seconds, and a redirect can bring the payer back before
 * the webhook lands. So this reports what it did and then gets out of the way:
 * the authoritative status arrives over the socket that `CheckoutView` is
 * already subscribed to, driven by a verified webhook. A page that declared
 * success from a client callback would tell a payer they had paid on the
 * strength of a promise their own browser made.
 */
export function CardPayment({ intent }: { intent: PaymentIntent }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const sdkRef = useRef<ProviderSdk | null>(null);
  const elementsRef = useRef<ProviderElements | null>(null);

  const [phase, setPhase] = useState<'loading' | 'ready' | 'confirming' | 'unavailable'>(
    'loading',
  );
  const [error, setError] = useState<string | null>(null);

  /**
   * Fetch the credential and mount the provider's fields.
   *
   * Keyed on the intent's id AND its client secret: `CheckoutView` swaps the
   * whole intent when a link mints a new one, and a form still mounted against
   * the previous payment would confirm the wrong one.
   */
  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    setError(null);

    void (async () => {
      try {
        const [action, factory] = await Promise.all([
          getClientAction(intent.id, intent.clientSecret),
          loadProviderSdk(),
        ]);
        if (cancelled) return;

        if (action.kind !== 'client_secret' || !action.publishableKey) {
          // A redirect-style action, or a deployment with no publishable key
          // configured. Neither is something this component can render, and
          // saying so beats mounting an empty box.
          setPhase('unavailable');
          setError('This payment cannot be completed on this page.');
          return;
        }

        const sdk = factory(action.publishableKey);
        const elements = sdk.elements({ clientSecret: action.value });
        const element = elements.create('payment');
        if (!mountRef.current) return;
        element.mount(mountRef.current);

        sdkRef.current = sdk;
        elementsRef.current = elements;
        setPhase('ready');
      } catch (cause) {
        if (cancelled) return;
        setPhase('unavailable');
        setError(
          cause instanceof Error
            ? cause.message
            : 'The card form could not be prepared. Please try again.',
        );
      }
    })();

    return () => {
      cancelled = true;
      // Unmount the provider's element explicitly. React removes OUR node; the
      // iframe is theirs, and leaving it attached to a detached parent leaks a
      // live frame per navigation.
      elementsRef.current?.getElement('payment')?.destroy();
      elementsRef.current = null;
      sdkRef.current = null;
    };
  }, [intent.id, intent.clientSecret]);

  async function confirm(): Promise<void> {
    const sdk = sdkRef.current;
    const elements = elementsRef.current;
    if (!sdk || !elements) return;

    setPhase('confirming');
    setError(null);
    try {
      const result = await sdk.confirmPayment({
        elements,
        /**
         * `if_required`, so a payment that needs no redirect completes in
         * place and the payer stays on this page — where the socket is already
         * delivering the authoritative status.
         *
         * A payment that DOES need one (3-D Secure) redirects away and comes
         * back to this same URL, which is why `return_url` is the page's own
         * address rather than the merchant's success URL: the merchant's URL is
         * for a payer whose payment this gateway has CONFIRMED, and a return
         * from a challenge proves only that they came back.
         */
        redirect: 'if_required',
        confirmParams: { return_url: window.location.href },
      });

      if (result.error) {
        // A declined card, an incomplete field, an authentication the payer
        // abandoned. All recoverable: the form stays mounted and they can try
        // again, on the same payment — the provider returns it to a confirmable
        // state, and the gateway's state machine accepts a success after a
        // declined attempt.
        setPhase('ready');
        setError(result.error.message ?? 'This card could not be charged.');
        return;
      }

      /**
       * Accepted — and deliberately NOT announced as success.
       *
       * The authoritative status arrives over the socket, from a verified
       * webhook. Until it does the payer sees "confirming", which is what is
       * true.
       */
      setPhase('confirming');
    } catch (cause) {
      setPhase('ready');
      setError(
        cause instanceof Error ? cause.message : 'This payment could not be confirmed.',
      );
    }
  }

  return (
    <div className="card-payment">
      <div ref={mountRef} className="card-payment__fields" data-testid="card-fields" />

      {phase === 'loading' && (
        <p className="card-payment__hint" aria-live="polite">
          Preparing a secure card form…
        </p>
      )}

      {error !== null && (
        <p className="card-payment__error" role="alert">
          {error}
        </p>
      )}

      {phase !== 'unavailable' && (
        <button
          type="button"
          className="card-payment__button"
          // Disabled while the form is being prepared and while a confirmation
          // is in flight: a second click during confirmation is the ordinary
          // way a payer creates a duplicate authorization attempt.
          disabled={phase !== 'ready'}
          onClick={() => {
            void confirm();
          }}
        >
          {phase === 'confirming' ? 'Confirming…' : 'Pay'}
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
 * `failed` is deliberately included. A declined attempt returns the provider's
 * payment to a confirmable state and the payer can try another card on the same
 * payment — the gateway's state machine accepts a success after a declined
 * attempt for exactly this reason. Dropping them onto a dead status panel
 * because their first card was declined would lose a sale the payer was still
 * trying to make.
 */
export function isPayableCardIntent(intent: PaymentIntent): boolean {
  return (
    intent.rail === 'card' &&
    (intent.status === 'created' ||
      intent.status === 'requires_action' ||
      intent.status === 'failed')
  );
}
