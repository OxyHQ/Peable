import type {
  SearchParams,
  ActiveEntitlement,
  ActiveEntitlementListParams,
  AdvanceTestClockParams,
  BillingMeter,
  BillingMeterEvent,
  BillingMeterEventSummary,
  BillingMeterEventSummaryParams,
  BillingMeterListParams,
  BillingPortalConfiguration,
  BillingPortalConfigurationListParams,
  BillingPortalSession,
  BillingSettings,
  CancelSubscriptionParams,
  CreateBillingMeterEventParams,
  CreateBillingMeterParams,
  CreateBillingPortalConfigurationParams,
  CreateBillingPortalSessionParams,
  CreateCreditNoteParams,
  CreateCustomerBalanceTransactionParams,
  CreateEntitlementFeatureParams,
  CreateInvoiceItemParams,
  CreateInvoiceParams,
  CreateSubscriptionItemParams,
  CreateSubscriptionParams,
  CreateTestClockParams,
  CreditNote,
  CreditNoteListParams,
  CustomerBalanceTransaction,
  DeletedInvoice,
  DeletedInvoiceItem,
  DeletedSubscriptionItem,
  DeletedTestClock,
  DeleteSubscriptionItemParams,
  EntitlementFeature,
  EntitlementFeatureListParams,
  ExpandParams,
  FinalizeInvoiceParams,
  Invoice,
  InvoiceItem,
  InvoiceItemListParams,
  InvoiceLineItem,
  InvoiceListParams,
  List,
  ListParams,
  PayInvoiceParams,
  RangeQuery,
  ProductFeature,
  ResumeSubscriptionParams,
  Subscription,
  SubscriptionItem,
  SubscriptionItemListParams,
  SubscriptionListParams,
  TestClock,
  UpcomingInvoiceParams,
  UpdateBillingMeterParams,
  UpdateBillingPortalConfigurationParams,
  UpdateBillingSettingsParams,
  UpdateEntitlementFeatureParams,
  UpdateInvoiceItemParams,
  UpdateInvoiceParams,
  UpdateSubscriptionItemParams,
  UpdateSubscriptionParams,
} from '@peable.to/shared-types';
import type { RestClient } from '../core/client';
import {
  type ApiListPromise,
  type ApiSearchPromise,
  listPromise,
  listQuery,
  type QueryValue,
} from '../core/list';
import { searchResource } from '../core/search';
import { BillingResource } from './billing';

/**
 * Orbit's native billing engine (ADR 0018): subscriptions, invoices, credit
 * notes, the customer balance, test clocks, billing settings, usage meters,
 * entitlements and the customer portal. Peable objects with Peable ids — the
 * provider only ever sees the PaymentIntent an invoice is collected with.
 *
 * Every amount is a base-unit STRING; the ones the wire documents as SIGNED
 * (a proration credit, a negative invoice total, a customer balance) may
 * start with `-`.
 */

/** Options of a create: your own `Idempotency-Key` (the client mints one otherwise). */
export interface BillingCreateOptions {
  idempotencyKey?: string;
}

/** `/v1/<collection>/<id>`, the id encoded. */
const path = (collection: string, id: string) => `/v1/${collection}/${encodeURIComponent(id)}`;
const booleanParam = (value: boolean | undefined) =>
  value === undefined ? undefined : String(value);

/** `X` (exactly that second) or `{ gte, lt, … }` — `key[gte]=…` on the wire. */
function rangeParam(value: number | RangeQuery | undefined): QueryValue {
  return typeof value === 'object' ? { ...value } : value;
}

/** `[{ a: 1 }]` under `key` as `key[0][a]=1` — the gateway's spelling of a list of objects in a query. */
function indexedQuery(
  key: string,
  entries: readonly Record<string, string | number | boolean | undefined>[] | undefined,
): Record<string, QueryValue> {
  const out: Record<string, QueryValue> = {};
  for (const [index, entry] of (entries ?? []).entries()) {
    for (const [field, value] of Object.entries(entry)) {
      if (value !== undefined) out[`${key}[${index}][${field}]`] = String(value);
    }
  }
  return out;
}

/** Subscriptions (`sub_…`). `cancel` ends one now; `cancel_at_period_end` (an update) at its period's end. */
export class SubscriptionsResource {
  constructor(private readonly client: RestClient) {}

  /**
   * The first invoice is priced — and, with `automatic_tax`, taxed — before
   * anything is stored; a tax that cannot be calculated refuses the create.
   */
  create(
    params: CreateSubscriptionParams & ExpandParams,
    options: BillingCreateOptions = {},
  ): Promise<Subscription> {
    return this.client.request<Subscription>('POST', '/v1/subscriptions', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }

  retrieve(id: string, params: ExpandParams = {}): Promise<Subscription> {
    return this.client.request<Subscription>('GET', path('subscriptions', id), {
      query: { expand: params.expand },
    });
  }

  /** Item changes are prorated per `proration_behavior`; `''` clears an optional field. */
  update(id: string, params: UpdateSubscriptionParams & ExpandParams): Promise<Subscription> {
    return this.client.request<Subscription>('POST', path('subscriptions', id), { body: params });
  }

  /** Cancel now (`DELETE /v1/subscriptions/:id`), optionally prorating and invoicing at once. */
  cancel(id: string, params: CancelSubscriptionParams & ExpandParams = {}): Promise<Subscription> {
    return this.client.request<Subscription>('DELETE', path('subscriptions', id), { body: params });
  }

  /** A `paused` subscription (a trial that ended with no payment method) becomes active. */
  resume(id: string, params: ResumeSubscriptionParams & ExpandParams = {}): Promise<Subscription> {
    return this.client.request<Subscription>('POST', `${path('subscriptions', id)}/resume`, {
      body: params,
    });
  }

  /** Without `status`, every subscription that is not canceled; `all` includes them. */
  list(params: SubscriptionListParams = {}): ApiListPromise<Subscription> {
    return listPromise(
      (page: SubscriptionListParams) =>
        this.client.request<List<Subscription>>('GET', '/v1/subscriptions', {
          query: listQuery(page, {
            customer: page.customer,
            price: page.price,
            status: page.status,
            test_clock: page.test_clock,
            current_period_end: rangeParam(page.current_period_end),
          }),
        }),
      params,
    );
  }

  /**
   * Search in Stripe's query language — `status`, `customer`, `currency`,
   * `collection_method`, `description`, `created`, `metadata['key']`. Every
   * status is searched, canceled included. A page promise and an async
   * iterable that follows `next_page`; `expand: ['total_count']` counts every
   * match.
   */
  search(params: SearchParams): ApiSearchPromise<Subscription> {
    return searchResource<Subscription>(this.client, 'subscriptions', params);
  }
}

/** Subscription items (`si_…`): each write is an update of its subscription, prorated the same way. */
export class SubscriptionItemsResource {
  constructor(private readonly client: RestClient) {}

  create(
    params: CreateSubscriptionItemParams,
    options: BillingCreateOptions = {},
  ): Promise<SubscriptionItem> {
    return this.client.request<SubscriptionItem>('POST', '/v1/subscription_items', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }

  retrieve(id: string): Promise<SubscriptionItem> {
    return this.client.request<SubscriptionItem>('GET', path('subscription_items', id));
  }

  update(id: string, params: UpdateSubscriptionItemParams): Promise<SubscriptionItem> {
    return this.client.request<SubscriptionItem>('POST', path('subscription_items', id), {
      body: params,
    });
  }

  del(id: string, params: DeleteSubscriptionItemParams = {}): Promise<DeletedSubscriptionItem> {
    return this.client.request<DeletedSubscriptionItem>('DELETE', path('subscription_items', id), {
      body: params,
    });
  }

  list(params: SubscriptionItemListParams): ApiListPromise<SubscriptionItem> {
    return listPromise(
      (page: SubscriptionItemListParams) =>
        this.client.request<List<SubscriptionItem>>('GET', '/v1/subscription_items', {
          query: listQuery(page, { subscription: page.subscription }),
        }),
      params,
    );
  }
}

/**
 * Invoices (`in_…`): draft → open → paid | void | uncollectible. Numbers are
 * gapless per merchant; tax is computed before an invoice finalizes.
 */
export class InvoicesResource {
  constructor(private readonly client: RestClient) {}

  create(
    params: CreateInvoiceParams & ExpandParams,
    options: BillingCreateOptions = {},
  ): Promise<Invoice> {
    return this.client.request<Invoice>('POST', '/v1/invoices', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }

  retrieve(id: string, params: ExpandParams = {}): Promise<Invoice> {
    return this.client.request<Invoice>('GET', path('invoices', id), {
      query: { expand: params.expand },
    });
  }

  /** A draft's fields; `metadata` (and `auto_advance` of an open one) on any. */
  update(id: string, params: UpdateInvoiceParams & ExpandParams): Promise<Invoice> {
    return this.client.request<Invoice>('POST', path('invoices', id), { body: params });
  }

  /** A draft only: its pending items return to pending. */
  del(id: string): Promise<DeletedInvoice> {
    return this.client.request<DeletedInvoice>('DELETE', path('invoices', id));
  }

  list(params: InvoiceListParams = {}): ApiListPromise<Invoice> {
    return listPromise(
      (page: InvoiceListParams) =>
        this.client.request<List<Invoice>>('GET', '/v1/invoices', {
          query: listQuery(page, {
            customer: page.customer,
            subscription: page.subscription,
            status: page.status,
            collection_method: page.collection_method,
            due_date: rangeParam(page.due_date),
          }),
        }),
      params,
    );
  }

  /**
   * Search in Stripe's query language — `status`, `customer`, `subscription`,
   * `currency`, `number`, `total`, `customer_email`, `customer_name`,
   * `created`, `metadata['key']`. A page promise and an async iterable that
   * follows `next_page`; `expand: ['total_count']` counts every match.
   */
  search(params: SearchParams): ApiSearchPromise<Invoice> {
    return searchResource<Invoice>(this.client, 'invoices', params);
  }

  finalizeInvoice(id: string, params: FinalizeInvoiceParams & ExpandParams = {}): Promise<Invoice> {
    return this.client.request<Invoice>('POST', `${path('invoices', id)}/finalize`, {
      body: params,
    });
  }

  /**
   * Charge a card invoice off-session (a decline is a `PeableCardError` with
   * the invoice), or record `paid_out_of_band`. A FairCoin invoice is paid by
   * its payer on the hosted invoice page.
   */
  pay(id: string, params: PayInvoiceParams & ExpandParams = {}): Promise<Invoice> {
    return this.client.request<Invoice>('POST', `${path('invoices', id)}/pay`, { body: params });
  }

  /** Email the invoice to its customer (`invoice.sent`). */
  sendInvoice(id: string, params: ExpandParams = {}): Promise<Invoice> {
    return this.client.request<Invoice>('POST', `${path('invoices', id)}/send`, { body: params });
  }

  voidInvoice(id: string, params: ExpandParams = {}): Promise<Invoice> {
    return this.client.request<Invoice>('POST', `${path('invoices', id)}/void`, { body: params });
  }

  markUncollectible(id: string, params: ExpandParams = {}): Promise<Invoice> {
    return this.client.request<Invoice>('POST', `${path('invoices', id)}/mark_uncollectible`, {
      body: params,
    });
  }

  listLineItems(id: string): Promise<List<InvoiceLineItem>> {
    return this.client.request<List<InvoiceLineItem>>('GET', `${path('invoices', id)}/lines`);
  }

  /** The next renewal, previewed (never stored) — optionally with a proposed item change. */
  retrieveUpcoming(params: UpcomingInvoiceParams & ExpandParams): Promise<Invoice> {
    return this.client.request<Invoice>('GET', '/v1/invoices/upcoming', {
      query: {
        customer: params.customer,
        subscription: params.subscription,
        subscription_proration_behavior: params.subscription_proration_behavior,
        subscription_proration_date: params.subscription_proration_date,
        expand: params.expand,
        ...indexedQuery('subscription_items', params.subscription_items),
      },
    });
  }
}

/** Invoice items (`ii_…`): pending on a customer, or on a draft. Never negative. */
export class InvoiceItemsResource {
  constructor(private readonly client: RestClient) {}

  create(
    params: CreateInvoiceItemParams & ExpandParams,
    options: BillingCreateOptions = {},
  ): Promise<InvoiceItem> {
    return this.client.request<InvoiceItem>('POST', '/v1/invoiceitems', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }

  retrieve(id: string, params: ExpandParams = {}): Promise<InvoiceItem> {
    return this.client.request<InvoiceItem>('GET', path('invoiceitems', id), {
      query: { expand: params.expand },
    });
  }

  update(id: string, params: UpdateInvoiceItemParams & ExpandParams): Promise<InvoiceItem> {
    return this.client.request<InvoiceItem>('POST', path('invoiceitems', id), { body: params });
  }

  del(id: string): Promise<DeletedInvoiceItem> {
    return this.client.request<DeletedInvoiceItem>('DELETE', path('invoiceitems', id));
  }

  list(params: InvoiceItemListParams = {}): ApiListPromise<InvoiceItem> {
    return listPromise(
      (page: InvoiceItemListParams) =>
        this.client.request<List<InvoiceItem>>('GET', '/v1/invoiceitems', {
          query: listQuery(page, {
            customer: page.customer,
            invoice: page.invoice,
            pending: booleanParam(page.pending),
          }),
        }),
      params,
    );
  }
}

/** The fields of a credit note as a query — the preview's spelling. */
function creditNoteQuery(params: CreateCreditNoteParams): Record<string, QueryValue> {
  return {
    invoice: params.invoice,
    amount: params.amount,
    reason: params.reason,
    memo: params.memo,
    refund_amount: params.refund_amount,
    credit_amount: params.credit_amount,
    out_of_band_amount: params.out_of_band_amount,
    ...indexedQuery('lines', params.lines),
  };
}

/** Credit notes (`cn_…`): reduce an open invoice, or refund / credit a paid one. Tax is reversed, never deleted. */
export class CreditNotesResource {
  constructor(private readonly client: RestClient) {}

  create(
    params: CreateCreditNoteParams & ExpandParams,
    options: BillingCreateOptions = {},
  ): Promise<CreditNote> {
    return this.client.request<CreditNote>('POST', '/v1/credit_notes', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** What `create` would issue, computed and not stored. */
  preview(params: CreateCreditNoteParams): Promise<CreditNote> {
    return this.client.request<CreditNote>('GET', '/v1/credit_notes/preview', {
      query: creditNoteQuery(params),
    });
  }

  retrieve(id: string, params: ExpandParams = {}): Promise<CreditNote> {
    return this.client.request<CreditNote>('GET', path('credit_notes', id), {
      query: { expand: params.expand },
    });
  }

  /** Reinstates what it took off; a note whose refund was made cannot be voided. */
  voidCreditNote(id: string, params: ExpandParams = {}): Promise<CreditNote> {
    return this.client.request<CreditNote>('POST', `${path('credit_notes', id)}/void`, {
      body: params,
    });
  }

  list(params: CreditNoteListParams = {}): ApiListPromise<CreditNote> {
    return listPromise(
      (page: CreditNoteListParams) =>
        this.client.request<List<CreditNote>>('GET', '/v1/credit_notes', {
          query: listQuery(page, { invoice: page.invoice, customer: page.customer }),
        }),
      params,
    );
  }
}

/** A customer's balance ledger. A negative amount credits the customer; applied to their next invoice. */
export class CustomerBalanceTransactionsResource {
  constructor(private readonly client: RestClient) {}

  create(
    customer: string,
    params: CreateCustomerBalanceTransactionParams,
    options: BillingCreateOptions = {},
  ): Promise<CustomerBalanceTransaction> {
    return this.client.request<CustomerBalanceTransaction>(
      'POST',
      `${path('customers', customer)}/balance_transactions`,
      { body: params, idempotencyKey: options.idempotencyKey },
    );
  }

  retrieve(customer: string, id: string): Promise<CustomerBalanceTransaction> {
    return this.client.request<CustomerBalanceTransaction>(
      'GET',
      `${path('customers', customer)}/balance_transactions/${encodeURIComponent(id)}`,
    );
  }

  list(customer: string, params: ListParams = {}): ApiListPromise<CustomerBalanceTransaction> {
    return listPromise(
      (page: ListParams) =>
        this.client.request<List<CustomerBalanceTransaction>>(
          'GET',
          `${path('customers', customer)}/balance_transactions`,
          { query: listQuery(page) },
        ),
      params,
    );
  }
}

/** Test clocks (`clock_…`, test mode only): `advance` runs everything that fell due, then answers. */
export class TestClocksResource {
  constructor(private readonly client: RestClient) {}

  create(params: CreateTestClockParams, options: BillingCreateOptions = {}): Promise<TestClock> {
    return this.client.request<TestClock>('POST', '/v1/test_helpers/test_clocks', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }

  retrieve(id: string): Promise<TestClock> {
    return this.client.request<TestClock>(
      'GET',
      `/v1/test_helpers/test_clocks/${encodeURIComponent(id)}`,
    );
  }

  advance(id: string, params: AdvanceTestClockParams): Promise<TestClock> {
    return this.client.request<TestClock>(
      'POST',
      `/v1/test_helpers/test_clocks/${encodeURIComponent(id)}/advance`,
      { body: params },
    );
  }

  /** Cancels every live subscription on it. */
  del(id: string): Promise<DeletedTestClock> {
    return this.client.request<DeletedTestClock>(
      'DELETE',
      `/v1/test_helpers/test_clocks/${encodeURIComponent(id)}`,
    );
  }

  list(params: ListParams = {}): ApiListPromise<TestClock> {
    return listPromise(
      (page: ListParams) =>
        this.client.request<List<TestClock>>('GET', '/v1/test_helpers/test_clocks', {
          query: listQuery(page),
        }),
      params,
    );
  }
}

/** Invoice numbering and dunning (retries, final action, emails). */
export class BillingSettingsResource {
  constructor(private readonly client: RestClient) {}

  retrieve(): Promise<BillingSettings> {
    return this.client.request<BillingSettings>('GET', '/v1/billing_settings');
  }

  update(params: UpdateBillingSettingsParams): Promise<BillingSettings> {
    return this.client.request<BillingSettings>('POST', '/v1/billing_settings', { body: params });
  }
}

/** Usage meters (`mtr_…`); a metered price bills a meter's aggregate per period. */
export class BillingMetersResource {
  constructor(private readonly client: RestClient) {}

  create(
    params: CreateBillingMeterParams,
    options: BillingCreateOptions = {},
  ): Promise<BillingMeter> {
    return this.client.request<BillingMeter>('POST', '/v1/billing/meters', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }

  retrieve(id: string): Promise<BillingMeter> {
    return this.client.request<BillingMeter>('GET', `/v1/billing/meters/${encodeURIComponent(id)}`);
  }

  update(id: string, params: UpdateBillingMeterParams): Promise<BillingMeter> {
    return this.client.request<BillingMeter>(
      'POST',
      `/v1/billing/meters/${encodeURIComponent(id)}`,
      {
        body: params,
      },
    );
  }

  deactivate(id: string): Promise<BillingMeter> {
    return this.client.request<BillingMeter>(
      'POST',
      `/v1/billing/meters/${encodeURIComponent(id)}/deactivate`,
      { body: {} },
    );
  }

  reactivate(id: string): Promise<BillingMeter> {
    return this.client.request<BillingMeter>(
      'POST',
      `/v1/billing/meters/${encodeURIComponent(id)}/reactivate`,
      { body: {} },
    );
  }

  list(params: BillingMeterListParams = {}): ApiListPromise<BillingMeter> {
    return listPromise(
      (page: BillingMeterListParams) =>
        this.client.request<List<BillingMeter>>('GET', '/v1/billing/meters', {
          query: listQuery(page, { status: page.status }),
        }),
      params,
    );
  }

  /** A customer's aggregate over `[start_time, end_time)`. */
  listEventSummaries(
    id: string,
    params: BillingMeterEventSummaryParams,
  ): Promise<List<BillingMeterEventSummary>> {
    return this.client.request<List<BillingMeterEventSummary>>(
      'GET',
      `/v1/billing/meters/${encodeURIComponent(id)}/event_summaries`,
      {
        query: {
          customer: params.customer,
          start_time: params.start_time,
          end_time: params.end_time,
        },
      },
    );
  }
}

/** One usage event; the same `identifier` is the same event, forever. */
export class BillingMeterEventsResource {
  constructor(private readonly client: RestClient) {}

  create(
    params: CreateBillingMeterEventParams,
    options: BillingCreateOptions = {},
  ): Promise<BillingMeterEvent> {
    return this.client.request<BillingMeterEvent>('POST', '/v1/billing/meter_events', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }
}

/**
 * `peable.billing`: the Stripe-Billing proxy's methods (`BillingResource`,
 * unchanged) plus the native engine's usage meters.
 */
export class BillingNamespace extends BillingResource {
  readonly meters: BillingMetersResource;
  readonly meterEvents: BillingMeterEventsResource;
  constructor(
    client: RestClient,
    invoiceAuthorityKeys?: Readonly<Record<string, string>>,
    taxQuoteAuthorityKeys?: Readonly<Record<string, string>>,
  ) {
    super(client, invoiceAuthorityKeys, taxQuoteAuthorityKeys);
    this.meters = new BillingMetersResource(client);
    this.meterEvents = new BillingMeterEventsResource(client);
  }
}

/** Features (`feat_…`) — the `lookup_key` an app checks access by. */
export class EntitlementFeaturesResource {
  constructor(private readonly client: RestClient) {}

  create(
    params: CreateEntitlementFeatureParams,
    options: BillingCreateOptions = {},
  ): Promise<EntitlementFeature> {
    return this.client.request<EntitlementFeature>('POST', '/v1/entitlements/features', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }

  retrieve(id: string): Promise<EntitlementFeature> {
    return this.client.request<EntitlementFeature>(
      'GET',
      `/v1/entitlements/features/${encodeURIComponent(id)}`,
    );
  }

  /** `active: false` archives it and withdraws it from every customer that held it. */
  update(id: string, params: UpdateEntitlementFeatureParams): Promise<EntitlementFeature> {
    return this.client.request<EntitlementFeature>(
      'POST',
      `/v1/entitlements/features/${encodeURIComponent(id)}`,
      { body: params },
    );
  }

  list(params: EntitlementFeatureListParams = {}): ApiListPromise<EntitlementFeature> {
    return listPromise(
      (page: EntitlementFeatureListParams) =>
        this.client.request<List<EntitlementFeature>>('GET', '/v1/entitlements/features', {
          query: listQuery(page, {
            lookup_key: page.lookup_key,
            archived: booleanParam(page.archived),
          }),
        }),
      params,
    );
  }
}

/** What a customer may access NOW — the authoritative answer an app asks. */
export class ActiveEntitlementsResource {
  constructor(private readonly client: RestClient) {}

  /** One entitlement per feature, however many products grant it. A complete set: never paged. */
  list(params: ActiveEntitlementListParams): Promise<List<ActiveEntitlement>> {
    return this.client.request<List<ActiveEntitlement>>(
      'GET',
      '/v1/entitlements/active_entitlements',
      {
        query: { customer: params.customer },
      },
    );
  }
}

/** The features a product grants (`prodft_…`). */
export class ProductFeaturesResource {
  constructor(private readonly client: RestClient) {}

  attach(product: string, params: { entitlement_feature: string }): Promise<ProductFeature> {
    return this.client.request<ProductFeature>('POST', `${path('products', product)}/features`, {
      body: params,
    });
  }

  list(product: string, params: ListParams = {}): ApiListPromise<ProductFeature> {
    return listPromise(
      (page: ListParams) =>
        this.client.request<List<ProductFeature>>('GET', `${path('products', product)}/features`, {
          query: listQuery(page),
        }),
      params,
    );
  }

  detach(
    product: string,
    id: string,
  ): Promise<{ id: string; object: 'product_feature'; deleted: true }> {
    return this.client.request(
      'DELETE',
      `${path('products', product)}/features/${encodeURIComponent(id)}`,
    );
  }
}

/** `peable.entitlements` — features, what products grant them, and what customers hold. */
export class EntitlementsResource {
  readonly features: EntitlementFeaturesResource;
  readonly activeEntitlements: ActiveEntitlementsResource;
  readonly productFeatures: ProductFeaturesResource;
  constructor(client: RestClient) {
    this.features = new EntitlementFeaturesResource(client);
    this.activeEntitlements = new ActiveEntitlementsResource(client);
    this.productFeatures = new ProductFeaturesResource(client);
  }
}

/** Portal configurations (`bpc_…`). */
export class BillingPortalConfigurationsResource {
  constructor(private readonly client: RestClient) {}

  create(
    params: CreateBillingPortalConfigurationParams,
    options: BillingCreateOptions = {},
  ): Promise<BillingPortalConfiguration> {
    return this.client.request<BillingPortalConfiguration>(
      'POST',
      '/v1/billing_portal/configurations',
      {
        body: params,
        idempotencyKey: options.idempotencyKey,
      },
    );
  }

  retrieve(id: string): Promise<BillingPortalConfiguration> {
    return this.client.request<BillingPortalConfiguration>(
      'GET',
      `/v1/billing_portal/configurations/${encodeURIComponent(id)}`,
    );
  }

  update(
    id: string,
    params: UpdateBillingPortalConfigurationParams,
  ): Promise<BillingPortalConfiguration> {
    return this.client.request<BillingPortalConfiguration>(
      'POST',
      `/v1/billing_portal/configurations/${encodeURIComponent(id)}`,
      { body: params },
    );
  }

  list(
    params: BillingPortalConfigurationListParams = {},
  ): ApiListPromise<BillingPortalConfiguration> {
    return listPromise(
      (page: BillingPortalConfigurationListParams) =>
        this.client.request<List<BillingPortalConfiguration>>(
          'GET',
          '/v1/billing_portal/configurations',
          {
            query: listQuery(page, {
              active: booleanParam(page.active),
              is_default: booleanParam(page.is_default),
            }),
          },
        ),
      params,
    );
  }
}

/** Portal sessions (`bps_…`): a one-hour URL for one customer. Hand it to that customer only. */
export class BillingPortalSessionsResource {
  constructor(private readonly client: RestClient) {}

  create(
    params: CreateBillingPortalSessionParams,
    options: BillingCreateOptions = {},
  ): Promise<BillingPortalSession> {
    return this.client.request<BillingPortalSession>('POST', '/v1/billing_portal/sessions', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }
}

/** `peable.billingPortal` — the Orbit-hosted customer portal (not the proxy's `billing.createPortalSession`). */
export class BillingPortalResource {
  readonly configurations: BillingPortalConfigurationsResource;
  readonly sessions: BillingPortalSessionsResource;
  constructor(client: RestClient) {
    this.configurations = new BillingPortalConfigurationsResource(client);
    this.sessions = new BillingPortalSessionsResource(client);
  }
}
