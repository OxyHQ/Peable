import { useEffect, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import type { PaymentIntent } from '@peable.to/shared-types';
import { CheckoutView } from '../components/CheckoutView';
import { browserLanguages, I18nProvider, queryLocale, resolveLocale, useI18n } from '../i18n';
import { getPaymentIntent } from '../lib/intentClient';
import type { LoadState } from '../lib/loadState';

function IntentPage({ intentId }: { intentId: string | undefined }) {
  const { t } = useI18n();
  const { hash } = useLocation();
  const clientSecret = new URLSearchParams(hash.slice(1)).get('client_secret');
  const [state, setState] = useState<LoadState<PaymentIntent>>({ status: 'loading' });

  useEffect(() => {
    if (!intentId || !clientSecret) {
      setState({ status: 'error', message: '' });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    getPaymentIntent(intentId, clientSecret)
      .then((intent) => {
        if (!cancelled) setState({ status: 'ready', data: intent });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', message: error instanceof Error ? error.message : '' });
      });
    return () => {
      cancelled = true;
    };
  }, [intentId, clientSecret]);

  return (
    <main className="checkout-page">
      {state.status === 'loading' && (
        <p className="checkout-page__pending" role="status">
          {t('loadingIntent', { id: intentId ?? '' })}
        </p>
      )}
      {state.status === 'error' && (
        <p className="checkout-page__pending" role="alert">
          {!intentId || !clientSecret ? t('missingIntentParams') : state.message || t('loadFailed')}
        </p>
      )}
      {state.status === 'ready' && <CheckoutView intent={state.data} />}
    </main>
  );
}

/**
 * `/i/:intentId#client_secret=<secret>` — one payment, no session around it:
 * what the SDK's pay button and a deep-linked "pay" page target. The secret is
 * in the FRAGMENT, so it reaches no server or CDN log.
 */
export function IntentRoute() {
  const { intentId } = useParams<{ intentId: string }>();
  const locale = resolveLocale({ override: queryLocale(), browser: browserLanguages() });
  return (
    <I18nProvider locale={locale}>
      <IntentPage intentId={intentId} />
    </I18nProvider>
  );
}
