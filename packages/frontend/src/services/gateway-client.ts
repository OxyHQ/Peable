import type { NetworkType } from '@fairco.in/core';
import type {
  PaymentIntent,
  SocialNextAddressResponse,
  SocialReceiveCursorResponse,
  EnrichmentResult,
  SocialPaymentsResponse,
} from '@peable.to/shared-types';
import { oxyServices } from '@/services/oxy-services';
import { GATEWAY_API_URL } from '@/config';

/**
 * HTTP client for the Peable Gateway backend (`api.peable.to`).
 *
 * A linked client owns its own base URL, cache, and request queue, but keeps its
 * bearer token in lockstep with the canonical Oxy session and delegates 401
 * refresh back to it — so the SDK re-mints the short access token from the device
 * secret when it expires. No app-local token provider or `Authorization` header.
 * GET caching stays OFF (the SDK cannot invalidate the Gateway's own resources);
 * React Query owns any caching in the consuming layer.
 */
export const gateway = oxyServices.createLinkedClient({ baseURL: GATEWAY_API_URL });

/**
 * Report a broadcast FairCoin txid for a payment intent — the payer path.
 * Possession of the intent's `client_secret` is the authorization; the reported
 * txid is what the Gateway's settlement watcher then verifies on-chain.
 *
 * The Gateway returns the updated `PaymentIntent` DTO directly (no `{ data }`
 * envelope — verified against `packages/backend/src/routes/paymentIntents.ts`),
 * so the linked client's parsed body IS the intent.
 */
export async function submitTx(
  intentId: string,
  clientSecret: string,
  txid: string,
): Promise<PaymentIntent> {
  return gateway.client.post<PaymentIntent>(
    `/v1/payment_intents/${intentId}/submit_tx`,
    { client_secret: clientSecret, txid },
  );
}

/**
 * Thrown by {@link reserveNextSocialAddress} when the recipient has no Oxy
 * identity key to derive a receive address from (spec §4.5's "invite them"
 * path). Distinguished from every other failure by the backend's dedicated
 * `409` status (see `routes/social.ts`), so this wrapping never
 * misclassifies an unrelated server/network error as "keyless".
 */
export class KeylessRecipientError extends Error {
  constructor(username: string) {
    super(`@${username} has not set up an Oxy identity yet`);
    this.name = 'KeylessRecipientError';
  }
}

function hasStatus(error: unknown): error is { status: number } {
  return typeof error === 'object' && error !== null && 'status' in error &&
    typeof (error as { status: unknown }).status === 'number';
}

/**
 * Reserve the next fresh social-receive address for `@username` (spec §4.4
 * step 3). Possession of the caller's own Oxy bearer token (carried
 * automatically by the linked client) authorizes the call; the reservation
 * is also recorded server-side as the sender's attribution for this payment
 * (spec §4.8 bullet 2), so a later `enrichAddresses` call renders "Sent to
 * @username" from this app's OWN history without any further action here.
 */
export async function reserveNextSocialAddress(
  username: string,
  network: NetworkType,
): Promise<SocialNextAddressResponse> {
  try {
    return await gateway.client.post<SocialNextAddressResponse>(
      `/v1/social/${encodeURIComponent(username)}/next_address`,
      { network },
    );
  } catch (error: unknown) {
    if (hasStatus(error) && error.status === 409) {
      throw new KeylessRecipientError(username);
    }
    throw error;
  }
}

/**
 * Resolve display identity for a batch of the caller's own addresses (spec
 * §4.8) — "Paid at <merchant>" / "Sent to @x" / "Received from @x" / an
 * honest `unknown` for a pure external payment. Display-only: a failure here
 * must never be treated as a payment failure by callers.
 *
 * The Gateway sends `{ data: map }` (see `routes/enrich.ts`), but the linked
 * client's `unwrapResponse` already strips a top-level `data` key with no
 * `pagination` sibling before resolving — so the parsed body IS the naked
 * map already. Returning `.data` here would unwrap a second time and yield
 * `undefined`.
 */
export async function enrichAddresses(
  addresses: string[],
): Promise<Record<string, EnrichmentResult>> {
  return gateway.client.post<Record<string, EnrichmentResult>>('/v1/enrich', { addresses });
}

/**
 * Resync this device's social-receive watch window against the backend's
 * reservation cursor (finding: cursor-sync HIGH). `reserveNextSocialAddress`
 * advances the recipient's cursor on every call regardless of whether the
 * reserved address is ever paid, but a receiving device only widens its
 * local watch window when a payment lands on an index it already watches —
 * so a burst of reservations with no payment in between can silently outrun
 * the device. This endpoint is read-only (reserves nothing), so a device
 * can poll it freely to widen its window to `0..reservedThrough+gap`.
 *
 * The Gateway returns `{ reservedThrough }` directly (no `{ data }` envelope
 * — verified against `packages/backend/src/routes/social.ts`'s
 * `GET /v1/social/me/cursor`), so the linked client's parsed body IS the
 * cursor. Returning `.data` here would unwrap a second time and yield
 * `undefined`.
 */
export async function getSocialReceiveCursor(
  network: NetworkType,
): Promise<SocialReceiveCursorResponse> {
  return gateway.client.get<SocialReceiveCursorResponse>('/v1/social/me/cursor', {
    params: { network },
  });
}

/**
 * The caller's own social payment history — the one payment view a surface
 * without a key can ask for.
 *
 * Every other view starts from addresses the device derived (`enrichAddresses`,
 * `getSocialReceiveCursor`), which needs a seed. The web build has none, so it
 * asks by identity instead and the backend answers from the attribution rows
 * the caller is already a named party to.
 *
 * Returns `{ payments }` directly (no `{ data }` envelope) — same shape as
 * `GET /v1/social/me/cursor`; see that function for why unwrapping again would
 * yield `undefined`.
 */
export async function getMyPayments(
  network: NetworkType,
): Promise<SocialPaymentsResponse> {
  return gateway.client.get<SocialPaymentsResponse>('/v1/social/me/payments', {
    params: { network },
  });
}
