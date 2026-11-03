import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import {
  confirmSetupOf,
  loadProviderSdk,
  type ProviderElements,
  type ProviderSdk,
} from '../lib/providerJs';
import { getSetupClientAction } from '../lib/sessionClient';

/**
 * Saving a card in a `setup`-mode session: the provider's Payment Element over
 * the SetupIntent's provider credential, then `confirmSetup`. Like the card
 * payment, nothing here decides the outcome — the session completes when the
 * gateway has seen the provider's verified result, and `onAccepted` only tells
 * the page to start asking.
 */
export function SetupPayment({
  setupIntent,
  providerAppearance,
  submitLabel,
  onAccepted,
}: {
  setupIntent: { id: string; client_secret: string };
  providerAppearance?: Record<string, unknown> | undefined;
  submitLabel: string;
  onAccepted: () => void;
}) {
  const { t, locale } = useI18n();
  const mountRef = useRef<HTMLDivElement | null>(null);
  const sdkRef = useRef<ProviderSdk | null>(null);
  const elementsRef = useRef<ProviderElements | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'confirming' | 'unavailable'>('loading');
  const [error, setError] = useState<string | null>(null);
  const appearanceRef = useRef(providerAppearance);
  appearanceRef.current = providerAppearance;

  // biome-ignore lint/correctness/useExhaustiveDependencies: mounted once per SetupIntent; `t` and the appearance are read at mount
  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    void (async () => {
      try {
        const [action, factory] = await Promise.all([
          getSetupClientAction(setupIntent.id, setupIntent.client_secret),
          loadProviderSdk(),
        ]);
        if (cancelled) return;
        if (action.kind !== 'client_secret' || !action.publishable_key) {
          setPhase('unavailable');
          setError(t('cardUnavailable'));
          return;
        }
        const sdk = factory(action.publishable_key, { locale });
        const elements = sdk.elements({
          clientSecret: action.value,
          ...(appearanceRef.current ? { appearance: appearanceRef.current } : {}),
        });
        const element = elements.create('payment');
        if (!mountRef.current) return;
        element.mount(mountRef.current);
        sdkRef.current = sdk;
        elementsRef.current = elements;
        setPhase('ready');
      } catch (cause) {
        if (cancelled) return;
        setPhase('unavailable');
        setError(cause instanceof Error ? cause.message : t('cardFormFailed'));
      }
    })();
    return () => {
      cancelled = true;
      elementsRef.current?.getElement('payment')?.destroy();
      elementsRef.current = null;
      sdkRef.current = null;
    };
  }, [setupIntent.id, setupIntent.client_secret]);

  async function confirm(): Promise<void> {
    const sdk = sdkRef.current;
    const elements = elementsRef.current;
    if (!sdk || !elements) return;
    const confirmSetup = confirmSetupOf(sdk);
    if (!confirmSetup) {
      setPhase('unavailable');
      setError(t('cardUnavailable'));
      return;
    }
    setPhase('confirming');
    setError(null);
    try {
      const result = await confirmSetup({
        elements,
        redirect: 'if_required',
        confirmParams: { return_url: window.location.href },
      });
      if (result.error) {
        setPhase('ready');
        setError(result.error.message ?? t('setupFailed'));
        return;
      }
      onAccepted();
    } catch (cause) {
      setPhase('ready');
      setError(cause instanceof Error ? cause.message : t('setupFailed'));
    }
  }

  return (
    <div className="card-payment">
      <div ref={mountRef} className="card-payment__fields" data-testid="setup-fields" />
      {phase === 'loading' && (
        <p className="card-payment__hint" aria-live="polite">
          {t('cardPreparing')}
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
          className="checkout-button"
          disabled={phase !== 'ready'}
          onClick={() => {
            void confirm();
          }}
        >
          {phase === 'confirming' ? t('confirming') : submitLabel}
        </button>
      )}
    </div>
  );
}
