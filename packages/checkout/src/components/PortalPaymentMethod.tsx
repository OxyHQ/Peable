import { useEffect, useRef, useState } from 'react';
import type { PublicPortalSession } from '@peable.to/shared-types';
import {
  finishPaymentMethodUpdate,
  getSetupClientAction,
  startPaymentMethodUpdate,
} from '../lib/billingClient';
import { loadProviderSdk, type ProviderElements, type ProviderSdk } from '../lib/providerJs';

/**
 * The provider SDK's SetupIntent confirmation. Stripe.js has it beside
 * `confirmPayment`; the shared `ProviderSdk` type names only the payment side,
 * so it is read as optional here and a provider without it says so.
 */
type SetupCapableSdk = ProviderSdk & {
  confirmSetup?(options: {
    elements: ProviderElements;
    confirmParams?: Record<string, unknown>;
    redirect?: 'if_required' | 'always';
  }): Promise<{ error?: { message?: string } }>;
};

/**
 * Replace the customer's card from the portal (ADR 0018 §9).
 *
 * The portal asks the gateway for a SetupIntent, reads its provider
 * credential with the SetupIntent's own client secret, mounts the PROVIDER's
 * fields (the card never touches this app — `CardPayment`'s rule) and
 * confirms the setup. The gateway then makes the new method the customer's
 * default, and every live subscription's, once the provider reports the setup
 * succeeded — never on the strength of this browser's callback.
 */
export function PortalPaymentMethod({
  token,
  onUpdated,
  onCancel,
}: {
  token: string;
  onUpdated: (session: PublicPortalSession) => void;
  onCancel: () => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const sdkRef = useRef<SetupCapableSdk | null>(null);
  const elementsRef = useRef<ProviderElements | null>(null);
  const setupRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<
    'loading' | 'ready' | 'confirming' | 'pending' | 'unavailable'
  >('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const setup = await startPaymentMethodUpdate(token);
        const [action, factory] = await Promise.all([
          getSetupClientAction(setup.setup_intent, setup.client_secret),
          loadProviderSdk(),
        ]);
        if (cancelled) return;
        if (action.kind !== 'client_secret' || !action.publishable_key) {
          setPhase('unavailable');
          setError('Your card cannot be updated on this page right now.');
          return;
        }
        const sdk = factory(action.publishable_key) as SetupCapableSdk;
        const elements = sdk.elements({ clientSecret: action.value });
        const element = elements.create('payment');
        if (!mountRef.current) return;
        element.mount(mountRef.current);
        sdkRef.current = sdk;
        elementsRef.current = elements;
        setupRef.current = setup.setup_intent;
        setPhase('ready');
      } catch (cause) {
        if (cancelled) return;
        setPhase('unavailable');
        setError(cause instanceof Error ? cause.message : 'The card form could not be prepared.');
      }
    })();
    return () => {
      cancelled = true;
      elementsRef.current?.getElement('payment')?.destroy();
      elementsRef.current = null;
      sdkRef.current = null;
    };
  }, [token]);

  async function save(): Promise<void> {
    const sdk = sdkRef.current;
    const elements = elementsRef.current;
    const setupIntent = setupRef.current;
    if (!sdk || !elements || !setupIntent) return;
    if (!sdk.confirmSetup) {
      setPhase('unavailable');
      setError('Your card cannot be updated on this page right now.');
      return;
    }
    setPhase('confirming');
    setError(null);
    try {
      const result = await sdk.confirmSetup({
        elements,
        redirect: 'if_required',
        confirmParams: { return_url: window.location.href },
      });
      if (result.error) {
        setPhase('ready');
        setError(result.error.message ?? 'This card could not be saved.');
        return;
      }
      const finished = await finishPaymentMethodUpdate(token, setupIntent);
      if (finished.status === 'succeeded') {
        onUpdated(finished.session);
        return;
      }
      // The provider has not reported the setup yet; the portal shows the new
      // card once it has.
      setPhase('pending');
    } catch (cause) {
      setPhase('ready');
      setError(cause instanceof Error ? cause.message : 'This card could not be saved.');
    }
  }

  return (
    <div className="card-payment">
      <div ref={mountRef} className="card-payment__fields" data-testid="setup-fields" />
      {phase === 'loading' && <p className="card-payment__hint">Preparing a secure card form…</p>}
      {phase === 'pending' && (
        <p className="card-payment__hint" aria-live="polite">
          Your card is being confirmed. Reload this page in a moment to see it.
        </p>
      )}
      {error !== null && (
        <p className="card-payment__error" role="alert">
          {error}
        </p>
      )}
      {phase !== 'unavailable' && phase !== 'pending' && (
        <button
          type="button"
          className="card-payment__button"
          disabled={phase !== 'ready'}
          onClick={() => {
            void save();
          }}
        >
          {phase === 'confirming' ? 'Saving…' : 'Save card'}
        </button>
      )}
      <button type="button" className="portal__link-button" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
