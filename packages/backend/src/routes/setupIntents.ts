/**
 * SetupIntents (`seti_…`, ADR 0016, ADR 0019): create, retrieve (merchant, or
 * the payer with `client_secret`), list, cancel, and the payer's
 * `client_action` — the provider's confirmation credential for its own
 * Elements, read fresh and never stored or put on the DTO.
 */
import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import { verifySecret } from '@oxy.so/core/server';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import type { CreateSetupIntentParams } from '@peable.to/shared-types';
import { oxy } from '../oxy';
import { config } from '../config';
import { getDb } from '../db/postgres';
import { findLiveCustomerForMerchant } from '../db/customers/customerRepository';
import {
  findSetupIntentByPublicId,
  findSetupIntentForMerchant,
  listSetupIntentsForMerchant,
  type SetupIntentRow,
} from '../db/customers/setupIntentRepository';
import {
  SetupUnavailableError,
  cancelSetupIntent,
  createSetupIntent,
  reconcileSetupIntent,
  setupClientAction,
} from '../services/customers/setupIntentService';
import { CustomersUnavailableError } from '../services/customers/providerCustomer';
import { ProviderError, providerModeOf } from '../services/providers/provider';
import { redactProviderMessage } from '../services/providers/redact';
import { toSetupIntentDTO } from '../lib/serialize';
import {
  requireAuthenticated,
  sendError,
  sendProviderError,
  sendValidationError,
  wrap,
} from '../lib/http';
import { idempotent } from '../lib/idempotency';
import { expandObjects, parseExpand } from '../lib/expand';
import {
  answerList,
  expandParam,
  listQuerySchema,
  parseQuery,
  resolveListReference,
  retrieveQuerySchema,
} from '../lib/list';
import { metadataCreateSchema } from '../lib/metadata';
import { resolveMerchant } from './paymentIntents';

const createBodySchema = z
  .object({
    customer: z.string().min(1).max(255).optional(),
    usage: z.enum(['on_session', 'off_session']).optional(),
    payment_method_types: z.tuple([z.literal('card')]).optional(),
    description: z.string().max(1000).optional(),
    metadata: metadataCreateSchema.optional(),
    expand: expandParam.optional(),
  } satisfies Record<keyof CreateSetupIntentParams | 'expand', z.ZodType>)
  .strict();

const cancelBodySchema = z
  .object({
    cancellation_reason: z.enum(['abandoned', 'duplicate', 'requested_by_customer']).optional(),
    expand: expandParam.optional(),
  })
  .strict();

const listSetupIntentsQuery = listQuerySchema({
  customer: z.string().min(1).max(255).optional(),
});
const retrieveQuery = retrieveQuerySchema({});

/** The payer's capability token, from the query or the header — as on payment intents. */
function readClientSecret(req: Request): string | undefined {
  const fromQuery = req.query.client_secret;
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;
  return req.header('X-Peable-Client-Secret') ?? undefined;
}

function sendSetupFailure(res: Parameters<typeof sendError>[0], error: unknown): boolean {
  if (error instanceof SetupUnavailableError || error instanceof CustomersUnavailableError) {
    sendError(res, 503, 'api_error', error.message);
    return true;
  }
  if (error instanceof ProviderError) {
    sendProviderError(res, error);
    return true;
  }
  return false;
}

export function createSetupIntentsRouter(deps: {
  requireMerchant: RequestHandler;
  optionalServiceAuth: RequestHandler;
}): Router {
  const router = Router();
  const { requireMerchant, optionalServiceAuth } = deps;

  router.post(
    '/v1/setup_intents',
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:write'),
    idempotent,
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const parsed = createBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      const body = parsed.data;
      const expand = parseExpand(res, 'setup_intent', body.expand, { list: false });
      if (!expand) return;
      // A `pm_…` is born attached, so a card is always saved TO someone.
      if (body.customer === undefined) {
        sendError(
          res,
          400,
          'invalid_request_error',
          'a setup intent saves a card to a customer; pass customer',
          'parameter_missing',
          'customer',
        );
        return;
      }
      const customer = await findLiveCustomerForMerchant(getDb(), body.customer, merchant.id);
      if (!customer) {
        sendError(
          res,
          400,
          'invalid_request_error',
          `no such customer: '${body.customer}'`,
          'resource_missing',
          'customer',
        );
        return;
      }
      try {
        const { row } = await createSetupIntent(merchant, customer, {
          usage: body.usage ?? 'off_session',
          description: body.description ?? null,
          metadata: body.metadata ?? {},
        });
        const dto = toSetupIntentDTO(row);
        await expandObjects([dto], 'setup_intent', expand, merchant.id);
        res.status(201).json(dto);
      } catch (error) {
        if (sendSetupFailure(res, error)) return;
        throw error;
      }
    }),
  );

  router.get(
    '/v1/setup_intents',
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:read'),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const query = parseQuery(req, res, listSetupIntentsQuery);
      if (!query) return;
      const db = getDb();
      const customer = await resolveListReference(
        res,
        'customer',
        query.customer,
        async (publicId) =>
          (await findLiveCustomerForMerchant(db, publicId, merchant.id))?.id ?? null,
      );
      if (!customer.ok) return;
      await answerList(req, res, {
        query,
        type: 'setup_intent',
        merchantId: merchant.id,
        cursor: async (publicId) =>
          (await findSetupIntentForMerchant(db, publicId, merchant.id))?.id ?? null,
        fetch: (page) =>
          listSetupIntentsForMerchant(db, {
            merchantId: merchant.id,
            customerId: customer.id,
            page,
          }),
        serialize: toSetupIntentDTO,
      });
    }),
  );

  /**
   * Retrieve — the merchant (service credential, reconciled with the provider
   * when not terminal) or the payer (`client_secret`, the row as stored).
   */
  router.get(
    '/v1/setup_intents/:id',
    optionalServiceAuth,
    wrap(async (req, res) => {
      const { id } = req.params;
      if (!id) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }
      const { serviceApp } = req as OxyAuthRequest;
      if (serviceApp?.appId) {
        let scopeGranted = false;
        oxy.middleware.requireScope('payments:read')(req, res, () => {
          scopeGranted = true;
        });
        if (!scopeGranted) return;
        const merchant = await resolveMerchant(req, res);
        if (!merchant) return;
        const query = parseQuery(req, res, retrieveQuery);
        if (!query) return;
        const expand = parseExpand(res, 'setup_intent', query.expand, { list: false });
        if (!expand) return;
        const found = await findSetupIntentForMerchant(getDb(), id, merchant.id);
        if (!found) {
          sendError(res, 404, 'invalid_request_error', 'setup intent not found');
          return;
        }
        const row = await reconcileSetupIntent(found);
        const dto = toSetupIntentDTO(row);
        await expandObjects([dto], 'setup_intent', expand, merchant.id);
        res.status(200).json(dto);
        return;
      }
      if (req.query.expand !== undefined) {
        sendError(
          res,
          400,
          'invalid_request_error',
          'expand requires the merchant credential',
          'parameter_invalid',
          'expand',
        );
        return;
      }
      const clientSecret = readClientSecret(req);
      if (!clientSecret) {
        sendError(
          res,
          401,
          'authentication_error',
          'missing service app credentials or client_secret',
        );
        return;
      }
      const row = await findSetupIntentByPublicId(getDb(), id);
      if (!row) {
        sendError(res, 404, 'invalid_request_error', 'setup intent not found');
        return;
      }
      if (!verifySecret(clientSecret, row.clientSecret)) {
        sendError(res, 403, 'permission_error', 'invalid client_secret');
        return;
      }
      res.status(200).json(toSetupIntentDTO(row));
    }),
  );

  router.post(
    '/v1/setup_intents/:id/cancel',
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
      const parsed = cancelBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      const expand = parseExpand(res, 'setup_intent', parsed.data.expand, { list: false });
      if (!expand) return;
      const row = await findSetupIntentForMerchant(getDb(), id, merchant.id);
      if (!row) {
        sendError(res, 404, 'invalid_request_error', 'setup intent not found');
        return;
      }
      try {
        const outcome = await cancelSetupIntent(row, parsed.data.cancellation_reason);
        if (outcome.kind === 'unexpected_state') {
          sendError(
            res,
            400,
            'invalid_request_error',
            `this setup intent is '${row.status}' and cannot be canceled`,
            'setup_intent_unexpected_state',
          );
          return;
        }
        if (outcome.kind === 'irreconcilable') {
          sendError(res, 409, 'invalid_request_error', redactProviderMessage(outcome.error));
          return;
        }
        const dto = toSetupIntentDTO(outcome.row);
        await expandObjects([dto], 'setup_intent', expand, merchant.id);
        res.status(200).json(dto);
      } catch (error) {
        if (sendSetupFailure(res, error)) return;
        throw error;
      }
    }),
  );

  /**
   * What the payer's client needs to confirm the SetupIntent with the
   * provider's Elements — read fresh, `Cache-Control: no-store`, never on the
   * DTO. The merchant (service credential) or the payer (`client_secret`).
   */
  router.post(
    '/v1/setup_intents/:id/client_action',
    optionalServiceAuth,
    wrap(async (req, res) => {
      const { id } = req.params;
      if (!id) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }
      const { serviceApp } = req as OxyAuthRequest;
      let row: SetupIntentRow | null;
      if (serviceApp?.appId) {
        let scopeGranted = false;
        oxy.middleware.requireScope('payments:read')(req, res, () => {
          scopeGranted = true;
        });
        if (!scopeGranted) return;
        const merchant = await resolveMerchant(req, res);
        if (!merchant) return;
        row = await findSetupIntentForMerchant(getDb(), id, merchant.id);
      } else {
        const clientSecret = readClientSecret(req);
        if (!clientSecret) {
          sendError(
            res,
            401,
            'authentication_error',
            'missing service app credentials or client_secret',
          );
          return;
        }
        row = await findSetupIntentByPublicId(getDb(), id);
        if (row && !verifySecret(clientSecret, row.clientSecret)) {
          sendError(res, 403, 'permission_error', 'invalid client_secret');
          return;
        }
      }
      if (!row) {
        sendError(res, 404, 'invalid_request_error', 'setup intent not found');
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      if (row.status === 'succeeded' || row.status === 'canceled') {
        sendError(
          res,
          409,
          'invalid_request_error',
          `this setup intent is '${row.status}' and needs no further action`,
        );
        return;
      }
      try {
        const action = await setupClientAction(row);
        if (!action) {
          sendError(res, 503, 'api_error', 'the provider offered no way to confirm this setup');
          return;
        }
        const publishableKey = config.stripe[providerModeOf(row.livemode)]?.publishableKey;
        res.status(200).json({
          object: 'client_action',
          kind: action.kind,
          value: action.value,
          ...(publishableKey === undefined ? {} : { publishable_key: publishableKey }),
        });
      } catch (error) {
        if (sendSetupFailure(res, error)) return;
        throw error;
      }
    }),
  );

  return router;
}
