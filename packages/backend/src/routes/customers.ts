/**
 * Customers (`cus_…`, ADR 0016) — Stripe's surface: create, retrieve, update,
 * delete, list (`email=` exact). A deleted customer is a tombstone that still
 * retrieves, as `{id, object: 'customer', deleted: true}`.
 */
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { CreateCustomerParams } from '@peable.to/shared-types';
import { oxy } from '../oxy';
import { getDb } from '../db/postgres';
import {
  findCustomerForMerchant,
  listCustomersForMerchant,
  type CustomerFields,
} from '../db/customers/customerRepository';
import {
  CustomerParameterError,
  createCustomer,
  deleteCustomer,
  updateCustomerFields,
} from '../services/customers/customerService';
import { toCustomerDTO, toDeletedCustomerDTO } from '../lib/serialize';
import {
  addressSchema,
  emailSchema,
  shippingSchema,
  toAddress,
  toShipping,
} from '../lib/addressSchema';
import { requireAuthenticated, sendError, sendValidationError, wrap } from '../lib/http';
import { idempotent } from '../lib/idempotency';
import { expandObjects, parseExpand } from '../lib/expand';
import {
  answerList,
  expandParam,
  listQuerySchema,
  parseQuery,
  retrieveQuerySchema,
} from '../lib/list';
import {
  METADATA_LIMIT_MESSAGE,
  metadataCreateSchema,
  metadataUpdateSchema,
} from '../lib/metadata';
import { resolveMerchant } from './paymentIntents';

/** `""` clears a field on an update, Stripe's rule. */
const clearable = <T extends z.ZodType>(schema: T) => z.union([schema, z.literal('')]);

const name = z.string().max(500);
const phone = z.string().max(40);
const description = z.string().max(1000);

const createBodySchema = z
  .object({
    email: emailSchema.optional(),
    name: name.optional(),
    phone: phone.optional(),
    description: description.optional(),
    address: addressSchema.optional(),
    shipping: shippingSchema.optional(),
    invoice_settings: z
      .object({ default_payment_method: z.string().min(1).max(255).optional() })
      .strict()
      .optional(),
    metadata: metadataCreateSchema.optional(),
    expand: expandParam.optional(),
  } satisfies Record<keyof CreateCustomerParams | 'expand', z.ZodType>)
  .strict();

const updateBodySchema = z
  .object({
    email: clearable(emailSchema).optional(),
    name: clearable(name).optional(),
    phone: clearable(phone).optional(),
    description: clearable(description).optional(),
    address: clearable(addressSchema).optional(),
    shipping: clearable(shippingSchema).optional(),
    invoice_settings: z
      .object({ default_payment_method: clearable(z.string().min(1).max(255)).optional() })
      .strict()
      .optional(),
    metadata: metadataUpdateSchema.optional(),
    expand: expandParam.optional(),
  })
  .strict();

const listCustomersQuery = listQuerySchema({ email: z.string().min(1).max(512).optional() });
const retrieveCustomerQuery = retrieveQuerySchema({});

function clear<T>(value: T | '' | undefined): T | null | undefined {
  if (value === undefined) return undefined;
  return value === '' ? null : value;
}

export function createCustomersRouter(deps: { requireMerchant: RequestHandler }): Router {
  const router = Router();
  const { requireMerchant } = deps;

  router.post(
    '/v1/customers',
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
      const expand = parseExpand(res, 'customer', body.expand, { list: false });
      if (!expand) return;
      // A new customer has no payment methods, so none can be its default:
      // a `pm_…` is born attached by a SetupIntent on an EXISTING customer.
      if (body.invoice_settings?.default_payment_method !== undefined) {
        sendError(
          res,
          400,
          'invalid_request_error',
          'a new customer has no attached payment method to make its default',
          'parameter_invalid',
          'invoice_settings[default_payment_method]',
        );
        return;
      }
      const fields: CustomerFields = {
        ...(body.email !== undefined ? { email: body.email } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.phone !== undefined ? { phone: body.phone } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.address !== undefined ? { address: toAddress(body.address) } : {}),
        ...(body.shipping !== undefined ? { shipping: toShipping(body.shipping) } : {}),
      };
      const customer = await createCustomer(merchant, { ...fields, metadata: body.metadata ?? {} });
      const dto = toCustomerDTO(customer);
      await expandObjects([dto], 'customer', expand, merchant.id);
      res.status(201).json(dto);
    }),
  );

  router.get(
    '/v1/customers',
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:read'),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const query = parseQuery(req, res, listCustomersQuery);
      if (!query) return;
      const db = getDb();
      await answerList(req, res, {
        query,
        type: 'customer',
        merchantId: merchant.id,
        cursor: async (publicId) => {
          const row = await findCustomerForMerchant(db, publicId, merchant.id);
          return row && row.deletedAt === null ? row.id : null;
        },
        fetch: (page) =>
          listCustomersForMerchant(db, { merchantId: merchant.id, email: query.email, page }),
        serialize: toCustomerDTO,
      });
    }),
  );

  router.get(
    '/v1/customers/:id',
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:read'),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const { id } = req.params;
      if (!id) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }
      const query = parseQuery(req, res, retrieveCustomerQuery);
      if (!query) return;
      const expand = parseExpand(res, 'customer', query.expand, { list: false });
      if (!expand) return;
      const customer = await findCustomerForMerchant(getDb(), id, merchant.id);
      if (!customer) {
        sendError(res, 404, 'invalid_request_error', 'customer not found');
        return;
      }
      if (customer.deletedAt !== null) {
        res.status(200).json(toDeletedCustomerDTO(customer));
        return;
      }
      const dto = toCustomerDTO(customer);
      await expandObjects([dto], 'customer', expand, merchant.id);
      res.status(200).json(dto);
    }),
  );

  router.post(
    '/v1/customers/:id',
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
      const body = parsed.data;
      const expand = parseExpand(res, 'customer', body.expand, { list: false });
      if (!expand) return;
      const customer = await findCustomerForMerchant(getDb(), id, merchant.id);
      if (!customer || customer.deletedAt !== null) {
        sendError(res, 404, 'invalid_request_error', 'customer not found');
        return;
      }
      const address = clear(body.address);
      const shipping = clear(body.shipping);
      try {
        const result = await updateCustomerFields(merchant, customer, {
          email: clear(body.email),
          name: clear(body.name),
          phone: clear(body.phone),
          description: clear(body.description),
          address: address === undefined || address === null ? address : toAddress(address),
          shipping: shipping === undefined || shipping === null ? shipping : toShipping(shipping),
          metadata: body.metadata,
          defaultPaymentMethod: clear(body.invoice_settings?.default_payment_method),
        });
        if (result === 'missing') {
          sendError(res, 404, 'invalid_request_error', 'customer not found');
          return;
        }
        if (result === 'limit_exceeded') {
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
        const dto = toCustomerDTO(result);
        await expandObjects([dto], 'customer', expand, merchant.id);
        res.status(200).json(dto);
      } catch (error) {
        if (error instanceof CustomerParameterError) {
          sendError(res, 400, 'invalid_request_error', error.message, error.code, error.param);
          return;
        }
        throw error;
      }
    }),
  );

  /**
   * Delete — a tombstone, its payment methods detached. Idempotent by nature:
   * deleting a deleted customer answers the tombstone again.
   */
  router.delete(
    '/v1/customers/:id',
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:write'),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const { id } = req.params;
      if (!id) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }
      const deleted = await deleteCustomer(merchant, id);
      if (deleted) {
        res.status(200).json(toDeletedCustomerDTO(deleted));
        return;
      }
      const existing = await findCustomerForMerchant(getDb(), id, merchant.id);
      if (existing && existing.deletedAt !== null) {
        res.status(200).json(toDeletedCustomerDTO(existing));
        return;
      }
      sendError(res, 404, 'invalid_request_error', 'customer not found');
    }),
  );

  return router;
}
