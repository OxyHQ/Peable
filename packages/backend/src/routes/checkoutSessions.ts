import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { verifySecret } from '@oxy.so/core/server';
import {
  METADATA_LIMIT_MESSAGE,
  confirmCheckoutSessionPublicParams,
  createCheckoutSessionParams,
  expandOnlyQuery,
  expireCheckoutSessionParams,
  listCheckoutSessionLineItemsQuery,
  listCheckoutSessionsQuery,
  updateCheckoutSessionParams,
  updateCheckoutSessionPublicParams,
} from '@peable.to/contracts';
import type { CheckoutSessionPublic } from '@peable.to/shared-types';
import { findCouponById } from '../db/catalog/couponRepository';
import { findPromotionCodeById } from '../db/catalog/promotionCodeRepository';
import { findLiveCustomerForMerchant } from '../db/customers/customerRepository';
import { findBranding } from '../db/merchants/brandingRepository';
import { findMerchantById, type MerchantRow } from '../db/merchants/merchantRepository';
import {
  type CheckoutSessionRow,
  findLineItemInSession,
  findSessionByPublicId,
  findSessionForMerchant,
  listLineItems,
  listSessionsForMerchant,
  updateSessionMetadata,
} from '../db/payments/checkoutSessionRepository';
import { findIntentById, findIntentForMerchant } from '../db/payments/paymentIntentRepository';
import { findLinkForMerchant } from '../db/payments/paymentLinkRepository';
import { getDb } from '../db/postgres';
import { expandObjects, parseExpand } from '../lib/expand';
import { sendError, sendValidationError, wrap } from '../lib/http';
import { answerList, dashboardQuery, parseQuery, resolveListReference } from '../lib/list';
import { toPaymentIntentDTO } from '../lib/serialize';
import {
  toCheckoutBranding,
  toCheckoutLineItemDTO,
  toCheckoutSessionDTO,
  toCheckoutSessionPublicDTO,
} from '../lib/serializeCheckout';
import { CheckoutError, sendCheckoutError } from '../services/checkout/errors';
import { refuseUnknownTaxCodes } from '../services/checkout/params';
import {
  type CheckoutDeps,
  confirmSessionAsPayer,
  createCheckoutSession,
  expireSessionForMerchant,
  publishableKeyFor,
  setupClientSecretOf,
  updateSessionAsPayer,
} from '../services/checkout/sessionService';
import { resolveMerchantDisplay } from '../services/merchantDisplay';
import { type CatalogRoute, createCatalogApiRouter } from './catalogRoutes';

// The contract's queries on the API; the dashboard's twin adds its environment.
const listSessionsQuery = {
  api: listCheckoutSessionsQuery,
  dashboard: dashboardQuery(listCheckoutSessionsQuery),
} as const;
const retrieveSessionQuery = { api: expandOnlyQuery, dashboard: dashboardQuery(expandOnlyQuery) };
const lineItemsQuery = {
  api: listCheckoutSessionLineItemsQuery,
  dashboard: dashboardQuery(listCheckoutSessionLineItemsQuery),
} as const;

function idParam(req: Request, res: Response): string | null {
  const { id } = req.params;
  if (!id) {
    sendError(res, 400, 'invalid_request_error', 'id is required');
    return null;
  }
  return id;
}

async function answerSession(
  res: Response,
  merchant: MerchantRow,
  row: CheckoutSessionRow,
  expand: readonly string[] | undefined,
  status = 200,
): Promise<void> {
  const tree = parseExpand(res, 'checkout_session', expand, { list: false });
  if (!tree) return;
  const dto = toCheckoutSessionDTO(row);
  await expandObjects([dto], 'checkout_session', tree, merchant.id);
  res.status(status).json(dto);
}

async function sessionOr404(id: string, merchant: MerchantRow): Promise<CheckoutSessionRow> {
  const row = await findSessionForMerchant(getDb(), id, merchant.id);
  if (!row) throw new CheckoutError(404, 'resource_missing', 'checkout session not found');
  return row;
}

/** The merchant's session routes, as data — mounted on the API and on Orbit's dashboard. */
export function checkoutSessionRoutes(deps: CheckoutDeps): CatalogRoute[] {
  return [
    {
      method: 'post',
      path: '/checkout_sessions',
      core: async (req, res, merchant) => {
        const parsed = createCheckoutSessionParams.safeParse(req.body ?? {});
        if (!parsed.success) {
          sendValidationError(res, parsed.error);
          return;
        }
        if (!refuseUnknownTaxCodes(res, parsed.data)) return;
        if (!parseExpand(res, 'checkout_session', parsed.data.expand, { list: false })) return;
        const row = await createCheckoutSession(merchant, parsed.data, deps);
        await answerSession(res, merchant, row, parsed.data.expand, 201);
      },
    },
    {
      method: 'get',
      path: '/checkout_sessions',
      core: async (req, res, merchant, surface) => {
        const query = parseQuery(req, res, listSessionsQuery[surface]);
        if (!query) return;
        const db = getDb();
        const intent = await resolveListReference(
          res,
          'payment_intent',
          query.payment_intent,
          async (id) => (await findIntentForMerchant(db, id, merchant.id))?.id ?? null,
        );
        if (!intent.ok) return;
        const link = await resolveListReference(
          res,
          'payment_link',
          query.payment_link,
          async (id) => (await findLinkForMerchant(db, id, merchant.id))?.id ?? null,
        );
        if (!link.ok) return;
        const customer = await resolveListReference(
          res,
          'customer',
          query.customer,
          async (id) => (await findLiveCustomerForMerchant(db, id, merchant.id))?.id ?? null,
        );
        if (!customer.ok) return;
        await answerList(req, res, {
          query,
          type: 'checkout_session',
          merchantId: merchant.id,
          cursor: async (publicId) =>
            (await findSessionForMerchant(db, publicId, merchant.id))?.id ?? null,
          fetch: (page) =>
            listSessionsForMerchant(db, {
              merchantId: merchant.id,
              paymentIntentId: intent.id,
              paymentLinkId: link.id,
              customerId: customer.id,
              status: query.status,
              page,
            }),
          serialize: toCheckoutSessionDTO,
        });
      },
    },
    {
      method: 'get',
      path: '/checkout_sessions/:id',
      core: async (req, res, merchant, surface) => {
        const id = idParam(req, res);
        if (!id) return;
        const query = parseQuery(req, res, retrieveSessionQuery[surface]);
        if (!query) return;
        if (!parseExpand(res, 'checkout_session', query.expand, { list: false })) return;
        await answerSession(res, merchant, await sessionOr404(id, merchant), query.expand);
      },
    },
    {
      method: 'post',
      path: '/checkout_sessions/:id',
      core: async (req, res, merchant) => {
        const id = idParam(req, res);
        if (!id) return;
        const parsed = updateCheckoutSessionParams.safeParse(req.body ?? {});
        if (!parsed.success) {
          sendValidationError(res, parsed.error);
          return;
        }
        if (!parseExpand(res, 'checkout_session', parsed.data.expand, { list: false })) return;
        const db = getDb();
        const row =
          parsed.data.metadata === undefined
            ? ((await findSessionForMerchant(db, id, merchant.id)) ?? 'missing')
            : await updateSessionMetadata(db, id, merchant.id, parsed.data.metadata);
        if (row === 'missing')
          throw new CheckoutError(404, 'resource_missing', 'checkout session not found');
        if (row === 'limit_exceeded') {
          throw new CheckoutError(400, 'parameter_invalid', METADATA_LIMIT_MESSAGE, 'metadata');
        }
        await answerSession(res, merchant, row, parsed.data.expand);
      },
    },
    {
      method: 'post',
      path: '/checkout_sessions/:id/expire',
      core: async (req, res, merchant) => {
        const id = idParam(req, res);
        if (!id) return;
        const parsed = expireCheckoutSessionParams.safeParse(req.body ?? {});
        if (!parsed.success) {
          sendValidationError(res, parsed.error);
          return;
        }
        const row = await expireSessionForMerchant(await sessionOr404(id, merchant));
        await answerSession(res, merchant, row, parsed.data.expand);
      },
    },
    {
      method: 'get',
      path: '/checkout_sessions/:id/line_items',
      core: async (req, res, merchant, surface) => {
        const id = idParam(req, res);
        if (!id) return;
        const query = parseQuery(req, res, lineItemsQuery[surface]);
        if (!query) return;
        const session = await sessionOr404(id, merchant);
        const db = getDb();
        // A session has at most twenty lines; the list contract pages over
        // them in their order, the cursor being a line's own `li_…`.
        const lines = await listLineItems(db, session.id);
        await answerList(req, res, {
          query: { ...query, created: undefined },
          type: 'item',
          merchantId: merchant.id,
          cursor: async (publicId) =>
            (await findLineItemInSession(db, session.id, publicId))?.id ?? null,
          fetch: async (page) => {
            const index = (lineId: string | undefined) =>
              lineId === undefined ? -1 : lines.findIndex((line) => line.id === lineId);
            let window = lines;
            if (page.after !== undefined) window = lines.slice(index(page.after) + 1);
            else if (page.before !== undefined) {
              const end = index(page.before);
              window = lines.slice(Math.max(0, end - page.limit), end);
              return { data: window, hasMore: end - page.limit > 0 };
            }
            return { data: window.slice(0, page.limit), hasMore: window.length > page.limit };
          },
          serialize: toCheckoutLineItemDTO,
        });
      },
    },
  ];
}

// ---- Payer routes ---------------------------------------------------------------------

function clientSecretOf(req: Request): string | undefined {
  return req.header('X-Peable-Client-Secret') ?? undefined;
}

/**
 * The session a payer may act on, or the answer already sent. Unknown session
 * and wrong secret answer differently (404 / 403), as the payment intent's
 * payer read does: the id is not a secret, the client secret is.
 */
async function payerSession(
  req: Request,
  res: Response,
): Promise<{ session: CheckoutSessionRow; merchant: MerchantRow } | null> {
  const id = idParam(req, res);
  if (!id) return null;
  const secret = clientSecretOf(req);
  if (!secret) {
    sendError(res, 401, 'authentication_error', 'missing client_secret');
    return null;
  }
  const db = getDb();
  const session = await findSessionByPublicId(db, id);
  if (!session) {
    sendError(res, 404, 'invalid_request_error', 'checkout session not found');
    return null;
  }
  if (session.clientSecret === null || !verifySecret(secret, session.clientSecret)) {
    sendError(res, 403, 'permission_error', 'invalid client_secret');
    return null;
  }
  const merchant = await findMerchantById(db, session.merchantId);
  if (!merchant) {
    sendError(res, 404, 'invalid_request_error', 'checkout session not found');
    return null;
  }
  return { session, merchant };
}

/** The discount as the payer sees it: the code they typed, or the coupon's name, and its terms. */
async function discountView(
  session: CheckoutSessionRow,
): Promise<CheckoutSessionPublic['discount']> {
  if (session.couponId === null) return null;
  const db = getDb();
  const [coupon, code] = await Promise.all([
    findCouponById(db, session.couponId),
    session.promotionCodeId ? findPromotionCodeById(db, session.promotionCodeId) : null,
  ]);
  if (!coupon) return null;
  return {
    promotion_code: code?.code ?? null,
    coupon_name: coupon.name,
    amount_off: coupon.amountOff,
    percent_off: coupon.percentOffBps === null ? null : coupon.percentOffBps / 100,
  };
}

/** The whole payer view of a session. */
export async function publicSessionDTO(
  session: CheckoutSessionRow,
  merchant: MerchantRow,
): Promise<CheckoutSessionPublic> {
  const db = getDb();
  const [lines, display, brandingRow, intent, setup, discount] = await Promise.all([
    listLineItems(db, session.id),
    resolveMerchantDisplay(merchant),
    findBranding(db, merchant.id),
    session.paymentIntentId ? findIntentById(db, session.paymentIntentId) : null,
    setupClientSecretOf(session),
    discountView(session),
  ]);
  return toCheckoutSessionPublicDTO({
    session,
    lines,
    merchant: display,
    branding: toCheckoutBranding(merchant, brandingRow),
    paymentIntent: intent ? toPaymentIntentDTO(intent) : null,
    setupIntent: setup,
    discount,
    termsOfServiceUrl: brandingRow.termsOfServiceUrl,
    publishableKey: publishableKeyFor(session),
  });
}

function answerPayer(res: Response, body: CheckoutSessionPublic): void {
  // A payer's view carries a client secret: never cached by anything in front.
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(body);
}

/** Build the checkout-session router: merchant API + payer routes. */
export function createCheckoutSessionsRouter(deps: {
  requireMerchant: RequestHandler;
  publicRateLimit: RequestHandler;
  checkout?: CheckoutDeps;
}): Router {
  const checkoutDeps = deps.checkout ?? {};
  const router = Router();
  router.use(
    createCatalogApiRouter(checkoutSessionRoutes(checkoutDeps), {
      requireMerchant: deps.requireMerchant,
    }),
  );

  router.get(
    '/v1/checkout_sessions/:id/public',
    deps.publicRateLimit,
    wrap(async (req, res) => {
      const found = await payerSession(req, res);
      if (!found) return;
      answerPayer(res, await publicSessionDTO(found.session, found.merchant));
    }),
  );

  router.post(
    '/v1/checkout_sessions/:id/public',
    deps.publicRateLimit,
    wrap(async (req, res) => {
      const found = await payerSession(req, res);
      if (!found) return;
      const parsed = updateCheckoutSessionPublicParams.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      try {
        const row = await updateSessionAsPayer(
          found.session,
          found.merchant,
          parsed.data,
          checkoutDeps,
        );
        answerPayer(res, await publicSessionDTO(row, found.merchant));
      } catch (error) {
        sendCheckoutError(res, error);
      }
    }),
  );

  router.post(
    '/v1/checkout_sessions/:id/public/confirm',
    deps.publicRateLimit,
    wrap(async (req, res) => {
      const found = await payerSession(req, res);
      if (!found) return;
      const parsed = confirmCheckoutSessionPublicParams.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      try {
        const row = await confirmSessionAsPayer(found.session, found.merchant, checkoutDeps);
        answerPayer(res, await publicSessionDTO(row, found.merchant));
      } catch (error) {
        sendCheckoutError(res, error);
      }
    }),
  );

  return router;
}
