/**
 * A merchant's branding and customer-email settings (Orbit Phase 3):
 * `GET|POST /v1/merchants/me/branding`, `GET|POST /v1/merchants/me/email_settings`,
 * and Orbit's dashboard twins (`routes/dashboard.ts`) — the same cores.
 *
 * Every branding value is a closed set or a validated colour. The icon is the
 * merchant's avatar and the logo its `business_logo` File: both live on the
 * merchant and are written through the ONE merchant writer
 * (`applyMerchantPatch`), so their ownership checks and Oxy references are the
 * merchant's, never a second copy here.
 */
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { BRANDING_BORDER_STYLES, BRANDING_FONTS } from '@peable.to/shared-types';
import {
  findBranding,
  findEmailSettings,
  upsertBranding,
  upsertEmailSettings,
} from '../db/merchants/brandingRepository';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { getDb } from '../db/postgres';
import { requireAuthenticated, sendValidationError, wrap } from '../lib/http';
import { idempotent } from '../lib/idempotency';
import { toMerchantBrandingDTO, toMerchantEmailSettingsDTO } from '../lib/serializeCheckout';
import { oxy } from '../oxy';
import { type OxyFilesClient, oxyFilesClient } from '../services/oxyFiles/client';
import {
  type AvatarAuthority,
  applyMerchantPatch,
  sendMerchantWriteError,
  serviceFileActor,
} from './merchants';
import { resolveMerchant } from './paymentIntents';

/** `#rgb` or `#rrggbb`, any case — stored as lowercase `#rrggbb`. */
const colorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'must be a #rrggbb colour')
  .transform((value) => {
    const hex = value.slice(1).toLowerCase();
    return `#${hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex}`;
  });

const httpsUrl = z
  .string()
  .max(2048)
  .regex(/^https:\/\/\S+$/, 'must be an https URL');

export const updateBrandingBodySchema = z
  .object({
    use_avatar_as_icon: z.boolean().optional(),
    /** A `file_…` of purpose `business_logo`, or `null` — the merchant's `business_logo`. */
    logo: z.string().min(1).max(255).nullable().optional(),
    primary_color: colorSchema.nullable().optional(),
    accent_color: colorSchema.nullable().optional(),
    font: z.enum(BRANDING_FONTS).nullable().optional(),
    border_style: z.enum(BRANDING_BORDER_STYLES).nullable().optional(),
    terms_of_service_url: httpsUrl.nullable().optional(),
  })
  .strict();

export const updateEmailSettingsBodySchema = z
  .object({
    payment_receipts: z.boolean().optional(),
    refund_notices: z.boolean().optional(),
    checkout_confirmations: z.boolean().optional(),
    support_email: z
      .string()
      .trim()
      .max(254)
      .email('must be an email address')
      .nullable()
      .optional(),
  })
  .strict();

export async function answerBranding(res: Response, merchant: MerchantRow): Promise<void> {
  res.status(200).json(toMerchantBrandingDTO(merchant, await findBranding(getDb(), merchant.id)));
}

export async function updateBrandingCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  authority: AvatarAuthority,
): Promise<void> {
  const parsed = updateBrandingBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const body = parsed.data;
  let current = merchant;
  if (body.logo !== undefined) {
    const result = await applyMerchantPatch(merchant, { business_logo: body.logo }, authority);
    if (!result.ok) {
      sendMerchantWriteError(res, result);
      return;
    }
    current = result.merchant;
  }
  const row = await upsertBranding(getDb(), merchant.id, {
    useAvatarAsIcon: body.use_avatar_as_icon,
    primaryColor: body.primary_color,
    accentColor: body.accent_color,
    font: body.font,
    borderStyle: body.border_style,
    termsOfServiceUrl: body.terms_of_service_url,
  });
  res.status(200).json(toMerchantBrandingDTO(current, row));
}

export async function answerEmailSettings(res: Response, merchant: MerchantRow): Promise<void> {
  res
    .status(200)
    .json(toMerchantEmailSettingsDTO(merchant, await findEmailSettings(getDb(), merchant.id)));
}

export async function updateEmailSettingsCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = updateEmailSettingsBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const row = await upsertEmailSettings(getDb(), merchant.id, {
    paymentReceipts: parsed.data.payment_receipts,
    refundNotices: parsed.data.refund_notices,
    checkoutConfirmations: parsed.data.checkout_confirmations,
    supportEmail: parsed.data.support_email,
  });
  res.status(200).json(toMerchantEmailSettingsDTO(merchant, row));
}

/** The merchant API's branding and email settings routes. */
export function createBrandingRouter(deps: {
  requireMerchant: RequestHandler;
  files?: OxyFilesClient;
}): Router {
  const files = deps.files ?? oxyFilesClient;
  const router = Router();
  const read = [
    deps.requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:read'),
  ];
  const write = [
    deps.requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:write'),
    idempotent,
  ];
  const withMerchant = (
    core: (req: Request, res: Response, merchant: MerchantRow) => Promise<void>,
  ) =>
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      await core(req, res, merchant);
    });

  router.get(
    '/v1/merchants/me/branding',
    ...read,
    withMerchant((_req, res, m) => answerBranding(res, m)),
  );
  router.post(
    '/v1/merchants/me/branding',
    ...write,
    withMerchant((req, res, m) =>
      updateBrandingCore(req, res, m, { actor: serviceFileActor(req, m.oxyAppId), files }),
    ),
  );
  router.get(
    '/v1/merchants/me/email_settings',
    ...read,
    withMerchant((_req, res, m) => answerEmailSettings(res, m)),
  );
  router.post('/v1/merchants/me/email_settings', ...write, withMerchant(updateEmailSettingsCore));
  return router;
}
