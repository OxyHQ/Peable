import { eq } from 'drizzle-orm';
import { faircoinBillingInvoices } from '../db/schema/faircoinBilling';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { oxy } from '../oxy';
import { verifySecret } from '@oxy.so/core/server';
import type {
  CreateCheckoutSessionParams,
  UpdateCheckoutSessionParams,
} from '@peable.to/shared-types';
import { getDb } from '../db/postgres';
import { findMerchantById } from '../db/merchants/merchantRepository';
import {
  findIntentById,
  findIntentForMerchant,
  findIntentsByIds,
} from '../db/payments/paymentIntentRepository';
import {
  findSessionByIntentId,
  findSessionByPublicId,
  findSessionForMerchant,
  insertCheckoutSession,
  listSessionsForMerchant,
  updateSessionMetadata,
} from '../db/payments/checkoutSessionRepository';
import {
  createIntent,
  IdempotencyConflictError,
  NetworkMismatchError,
  RailMismatchError,
  RailUnavailableError,
} from '../services/createIntent';
import { EnvironmentModeMismatchError } from '../services/providers/environmentGuard';
import { resolveMerchantDisplay } from '../services/merchantDisplay';
import { newId } from '../lib/ids';
import { toCheckoutSessionDTO, toCheckoutSessionPublicDTO } from '../lib/serialize';
import {
  sendEnvironmentMismatch,
  sendError,
  wrap,
  requireAuthenticated,
  sendValidationError,
} from '../lib/http';
import {
  connectedAccountBodyField,
  resolveMerchant,
  sendConnectedAccountRefusal,
} from './paymentIntents';
import { railBodyFields } from '../lib/railSchema';
import { idempotencyKeyOf, idempotent } from '../lib/idempotency';
import { expandObjects, parseExpand } from '../lib/expand';
import {
  answerList,
  expandParam,
  listQuerySchema,
  parseQuery,
  resolveListReference,
  retrieveQuerySchema,
} from '../lib/list';
import {
  METADATA_LIMIT_MESSAGE,
  metadataCreateSchema,
  metadataUpdateSchema,
} from '../lib/metadata';

/** `GET /v1/checkout_sessions`: every session, or the one wrapping a payment. */
const listSessionsQuery = listQuerySchema({
  payment_intent: z.string().min(1).max(255).optional(),
});
const retrieveSessionQuery = retrieveQuerySchema({});

const updateBodySchema = z
  .object({
    metadata: metadataUpdateSchema.optional(),
    expand: expandParam.optional(),
  } satisfies Record<keyof UpdateCheckoutSessionParams | 'expand', z.ZodType>)
  .strict();

const createBodySchema = z
  .object({
    ...railBodyFields,
    ...connectedAccountBodyField,
    metadata: metadataCreateSchema.optional(),
    success_url: z.string().url().optional(),
    cancel_url: z.string().url().optional(),
  } satisfies Record<keyof CreateCheckoutSessionParams, z.ZodType>)
  .strict();

/**
 * Build the checkout-session REST router (F2.2). `POST`/merchant `GET` follow
 * the same merchant-authed chain as `paymentIntents.ts`; the public `GET
 * .../public` is the checkout page's payer path, authorized by possession of
 * the wrapped intent's `client_secret` — exactly the same idiom as the payer
 * branch of `GET /v1/payment_intents/:id` — never a service token.
 */
export function createCheckoutSessionsRouter(deps: {
  requireMerchant: RequestHandler;
  publicRateLimit: RequestHandler;
}): Router {
  const { requireMerchant, publicRateLimit } = deps;
  const router = Router();

  router.post(
    '/v1/checkout_sessions',
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:write'),
    idempotent,
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      const parsed = createBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      const params: CreateCheckoutSessionParams = parsed.data as CreateCheckoutSessionParams;

      /**
       * A retried request is answered by the generic layer (`idempotent`, ADR
       * 0014 D3) before this handler runs. The key also converges the INTENT
       * (`payment_intents.idempotency_key`), and `checkout_sessions` is unique
       * on the intent it wraps — so the session that already wraps the
       * replayed intent IS the session that key created. That is the second
       * line, for a retry the generic layer let through (a lease takeover, or
       * after its 24 hours): one order never gets two live sessions and two
       * prices a buyer can be shown.
       */
      const idempotencyKey = idempotencyKeyOf(res);

      try {
        const { intent, reused } = await createIntent({
          merchant,
          amount: params.amount,
          ...(params.rail !== undefined ? { rail: params.rail } : {}),
          ...(params.currency !== undefined ? { currency: params.currency } : {}),
          ...(params.network !== undefined ? { network: params.network } : {}),
          ...(params.connected_account !== undefined
            ? { connectedAccount: params.connected_account }
            : {}),
          metadata: params.metadata,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });

        if (reused) {
          // The key named an intent that already exists, so the session that
          // wraps it already exists too. 200, not 201: nothing was created, and
          // the status code is what tells a merchant whether they just made a
          // second checkout.
          const existing = await findSessionByIntentId(getDb(), intent.id);
          if (existing) {
            res.status(200).json(toCheckoutSessionDTO(existing, intent));
            return;
          }
          // The intent exists and no session wraps it — a create interrupted
          // between the two writes. Fall through and write the session, which
          // is what finishing that create means.
        }

        // Explicit field whitelist — never spread `req.body`.
        //
        // `paymentIntentId` is the intent's INTERNAL id, which is what
        // `checkout_sessions.payment_intent_id` references, NOT the public
        // `pi_…`. The public id still reaches the wire, from
        // `toCheckoutSessionDTO`, which reads it off the intent.
        const session = await insertCheckoutSession(getDb(), {
          publicId: newId('cs'),
          merchantId: merchant.id,
          oxyAppId: merchant.oxyAppId,
          environment: merchant.environment,
          paymentIntentId: intent.id,
          amount: params.amount,
          // Copied from the INTENT, never re-derived from the request. The two
          // rows live in different tables, so no constraint can catch a session
          // whose rail disagrees with the payment it wraps — and that
          // disagreement is a card form rendered over a FairCoin payment.
          currency: intent.currency,
          rail: intent.rail,
          network: intent.network,
          // From the INTENT, for the reason the rail is: a session whose seller
          // disagreed with the payment it wraps would show one payee and pay
          // another. `checkout_sessions_connected_account_network_fkey` holds the
          // account to this merchant and to the intent's network.
          connectedAccountId: intent.connectedAccountId ?? null,
          metadata: params.metadata ?? {},
          successUrl: params.success_url,
          cancelUrl: params.cancel_url,
        });
        if (!session) {
          /**
           * Another request wrapped this intent between the read above and this
           * insert — two concurrent creates with one `Idempotency-Key`. The
           * unique index decided the winner; re-reading it is correct rather
           * than merely convenient, because both requests named the same intent
           * and therefore the same session.
           *
           * Before the key was honoured this branch was unreachable and said
           * so: every session minted a fresh intent, so nothing else could have
           * wrapped it.
           */
          const winner = await findSessionByIntentId(getDb(), intent.id);
          if (!winner) {
            throw new Error(`checkout session insert found intent ${intent.id} already wrapped`);
          }
          res.status(200).json(toCheckoutSessionDTO(winner, intent));
          return;
        }

        res.status(201).json(toCheckoutSessionDTO(session, intent));
      } catch (err) {
        if (err instanceof NetworkMismatchError || err instanceof RailMismatchError) {
          sendError(res, 400, 'invalid_request_error', err.message);
          return;
        }
        if (sendConnectedAccountRefusal(res, err)) return;
        if (err instanceof EnvironmentModeMismatchError) {
          sendEnvironmentMismatch(res, err.message);
          return;
        }
        if (err instanceof IdempotencyConflictError) {
          sendError(res, 400, 'invalid_request_error', err.message, 'idempotency_error');
          return;
        }
        // 503, not 400: the rail is not configured on this deployment, which is
        // not something the caller can fix by sending different fields.
        if (err instanceof RailUnavailableError) {
          sendError(res, 503, 'api_error', err.message);
          return;
        }
        throw err;
      }
    }),
  );

  /** Every session of the merchant, newest first — or the one wrapping `payment_intent=pi_…`. */
  router.get(
    '/v1/checkout_sessions',
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:read'),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const query = parseQuery(req, res, listSessionsQuery);
      if (!query) return;

      const db = getDb();
      const intent = await resolveListReference(
        res,
        'payment_intent',
        query.payment_intent,
        async (publicId) => (await findIntentForMerchant(db, publicId, merchant.id))?.id ?? null,
      );
      if (!intent.ok) return;

      await answerList(req, res, {
        query,
        type: 'checkout_session',
        merchantId: merchant.id,
        cursor: async (publicId) =>
          (await findSessionForMerchant(db, publicId, merchant.id))?.id ?? null,
        fetch: async (page) => {
          const sessions = await listSessionsForMerchant(db, {
            merchantId: merchant.id,
            paymentIntentId: intent.id,
            page,
          });
          // The DTO reads the wrapped intent (its `pi_…`, `client_secret`,
          // seller), so the page's intents are read in ONE query, not per row.
          const intents = new Map(
            (
              await findIntentsByIds(
                db,
                sessions.data.map((s) => s.paymentIntentId),
              )
            ).map((row) => [row.id, row]),
          );
          return {
            hasMore: sessions.hasMore,
            data: sessions.data.map((session) => {
              const wrapped = intents.get(session.paymentIntentId);
              if (!wrapped) {
                throw new Error(`checkout session ${session.publicId} wraps an unreadable intent`);
              }
              return { session, intent: wrapped };
            }),
          };
        },
        serialize: ({ session, intent: wrapped }) => toCheckoutSessionDTO(session, wrapped),
      });
    }),
  );

  router.get(
    '/v1/checkout_sessions/:id',
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:read'),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      // `noUncheckedIndexedAccess` types `req.params.id` as possibly
      // `undefined` even though Express guarantees `:id` is present here. The
      // repositories take a `string`, so the guard is explicit rather than a
      // non-null assertion.
      const { id } = req.params;
      if (!id) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }
      const query = parseQuery(req, res, retrieveSessionQuery);
      if (!query) return;
      const expand = parseExpand(res, 'checkout_session', query.expand, { list: false });
      if (!expand) return;

      const db = getDb();
      const session = await findSessionForMerchant(db, id, merchant.id);
      if (!session) {
        sendError(res, 404, 'invalid_request_error', 'checkout session not found');
        return;
      }
      // By PRIMARY KEY, and deliberately unscoped: the session that names it
      // was already ownership-checked, so a second merchant predicate here
      // would be a second authority for a decision already made.
      const intent = await findIntentById(db, session.paymentIntentId);
      if (!intent) {
        sendError(res, 404, 'invalid_request_error', 'checkout session not found');
        return;
      }
      const dto = toCheckoutSessionDTO(session, intent);
      await expandObjects([dto], 'checkout_session', expand, merchant.id);
      res.status(200).json(dto);
    }),
  );

  /**
   * Update a session — `POST`, Stripe's verb. Only the merchant's `metadata`
   * is mutable: the amount, rail and seller are the wrapped payment's.
   */
  router.post(
    '/v1/checkout_sessions/:id',
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:write'),
    idempotent,
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const { id } = req.params;
      if (!id) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }
      const parsed = updateBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      const expand = parseExpand(res, 'checkout_session', parsed.data.expand, { list: false });
      if (!expand) return;

      const db = getDb();
      const session =
        parsed.data.metadata === undefined
          ? ((await findSessionForMerchant(db, id, merchant.id)) ?? 'missing')
          : await updateSessionMetadata(db, id, merchant.id, parsed.data.metadata);
      if (session === 'missing') {
        sendError(res, 404, 'invalid_request_error', 'checkout session not found');
        return;
      }
      if (session === 'limit_exceeded') {
        sendError(
          res,
          400,
          'invalid_request_error',
          METADATA_LIMIT_MESSAGE,
          'parameter_invalid',
          'metadata',
        );
        return;
      }
      const intent = await findIntentById(db, session.paymentIntentId);
      if (!intent) {
        throw new Error(`checkout session ${session.publicId} wraps an unreadable intent`);
      }
      const dto = toCheckoutSessionDTO(session, intent);
      await expandObjects([dto], 'checkout_session', expand, merchant.id);
      res.status(200).json(dto);
    }),
  );

  // Public payer path — UNAUTHENTICATED, rate-limited, authorized by
  // possession of the wrapped intent's `client_secret` (query param or
  // `X-Peable-Client-Secret` header — mirrors `GET /v1/payment_intents/:id`).
  // Never leaks `merchant`/`payment_intent` without a proven secret.
  router.get(
    '/v1/checkout_sessions/:id/public',
    publicRateLimit,
    wrap(async (req, res) => {
      // `noUncheckedIndexedAccess` types `req.params.id` as possibly
      // `undefined` even though Express guarantees `:id` is present here. The
      // repositories take a `string`, so the guard is explicit rather than a
      // non-null assertion.
      const { id } = req.params;
      if (!id) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }

      const db = getDb();
      const session = await findSessionByPublicId(db, id);
      if (!session) {
        sendError(res, 404, 'invalid_request_error', 'checkout session not found');
        return;
      }
      // Unscoped by primary key: this path proves its right to the row by
      // presenting the wrapped intent's `client_secret`, verified below.
      const intent = await findIntentById(db, session.paymentIntentId);
      if (!intent) {
        sendError(res, 404, 'invalid_request_error', 'checkout session not found');
        return;
      }

      const clientSecretParam = req.query.client_secret;
      const clientSecret =
        typeof clientSecretParam === 'string'
          ? clientSecretParam
          : req.header('X-Peable-Client-Secret');
      if (!clientSecret) {
        sendError(res, 401, 'authentication_error', 'missing client_secret');
        return;
      }
      if (!verifySecret(clientSecret, intent.clientSecret)) {
        sendError(res, 403, 'permission_error', 'invalid client_secret');
        return;
      }

      const merchant = await findMerchantById(db, session.merchantId);
      if (!merchant) {
        sendError(res, 404, 'invalid_request_error', 'checkout session not found');
        return;
      }
      const merchantDisplay = await resolveMerchantDisplay(merchant);
      const [billing] = await db
        .select({ fxQuote: faircoinBillingInvoices.fxQuote })
        .from(faircoinBillingInvoices)
        .where(eq(faircoinBillingInvoices.paymentIntentId, intent.id));
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        ...toCheckoutSessionPublicDTO(session, merchantDisplay, intent),
        ...(billing ? { billing_quote: billing.fxQuote } : {}),
      });
    }),
  );

  return router;
}
