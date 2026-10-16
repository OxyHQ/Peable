import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { oxy } from '../oxy';
import type { OxyAuthRequest, OxyServiceEnvironment } from '@oxy.so/core/server';
import { getDb } from '../db/postgres';
import {
  ChainRegistrationError,
  insertMerchant,
  updateMerchantSettings,
  WatchOnlyViolationError,
} from '../db/merchants/merchantRepository';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { newId } from '../lib/ids';
import { toMerchantDTO } from '../lib/serialize';
import { sendError, wrap, requireServiceApp, requireAuthenticated } from '../lib/http';
import { resolveMerchant } from './paymentIntents';
import { enqueueReferenceSync } from '../db/oxyFiles/referenceSyncRepository';
import { type OxyFilesClient, oxyFilesClient } from '../services/oxyFiles/client';
import { acceptMerchantAvatar, type AvatarActor } from '../services/oxyFiles/merchantAvatar';
import { kickReferenceSync } from '../services/oxyFiles/referenceSync';

/** Exported: `routes/dashboard.ts` parses the SAME registration body for its dashboard-authed register route (F2.5) so the two never drift. */
// The branding columns are bare `text()` with no CHECK, so these bounds are
// the ONLY thing between a merchant and an unbounded write. `displayName` is
// rendered in a payer's transaction history and on the checkout chip, so it is
// held to a chip-sized length rather than a paragraph.
const DISPLAY_NAME_MAX = 64;
const AVATAR_FILE_ID_MAX = 128;
const DESCRIPTION_MAX = 512;

const brandingFields = {
  displayName: z.string().min(1).max(DISPLAY_NAME_MAX).optional(),
  avatarFileId: z.string().min(1).max(AVATAR_FILE_ID_MAX).optional(),
  description: z.string().min(1).max(DESCRIPTION_MAX).optional(),
};

export const createMerchantBodySchema = z
  .object({
    /**
     * The FairCoin half. OPTIONAL — both fields or neither.
     *
     * Required unconditionally until now, so a merchant who only wanted to
     * take cards had to supply a watch-only extended key for a chain they had
     * no intention of using. Whatever they supplied was then either a real key
     * they had to custody, or a fixture that silently made their FairCoin
     * receive addresses underivable by their own wallet.
     */
    network: z.enum(['mainnet', 'testnet']).optional(),
    xpub: z.string().min(1).optional(),
    webhookUrl: z.string().url().optional(),
    webhookSecret: z.string().min(1).optional(),
    requiredConfirmations: z.number().int().positive().optional(),
    ...brandingFields,
  })
  .refine((body) => (body.network === undefined) === (body.xpub === undefined), {
    message:
      'accepting FairCoin needs both a network and a watch-only xpub, or neither — ' +
      'omit both to register a card-only merchant',
  });

/** Exported: `routes/dashboard.ts` reuses the SAME patch body for its dashboard-authed PATCH route (F2.5). */
export const patchMerchantBodySchema = z.object({
  webhookUrl: z.string().url().nullable().optional(),
  webhookSecret: z.string().min(1).nullable().optional(),
  requiredConfirmations: z.number().int().positive().optional(),
  // `.nullable()` on top of the create bounds: `null` clears the field.
  displayName: brandingFields.displayName.unwrap().nullable().optional(),
  avatarFileId: brandingFields.avatarFileId.unwrap().nullable().optional(),
  description: brandingFields.description.unwrap().nullable().optional(),
});

export type RegisterMerchantResult =
  | { ok: true; merchant: MerchantRow }
  | { ok: false; status: number; message: string };

/** What an avatar write needs: who is writing, and how to ask Oxy about the file. */
export interface AvatarAuthority {
  readonly actor: AvatarActor;
  readonly files: OxyFilesClient;
}

/**
 * The avatar authority of a SERVICE-authenticated caller: the token's own
 * application, its owner account (the billing principal Oxy signed into the
 * token) and, under a delegation grant, the user it acts as.
 */
export function serviceAvatarActor(req: Request, appId: string): AvatarActor {
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
    network?: 'mainnet' | 'testnet';
    xpub?: string;
    webhookUrl?: string;
    webhookSecret?: string;
    requiredConfirmations?: number;
    displayName?: string;
    avatarFileId?: string;
    description?: string;
  },
  avatar: AvatarAuthority,
): Promise<RegisterMerchantResult> {
  // Test/live firewall (F2.0 task 1b): a development/staging caller can only
  // ever register a testnet merchant — this makes it structurally impossible
  // for a leaked test credential (or a compromised dashboard session) to move
  // mainnet funds, not merely a data-labelling convention.
  if (environment !== 'production' && params.network === 'mainnet') {
    return {
      ok: false,
      status: 422,
      message: `a '${environment}' environment cannot register a mainnet merchant`,
    };
  }
  // A card-only merchant (no network) passes the firewall above vacuously, and
  // that is correct: what it guards is the CHAIN. The equivalent guard for the
  // card rail is `environmentGuard`, which refuses a non-production credential
  // reaching a live provider key before any call is made.

  // The public id is minted BEFORE the insert because the avatar's Oxy
  // reference names it, and that reference is registered first: Oxy's answer
  // decides whether the avatar is accepted at all.
  const publicId = newId('merch');
  if (params.avatarFileId !== undefined) {
    const accepted = await acceptMerchantAvatar(
      avatar.files,
      params.avatarFileId,
      publicId,
      avatar.actor,
    );
    if (!accepted.ok) return accepted;
  }

  let merchant: MerchantRow | null;
  try {
    // Explicit field whitelist — never spread caller input. The non-custody
    // firewall runs inside `insertMerchant` on `xpub` regardless of this
    // function: it refuses any private extended key.
    merchant = await insertMerchant(getDb(), {
      publicId,
      oxyAppId,
      environment,
      network: params.network,
      xpub: params.xpub,
      webhookUrl: params.webhookUrl,
      webhookSecret: params.webhookSecret,
      requiredConfirmations: params.requiredConfirmations,
      displayName: params.displayName,
      avatarFileId: params.avatarFileId,
      description: params.description,
    });
  } catch (err) {
    if (params.avatarFileId !== undefined) await releaseUnusedAvatar(params.avatarFileId, publicId);
    // The non-custody firewall refusing a key the caller sent is a bad
    // REQUEST, not a server fault. Surfacing it as a 422 says which field is
    // wrong; letting it escape would answer a spend-capable key with a 500 and
    // no indication that the key itself was the problem.
    if (err instanceof WatchOnlyViolationError || err instanceof ChainRegistrationError) {
      // Both are the caller describing a FairCoin account this gateway will not
      // accept — a key that can spend, or half a registration. 422 with the
      // message says which; letting either escape would answer a spend-capable
      // key with a 500 and no indication the key was the problem.
      return { ok: false, status: 422, message: err.message };
    }
    throw err;
  }

  // `null` is the unique index having refused a second registration for this
  // application and environment — converged on rather than read first, so two
  // concurrent registrations cannot both win.
  if (!merchant) {
    if (params.avatarFileId !== undefined) await releaseUnusedAvatar(params.avatarFileId, publicId);
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
 * Apply the mutable merchant fields (F2.5 — shared by `PATCH /v1/merchants/me`
 * and the dashboard's `PATCH .../merchant`). `xpub`/`network`/`environment`/
 * `oxyAppId` are deliberately NOT accepted here: mutating the derivation key
 * after intents already derived addresses from it would corrupt address
 * history, and network/environment are the test/live firewall itself.
 */
export async function applyMerchantPatch(
  merchant: MerchantRow,
  params: {
    webhookUrl?: string | null;
    webhookSecret?: string | null;
    requiredConfirmations?: number;
    displayName?: string | null;
    avatarFileId?: string | null;
    description?: string | null;
  },
  avatar: AvatarAuthority,
): Promise<PatchMerchantResult> {
  // A NEW avatar is verified and its Oxy reference registered first; clearing
  // it, or re-sending the one already set, needs nothing from Oxy.
  const newAvatar =
    typeof params.avatarFileId === 'string' && params.avatarFileId !== merchant.avatarFileId
      ? params.avatarFileId
      : undefined;
  if (newAvatar !== undefined) {
    const accepted = await acceptMerchantAvatar(
      avatar.files,
      newAvatar,
      merchant.publicId,
      avatar.actor,
    );
    if (!accepted.ok) return accepted;
  }

  // The patch is applied and re-read in ONE statement, so what the response
  // serializes is what was stored. An absent key means "leave alone" and an
  // explicit `null` means "clear"; `updateMerchantSettings` distinguishes them
  // by `undefined` rather than by falsiness, which is why a `null` webhook URL
  // clears the column instead of being ignored.
  let updated: MerchantRow | null;
  try {
    updated = await updateMerchantSettings(getDb(), merchant.id, {
      webhookUrl: params.webhookUrl,
      webhookSecret: params.webhookSecret,
      requiredConfirmations: params.requiredConfirmations,
      displayName: params.displayName,
      avatarFileId: params.avatarFileId,
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
  if (params.avatarFileId !== undefined) kickReferenceSync();
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
    oxy.middleware.requireScope('payments:write'),
    wrap(async (req, res) => {
      const serviceApp = requireServiceApp(req, res);
      if (!serviceApp) return;

      const parsed = createMerchantBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(
          res,
          422,
          'invalid_request_error',
          parsed.error.issues[0]?.message ?? 'invalid request body',
        );
        return;
      }
      const result = await registerMerchant(serviceApp.appId, serviceApp.environment, parsed.data, {
        actor: serviceAvatarActor(req, serviceApp.appId),
        files,
      });
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
    oxy.middleware.requireScope('payments:read'),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      res.status(200).json(toMerchantDTO(merchant));
    }),
  );

  router.patch(
    '/v1/merchants/me',
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:write'),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      const parsed = patchMerchantBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(
          res,
          422,
          'invalid_request_error',
          parsed.error.issues[0]?.message ?? 'invalid request body',
        );
        return;
      }
      const result = await applyMerchantPatch(merchant, parsed.data, {
        actor: serviceAvatarActor(req, merchant.oxyAppId),
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
