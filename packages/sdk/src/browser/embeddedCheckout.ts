// `PeableCheckout.mountCheckout(element, { clientSecret })` — the embedded
// checkout: the same experience as `checkout.peable.to/c/:id`, framed in the
// merchant's page from checkout.peable.to and talking to it only through the
// origin-checked protocol in `embedProtocol.ts`.
//
// The page never sees a card number: the frame is Peable's origin, and inside
// it the card fields are the provider's own frames. Completion is reported by
// the frame only after the gateway said the session is `complete`; a server
// that fulfils an order still reads the session itself (or listens for
// `checkout.session.completed`) rather than trusting this callback.
import { PeableInvalidRequestError } from '../core/errors';
import type { Appearance } from './appearance';
import {
  buildEmbedUrl,
  envelope,
  normalizeOrigin,
  readFrameMessage,
  sessionIdFromClientSecret,
  DEFAULT_CHECKOUT_URL,
} from './embedProtocol';

export interface MountCheckoutOptions {
  /** The session's `client_secret` (`cs_…_secret_…`), from an `ui_mode: 'embedded'` session. */
  clientSecret: string;
  /** Default `https://checkout.peable.to`. */
  checkoutUrl?: string;
  /** Layered over the merchant's branding inside the frame. */
  appearance?: Appearance;
  /** One of the checkout locales; the session's `locale`, then the browser's, otherwise. */
  locale?: string;
  /**
   * Called once the gateway says the session is complete. Without it, the
   * page navigates to the session's `success_url` (when it has one).
   */
  onComplete?(event: { sessionId: string; successUrl: string | null }): void;
  onExpired?(event: { sessionId: string }): void;
  onError?(event: { sessionId: string; message: string }): void;
}

export interface EmbeddedCheckoutInstance {
  /** Remove the frame and stop listening. */
  destroy(): void;
  /** Re-style the frame (presentation only). */
  updateAppearance(appearance: Appearance): void;
}

/** What `mountCheckout` touches, injectable so it is testable without a browser. */
export interface EmbeddedCheckoutEnvironment {
  readonly document: {
    createElement(tag: 'iframe'): HTMLIFrameElement;
    querySelector(selector: string): Element | null;
  };
  readonly window: {
    readonly location: { readonly origin: string; assign(url: string): void };
    addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
    removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  };
}

function browserEnvironment(): EmbeddedCheckoutEnvironment {
  return { document, window };
}

const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups';
const INITIAL_HEIGHT = 600;

/** Mount with an explicit environment — {@link mountCheckout} passes the browser's. */
export function mountCheckoutIn(
  env: EmbeddedCheckoutEnvironment,
  target: string | Element,
  options: MountCheckoutOptions,
): EmbeddedCheckoutInstance {
  const container = typeof target === 'string' ? env.document.querySelector(target) : target;
  if (!container) {
    throw new PeableInvalidRequestError(
      `PeableCheckout.mountCheckout: no element matches ${String(target)}`,
    );
  }
  const derivedId = sessionIdFromClientSecret(options.clientSecret);
  if (!derivedId) {
    throw new PeableInvalidRequestError(
      'PeableCheckout.mountCheckout: clientSecret is not a checkout session client secret',
    );
  }
  const checkoutUrl = options.checkoutUrl ?? DEFAULT_CHECKOUT_URL;
  const derivedOrigin = normalizeOrigin(checkoutUrl);
  if (!derivedOrigin) {
    throw new PeableInvalidRequestError('PeableCheckout.mountCheckout: checkoutUrl is not a URL');
  }
  const sessionId: string = derivedId;
  const checkoutOrigin: string = derivedOrigin;

  const iframe = env.document.createElement('iframe');
  iframe.src = buildEmbedUrl({
    checkoutUrl,
    clientSecret: options.clientSecret,
    hostOrigin: env.window.location.origin,
    locale: options.locale,
  });
  iframe.title = 'Peable checkout';
  iframe.setAttribute('allow', 'payment');
  iframe.setAttribute('sandbox', SANDBOX);
  iframe.style.width = '100%';
  iframe.style.border = '0';
  iframe.style.height = `${INITIAL_HEIGHT}px`;
  container.replaceChildren(iframe);

  let appearance = options.appearance;
  let completed = false;
  let destroyed = false;

  function post(next: Appearance | undefined): void {
    if (!next || destroyed) return;
    iframe.contentWindow?.postMessage(
      envelope({
        type: 'appearance',
        session_id: sessionId,
        appearance: next as Record<string, unknown>,
      }),
      checkoutOrigin,
    );
  }

  function onMessage(event: MessageEvent): void {
    const message = readFrameMessage(event, {
      origin: checkoutOrigin,
      source: iframe.contentWindow,
      sessionId: sessionId,
    });
    if (!message) return;
    switch (message.type) {
      case 'ready':
        post(appearance);
        return;
      case 'resize':
        iframe.style.height = `${message.height}px`;
        return;
      case 'complete':
        if (completed) return;
        completed = true;
        if (options.onComplete) {
          options.onComplete({ sessionId: message.session_id, successUrl: message.success_url });
        } else if (message.success_url) {
          env.window.location.assign(message.success_url);
        }
        return;
      case 'expired':
        options.onExpired?.({ sessionId: message.session_id });
        return;
      case 'error':
        options.onError?.({ sessionId: message.session_id, message: message.message });
        return;
    }
  }

  env.window.addEventListener('message', onMessage);

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      env.window.removeEventListener('message', onMessage);
      iframe.remove();
    },
    updateAppearance(next) {
      appearance = next;
      post(next);
    },
  };
}

/**
 * Frame the hosted checkout of an `ui_mode: 'embedded'` session into
 * `target`. Returns synchronously; the frame reports `ready`, sizes itself,
 * and calls `onComplete` once the gateway says the session completed.
 */
export function mountCheckout(
  target: string | Element,
  options: MountCheckoutOptions,
): EmbeddedCheckoutInstance {
  return mountCheckoutIn(browserEnvironment(), target, options);
}
