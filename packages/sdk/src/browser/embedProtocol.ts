// The embedded checkout's postMessage protocol — ONE definition shared by the
// host side (`PeableCheckout.mountCheckout`, in a merchant's page) and the
// frame side (`checkout.peable.to/embed/:id`, `packages/checkout`).
//
// ## Trust
//
// A message is accepted only when BOTH hold:
//
//  - its `origin` is the one origin the other side is expected to be — the
//    host checks the checkout origin it framed; the frame checks the host
//    origin it was given in its URL fragment and posts with that origin as the
//    `targetOrigin`, so a page that framed it under another origin receives
//    nothing;
//  - its `source` window is the other side's window (`iframe.contentWindow`
//    for the host, `window.parent` for the frame).
//
// A frame never takes an instruction that changes money from the host: the
// host can only ASK for a resize-free re-render (`appearance`). Completion is
// reported by the frame only after the gateway said the session is
// `complete`, and the host re-reads the session server-side anyway.
//
// The client secret travels in the frame URL's FRAGMENT, so it never reaches
// a server or CDN log.

/** Every message carries this, so stray `postMessage` traffic is ignored. */
/** Peable's hosted checkout — the origin of `/c/:id`, `/i/:id` and the embedded frame. */
export const DEFAULT_CHECKOUT_URL = 'https://checkout.peable.to';

export const EMBED_MESSAGE_SOURCE = 'peable-checkout';
export const EMBED_PROTOCOL_VERSION = 1;

/** Frame → host. */
export type EmbedFrameMessage =
  | { type: 'ready'; session_id: string }
  | { type: 'resize'; session_id: string; height: number }
  | {
      type: 'complete';
      session_id: string;
      /** The session's `success_url` with its id substituted, or `null`. */
      success_url: string | null;
    }
  | { type: 'expired'; session_id: string }
  | { type: 'error'; session_id: string; message: string };

/** Host → frame. Presentation only — never an amount, a status or a URL to visit. */
export type EmbedHostMessage = {
  type: 'appearance';
  session_id: string;
  appearance: Record<string, unknown>;
};

export type EmbedEnvelope<T> = T & {
  source: typeof EMBED_MESSAGE_SOURCE;
  version: typeof EMBED_PROTOCOL_VERSION;
};

/** The `cs_…` a session client secret belongs to (`cs_<hex>_secret_<hex>`). */
export function sessionIdFromClientSecret(clientSecret: string): string | null {
  const match = /^(cs_[0-9a-f]{24,})_secret_[0-9a-f]{16,}$/.exec(clientSecret);
  return match?.[1] ?? null;
}

/** A browser origin as `URL.origin` spells it, or `null` for anything else. */
export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The frame's URL: `<checkout>/embed/<cs_…>#cs=<secret>&origin=<host origin>[&locale=]`. */
export function buildEmbedUrl(params: {
  checkoutUrl: string;
  clientSecret: string;
  hostOrigin: string;
  locale?: string | undefined;
}): string {
  const sessionId = sessionIdFromClientSecret(params.clientSecret);
  if (!sessionId) throw new Error('not a checkout session client secret');
  const origin = normalizeOrigin(params.hostOrigin);
  if (!origin) throw new Error('the host page has no web origin');
  const base = params.checkoutUrl.replace(/\/$/, '');
  const fragment = [
    `cs=${encodeURIComponent(params.clientSecret)}`,
    `origin=${encodeURIComponent(origin)}`,
    ...(params.locale ? [`locale=${encodeURIComponent(params.locale)}`] : []),
  ].join('&');
  return `${base}/embed/${sessionId}#${fragment}`;
}

/** What the frame reads back out of its own fragment. */
export function parseEmbedFragment(hash: string): {
  clientSecret: string;
  hostOrigin: string;
  locale: string | null;
} | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const clientSecret = params.get('cs');
  const rawOrigin = params.get('origin');
  if (!clientSecret || !rawOrigin || !sessionIdFromClientSecret(clientSecret)) return null;
  const hostOrigin = normalizeOrigin(rawOrigin);
  if (!hostOrigin) return null;
  return { clientSecret, hostOrigin, locale: params.get('locale') };
}

export function envelope<T extends EmbedFrameMessage | EmbedHostMessage>(
  message: T,
): EmbedEnvelope<T> {
  return { ...message, source: EMBED_MESSAGE_SOURCE, version: EMBED_PROTOCOL_VERSION };
}

function isEnvelope(data: unknown, sessionId: string): data is Record<string, unknown> {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { source?: unknown }).source === EMBED_MESSAGE_SOURCE &&
    (data as { version?: unknown }).version === EMBED_PROTOCOL_VERSION &&
    (data as { session_id?: unknown }).session_id === sessionId &&
    typeof (data as { type?: unknown }).type === 'string'
  );
}

/**
 * The host's check of one `message` event: from the expected origin, from the
 * frame's window, about this session, and well-formed. Anything else is
 * `null` and must be ignored.
 */
export function readFrameMessage(
  event: { origin: string; source: unknown; data: unknown },
  expected: { origin: string; source: unknown; sessionId: string },
): EmbedFrameMessage | null {
  if (event.origin !== expected.origin || event.source !== expected.source) return null;
  const data = event.data;
  if (!isEnvelope(data, expected.sessionId)) return null;
  switch (data.type) {
    case 'ready':
    case 'expired':
      return { type: data.type, session_id: expected.sessionId };
    case 'resize':
      return typeof data.height === 'number' && Number.isFinite(data.height) && data.height >= 0
        ? {
            type: 'resize',
            session_id: expected.sessionId,
            height: Math.min(Math.ceil(data.height), 10_000),
          }
        : null;
    case 'complete': {
      const url = data.success_url;
      if (url !== null && (typeof url !== 'string' || normalizeOrigin(url) === null)) return null;
      return { type: 'complete', session_id: expected.sessionId, success_url: url };
    }
    case 'error':
      return typeof data.message === 'string'
        ? { type: 'error', session_id: expected.sessionId, message: data.message.slice(0, 500) }
        : null;
    default:
      return null;
  }
}

/** The frame's check of one `message` event from its host. */
export function readHostMessage(
  event: { origin: string; source: unknown; data: unknown },
  expected: { origin: string; source: unknown; sessionId: string },
): EmbedHostMessage | null {
  if (event.origin !== expected.origin || event.source !== expected.source) return null;
  const data = event.data;
  if (!isEnvelope(data, expected.sessionId)) return null;
  if (data.type !== 'appearance') return null;
  const appearance = data.appearance;
  if (typeof appearance !== 'object' || appearance === null || Array.isArray(appearance)) {
    return null;
  }
  return {
    type: 'appearance',
    session_id: expected.sessionId,
    appearance: appearance as Record<string, unknown>,
  };
}
