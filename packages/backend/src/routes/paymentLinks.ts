/**
 * Payment Links v2 (Orbit Phase 3).
 *
 * The merchant routes are DATA (`paymentLinkRoutes`), mounted on
 * `/v1/payment_links` here and on Orbit's dashboard from the same list. The
 * payer routes are anonymous and rate-limited: `GET …/public` shows the link,
 * and `POST …/checkout_sessions` starts checkout — it creates a Checkout
 * Session (Stripe's semantics), never a payment; the payment exists only once
 * the payer confirms that session.
 */
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import {
  contributionAmountSchema,
  contributionOperationKeySchema,
} from '@peable.to/contracts/contributions';
import { findBranding } from '../db/merchants/brandingRepository';
import { findMerchantById, type MerchantRow } from '../db/merchants/merchantRepository';
import {
  findLinkByPublicId,
  findLinkForMerchant,
  listLinksForMerchant,
  type PaymentLinkRow,
} from '../db/payments/paymentLinkRepository';
import { getDb } from '../db/postgres';
import { expandObjects, parseExpand } from '../lib/expand';
import { sendError, sendValidationError, wrap } from '../lib/http';
import {
  answerList,
  completeList,
  parseQuery,
  surfaceListQuery,
  surfaceRetrieveQuery,
} from '../lib/list';
import {
  hostedCheckoutUrl,
  toCheckoutBranding,
  toPublicPaymentLinkDTO,
} from '../lib/serializeCheckout';
import { booleanQuery } from '../services/catalog/params';
import { CheckoutError, sendCheckoutError } from '../services/checkout/errors';
import {
  createLinkBodySchema,
  createPaymentLink,
  linkLines,
  toLinkDTO,
  toLinkDTOs,
  updateLinkBodySchema,
  updatePaymentLinkOptions,
} from '../services/checkout/linkService';
import { type CheckoutDeps, createSessionFromLink } from '../services/checkout/sessionService';
import { resolveMerchantDisplay } from '../services/merchantDisplay';
import { type CatalogRoute, createCatalogApiRouter } from './catalogRoutes';

const listLinksQuery = surfaceListQuery({ active: booleanQuery.optional() });
const retrieveLinkQuery = surfaceRetrieveQuery();
const lineItemsQuery = surfaceListQuery({});

function idParam(req: Request, res: Response): string | null {
  const { id } = req.params;
  if (!id) {
    sendError(res, 400, 'invalid_request_error', 'id is required');
    return null;
  }
  return id;
}

async function linkOr404(id: string, merchant: MerchantRow): Promise<PaymentLinkRow> {
  const row = await findLinkForMerchant(getDb(), id, merchant.id);
  if (!row) throw new CheckoutError(404, 'resource_missing', 'payment link not found');
  return row;
}

async function answerLink(
  res: Response,
  merchant: MerchantRow,
  row: PaymentLinkRow,
  status = 200,
): Promise<void> {
  const dto = await toLinkDTO(getDb(), row);
  await expandObjects([dto], 'payment_link', {}, merchant.id);
  res.status(status).json(dto);
}

/** The merchant's link routes, as data. */
export function paymentLinkRoutes(deps: CheckoutDeps): CatalogRoute[] {
  return [
    {
      method: 'post',
      path: '/payment_links',
      core: async (req, res, merchant) => {
        const parsed = createLinkBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          sendValidationError(res, parsed.error);
          return;
        }
        if (!parseExpand(res, 'payment_link', parsed.data.expand, { list: false })) return;
        await answerLink(res, merchant, await createPaymentLink(merchant, parsed.data, deps), 201);
      },
    },
    {
      method: 'get',
      path: '/payment_links',
      core: async (req, res, merchant, surface) => {
        const query = parseQuery(req, res, listLinksQuery[surface]);
        if (!query) return;
        const db = getDb();
        await answerList(req, res, {
          query,
          type: 'payment_link',
          merchantId: merchant.id,
          cursor: async (publicId) =>
            (await findLinkForMerchant(db, publicId, merchant.id))?.id ?? null,
          fetch: async (page) => {
            const links = await listLinksForMerchant(db, {
              merchantId: merchant.id,
              active: query.active,
              page,
            });
            // One read of every line on the page, not one per link.
            const dtos = await toLinkDTOs(db, merchant.id, links.data);
            return { data: dtos, hasMore: links.hasMore };
          },
          serialize: (dto) => dto,
        });
      },
    },
    {
      method: 'get',
      path: '/payment_links/:id',
      core: async (req, res, merchant, surface) => {
        const id = idParam(req, res);
        if (!id) return;
        const query = parseQuery(req, res, retrieveLinkQuery[surface]);
        if (!query) return;
        if (!parseExpand(res, 'payment_link', query.expand, { list: false })) return;
        await answerLink(res, merchant, await linkOr404(id, merchant));
      },
    },
    {
      method: 'post',
      path: '/payment_links/:id',
      core: async (req, res, merchant) => {
        const id = idParam(req, res);
        if (!id) return;
        const parsed = updateLinkBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          sendValidationError(res, parsed.error);
          return;
        }
        if (!parseExpand(res, 'payment_link', parsed.data.expand, { list: false })) return;
        await answerLink(
          res,
          merchant,
          await updatePaymentLinkOptions(merchant, id, parsed.data, deps),
        );
      },
    },
    {
      method: 'get',
      path: '/payment_links/:id/line_items',
      core: async (req, res, merchant, surface) => {
        const id = idParam(req, res);
        if (!id) return;
        const query = parseQuery(req, res, lineItemsQuery[surface]);
        if (!query) return;
        const tree = parseExpand(res, 'item', query.expand, { list: true });
        if (!tree) return;
        // At most twenty lines: a complete set (`has_more: false`).
        const lines = await linkLines(await linkOr404(id, merchant));
        await expandObjects(lines, 'item', tree, merchant.id);
        res.status(200).json(completeList(req, lines));
      },
    },
  ];
}

// `@peable.to/contracts` is Zod 4, this router Zod 3: the contract's own rule, applied by value.
const startBodySchema = z
  .object({
    amount: z
      .string()
      .refine(
        (value) => contributionAmountSchema.safeParse(value).success,
        'Enter a positive FairCoin base-unit amount within the supported range',
      )
      .optional(),
  })
  .strict();

/** Build the payment-link router: merchant API + payer routes. */
export function createPaymentLinksRouter(deps: {
  requireMerchant: RequestHandler;
  publicRateLimit: RequestHandler;
  checkout?: CheckoutDeps;
}): Router {
  const checkoutDeps = deps.checkout ?? {};
  const router = Router();
  router.use(
    createCatalogApiRouter(paymentLinkRoutes(checkoutDeps), {
      requireMerchant: deps.requireMerchant,
    }),
  );

  // Anonymous: what a visitor sees before checkout starts. An inactive link is
  // answered (not 404'd) so the page can say it is inactive.
  router.get(
    '/v1/payment_links/:id/public',
    deps.publicRateLimit,
    wrap(async (req, res) => {
      const id = idParam(req, res);
      if (!id) return;
      const db = getDb();
      const link = await findLinkByPublicId(db, id);
      const merchant = link ? await findMerchantById(db, link.merchantId) : null;
      if (!link || !merchant) {
        sendError(res, 404, 'invalid_request_error', 'payment link not found');
        return;
      }
      const [display, branding, lines] = await Promise.all([
        resolveMerchantDisplay(merchant),
        findBranding(db, merchant.id),
        link.contribution ? Promise.resolve([]) : linkLines(link),
      ]);
      const expired =
        link.contribution?.expiresAt != null &&
        Date.parse(link.contribution.expiresAt) <= Date.now();
      res
        .status(200)
        .json(
          toPublicPaymentLinkDTO(
            expired ? { ...link, active: false } : link,
            lines,
            display,
            toCheckoutBranding(merchant, branding),
          ),
        );
    }),
  );

  // Anonymous: start checkout. Every value comes from the STORED link; a
  // payer may only choose a free contribution's amount. A contribution start
  // needs a UUID `Idempotency-Key`, written by the page BEFORE the request, so
  // a lost answer recovers the same session even after the link is disabled.
  router.post(
    '/v1/payment_links/:id/checkout_sessions',
    deps.publicRateLimit,
    wrap(async (req, res) => {
      const id = idParam(req, res);
      if (!id) return;
      const db = getDb();
      const link = await findLinkByPublicId(db, id);
      const merchant = link ? await findMerchantById(db, link.merchantId) : null;
      if (!link || !merchant) {
        sendError(res, 404, 'invalid_request_error', 'payment link not found');
        return;
      }
      const body = startBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
        sendValidationError(res, body.error);
        return;
      }
      const rawKey = req.header('Idempotency-Key');
      const key =
        rawKey === undefined ? undefined : contributionOperationKeySchema.safeParse(rawKey);
      if ((link.contribution && !key?.success) || (key && !key.success)) {
        sendError(
          res,
          400,
          'invalid_request_error',
          'A UUID Idempotency-Key header is required',
          'idempotency_key_invalid',
        );
        return;
      }
      try {
        const session = await createSessionFromLink(
          link,
          merchant,
          {
            ...(body.data.amount !== undefined ? { amount: body.data.amount } : {}),
            ...(key?.success ? { operationKey: key.data } : {}),
          },
          checkoutDeps,
        );
        const url = hostedCheckoutUrl(session);
        if (!url || session.clientSecret === null) throw new Error('a link session is hosted');
        res.setHeader('Cache-Control', 'no-store');
        res.status(201).json({
          object: 'checkout_session_start',
          id: session.publicId,
          client_secret: session.clientSecret,
          url,
        });
      } catch (error) {
        sendCheckoutError(res, error);
      }
    }),
  );

  return router;
}
