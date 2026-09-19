/**
 * The seller-account surface: `/v1/connected_accounts`.
 *
 * Merchant-authed throughout. Every route resolves the merchant from the
 * service credential and scopes its lookup to it — never "find by id, then
 * check the owner", which is the shape that leaks one marketplace's sellers to
 * another the day someone forgets the second half.
 */
import { Router } from "express";
import type { RequestHandler } from "express";
import { z } from "zod";
import { oxyClient } from "@oxy.so/core";
import { getDb } from "../db/postgres";
import {
  findAccountByExternalRef,
  findAccountByPublicId,
  listAccountsForMerchant,
} from "../db/accounts/connectedAccountRepository";
import {
  AccountsUnavailableError,
  createAccountLink,
  ensureConnectedAccount,
  refreshConnectedAccount,
} from "../services/accounts/connectedAccountService";
import { EnvironmentModeMismatchError } from "../services/providers/environmentGuard";
import { ProviderError } from "../services/providers/provider";
import { toConnectedAccountDTO } from "../lib/serializeSettlement";
import {
  requireAuthenticated,
  requireProviderMode,
  sendEnvironmentMismatch,
  sendError,
  sendProviderError,
  wrap,
} from "../lib/http";
import { resolveMerchant } from "./paymentIntents";

/** How many accounts one list call returns when the caller does not say. */
const DEFAULT_LIST_LIMIT = 25;
/** ...and the most it will return however large a `limit` is asked for. */
const MAX_LIST_LIMIT = 100;

/**
 * Mirrors the payment-intent list query, deliberately: a merchant paginating
 * two collections in one integration should not have to learn two shapes.
 */
const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_LIST_LIMIT).optional(),
  starting_after: z.string().optional(),
});

const createAccountBodySchema = z.object({
  /**
   * The merchant's own id for the seller. Bounded because it is a key: an
   * unbounded string here is an unbounded index entry and an unbounded response
   * field.
   */
  externalRef: z.string().min(1).max(255),
  /** ISO-3166-1 alpha-2. Case-insensitive in; upper-cased before storage. */
  country: z.string().length(2),
  businessType: z.enum(["individual", "company"]),
});

const accountLinkBodySchema = z.object({
  refreshUrl: z.string().url(),
  returnUrl: z.string().url(),
});

export function createConnectedAccountsRouter(deps: {
  requireMerchant: RequestHandler;
}): Router {
  const router = Router();
  const { requireMerchant } = deps;

  /**
   * Open (or return) the account for one seller.
   *
   * Answers 200 for an account that already existed and 201 for one just
   * opened, so a merchant can tell a converged retry from a real creation —
   * which matters here more than usual, because the underlying object cannot be
   * deleted and "did I just open a second one" is a question they will ask.
   */
  router.post(
    "/v1/connected_accounts",
    requireMerchant,
    requireAuthenticated,
    oxyClient.requireScope("payments:write"),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      if (!requireProviderMode(merchant.environment, res)) return;

      const parsed = createAccountBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 422, "invalid_request_error", parsed.error.issues[0]?.message ?? "invalid body");
        return;
      }

      try {
        const { account, created } = await ensureConnectedAccount({
          merchantId: merchant.id,
          environment: merchant.environment,
          externalRef: parsed.data.externalRef,
          country: parsed.data.country,
          businessType: parsed.data.businessType,
        });
        res.status(created ? 201 : 200).json(toConnectedAccountDTO(account));
      } catch (error) {
        if (error instanceof AccountsUnavailableError) {
          sendError(res, 503, "api_error", error.message);
          return;
        }
        if (error instanceof EnvironmentModeMismatchError) {
          sendEnvironmentMismatch(res, error.message);
          return;
        }
        if (error instanceof ProviderError) {
          sendProviderError(res, error);
          return;
        }
        throw error;
      }
    }),
  );

  /** Every seller this merchant has onboarded. */
  router.get(
    "/v1/connected_accounts",
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

      const db = getDb();
      /**
       * The cursor arrives as a PUBLIC `ca_…` and the keyset walk runs on the
       * primary key, so it is resolved here — ownership-scoped, so a cursor
       * naming ANOTHER merchant's seller is a 422 exactly like an unknown one
       * and never confirms that the account exists.
       */
      let after: string | undefined;
      if (parsed.data.starting_after) {
        const cursor = await findAccountByPublicId(db, merchant.id, parsed.data.starting_after);
        if (!cursor) {
          sendError(
            res,
            422,
            "invalid_request_error",
            "starting_after references an unknown connected account",
          );
          return;
        }
        after = cursor.id;
      }

      const page = await listAccountsForMerchant(
        db,
        merchant.id,
        parsed.data.limit ?? DEFAULT_LIST_LIMIT,
        after,
      );
      // `has_more` rather than a silently truncated list: this route used to
      // return at most 100 sellers with nothing saying there were more, and a
      // caller reconciling against it concludes the rest are gone.
      res.status(200).json({
        object: "list",
        data: page.data.map(toConnectedAccountDTO),
        has_more: page.hasMore,
      });
    }),
  );

  /**
   * One seller, by the merchant's own id for them.
   *
   * By `external_ref` and NOT by `ca_…`, deliberately: the merchant already has
   * their own id and may well have lost the `ca_…` (a create whose response
   * never arrived). Making the durable address the primary one is what keeps
   * recovery possible without a list scan.
   */
  router.get(
    "/v1/connected_accounts/by_ref/:externalRef",
    requireMerchant,
    requireAuthenticated,
    oxyClient.requireScope("payments:read"),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      // `noUncheckedIndexedAccess` types a route param as possibly undefined
      // even though Express guarantees it is present on a matched route.
      const { externalRef } = req.params;
      if (!externalRef) {
        sendError(res, 422, "invalid_request_error", "externalRef is required");
        return;
      }

      const account = await findAccountByExternalRef(getDb(), merchant.id, externalRef);
      if (!account) {
        sendError(res, 404, "invalid_request_error", "connected account not found");
        return;
      }
      res.status(200).json(toConnectedAccountDTO(account));
    }),
  );

  router.get(
    "/v1/connected_accounts/:accountId",
    requireMerchant,
    requireAuthenticated,
    oxyClient.requireScope("payments:read"),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      const { accountId } = req.params;
      if (!accountId) {
        sendError(res, 422, "invalid_request_error", "accountId is required");
        return;
      }

      const account = await findAccountByPublicId(getDb(), merchant.id, accountId);
      if (!account) {
        sendError(res, 404, "invalid_request_error", "connected account not found");
        return;
      }
      res.status(200).json(toConnectedAccountDTO(account));
    }),
  );

  /**
   * Re-read this account from the provider now.
   *
   * `payments:write` rather than `:read`, because it costs a provider call and
   * a merchant looping it is a rate-limit problem at the provider rather than
   * here. The sweep and the inbound event keep it fresh without anyone asking;
   * this is for a seller staring at a dashboard.
   */
  router.post(
    "/v1/connected_accounts/:accountId/refresh",
    requireMerchant,
    requireAuthenticated,
    oxyClient.requireScope("payments:write"),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      if (!requireProviderMode(merchant.environment, res)) return;

      const { accountId } = req.params;
      if (!accountId) {
        sendError(res, 422, "invalid_request_error", "accountId is required");
        return;
      }

      const account = await findAccountByPublicId(getDb(), merchant.id, accountId);
      if (!account) {
        sendError(res, 404, "invalid_request_error", "connected account not found");
        return;
      }

      try {
        res
          .status(200)
          .json(toConnectedAccountDTO(await refreshConnectedAccount(account, merchant.environment)));
      } catch (error) {
        if (error instanceof AccountsUnavailableError) {
          sendError(res, 503, "api_error", error.message);
          return;
        }
        if (error instanceof EnvironmentModeMismatchError) {
          sendEnvironmentMismatch(res, error.message);
          return;
        }
        if (error instanceof ProviderError) {
          sendProviderError(res, error);
          return;
        }
        throw error;
      }
    }),
  );

  /**
   * A hosted onboarding link.
   *
   * Minted on demand and never stored: these expire in minutes at the provider,
   * so a stored one is a link that has already died by the time a seller
   * follows it — and the failure looks like the seller's fault.
   */
  router.post(
    "/v1/connected_accounts/:accountId/account_links",
    requireMerchant,
    requireAuthenticated,
    oxyClient.requireScope("payments:write"),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      if (!requireProviderMode(merchant.environment, res)) return;

      const parsed = accountLinkBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 422, "invalid_request_error", parsed.error.issues[0]?.message ?? "invalid body");
        return;
      }

      const { accountId } = req.params;
      if (!accountId) {
        sendError(res, 422, "invalid_request_error", "accountId is required");
        return;
      }

      const account = await findAccountByPublicId(getDb(), merchant.id, accountId);
      if (!account) {
        sendError(res, 404, "invalid_request_error", "connected account not found");
        return;
      }

      try {
        const link = await createAccountLink({
          environment: merchant.environment,
          account,
          refreshUrl: parsed.data.refreshUrl,
          returnUrl: parsed.data.returnUrl,
        });
        res.status(201).json({
          object: "account_link",
          url: link.url,
          expiresAt: link.expiresAt.toISOString(),
        });
      } catch (error) {
        if (error instanceof AccountsUnavailableError) {
          sendError(res, 503, "api_error", error.message);
          return;
        }
        if (error instanceof EnvironmentModeMismatchError) {
          sendEnvironmentMismatch(res, error.message);
          return;
        }
        if (error instanceof ProviderError) {
          sendProviderError(res, error);
          return;
        }
        throw error;
      }
    }),
  );

  return router;
}
