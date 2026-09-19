import { Router } from "express";
import type {
  Request,
  RequestHandler,
  Response,
} from "express";
import { z } from "zod";
import { oxyClient } from "@oxy.so/core";
import { verifySecret } from "@oxy.so/core/server";
import type { OxyAuthRequest, OxyServiceEnvironment } from "@oxy.so/core/server";
import {
  PAYMENT_INTENT_STATUSES,
  canStillBePaid,
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
  IdempotencyConflictError,
  NetworkMismatchError,
  RailMismatchError,
  RailUnavailableError,
} from "../services/createIntent";
import { EnvironmentModeMismatchError } from "../services/providers/environmentGuard";
import { redactProviderMessage } from "../services/providers/redact";
import { cancelCardPaymentAtProvider } from "../services/cardCancellation";
import { reconcileIntentWithProvider } from "../services/intentReconciliation";
import { resolveClientAction } from "../services/clientAction";
import { applyEvent } from "../services/intentState";
import { announceIntentChange, transitionIntent } from "../services/intentTransition";
import { toPaymentIntentDTO } from "../lib/serialize";
import {
  sendEnvironmentMismatch,
  sendError,
  wrap,
  requireServiceApp,
  requireAuthenticated,
} from "../lib/http";
import { railBodyFields } from "../lib/railSchema";

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

/**
 * The payer's capability token, from the header or the query.
 *
 * The HEADER is preferred and the query param is accepted because the hosted
 * checkout's first REST snapshot has historically used it. Kept in one function
 * so the three payer-authorized routes read it identically — a route that
 * looked only at the query would silently reject every caller using the header,
 * and vice versa.
 */
function readClientSecret(req: Request): string | undefined {
  const fromQuery = req.query.client_secret;
  if (typeof fromQuery === "string" && fromQuery.length > 0) return fromQuery;
  return req.header("X-Peable-Client-Secret") ?? undefined;
}

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
        // A development or staging credential asking a live deployment for a
        // card payment. Refused before Stripe was called at all.
        if (err instanceof EnvironmentModeMismatchError) {
          sendEnvironmentMismatch(res, err.message);
          return;
        }
        // The key is in use for a DIFFERENT operation. Neither a bad request
        // nor a success: answering 200 with the stored intent would tell the
        // caller their new payment exists, and they would wait for money
        // against an amount they never asked for.
        if (err instanceof IdempotencyConflictError) {
          sendError(res, 409, "invalid_request_error", err.message);
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

        /**
         * A single merchant read of a still-payable CARD intent carries the
         * client action; a list never does.
         *
         * This is the resume path a server-side integrator already writes:
         * Mercaria's adapter re-reads the intent expecting `client_action` and
         * found nothing, so a buyer returning to an unpaid checkout the next
         * day got a SECOND payment rather than the one that already funds their
         * order. `POST …/client_action` is the explicit operation; this makes
         * the obvious call work too.
         *
         * Bounded three ways, because the field is a credential: ONE intent
         * named explicitly (never a list), only while the payment can still be
         * paid, and `Cache-Control: no-store` so nothing in front of this route
         * keeps a copy.
         */
        const action =
          intent.rail === "card" && canStillBePaid(intent.status)
            ? await resolveClientAction(intent)
            : { kind: "not_applicable" as const };
        if (action.kind === "ok") res.setHeader("Cache-Control", "no-store");

        res.status(200).json({
          ...toPaymentIntentDTO(intent),
          ...(action.kind === "ok" ? { client_action: action.action } : {}),
        });
        return;
      }

      // Payer path — authorized by possession of the intent's `client_secret`,
      // the same idiom `submit_tx` and the socket `subscribe` already use.
      // Needed for a hosted checkout page's initial REST snapshot before its
      // socket subscription confirms (F2.0 task 3).
      //
      // Deliberately carries NO client action, unlike the merchant branch
      // above: this response is the one a checkout page polls, and a credential
      // on a polled response is a credential in a browser's cache and in every
      // intermediary's logs. The payer asks for it explicitly, once, through
      // `POST …/client_action`.
      const clientSecret = readClientSecret(req);
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

  /**
   * What the payer's client must do next — the RESUME operation.
   *
   * ## Why a POST, and why its own route
   *
   * The DTO carries no client action on purpose: a client secret is a
   * confirmation credential, and putting one on the payment-intent shape would
   * hand it out on every list and every re-read. That left no way to resume,
   * so a payer who refreshed the page or came back from an SCA challenge in a
   * new tab had nothing to confirm with — and the only way to get one was to
   * create a second payment.
   *
   * POST rather than GET because the credential must not reach a URL. A GET
   * response is cacheable by anything in front of it, and the path lands in
   * access logs; this answers with `Cache-Control: no-store` and keeps the
   * secret in a body.
   *
   * ## Either party may ask, and neither is the other
   *
   * The MERCHANT proves it with their service token, which is how a
   * server-side integrator resumes a buyer's checkout. The PAYER proves it with
   * the intent's own `client_secret` — the same capability `submit_tx` and the
   * socket `subscribe` already take. The two secrets are different things:
   * Peable's is a capability over the intent, the provider's is a credential
   * over the payment, and nothing here derives one from the other.
   */
  router.post(
    "/v1/payment_intents/:id/client_action",
    optionalServiceAuth,
    wrap(async (req, res) => {
      const { id } = req.params;
      if (!id) {
        sendError(res, 422, "invalid_request_error", "id is required");
        return;
      }

      const { serviceApp } = req as OxyAuthRequest;
      let intent: PaymentIntentRow | null;

      if (serviceApp?.appId) {
        let scopeGranted = false;
        oxyClient.requireScope("payments:read")(req, res, () => {
          scopeGranted = true;
        });
        if (!scopeGranted) return;
        const merchant = await resolveMerchant(req, res);
        if (!merchant) return;
        intent = await findIntentForMerchant(getDb(), id, merchant.id);
      } else {
        const clientSecret = readClientSecret(req);
        if (!clientSecret) {
          sendError(
            res,
            401,
            "authentication_error",
            "missing service app credentials or client_secret",
          );
          return;
        }
        intent = await findIntentByPublicId(getDb(), id);
        if (intent && !verifySecret(clientSecret, intent.clientSecret)) {
          sendError(res, 403, "permission_error", "invalid client_secret");
          return;
        }
      }

      if (!intent) {
        sendError(res, 404, "invalid_request_error", "payment intent not found");
        return;
      }

      // Never cached, never revalidated, and never stored by anything in
      // between. The body carries a credential.
      res.setHeader("Cache-Control", "no-store");

      const outcome = await resolveClientAction(intent);
      if (outcome.kind === "ok") {
        res.status(200).json({ object: "client_action", ...outcome.action });
        return;
      }
      if (outcome.kind === "not_applicable") {
        // The FairCoin rail. The next step is "send coins to `address`", which
        // the intent already says — a 422 rather than an empty 200, so a client
        // that asked the wrong question learns that rather than waiting.
        sendError(
          res,
          422,
          "invalid_request_error",
          "this payment needs no client action; its address is on the intent",
        );
        return;
      }
      if (outcome.kind === "unpayable") {
        sendError(
          res,
          409,
          "invalid_request_error",
          `this payment is '${outcome.status}' and can no longer be paid`,
        );
        return;
      }
      sendError(res, 503, "api_error", outcome.error);
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

      /**
       * Cancel at the PROVIDER first, and only then announce it.
       *
       * This route used to move the row and emit `payment_intent.rejected`
       * while the acquirer knew nothing: the payer's browser still held a live
       * confirmation credential for a PaymentIntent that remained confirmable,
       * so a payment the merchant had been told was rejected could complete
       * minutes later — against an intent in a terminal status, for an order
       * already released.
       *
       * The cancellation can LOSE, and the answers are not symmetric:
       *
       *  - `settled` means the payer confirmed first. The gateway reconciles to
       *    the truth and answers 409 rather than announcing a cancellation it
       *    cannot deliver.
       *  - `unknown` means the provider could not be reached. The payment is
       *    still live and its state is unknown, so nothing is written: a 502
       *    tells the merchant to try again, which is the only safe answer.
       *  - `nothing_to_cancel` is the FairCoin rail, where there is no provider
       *    and the local transition has always been the whole of it.
       */
      const cancellation = await cancelCardPaymentAtProvider(
        intent,
        // Derived from the intent's own id, so a retry after a lost response
        // presents the same key rather than being a second operation.
        `cancel:${intent.publicId}`,
      );
      if (cancellation.kind === "settled") {
        const reconciled = await reconcileIntentWithProvider(intent);
        sendError(
          res,
          409,
          "invalid_request_error",
          "this payment was completed by the payer before it could be rejected" +
            (reconciled.kind === "applied" || reconciled.kind === "agreed"
              ? `; it is '${reconciled.status}'`
              : ""),
        );
        return;
      }
      if (cancellation.kind === "in_flight") {
        // The provider did not cancel it, and still has it in flight. Rejecting
        // locally here is the exact failure this call exists to prevent: the
        // payer can still complete a payment the merchant has been told is
        // rejected.
        sendError(
          res,
          409,
          "invalid_request_error",
          `the provider still has this payment in flight ('${cancellation.status}'); it cannot be rejected yet`,
        );
        return;
      }
      if (cancellation.kind === "unknown") {
        sendError(
          res,
          502,
          "api_error",
          `the payment could not be cancelled at the provider: ${redactProviderMessage(cancellation.error)}`,
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
