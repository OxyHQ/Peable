import type { AuthenticatedResponseRequest } from '@oxy.so/core';
import type { Merchant, PaymentIntent, WebhookDelivery } from '@peable.to/shared-types';

export const ORBIT_ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type OrbitEnvironment = (typeof ORBIT_ENVIRONMENTS)[number];
export interface OrbitScope {
  applicationId: string;
  environment: OrbitEnvironment;
}
export interface OrbitTransport {
  requestAuthenticatedResponse(request: AuthenticatedResponseRequest): Promise<Response>;
}
export interface OrbitPage<T> {
  data: T[];
  hasMore: boolean;
}
export type OrbitPayment = Pick<
  PaymentIntent,
  | 'id'
  | 'status'
  | 'rail'
  | 'amount'
  | 'currency'
  | 'createdAt'
  | 'updatedAt'
  | 'txid'
  | 'confirmations'
>;
export type OrbitMerchant = Pick<
  Merchant,
  'id' | 'displayName' | 'environment' | 'oxyAppId' | 'network' | 'webhookUrl'
>;
export type OrbitDelivery = Pick<
  WebhookDelivery,
  'id' | 'eventId' | 'eventType' | 'intentId' | 'attempts' | 'lastStatus' | 'createdAt'
>;
export class OrbitReadError extends Error {
  constructor(readonly status: number) {
    super(`Orbit request failed (HTTP ${status})`);
  }
}
export function orbitPath(scope: OrbitScope, resource: string, cursor?: string): string {
  if (!scope.applicationId.trim() || !ORBIT_ENVIRONMENTS.includes(scope.environment))
    throw new Error('Select an application and environment');
  const query = new URLSearchParams({ environment: scope.environment });
  if (cursor) query.set('starting_after', cursor);
  if (resource === 'payment_intents' || resource === 'webhook_deliveries') query.set('limit', '20');
  return `/v1/dashboard/applications/${encodeURIComponent(scope.applicationId)}/${resource}?${query}`;
}
export function orbitKey(viewer: string, organization: string, scope: OrbitScope) {
  return ['orbit', viewer, organization, scope.applicationId, scope.environment] as const;
}
const payment = (value: PaymentIntent): OrbitPayment => {
  const { id, status, rail, amount, currency, createdAt, updatedAt, txid, confirmations } = value;
  return { id, status, rail, amount, currency, createdAt, updatedAt, txid, confirmations };
};
const delivery = (value: WebhookDelivery): OrbitDelivery => {
  const { id, eventId, eventType, intentId, attempts, lastStatus, createdAt } = value;
  return { id, eventId, eventType, intentId, attempts, lastStatus, createdAt };
};
/** Only authenticated GETs. Domain envelopes stay intact; payer capabilities never enter UI state. */
export function createOrbitReader(client: OrbitTransport) {
  async function read<T>(scope: OrbitScope, resource: string, cursor?: string): Promise<T> {
    const response = await client.requestAuthenticatedResponse({
      method: 'GET',
      url: orbitPath(scope, resource, cursor),
    });
    if (!response.ok) throw new OrbitReadError(response.status);
    return response.json();
  }
  async function page<T, U>(
    scope: OrbitScope,
    resource: string,
    project: (row: T) => U,
    cursor?: string,
  ): Promise<OrbitPage<U>> {
    const result = await read<{ object: string; data: T[]; has_more: boolean }>(
      scope,
      resource,
      cursor,
    );
    if (
      result?.object !== 'list' ||
      !Array.isArray(result.data) ||
      typeof result.has_more !== 'boolean'
    )
      throw new Error('Invalid Orbit list response');
    return { data: result.data.map(project), hasMore: result.has_more };
  }
  return {
    async merchant(scope: OrbitScope): Promise<OrbitMerchant> {
      const result = await read<Merchant>(scope, 'merchant');
      if (
        result.object !== 'merchant' ||
        result.oxyAppId !== scope.applicationId ||
        result.environment !== scope.environment
      )
        throw new Error('Merchant scope mismatch');
      const { id, displayName, environment, oxyAppId, network, webhookUrl } = result;
      return { id, displayName, environment, oxyAppId, network, webhookUrl };
    },
    payments: (scope: OrbitScope, cursor?: string) =>
      page(scope, 'payment_intents', payment, cursor),
    deliveries: (scope: OrbitScope, cursor?: string) =>
      page(scope, 'webhook_deliveries', delivery, cursor),
    async payment(scope: OrbitScope, id: string) {
      const result = await read<PaymentIntent>(scope, `payment_intents/${encodeURIComponent(id)}`);
      if (result.object !== 'payment_intent' || result.id !== id)
        throw new Error('Payment identity mismatch');
      return payment(result);
    },
  };
}
/** Exact decimal display; no float conversion and no assumed two-decimal currency. */
export function orbitAmount(amount: string, currency: string): string {
  if (!/^\d+$/.test(amount)) return `${amount} ${currency}`;
  const digits =
    currency === 'FAIR'
      ? 8
      : new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
          .maximumFractionDigits;
  const places = digits ?? 2;
  const padded = amount.padStart(places + 1, '0');
  return `${places ? `${padded.slice(0, -places)}.${padded.slice(-places)}` : padded} ${currency}`;
}
