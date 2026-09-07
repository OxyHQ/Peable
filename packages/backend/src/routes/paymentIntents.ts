import { Router } from "express";
import type {
  Request,
  RequestHandler,
  Response,
} from "express";
import { z } from "zod";
import { oxyClient } from "@oxyhq/core";
import { verifySecret } from "@oxyhq/core/server";
import type { OxyAuthRequest, OxyServiceEnvironment } from "@oxyhq/core/server";
import {
  PAYMENT_INTENT_STATUSES,
  type CreatePaymentIntentParams,
  type PaymentIntentStatus,
} from "@peable.to/shared-types";
import { getDb } from "../db/postgres";
import { findMerchantByAppEnvironment } from "../db/merchants/merchantRepository";
import type { MerchantRow } from "../db/merchants/merchantRepository";
import {
  findIntentByPublicId,
  findIntentForMerchant,
  listIntentsForMerchant,
} from "../db/payments/paymentIntentRepository";
import type {
  IntentStateResult,
  PaymentIntentRow,
} from "../db/payments/paymentIntentRepository";
import {
  createIntent,
  NetworkMismatchError,
  RailMismatchError,
  RailUnavailableError,
} from "../services/createIntent";
import { applyEvent } from "../services/intentState";
import { announceIntentChange, transitionIntent } from "../services/intentTransition";
import { toPaymentIntentDTO } from "../lib/serialize";
import { sendError, wrap, requireServiceApp, requireAuthenticated } from "../lib/http";
import { railBodyFields } from "../lib/railSchema";

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

/**
 * Answer a transition that did not apply.
 *
 * Two statuses, not one. Both routes here read the intent, validate the
 * transition against what they read, and only then write — so between those two
 * steps the expiry sweeper or a provider event can move the row. That is a
 * CONFLICT (409): the request was well-formed and addressed a payment that
 * exists, it simply describes a move from a state the payment has left. A 404
 * would tell the caller their payment does not exist, which is both false and
 * unactionable — the status is what they need to see.
 *
 * `missing` keeps the 404 it always had.
 */
function sendStaleOrMissing(
  res: Parameters<typeof sendError>[0],
  result: Exclude<IntentStateResult, { kind: 'updated' }>,
): void {
  if (result.kind === "missing") {
    sendError(res, 404, "invalid_request_error", "payment intent not found");
    return;
  }
  sendError(
    res,
    409,
    "invalid_request_error",
    `the payment intent moved to '${result.current}' while this request was in flight`,
  );
}

/** Exported: `routes/dashboard.ts` parses the SAME query shape for its list route (F2.5) so the two never drift. */
export const listQuerySchema = z.object({
  status: z
    .enum(PAYMENT_INTENT_STATUSES as [PaymentIntentStatus, ...PaymentIntentStatus[]])
    .optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIST_LIMIT).optional(),
  starting_after: z.string().optional(),
});

// Zod schema for the create body. Its inferred output is asserted assignable to
// `CreatePaymentIntentParams` (see `params` below) so the wire contract and the
// shared type can never silently drift apart.
const createBodySchema = z.object({
  ...railBodyFields,
  metadata: z.record(z.string(), z.string()).optional(),
  expiresInSeconds: z.number().int().positive().optional(),
});

// The payer proves possession of the intent with its `client_secret`; the
// reported broadcast txid is what the settlement watcher then verifies on-chain.
const submitTxBodySchema = z.object({
  client_secret: z.string().min(1),
  txid: z.string().min(1),
});

/**
 * Single query owner for "find a Merchant by (oxyAppId, environment)" — no
 * side effects, no response writes. Shared by `resolveMerchant` (service-auth
 * path, below) and `resolveMerchantByApp` (dashboard path, F2.5) so there is
 * exactly one place that knows the compound key `Merchant` is looked up by.
 */
function findMerchantByAppEnv(
  oxyAppId: string,
  environment: OxyServiceEnvironment,
): Promise<MerchantRow | null> {
  return findMerchantByAppEnvironment(getDb(), oxyAppId, environment);
}

/**
 * Resolve the merchant behind the authenticated service app, scoped to BOTH
 * the caller's Application AND its credential's `environment` (F2.0 task 1b —
 * test/live isolation). Returns null AND writes the error response when the
 * caller is unauthenticated (401) or the app has no merchant registered for
 * this specific environment (403), so callers just `if (!merchant) return`.
 *
 * Exported: `routes/merchants.ts` reuses this unchanged for the merchant-authed
 * GET/PATCH `/v1/merchants/me` routes.
 */
export async function resolveMerchant(
  req: Request,
  res: Response,
): Promise<MerchantRow | null> {
  const serviceApp = requireServiceApp(req, res);
  if (!serviceApp) return null;
  const merchant = await findMerchantByAppEnv(serviceApp.appId, serviceApp.environment);
  if (!merchant) {
    sendError(res, 403, "permission_error", "no merchant registered for this app");
    return null;
  }
  return merchant;
}

/**
 * Dashboard-path sibling of `resolveMerchant` (F2.5): resolves a Merchant by
 * an EXPLICIT `(applicationId, environment)` pair instead of `req.serviceApp`,
 * since a `/v1/dashboard/*` caller is a human Oxy user, not a service-authed
 * merchant — the application + environment come from the route param + query
 * (already validated + membership-checked by `routes/dashboard.ts` before this
 * is called). 404 (not 403): the caller's ACCESS to the application was
 * already proven by `assertAppMembership`, so a missing merchant here means
 * exactly what it says — nothing registered for this environment yet, not a
 * permission gap.
 */
export async function resolveMerchantByApp(
  applicationId: string,
  environment: OxyServiceEnvironment,
  res: Response,
): Promise<MerchantRow | null> {
  const merchant = await findMerchantByAppEnv(applicationId, environment);
  if (!merchant) {
    sendError(
      res,
      404,
      "invalid_request_error",
      "no merchant registered for this application in this environment",
    );
    return null;
  }
  return merchant;
}

export interface ListPaymentIntentsQuery {
  status?: PaymentIntentStatus;
  limit?: number;
  starting_after?: string;
}

export type ListPaymentIntentsResult =
  | { ok: true; data: PaymentIntentRow[]; hasMore: boolean }
  | { ok: false; status: number; message: string };

/**
 * Shared pagination body for "list a merchant's payment intents" — factored
 * out (F2.5) so `GET /v1/payment_intents` (below) and the dashboard's `GET
 * /v1/dashboard/applications/:applicationId/payment_intents` run the EXACT
 * same query/cursor/status-filter logic against different auth paths, never
 * two copies to keep in sync.
 */
export async function listPaymentIntentsForMerchant(
  merchantId: string,
  query: ListPaymentIntentsQuery,
): Promise<ListPaymentIntentsResult> {
  const { status, starting_after } = query;
  const limit = query.limit ?? DEFAULT_LIST_LIMIT;
  const db = getDb();

  // The cursor arrives as a PUBLIC `pi_…` and the keyset walk runs on the
  // primary key, so it is resolved here — ownership-scoped, so a cursor
  // naming another merchant's intent is a 422 exactly like an unknown one and
  // never confirms that the intent exists.
  let after: string | undefined;
  if (starting_after) {
    const cursor = await findIntentForMerchant(db, starting_after, merchantId);
    if (!cursor) {
      return {
        ok: false,
        status: 422,
        message: "starting_after references an unknown payment intent",
      };
    }
    after = cursor.id;
  }

  const page = await listIntentsForMerchant(db, { merchantId, status, limit, after });
  return { ok: true, data: page.data, hasMore: page.hasMore };
}

/**
 * Build the payment-intent REST router.
 *
 * `requireMerchant` and `optionalServiceAuth` are injectable so tests can
 * bypass real Oxy service tokens with stubs that populate `req.serviceApp`;
 * in production callers must pass `oxyClient.serviceAuth({ jwtSecret })` /
 * `oxyClient.auth({ jwtSecret, optional: true })` explicitly (see
 * `server.ts`) — there is no bare default here, since those with no
 * `jwtSecret` reject (or silently drop) every real token. `requireMerchant`
 * gates the merchant-only routes; `optionalServiceAuth` gates the dual-auth
 * `GET /:id` route. `submit_tx` is the payer path and is guarded by the
 * intent's `client_secret` instead.
 */
export function createPaymentIntentsRouter(deps: {
  requireMerchant: RequestHandler;
  optionalServiceAuth: RequestHandler;
}): Router {
  const { requireMerchant, optionalServiceAuth } = deps;
  const router = Router();

  router.post(
    "/v1/payment_intents",
    requireMerchant,
    requireAuthenticated,
    oxyClient.requireScope("payments:write"),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      const idempotencyKey = req.header("Idempotency-Key")?.trim();
      if (!idempotencyKey) {
        sendError(
          res,
          400,
          "invalid_request_error",
          "Idempotency-Key header is required",
        );
        return;
      }

      const parsed = createBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(
          res,
          422,
          "invalid_request_error",
          parsed.error.issues[0]?.message ?? "invalid request body",
        );
        return;
      }
      const params: CreatePaymentIntentParams = parsed.data as CreatePaymentIntentParams;

      try {
        const { intent, reused, clientAction } = await createIntent({
          merchant,
          amount: params.amount,
          ...(params.rail !== undefined ? { rail: params.rail } : {}),
          ...(params.currency !== undefined ? { currency: params.currency } : {}),
          ...(params.network !== undefined ? { network: params.network } : {}),
          metadata: params.metadata,
          expiresInSeconds: params.expiresInSeconds,
          idempotencyKey,
        });
        res.status(reused ? 200 : 201).json({
          ...toPaymentIntentDTO(intent),
          client_secret: intent.clientSecret,
          // The card rail's next step for the PAYER's client, present only on
          // that rail and only in this response. Never on the DTO: re-reading an
          // intent tomorrow must not hand out a confirmation credential, and a
          // merchant listing their intents must not receive one per row.
          ...(clientAction ? { client_action: clientAction } : {}),
        });
      } catch (err) {
        // Data-integrity firewall (F2.0 task 1a): the watch-only address is
        // derived using the MERCHANT's network (`reserveAddress.ts`), never
        // the caller's claimed `network` — `createIntent` rejects a mismatch
        // up front, or the returned intent's `network` label would lie about
        // the network its `address` actually encodes.
        // `RailMismatchError` rides the same branch: both are a caller
        // describing a payment this gateway cannot make, and neither is a
        // server fault. Which mistake they made is in the message.
        if (err instanceof NetworkMismatchError || err instanceof RailMismatchError) {
          sendError(res, 422, "invalid_request_error", err.message);
          return;
        }
        // 503, not 422: the caller cannot fix this by sending different fields.
        // The rail they asked for is not configured on this deployment, and
        // telling them their request was invalid would send them off editing it.
        if (err instanceof RailUnavailableError) {
          sendError(res, 503, "api_error", err.message);
          return;
        }
        throw err;
      }
    }),
  );

  router.get(
    "/v1/payment_intents",
    requireMerchant,
    requireAuthenticated,
    oxyClient.requireScope("payments:read"),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        sendError(
          res,
          422,
          "invalid_request_error",
          parsed.error.issues[0]?.message ?? "invalid query",
        );
        return;
      }

      const result = await listPaymentIntentsForMerchant(merchant.id, parsed.data);
      if (!result.ok) {
        sendError(res, result.status, "invalid_request_error", result.message);
        return;
      }
      const data = result.data.map((intent) => toPaymentIntentDTO(intent));
      res.status(200).json({ object: "list", data, has_more: result.hasMore });
    }),
  );

  router.get(
    "/v1/payment_intents/:id",
    optionalServiceAuth,
    wrap(async (req, res) => {
      const { serviceApp } = req as OxyAuthRequest;

      // `noUncheckedIndexedAccess` types `req.params.id` as possibly
      // `undefined` even though Express guarantees `:id` is present here.
      // Read once, above the branch, because BOTH the merchant path and the
      // payer path below need it.
      const { id } = req.params;
      if (!id) {
        sendError(res, 422, "invalid_request_error", "id is required");
        return;
      }

      if (serviceApp?.appId) {
        // Merchant path — same `payments:read` requirement as the list route
        // (F2.0 gateway-review finding: this branch previously enforced no
        // scope at all). Can't use `oxyClient.requireScope()` as ordinary
        // route middleware here — that would also gate the payer/client_secret
        // branch below, which has no service token to check — so the SAME
        // scope-checking primitive is invoked manually, scoped to just this
        // branch.
        let scopeGranted = false;
        oxyClient.requireScope("payments:read")(req, res, () => {
          scopeGranted = true;
        });
        if (!scopeGranted) return;

        const merchant = await resolveMerchant(req, res);
        if (!merchant) return;
        const intent = await findIntentForMerchant(getDb(), id, merchant.id);
        if (!intent) {
          sendError(res, 404, "invalid_request_error", "payment intent not found");
          return;
        }
        res.status(200).json(toPaymentIntentDTO(intent));
        return;
      }

      // Payer path — authorized by possession of the intent's `client_secret`,
      // the same idiom `submit_tx` and the socket `subscribe` already use.
      // Needed for a hosted checkout page's initial REST snapshot before its
      // socket subscription confirms (F2.0 task 3).
      const clientSecretParam = req.query.client_secret;
      const clientSecret =
        typeof clientSecretParam === "string"
          ? clientSecretParam
          : req.header("X-Peable-Client-Secret");
      if (!clientSecret) {
        sendError(
          res,
          401,
          "authentication_error",
          "missing service app credentials or client_secret",
        );
        return;
      }

      const intent = await findIntentByPublicId(getDb(), id);
      if (!intent) {
        sendError(res, 404, "invalid_request_error", "payment intent not found");
        return;
      }
      if (!verifySecret(clientSecret, intent.clientSecret)) {
        sendError(res, 403, "permission_error", "invalid client_secret");
        return;
      }
      res.status(200).json(toPaymentIntentDTO(intent));
    }),
  );

  router.post(
    "/v1/payment_intents/:id/reject",
    requireMerchant,
    requireAuthenticated,
    oxyClient.requireScope("payments:write"),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      // `noUncheckedIndexedAccess` types `req.params.id` as possibly
      // `undefined` even though Express guarantees `:id` is present here. The
      // repositories take a `string`, so the guard is explicit rather than a
      // non-null assertion.
      const { id } = req.params;
      if (!id) {
        sendError(res, 422, "invalid_request_error", "id is required");
        return;
      }

      const intent = await findIntentForMerchant(getDb(), id, merchant.id);
      if (!intent) {
        sendError(res, 404, "invalid_request_error", "payment intent not found");
        return;
      }

      let nextStatus: PaymentIntentStatus;
      try {
        nextStatus = applyEvent(intent.status, "reject");
      } catch (err) {
        sendError(
          res,
          409,
          "invalid_request_error",
          err instanceof Error ? err.message : "illegal state transition",
        );
        return;
      }
      // `transitionIntent`, not `updateIntentState`. This route mutated the
      // status and returned, so `payment_intent.rejected` was emitted by NO
      // path a merchant could trigger — the only way to see one was the
      // settlement watcher, which never produces that status, or a manual
      // redelivery of a row that therefore never existed. The event type has
      // been in the published contract since the first release.
      const rejected = await transitionIntent(intent.id, {
        from: intent.status,
        status: nextStatus,
      });
      if (rejected.kind !== "updated") {
        sendStaleOrMissing(res, rejected);
        return;
      }
      announceIntentChange(rejected.row);
      res.status(200).json(toPaymentIntentDTO(rejected.row));
    }),
  );

  // Payer path — NOT merchant-authed. Possession of the intent's `client_secret`
  // is the authorization; the reported txid is handed to the settlement watcher.
  router.post(
    "/v1/payment_intents/:id/submit_tx",
    wrap(async (req, res) => {
      const parsed = submitTxBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(
          res,
          422,
          "invalid_request_error",
          parsed.error.issues[0]?.message ?? "invalid request body",
        );
        return;
      }

      // `noUncheckedIndexedAccess` types `req.params.id` as possibly
      // `undefined` even though Express guarantees `:id` is present here. The
      // repositories take a `string`, so the guard is explicit rather than a
      // non-null assertion.
      const { id } = req.params;
      if (!id) {
        sendError(res, 422, "invalid_request_error", "id is required");
        return;
      }

      const intent = await findIntentByPublicId(getDb(), id);
      if (!intent) {
        sendError(res, 404, "invalid_request_error", "payment intent not found");
        return;
      }

      if (!verifySecret(parsed.data.client_secret, intent.clientSecret)) {
        sendError(res, 403, "permission_error", "invalid client_secret");
        return;
      }

      let nextStatus: PaymentIntentStatus;
      try {
        nextStatus = applyEvent(intent.status, "broadcast");
      } catch (err) {
        sendError(
          res,
          409,
          "invalid_request_error",
          err instanceof Error ? err.message : "illegal state transition",
        );
        return;
      }
      // Status and txid move in ONE statement: `payment_intents_broadcast_requires_txid_check`
      // refuses `broadcast` without the txid beside it, so two writes could not
      // satisfy the constraint in either order.
      //
      // `broadcast` maps to no webhook event — a merchant acts on outcomes, not
      // on a payer pressing send — so `transitionIntent` enqueues nothing here.
      // It is still the right entry point: the announce below is what puts the
      // "payment sent, waiting to be seen on-chain" frame on the payer's own
      // checkout page, which this route previously left to the next poll.
      const broadcast = await transitionIntent(intent.id, {
        from: intent.status,
        status: nextStatus,
        txid: parsed.data.txid,
      });
      if (broadcast.kind !== "updated") {
        sendStaleOrMissing(res, broadcast);
        return;
      }
      announceIntentChange(broadcast.row);
      res.status(200).json(toPaymentIntentDTO(broadcast.row));
    }),
  );

  return router;
}
