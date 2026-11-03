// The ONLY place the checkout-session and payment-link flows touch
// `@peable.to/sdk/checkout` — the session/link twin of `intentClient.ts`, so
// tests mock this module rather than the SDK, and nothing here hand-rolls a
// gateway request the SDK already makes.
import { createPeableCheckout, type PeableClientAction } from '@peable.to/sdk/checkout';
import type {
  CheckoutSessionPublic,
  CreatePaymentLinkSessionParams,
  PaymentLinkSessionStart,
  PublicPaymentLink,
  UpdateCheckoutSessionPublicParams,
} from '@peable.to/shared-types';
import { GATEWAY_URL } from './config';

const client = createPeableCheckout({ gatewayUrl: GATEWAY_URL });

export function getCheckoutSession(
  id: string,
  clientSecret: string,
): Promise<CheckoutSessionPublic> {
  return client.getCheckoutSession(id, clientSecret);
}

export function updateCheckoutSession(
  id: string,
  clientSecret: string,
  params: UpdateCheckoutSessionPublicParams,
): Promise<CheckoutSessionPublic> {
  return client.updateCheckoutSession(id, clientSecret, params);
}

export function confirmCheckoutSession(
  id: string,
  clientSecret: string,
): Promise<CheckoutSessionPublic> {
  return client.confirmCheckoutSession(id, clientSecret);
}

export function getPaymentLink(id: string): Promise<PublicPaymentLink> {
  return client.getPaymentLink(id);
}

export function startPaymentLinkSession(
  id: string,
  params: CreatePaymentLinkSessionParams,
  idempotencyKey?: string,
): Promise<PaymentLinkSessionStart> {
  return client.startPaymentLinkSession(id, params, idempotencyKey);
}

/**
 * `POST /v1/setup_intents/:id/client_action` — what a setup-mode session
 * confirms its card with. The SetupIntent's own `client_secret` goes in the
 * HEADER, never the URL.
 */
export async function getSetupClientAction(
  id: string,
  clientSecret: string,
): Promise<PeableClientAction> {
  const response = await fetch(
    `${GATEWAY_URL}/v1/setup_intents/${encodeURIComponent(id)}/client_action`,
    { method: 'POST', headers: { 'X-Peable-Client-Secret': clientSecret } },
  );
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error =
      typeof body === 'object' && body !== null
        ? (body as { error?: { message?: unknown } }).error
        : undefined;
    throw new Error(
      typeof error?.message === 'string'
        ? error.message
        : `The setup could not be prepared (${response.status})`,
    );
  }
  return body as PeableClientAction;
}
