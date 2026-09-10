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
import type { PaymentIntent } from '@peable.to/shared-types';
import { errorFromResponse, PeableApiError, PeableInvalidRequestError } from '../core/errors';

const DEFAULT_GATEWAY_URL = 'https://api.peable.to';

export interface PeableCheckoutClient {
  /**
   * `GET /v1/payment_intents/:id` — the initial REST snapshot. Sends
   * `clientSecret` via the `X-Peable-Client-Secret` header, never a query
   * param, so the capability token never lands in server/CDN access logs.
   */
  getPaymentIntent(id: string, clientSecret: string): Promise<PaymentIntent>;
  /** Realtime status stream over the Gateway's socket contract, filtered to this intent. */
  subscribe(
    id: string,
    clientSecret: string,
    onUpdate: (intent: PaymentIntent) => void,
  ): Promise<{ unsubscribe(): void }>;
  /** `POST /v1/payment_intents/:id/submit_tx` — report a broadcast txid. */
  submitTx(id: string, clientSecret: string, txid: string): Promise<PaymentIntent>;
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
    payload: { intentId: string; clientSecret: string },
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
export function createPeableCheckout(
  opts: CreatePeableCheckoutOptions = {},
): PeableCheckoutClient {
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
    if (!response.ok) throw errorFromResponse(response.status, body);
    return body as PaymentIntent;
  }

  async function submitTx(id: string, clientSecret: string, txid: string): Promise<PaymentIntent> {
    let response: Response;
    try {
      response = await fetch(
        `${baseUrl}/v1/payment_intents/${encodeURIComponent(id)}/submit_tx`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_secret: clientSecret, txid }),
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
    if (!response.ok) throw errorFromResponse(response.status, body);
    return body as PaymentIntent;
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
  ): Promise<{ unsubscribe(): void }> {
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(baseUrl, {
      transports: ['websocket'],
    });

    let ack: { ok: boolean };
    try {
      ack = await socket.emitWithAck('subscribe', { intentId: id, clientSecret });
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
      void socket.emitWithAck('subscribe', { intentId: id, clientSecret }).catch(() => {
        // Fire-and-forget: `onUpdate` has no error channel to surface a
        // failed resubscribe (e.g. the intent expired between drop and
        // reconnect) — socket.io keeps retrying the transport regardless, so
        // there is nothing actionable to do with this rejection here.
      });
    };
    socket.io.on('reconnect', onReconnect);

    return {
      unsubscribe(): void {
        socket.off('intent.updated', listener);
        socket.io.off('reconnect', onReconnect);
        socket.disconnect();
      },
    };
  }

  return { getPaymentIntent, subscribe, submitTx };
}
