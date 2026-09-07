import { Router } from "express";
import type { Request, RequestHandler } from "express";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import { oxyClient, isNotFoundError } from "@oxyhq/core";
import { createOxyAuthMiddleware, getRequiredOxyUserId } from "@oxyhq/core/server";
import type {
  SocialNextAddressResponse,
  SocialPayment,
  SocialPaymentsResponse,
  SocialReceiveCursorResponse,
} from "@peable.to/shared-types";
import { reserveNextSocialAddress, getReservedThrough } from "../services/socialReceive";
import { getDb } from "../db/postgres";
import {
  insertSendAttribution,
  listAttributionsForViewer,
} from "../db/social/sendAttribution";
import { ENRICH_MAX_ADDRESSES, enrichAddresses } from "../services/enrichment";
import { sendError, wrap } from "../lib/http";

const nextAddressBodySchema = z.object({
  network: z.enum(["mainnet", "testnet"]),
});

const cursorQuerySchema = z.object({
  network: z.enum(["mainnet", "testnet"]),
});

const paymentsQuerySchema = z.object({
  network: z.enum(["mainnet", "testnet"]),
});

/**
 * Anti-grief limit for `POST /:username/next_address`, keyed on the
 * (sender, recipient) pair — distinct from the coarse global per-caller
 * limiter already mounted in `server.ts` (`createOxyRateLimit`), which 20
 * calls trivially clears. `reserveNextSocialAddress` advances the
 * recipient's cursor whether or not the reserved address is ever paid, so an
 * unbounded sender could silently desync one victim's device watch window
 * (finding: cursor-sync HIGH — see `SocialReceiveCursorResponse`). 6 per 10
 * minutes covers legitimate repeat-pay / re-pick-recipient flows in the
 * SendSheet while bounding how many fresh indices one sender can force onto
 * one recipient before that recipient's device can resync via
 * `GET /v1/social/me/cursor`.
 *
 * Exported so tests assert against the authoritative values rather than a
 * magic number that could silently drift out of sync with the limiter.
 */
export const NEXT_ADDRESS_PAIR_WINDOW_MS = 10 * 60 * 1000;
export const NEXT_ADDRESS_PAIR_MAX = 6;

/** Carries the resolved (sender, recipient) rate-limit key from the handler to `nextAddressPairLimiter`'s `keyGenerator`, set just before invoking it (recipient isn't known until after the username lookup). */
interface PairRateLimitedRequest extends Request {
  socialNextAddressPairKey?: string;
}

/**
 * Build the social-send REST router (spec §4.4 step 3, §4.5, §4.8 bullets
 * 2-3).
 *
 * `requireOxyUser` is injectable so tests can bypass a real Oxy bearer token
 * with a stub that populates `req.userId`; production defaults to
 * `createOxyAuthMiddleware(oxyClient)` — the PAYER's own signed-in Oxy
 * session, distinct from the merchant service-auth `paymentIntents.ts` uses.
 */
export function createSocialRouter(deps?: { requireOxyUser?: RequestHandler }): Router {
  const requireOxyUser: RequestHandler =
    deps?.requireOxyUser ?? createOxyAuthMiddleware(oxyClient);
  const router = Router();

  // Built once per router (so tests building a fresh router via
  // `createSocialRouter()` get an isolated counter, never leaking state
  // across test files), invoked manually inside the handler below once the
  // recipient is known — it can't be ordinary route middleware because the
  // (sender, recipient) key isn't resolvable until after the username lookup.
  const nextAddressPairLimiter = rateLimit({
    windowMs: NEXT_ADDRESS_PAIR_WINDOW_MS,
    limit: NEXT_ADDRESS_PAIR_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req as PairRateLimitedRequest).socialNextAddressPairKey ?? "unknown",
    handler: (_req, res) => {
      sendError(
        res,
        429,
        "rate_limit_error",
        "too many address reservations for this recipient — try again shortly",
      );
    },
  });

  router.post(
    "/v1/social/:username/next_address",
    requireOxyUser,
    wrap(async (req, res) => {
      const senderUserId = getRequiredOxyUserId(req);

      const parsed = nextAddressBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(
          res,
          422,
          "invalid_request_error",
          parsed.error.issues[0]?.message ?? "invalid request body",
        );
        return;
      }
      const { network } = parsed.data;

      const { username } = req.params;
      if (!username) {
        sendError(res, 422, "invalid_request_error", "username is required");
        return;
      }

      let recipient: { id: string };
      try {
        recipient = await oxyClient.getProfileByUsername(username);
      } catch (err) {
        if (isNotFoundError(err)) {
          sendError(res, 404, "invalid_request_error", "recipient not found");
          return;
        }
        // Anything other than a genuine 404 (network failure, oxy-api 5xx,
        // timeout) is an upstream outage, not a missing recipient — mapping
        // it to 404 would both mislead the payer and hide the outage from
        // observability. Log it and surface a distinct 5xx instead.
        const message = err instanceof Error ? err.message : String(err);
        process.emitWarning(
          `Peable social-send profile lookup failed for @${username}: ${message}`,
        );
        sendError(res, 502, "api_error", "failed to resolve recipient — try again");
        return;
      }

      if (recipient.id === senderUserId) {
        sendError(res, 422, "invalid_request_error", "cannot pay yourself");
        return;
      }

      // Anti-grief: bound how many fresh indices THIS sender can force onto
      // THIS recipient before reserving one (see `nextAddressPairLimiter`
      // above). `withinPairLimit` is only ever set inside the `next()`
      // callback, so it stays false (and the limiter has already written the
      // 429 response) when the pair is over budget.
      (req as PairRateLimitedRequest).socialNextAddressPairKey = `${senderUserId}:${recipient.id}`;
      let withinPairLimit = false;
      await nextAddressPairLimiter(req, res, () => {
        withinPairLimit = true;
      });
      if (!withinPairLimit) return;

      // Reservation (Task 5) + attribution write (Task 6) happen together in
      // this handler so an enrichment lookup can never observe a reserved
      // address with no attribution row.
      const reservation = await reserveNextSocialAddress(recipient.id, network);
      if (!reservation) {
        sendError(
          res,
          409,
          "keyless_recipient",
          "recipient has not set up an Oxy identity yet",
        );
        return;
      }

      await insertSendAttribution(getDb(), {
        address: reservation.address,
        network,
        senderUserId,
        recipientUserId: recipient.id,
        derivationIndex: reservation.index,
      });

      const body: SocialNextAddressResponse = {
        address: reservation.address,
        index: reservation.index,
      };
      res.status(200).json(body);
    }),
  );

  router.get(
    "/v1/social/me/cursor",
    requireOxyUser,
    wrap(async (req, res) => {
      const oxyUserId = getRequiredOxyUserId(req);

      const parsed = cursorQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        sendError(
          res,
          422,
          "invalid_request_error",
          parsed.error.issues[0]?.message ?? "invalid query",
        );
        return;
      }

      // Read-only: reserves nothing, so a device can poll it freely to
      // resync its watch window (spec cursor-sync fix).
      const reservedThrough = await getReservedThrough(oxyUserId, parsed.data.network);
      const body: SocialReceiveCursorResponse = { reservedThrough };
      res.status(200).json(body);
    }),
  );

  /**
   * The caller's own social payment history — the only one a surface WITHOUT a
   * key can ask for.
   *
   * Every other view of a payment starts from addresses the device derived
   * (`POST /v1/enrich`, the cursor), which needs a seed. The web build has none,
   * so it can only say who it is; this endpoint answers from the attribution
   * table, where the caller's user id is already one of the two named parties.
   *
   * The viewer scoping lives in `listAttributionsForViewer`'s WHERE clause, not
   * in a filter here: an attribution names two people, and a row the caller is
   * not party to must never leave the database.
   *
   * Bounded by `ENRICH_MAX_ADDRESSES` — the same number `POST /v1/enrich`
   * accepts — because the enrichment below is the expensive half (an Oxy
   * profile batch), and letting the listing outrun what enrichment is sized for
   * would silently return rows with `unknown` counterparties.
   */
  router.get(
    "/v1/social/me/payments",
    requireOxyUser,
    wrap(async (req, res) => {
      const oxyUserId = getRequiredOxyUserId(req);

      const parsed = paymentsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        sendError(
          res,
          422,
          "invalid_request_error",
          parsed.error.issues[0]?.message ?? "invalid query",
        );
        return;
      }

      const rows = await listAttributionsForViewer(
        getDb(),
        oxyUserId,
        parsed.data.network,
        ENRICH_MAX_ADDRESSES,
      );
      const enriched = await enrichAddresses(
        rows.map((row) => row.address),
        oxyUserId,
      );

      const payments: SocialPayment[] = rows.map((row) => ({
        address: row.address,
        direction: row.senderUserId === oxyUserId ? "sent" : "received",
        counterparty: enriched[row.address] ?? { kind: "unknown" },
        createdAt: row.createdAt.toISOString(),
      }));

      const body: SocialPaymentsResponse = { payments };
      res.status(200).json(body);
    }),
  );

  return router;
}
