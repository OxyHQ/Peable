import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { getRequiredOxyUserId, OXY_SERVICE_ENVIRONMENTS } from '@oxy.so/core/server';
import type { OxyServiceEnvironment } from '@oxy.so/core/server';
import type { DashboardAction } from '@peable.to/contracts/vocabulary';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { sendError, wrap } from '../lib/http';
import {
  type ApplicationAccess,
  authorizeApplication,
  type OxyAccess,
} from '../services/oxyAccess';
import type { FileActor } from '../services/oxyFiles/fileOwnership';
import { resolveMerchantByApp } from './paymentIntents';

/**
 * Every `/v1/dashboard/applications/:applicationId/*` route is scoped to one
 * `(applicationId, environment)` pair — the Test/Live toggle selects
 * `environment`, which decides which merchant (and therefore which payments,
 * webhooks, …) the request can see.
 */
const environmentQuerySchema = z.object({ environment: z.enum(OXY_SERVICE_ENVIRONMENTS) });

function resolveEnvironment(req: Request, res: Response): OxyServiceEnvironment | null {
  const parsed = environmentQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(
      res,
      400,
      'invalid_request_error',
      'a valid environment query parameter is required (development | staging | production)',
    );
    return null;
  }
  return parsed.data.environment;
}

export interface DashboardAccess {
  readonly applicationId: string;
  readonly environment: OxyServiceEnvironment;
  readonly userId: string;
  /** What oxy-api says the caller may do on the application. */
  readonly application: ApplicationAccess;
  /**
   * Who may own an Oxy file this caller makes the merchant's (an avatar, an
   * imported File): the application itself, the signed-in user, and the
   * account that owns the application.
   */
  readonly avatarActor: FileActor;
}

/**
 * The dashboard's whole gate: `?environment=`, then the caller's permission
 * for `action` on the application ({@link authorizeApplication}). Answers the
 * request and returns `null` on every refusal.
 */
export async function resolveDashboardAccess(
  req: Request,
  res: Response,
  action: DashboardAction,
  access: OxyAccess,
): Promise<DashboardAccess | null> {
  const environment = resolveEnvironment(req, res);
  if (!environment) return null;
  const { applicationId } = req.params;
  if (!applicationId) {
    sendError(res, 400, 'invalid_request_error', 'applicationId is required');
    return null;
  }
  const application = await authorizeApplication(req, res, applicationId, action, access);
  if (!application) return null;
  const userId = getRequiredOxyUserId(req);
  return {
    applicationId,
    environment,
    userId,
    application,
    avatarActor: { applicationId, accountIds: [userId, application.ownerAccountId] },
  };
}

export type DashboardCore = (
  req: Request,
  res: Response,
  merchant: MerchantRow,
  access: DashboardAccess,
) => Promise<void>;

/**
 * A dashboard handler: the gate for `action` (or the action a request names,
 * as an upload's purpose does), then the application's merchant in the
 * environment, then `core`.
 */
export type DashboardGate = (
  action: DashboardAction | ((req: Request) => DashboardAction),
  core: DashboardCore,
) => RequestHandler;

export function dashboardGate(access: OxyAccess): DashboardGate {
  return (action, core) =>
    wrap(async (req, res) => {
      const granted = await resolveDashboardAccess(
        req,
        res,
        typeof action === 'function' ? action(req) : action,
        access,
      );
      if (!granted) return;
      const merchant = await resolveMerchantByApp(granted.applicationId, granted.environment, res);
      if (!merchant) return;
      await core(req, res, merchant, granted);
    });
}
