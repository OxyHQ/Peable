import type {
  CreatePriceParams,
  CreateProductParams,
  CreateTaxRegistrationParams,
  DeletedProduct,
  Price,
  Product,
  UpdatePriceParams,
  UpdateProductParams,
  Merchant,
  PaymentIntent,
  PaymentIntentStatus,
  TaxCode,
  TaxProductCode,
  TaxRegistration,
  TaxReport,
  TaxSettings,
  UpdateTaxSettingsParams,
  CreateWebhookEndpointParams,
  DeletedWebhookEndpoint,
  UpdateWebhookEndpointParams,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEvent,
} from '@peable.to/shared-types';
import { isOrbitApiError, type OrbitTransport, type Query, withQuery } from './transport';

/**
 * The two environments Orbit's Test / Live toggle selects. `staging` exists on
 * the gateway (`OXY_SERVICE_ENVIRONMENTS`) and is deliberately not offered:
 * a merchant thinks in test and live.
 */
export type OrbitEnvironment = 'development' | 'production';

/** Everything under `/v1/dashboard/applications/:applicationId/*` is scoped by this pair. */
export interface DashboardScope {
  applicationId: string;
  environment: OrbitEnvironment;
}

/** A Peable list (ADR 0014 D1). */
export interface ListPage<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
  /** The path that was listed. */
  url: string;
}

export interface PageParams {
  limit?: number;
  starting_after?: string;
}

export interface EventListParams extends PageParams {
  /** An exact type, or a prefix ending in `.*`. */
  type?: string;
}

export interface DeliveryListParams extends PageParams {
  /** Only the deliveries of this event (`evt_…`). */
  event?: string;
  /** Only the deliveries to this endpoint (`we_…`). */
  webhook_endpoint?: string;
}

export interface ProductListParams extends PageParams {
  /** `true` sellable, `false` archived; absent for both. */
  active?: boolean;
}

export interface PriceListParams extends PageParams {
  /** Only this product's prices (`prod_…`). */
  product?: string;
  active?: boolean;
}

export interface PaymentIntentListParams extends PageParams {
  status?: PaymentIntentStatus;
}

/** `POST /merchant`: mirrors the gateway's `createMerchantBodySchema` (strict). */
export interface RegisterMerchantBody {
  /** The FairCoin half: both `network` and `xpub`, or neither (a card-only merchant). */
  network?: 'mainnet' | 'testnet';
  /** A WATCH-ONLY account xpub. The gateway refuses a private extended key. */
  xpub?: string;
  required_confirmations?: number;
  display_name?: string;
  description?: string;
}

/** `PATCH /merchant`: mirrors `patchMerchantBodySchema` (strict). `null` clears a field. */
export interface UpdateMerchantBody {
  required_confirmations?: number;
  display_name?: string | null;
  description?: string | null;
}

/** `/v1/dashboard/applications/:id<rest>?environment=…&<query>`. */
export function dashboardPath(scope: DashboardScope, rest: string, query?: Query): string {
  const base = `/v1/dashboard/applications/${encodeURIComponent(scope.applicationId)}${rest}`;
  return withQuery(base, { environment: scope.environment, ...query });
}

/** Refuse anything that is not a list envelope instead of rendering it as an empty list. */
export function assertList<T>(body: unknown): ListPage<T> {
  if (
    !body ||
    typeof body !== 'object' ||
    (body as { object?: unknown }).object !== 'list' ||
    !Array.isArray((body as { data?: unknown }).data)
  ) {
    throw new Error('The gateway answered with something that is not a list');
  }
  const page = body as { data: T[]; has_more?: unknown; url?: unknown };
  return {
    object: 'list',
    data: page.data,
    has_more: page.has_more === true,
    url: typeof page.url === 'string' ? page.url : '',
  };
}

/**
 * The gateway's answer for an application with no merchant in this environment
 * (`resolveMerchantByApp`): 404. Every merchant-scoped dashboard route gives
 * it, so a screen can tell "register first" apart from a real failure.
 */
export function isMerchantMissing(error: unknown): boolean {
  return isOrbitApiError(error) && error.status === 404;
}

const id = (value: string) => encodeURIComponent(value);

export function createDashboardApi(transport: OrbitTransport) {
  const get = <T>(path: string) => transport.request<T>('GET', path);
  const list = async <T>(path: string) => assertList<T>(await get<unknown>(path));

  return {
    merchant: {
      /** `null` when the application has no merchant in this environment yet. */
      async retrieve(scope: DashboardScope): Promise<Merchant | null> {
        try {
          return await get<Merchant>(dashboardPath(scope, '/merchant'));
        } catch (error) {
          if (isMerchantMissing(error)) return null;
          throw error;
        }
      },
      register: (scope: DashboardScope, body: RegisterMerchantBody) =>
        transport.request<Merchant>('POST', dashboardPath(scope, '/merchant'), { body }),
      update: (scope: DashboardScope, body: UpdateMerchantBody) =>
        transport.request<Merchant>('PATCH', dashboardPath(scope, '/merchant'), { body }),
    },

    paymentIntents: {
      list: (scope: DashboardScope, params: PaymentIntentListParams = {}) =>
        list<PaymentIntent>(dashboardPath(scope, '/payment_intents', { ...params })),
      retrieve: (scope: DashboardScope, intentId: string) =>
        get<PaymentIntent>(dashboardPath(scope, `/payment_intents/${id(intentId)}`)),
    },

    /** The catalog's products (ADR 0018). A product with prices is archived, not deleted. */
    products: {
      list: (scope: DashboardScope, params: ProductListParams = {}) =>
        list<Product>(dashboardPath(scope, '/products', { ...params })),
      retrieve: (scope: DashboardScope, productId: string) =>
        get<Product>(dashboardPath(scope, `/products/${id(productId)}`)),
      create: (scope: DashboardScope, body: CreateProductParams) =>
        transport.request<Product>('POST', dashboardPath(scope, '/products'), { body }),
      update: (scope: DashboardScope, productId: string, body: UpdateProductParams) =>
        transport.request<Product>('POST', dashboardPath(scope, `/products/${id(productId)}`), {
          body,
        }),
      delete: (scope: DashboardScope, productId: string) =>
        transport.request<DeletedProduct>(
          'DELETE',
          dashboardPath(scope, `/products/${id(productId)}`),
        ),
    },

    /** Prices are immutable but for `active`, `nickname`, `metadata`, `lookup_key`. */
    prices: {
      list: (scope: DashboardScope, params: PriceListParams = {}) =>
        list<Price>(dashboardPath(scope, '/prices', { ...params })),
      create: (scope: DashboardScope, body: CreatePriceParams) =>
        transport.request<Price>('POST', dashboardPath(scope, '/prices'), { body }),
      update: (scope: DashboardScope, priceId: string, body: UpdatePriceParams) =>
        transport.request<Price>('POST', dashboardPath(scope, `/prices/${id(priceId)}`), {
          body,
        }),
    },

    /**
     * Where this merchant's events are sent (ADR 0014 D4). `secret` is on the
     * answer of `create` and `rollSecret` ONLY — show it then, or never.
     */
    webhookEndpoints: {
      list: (scope: DashboardScope, params: PageParams = {}) =>
        list<WebhookEndpoint>(dashboardPath(scope, '/webhook_endpoints', { ...params })),
      create: (scope: DashboardScope, body: CreateWebhookEndpointParams) =>
        transport.request<WebhookEndpoint>('POST', dashboardPath(scope, '/webhook_endpoints'), {
          body,
        }),
      update: (scope: DashboardScope, endpointId: string, body: UpdateWebhookEndpointParams) =>
        transport.request<WebhookEndpoint>(
          'POST',
          dashboardPath(scope, `/webhook_endpoints/${id(endpointId)}`),
          { body },
        ),
      delete: (scope: DashboardScope, endpointId: string) =>
        transport.request<DeletedWebhookEndpoint>(
          'DELETE',
          dashboardPath(scope, `/webhook_endpoints/${id(endpointId)}`),
        ),
      /** `expiresInSeconds` keeps the previous secret signing beside the new one (≤ 24h). */
      rollSecret: (scope: DashboardScope, endpointId: string, expiresInSeconds: number) =>
        transport.request<WebhookEndpoint>(
          'POST',
          dashboardPath(scope, `/webhook_endpoints/${id(endpointId)}/roll_secret`),
          { body: { expires_in_seconds: expiresInSeconds } },
        ),
      /** A `webhook_endpoint.test` event to this endpoint only; answers its delivery. */
      sendTest: (scope: DashboardScope, endpointId: string) =>
        transport.request<WebhookDelivery>(
          'POST',
          dashboardPath(scope, `/webhook_endpoints/${id(endpointId)}/test`),
          { body: {} },
        ),
    },

    /** Every event of the last 30 days, as its deliveries carried it. */
    events: {
      list: (scope: DashboardScope, params: EventListParams = {}) =>
        list<WebhookEvent>(dashboardPath(scope, '/events', { ...params })),
    },

    webhookDeliveries: {
      list: (scope: DashboardScope, params: DeliveryListParams = {}) =>
        list<WebhookDelivery>(dashboardPath(scope, '/webhook_deliveries', { ...params })),
      /** Sends the same stored event again, now, as a new delivery, and answers with it. */
      redeliver: (scope: DashboardScope, deliveryId: string) =>
        transport.request<WebhookDelivery>(
          'POST',
          dashboardPath(scope, `/webhook_deliveries/${id(deliveryId)}/redeliver`),
        ),
    },

    /**
     * Peable Tax for the application's owner — the same routes the wallet's tax
     * screen calls (`billing:read` to look, `billing:manage` to change).
     */
    tax: {
      settings: (scope: DashboardScope) => get<TaxSettings>(dashboardPath(scope, '/tax/settings')),
      updateSettings: (scope: DashboardScope, body: UpdateTaxSettingsParams) =>
        transport.request<TaxSettings>('PATCH', dashboardPath(scope, '/tax/settings'), { body }),
      codes: (scope: DashboardScope) => list<TaxCode>(dashboardPath(scope, '/tax/codes')),
      registrations: (scope: DashboardScope) =>
        list<TaxRegistration>(dashboardPath(scope, '/tax/registrations')),
      addRegistration: (scope: DashboardScope, body: CreateTaxRegistrationParams) =>
        transport.request<TaxRegistration>('POST', dashboardPath(scope, '/tax/registrations'), {
          body,
        }),
      deleteRegistration: (scope: DashboardScope, registrationId: string) =>
        transport.request<void>(
          'DELETE',
          dashboardPath(scope, `/tax/registrations/${id(registrationId)}`),
        ),
      /** `expiresAt` is Unix seconds. */
      endRegistration: (scope: DashboardScope, registrationId: string, expiresAt: number) =>
        transport.request<TaxRegistration>(
          'POST',
          dashboardPath(scope, `/tax/registrations/${id(registrationId)}/end`),
          { body: { expires_at: expiresAt } },
        ),
      products: (scope: DashboardScope) =>
        list<TaxProductCode>(dashboardPath(scope, '/tax/products')),
      setProductCode: (scope: DashboardScope, productRef: string, taxCode: string) =>
        transport.request<TaxProductCode>(
          'PUT',
          dashboardPath(scope, `/tax/products/${id(productRef)}`),
          { body: { tax_code: taxCode } },
        ),
      approve: (scope: DashboardScope) =>
        transport.request<{ settings: TaxSettings; registrations: TaxRegistration[] }>(
          'POST',
          dashboardPath(scope, '/tax/approve'),
          { body: {} },
        ),
      /** `from` inclusive, `to` exclusive, both Unix seconds. */
      report: (scope: DashboardScope, from: number, to: number) =>
        get<TaxReport>(dashboardPath(scope, '/tax/reports/summary', { from, to })),
    },
  };
}

export type DashboardApi = ReturnType<typeof createDashboardApi>;
