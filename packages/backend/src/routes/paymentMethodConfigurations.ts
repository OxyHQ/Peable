/**
 * Payment method breadth: `/v1/payment_method_configurations` (`pmc_…`) and
 * `/v1/payment_method_domains` (`pmd_…`). Cores shared with the dashboard
 * (`routes/dashboard.ts`); `services/paymentMethods/*` hold the rules.
 */
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import {
  PAYMENT_METHOD_CONFIGURATION_TYPES,
  type PaymentMethodConfigurationType,
} from '@peable.to/shared-types';
import { oxy } from '../oxy';
import { getDb } from '../db/postgres';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import {
  clearConfigurationPreferences,
  ensureDefaultConfiguration,
  findConfigurationById,
  findConfigurationByPublicId,
  findDomainByPublicId,
  insertConfiguration,
  listConfigurationsForMerchant,
  listDomainsForMerchant,
  updateConfiguration,
  type PaymentMethodConfigurationRow,
  type PaymentMethodPreferences,
} from '../db/paymentMethods/paymentMethodConfigurationRepository';
import { toPaymentMethodConfigurationDTO } from '../services/paymentMethods/configuration';
import {
  createPaymentMethodDomain,
  DomainParameterError,
  DomainsUnavailableError,
  DomainTakenError,
  setPaymentMethodDomainEnabled,
  toPaymentMethodDomainDTO,
  validatePaymentMethodDomain,
} from '../services/paymentMethods/domains';
import { PROVIDER_PAYMENT_METHODS, ProviderError } from '../services/providers/provider';
import {
  requireAuthenticated,
  sendError,
  sendProviderError,
  sendValidationError,
  wrap,
} from '../lib/http';
import { idempotent } from '../lib/idempotency';
import {
  answerList,
  parseQuery,
  type QuerySurface,
  surfaceListQuery,
  surfaceRetrieveQuery,
} from '../lib/list';
import { resolveMerchant } from './paymentIntents';

const listConfigurationsQuery = surfaceListQuery({});
const retrieveQuery = surfaceRetrieveQuery();
const listDomainsQuery = surfaceListQuery({
  domain_name: z.string().min(1).max(253).optional(),
  enabled: z.enum(['true', 'false']).optional(),
});

const entryParam = z
  .object({
    display_preference: z.object({ preference: z.enum(['on', 'off', 'none']) }).strict(),
  })
  .strict();

const methodFields = Object.fromEntries(
  PAYMENT_METHOD_CONFIGURATION_TYPES.map((type) => [type, entryParam.optional()]),
) as Record<PaymentMethodConfigurationType, z.ZodOptional<typeof entryParam>>;

const createConfigurationBody = z
  .object({ name: z.string().min(1).max(100).optional(), ...methodFields })
  .strict();
const updateConfigurationBody = z
  .object({
    name: z.string().min(1).max(100).optional(),
    active: z.boolean().optional(),
    ...methodFields,
  })
  .strict();

const createDomainBody = z
  .object({ domain_name: z.string().min(1).max(300), enabled: z.boolean().optional() })
  .strict();
const updateDomainBody = z.object({ enabled: z.boolean().optional() }).strict();

function idParam(req: Request, res: Response): string | null {
  const { id } = req.params;
  if (!id) {
    sendError(res, 400, 'invalid_request_error', 'id is required');
    return null;
  }
  return id;
}

/** Split a body's method settings into choices and resets, refusing what cannot be on. */
function preferencesOf(
  res: Response,
  body: Partial<Record<PaymentMethodConfigurationType, z.infer<typeof entryParam>>>,
): { set: PaymentMethodPreferences; reset: PaymentMethodConfigurationType[] } | null {
  const set: PaymentMethodPreferences = {};
  const reset: PaymentMethodConfigurationType[] = [];
  for (const type of PAYMENT_METHOD_CONFIGURATION_TYPES) {
    const entry = body[type];
    if (entry === undefined) continue;
    const preference = entry.display_preference.preference;
    if (preference === 'on' && !PROVIDER_PAYMENT_METHODS.stripe.includes(type)) {
      // Truthful: a toggle that can never take effect is refused, not stored.
      sendError(
        res,
        400,
        'invalid_request_error',
        `${type} is not offered by the processing provider and cannot be turned on`,
        'parameter_invalid',
        type,
      );
      return null;
    }
    if (preference === 'none') reset.push(type);
    else set[type] = preference;
  }
  return { set, reset };
}

/** `GET /v1/payment_method_configurations` — the default is created on first read. */
export async function answerConfigurationList(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface = 'api',
): Promise<void> {
  const query = parseQuery(req, res, listConfigurationsQuery[surface]);
  if (!query) return;
  const db = getDb();
  await ensureDefaultConfiguration(db, merchant.id);
  await answerList(req, res, {
    query,
    type: 'payment_method_configuration',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findConfigurationByPublicId(db, merchant.id, publicId))?.id ?? null,
    fetch: (page) => listConfigurationsForMerchant(db, { merchantId: merchant.id, page }),
    serialize: toPaymentMethodConfigurationDTO,
  });
}

async function loadConfiguration(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<PaymentMethodConfigurationRow | null> {
  const id = idParam(req, res);
  if (!id) return null;
  const row = await findConfigurationByPublicId(getDb(), merchant.id, id);
  if (!row) {
    sendError(
      res,
      404,
      'invalid_request_error',
      'payment method configuration not found',
      'resource_missing',
      'id',
    );
  }
  return row;
}

export async function retrieveConfiguration(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface = 'api',
): Promise<void> {
  if (!parseQuery(req, res, retrieveQuery[surface])) return;
  const row = await loadConfiguration(req, res, merchant);
  if (!row) return;
  res.status(200).json(toPaymentMethodConfigurationDTO(row));
}

/** `POST /v1/payment_method_configurations` — an additional, non-default configuration. */
export async function createConfiguration(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = createConfigurationBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const prefs = preferencesOf(res, parsed.data);
  if (!prefs) return;
  const db = getDb();
  await ensureDefaultConfiguration(db, merchant.id);
  const row = await insertConfiguration(db, {
    merchantId: merchant.id,
    name: parsed.data.name ?? 'Configuration',
    preferences: prefs.set,
  });
  res.status(200).json(toPaymentMethodConfigurationDTO(row));
}

/** `POST /v1/payment_method_configurations/:id` — methods (merged), name, active. */
export async function updateConfigurationCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = updateConfigurationBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const row = await loadConfiguration(req, res, merchant);
  if (!row) return;
  if (row.isDefault && parsed.data.active === false) {
    sendError(
      res,
      400,
      'invalid_request_error',
      'the default configuration is always active',
      'parameter_invalid',
      'active',
    );
    return;
  }
  const prefs = preferencesOf(res, parsed.data);
  if (!prefs) return;
  const db = getDb();
  const updated = await db.transaction(async (tx) => {
    await clearConfigurationPreferences(tx, row.id, prefs.reset);
    await updateConfiguration(tx, row.id, {
      name: parsed.data.name,
      active: parsed.data.active,
      preferences: Object.keys(prefs.set).length > 0 ? prefs.set : undefined,
    });
    return findConfigurationById(tx, row.id);
  });
  res.status(200).json(toPaymentMethodConfigurationDTO(updated ?? row));
}

function sendDomainError(res: Response, error: unknown): void {
  if (error instanceof DomainParameterError) {
    sendError(res, 400, 'invalid_request_error', error.message, 'parameter_invalid', 'domain_name');
    return;
  }
  if (error instanceof DomainTakenError) {
    sendError(res, 409, 'invalid_request_error', error.message, 'domain_taken', 'domain_name');
    return;
  }
  if (error instanceof DomainsUnavailableError) {
    sendError(res, 503, 'api_error', error.message);
    return;
  }
  if (error instanceof ProviderError) {
    sendProviderError(res, error);
    return;
  }
  throw error;
}

export async function answerDomainList(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface = 'api',
): Promise<void> {
  const query = parseQuery(req, res, listDomainsQuery[surface]);
  if (!query) return;
  const db = getDb();
  await answerList(req, res, {
    query,
    type: 'payment_method_domain',
    merchantId: merchant.id,
    cursor: async (publicId) => (await findDomainByPublicId(db, merchant.id, publicId))?.id ?? null,
    fetch: (page) =>
      listDomainsForMerchant(db, {
        merchantId: merchant.id,
        domainName: query.domain_name?.toLowerCase(),
        enabled: query.enabled === undefined ? undefined : query.enabled === 'true',
        page,
      }),
    serialize: toPaymentMethodDomainDTO,
  });
}

async function loadDomain(req: Request, res: Response, merchant: MerchantRow) {
  const id = idParam(req, res);
  if (!id) return null;
  const row = await findDomainByPublicId(getDb(), merchant.id, id);
  if (!row) {
    sendError(
      res,
      404,
      'invalid_request_error',
      'payment method domain not found',
      'resource_missing',
      'id',
    );
  }
  return row;
}

export async function retrieveDomain(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface = 'api',
): Promise<void> {
  if (!parseQuery(req, res, retrieveQuery[surface])) return;
  const row = await loadDomain(req, res, merchant);
  if (!row) return;
  res.status(200).json(toPaymentMethodDomainDTO(row));
}

export async function createDomain(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = createDomainBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  try {
    const { domain } = await createPaymentMethodDomain(merchant, {
      domainName: parsed.data.domain_name,
      enabled: parsed.data.enabled ?? true,
    });
    res.status(200).json(toPaymentMethodDomainDTO(domain));
  } catch (error) {
    sendDomainError(res, error);
  }
}

export async function updateDomain(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = updateDomainBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const row = await loadDomain(req, res, merchant);
  if (!row) return;
  try {
    const updated =
      parsed.data.enabled === undefined || parsed.data.enabled === row.enabled
        ? row
        : await setPaymentMethodDomainEnabled(row, parsed.data.enabled);
    res.status(200).json(toPaymentMethodDomainDTO(updated));
  } catch (error) {
    sendDomainError(res, error);
  }
}

export async function validateDomain(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = z
    .object({})
    .strict()
    .safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const row = await loadDomain(req, res, merchant);
  if (!row) return;
  try {
    res.status(200).json(toPaymentMethodDomainDTO(await validatePaymentMethodDomain(row)));
  } catch (error) {
    sendDomainError(res, error);
  }
}

export function createPaymentMethodConfigurationsRouter(deps: {
  requireMerchant: RequestHandler;
}): Router {
  const router = Router();
  const { requireMerchant } = deps;
  const read = [
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:read'),
  ];
  const write = [
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:write'),
  ];
  const withMerchant = (
    handler: (req: Request, res: Response, merchant: MerchantRow) => Promise<void>,
  ) =>
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      await handler(req, res, merchant);
    });

  const pmc = '/v1/payment_method_configurations';
  router.get(pmc, ...read, withMerchant(answerConfigurationList));
  router.post(pmc, ...write, idempotent, withMerchant(createConfiguration));
  router.get(`${pmc}/:id`, ...read, withMerchant(retrieveConfiguration));
  router.post(`${pmc}/:id`, ...write, idempotent, withMerchant(updateConfigurationCore));

  const pmd = '/v1/payment_method_domains';
  router.get(pmd, ...read, withMerchant(answerDomainList));
  router.post(pmd, ...write, idempotent, withMerchant(createDomain));
  router.get(`${pmd}/:id`, ...read, withMerchant(retrieveDomain));
  router.post(`${pmd}/:id`, ...write, idempotent, withMerchant(updateDomain));
  router.post(`${pmd}/:id/validate`, ...write, idempotent, withMerchant(validateDomain));
  return router;
}
