import type { SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { SearchableResource } from '@peable.to/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres';
import type { KeysetPage } from '../../db/keyset';
import {
  charges,
  customers,
  invoices,
  paymentIntents,
  prices,
  products,
  refunds,
  subscriptions,
} from '../../db/schema';
import {
  countSubscriptions,
  listSubscriptions,
} from '../../db/billingEngine/subscriptionRepository';
import { countInvoices, listInvoices } from '../../db/billingEngine/invoiceRepository';
import {
  countIntentsForMerchant,
  listIntentsForMerchant,
} from '../../db/payments/paymentIntentRepository';
import {
  countChargesForMerchant,
  listChargesForMerchant,
} from '../../db/payments/chargeRepository';
import {
  countCustomersForMerchant,
  listCustomersForMerchant,
} from '../../db/customers/customerRepository';
import {
  countProductsForMerchant,
  listProductsForMerchant,
} from '../../db/catalog/productRepository';
import { countPricesForMerchant, listPricesForMerchant } from '../../db/catalog/priceRepository';
import { countRefundsForMerchant, listRefundsForMerchant } from '../../db/refunds/refundRepository';
import {
  CHARGE_SEARCH_FIELDS,
  CUSTOMER_SEARCH_FIELDS,
  INVOICE_SEARCH_FIELDS,
  PAYMENT_INTENT_SEARCH_FIELDS,
  PRICE_SEARCH_FIELDS,
  PRODUCT_SEARCH_FIELDS,
  REFUND_SEARCH_FIELDS,
  SUBSCRIPTION_SEARCH_FIELDS,
} from '../../db/search/searchFields';
import type { ExpandableType } from '../expand';
import { toChargeDTO, toCustomerDTO, toPaymentIntentDTO, toRefundDTO } from '../serialize';
import { toPriceDTO, toProductDTO } from '../serializeCatalog';
import { renderInvoices, renderSubscriptions } from '../serializeBilling';
import type { SearchFields } from './compile';

/**
 * The searchable resources — THE registry. A route, the dashboard's global
 * search and the SDK all read this list; a resource is searchable exactly when
 * it has an entry here (and its name in `SEARCHABLE_RESOURCES`, which types it).
 *
 * Each entry walks the resource's OWN list function with a compiled `search`
 * predicate, so a search answers the same rows, in the same order, serialized
 * by the same function, as the list — it is the list with a filter, never a
 * second reader of the table that could disagree with it.
 */

/** One serialized hit and the key the next page starts after. */
export interface SearchHit {
  /** INTERNAL primary key — the keyset position, never on the wire. */
  readonly key: string;
  readonly object: object;
}

export interface SearchResource {
  readonly name: SearchableResource;
  /** The type of `data[]`, for `expand[]`. */
  readonly object: ExpandableType;
  readonly fields: SearchFields;
  /** The id prefix of this resource's objects (`pi`), for the dashboard's id lookups. */
  readonly idPrefix: string;
  /** The public id column (the dashboard's lookup of one object by id). */
  readonly publicId: AnyPgColumn;
  /** The fields the dashboard's free-text box matches, in order of usefulness. */
  readonly textFields: readonly string[];
  run(
    db: DatabaseOrTransaction,
    args: { readonly merchantId: string; readonly search: SQL; readonly page: KeysetPage },
  ): Promise<{ data: SearchHit[]; hasMore: boolean }>;
  count(
    db: DatabaseOrTransaction,
    args: { readonly merchantId: string; readonly search: SQL },
  ): Promise<number>;
}

/** Bind a list function and its serializer into an entry, erasing the row type. */
function entry<Row extends { readonly id: string }>(definition: {
  readonly name: SearchableResource;
  readonly object: ExpandableType;
  readonly fields: SearchFields;
  readonly idPrefix: string;
  readonly publicId: AnyPgColumn;
  readonly textFields: readonly string[];
  readonly list: (
    db: DatabaseOrTransaction,
    merchantId: string,
    search: SQL,
    page: KeysetPage,
  ) => Promise<{ data: Row[]; hasMore: boolean }>;
  readonly count: (db: DatabaseOrTransaction, merchantId: string, search: SQL) => Promise<number>;
  /**
   * The list's own serializer: per row, or — for an object whose DTO reads
   * more rows (a subscription's items, an invoice's lines) — the list's batch
   * renderer, one round trip per page rather than per hit.
   */
  readonly serialize:
    | { readonly row: (row: Row) => object }
    | { readonly page: (db: DatabaseOrTransaction, rows: Row[]) => Promise<object[]> };
}): SearchResource {
  const serialize = definition.serialize;
  return {
    name: definition.name,
    object: definition.object,
    fields: definition.fields,
    idPrefix: definition.idPrefix,
    publicId: definition.publicId,
    textFields: definition.textFields,
    async run(db, { merchantId, search, page }) {
      const result = await definition.list(db, merchantId, search, page);
      const objects =
        'row' in serialize ? result.data.map(serialize.row) : await serialize.page(db, result.data);
      return {
        data: result.data.map((row, index) => ({ key: row.id, object: objects[index] as object })),
        hasMore: result.hasMore,
      };
    },
    count: (db, { merchantId, search }) => definition.count(db, merchantId, search),
  };
}

export const SEARCH_RESOURCES: Readonly<Record<SearchableResource, SearchResource>> = {
  payment_intents: entry({
    name: 'payment_intents',
    object: 'payment_intent',
    fields: PAYMENT_INTENT_SEARCH_FIELDS,
    idPrefix: 'pi',
    publicId: paymentIntents.publicId,
    textFields: ['receipt_email', 'description'],
    list: (db, merchantId, search, page) =>
      listIntentsForMerchant(db, { merchantId, search, page }),
    count: (db, merchantId, search) => countIntentsForMerchant(db, { merchantId, search }),
    serialize: { row: toPaymentIntentDTO },
  }),
  charges: entry({
    name: 'charges',
    object: 'charge',
    fields: CHARGE_SEARCH_FIELDS,
    idPrefix: 'ch',
    publicId: charges.publicId,
    textFields: [
      'billing_details.email',
      'billing_details.name',
      'payment_method_details.card.last4',
    ],
    list: (db, merchantId, search, page) =>
      listChargesForMerchant(db, { merchantId, search, page }),
    count: (db, merchantId, search) => countChargesForMerchant(db, { merchantId, search }),
    serialize: { row: toChargeDTO },
  }),
  customers: entry({
    name: 'customers',
    object: 'customer',
    fields: CUSTOMER_SEARCH_FIELDS,
    idPrefix: 'cus',
    publicId: customers.publicId,
    textFields: ['email', 'name', 'phone'],
    list: (db, merchantId, search, page) =>
      listCustomersForMerchant(db, { merchantId, search, page }),
    count: (db, merchantId, search) => countCustomersForMerchant(db, { merchantId, search }),
    serialize: { row: toCustomerDTO },
  }),
  products: entry({
    name: 'products',
    object: 'product',
    fields: PRODUCT_SEARCH_FIELDS,
    idPrefix: 'prod',
    publicId: products.publicId,
    textFields: ['name', 'description'],
    list: (db, merchantId, search, page) =>
      listProductsForMerchant(db, { merchantId, search, page }),
    count: (db, merchantId, search) => countProductsForMerchant(db, { merchantId, search }),
    serialize: { row: toProductDTO },
  }),
  prices: entry({
    name: 'prices',
    object: 'price',
    fields: PRICE_SEARCH_FIELDS,
    idPrefix: 'price',
    publicId: prices.publicId,
    textFields: ['lookup_key'],
    list: (db, merchantId, search, page) => listPricesForMerchant(db, { merchantId, search, page }),
    count: (db, merchantId, search) => countPricesForMerchant(db, { merchantId, search }),
    serialize: { row: toPriceDTO },
  }),
  refunds: entry({
    name: 'refunds',
    object: 'refund',
    fields: REFUND_SEARCH_FIELDS,
    idPrefix: 're',
    publicId: refunds.publicId,
    textFields: [],
    list: (db, merchantId, search, page) =>
      listRefundsForMerchant(db, { merchantId, search, page }),
    count: (db, merchantId, search) => countRefundsForMerchant(db, { merchantId, search }),
    serialize: { row: (row) => toRefundDTO(row, row.paymentIntentPublicId) },
  }),
  // The billing engine (ADR 0018). A search walks EVERY status (`all`): the
  // list's default of hiding canceled subscriptions is not a search's.
  subscriptions: entry({
    name: 'subscriptions',
    object: 'subscription',
    fields: SUBSCRIPTION_SEARCH_FIELDS,
    idPrefix: 'sub',
    publicId: subscriptions.publicId,
    textFields: ['description'],
    list: (db, merchantId, search, page) =>
      listSubscriptions(db, { merchantId, search, page, status: 'all' }),
    count: (db, merchantId, search) =>
      countSubscriptions(db, { merchantId, search, status: 'all' }),
    serialize: { page: renderSubscriptions },
  }),
  invoices: entry({
    name: 'invoices',
    object: 'invoice',
    fields: INVOICE_SEARCH_FIELDS,
    idPrefix: 'in',
    publicId: invoices.publicId,
    textFields: ['customer_email', 'customer_name', 'number'],
    list: (db, merchantId, search, page) => listInvoices(db, { merchantId, search, page }),
    count: (db, merchantId, search) => countInvoices(db, { merchantId, search }),
    serialize: { page: renderInvoices },
  }),
};
