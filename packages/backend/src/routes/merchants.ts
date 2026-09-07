import { Router } from "express";
import type { RequestHandler } from "express";
import { z } from "zod";
import { oxyClient } from "@oxyhq/core";
import type { OxyServiceEnvironment } from "@oxyhq/core/server";
import { getDb } from "../db/postgres";
import {
  insertMerchant,
  updateMerchantSettings,
  WatchOnlyViolationError,
} from "../db/merchants/merchantRepository";
import type { MerchantRow } from "../db/merchants/merchantRepository";
import { newId } from "../lib/ids";
import { toMerchantDTO } from "../lib/serialize";
import {
  sendError,
  wrap,
  requireServiceApp,
  requireAuthenticated,
} from "../lib/http";
import { resolveMerchant } from "./paymentIntents";

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

export const createMerchantBodySchema = z.object({
  network: z.enum(["mainnet", "testnet"]),
  xpub: z.string().min(1),
  webhookUrl: z.string().url().optional(),
  webhookSecret: z.string().min(1).optional(),
  requiredConfirmations: z.number().int().positive().optional(),
  ...brandingFields,
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
    network: "mainnet" | "testnet";
    xpub: string;
    webhookUrl?: string;
    webhookSecret?: string;
    requiredConfirmations?: number;
    displayName?: string;
    avatarFileId?: string;
    description?: string;
  },
): Promise<RegisterMerchantResult> {
  // Test/live firewall (F2.0 task 1b): a development/staging caller can only
  // ever register a testnet merchant — this makes it structurally impossible
  // for a leaked test credential (or a compromised dashboard session) to move
  // mainnet funds, not merely a data-labelling convention.
  if (environment !== "production" && params.network === "mainnet") {
    return {
      ok: false,
      status: 422,
      message: `a '${environment}' environment cannot register a mainnet merchant`,
    };
  }

  let merchant: MerchantRow | null;
  try {
    // Explicit field whitelist — never spread caller input. The non-custody
    // firewall runs inside `insertMerchant` on `xpub` regardless of this
    // function: it refuses any private extended key.
    merchant = await insertMerchant(getDb(), {
      publicId: newId("merch"),
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
    // The non-custody firewall refusing a key the caller sent is a bad
    // REQUEST, not a server fault. Surfacing it as a 422 says which field is
    // wrong; letting it escape would answer a spend-capable key with a 500 and
    // no indication that the key itself was the problem.
    if (err instanceof WatchOnlyViolationError) {
      return { ok: false, status: 422, message: err.message };
    }
    throw err;
  }

  // `null` is the unique index having refused a second registration for this
  // application and environment — converged on rather than read first, so two
  // concurrent registrations cannot both win.
  if (!merchant) {
    return {
      ok: false,
      status: 409,
      message: "a merchant is already registered for this application and environment",
    };
  }

  return { ok: true, merchant };
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
): Promise<MerchantRow | null> {
  // The patch is applied and re-read in ONE statement, so what the response
  // serializes is what was stored. An absent key means "leave alone" and an
  // explicit `null` means "clear"; `updateMerchantSettings` distinguishes them
  // by `undefined` rather than by falsiness, which is why a `null` webhook URL
  // clears the column instead of being ignored.
  return updateMerchantSettings(getDb(), merchant.id, {
    webhookUrl: params.webhookUrl,
    webhookSecret: params.webhookSecret,
    requiredConfirmations: params.requiredConfirmations,
    displayName: params.displayName,
    avatarFileId: params.avatarFileId,
    description: params.description,
  });
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
}): Router {
  const { requireMerchant } = deps;
  const router = Router();

  router.post(
    "/v1/merchants",
    requireMerchant,
    requireAuthenticated,
    oxyClient.requireScope("payments:write"),
    wrap(async (req, res) => {
      const serviceApp = requireServiceApp(req, res);
      if (!serviceApp) return;

      const parsed = createMerchantBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(
          res,
          422,
          "invalid_request_error",
          parsed.error.issues[0]?.message ?? "invalid request body",
        );
        return;
      }
      const result = await registerMerchant(serviceApp.appId, serviceApp.environment, parsed.data);
      if (!result.ok) {
        sendError(res, result.status, "invalid_request_error", result.message);
        return;
      }
      res.status(201).json(toMerchantDTO(result.merchant));
    }),
  );

  router.get(
    "/v1/merchants/me",
    requireMerchant,
    requireAuthenticated,
    oxyClient.requireScope("payments:read"),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      res.status(200).json(toMerchantDTO(merchant));
    }),
  );

  router.patch(
    "/v1/merchants/me",
    requireMerchant,
    requireAuthenticated,
    oxyClient.requireScope("payments:write"),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      const parsed = patchMerchantBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(
          res,
          422,
          "invalid_request_error",
          parsed.error.issues[0]?.message ?? "invalid request body",
        );
        return;
      }
      const updated = await applyMerchantPatch(merchant, parsed.data);
      if (!updated) {
        sendError(res, 404, "invalid_request_error", "merchant not found");
        return;
      }
      res.status(200).json(toMerchantDTO(updated));
    }),
  );

  return router;
}
