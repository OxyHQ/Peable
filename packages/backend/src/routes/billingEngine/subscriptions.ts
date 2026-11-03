/**
 * Subscriptions (`sub_…`) and subscription items (`si_…`) — ADR 0018 §1.
 */
import type { Request, Response } from 'express';
import {
  cancelSubscriptionParams,
  createSubscriptionItemParams,
  createSubscriptionParams,
  deleteSubscriptionItemParams,
  expandOnlyQuery,
  listSubscriptionItemsQuery,
  listSubscriptionsQuery,
  resumeSubscriptionParams,
  updateSubscriptionItemParams,
  updateSubscriptionParams,
} from '@peable.to/contracts';
import { findPriceForMerchant } from '../../db/catalog/priceRepository';
import { findCustomerForMerchant } from '../../db/customers/customerRepository';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { findLiveTestClockForMerchant } from '../../db/billingEngine/testClockRepository';
import {
  findItemForMerchant,
  findSubscriptionForMerchant,
  listItemsPage,
  listSubscriptions,
} from '../../db/billingEngine/subscriptionRepository';
import { getDb } from '../../db/postgres';
import { findPricesByRowIds } from '../../db/catalog/priceRepository';
import { answerList, parseQuery, type QuerySurface, resolveListReference } from '../../lib/list';
import {
  renderSubscription,
  renderSubscriptions,
  toSubscriptionItemDTO,
} from '../../lib/serializeBilling';
import { toPriceDTO } from '../../lib/serializeCatalog';
import { BillingEngineError, missing } from '../../services/billingEngine/errors';
import {
  cancelSubscriptionNow,
  createSubscription,
  resumeSubscription,
  updateSubscription,
} from '../../services/billingEngine/subscriptions';
import type { CatalogRoute } from '../catalogRoutes';
import { answerObject, bySurface, cleared, idParam, parseBody } from './helpers';

/**
 * Every request schema is the contract's (`@peable.to/contracts`
 * `subscriptionRoutes`); the dashboard's reads add only its Test/Live toggle.
 */
const listQuery = bySurface(listSubscriptionsQuery);
const retrieveQuery = bySurface(expandOnlyQuery);

async function answer(
  res: Response,
  merchant: MerchantRow,
  id: string,
  expand: readonly string[] | undefined,
  status = 200,
) {
  const db = getDb();
  const row = await findSubscriptionForMerchant(db, id, merchant.id);
  if (!row) throw missing('subscription');
  await answerObject(
    res,
    merchant,
    'subscription',
    await renderSubscription(db, row),
    expand,
    status,
  );
}

async function create(req: Request, res: Response, merchant: MerchantRow) {
  const body = parseBody(req, res, createSubscriptionParams);
  if (!body) return;
  const row = await createSubscription(merchant, {
    customer: body.customer,
    items: body.items.map((item) => ({
      price: item.price,
      ...(item.quantity !== undefined ? { quantity: item.quantity } : {}),
      ...(item.metadata ? { metadata: item.metadata } : {}),
    })),
    ...(body.default_payment_method ? { defaultPaymentMethod: body.default_payment_method } : {}),
    ...(body.collection_method ? { collectionMethod: body.collection_method } : {}),
    ...(body.days_until_due !== undefined ? { daysUntilDue: body.days_until_due } : {}),
    ...(body.description ? { description: body.description } : {}),
    ...(body.trial_period_days !== undefined ? { trialPeriodDays: body.trial_period_days } : {}),
    ...(body.trial_end !== undefined ? { trialEnd: body.trial_end } : {}),
    ...(body.trial_settings
      ? { trialEndBehavior: body.trial_settings.end_behavior.missing_payment_method }
      : {}),
    ...(body.billing_cycle_anchor !== undefined
      ? { billingCycleAnchor: body.billing_cycle_anchor }
      : {}),
    ...(body.proration_behavior ? { prorationBehavior: body.proration_behavior } : {}),
    ...(body.cancel_at_period_end !== undefined
      ? { cancelAtPeriodEnd: body.cancel_at_period_end }
      : {}),
    ...(body.cancel_at !== undefined ? { cancelAt: body.cancel_at } : {}),
    ...(body.coupon ? { coupon: body.coupon } : {}),
    ...(body.promotion_code ? { promotionCode: body.promotion_code } : {}),
    ...(body.discounts ? { discounts: body.discounts } : {}),
    ...(body.payment_behavior ? { paymentBehavior: body.payment_behavior } : {}),
    ...(body.automatic_tax ? { automaticTax: body.automatic_tax.enabled } : {}),
    metadata: body.metadata ?? {},
  });
  await answer(res, merchant, row.publicId, body.expand);
}

async function retrieve(req: Request, res: Response, merchant: MerchantRow, surface: QuerySurface) {
  const id = idParam(req, res);
  if (!id) return;
  const query = parseQuery(req, res, retrieveQuery[surface]);
  if (!query) return;
  await answer(res, merchant, id, query.expand);
}

async function update(req: Request, res: Response, merchant: MerchantRow) {
  const id = idParam(req, res);
  if (!id) return;
  const body = parseBody(req, res, updateSubscriptionParams);
  if (!body) return;
  const row = await updateSubscription(merchant, id, {
    ...(body.items
      ? {
          items: body.items.map((item) => ({
            ...(item.id ? { id: item.id } : {}),
            ...(item.price ? { price: item.price } : {}),
            ...(item.quantity !== undefined ? { quantity: item.quantity } : {}),
            ...(item.deleted ? { deleted: true } : {}),
            ...(item.metadata ? { metadata: item.metadata } : {}),
          })),
        }
      : {}),
    ...(body.proration_behavior ? { prorationBehavior: body.proration_behavior } : {}),
    ...(body.proration_date !== undefined ? { prorationDate: body.proration_date } : {}),
    ...(body.default_payment_method !== undefined
      ? { defaultPaymentMethod: cleared(body.default_payment_method) ?? null }
      : {}),
    ...(body.collection_method ? { collectionMethod: body.collection_method } : {}),
    ...(body.days_until_due !== undefined ? { daysUntilDue: body.days_until_due } : {}),
    ...(body.description !== undefined ? { description: cleared(body.description) ?? null } : {}),
    ...(body.cancel_at_period_end !== undefined
      ? { cancelAtPeriodEnd: body.cancel_at_period_end }
      : {}),
    ...(body.cancel_at !== undefined ? { cancelAt: cleared(body.cancel_at) ?? null } : {}),
    ...(body.pause_collection !== undefined
      ? {
          pauseCollection:
            body.pause_collection === ''
              ? null
              : {
                  behavior: body.pause_collection.behavior,
                  ...(body.pause_collection.resumes_at !== undefined
                    ? { resumesAt: body.pause_collection.resumes_at }
                    : {}),
                },
        }
      : {}),
    ...(body.trial_end !== undefined ? { trialEnd: body.trial_end } : {}),
    ...(body.coupon !== undefined ? { coupon: cleared(body.coupon) ?? null } : {}),
    ...(body.promotion_code ? { promotionCode: body.promotion_code } : {}),
    ...(body.discounts !== undefined ? { discounts: cleared(body.discounts) ?? null } : {}),
    ...(body.automatic_tax ? { automaticTax: body.automatic_tax.enabled } : {}),
    ...(body.metadata ? { metadata: body.metadata } : {}),
  });
  await answer(res, merchant, row.publicId, body.expand);
}

async function cancel(req: Request, res: Response, merchant: MerchantRow) {
  const id = idParam(req, res);
  if (!id) return;
  const body = parseBody(req, res, cancelSubscriptionParams);
  if (!body) return;
  const row = await cancelSubscriptionNow(merchant, id, {
    ...(body.invoice_now !== undefined ? { invoiceNow: body.invoice_now } : {}),
    ...(body.prorate !== undefined ? { prorate: body.prorate } : {}),
    ...(body.cancellation_details?.comment ? { comment: body.cancellation_details.comment } : {}),
  });
  await answer(res, merchant, row.publicId, body.expand);
}

async function resume(req: Request, res: Response, merchant: MerchantRow) {
  const id = idParam(req, res);
  if (!id) return;
  const body = parseBody(req, res, resumeSubscriptionParams);
  if (!body) return;
  const row = await resumeSubscription(merchant, id, {
    ...(body.billing_cycle_anchor ? { billingCycleAnchor: body.billing_cycle_anchor } : {}),
    ...(body.proration_behavior ? { prorationBehavior: body.proration_behavior } : {}),
  });
  await answer(res, merchant, row.publicId, body.expand);
}

async function list(req: Request, res: Response, merchant: MerchantRow, surface: QuerySurface) {
  const query = parseQuery(req, res, listQuery[surface]);
  if (!query) return;
  const db = getDb();
  const customer = await resolveListReference(
    res,
    'customer',
    query.customer,
    async (id) => (await findCustomerForMerchant(db, id, merchant.id))?.id ?? null,
  );
  if (!customer.ok) return;
  const price = await resolveListReference(
    res,
    'price',
    query.price,
    async (id) => (await findPriceForMerchant(db, id, merchant.id))?.id ?? null,
  );
  if (!price.ok) return;
  const clock = await resolveListReference(
    res,
    'test_clock',
    query.test_clock,
    async (id) => (await findLiveTestClockForMerchant(db, id, merchant.id))?.id ?? null,
  );
  if (!clock.ok) return;
  await answerList(req, res, {
    query,
    type: 'subscription',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findSubscriptionForMerchant(db, publicId, merchant.id))?.id ?? null,
    fetch: (page) =>
      listSubscriptions(db, {
        merchantId: merchant.id,
        page,
        customerId: customer.id,
        priceId: price.id,
        status: query.status,
        testClockId: clock.id,
        currentPeriodEnd: query.current_period_end,
      }),
    serializeAll: (rows) => renderSubscriptions(db, rows),
  });
}

// ---- Items ------------------------------------------------------------------------

const listItemsQuery = bySurface(listSubscriptionItemsQuery);

async function itemDTO(merchant: MerchantRow, publicId: string) {
  const db = getDb();
  const item = await findItemForMerchant(db, publicId, merchant.id);
  if (!item) throw missing('subscription item');
  const [price] = await findPricesByRowIds(db, [item.priceId]);
  if (!price) throw new Error('item price vanished');
  return { item, dto: toSubscriptionItemDTO(item, toPriceDTO(price)) };
}

async function createItem(req: Request, res: Response, merchant: MerchantRow) {
  const body = parseBody(req, res, createSubscriptionItemParams);
  if (!body) return;
  const before = await findSubscriptionForMerchant(getDb(), body.subscription, merchant.id);
  if (!before)
    throw new BillingEngineError(
      'resource_missing',
      `no such subscription: '${body.subscription}'`,
      'subscription',
    );
  const row = await updateSubscription(merchant, body.subscription, {
    items: [
      {
        price: body.price,
        ...(body.quantity !== undefined ? { quantity: body.quantity } : {}),
        ...(body.metadata ? { metadata: body.metadata } : {}),
      },
    ],
    ...(body.proration_behavior ? { prorationBehavior: body.proration_behavior } : {}),
    ...(body.proration_date !== undefined ? { prorationDate: body.proration_date } : {}),
  });
  const dto = await renderSubscription(getDb(), row);
  const created = dto.items.data.find((item) => item.price.id === body.price);
  if (!created) throw new Error('the new item vanished');
  res.status(200).json(created);
}

async function retrieveItem(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
) {
  const id = idParam(req, res);
  if (!id) return;
  const query = parseQuery(req, res, retrieveQuery[surface]);
  if (!query) return;
  const { dto } = await itemDTO(merchant, id);
  await answerObject(res, merchant, 'subscription_item', dto, query.expand);
}

async function updateItem(req: Request, res: Response, merchant: MerchantRow) {
  const id = idParam(req, res);
  if (!id) return;
  const body = parseBody(req, res, updateSubscriptionItemParams);
  if (!body) return;
  const { item } = await itemDTO(merchant, id);
  await updateSubscription(merchant, item.subscriptionPublicId, {
    items: [
      {
        id,
        ...(body.price ? { price: body.price } : {}),
        ...(body.quantity !== undefined ? { quantity: body.quantity } : {}),
        ...(body.metadata ? { metadata: body.metadata } : {}),
      },
    ],
    ...(body.proration_behavior ? { prorationBehavior: body.proration_behavior } : {}),
    ...(body.proration_date !== undefined ? { prorationDate: body.proration_date } : {}),
  });
  res.status(200).json((await itemDTO(merchant, id)).dto);
}

async function deleteItem(req: Request, res: Response, merchant: MerchantRow) {
  const id = idParam(req, res);
  if (!id) return;
  const body = parseBody(req, res, deleteSubscriptionItemParams);
  if (!body) return;
  const { item } = await itemDTO(merchant, id);
  await updateSubscription(merchant, item.subscriptionPublicId, {
    items: [{ id, deleted: true }],
    ...(body.proration_behavior ? { prorationBehavior: body.proration_behavior } : {}),
    ...(body.proration_date !== undefined ? { prorationDate: body.proration_date } : {}),
  });
  res.status(200).json({ id, object: 'subscription_item', deleted: true });
}

async function listItems(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
) {
  const query = parseQuery(req, res, listItemsQuery[surface]);
  if (!query) return;
  const db = getDb();
  const subscription = await findSubscriptionForMerchant(db, query.subscription, merchant.id);
  if (!subscription)
    throw new BillingEngineError(
      'resource_missing',
      `no such subscription: '${query.subscription}'`,
      'subscription',
    );
  await answerList(req, res, {
    query,
    type: 'subscription_item',
    merchantId: merchant.id,
    cursor: async (publicId) => {
      const item = await findItemForMerchant(db, publicId, merchant.id);
      return item && item.subscriptionId === subscription.id ? item.id : null;
    },
    fetch: (page) => listItemsPage(db, subscription.id, page),
    serializeAll: async (rows) => {
      const prices = await findPricesByRowIds(
        db,
        rows.map((row) => row.priceId),
      );
      return rows.map((row) => {
        const price = prices.find((candidate) => candidate.id === row.priceId);
        if (!price) throw new Error('item price vanished');
        return toSubscriptionItemDTO(row, toPriceDTO(price));
      });
    },
  });
}

export const SUBSCRIPTION_ROUTES: readonly CatalogRoute[] = [
  { method: 'post', path: '/subscriptions', core: create },
  { method: 'get', path: '/subscriptions', core: list },
  { method: 'get', path: '/subscriptions/:id', core: retrieve },
  { method: 'post', path: '/subscriptions/:id', core: update },
  { method: 'delete', path: '/subscriptions/:id', core: cancel },
  { method: 'post', path: '/subscriptions/:id/resume', core: resume },
  { method: 'post', path: '/subscription_items', core: createItem },
  { method: 'get', path: '/subscription_items', core: listItems },
  { method: 'get', path: '/subscription_items/:id', core: retrieveItem },
  { method: 'post', path: '/subscription_items/:id', core: updateItem },
  { method: 'delete', path: '/subscription_items/:id', core: deleteItem },
];
