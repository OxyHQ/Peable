import { useEffect, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import type { CheckoutSessionPublic } from '@peable.to/shared-types';
import { CheckoutPage } from '../components/CheckoutPage';
import { browserLanguages, I18nProvider, queryLocale, resolveLocale, useI18n } from '../i18n';
import type { LoadState } from '../lib/loadState';
import { getCheckoutSession } from '../lib/sessionClient';

function Pending({ message }: { message: string }) {
  return (
    <main className="checkout-page">
      <p className="checkout-page__pending" role="status">
        {message}
      </p>
    </main>
  );
}

function PendingKey({ messageKey }: { messageKey: 'loading' | 'missingParams' }) {
  const { t } = useI18n();
  return <Pending message={t(messageKey)} />;
}

/**
 * `/c/:sessionId#cs=<secret>` — the hosted checkout. The secret travels in the
 * URL FRAGMENT, never the query string, so it reaches no server or CDN access
 * log; the app sends it to the gateway in the `X-Peable-Client-Secret` header.
 */
export function SessionRoute() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { hash } = useLocation();
  const clientSecret = new URLSearchParams(hash.slice(1)).get('cs');
  const [state, setState] = useState<LoadState<CheckoutSessionPublic>>({ status: 'loading' });
  const override = queryLocale();

  useEffect(() => {
    if (!sessionId || !clientSecret) {
      setState({ status: 'error', message: '' });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    getCheckoutSession(sessionId, clientSecret)
      .then((session) => {
        if (!cancelled) setState({ status: 'ready', data: session });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', message: error instanceof Error ? error.message : '' });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, clientSecret]);

  const locale = resolveLocale({
    override,
    merchant: state.status === 'ready' ? state.data.locale : null,
    browser: browserLanguages(),
  });

  return (
    <I18nProvider locale={locale}>
      {!sessionId || !clientSecret ? (
        <PendingKey messageKey="missingParams" />
      ) : state.status === 'loading' ? (
        <PendingKey messageKey="loading" />
      ) : state.status === 'error' ? (
        <LoadError message={state.message} />
      ) : (
        <main className="checkout-page">
          <CheckoutPage initialSession={state.data} clientSecret={clientSecret} />
        </main>
      )}
    </I18nProvider>
  );
}

export function LoadError({ message }: { message: string }) {
  const { t } = useI18n();
  return (
    <main className="checkout-page">
      <p className="checkout-page__pending" role="alert">
        {message || t('loadFailed')}
      </p>
    </main>
  );
}
