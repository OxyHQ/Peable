import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import {
  type EmbedFrameMessage,
  embedEnvelope,
  parseEmbedFragment,
  readHostMessage,
} from '@peable.to/sdk/checkout';
import type { CheckoutSessionPublic } from '@peable.to/shared-types';
import { CheckoutPage } from '../components/CheckoutPage';
import { browserLanguages, I18nProvider, resolveLocale, useI18n } from '../i18n';
import type { Appearance } from '../lib/branding';
import type { LoadState } from '../lib/loadState';
import { getCheckoutSession } from '../lib/sessionClient';

function Message({
  messageKey,
  text,
}: {
  messageKey: 'loading' | 'missingParams' | 'loadFailed';
  text?: string;
}) {
  const { t } = useI18n();
  return (
    <p className="checkout-page__pending" role={messageKey === 'loading' ? 'status' : 'alert'}>
      {text || t(messageKey)}
    </p>
  );
}

/**
 * `/embed/:sessionId#cs=…&origin=…&locale=` — the embedded checkout, framed by
 * `PeableCheckout.mountCheckout` on the merchant's page.
 *
 * It speaks the SDK's embed protocol (`embedProtocol.ts`) and nothing else:
 * every message goes to `window.parent` with the host's origin as the
 * `targetOrigin`, so a page that framed it under another origin hears nothing;
 * a host message is read only through `readHostMessage` (origin AND source
 * window checked) and can only change presentation. `complete` is posted only
 * once the gateway reports the session complete, and the frame never
 * navigates itself — the host does.
 */
export function EmbedRoute() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { hash } = useLocation();
  const fragment = useMemo(() => parseEmbedFragment(hash), [hash]);
  const valid = Boolean(sessionId && fragment?.clientSecret.startsWith(`${sessionId}_secret_`));
  const [state, setState] = useState<LoadState<CheckoutSessionPublic>>({ status: 'loading' });
  const [appearance, setAppearance] = useState<Appearance | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const post = useCallback(
    (message: EmbedFrameMessage) => {
      if (!fragment || window.parent === window) return;
      window.parent.postMessage(embedEnvelope(message), fragment.hostOrigin);
    },
    [fragment],
  );

  useEffect(() => {
    if (!valid || !sessionId || !fragment) return;
    let cancelled = false;
    getCheckoutSession(sessionId, fragment.clientSecret)
      .then((session) => {
        if (cancelled) return;
        setState({ status: 'ready', data: session });
        post({ type: 'ready', session_id: sessionId });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : '';
        setState({ status: 'error', message });
        post({ type: 'error', session_id: sessionId, message: message || 'load_failed' });
      });
    return () => {
      cancelled = true;
    };
  }, [valid, sessionId, fragment, post]);

  // The host may restyle the frame — origin and source window checked first.
  useEffect(() => {
    if (!fragment || !sessionId) return;
    const listener = (event: MessageEvent) => {
      const message = readHostMessage(event, {
        origin: fragment.hostOrigin,
        source: window.parent,
        sessionId,
      });
      if (message) setAppearance(message.appearance as Appearance);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [fragment, sessionId]);

  // The host sizes the iframe to the content.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !sessionId || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      post({ type: 'resize', session_id: sessionId, height: root.scrollHeight });
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [sessionId, post]);

  const locale = resolveLocale({
    override: fragment?.locale,
    merchant: state.status === 'ready' ? state.data.locale : null,
    browser: browserLanguages(),
  });

  return (
    <I18nProvider locale={locale}>
      <div ref={rootRef} className="embed-root">
        {!valid || !fragment || !sessionId ? (
          <Message messageKey="missingParams" />
        ) : state.status === 'loading' ? (
          <Message messageKey="loading" />
        ) : state.status === 'error' ? (
          <Message messageKey="loadFailed" text={state.message} />
        ) : (
          <CheckoutPage
            initialSession={state.data}
            clientSecret={fragment.clientSecret}
            embedded
            appearanceOverride={appearance}
            onComplete={(session) =>
              post({ type: 'complete', session_id: session.id, success_url: session.success_url })
            }
            onExpired={(session) => post({ type: 'expired', session_id: session.id })}
          />
        )}
      </div>
    </I18nProvider>
  );
}
