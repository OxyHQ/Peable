import type {
  CreateTaxRegistrationParams,
  Merchant,
  PaymentIntent,
  PaymentIntentStatus,
  TaxCode,
  TaxProductCode,
  TaxRegistration,
  TaxReport,
  TaxSettings,
  UpdateTaxSettingsParams,
  WebhookDelivery,
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

export interface PaymentIntentListParams extends PageParams {
  status?: PaymentIntentStatus;
}

/** `POST /merchant`: mirrors the gateway's `createMerchantBodySchema` (strict). */
export interface RegisterMerchantBody {
  /** The FairCoin half: both `network` and `xpub`, or neither (a card-only merchant). */
  network?: 'mainnet' | 'testnet';
  /** A WATCH-ONLY account xpub. The gateway refuses a private extended key. */
  xpub?: string;
  webhook_url?: string;
  webhook_secret?: string;
  required_confirmations?: number;
  display_name?: string;
  description?: string;
}

/** `PATCH /merchant`: mirrors `patchMerchantBodySchema` (strict). `null` clears a field. */
export interface UpdateMerchantBody {
  webhook_url?: string | null;
  webhook_secret?: string | null;
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

    webhookDeliveries: {
      list: (scope: DashboardScope, params: PageParams = {}) =>
        list<WebhookDelivery>(dashboardPath(scope, '/webhook_deliveries', { ...params })),
      /** Sends the stored envelope again, now, and answers with the updated delivery. */
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
