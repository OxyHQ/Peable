import { Router } from "express";
import type { RequestHandler } from "express";
import { z } from "zod";
import { oxyClient } from "@oxy.so/core";
import type { CreatePaymentLinkParams } from "@peable.to/shared-types";
import { getDb } from "../db/postgres";
import { findMerchantById } from "../db/merchants/merchantRepository";
import {
  findLinkByPublicId,
  findLinkForMerchant,
  insertPaymentLink,
  listLinksForMerchant,
  updatePaymentLink,
} from "../db/payments/paymentLinkRepository";
import {
  createIntent,
  NetworkMismatchError,
  RailMismatchError,
  RailUnavailableError,
  assertRailAvailable,
  resolveRail,
} from "../services/createIntent";
import { resolveMerchantDisplay } from "../services/merchantDisplay";
import { newId } from "../lib/ids";
import { toPaymentLinkDTO, toPublicPaymentLinkDTO, toPaymentIntentDTO } from "../lib/serialize";
import { sendError, wrap, requireAuthenticated } from "../lib/http";
import { resolveMerchant } from "./paymentIntents";
import { railBodyFields } from "../lib/railSchema";

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_LIST_LIMIT).optional(),
  starting_after: z.string().optional(),
});

const createBodySchema = z.object({
  ...railBodyFields,
  metadata: z.record(z.string(), z.string()).optional(),
  successUrl: z.string().url().optional(),
});

// Only `active`/`metadata`/`successUrl` are mutable — a link's price must be
// immutable once shared, so `amount`/`network` are deliberately absent here.
const patchBodySchema = z.object({
  active: z.boolean().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  successUrl: z.string().url().nullable().optional(),
});

/**
 * Build the payment-link REST router (F2.3). Merchant CRUD routes follow the
 * exact auth/scope chain as `paymentIntents.ts`/`merchants.ts`; the two
 * `/public` and `/payment_intent` routes are UNAUTHENTICATED payer paths,
 * gated only by the injected `publicRateLimit` — never a service token, since
 * an anonymous checkout-page visitor has none.
 */
export function createPaymentLinksRouter(deps: {
  requireMerchant: RequestHandler;
  publicRateLimit: RequestHandler;
}): Router {
  const { requireMerchant, publicRateLimit } = deps;
  const router = Router();

  router.post(
    "/v1/payment_links",
    requireMerchant,
    requireAuthenticated,
    oxyClient.requireScope("payments:write"),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

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
      const params: CreatePaymentLinkParams = parsed.data as CreatePaymentLinkParams;

      // Same data-integrity firewall as `createIntent`'s network check
      // (F2.0 task 1a): a link's `network` must match the merchant it was
      // created under, since every intent it later mints derives its
      // watch-only address from THIS merchant's xpub.
      //
      // Delegated to `resolveRail` rather than re-checked here, because the
      // rules a link must satisfy are exactly the rules its future intents must
      // satisfy — and a link storing a combination `createIntent` would refuse
      // is a price a payer can see and can never pay.
      let resolved;
      try {
        resolved = resolveRail(merchant, params);
        // ...and the same argument one step further: a link is a URL a merchant
        // SENDS to customers, so a rail this deployment cannot serve has to be
        // refused here, to the merchant, rather than at mint time to a payer
        // who is already looking at the price.
        assertRailAvailable(resolved.rail);
      } catch (err) {
        if (err instanceof NetworkMismatchError || err instanceof RailMismatchError) {
          sendError(res, 422, "invalid_request_error", err.message);
          return;
        }
        if (err instanceof RailUnavailableError) {
          sendError(res, 503, "api_error", err.message);
          return;
        }
        throw err;
      }

      // Explicit field whitelist — never spread `req.body`. `active` takes its
      // column default of true rather than being passed: a caller does not get
      // to mint a link that is already disabled.
      const link = await insertPaymentLink(getDb(), {
        publicId: newId("link"),
        merchantId: merchant.id,
        oxyAppId: merchant.oxyAppId,
        environment: merchant.environment,
        amount: params.amount,
        currency: resolved.currency,
        rail: resolved.rail,
        network: resolved.network,
        metadata: params.metadata ?? {},
        successUrl: params.successUrl,
      });

      res.status(201).json(toPaymentLinkDTO(link));
    }),
  );

  router.get(
    "/v1/payment_links",
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
      const { starting_after } = parsed.data;
      const limit = parsed.data.limit ?? DEFAULT_LIST_LIMIT;

      const db = getDb();

      // The cursor arrives as a public `link_…`; the keyset walk runs on the
      // primary key, so it is resolved here, ownership-scoped — a cursor
      // naming another merchant's link is a 422 exactly like an unknown one.
      let after: string | undefined;
      if (starting_after) {
        const cursor = await findLinkForMerchant(db, starting_after, merchant.id);
        if (!cursor) {
          sendError(
            res,
            422,
            "invalid_request_error",
            "starting_after references an unknown payment link",
          );
          return;
        }
        after = cursor.id;
      }

      const page = await listLinksForMerchant(db, { merchantId: merchant.id, limit, after });
      const data = page.data.map((link) => toPaymentLinkDTO(link));

      res.status(200).json({ object: "list", data, has_more: page.hasMore });
    }),
  );

  router.get(
    "/v1/payment_links/:id",
    requireMerchant,
    requireAuthenticated,
    oxyClient.requireScope("payments:read"),
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

      const link = await findLinkForMerchant(getDb(), id, merchant.id);
      if (!link) {
        sendError(res, 404, "invalid_request_error", "payment link not found");
        return;
      }
      res.status(200).json(toPaymentLinkDTO(link));
    }),
  );

  router.patch(
    "/v1/payment_links/:id",
    requireMerchant,
    requireAuthenticated,
    oxyClient.requireScope("payments:write"),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      const parsed = patchBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(
          res,
          422,
          "invalid_request_error",
          parsed.error.issues[0]?.message ?? "invalid request body",
        );
        return;
      }
      const params = parsed.data;

      // The patch is scoped to the merchant in the SAME statement that applies
      // it, so a link the caller does not own is never read and never written;
      // `null` covers both "no such link" and "not yours", which is why both
      // answer 404.
      // `noUncheckedIndexedAccess` types `req.params.id` as possibly
      // `undefined` even though Express guarantees `:id` is present here. The
      // repositories take a `string`, so the guard is explicit rather than a
      // non-null assertion.
      const { id } = req.params;
      if (!id) {
        sendError(res, 422, "invalid_request_error", "id is required");
        return;
      }

      const link = await updatePaymentLink(getDb(), id, merchant.id, params);
      if (!link) {
        sendError(res, 404, "invalid_request_error", "payment link not found");
        return;
      }
      res.status(200).json(toPaymentLinkDTO(link));
    }),
  );

  // Public payer path — UNAUTHENTICATED, rate-limited. Returns only
  // payer-safe fields (no metadata/successUrl/internal ids). Still returns
  // `active: false` links (never 404s an inactive link) so the checkout page
  // can render a "link disabled" state instead of a generic not-found.
  router.get(
    "/v1/payment_links/:id/public",
    publicRateLimit,
    wrap(async (req, res) => {
      // `noUncheckedIndexedAccess` types `req.params.id` as possibly
      // `undefined` even though Express guarantees `:id` is present here. The
      // repositories take a `string`, so the guard is explicit rather than a
      // non-null assertion.
      const { id } = req.params;
      if (!id) {
        sendError(res, 422, "invalid_request_error", "id is required");
        return;
      }

      const db = getDb();
      const link = await findLinkByPublicId(db, id);
      if (!link) {
        sendError(res, 404, "invalid_request_error", "payment link not found");
        return;
      }
      const merchant = await findMerchantById(db, link.merchantId);
      if (!merchant) {
        sendError(res, 404, "invalid_request_error", "payment link not found");
        return;
      }
      const merchantDisplay = await resolveMerchantDisplay(merchant);
      res.status(200).json(toPublicPaymentLinkDTO(link, merchantDisplay));
    }),
  );

  // Public payer path — UNAUTHENTICATED, rate-limited. Mints a FRESH intent
  // every call (the checkout page owns reuse-if-open via sessionStorage); every
  // value comes from the STORED link, never the caller, so a public caller can
  // never mint an intent for an amount/network/merchant it doesn't control.
  router.post(
    "/v1/payment_links/:id/payment_intent",
    publicRateLimit,
    wrap(async (req, res) => {
      // `noUncheckedIndexedAccess` types `req.params.id` as possibly
      // `undefined` even though Express guarantees `:id` is present here. The
      // repositories take a `string`, so the guard is explicit rather than a
      // non-null assertion.
      const { id } = req.params;
      if (!id) {
        sendError(res, 422, "invalid_request_error", "id is required");
        return;
      }

      const db = getDb();
      const link = await findLinkByPublicId(db, id);
      if (!link) {
        sendError(res, 404, "invalid_request_error", "payment link not found");
        return;
      }
      if (!link.active) {
        sendError(res, 422, "invalid_request_error", "payment link is no longer active");
        return;
      }
      const merchant = await findMerchantById(db, link.merchantId);
      if (!merchant) {
        sendError(res, 404, "invalid_request_error", "payment link not found");
        return;
      }

      try {
        const { intent, clientAction } = await createIntent({
          merchant,
          amount: link.amount,
          rail: link.rail,
          currency: link.currency,
          // `?? undefined` rather than passing the null through: `createIntent`
          // distinguishes "no network given" (legal on the card rail) from a
          // network it must validate, and a null would be neither.
          ...(link.network !== null ? { network: link.network } : {}),
          metadata: link.metadata,
        });
        res.status(201).json({
          ...toPaymentIntentDTO(intent),
          client_secret: intent.clientSecret,
          // The payer is anonymous here and this is their only chance to be
          // handed the card rail's next step — there is no authenticated read
          // they could make later to fetch it.
          ...(clientAction ? { client_action: clientAction } : {}),
        });
      } catch (err) {
        // Structurally unreachable today (a link's `network` is validated
        // against its merchant at creation, and `Merchant.network` has no
        // mutation route) — kept as a defensive translation, same as every
        // other `createIntent` caller, rather than letting it fall through
        // to a bare 500 if that invariant is ever loosened.
        if (err instanceof NetworkMismatchError || err instanceof RailMismatchError) {
          sendError(res, 422, "invalid_request_error", err.message);
          return;
        }
        // 503, not 422: the rail is not configured on this deployment, which is
        // not something the caller can fix by sending different fields.
        if (err instanceof RailUnavailableError) {
          sendError(res, 503, "api_error", err.message);
          return;
        }
        throw err;
      }
    }),
  );

  return router;
}
