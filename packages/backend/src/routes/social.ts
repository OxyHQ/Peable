import { Router } from "express";
import type { Request, RequestHandler } from "express";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import { oxyClient, isNotFoundError } from "@oxy.so/core";
import { createOxyAuthMiddleware, getRequiredOxyUserId } from "@oxy.so/core/server";
import {
  SOCIAL_SOURCE_APP_MAX_LENGTH,
  SOCIAL_SOURCE_REF_MAX_LENGTH,
  type SocialNextAddressRequest,
  type SocialNextAddressResponse,
  type SocialPayment,
  type SocialPaymentsResponse,
  type SocialReceiveCursorResponse,
} from "@peable.to/shared-types";
import { config } from "../config";
import { reserveNextSocialAddress, getReservedThrough } from "../services/socialReceive";
import { getDb } from "../db/postgres";
import {
  insertSendAttribution,
  listAttributionsForViewer,
} from "../db/social/sendAttribution";
import { ENRICH_MAX_ADDRESSES, enrichAddresses } from "../services/enrichment";
import { sendError, wrap } from "../lib/http";
import { toSocialPaymentSource } from "../lib/serialize";

/**
 * Optional, display-only context for one social payment: which app the payer
 * was in, and that app's own id for what they were paying for (a Mention post,
 * say).
 *
 * **Optional, and it stays optional.** A plain person-to-person payment is for
 * nothing in particular; requiring this would make every caller invent an
 * answer, and an invented context is worse than none.
 *
 * `.strict()` is the "reject anything else" half and is load-bearing rather
 * than tidy. Zod strips an unknown key silently by default, so `{ app, postId }`
 * — the obvious misspelling of `ref` — would reserve an address and record a
 * context missing the only part the recipient cares about, with a 200 to say it
 * worked. The bounds come from `@peable.to/shared-types`, which is also where
 * the column CHECKs read them, so the request, the contract and the table
 * cannot drift apart.
 *
 * `ref` is validated for SHAPE and never for meaning: printable non-space ASCII
 * bounds it to something id-shaped, so the field cannot quietly become a free
 * text memo the gateway is then storing on behalf of two users. Peable never
 * parses it beyond this.
 */
const paymentSourceSchema = z
  .object({
    app: z
      .string()
      .min(1)
      .max(SOCIAL_SOURCE_APP_MAX_LENGTH)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, "source.app must be a lowercase app slug"),
    ref: z
      .string()
      .min(1)
      .max(SOCIAL_SOURCE_REF_MAX_LENGTH)
      .regex(/^[\x21-\x7e]+$/, "source.ref must be an opaque id, without spaces")
      .optional(),
  })
  .strict();

const nextAddressBodySchema = z.object({
  network: z.enum(["mainnet", "testnet"]),
  source: paymentSourceSchema.optional(),
});

/** True only when `A` and `B` are the SAME type, not merely assignable to each other. */
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
/** Fails to compile when its argument is anything but `true`. */
type AssertTrue<T extends true> = T;

/**
 * Compile-time proof that what this route PARSES and what
 * `@peable.to/shared-types` PUBLISHES are one shape — a field accepted here
 * that the contract does not name, or a contract field this parser would strip,
 * is an error on this line instead of a mismatch a consumer of the published
 * package meets at runtime.
 *
 * `Exact`, not an annotation of `z.ZodType<SocialNextAddressRequest>` on the
 * schema. MEASURED: that annotation accepts an extra required field without a
 * word, because `ZodType`'s output parameter appears in method positions and is
 * therefore bivariant — the obvious spelling of this check does not check
 * anything.
 */
export type NextAddressBodyIsTheContract = AssertTrue<
  Exact<z.infer<typeof nextAddressBodySchema>, SocialNextAddressRequest>
>;

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
      const { network, source } = parsed.data;

      // The network gate lives HERE, not only in the wallet. Social-receive
      // addresses are derived from the recipient's identity key, and a payer
      // reaching a network this deployment has not cleared for that derivation
      // sends money to an address nobody has proven the recipient can spend.
      if (network !== config.socialPayNetwork) {
        sendError(
          res,
          403,
          "invalid_request_error",
          `paying by @username is not enabled on ${network}`,
        );
        return;
      }

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
        // Recorded AFTER the reservation and an input to nothing before it. The
        // address comes from the recipient's identity key and their cursor, so
        // a request carrying a source and one carrying none reserve the same
        // index — the context is something the recipient reads later, never
        // something that decides where money goes.
        source,
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
      const { reservedThrough, identityPublicKey } = await getReservedThrough(
        oxyUserId,
        parsed.data.network,
      );
      const body: SocialReceiveCursorResponse = { reservedThrough, identityPublicKey };
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
        // Display-only, like `counterparty`, and handed back exactly as the
        // paying app sent it: `toSocialPaymentSource` copies the two columns
        // and reads into neither. Omitted entirely for a payment nobody gave
        // a context to.
        source: toSocialPaymentSource(row),
        createdAt: row.createdAt.toISOString(),
      }));

      const body: SocialPaymentsResponse = { payments };
      res.status(200).json(body);
    }),
  );

  return router;
}
