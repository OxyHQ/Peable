/**
 * Payment method breadth: `/v1/payment_method_configurations` (`pmc_…`) and
 * `/v1/payment_method_domains` (`pmd_…`). Cores shared with the dashboard
 * (`routes/dashboard.ts`); `services/paymentMethods/*` hold the rules.
 */
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';
import {
  createPaymentMethodConfigurationParams,
  createPaymentMethodDomainParams,
  expandOnlyQuery,
  listPaymentMethodConfigurationsQuery,
  listPaymentMethodDomainsQuery,
  type paymentMethodConfigurationEntryParams,
  updatePaymentMethodConfigurationParams,
  updatePaymentMethodDomainParams,
  validatePaymentMethodDomainParams,
} from '@peable.to/contracts';
import {
  PAYMENT_METHOD_CONFIGURATION_TYPES,
  type PaymentMethodConfigurationType,
} from '@peable.to/shared-types';
import { getDb } from '../db/postgres';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import {
  type ChoosablePaymentMethodType,
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
import {
  faircoinWalletOf,
  toPaymentMethodConfigurationDTO,
} from '../services/paymentMethods/configuration';
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
  requireScope,
} from '../lib/http';
import { idempotent } from '../lib/idempotency';
import { answerList, dashboardQuery, parseQuery, type QuerySurface } from '../lib/list';
import { resolveMerchant } from './paymentIntents';

// The contract's schemas (`@peable.to/contracts` `paymentMethodConfigurationRoutes`);
// the dashboard's twin of each query adds its environment.
const listConfigurationsQuery = {
  api: listPaymentMethodConfigurationsQuery,
  dashboard: dashboardQuery(listPaymentMethodConfigurationsQuery),
} as const;
const retrieveQuery = { api: expandOnlyQuery, dashboard: dashboardQuery(expandOnlyQuery) };
const listDomainsQuery = {
  api: listPaymentMethodDomainsQuery,
  dashboard: dashboardQuery(listPaymentMethodDomainsQuery),
} as const;

type EntryParams = z.output<typeof paymentMethodConfigurationEntryParams>;

function idParam(req: Request, res: Response): string | null {
  const { id } = req.params;
  if (!id) {
    sendError(res, 400, 'invalid_request_error', 'id is required');
    return null;
  }
  return id;
}

/**
 * Split a body's method settings into choices and resets, refusing what cannot
 * be on — and FairCoin off: it is locked on (ADR 0021 D2), so `off` is a 400
 * `payment_method_locked` and `on`/`none` are accepted and store nothing.
 */
function preferencesOf(
  res: Response,
  body: Partial<Record<PaymentMethodConfigurationType, EntryParams | undefined>>,
): { set: PaymentMethodPreferences; reset: ChoosablePaymentMethodType[] } | null {
  const set: PaymentMethodPreferences = {};
  const reset: ChoosablePaymentMethodType[] = [];
  for (const type of PAYMENT_METHOD_CONFIGURATION_TYPES) {
    const entry = body[type];
    if (entry === undefined) continue;
    const preference = entry.display_preference.preference;
    if (type === 'faircoin') {
      if (preference === 'off') {
        sendError(
          res,
          400,
          'invalid_request_error',
          'FairCoin is always offered to every payer and cannot be turned off',
          'payment_method_locked',
          'faircoin',
        );
        return null;
      }
      continue;
    }
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
  const wallet = await faircoinWalletOf(merchant);
  await answerList(req, res, {
    query,
    type: 'payment_method_configuration',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findConfigurationByPublicId(db, merchant.id, publicId))?.id ?? null,
    fetch: (page) => listConfigurationsForMerchant(db, { merchantId: merchant.id, page }),
    serialize: (row) => toPaymentMethodConfigurationDTO(row, wallet),
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
  res.status(200).json(toPaymentMethodConfigurationDTO(row, await faircoinWalletOf(merchant)));
}

/** `POST /v1/payment_method_configurations` — an additional, non-default configuration. */
export async function createConfiguration(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = createPaymentMethodConfigurationParams.safeParse(req.body ?? {});
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
  res.status(200).json(toPaymentMethodConfigurationDTO(row, await faircoinWalletOf(merchant)));
}

/** `POST /v1/payment_method_configurations/:id` — methods (merged), name, active. */
export async function updateConfigurationCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = updatePaymentMethodConfigurationParams.safeParse(req.body ?? {});
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
  res
    .status(200)
    .json(toPaymentMethodConfigurationDTO(updated ?? row, await faircoinWalletOf(merchant)));
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
        enabled: query.enabled,
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
  const parsed = createPaymentMethodDomainParams.safeParse(req.body ?? {});
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
  const parsed = updatePaymentMethodDomainParams.safeParse(req.body ?? {});
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
  const parsed = validatePaymentMethodDomainParams.safeParse(req.body ?? {});
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
  const read = [requireMerchant, requireAuthenticated, requireScope('payments:read')];
  const write = [requireMerchant, requireAuthenticated, requireScope('payments:write')];
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
