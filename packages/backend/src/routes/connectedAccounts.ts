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
import { ProviderError } from "../services/providers/provider";
import { redactProviderMessage } from "../services/providers/redact";
import { toConnectedAccountDTO } from "../lib/serializeSettlement";
import { requireAuthenticated, sendError, wrap } from "../lib/http";
import { resolveMerchant } from "./paymentIntents";

/** How many accounts one list call may return. */
const LIST_LIMIT = 100;

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

/** Turn a provider failure into an HTTP answer without leaking its text raw. */
function sendProviderError(res: Parameters<typeof sendError>[0], error: ProviderError): void {
  // 502 for a retryable provider fault and 422 for a permanent refusal. The
  // distinction is the merchant's to act on: one means try again, the other
  // means the request as sent will never work.
  sendError(
    res,
    error.retryable ? 502 : 422,
    error.retryable ? "api_error" : "invalid_request_error",
    redactProviderMessage(error.message),
  );
}

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

      const parsed = createAccountBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 422, "invalid_request_error", parsed.error.issues[0]?.message ?? "invalid body");
        return;
      }

      try {
        const { account, created } = await ensureConnectedAccount({
          merchantId: merchant.id,
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

      const rows = await listAccountsForMerchant(getDb(), merchant.id, LIST_LIMIT);
      res.status(200).json({ object: "list", data: rows.map(toConnectedAccountDTO) });
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
        res.status(200).json(toConnectedAccountDTO(await refreshConnectedAccount(account)));
      } catch (error) {
        if (error instanceof AccountsUnavailableError) {
          sendError(res, 503, "api_error", error.message);
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
