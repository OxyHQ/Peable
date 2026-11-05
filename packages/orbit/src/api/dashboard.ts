import type {
  CreatePaymentMethodConfigurationParams,
  CreatePaymentMethodDomainParams,
  CheckoutLineItem,
  CreatePaymentLinkParams,
  MerchantBranding,
  MerchantEmailSettings,
  PaymentLink,
  UpdateMerchantBrandingParams,
  UpdateMerchantEmailSettingsParams,
  UpdatePaymentLinkParams,
  ActiveEntitlement,
  BillingSettings,
  CreateEntitlementFeatureParams,
  Customer,
  CustomerBalanceTransaction,
  EntitlementFeature,
  Invoice,
  InvoiceStatus,
  ProductFeature,
  Subscription,
  SubscriptionStatus,
  UpdateBillingSettingsParams,
  UpdateEntitlementFeatureParams,
  UpdateSubscriptionParams,
  CreatePriceParams,
  CreateProductParams,
  CreateReportRunParams,
  Charge,
  ReportRun,
  ReportType,
  ReportTypeId,
  Refund,
  SearchableResource,
  Account,
  AccountLink,
  Balance,
  BalanceTransaction,
  BalanceTransactionType,
  CreateAccountLinkParams,
  CreatePayoutParams,
  Payout,
  PayoutReconciliationReport,
  PayoutStatus,
  ReconciliationMismatch,
  UpdateAccountParams,
  CreateTaxRegistrationParams,
  DeletedProduct,
  Dispute,
  FileObject,
  FilePurpose,
  FileUploadPurpose,
  PaymentMethodConfiguration,
  PaymentMethodDomain,
  Price,
  Product,
  UpdateDisputeParams,
  UpdatePaymentMethodConfigurationParams,
  UpdatePaymentMethodDomainParams,
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
  WebhookEndpointWithSecret,
  WebhookEvent,
  ConnectedAccount,
  RequestLog,
  RequestLogMethod,
  RequestLogStatusFilter,
  Transfer,
  TransferReversal,
  TransferWithReversal,
} from '@peable.to/shared-types';
import { errorState } from '../ui/errorState';
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

/** `created[gte|gt|lte|lt]`, Unix seconds. */
export type CreatedFilter = {
  gte?: number;
  gt?: number;
  lte?: number;
  lt?: number;
};

export interface EventListParams extends PageParams {
  /** An exact type, or a prefix ending in `.*`. */
  type?: string;
  /** Only the events about this payment (`pi_…`). */
  payment_intent?: string;
  created?: CreatedFilter;
}

export interface RequestLogListParams extends PageParams {
  /** One code (`404`) or a class (`4xx`). */
  status?: RequestLogStatusFilter;
  method?: RequestLogMethod;
  created?: CreatedFilter;
}

export interface TransferListParams extends PageParams {
  /** Only what this seller (`ca_…`) was paid. */
  connected_account?: string;
  /** Only what this payment (`pi_…`) settled. */
  payment_intent?: string;
}

/** `POST …/connected_accounts`: mirrors the gateway's `createAccountBodySchema` (strict). */
export interface CreateConnectedAccountBody {
  /** The marketplace's own id for the seller. */
  external_ref: string;
  /** The card half: both or neither. */
  country?: string;
  business_type?: 'individual' | 'company';
  /** The FairCoin half: the seller's Oxy user registers their own key (ADR 0012). */
  faircoin?: { network: 'mainnet' | 'testnet'; oxy_user_id: string };
}

/** `POST …/connected_accounts/:id/account_links`. */
export interface SellerAccountLinkBody {
  refresh_url: string;
  return_url: string;
  rail: 'card' | 'faircoin';
}

/** `POST …/transfers/:id/reversals`. `external_ref` is the reversal's durable identity. */
export interface ReverseTransferBody {
  amount: string;
  external_ref: string;
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

export interface PaymentLinkListParams extends PageParams {
  /** `true` active, `false` deactivated; absent for both. */
  active?: boolean;
}

export interface CustomerListParams extends PageParams {
  /** An exact email. */
  email?: string;
}

export interface SubscriptionListParams extends PageParams {
  customer?: string;
  /** A status, `all` (cancelled included) or `ended`; absent hides cancelled ones. */
  status?: SubscriptionStatus | 'all' | 'ended';
}

export interface InvoiceListParams extends PageParams {
  customer?: string;
  subscription?: string;
  status?: InvoiceStatus;
}

export interface FeatureListParams extends PageParams {
  /** `true` archived only, `false` active only, absent for both. */
  archived?: boolean;
}

/** What `DELETE` of a dashboard resource answers. */
export interface Deleted {
  id: string;
  object: string;
  deleted: true;
}

export interface PaymentIntentListParams extends PageParams {
  status?: PaymentIntentStatus;
}

export interface DisputeListParams extends PageParams {
  /** Only the disputes of this payment (`pi_…`). */
  payment_intent?: string;
}

export interface FileListParams extends PageParams {
  purpose?: FilePurpose;
}

export interface PaymentMethodDomainListParams extends PageParams {
  domain_name?: string;
  enabled?: boolean;
}

/** `POST …/files`: the bytes and the purpose they are for. */
export interface UploadFileParams {
  /** Never `finance_report_run`: the gateway writes those, and refuses them as uploads. */
  purpose: FileUploadPurpose;
  /** A DOM `File` on web (its name travels with it), or any `Blob` with `filename`. */
  file: Blob;
  filename?: string;
}

export interface BalanceTransactionListParams extends PageParams {
  type?: BalanceTransactionType;
  /** `po_…`: only what that payout paid out. */
  payout?: string;
  /** The object that caused it (`ch_…`, `re_…`, …). */
  source?: string;
  currency?: string;
}

export interface PayoutListParams extends PageParams {
  status?: PayoutStatus;
}

export interface ReportRunListParams extends PageParams {
  report_type?: ReportTypeId;
}

/** The object each searchable resource's hits are. */
export interface SearchHitObjects {
  payment_intents: PaymentIntent;
  charges: Charge;
  customers: Customer;
  products: Product;
  prices: Price;
  refunds: Refund;
  subscriptions: Subscription;
  invoices: Invoice;
}

/** One resource's hits in Orbit's global search — at most five. */
export type DashboardSearchGroup = {
  [R in SearchableResource]: {
    resource: R;
    object: string;
    data: SearchHitObjects[R][];
    has_more: boolean;
  };
}[SearchableResource];

/**
 * `GET …/search?q=`: an id is looked up, a query in the search language runs
 * on every resource that has its fields, anything else is free text.
 */
export interface DashboardSearchResult {
  object: 'dashboard_search';
  q: string;
  mode: 'id' | 'query' | 'text';
  /** Only the resources with at least one hit. */
  groups: DashboardSearchGroup[];
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

/**
 * `POST /merchant/faircoin`: the merchant's FairCoin receiving key, registered
 * ONCE (ADR 0021 D5) — mirrors `registerMerchantFaircoinParams` (strict).
 */
export interface RegisterFaircoinKeyBody {
  /** A non-production merchant registers `testnet` only. */
  network: 'mainnet' | 'testnet';
  /** A WATCH-ONLY account xpub. The gateway refuses a private extended key and never stores it. */
  xpub: string;
}

/** `PATCH /merchant`: mirrors `patchMerchantBodySchema` (strict). `null` clears a field. */
export interface UpdateMerchantBody {
  required_confirmations?: number;
  display_name?: string | null;
  description?: string | null;
  /** A `file_…` of purpose `business_logo`; `null` removes the logo. */
  business_logo?: string | null;
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
 * (`resolveMerchantByApp`): 404 `merchant_missing`. Every merchant-scoped
 * dashboard route gives it, so a screen can tell "set up payments" apart from
 * a real failure — and from a 404 for ONE object (a payment that does not
 * exist), which is not a first run.
 */
export function isMerchantMissing(error: unknown): boolean {
  return errorState(error).kind === 'merchant_missing';
}

/**
 * The merchant exists but has no fiat provider account in this mode (ADR
 * 0015): 404 with `code: 'account_missing'`. A screen shows "open an account",
 * never a zero balance.
 */
export function isAccountMissing(error: unknown): boolean {
  return isOrbitApiError(error) && error.status === 404 && error.code === 'account_missing';
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
          // This route has no other 404: whatever its code, it means "none yet".
          if (isOrbitApiError(error) && error.status === 404) return null;
          throw error;
        }
      },
      register: (scope: DashboardScope, body: RegisterMerchantBody) =>
        transport.request<Merchant>('POST', dashboardPath(scope, '/merchant'), { body }),
      update: (scope: DashboardScope, body: UpdateMerchantBody) =>
        transport.request<Merchant>('PATCH', dashboardPath(scope, '/merchant'), { body }),
      /** Register the FairCoin receiving key of a merchant that has none. Immutable once set. */
      registerFaircoinKey: (scope: DashboardScope, body: RegisterFaircoinKeyBody) =>
        transport.request<Merchant>('POST', dashboardPath(scope, '/merchant/faircoin'), { body }),
    },

    /**
     * The merchant's own fiat account at the provider (ADR 0015 §1), mirrored.
     * `retrieve` answers `null` for `account_missing`; any other refusal throws.
     */
    account: {
      async retrieve(scope: DashboardScope): Promise<Account | null> {
        try {
          return await get<Account>(dashboardPath(scope, '/account'));
        } catch (error) {
          if (isAccountMissing(error)) return null;
          throw error;
        }
      },
      /** Opens the account the first time (country + business type); updates it afterwards. */
      update: (scope: DashboardScope, body: UpdateAccountParams) =>
        transport.request<Account>('POST', dashboardPath(scope, '/account'), { body }),
      /** A single-use hosted onboarding link: open it at once, never store it. */
      createLink: (scope: DashboardScope, body: CreateAccountLinkParams) =>
        transport.request<AccountLink>('POST', dashboardPath(scope, '/account_links'), { body }),
    },

    balance: {
      /** `null` for `account_missing`: no account has no balance — never zeros. */
      async retrieve(scope: DashboardScope): Promise<Balance | null> {
        try {
          return await get<Balance>(dashboardPath(scope, '/balance'));
        } catch (error) {
          if (isAccountMissing(error)) return null;
          throw error;
        }
      },
    },

    balanceTransactions: {
      list: (scope: DashboardScope, params: BalanceTransactionListParams = {}) =>
        list<BalanceTransaction>(dashboardPath(scope, '/balance_transactions', { ...params })),
      retrieve: (scope: DashboardScope, transactionId: string) =>
        get<BalanceTransaction>(dashboardPath(scope, `/balance_transactions/${id(transactionId)}`)),
    },

    /** Executed by the provider, always; Orbit instructs a manual one and mirrors the rest. */
    payouts: {
      list: (scope: DashboardScope, params: PayoutListParams = {}) =>
        list<Payout>(dashboardPath(scope, '/payouts', { ...params })),
      retrieve: (scope: DashboardScope, payoutId: string) =>
        get<Payout>(dashboardPath(scope, `/payouts/${id(payoutId)}`)),
      /** `idempotencyKey` is kept by the form across retries of the same instruction. */
      create: (scope: DashboardScope, body: CreatePayoutParams, idempotencyKey?: string) =>
        transport.request<Payout>('POST', dashboardPath(scope, '/payouts'), {
          body,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        }),
      cancel: (scope: DashboardScope, payoutId: string) =>
        transport.request<Payout>('POST', dashboardPath(scope, `/payouts/${id(payoutId)}/cancel`)),
    },

    reports: {
      /** The balance transactions one payout paid out, with `summary` over all of them. */
      async payoutReconciliation(
        scope: DashboardScope,
        payoutId: string,
        params: PageParams = {},
      ): Promise<PayoutReconciliationReport> {
        const body = await get<unknown>(
          dashboardPath(scope, '/reports/payout_reconciliation', { payout: payoutId, ...params }),
        );
        const page = assertList<BalanceTransaction>(body);
        return { ...(body as PayoutReconciliationReport), ...page };
      },
    },

    /** What the daily reconciliation found disagreeing with the provider. Never auto-corrected. */
    reconciliationMismatches: {
      list: (scope: DashboardScope, params: PageParams = {}) =>
        list<ReconciliationMismatch>(
          dashboardPath(scope, '/reconciliation_mismatches', { ...params }),
        ),
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

    /** Customers (`cus_…`): the dashboard's read-only mirror of `/v1/customers`. */
    customers: {
      list: (scope: DashboardScope, params: CustomerListParams = {}) =>
        list<Customer>(dashboardPath(scope, '/customers', { ...params })),
      retrieve: (scope: DashboardScope, customerId: string) =>
        get<Customer>(dashboardPath(scope, `/customers/${id(customerId)}`)),
      balanceTransactions: (scope: DashboardScope, customerId: string, params: PageParams = {}) =>
        list<CustomerBalanceTransaction>(
          dashboardPath(scope, `/customers/${id(customerId)}/balance_transactions`, { ...params }),
        ),
      /** What the customer is entitled to now (ADR 0018 §6) — a complete set, never paged. */
      activeEntitlements: (scope: DashboardScope, customerId: string) =>
        list<ActiveEntitlement>(
          dashboardPath(scope, '/entitlements/active_entitlements', { customer: customerId }),
        ),
    },

    /** Native subscriptions (`sub_…`, ADR 0018). */
    subscriptions: {
      list: (scope: DashboardScope, params: SubscriptionListParams = {}) =>
        list<Subscription>(dashboardPath(scope, '/subscriptions', { ...params })),
      retrieve: (scope: DashboardScope, subscriptionId: string) =>
        get<Subscription>(
          dashboardPath(scope, `/subscriptions/${id(subscriptionId)}`, {
            expand: ['latest_invoice'],
          }),
        ),
      update: (scope: DashboardScope, subscriptionId: string, body: UpdateSubscriptionParams) =>
        transport.request<Subscription>(
          'POST',
          dashboardPath(scope, `/subscriptions/${id(subscriptionId)}`),
          { body },
        ),
      /** Cancel now (`DELETE`), optionally crediting the unused time. */
      cancel: (scope: DashboardScope, subscriptionId: string, body: { prorate?: boolean } = {}) =>
        transport.request<Subscription>(
          'DELETE',
          dashboardPath(scope, `/subscriptions/${id(subscriptionId)}`),
          { body },
        ),
      /** A `paused` subscription (a trial that ended with no payment method) becomes active. */
      resume: (scope: DashboardScope, subscriptionId: string) =>
        transport.request<Subscription>(
          'POST',
          dashboardPath(scope, `/subscriptions/${id(subscriptionId)}/resume`),
          { body: {} },
        ),
    },

    /** Native invoices (`in_…`, ADR 0018). */
    invoices: {
      list: (scope: DashboardScope, params: InvoiceListParams = {}) =>
        list<Invoice>(dashboardPath(scope, '/invoices', { ...params })),
      retrieve: (scope: DashboardScope, invoiceId: string) =>
        get<Invoice>(dashboardPath(scope, `/invoices/${id(invoiceId)}`)),
      /** `finalize`, `void`, `send` (email to the customer) or `mark_uncollectible`. */
      act: (
        scope: DashboardScope,
        invoiceId: string,
        action: 'finalize' | 'void' | 'send' | 'mark_uncollectible',
      ) =>
        transport.request<Invoice>(
          'POST',
          dashboardPath(scope, `/invoices/${id(invoiceId)}/${action}`),
          { body: {} },
        ),
    },

    /** Numbering and dunning (ADR 0018 §6). Every field has a default; the row exists on first read. */
    billingSettings: {
      retrieve: (scope: DashboardScope) =>
        get<BillingSettings>(dashboardPath(scope, '/billing_settings')),
      update: (scope: DashboardScope, body: UpdateBillingSettingsParams) =>
        transport.request<BillingSettings>('POST', dashboardPath(scope, '/billing_settings'), {
          body,
        }),
    },

    /** Entitlement features (`feat_…`) and the products that grant them. */
    features: {
      list: (scope: DashboardScope, params: FeatureListParams = {}) =>
        list<EntitlementFeature>(dashboardPath(scope, '/entitlements/features', { ...params })),
      create: (scope: DashboardScope, body: CreateEntitlementFeatureParams) =>
        transport.request<EntitlementFeature>(
          'POST',
          dashboardPath(scope, '/entitlements/features'),
          { body },
        ),
      update: (scope: DashboardScope, featureId: string, body: UpdateEntitlementFeatureParams) =>
        transport.request<EntitlementFeature>(
          'POST',
          dashboardPath(scope, `/entitlements/features/${id(featureId)}`),
          { body },
        ),
      ofProduct: (scope: DashboardScope, productId: string) =>
        list<ProductFeature>(
          dashboardPath(scope, `/products/${id(productId)}/features`, { limit: 100 }),
        ),
      attach: (scope: DashboardScope, productId: string, featureId: string) =>
        transport.request<ProductFeature>(
          'POST',
          dashboardPath(scope, `/products/${id(productId)}/features`),
          { body: { entitlement_feature: featureId } },
        ),
      detach: (scope: DashboardScope, productId: string, attachmentId: string) =>
        transport.request<Deleted>(
          'DELETE',
          dashboardPath(scope, `/products/${id(productId)}/features/${id(attachmentId)}`),
        ),
    },

    /**
     * Disputes (`dp_…`). A retrieve carries `evidence` (read live by the
     * gateway; never stored by Peable); lists do not. `update` with
     * `submit: true` is ONE-SHOT at the card network, and `close` accepts the
     * dispute as lost — screens confirm both before calling.
     */
    disputes: {
      list: (scope: DashboardScope, params: DisputeListParams = {}) =>
        list<Dispute>(dashboardPath(scope, '/disputes', { ...params })),
      retrieve: (scope: DashboardScope, disputeId: string) =>
        get<Dispute>(dashboardPath(scope, `/disputes/${id(disputeId)}`)),
      update: (scope: DashboardScope, disputeId: string, body: UpdateDisputeParams) =>
        transport.request<Dispute>('POST', dashboardPath(scope, `/disputes/${id(disputeId)}`), {
          body,
        }),
      close: (scope: DashboardScope, disputeId: string) =>
        transport.request<Dispute>(
          'POST',
          dashboardPath(scope, `/disputes/${id(disputeId)}/close`),
        ),
    },

    /** Files (`file_…`), uploaded as `multipart/form-data`; stored in Oxy Files by the gateway. */
    files: {
      upload: (scope: DashboardScope, params: UploadFileParams) =>
        transport.request<FileObject>('POST', dashboardPath(scope, '/files'), {
          form: () => {
            const form = new FormData();
            form.append('purpose', params.purpose);
            if (params.filename !== undefined) form.append('file', params.file, params.filename);
            else form.append('file', params.file);
            return form;
          },
        }),
      list: (scope: DashboardScope, params: FileListParams = {}) =>
        list<FileObject>(dashboardPath(scope, '/files', { ...params })),
      retrieve: (scope: DashboardScope, fileId: string) =>
        get<FileObject>(dashboardPath(scope, `/files/${id(fileId)}`)),
      /** The bytes of a file the merchant reads back — a report run's CSV. */
      contents: (scope: DashboardScope, fileId: string) =>
        transport.request<Blob>('GET', dashboardPath(scope, `/files/${id(fileId)}/contents`), {
          responseType: 'blob',
        }),
    },

    /** Orbit's one search box over every searchable resource (Stripe's Search API beneath). */
    search: {
      global: (scope: DashboardScope, q: string) =>
        get<DashboardSearchResult>(dashboardPath(scope, '/search', { q })),
    },

    /**
     * Report runs (`frr_…`): asked for here, produced in the background as a
     * CSV `finance_report_run` File, downloaded through `files.contents`.
     */
    reporting: {
      reportTypes: (scope: DashboardScope) =>
        list<ReportType>(dashboardPath(scope, '/reporting/report_types')),
      list: (scope: DashboardScope, params: ReportRunListParams = {}) =>
        list<ReportRun>(dashboardPath(scope, '/reporting/report_runs', { ...params })),
      retrieve: (scope: DashboardScope, runId: string) =>
        get<ReportRun>(dashboardPath(scope, `/reporting/report_runs/${id(runId)}`)),
      /**
       * The same report a run would store, streamed at once
       * (`GET …/reporting/report_types/:id/csv`); a refusal is the gateway's
       * JSON error, thrown before any file.
       */
      download: (scope: DashboardScope, body: CreateReportRunParams) =>
        transport.request<Blob>(
          'GET',
          dashboardPath(scope, `/reporting/report_types/${id(body.report_type)}/csv`, {
            interval_start: body.parameters.interval_start,
            interval_end: body.parameters.interval_end,
            columns: body.parameters.columns,
            currency: body.parameters.currency,
          }),
          { responseType: 'blob' },
        ),
      /** `idempotencyKey` is kept by the form across retries of the same request. */
      create: (scope: DashboardScope, body: CreateReportRunParams, idempotencyKey?: string) =>
        transport.request<ReportRun>('POST', dashboardPath(scope, '/reporting/report_runs'), {
          body,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        }),
    },

    /** Which methods payers are offered (`pmc_…`); exactly one is the default. */
    paymentMethodConfigurations: {
      list: (scope: DashboardScope, params: PageParams = {}) =>
        list<PaymentMethodConfiguration>(
          dashboardPath(scope, '/payment_method_configurations', { ...params }),
        ),
      create: (scope: DashboardScope, body: CreatePaymentMethodConfigurationParams) =>
        transport.request<PaymentMethodConfiguration>(
          'POST',
          dashboardPath(scope, '/payment_method_configurations'),
          { body },
        ),
      retrieve: (scope: DashboardScope, configurationId: string) =>
        get<PaymentMethodConfiguration>(
          dashboardPath(scope, `/payment_method_configurations/${id(configurationId)}`),
        ),
      update: (
        scope: DashboardScope,
        configurationId: string,
        body: UpdatePaymentMethodConfigurationParams,
      ) =>
        transport.request<PaymentMethodConfiguration>(
          'POST',
          dashboardPath(scope, `/payment_method_configurations/${id(configurationId)}`),
          { body },
        ),
    },

    /** Web domains wallets (Apple Pay, Google Pay) may run on (`pmd_…`). */
    paymentMethodDomains: {
      list: (scope: DashboardScope, params: PaymentMethodDomainListParams = {}) =>
        list<PaymentMethodDomain>(dashboardPath(scope, '/payment_method_domains', { ...params })),
      create: (scope: DashboardScope, body: CreatePaymentMethodDomainParams) =>
        transport.request<PaymentMethodDomain>(
          'POST',
          dashboardPath(scope, '/payment_method_domains'),
          { body },
        ),
      retrieve: (scope: DashboardScope, domainId: string) =>
        get<PaymentMethodDomain>(dashboardPath(scope, `/payment_method_domains/${id(domainId)}`)),
      update: (scope: DashboardScope, domainId: string, body: UpdatePaymentMethodDomainParams) =>
        transport.request<PaymentMethodDomain>(
          'POST',
          dashboardPath(scope, `/payment_method_domains/${id(domainId)}`),
          { body },
        ),
      /** Ask the provider to check the domain again; answers its new wallet statuses. */
      validate: (scope: DashboardScope, domainId: string) =>
        transport.request<PaymentMethodDomain>(
          'POST',
          dashboardPath(scope, `/payment_method_domains/${id(domainId)}/validate`),
        ),
    },

    /**
     * Payment Links over catalog prices (Orbit Phase 3). The line items are
     * fixed once created; `update` changes options and `active` only.
     */
    paymentLinks: {
      list: (scope: DashboardScope, params: PaymentLinkListParams = {}) =>
        list<PaymentLink>(dashboardPath(scope, '/payment_links', { ...params })),
      retrieve: (scope: DashboardScope, linkId: string) =>
        get<PaymentLink>(dashboardPath(scope, `/payment_links/${id(linkId)}`)),
      create: (scope: DashboardScope, body: CreatePaymentLinkParams) =>
        transport.request<PaymentLink>('POST', dashboardPath(scope, '/payment_links'), { body }),
      update: (scope: DashboardScope, linkId: string, body: UpdatePaymentLinkParams) =>
        transport.request<PaymentLink>(
          'POST',
          dashboardPath(scope, `/payment_links/${id(linkId)}`),
          { body },
        ),
      lineItems: (scope: DashboardScope, linkId: string, params: PageParams = {}) =>
        list<CheckoutLineItem>(
          dashboardPath(scope, `/payment_links/${id(linkId)}/line_items`, { ...params }),
        ),
    },

    /** How hosted checkout, embedded checkout and receipts look for this merchant. */
    branding: {
      retrieve: (scope: DashboardScope) => get<MerchantBranding>(dashboardPath(scope, '/branding')),
      update: (scope: DashboardScope, body: UpdateMerchantBrandingParams) =>
        transport.request<MerchantBranding>('POST', dashboardPath(scope, '/branding'), { body }),
    },

    /** Which customer emails Peable sends for this merchant. */
    emailSettings: {
      retrieve: (scope: DashboardScope) =>
        get<MerchantEmailSettings>(dashboardPath(scope, '/email_settings')),
      update: (scope: DashboardScope, body: UpdateMerchantEmailSettingsParams) =>
        transport.request<MerchantEmailSettings>('POST', dashboardPath(scope, '/email_settings'), {
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
        transport.request<WebhookEndpointWithSecret>(
          'POST',
          dashboardPath(scope, '/webhook_endpoints'),
          { body },
        ),
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
        transport.request<WebhookEndpointWithSecret>(
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
      retrieve: (scope: DashboardScope, eventId: string) =>
        get<WebhookEvent>(dashboardPath(scope, `/events/${id(eventId)}`)),
    },

    /** The merchant's own API requests of the last 30 days (`req_…`, the `Request-Id`). */
    requestLogs: {
      list: (scope: DashboardScope, params: RequestLogListParams = {}) =>
        list<RequestLog>(dashboardPath(scope, '/request_logs', { ...params })),
      retrieve: (scope: DashboardScope, requestId: string) =>
        get<RequestLog>(dashboardPath(scope, `/request_logs/${id(requestId)}`)),
    },

    /**
     * A marketplace's sellers (`ca_…`, role seller). The merchant's own
     * account is `account` above, never one of these.
     */
    connectedAccounts: {
      list: (scope: DashboardScope, params: PageParams = {}) =>
        list<ConnectedAccount>(dashboardPath(scope, '/connected_accounts', { ...params })),
      retrieve: (scope: DashboardScope, accountId: string) =>
        get<ConnectedAccount>(dashboardPath(scope, `/connected_accounts/${id(accountId)}`)),
      /** 201 for a new seller, 200 for the one this `external_ref` already names. */
      create: (scope: DashboardScope, body: CreateConnectedAccountBody, idempotencyKey?: string) =>
        transport.request<ConnectedAccount>('POST', dashboardPath(scope, '/connected_accounts'), {
          body,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        }),
      /** Re-read the seller's account from the provider now. */
      refresh: (scope: DashboardScope, accountId: string) =>
        transport.request<ConnectedAccount>(
          'POST',
          dashboardPath(scope, `/connected_accounts/${id(accountId)}/refresh`),
          { body: {} },
        ),
      /** A single-use onboarding link for the SELLER to open — share it, never store it. */
      createLink: (scope: DashboardScope, accountId: string, body: SellerAccountLinkBody) =>
        transport.request<AccountLink>(
          'POST',
          dashboardPath(scope, `/connected_accounts/${id(accountId)}/account_links`),
          { body },
        ),
    },

    /** Settlements paid to sellers (`tr_…`) and their reversals (`trr_…`). */
    transfers: {
      list: (scope: DashboardScope, params: TransferListParams = {}) =>
        list<Transfer>(dashboardPath(scope, '/transfers', { ...params })),
      retrieve: (scope: DashboardScope, transferId: string) =>
        get<Transfer>(dashboardPath(scope, `/transfers/${id(transferId)}`)),
      /** A complete list: a settlement is reversed at most down to zero. */
      reversals: (scope: DashboardScope, transferId: string) =>
        list<TransferReversal>(dashboardPath(scope, `/transfers/${id(transferId)}/reversals`)),
      /** `idempotencyKey` is kept by the form across retries of the same reversal. */
      reverse: (
        scope: DashboardScope,
        transferId: string,
        body: ReverseTransferBody,
        idempotencyKey?: string,
      ) =>
        transport.request<TransferWithReversal>(
          'POST',
          dashboardPath(scope, `/transfers/${id(transferId)}/reversals`),
          { body, ...(idempotencyKey ? { idempotencyKey } : {}) },
        ),
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
