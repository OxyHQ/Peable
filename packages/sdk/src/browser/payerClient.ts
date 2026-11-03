// The payer-side REST+socket client core — the "./checkout" entry's payer
// capability (Fase 2 SDK plan, Task 5). Mirrors the wallet's
// `gateway-client.ts`/`gateway-socket.ts` but standalone: no
// `@oxy.so/services`/`@oxy.so/core` — this is a third-party browser bundle, so
// it talks to the Gateway over bare `fetch` + `socket.io-client`.
//
// Holds NO service token and NO private key — only a public `client_secret`,
// the exact payer capability the wallet's own payer path already uses
// (non-custody invariant). `core/errors.ts` is the one `./core/*` import: it
// is a pure status-code→`PeableError` mapper with no service-token/secret
// machinery, so reusing it here (instead of throwing bare `Error`) does not
// carry any of the merchant-authed code `checkout.ts` warns against into the
// browser bundle.
import { io, type Socket } from 'socket.io-client';
import type {
  CheckoutSessionPublic,
  CreatePaymentLinkSessionParams,
  PaymentIntent,
  PaymentLinkSessionStart,
  PublicPaymentLink,
  SetupIntent,
  UpdateCheckoutSessionPublicParams,
} from '@peable.to/shared-types';
import { errorFromResponse, PeableApiError, PeableInvalidRequestError } from '../core/errors';

const DEFAULT_GATEWAY_URL = 'https://api.peable.to';

/**
 * Whether updates are actually arriving.
 *
 * `'live'` means the socket is connected AND rejoined to this intent's room —
 * both, because a connected socket in no room delivers nothing and is
 * indistinguishable from a quiet payment.
 *
 * `'lost'` is a report, not a recovery: socket.io keeps retrying the transport
 * on its own, but it replays NOTHING, so anything emitted during the gap is
 * gone. A host that wants those updates has to re-read the intent when `'live'`
 * comes back.
 */
export type RealtimeConnectionState = 'live' | 'lost';

/**
 * What the payer's client has to do next — the RESUME capability.
 *
 * The payment-intent DTO deliberately carries no confirmation credential, so a
 * payer who refreshed the page, came back from an SCA challenge in a new tab,
 * or returned the next day had nothing to pay WITH. This is the one call that
 * hands one out, bounded to a single payment the caller has proven they may
 * pay.
 *
 * `value` is opaque and provider-specific; `publishable_key` is the provider's
 * public key, served here rather than compiled into a checkout bundle — that
 * page is deployed once and serves whichever gateway it is pointed at, so a
 * baked-in key would be the wrong mode the first time a test deployment used
 * the same page.
 */
export interface PeableClientAction {
  readonly object: 'client_action';
  readonly kind: 'client_secret' | 'redirect';
  readonly value: string;
  readonly publishable_key?: string;
}

export interface PeableCheckoutClient {
  /**
   * `GET /v1/payment_intents/:id` — the initial REST snapshot. Sends
   * `clientSecret` via the `X-Peable-Client-Secret` header, never a query
   * param, so the capability token never lands in server/CDN access logs.
   */
  getPaymentIntent(id: string, clientSecret: string): Promise<PaymentIntent>;
  /**
   * Realtime status stream over the Gateway's socket contract, filtered to this
   * intent.
   *
   * `onConnectionChange` is optional and additive: it reports drops and
   * recoveries AFTER this promise resolves, which nothing could observe before.
   * A caller that omits it behaves exactly as it did.
   */
  subscribe(
    id: string,
    clientSecret: string,
    onUpdate: (intent: PaymentIntent) => void,
    onConnectionChange?: (state: RealtimeConnectionState) => void,
  ): Promise<{ unsubscribe(): void }>;
  /** `POST /v1/payment_intents/:id/submit_tx` — report a broadcast txid. */
  submitTx(id: string, clientSecret: string, txid: string): Promise<PaymentIntent>;
  /**
   * `POST /v1/payment_intents/:id/client_action` — what to pay WITH.
   *
   * A POST, and not a field on `getPaymentIntent`, because the answer is a
   * credential: a GET response is cacheable by anything in front of it and its
   * path lands in access logs, while `getPaymentIntent` is the call a checkout
   * page POLLS.
   *
   * @throws {PeableInvalidRequestError} when the payment can no longer be paid
   *   — a payment that succeeded or was cancelled has no next step, and a page
   *   handed one would render a card form over a finished payment.
   */
  getClientAction(id: string, clientSecret: string): Promise<PeableClientAction>;
  /**
   * `GET /v1/checkout_sessions/:id/public` — the session as the payer sees it.
   * `clientSecret` is the session's (`cs_…_secret_…`), sent as a header.
   */
  getCheckoutSession(id: string, clientSecret: string): Promise<CheckoutSessionPublic>;
  /** `POST /v1/checkout_sessions/:id/public` — quantities, promotion code, details. */
  updateCheckoutSession(
    id: string,
    clientSecret: string,
    params: UpdateCheckoutSessionPublicParams,
  ): Promise<CheckoutSessionPublic>;
  /**
   * `POST /v1/checkout_sessions/:id/public/confirm` — lock the order and create
   * its payment (or setup). Resolving is NOT completion: the session completes
   * when the gateway says so, which `getCheckoutSession` reports.
   */
  confirmCheckoutSession(id: string, clientSecret: string): Promise<CheckoutSessionPublic>;
  /** `GET /v1/setup_intents/:id` with the payer's `client_secret` — the row as the gateway holds it. */
  getSetupIntent(id: string, clientSecret: string): Promise<SetupIntent>;
  /**
   * `POST /v1/setup_intents/:id/client_action` — the provider credential to
   * confirm a SetupIntent with, same rules as {@link getClientAction}.
   */
  getSetupClientAction(id: string, clientSecret: string): Promise<PeableClientAction>;
  /** `GET /v1/payment_links/:id/public` — what a link shows before checkout starts. */
  getPaymentLink(id: string): Promise<PublicPaymentLink>;
  /**
   * `POST /v1/payment_links/:id/checkout_sessions` — start checkout from a link.
   * `idempotencyKey` (a UUID) is required for a contribution link, so a retry
   * after a lost answer returns the same session instead of a second one.
   */
  startPaymentLinkSession(
    id: string,
    params?: CreatePaymentLinkSessionParams,
    idempotencyKey?: string,
  ): Promise<PaymentLinkSessionStart>;
}

export interface CreatePeableCheckoutOptions {
  /** Gateway base URL. Default `https://api.peable.to`. */
  gatewayUrl?: string;
}

/** Gateway realtime event contract (mirrors `packages/backend/src/realtime/socket.ts`). */
interface ServerToClientEvents {
  'intent.updated': (intent: PaymentIntent) => void;
}

interface ClientToServerEvents {
  subscribe: (
    payload: { intent_id: string; client_secret: string },
    ack: (result: { ok: boolean }) => void,
  ) => void;
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Factory for the payer-side client core.
 */
export function createPeableCheckout(opts: CreatePeableCheckoutOptions = {}): PeableCheckoutClient {
  const baseUrl = (opts.gatewayUrl ?? DEFAULT_GATEWAY_URL).replace(/\/$/, '');

  async function getPaymentIntent(id: string, clientSecret: string): Promise<PaymentIntent> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v1/payment_intents/${encodeURIComponent(id)}`, {
        headers: { 'X-Peable-Client-Secret': clientSecret },
      });
    } catch (cause) {
      throw new PeableApiError(
        `Failed to reach the Peable Gateway at ${baseUrl}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
    const body = await readJsonBody(response);
    if (!response.ok)
      throw errorFromResponse(response.status, body, response.headers.get('Request-Id'));
    return body as PaymentIntent;
  }

  async function submitTx(id: string, clientSecret: string, txid: string): Promise<PaymentIntent> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v1/payment_intents/${encodeURIComponent(id)}/submit_tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_secret: clientSecret, txid }),
      });
    } catch (cause) {
      throw new PeableApiError(
        `Failed to reach the Peable Gateway at ${baseUrl}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
    const body = await readJsonBody(response);
    if (!response.ok)
      throw errorFromResponse(response.status, body, response.headers.get('Request-Id'));
    return body as PaymentIntent;
  }

  async function getClientAction(id: string, clientSecret: string): Promise<PeableClientAction> {
    let response: Response;
    try {
      response = await fetch(
        `${baseUrl}/v1/payment_intents/${encodeURIComponent(id)}/client_action`,
        {
          method: 'POST',
          // The HEADER, never a query param, for the same reason the snapshot
          // read uses one: a capability token in a URL lands in every access
          // log between here and the gateway.
          headers: { 'X-Peable-Client-Secret': clientSecret },
        },
      );
    } catch (cause) {
      throw new PeableApiError(
        `Failed to reach the Peable Gateway at ${baseUrl}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
    const body = await readJsonBody(response);
    if (!response.ok)
      throw errorFromResponse(response.status, body, response.headers.get('Request-Id'));
    return body as PeableClientAction;
  }

  /**
   * Opens its OWN socket per call (never a shared/module-level connection —
   * this SDK has no session to key a singleton off) and connects with NO
   * handshake auth token: the Gateway's connection auth is identity-optional
   * (`optionalSocketAuth`, `packages/backend/src/realtime/socket.ts`) exactly
   * so an anonymous checkout/embed payer can reach it. `subscribe`'s ack is
   * the real authorization check — it requires this intent's `client_secret`
   * — so nothing here needs an Oxy session.
   */
  async function subscribe(
    id: string,
    clientSecret: string,
    onUpdate: (intent: PaymentIntent) => void,
    onConnectionChange?: (state: RealtimeConnectionState) => void,
  ): Promise<{ unsubscribe(): void }> {
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(baseUrl, {
      transports: ['websocket'],
    });

    let ack: { ok: boolean };
    try {
      ack = await socket.emitWithAck('subscribe', { intent_id: id, client_secret: clientSecret });
    } catch (cause) {
      socket.disconnect();
      throw new PeableApiError(
        `Failed to reach the Peable Gateway realtime layer at ${baseUrl}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
    if (!ack.ok) {
      socket.disconnect();
      // The Gateway's `subscribe` handler returns this SAME {ok:false} for
      // an unknown intent AND a wrong client_secret (anti-enumeration — see
      // `realtime/socket.ts`), so this is deliberately InvalidRequestError,
      // not PermissionError: there is no signal here to tell the two apart.
      throw new PeableInvalidRequestError(
        `Gateway rejected subscription to payment intent ${id} ` +
          '(unknown payment intent or invalid client_secret)',
      );
    }

    // The socket only ever carries this one subscription, but filter by id
    // anyway — matching the wallet's per-intent filter exactly means a future
    // change there (e.g. a shared connection) can't silently leak another
    // intent's updates into this caller's `onUpdate`.
    const listener = (intent: PaymentIntent): void => {
      if (intent.id === id) {
        onUpdate(intent);
      }
    };
    socket.on('intent.updated', listener);

    // A drop AFTER this point used to be invisible to the caller. `subscribe`
    // had already resolved, so a `.catch` on it could not fire again, and the
    // reconnect below restores DELIVERY but replays nothing — socket.io has no
    // buffer for frames emitted while the socket was gone. A payment that
    // settled during a thirty-second blip therefore never reached the page, and
    // the payer watched a snapshot that would never update again.
    //
    // Reported rather than handled here: the SDK cannot know what a host wants
    // to do about it. The hosted checkout turns REST polling on and re-reads
    // the intent before turning it off again.
    let closedByUs = false;
    const onDisconnect = (): void => {
      if (!closedByUs) onConnectionChange?.('lost');
    };
    socket.on('disconnect', onDisconnect);

    // socket.io-client's default reconnection restores the TRANSPORT, but the
    // server spins up a fresh Socket with no room membership — so every
    // reconnect (mobile network blip, backgrounded tab, LB cycle) must re-run
    // the room-join handshake or `intent.updated` silently stops arriving for
    // the rest of the subscription's life. A hosted checkout tab can sit open
    // unattended for minutes while a payment settles, with no app-lifecycle
    // trigger to notice and recover — unlike the wallet, this can't rely on
    // the user reopening the screen. `reconnect` is a Manager-level event
    // (`socket.io`, not `socket` itself) in socket.io-client.
    const onReconnect = (): void => {
      void socket
        .emitWithAck('subscribe', { intent_id: id, client_secret: clientSecret })
        .then((ack) => {
          // `'live'` only once the ROOM is rejoined, never on the transport
          // alone: a socket that is connected and in no room delivers nothing,
          // and telling the host it is live there would have them stand their
          // fallback down into permanent silence.
          if (ack.ok) onConnectionChange?.('live');
        })
        .catch(() => {
          // The subscription is gone for good (the intent expired between drop
          // and reconnect, say). Staying `lost` is the honest report: socket.io
          // keeps retrying the transport, but nothing will arrive on it.
        });
    };
    socket.io.on('reconnect', onReconnect);

    return {
      unsubscribe(): void {
        // Set BEFORE `disconnect()`: a deliberate close fires `disconnect` like
        // any other, and reporting `'lost'` there would have a host spin up a
        // fallback for a subscription it just tore down — on an unmounting
        // component, at that.
        closedByUs = true;
        socket.off('intent.updated', listener);
        socket.off('disconnect', onDisconnect);
        socket.io.off('reconnect', onReconnect);
        socket.disconnect();
      },
    };
  }

  async function call<T>(
    path: string,
    init: {
      method?: 'GET' | 'POST';
      clientSecret?: string;
      body?: unknown;
      idempotencyKey?: string;
    },
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (init.clientSecret) headers['X-Peable-Client-Secret'] = init.clientSecret;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (cause) {
      throw new PeableApiError(
        `Failed to reach the Peable Gateway at ${baseUrl}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
    const body = await readJsonBody(response);
    if (!response.ok)
      throw errorFromResponse(response.status, body, response.headers.get('Request-Id'));
    return body as T;
  }

  const sessionPath = (id: string) => `/v1/checkout_sessions/${encodeURIComponent(id)}/public`;

  return {
    getPaymentIntent,
    subscribe,
    submitTx,
    getClientAction,
    getCheckoutSession: (id, clientSecret) =>
      call<CheckoutSessionPublic>(sessionPath(id), { clientSecret }),
    updateCheckoutSession: (id, clientSecret, params) =>
      call<CheckoutSessionPublic>(sessionPath(id), { method: 'POST', clientSecret, body: params }),
    confirmCheckoutSession: (id, clientSecret) =>
      call<CheckoutSessionPublic>(`${sessionPath(id)}/confirm`, {
        method: 'POST',
        clientSecret,
        body: {},
      }),
    getSetupIntent: (id, clientSecret) =>
      call<SetupIntent>(`/v1/setup_intents/${encodeURIComponent(id)}`, { clientSecret }),
    getSetupClientAction: (id, clientSecret) =>
      call<PeableClientAction>(`/v1/setup_intents/${encodeURIComponent(id)}/client_action`, {
        method: 'POST',
        clientSecret,
      }),
    getPaymentLink: (id) =>
      call<PublicPaymentLink>(`/v1/payment_links/${encodeURIComponent(id)}/public`, {}),
    startPaymentLinkSession: (id, params = {}, idempotencyKey) =>
      call<PaymentLinkSessionStart>(
        `/v1/payment_links/${encodeURIComponent(id)}/checkout_sessions`,
        {
          method: 'POST',
          body: params,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
      ),
  };
}
