import { idempotent } from '../lib/idempotency';
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { registerMerchantParams, updateMerchantParams } from '@peable.to/contracts';
import type { OxyAuthRequest, OxyServiceEnvironment } from '@oxy.so/core/server';
import { getDb } from '../db/postgres';
import { insertMerchant, updateMerchantSettings } from '../db/merchants/merchantRepository';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { newId } from '../lib/ids';
import { toMerchantDTO } from '../lib/serialize';
import {
  sendError,
  wrap,
  requireServiceApp,
  requireAuthenticated,
  sendValidationError,
  requireScope,
} from '../lib/http';
import { resolveMerchant } from './paymentIntents';
import { enqueueReferenceSync } from '../db/oxyFiles/referenceSyncRepository';
import { type OxyFilesClient, oxyFilesClient } from '../services/oxyFiles/client';
import { acceptOxyFile, type FileActor } from '../services/oxyFiles/fileOwnership';
import { findFileByPublicId } from '../db/files/fileRepository';
import { kickReferenceSync } from '../services/oxyFiles/referenceSync';

export type RegisterMerchantResult =
  | { ok: true; merchant: MerchantRow }
  | { ok: false; status: number; message: string };

/** What an avatar write needs: who is writing, and how to ask Oxy about the file. */
export interface AvatarAuthority {
  readonly actor: FileActor;
  readonly files: OxyFilesClient;
}

/**
 * The file authority of a SERVICE-authenticated caller: the token's own
 * application, its owner account (the billing principal Oxy signed into the
 * token) and, under a delegation grant, the user it acts as.
 */
export function serviceFileActor(req: Request, appId: string): FileActor {
  const { serviceApp, serviceActingAs } = req as OxyAuthRequest;
  return {
    applicationId: appId,
    accountIds: [serviceApp?.ownerAccountId, serviceActingAs?.userId],
  };
}

/**
 * A file was registered as this merchant's avatar at Oxy and the write that
 * would have used it did not happen. Queue the pair: the sync finds it unused
 * and removes the reference. Best effort — the database refusing this insert
 * too is the case the nightly reconciliation exists for.
 */
async function releaseUnusedAvatar(fileId: string, merchantPublicId: string): Promise<void> {
  try {
    await enqueueReferenceSync(getDb(), {
      fileId,
      entityType: 'merchant_avatar',
      entityId: merchantPublicId,
    });
    kickReferenceSync();
  } catch (error) {
    process.emitWarning(
      `Peable could not queue the release of an unused avatar reference for ${merchantPublicId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Shared registration body (F2.5) — factored out so `POST /v1/merchants`
 * (service-authed) and the dashboard's `POST
 * /v1/dashboard/applications/:applicationId/merchant` (human-authed) run the
 * EXACT same test/live firewall + create-with-whitelist + duplicate-key
 * handling, never two copies to keep in sync. The non-custody firewall runs
 * regardless of caller, since it lives inside `insertMerchant` — the single
 * write point — rather than on any one route.
 */
export async function registerMerchant(
  oxyAppId: string,
  environment: OxyServiceEnvironment,
  params: {
    required_confirmations?: number;
    display_name?: string;
    avatar_file_id?: string;
    description?: string;
  },
  avatar: AvatarAuthority,
  /** The application's VERIFIED owner account — whose Peable wallet receives (ADR 0021 D5). */
  ownerAccountId?: string,
): Promise<RegisterMerchantResult> {
  // No FairCoin key is registered (ADR 0021 D5): the merchant's network is its
  // environment's — so a non-production credential can only ever reach
  // testnet, the test/live firewall by construction — and its FairCoin is
  // received into the Peable wallet of the account that owns the application.

  // The public id is minted BEFORE the insert because the avatar's Oxy
  // reference names it, and that reference is registered first: Oxy's answer
  // decides whether the avatar is accepted at all.
  const publicId = newId('merch');
  if (params.avatar_file_id !== undefined) {
    const accepted = await acceptOxyFile(
      avatar.files,
      params.avatar_file_id,
      { entityType: 'merchant_avatar', entityId: publicId, param: 'avatar_file_id' },
      avatar.actor,
    );
    if (!accepted.ok) return accepted;
  }

  // Explicit field whitelist — never spread caller input.
  const merchant: MerchantRow | null = await insertMerchant(getDb(), {
    publicId,
    oxyAppId,
    environment,
    ownerAccountId,
    requiredConfirmations: params.required_confirmations,
    displayName: params.display_name,
    avatarFileId: params.avatar_file_id,
    description: params.description,
  }).catch(async (err: unknown) => {
    if (params.avatar_file_id !== undefined)
      await releaseUnusedAvatar(params.avatar_file_id, publicId);
    throw err;
  });

  // `null` is the unique index having refused a second registration for this
  // application and environment — converged on rather than read first, so two
  // concurrent registrations cannot both win.
  if (!merchant) {
    if (params.avatar_file_id !== undefined)
      await releaseUnusedAvatar(params.avatar_file_id, publicId);
    return {
      ok: false,
      status: 409,
      message: 'a merchant is already registered for this application and environment',
    };
  }

  return { ok: true, merchant };
}

export type PatchMerchantResult = RegisterMerchantResult;

/**
 * The answer to a refused registration or patch. A 503 is Oxy being
 * unreachable for the avatar check — the caller's request was fine, so it is an
 * `api_error` to retry, not an `invalid_request_error` to fix.
 */
export function sendMerchantWriteError(
  res: Response,
  result: { readonly status: number; readonly message: string },
): void {
  sendError(
    res,
    result.status,
    result.status === 503 ? 'api_error' : 'invalid_request_error',
    result.message,
  );
}

/**
 * Apply the mutable merchant fields (F2.5 — shared by `POST /v1/merchants/me`
 * and the dashboard's `PATCH .../merchant`). `xpub`/`network`/`environment`/
 * `oxyAppId` are deliberately NOT accepted here: mutating the derivation key
 * after intents already derived addresses from it would corrupt address
 * history, and network/environment are the test/live firewall itself.
 */
export async function applyMerchantPatch(
  merchant: MerchantRow,
  params: {
    required_confirmations?: number;
    display_name?: string | null;
    avatar_file_id?: string | null;
    business_logo?: string | null;
    description?: string | null;
  },
  avatar: AvatarAuthority,
): Promise<PatchMerchantResult> {
  // A NEW avatar is verified and its Oxy reference registered first; clearing
  // it, or re-sending the one already set, needs nothing from Oxy.
  const newAvatar =
    typeof params.avatar_file_id === 'string' && params.avatar_file_id !== merchant.avatarFileId
      ? params.avatar_file_id
      : undefined;
  if (newAvatar !== undefined) {
    const accepted = await acceptOxyFile(
      avatar.files,
      newAvatar,
      { entityType: 'merchant_avatar', entityId: merchant.publicId, param: 'avatar_file_id' },
      avatar.actor,
    );
    if (!accepted.ok) return accepted;
  }

  // The logo is one of THIS merchant's own Files, of purpose `business_logo`
  // and not removed. The File already holds its Oxy reference, so this needs
  // nothing from Oxy; `merchants_business_logo_file_fkey` makes "this
  // merchant's" structural, and this is where the purpose is checked.
  let businessLogoFileId: string | null | undefined;
  if (params.business_logo === null) businessLogoFileId = null;
  else if (params.business_logo !== undefined) {
    const logo = await findFileByPublicId(getDb(), merchant.id, params.business_logo);
    if (logo?.purpose !== 'business_logo' || logo.removedAt !== null) {
      return {
        ok: false,
        status: 400,
        message: 'business_logo must name one of your files of purpose business_logo',
      };
    }
    businessLogoFileId = logo.id;
  }

  // The patch is applied and re-read in ONE statement, so what the response
  // serializes is what was stored. An absent key means "leave alone" and an
  // explicit `null` means "clear"; `updateMerchantSettings` distinguishes them
  // by `undefined` rather than by falsiness, which is why a `null` description
  // clears the column instead of being ignored.
  let updated: MerchantRow | null;
  try {
    updated = await updateMerchantSettings(getDb(), merchant.id, {
      requiredConfirmations: params.required_confirmations,
      displayName: params.display_name,
      avatarFileId: params.avatar_file_id,
      businessLogoFileId,
      description: params.description,
    });
  } catch (error) {
    if (newAvatar !== undefined) await releaseUnusedAvatar(newAvatar, merchant.publicId);
    throw error;
  }
  if (!updated) {
    if (newAvatar !== undefined) await releaseUnusedAvatar(newAvatar, merchant.publicId);
    return { ok: false, status: 404, message: 'merchant not found' };
  }
  // The write queued the old file's release and the new one's reference in its
  // own transaction; this only runs that sync now instead of at the next tick.
  if (params.avatar_file_id !== undefined) kickReferenceSync();
  return { ok: true, merchant: updated };
}

/**
 * Build the merchant registration/management REST router (F2.0 task 8).
 * `requireMerchant` is injectable so tests can bypass real Oxy service tokens
 * with a stub that populates `req.serviceApp`; in production it is the SAME
 * resolved default `createGateway()` builds for `paymentIntents.ts`, so
 * `environment` is always available from the token — doubling as the
 * enforcement point for the test/live firewall below.
 */
export function createMerchantsRouter(deps: {
  requireMerchant: RequestHandler;
  /** Oxy Files, for the avatar ownership check. Default: the real client. */
  files?: OxyFilesClient;
}): Router {
  const { requireMerchant } = deps;
  const files = deps.files ?? oxyFilesClient;
  const router = Router();

  router.post(
    '/v1/merchants',
    requireMerchant,
    requireAuthenticated,
    requireScope('payments:write'),
    wrap(async (req, res) => {
      const serviceApp = requireServiceApp(req, res);
      if (!serviceApp) return;

      const parsed = registerMerchantParams.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      const result = await registerMerchant(
        serviceApp.appId,
        serviceApp.environment,
        parsed.data,
        { actor: serviceFileActor(req, serviceApp.appId), files },
        serviceApp.ownerAccountId,
      );
      if (!result.ok) {
        sendMerchantWriteError(res, result);
        return;
      }
      res.status(201).json(toMerchantDTO(result.merchant));
    }),
  );

  router.get(
    '/v1/merchants/me',
    requireMerchant,
    requireAuthenticated,
    requireScope('payments:read'),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      res.status(200).json(toMerchantDTO(merchant));
    }),
  );

  // An update is a POST, as every update on this API is; there is no PATCH.
  router.post(
    '/v1/merchants/me',
    requireMerchant,
    requireAuthenticated,
    requireScope('payments:write'),
    idempotent,
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      const parsed = updateMerchantParams.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      const result = await applyMerchantPatch(merchant, parsed.data, {
        actor: serviceFileActor(req, merchant.oxyAppId),
        files,
      });
      if (!result.ok) {
        sendMerchantWriteError(res, result);
        return;
      }
      res.status(200).json(toMerchantDTO(result.merchant));
    }),
  );

  return router;
}
