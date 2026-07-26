import { Router } from "express";
import type { RequestHandler } from "express";
import { z } from "zod";
import { getNetwork } from "@fairco.in/core";
import { oxyClient } from "@oxyhq/core";
import { createOxyAuthMiddleware, getRequiredOxyUserId } from "@oxyhq/core/server";
import type { WalletXpubResponse } from "@peable.to/shared-types";
import { getDb } from "../db/postgres";
import { findWalletXpub, upsertWalletXpub } from "../db/wallets/xpubRepository";
import { assertWatchOnly } from "../services/derivation";
import { sendError, wrap } from "../lib/http";

const publishBodySchema = z.object({
  network: z.enum(["mainnet", "testnet"]),
  xpub: z.string().min(1),
});

const readQuerySchema = z.object({
  network: z.enum(["mainnet", "testnet"]),
});

/**
 * The user's own account WATCH-ONLY key, published by the device that holds the
 * signing key and read back by that same user's other surfaces.
 *
 * WHY THIS EXISTS. The identity wallet's address tree derives from a seed
 * produced by HKDF over the on-device identity PRIVATE key, so nothing already
 * published about a user lets another surface compute those addresses — which
 * is deliberate, because the alternative would let anyone holding a handle
 * enumerate a stranger's entire balance and history. A browser has no keystore
 * and therefore no seed, so the public half has to travel once.
 *
 * The social-receive branch needs none of this: those addresses derive from the
 * identity PUBLIC key already in the user's DID (`services/socialReceive.ts`).
 * This endpoint covers the other branch.
 *
 * BOTH directions are scoped to the caller. An xpub is a permanent, total view
 * of an account — leaking one costs no funds and all privacy, and it cannot be
 * rotated without moving to a new account.
 */
export function createWalletRouter(deps?: { requireOxyUser?: RequestHandler }): Router {
  const requireOxyUser: RequestHandler =
    deps?.requireOxyUser ?? createOxyAuthMiddleware(oxyClient);
  const router = Router();

  router.put(
    "/v1/wallet/me/xpub",
    requireOxyUser,
    wrap(async (req, res) => {
      const oxyUserId = getRequiredOxyUserId(req);

      const parsed = publishBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(
          res,
          422,
          "invalid_request_error",
          parsed.error.issues[0]?.message ?? "invalid body",
        );
        return;
      }

      // The non-custody firewall, run BEFORE the write. A key that can sign
      // must never reach the database — not "must never be used to sign", which
      // a later careless caller could undo.
      try {
        assertWatchOnly(parsed.data.xpub, getNetwork(parsed.data.network));
      } catch (error) {
        sendError(
          res,
          422,
          "invalid_request_error",
          error instanceof Error ? error.message : "invalid extended key",
        );
        return;
      }

      await upsertWalletXpub(getDb(), {
        oxyUserId,
        network: parsed.data.network,
        xpub: parsed.data.xpub,
      });
      res.status(204).end();
    }),
  );

  router.get(
    "/v1/wallet/me/xpub",
    requireOxyUser,
    wrap(async (req, res) => {
      const oxyUserId = getRequiredOxyUserId(req);

      const parsed = readQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        sendError(
          res,
          422,
          "invalid_request_error",
          parsed.error.issues[0]?.message ?? "invalid query",
        );
        return;
      }

      const xpub = await findWalletXpub(getDb(), oxyUserId, parsed.data.network);
      const body: WalletXpubResponse = { xpub };
      res.status(200).json(body);
    }),
  );

  return router;
}
