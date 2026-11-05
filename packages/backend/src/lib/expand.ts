import type { Response } from 'express';
import { findAccountsByPublicIds } from '../db/accounts/connectedAccountRepository';
import { findIntentsForMerchantByPublicIds } from '../db/payments/paymentIntentRepository';
import { findChargesForMerchantByPublicIds } from '../db/payments/chargeRepository';
import { findRefundsForMerchantByPublicIds } from '../db/refunds/refundRepository';
import { findDisputesForMerchantByPublicIds } from '../db/disputes/disputeRepository';
import { findCustomersForMerchantByPublicIds } from '../db/customers/customerRepository';
import { findPaymentMethodsForMerchantByPublicIds } from '../db/customers/paymentMethodRepository';
import { findSetupIntentsForMerchantByPublicIds } from '../db/customers/setupIntentRepository';
import { findCouponsByPublicIds } from '../db/catalog/couponRepository';
import { findPricesByPublicIds } from '../db/catalog/priceRepository';
import { findProductsByPublicIds } from '../db/catalog/productRepository';
import { toCouponDTO, toPriceDTO, toProductDTO } from './serializeCatalog';
import { findInvoicesByPublicIds } from '../db/billingEngine/invoiceRepository';
import { findSubscriptionsByPublicIds } from '../db/billingEngine/subscriptionRepository';
import { renderInvoices, renderSubscriptions } from './serializeBilling';
import { getDb } from '../db/postgres';
import { sendError } from './http';
import {
  toChargeDTO,
  toCustomerDTO,
  toDeletedCustomerDTO,
  toDisputeDTO,
  toPaymentIntentDTO,
  toPaymentMethodDTO,
  toRefundDTO,
  toSetupIntentDTO,
} from './serialize';
import { toConnectedAccountDTO } from './serializeSettlement';

/**
 * `expand[]` (ADR 0014 D1): replace a reference's id with the object it names.
 *
 * ## The naming rule this rests on
 *
 * A reference is spelled WITHOUT `_id` exactly when it is expandable —
 * `payment_intent`, `connected_account` — and its type is `string | Object`.
 * A reference that cannot be expanded (a provider's id, an Oxy id, a signed
 * evidence id) keeps `_id`. So the registry below and the field names on the
 * wire are the same list: making a reference expandable renames it in the same
 * change, and a field without `_id` that is missing here is a bug.
 *
 * ## Scope
 *
 * Every expansion resolves inside the CALLER's merchant — the loaders take the
 * merchant id and put it in the predicate. A reference is always to an object
 * of the same merchant (foreign keys hold that), so an id the scoped read does
 * not find is a broken invariant and throws rather than answering with a
 * half-expanded object.
 *
 * ## Shape of a path
 *
 * Dot-separated fields, at most four (Stripe's depth), each one an expandable
 * field of the object the previous one produced. On a list every path starts
 * with `data.`, which names the list's elements and does not count toward the
 * depth. A path that names anything else is a 400 with `param: 'expand'`,
 * decided before any row is read.
 */

/** Every object type that appears at the root of a response that accepts `expand[]`. */
export type ExpandableType =
  | 'payment_intent'
  | 'charge'
  | 'customer'
  | 'payment_method'
  | 'setup_intent'
  | 'checkout_session'
  | 'refund'
  | 'transfer'
  | 'dispute'
  | 'settlement'
  | 'connected_account'
  | 'payment_link'
  | 'webhook_delivery'
  | 'webhook_endpoint'
  | 'event'
  | 'tax.transaction'
  | 'tax.operating_location'
  | 'tax.sales_destination'
  | 'tax.registration_declaration'
  | 'tax.document'
  | 'tax.assessment'
  | 'tax.review_item'
  | 'tax.compliance_action'
  | 'product'
  | 'price'
  | 'coupon'
  | 'promotion_code'
  | 'request_log'
  | 'file'
  | 'payment_method_configuration'
  | 'payment_method_domain'
  | 'balance_transaction'
  | 'payout'
  | 'application_fee'
  | 'reconciliation_mismatch'
  | 'item'
  | 'reporting.report_run'
  | 'subscription'
  | 'subscription_item'
  | 'invoice'
  | 'invoiceitem'
  | 'credit_note'
  | 'customer_balance_transaction'
  | 'test_helpers.test_clock'
  | 'billing.meter'
  | 'entitlements.feature'
  | 'entitlements.active_entitlement'
  | 'product_feature'
  | 'billing_portal.configuration'
  | 'billing_portal.session';

/** The types an expansion can PRODUCE — each needs a loader. */
type TargetType =
  | 'payment_intent'
  | 'connected_account'
  | 'charge'
  | 'customer'
  | 'payment_method'
  | 'product'
  | 'price'
  | 'coupon'
  | 'setup_intent'
  | 'invoice'
  | 'subscription'
  | 'refund'
  | 'dispute';

const REGISTRY: Record<ExpandableType, Readonly<Record<string, TargetType>>> = {
  // `latest_charge` is the one reference named for its ROLE, not its type —
  // Stripe's spelling; it expands to a `charge`.
  payment_intent: {
    connected_account: 'connected_account',
    customer: 'customer',
    payment_method: 'payment_method',
    latest_charge: 'charge',
  },
  charge: {
    payment_intent: 'payment_intent',
    customer: 'customer',
    payment_method: 'payment_method',
  },
  customer: {},
  payment_method: { customer: 'customer' },
  setup_intent: { customer: 'customer', payment_method: 'payment_method' },
  checkout_session: {
    payment_intent: 'payment_intent',
    setup_intent: 'setup_intent',
    customer: 'customer',
    connected_account: 'connected_account',
  },
  refund: { payment_intent: 'payment_intent' },
  transfer: { payment_intent: 'payment_intent', connected_account: 'connected_account' },
  dispute: { payment_intent: 'payment_intent', charge: 'charge' },
  // A refund's or a dispute's settlement names it beside the payment.
  settlement: { payment_intent: 'payment_intent', refund: 'refund', dispute: 'dispute' },
  connected_account: {},
  payment_link: {},
  webhook_delivery: {},
  webhook_endpoint: {},
  event: {},
  request_log: {},
  file: {},
  payment_method_configuration: {},
  payment_method_domain: {},
  'tax.transaction': {},
  // Business compliance (ADR 0020): nothing expands yet; `expand[]` is still validated.
  'tax.operating_location': {},
  'tax.sales_destination': {},
  'tax.registration_declaration': {},
  'tax.document': {},
  'tax.assessment': {},
  'tax.review_item': {},
  'tax.compliance_action': {},
  product: { default_price: 'price' },
  price: { product: 'product' },
  coupon: {},
  promotion_code: { coupon: 'coupon', customer: 'customer' },
  // ADR 0015's mirrors name their sources by public id; none expands yet.
  balance_transaction: {},
  payout: {},
  application_fee: {},
  reconciliation_mismatch: {},
  // A checkout session's or payment link's line (`object: 'item'`).
  item: { price: 'price', product: 'product' },
  // The result File is embedded, as on Stripe; nothing on a run expands.
  'reporting.report_run': {},
  // The billing engine (ADR 0018).
  subscription: {
    customer: 'customer',
    default_payment_method: 'payment_method',
    latest_invoice: 'invoice',
  },
  subscription_item: {},
  invoice: {
    customer: 'customer',
    subscription: 'subscription',
    payment_intent: 'payment_intent',
    default_payment_method: 'payment_method',
  },
  invoiceitem: { customer: 'customer', invoice: 'invoice', subscription: 'subscription' },
  credit_note: { invoice: 'invoice', customer: 'customer' },
  customer_balance_transaction: { customer: 'customer', invoice: 'invoice' },
  'test_helpers.test_clock': {},
  'billing.meter': {},
  'entitlements.feature': {},
  'entitlements.active_entitlement': {},
  product_feature: {},
  'billing_portal.configuration': {},
  'billing_portal.session': {},
};

type Loader = (merchantId: string, ids: readonly string[]) => Promise<Map<string, object>>;

const LOADERS: Record<TargetType, Loader> = {
  payment_intent: async (merchantId, ids) =>
    new Map(
      (await findIntentsForMerchantByPublicIds(getDb(), merchantId, ids)).map((row) => [
        row.publicId,
        toPaymentIntentDTO(row),
      ]),
    ),
  charge: async (merchantId, ids) =>
    new Map(
      (await findChargesForMerchantByPublicIds(getDb(), merchantId, ids)).map((row) => [
        row.publicId,
        toChargeDTO(row),
      ]),
    ),
  customer: async (merchantId, ids) =>
    new Map(
      (await findCustomersForMerchantByPublicIds(getDb(), merchantId, ids)).map((row) => [
        row.publicId,
        row.deletedAt === null ? toCustomerDTO(row) : toDeletedCustomerDTO(row),
      ]),
    ),
  payment_method: async (merchantId, ids) =>
    new Map(
      (await findPaymentMethodsForMerchantByPublicIds(getDb(), merchantId, ids)).map((row) => [
        row.publicId,
        toPaymentMethodDTO(row),
      ]),
    ),
  product: async (merchantId, ids) =>
    new Map(
      (await findProductsByPublicIds(getDb(), merchantId, ids)).map((row) => [
        row.publicId,
        toProductDTO(row),
      ]),
    ),
  price: async (merchantId, ids) =>
    new Map(
      (await findPricesByPublicIds(getDb(), merchantId, ids)).map((row) => [
        row.publicId,
        toPriceDTO(row),
      ]),
    ),
  // Deleted coupons included: a promotion code keeps naming the coupon it
  // redeemed, and the expansion shows it `valid: false` rather than failing.
  coupon: async (merchantId, ids) =>
    new Map(
      (await findCouponsByPublicIds(getDb(), merchantId, ids)).map((row) => [
        row.publicId,
        toCouponDTO(row),
      ]),
    ),
  setup_intent: async (merchantId, ids) =>
    new Map(
      (await findSetupIntentsForMerchantByPublicIds(getDb(), merchantId, ids)).map((row) => [
        row.publicId,
        toSetupIntentDTO(row),
      ]),
    ),
  invoice: async (merchantId, ids) => {
    const rows = await findInvoicesByPublicIds(getDb(), merchantId, ids);
    const dtos = await renderInvoices(getDb(), rows);
    return new Map(dtos.map((dto) => [dto.id, dto]));
  },
  subscription: async (merchantId, ids) => {
    const rows = await findSubscriptionsByPublicIds(getDb(), merchantId, ids);
    const dtos = await renderSubscriptions(getDb(), rows);
    return new Map(dtos.map((dto) => [dto.id, dto]));
  },
  refund: async (merchantId, ids) =>
    new Map(
      (await findRefundsForMerchantByPublicIds(getDb(), merchantId, ids)).map((row) => [
        row.publicId,
        toRefundDTO(row, row.paymentIntentPublicId),
      ]),
    ),
  // As a list renders it: `evidence` is only ever on the dispute's own read.
  dispute: async (merchantId, ids) =>
    new Map(
      (await findDisputesForMerchantByPublicIds(getDb(), merchantId, ids)).map((row) => [
        row.publicId,
        toDisputeDTO(row, row.paymentIntentPublicId),
      ]),
    ),
  connected_account: async (merchantId, ids) =>
    new Map(
      (await findAccountsByPublicIds(getDb(), merchantId, ids)).map((row) => [
        row.publicId,
        toConnectedAccountDTO(row),
      ]),
    ),
};

export const EXPAND_MAX_DEPTH = 4;

/** A parsed set of paths: field → what to expand inside the object it produces. */
export interface ExpandTree {
  readonly [field: string]: ExpandTree;
}

function validatePath(
  root: ExpandableType,
  path: string,
  list: boolean,
): { ok: true; segments: string[] } | { ok: false; message: string } {
  let segments = path.split('.');
  if (list) {
    if (segments[0] !== 'data') {
      return {
        ok: false,
        message: `on a list, expand paths start with 'data.' (got '${path}')`,
      };
    }
    segments = segments.slice(1);
  }
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    return { ok: false, message: `'${path}' is not an expand path` };
  }
  if (segments.length > EXPAND_MAX_DEPTH) {
    return {
      ok: false,
      message: `'${path}' is deeper than the ${EXPAND_MAX_DEPTH} levels expand allows`,
    };
  }
  let type: ExpandableType = root;
  for (const segment of segments) {
    const target: TargetType | undefined = Object.hasOwn(REGISTRY[type], segment)
      ? REGISTRY[type][segment]
      : undefined;
    if (target === undefined) {
      return {
        ok: false,
        message: `'${segment}' is not an expandable field of ${type} (in '${path}')`,
      };
    }
    type = target;
  }
  return { ok: true, segments };
}

/**
 * Validate `expand[]` against the root object type, or answer the 400 and
 * return `null`. An empty or absent `expand` is the empty tree.
 */
export function parseExpand(
  res: Response,
  root: ExpandableType,
  paths: readonly string[] | undefined,
  options: { list: boolean },
): ExpandTree | null {
  const tree: Record<string, Record<string, unknown>> = {};
  for (const path of paths ?? []) {
    const checked = validatePath(root, path, options.list);
    if (!checked.ok) {
      sendError(res, 400, 'invalid_request_error', checked.message, 'parameter_invalid', 'expand');
      return null;
    }
    let node: Record<string, Record<string, unknown>> = tree;
    for (const segment of checked.segments) {
      node[segment] ??= {};
      node = node[segment] as Record<string, Record<string, unknown>>;
    }
  }
  return tree as ExpandTree;
}

/**
 * Expand `objects` (all of `type`) in place, one query per field per level —
 * a page of a hundred refunds expanding `data.payment_intent` is ONE read of
 * `payment_intents`, not a hundred.
 */
export async function expandObjects(
  objects: readonly object[],
  type: ExpandableType,
  tree: ExpandTree,
  merchantId: string,
): Promise<void> {
  for (const [field, subtree] of Object.entries(tree)) {
    const target = REGISTRY[type][field];
    if (target === undefined) throw new Error(`expand: ${type}.${field} is not registered`);
    const holders = objects as Record<string, unknown>[];
    const ids = [
      ...new Set(holders.map((o) => o[field]).filter((v): v is string => typeof v === 'string')),
    ];
    const loaded = await LOADERS[target](merchantId, ids);
    const produced: object[] = [];
    for (const holder of holders) {
      const id = holder[field];
      if (typeof id !== 'string') continue; // `null`: nothing referenced, nothing to expand.
      const object = loaded.get(id);
      if (object === undefined) {
        throw new Error(`expand: ${type}.${field} names ${id}, which this merchant cannot read`);
      }
      holder[field] = object;
      produced.push(object);
    }
    if (Object.keys(subtree).length > 0) {
      await expandObjects(produced, target, subtree, merchantId);
    }
  }
}
