// The payer-facing billing routes (ADR 0018): a hosted invoice and the
// customer portal, both authorized by a bearer token in the URL path. Like the
// links and sessions, they have no SDK client core, so this module calls the
// gateway directly — and keeps the HTTP status, because "this link expired"
// (404) is an answer the page renders differently from "try again".
import type {
  PublicInvoice,
  PublicInvoicePayment,
  PublicPortalSession,
} from '@peable.to/shared-types';
import type { PeableClientAction } from '@peable.to/sdk/checkout';
import { GATEWAY_URL } from './config';

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${GATEWAY_URL}${path}`, init);
  if (!response.ok) {
    let message = `The request failed (${response.status}).`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // Not JSON: keep the generic message. A token is never echoed back.
    }
    throw new GatewayError(response.status, message);
  }
  return (await response.json()) as T;
}

function post<T>(
  path: string,
  body: unknown = {},
  headers: Record<string, string> = {},
): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const invoicePath = (token: string) => `/v1/invoices/public/${encodeURIComponent(token)}`;
const portalPath = (token: string) => `/v1/billing_portal/public/${encodeURIComponent(token)}`;

export function getPublicInvoice(token: string): Promise<PublicInvoice> {
  return request<PublicInvoice>(invoicePath(token));
}

/** The PaymentIntent the payer completes for this invoice (the same one while it can still be paid). */
export function payPublicInvoice(
  token: string,
  paymentMethodType?: 'card' | 'faircoin',
): Promise<PublicInvoicePayment> {
  return post<PublicInvoicePayment>(
    `${invoicePath(token)}/pay`,
    paymentMethodType ? { payment_method_type: paymentMethodType } : {},
  );
}

export function getPortal(token: string): Promise<PublicPortalSession> {
  return request<PublicPortalSession>(portalPath(token));
}

export type PortalAction = 'cancel' | 'renew' | 'change_plan' | 'customer';

/** A portal action; the gateway answers the session as it now stands. */
export function portalAction(
  token: string,
  action: PortalAction,
  body: Record<string, unknown>,
): Promise<PublicPortalSession> {
  return post<PublicPortalSession>(`${portalPath(token)}/${action}`, body);
}

export function startPaymentMethodUpdate(
  token: string,
): Promise<{ setup_intent: string; client_secret: string }> {
  return post(`${portalPath(token)}/payment_method_update`);
}

export function finishPaymentMethodUpdate(
  token: string,
  setupIntent: string,
): Promise<{ status: 'succeeded' | 'pending'; session: PublicPortalSession }> {
  return post(`${portalPath(token)}/payment_method_update/complete`, { setup_intent: setupIntent });
}

/**
 * The provider's confirmation credential for a SetupIntent, read with the
 * intent's client secret in a header (never the URL), `no-store` on the
 * gateway side.
 */
export function getSetupClientAction(
  setupIntent: string,
  clientSecret: string,
): Promise<PeableClientAction> {
  return post<PeableClientAction>(
    `/v1/setup_intents/${encodeURIComponent(setupIntent)}/client_action`,
    {},
    { 'X-Peable-Client-Secret': clientSecret },
  );
}
