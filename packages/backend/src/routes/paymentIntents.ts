/**
 * PaymentIntents (`pi_…`, ADR 0019) — Stripe's surface over the FairCoin and
 * card rails.
 *
 * Every request schema is the contract's (`@peable.to/contracts`
 * `paymentIntentRoutes`): this file validates with those objects and decides
 * nothing about the wire's shape.
 */
import {
  FaircoinNetworkClosedError,
  FaircoinWalletMissingError,
} from '../services/faircoin/recipient';
import { FaircoinCapacityError } from '../services/faircoin/addressPool';
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { verifySecret } from '@oxy.so/core/server';
import type { OxyAuthRequest, OxyServiceEnvironment } from '@oxy.so/core/server';
import { randomUUID } from 'node:crypto';
import {
  METADATA_LIMIT_MESSAGE,
  cancelPaymentIntentParams,
  capturePaymentIntentParams,
  clientSecretQuery,
  confirmPaymentIntentParams,
  createPaymentIntentParams,
  listPaymentIntentsQuery,
  retrievePaymentIntentQuery,
  submitPaymentIntentTxParams,
  toShipping,
  updatePaymentIntentParams,
} from '@peable.to/contracts';
import type { PaymentIntentStatus } from '@peable.to/shared-types';
import { getDb } from '../db/postgres';
import {
  findMerchantByAppEnvironment,
  syncMerchantAuthority,
} from '../db/merchants/merchantRepository';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import {
  findIntentById,
  findIntentByPublicId,
  findIntentForMerchant,
  listIntentsForMerchant,
  updateIntentDetails,
} from '../db/payments/paymentIntentRepository';
import { findLiveCustomerForMerchant } from '../db/customers/customerRepository';
import { findPaymentMethodForMerchant } from '../db/customers/paymentMethodRepository';
import type { IntentStateResult, PaymentIntentRow } from '../db/payments/paymentIntentRepository';
import {
  AccountNotReadyError,
  assertUsablePaymentMethod,
  ConnectedAccountNotFoundError,
  createIntent,
  IdempotencyConflictError,
  IntentParameterError,
  NetworkMismatchError,
  RailMismatchError,
  RailUnavailableError,
} from '../services/createIntent';
import { selectStoredProvider } from '../services/providers/environmentGuard';
import { ProviderError } from '../services/providers/provider';
import { findAccountByPublicId } from '../db/accounts/connectedAccountRepository';
import { redactProviderMessage } from '../services/providers/redact';
import { cancelCardPaymentAtProvider } from '../services/cardCancellation';
import {
  applyProviderPaymentResult,
  reconcileIntentWithProvider,
} from '../services/intentReconciliation';
import { resolveClientAction } from '../services/clientAction';
import { applyEvent } from '../services/intentState';
import { reportFaircoinBroadcast } from '../services/faircoinBroadcast';
import { confirmCardIntent } from '../services/confirmIntent';
import { announceIntentChange, transitionIntent } from '../services/intentTransition';
import { toPaymentIntentDTO } from '../lib/serialize';
import {
  sendError,
  sendProviderError,
  wrap,
  requireServiceApp,
  requireAuthenticated,
  sendValidationError,
  hasScope,
  requireScope,
} from '../lib/http';
import { sendMoneyRefusal } from '../lib/moneyHttp';
import { idempotencyKeyOf, idempotent } from '../lib/idempotency';
import { requestIdOf } from '../lib/requestId';
import { expandObjects, parseExpand } from '../lib/expand';
import { retireIfNoLongerOffered } from '../services/faircoin/keyBinding';
import { answerList, type ListQuery, parseQuery, resolveListReference } from '../lib/list';

/**
 * The payer's capability token: the contract's `client_secret` query parameter
 * (already parsed), else the `X-Peable-Client-Secret` header.
 *
 * The HEADER is preferred and the query param is accepted because the hosted
 * checkout's first REST snapshot has historically used it. Kept in one function
 * so every payer-authorized route (here and `routes/setupIntents.ts`) reads it
 * identically — a route that looked only at the query would silently reject
 * every caller using the header, and vice versa.
 */
export function readClientSecret(req: Request, fromQuery: string | undefined): string | undefined {
  return fromQuery ?? req.header('X-Peable-Client-Secret') ?? undefined;
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
  if (result.kind === 'missing') {
    sendError(res, 404, 'invalid_request_error', 'payment intent not found');
    return;
  }
  sendError(
    res,
    409,
    'invalid_request_error',
    `the payment intent moved to '${result.current}' while this request was in flight`,
  );
}

/** Stripe's answer for an operation the intent's status does not allow. */
function sendUnexpectedState(res: Response, intent: PaymentIntentRow, operation: string): void {
  sendError(
    res,
    400,
    'invalid_request_error',
    `this payment intent is '${intent.status}' and cannot be ${operation}`,
    'payment_intent_unexpected_state',
  );
}

/** A FairCoin payment has nothing to confirm or capture server-side (ADR 0019). */
function sendCardOnly(res: Response, operation: string, param?: string): void {
  sendError(
    res,
    400,
    'invalid_request_error',
    `${operation} is card only: a FairCoin payment is completed by the payer's own wallet broadcasting a transaction`,
    'parameter_invalid',
    param,
  );
}

/**
 * Answer the two refusals an ON-BEHALF create can meet before anything is
 * written. Shared by both creating routes.
 *
 * @returns whether it answered.
 */
export function sendConnectedAccountRefusal(res: Response, err: unknown): boolean {
  if (err instanceof ConnectedAccountNotFoundError) {
    sendError(res, 404, 'invalid_request_error', err.message);
    return true;
  }
  if (err instanceof AccountNotReadyError) {
    // 409 with a code the platform branches on: the request is right and the
    // seller is not ready — onboard them, do not edit the request.
    sendError(res, 409, 'invalid_request_error', err.message, err.code);
    return true;
  }
  return false;
}

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
 * GET/POST `/v1/merchants/me` routes.
 */
export async function resolveMerchant(req: Request, res: Response): Promise<MerchantRow | null> {
  const serviceApp = requireServiceApp(req, res);
  if (!serviceApp) return null;
  const merchant = await findMerchantByAppEnv(serviceApp.appId, serviceApp.environment);
  if (!merchant) {
    sendError(res, 403, 'permission_error', 'no merchant registered for this app');
    return null;
  }
  // The credential's VERIFIED authority (Oxy ADR 0049) decides whether this is
  // one of Oxy's own products (ADR 0015 §2) and which account owns it — whose
  // Peable wallet receives its FairCoin (ADR 0021 D5); the row mirrors both
  // for the paths that carry no credential (payers, the dashboard, the drain).
  const synced = await syncMerchantAuthority(getDb(), merchant, {
    firstParty: serviceApp.firstParty,
    ownerAccountId: serviceApp.ownerAccountId,
  });
  // The request log (`lib/requestLog.ts`) records the request under it.
  res.locals.merchant = synced;
  return synced;
}

/**
 * Dashboard-path sibling of `resolveMerchant` (F2.5): resolves a Merchant by
 * an EXPLICIT `(applicationId, environment)` pair instead of `req.serviceApp`,
 * since a `/v1/dashboard/*` caller is a human Oxy user, not a service-authed
 * merchant — the application + environment come from the route param + query
 * (already validated + membership-checked by `routes/dashboard.ts` before this
 * is called). 404 (not 403): the caller's ACCESS to the application was
 * already proven by the dashboard's gate (`routes/dashboardAccess.ts`), so a missing merchant here means
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
      'invalid_request_error',
      'no merchant registered for this application in this environment',
      // Orbit's first-run state keys on this code, never on the status alone:
      // a 404 for one object (a payment, a product) is not "set up payments".
      'merchant_missing',
    );
    return null;
  }
  return merchant;
}

export interface ListPaymentIntentsQuery extends ListQuery {
  readonly status?: PaymentIntentStatus | undefined;
  /** A seller's PUBLIC `ca_…`; resolved and ownership-checked below. */
  readonly connected_account?: string | undefined;
  /** A customer's PUBLIC `cus_…`; resolved and ownership-checked below. */
  readonly customer?: string | undefined;
}

/**
 * Answer "list a merchant's payment intents" — shared (F2.5) so
 * `GET /v1/payment_intents` (below) and the dashboard's
 * `GET /v1/dashboard/applications/:applicationId/payment_intents` run the
 * EXACT same query, cursor and filter logic against different auth paths.
 */
export async function answerPaymentIntentList(
  req: Request,
  res: Response,
  merchantId: string,
  query: ListPaymentIntentsQuery,
): Promise<void> {
  const db = getDb();

  // The seller filter arrives as a PUBLIC `ca_…` and is resolved the way a
  // cursor is: scoped to the merchant, so another platform's seller is a 400
  // exactly like an unknown one.
  const account = await resolveListReference(
    res,
    'connected_account',
    query.connected_account,
    async (publicId) => (await findAccountByPublicId(db, merchantId, publicId))?.id ?? null,
  );
  if (!account.ok) return;
  const connectedAccountId = account.id;
  const customer = await resolveListReference(
    res,
    'customer',
    query.customer,
    async (publicId) => (await findLiveCustomerForMerchant(db, publicId, merchantId))?.id ?? null,
  );
  if (!customer.ok) return;

  await answerList(req, res, {
    query,
    type: 'payment_intent',
    merchantId,
    // The cursor arrives as a PUBLIC `pi_…` and the walk runs on the primary
    // key; resolved ownership-scoped, so a cursor naming another merchant's
    // intent is a 400 exactly like an unknown one.
    cursor: async (publicId) => (await findIntentForMerchant(db, publicId, merchantId))?.id ?? null,
    fetch: (page) =>
      listIntentsForMerchant(db, {
        merchantId,
        status: query.status,
        connectedAccountId,
        customerId: customer.id,
        page,
      }),
    serialize: toPaymentIntentDTO,
  });
}

/**
 * Build the payment-intent REST router.
 *
 * `requireMerchant` and `optionalServiceAuth` are injectable so tests can
 * bypass real Oxy service tokens with stubs that populate `req.serviceApp`;
 * in production `server.ts` passes `oxy.middleware.service()` /
 * `oxy.middleware.auth({ optional: true })`, which verify EdDSA service tokens
 * against Oxy's public JWKS (oxy ADR 0012). `requireMerchant`
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
    '/v1/payment_intents',
    requireMerchant,
    requireAuthenticated,
    requireScope('payments:write'),
    idempotent,
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      /**
       * Optional, as on Stripe. A retried request is answered by the generic
       * layer (`idempotent`, ADR 0014 D3) before this handler runs. The key
       * ALSO keys the intent itself (`payment_intents (merchant_id,
       * idempotency_key)`), which is the second line: it still converges a
       * retry the generic layer let through — after a lease takeover, or after
       * the 24-hour window — on the one payment that key created.
       */
      const idempotencyKey = idempotencyKeyOf(res);

      const parsed = createPaymentIntentParams.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      const params = parsed.data;

      try {
        const { intent, reused, clientAction } = await createIntent({
          merchant,
          amount: params.amount,
          ...(params.rail !== undefined ? { rail: params.rail } : {}),
          ...(params.currency !== undefined ? { currency: params.currency } : {}),
          ...(params.network !== undefined ? { network: params.network } : {}),
          ...(params.connected_account !== undefined
            ? { connectedAccount: params.connected_account }
            : {}),
          metadata: params.metadata,
          expiresInSeconds: params.expires_in_seconds,
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
          ...(params.payment_method_types !== undefined
            ? { paymentMethodTypes: params.payment_method_types }
            : {}),
          ...(params.payment_method_configuration !== undefined
            ? { paymentMethodConfiguration: params.payment_method_configuration }
            : {}),
          ...(params.customer !== undefined ? { customer: params.customer } : {}),
          ...(params.payment_method !== undefined ? { paymentMethod: params.payment_method } : {}),
          ...(params.confirm !== undefined ? { confirm: params.confirm } : {}),
          ...(params.off_session !== undefined ? { offSession: params.off_session } : {}),
          ...(params.setup_future_usage !== undefined
            ? { setupFutureUsage: params.setup_future_usage }
            : {}),
          ...(params.capture_method !== undefined ? { captureMethod: params.capture_method } : {}),
          ...(params.receipt_email !== undefined ? { receiptEmail: params.receipt_email } : {}),
          ...(params.description !== undefined ? { description: params.description } : {}),
          ...(params.statement_descriptor_suffix !== undefined
            ? { statementDescriptorSuffix: params.statement_descriptor_suffix }
            : {}),
          ...(params.shipping !== undefined ? { shipping: toShipping(params.shipping) } : {}),
          ...(params.return_url !== undefined ? { returnUrl: params.return_url } : {}),
          ...(params.application_fee_amount !== undefined
            ? { applicationFeeAmount: params.application_fee_amount }
            : {}),
          ...(params.transfer_data !== undefined
            ? {
                transferData: {
                  destination: params.transfer_data.destination,
                  ...(params.transfer_data.amount !== undefined
                    ? { amount: params.transfer_data.amount }
                    : {}),
                },
              }
            : {}),
          ...(params.on_behalf_of !== undefined ? { onBehalfOf: params.on_behalf_of } : {}),
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
        // Data-integrity firewall (F2.0 task 1a): the address is derived on
        // the MERCHANT's network (`faircoin/recipient.ts`), never the caller's
        // claimed `network` — `createIntent` rejects a mismatch up front, or the
        // returned intent's `network` label would lie about the network its
        // `address` actually encodes.
        // `RailMismatchError` rides the same branch: both are a caller
        // describing a payment this gateway cannot make, and neither is a
        // server fault. Which mistake they made is in the message.
        if (err instanceof NetworkMismatchError || err instanceof RailMismatchError) {
          sendError(res, 400, 'invalid_request_error', err.message);
          return;
        }
        if (err instanceof IntentParameterError) {
          sendError(res, 400, 'invalid_request_error', err.message, err.code, err.param);
          return;
        }
        // The recipient's Peable wallet is not set up, or the deployment does
        // not open this network yet (ADR 0021 D5): the request is right, the
        // payee is not ready — never a silent card-only answer.
        if (err instanceof FaircoinWalletMissingError) {
          sendError(res, 409, 'invalid_request_error', err.message, 'faircoin_wallet_missing');
          return;
        }
        if (err instanceof FaircoinNetworkClosedError) {
          sendError(
            res,
            409,
            'invalid_request_error',
            err.message,
            'faircoin_network_closed',
            'network',
          );
          return;
        }
        // Too many of the recipient's addresses of the last day went unpaid (ADR 0021 D9).
        if (err instanceof FaircoinCapacityError) {
          sendError(res, 503, 'api_error', err.message, 'faircoin_capacity_reached');
          return;
        }
        if (sendMoneyRefusal(res, err)) return;
        if (err instanceof ProviderError) {
          sendProviderError(res, err);
          return;
        }
        if (sendConnectedAccountRefusal(res, err)) return;
        // The key names a payment with DIFFERENT terms. Answering 200 with the
        // stored intent would tell the caller their new payment exists, and they
        // would wait for money against an amount they never asked for. The same
        // answer the generic layer gives a key reused for another request.
        if (err instanceof IdempotencyConflictError) {
          sendError(res, 400, 'invalid_request_error', err.message, 'idempotency_error');
          return;
        }
        // 503, not 400: the caller cannot fix this by sending different fields.
        // The rail they asked for is not configured on this deployment, and
        // telling them their request was invalid would send them off editing it.
        if (err instanceof RailUnavailableError) {
          sendError(res, 503, 'api_error', err.message);
          return;
        }
        throw err;
      }
    }),
  );

  router.get(
    '/v1/payment_intents',
    requireMerchant,
    requireAuthenticated,
    requireScope('payments:read'),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      const query = parseQuery(req, res, listPaymentIntentsQuery);
      if (!query) return;
      await answerPaymentIntentList(req, res, merchant.id, query);
    }),
  );

  router.get(
    '/v1/payment_intents/:id',
    optionalServiceAuth,
    wrap(async (req, res) => {
      const { serviceApp } = req as OxyAuthRequest;

      // `noUncheckedIndexedAccess` types `req.params.id` as possibly
      // `undefined` even though Express guarantees `:id` is present here.
      // Read once, above the branch, because BOTH the merchant path and the
      // payer path below need it.
      const { id } = req.params;
      if (!id) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }

      if (serviceApp?.appId) {
        // Merchant path — same `payments:read` requirement as the list route
        // (F2.0 gateway-review finding: this branch previously enforced no
        // scope at all). Can't use `requireScope()` as ordinary
        // route middleware here — that would also gate the payer/client_secret
        // branch below, which has no service token to check — so the SAME
        // scope-checking primitive is invoked manually, scoped to just this
        // branch.
        if (!hasScope(req, res, 'payments:read')) return;

        const merchant = await resolveMerchant(req, res);
        if (!merchant) return;
        const query = parseQuery(req, res, retrievePaymentIntentQuery);
        if (!query) return;
        const expand = parseExpand(res, 'payment_intent', query.expand, { list: false });
        if (!expand) return;
        const intent = await findIntentForMerchant(getDb(), id, merchant.id);
        if (!intent) {
          sendError(res, 404, 'invalid_request_error', 'payment intent not found');
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
          intent.rail === 'card'
            ? await resolveClientAction(intent)
            : { kind: 'not_applicable' as const };
        if (action.kind === 'ok') res.setHeader('Cache-Control', 'no-store');

        const dto = toPaymentIntentDTO(intent);
        await expandObjects([dto], 'payment_intent', expand, merchant.id);
        res.status(200).json({
          ...dto,
          ...(action.kind === 'ok' ? { client_action: action.action } : {}),
        });
        return;
      }

      // Expansion resolves inside a MERCHANT's scope, and a payer has none: an
      // expanded seller is the merchant's record of them, not the payer's.
      if (req.query.expand !== undefined) {
        sendError(
          res,
          400,
          'invalid_request_error',
          'expand requires the merchant credential',
          'parameter_invalid',
          'expand',
        );
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
      const payerQuery = parseQuery(req, res, retrievePaymentIntentQuery);
      if (!payerQuery) return;
      const clientSecret = readClientSecret(req, payerQuery.client_secret);
      if (!clientSecret) {
        sendError(
          res,
          401,
          'authentication_error',
          'missing service app credentials or client_secret',
        );
        return;
      }

      const intent = await findIntentByPublicId(getDb(), id);
      if (!intent) {
        sendError(res, 404, 'invalid_request_error', 'payment intent not found');
        return;
      }
      if (!verifySecret(clientSecret, intent.clientSecret)) {
        sendError(res, 403, 'permission_error', 'invalid client_secret');
        return;
      }
      // A FairCoin payment under a replaced recipient key is never shown to a
      // payer as payable again: it is retired first (ADR 0002, amended 2026-11-06).
      res.status(200).json(toPaymentIntentDTO(await retireIfNoLongerOffered(intent)));
    }),
  );

  /**
   * Update an intent — Stripe's `POST /v1/payment_intents/:id`.
   *
   * The merchant's own fields only: `metadata`, `description`, `receipt_email`,
   * `shipping`. The amount, rail and address ARE the payment, and the status
   * moves only through its own operations (`transitionIntent`), so a generic
   * update can never be a back door into the state machine. Sends no webhook:
   * it is the merchant's own bookkeeping.
   */
  router.post(
    '/v1/payment_intents/:id',
    requireMerchant,
    requireAuthenticated,
    requireScope('payments:write'),
    idempotent,
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const { id } = req.params;
      if (!id) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }
      const parsed = updatePaymentIntentParams.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      const expand = parseExpand(res, 'payment_intent', parsed.data.expand, { list: false });
      if (!expand) return;

      const db = getDb();
      const body = parsed.data;
      const nothing =
        body.metadata === undefined &&
        body.description === undefined &&
        body.receipt_email === undefined &&
        body.shipping === undefined;
      const result = nothing
        ? ((await findIntentForMerchant(db, id, merchant.id)) ?? 'missing')
        : await updateIntentDetails(db, id, merchant.id, {
            metadata: body.metadata,
            ...(body.description !== undefined
              ? { description: body.description === '' ? null : body.description }
              : {}),
            ...(body.receipt_email !== undefined
              ? { receiptEmail: body.receipt_email === '' ? null : body.receipt_email }
              : {}),
            ...(body.shipping !== undefined
              ? { shipping: body.shipping === '' ? null : toShipping(body.shipping) }
              : {}),
          });
      if (result === 'missing') {
        sendError(res, 404, 'invalid_request_error', 'payment intent not found');
        return;
      }
      if (result === 'limit_exceeded') {
        sendError(
          res,
          400,
          'invalid_request_error',
          METADATA_LIMIT_MESSAGE,
          'parameter_invalid',
          'metadata',
        );
        return;
      }
      const dto = toPaymentIntentDTO(result);
      await expandObjects([dto], 'payment_intent', expand, merchant.id);
      res.status(200).json(dto);
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
    '/v1/payment_intents/:id/client_action',
    optionalServiceAuth,
    wrap(async (req, res) => {
      const { id } = req.params;
      if (!id) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }

      const query = parseQuery(req, res, clientSecretQuery);
      if (!query) return;

      const { serviceApp } = req as OxyAuthRequest;
      let intent: PaymentIntentRow | null;

      if (serviceApp?.appId) {
        if (!hasScope(req, res, 'payments:read')) return;
        const merchant = await resolveMerchant(req, res);
        if (!merchant) return;
        intent = await findIntentForMerchant(getDb(), id, merchant.id);
      } else {
        const clientSecret = readClientSecret(req, query.client_secret);
        if (!clientSecret) {
          sendError(
            res,
            401,
            'authentication_error',
            'missing service app credentials or client_secret',
          );
          return;
        }
        intent = await findIntentByPublicId(getDb(), id);
        if (intent && !verifySecret(clientSecret, intent.clientSecret)) {
          sendError(res, 403, 'permission_error', 'invalid client_secret');
          return;
        }
      }

      if (!intent) {
        sendError(res, 404, 'invalid_request_error', 'payment intent not found');
        return;
      }

      // Never cached, never revalidated, and never stored by anything in
      // between. The body carries a credential.
      res.setHeader('Cache-Control', 'no-store');

      const outcome = await resolveClientAction(intent);
      if (outcome.kind === 'ok') {
        res.status(200).json({ object: 'client_action', ...outcome.action });
        return;
      }
      if (outcome.kind === 'not_applicable') {
        // The FairCoin rail. The next step is "send coins to `address`", which
        // the intent already says — a 400 rather than an empty 200, so a client
        // that asked the wrong question learns that rather than waiting.
        sendError(
          res,
          400,
          'invalid_request_error',
          'this payment needs no client action; it is paid by sending coins to its next_action.faircoin_payment address',
        );
        return;
      }
      if (outcome.kind === 'unpayable') {
        sendError(
          res,
          409,
          'invalid_request_error',
          `this payment is '${outcome.status}' and can no longer be paid`,
        );
        return;
      }
      sendError(res, 503, 'api_error', outcome.error);
    }),
  );

  /**
   * Confirm a CARD payment server-side with a saved payment method (ADR 0019) —
   * Stripe's `POST /v1/payment_intents/:id/confirm`.
   *
   * The method is the body's `pm_…` or the intent's own, and it must be
   * attached to the intent's customer: the provider charges a saved card
   * through that customer. A decline is not an error from the provider's side —
   * the payment returns to `requires_payment_method` with `last_payment_error`
   * — and is answered 402 `card_error` carrying the intent, Stripe's shape. A
   * challenge answers 200 with `status: 'requires_action'` and
   * `next_action: use_peable_sdk`; the payer's client completes it.
   */
  router.post(
    '/v1/payment_intents/:id/confirm',
    requireMerchant,
    requireAuthenticated,
    requireScope('payments:write'),
    idempotent,
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const { id } = req.params;
      if (!id) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }
      const parsed = confirmPaymentIntentParams.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      const body = parsed.data;
      const expand = parseExpand(res, 'payment_intent', body.expand, { list: false });
      if (!expand) return;

      const db = getDb();
      const intent = await findIntentForMerchant(db, id, merchant.id);
      if (!intent) {
        sendError(res, 404, 'invalid_request_error', 'payment intent not found');
        return;
      }
      if (intent.rail !== 'card') {
        sendCardOnly(res, 'confirm', 'payment_method');
        return;
      }
      if (
        intent.status !== 'requires_payment_method' &&
        intent.status !== 'requires_confirmation' &&
        intent.status !== 'requires_action'
      ) {
        sendUnexpectedState(res, intent, 'confirmed');
        return;
      }

      const methodId = body.payment_method ?? intent.paymentMethodPublicId;
      if (methodId === null) {
        sendError(
          res,
          400,
          'invalid_request_error',
          'confirming needs a payment_method',
          'parameter_missing',
          'payment_method',
        );
        return;
      }
      const paymentMethod = await findPaymentMethodForMerchant(db, methodId, merchant.id);
      if (!paymentMethod) {
        sendError(
          res,
          400,
          'invalid_request_error',
          `no such payment method: '${methodId}'`,
          'resource_missing',
          'payment_method',
        );
        return;
      }
      const customer =
        intent.customerPublicId === null
          ? null
          : await findLiveCustomerForMerchant(db, intent.customerPublicId, merchant.id);
      try {
        assertUsablePaymentMethod(paymentMethod, customer);
      } catch (error) {
        if (error instanceof IntentParameterError) {
          sendError(res, 400, 'invalid_request_error', error.message, error.code, error.param);
          return;
        }
        throw error;
      }
      if (customer === null) throw new Error('assertUsablePaymentMethod admitted no customer');

      let current: PaymentIntentRow;
      try {
        const outcome = await confirmCardIntent({
          intent,
          paymentMethod,
          customer,
          offSession: body.off_session,
          setupFutureUsage: body.setup_future_usage,
          receiptEmail: body.receipt_email,
          ...(body.shipping !== undefined ? { shipping: toShipping(body.shipping) } : {}),
          returnUrl: body.return_url,
          // One provider operation per Peable request: the generic key when the
          // caller sent one (a retry is the same confirmation), otherwise fresh
          // — a second confirm after a decline is a NEW attempt.
          idempotencyKey: `confirm:${intent.publicId}:${idempotencyKeyOf(res) ?? randomUUID()}`,
        });
        if (outcome.kind === 'unavailable') {
          sendError(res, 503, 'api_error', 'the card rail cannot reach this payment right now');
          return;
        }
        if (outcome.kind === 'stale') {
          sendStaleOrMissing(
            res,
            outcome.current
              ? { kind: 'stale', current: outcome.current.status }
              : { kind: 'missing' },
          );
          return;
        }
        current = outcome.intent;
      } catch (error) {
        if (error instanceof ProviderError) {
          sendProviderError(res, error);
          return;
        }
        throw error;
      }

      const dto = toPaymentIntentDTO(current);
      await expandObjects([dto], 'payment_intent', expand, merchant.id);
      if (current.status === 'requires_payment_method' && current.lastPaymentError !== null) {
        res.status(402).json({
          error: {
            type: 'card_error',
            ...(current.lastPaymentError.code ? { code: current.lastPaymentError.code } : {}),
            ...(current.lastPaymentError.decline_code
              ? { decline_code: current.lastPaymentError.decline_code }
              : {}),
            message: current.lastPaymentError.message,
            payment_intent: dto,
            request_id: requestIdOf(res) ?? null,
          },
        });
        return;
      }
      res.status(200).json(dto);
    }),
  );

  /**
   * Capture a held authorization (`capture_method: manual`, `requires_capture`)
   * — in full, or `amount_to_capture` of it; the rest is released. Card only.
   */
  router.post(
    '/v1/payment_intents/:id/capture',
    requireMerchant,
    requireAuthenticated,
    requireScope('payments:write'),
    idempotent,
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const { id } = req.params;
      if (!id) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }
      const parsed = capturePaymentIntentParams.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      const expand = parseExpand(res, 'payment_intent', parsed.data.expand, { list: false });
      if (!expand) return;

      const db = getDb();
      const intent = await findIntentForMerchant(db, id, merchant.id);
      if (!intent) {
        sendError(res, 404, 'invalid_request_error', 'payment intent not found');
        return;
      }
      if (intent.rail !== 'card') {
        sendCardOnly(res, 'capture', 'amount_to_capture');
        return;
      }
      if (intent.status !== 'requires_capture') {
        sendUnexpectedState(res, intent, 'captured');
        return;
      }
      const amountToCapture = parsed.data.amount_to_capture;
      if (amountToCapture !== undefined && BigInt(amountToCapture) > BigInt(intent.amount)) {
        sendError(
          res,
          400,
          'invalid_request_error',
          `amount_to_capture cannot exceed the authorized ${intent.amount}`,
          'parameter_invalid',
          'amount_to_capture',
        );
        return;
      }
      const provider = intent.provider
        ? selectStoredProvider(intent.provider, intent.livemode)
        : undefined;
      if (!provider || !intent.providerObjectId) {
        sendError(res, 503, 'api_error', 'the card rail cannot reach this payment right now');
        return;
      }

      let outcome: Awaited<ReturnType<typeof applyProviderPaymentResult>>;
      try {
        const result = await provider.capture({
          intentId: intent.publicId,
          providerObjectId: intent.providerObjectId,
          // One capture per payment: a retry is the same capture.
          idempotencyKey: `capture:${intent.publicId}`,
          ...(amountToCapture !== undefined ? { amountToCapture } : {}),
        });
        outcome = await applyProviderPaymentResult(intent, result, {
          amountReceived: amountToCapture ?? intent.amount,
        });
      } catch (error) {
        if (error instanceof ProviderError) {
          sendProviderError(res, error);
          return;
        }
        throw error;
      }
      if (outcome.kind === 'irreconcilable') {
        sendError(res, 409, 'invalid_request_error', redactProviderMessage(outcome.error));
        return;
      }
      const current = (await findIntentById(db, intent.id)) ?? intent;
      const dto = toPaymentIntentDTO(current);
      await expandObjects([dto], 'payment_intent', expand, merchant.id);
      res.status(200).json(dto);
    }),
  );

  /**
   * Cancel a payment — Stripe's `POST /v1/payment_intents/:id/cancel`, which
   * replaces `/reject` (ADR 0019). Allowed while nothing is moving money:
   * `requires_payment_method`, `requires_confirmation`, `requires_action`, and a
   * held authorization (`requires_capture`, which a cancellation releases).
   */
  router.post(
    '/v1/payment_intents/:id/cancel',
    requireMerchant,
    requireAuthenticated,
    requireScope('payments:write'),
    idempotent,
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const { id } = req.params;
      if (!id) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }
      const parsed = cancelPaymentIntentParams.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      const expand = parseExpand(res, 'payment_intent', parsed.data.expand, { list: false });
      if (!expand) return;
      const reason = parsed.data.cancellation_reason;

      const intent = await findIntentForMerchant(getDb(), id, merchant.id);
      if (!intent) {
        sendError(res, 404, 'invalid_request_error', 'payment intent not found');
        return;
      }

      let nextStatus: PaymentIntentStatus;
      try {
        nextStatus = applyEvent(intent.status, 'cancel', intent.rail);
      } catch {
        sendUnexpectedState(res, intent, 'canceled');
        return;
      }
      if (nextStatus === intent.status) {
        // Already cancelled: the answer to a cancel is the cancelled intent.
        const dto = toPaymentIntentDTO(intent);
        await expandObjects([dto], 'payment_intent', expand, merchant.id);
        res.status(200).json(dto);
        return;
      }

      /**
       * Cancel at the PROVIDER first, and only then announce it.
       *
       * A local cancellation alone would leave the payer's browser holding a
       * live confirmation credential for a provider payment that stays
       * confirmable — a payment the merchant was told is cancelled could
       * complete minutes later. The cancellation can LOSE:
       *
       *  - `settled`: the payer confirmed first; reconcile to the truth and 400.
       *  - `in_flight`: the provider still has it in flight; not cancellable yet.
       *  - `unknown`: the provider could not be reached; 502, nothing written.
       *  - `nothing_to_cancel`: the FairCoin rail, where the local transition is
       *    the whole of it.
       */
      const cancellation = await cancelCardPaymentAtProvider(
        intent,
        // Derived from the intent's own id: a retry is the same cancellation.
        `cancel:${intent.publicId}`,
        reason,
      );
      if (cancellation.kind === 'settled') {
        const reconciled = await reconcileIntentWithProvider(intent);
        sendError(
          res,
          400,
          'invalid_request_error',
          'this payment was completed by the payer before it could be canceled' +
            (reconciled.kind === 'applied' || reconciled.kind === 'agreed'
              ? `; it is '${reconciled.status}'`
              : ''),
          'payment_intent_unexpected_state',
        );
        return;
      }
      if (cancellation.kind === 'in_flight') {
        sendError(
          res,
          400,
          'invalid_request_error',
          `the provider still has this payment in flight ('${cancellation.status}'); it cannot be canceled yet`,
          'payment_intent_unexpected_state',
        );
        return;
      }
      if (cancellation.kind === 'unknown') {
        sendError(
          res,
          502,
          'api_error',
          `the payment could not be canceled at the provider: ${redactProviderMessage(cancellation.error)}`,
        );
        return;
      }
      const canceled = await transitionIntent(intent.id, {
        from: intent.status,
        status: nextStatus,
        ...(reason !== undefined ? { cancellationReason: reason } : {}),
      });
      if (canceled.kind !== 'updated') {
        sendStaleOrMissing(res, canceled);
        return;
      }
      announceIntentChange(canceled.row);
      const dto = toPaymentIntentDTO(canceled.row);
      await expandObjects([dto], 'payment_intent', expand, merchant.id);
      res.status(200).json(dto);
    }),
  );

  // Payer path — NOT merchant-authed. Possession of the intent's `client_secret`
  // is the authorization; the reported txid is handed to the settlement watcher.
  router.post(
    '/v1/payment_intents/:id/submit_tx',
    wrap(async (req, res) => {
      const parsed = submitPaymentIntentTxParams.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }

      // `noUncheckedIndexedAccess` types `req.params.id` as possibly
      // `undefined` even though Express guarantees `:id` is present here. The
      // repositories take a `string`, so the guard is explicit rather than a
      // non-null assertion.
      const { id } = req.params;
      if (!id) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }

      const intent = await findIntentByPublicId(getDb(), id);
      if (!intent) {
        sendError(res, 404, 'invalid_request_error', 'payment intent not found');
        return;
      }

      if (!verifySecret(parsed.data.client_secret, intent.clientSecret)) {
        sendError(res, 403, 'permission_error', 'invalid client_secret');
        return;
      }

      // A card payment has no transaction to report: its payer confirms through
      // the provider, never here.
      if (intent.rail !== 'faircoin') {
        sendError(
          res,
          400,
          'invalid_request_error',
          'submit_tx is FairCoin only; a card payment is confirmed through the provider',
        );
        return;
      }

      // The merchant is told `payment_intent.processing`, and the announce puts
      // the "payment sent, confirming" frame on the payer's own checkout page.
      const broadcast = await reportFaircoinBroadcast(intent, parsed.data.txid);
      if (broadcast.kind === 'illegal') {
        sendError(res, 409, 'invalid_request_error', broadcast.message);
        return;
      }
      if (broadcast.kind !== 'updated') {
        sendStaleOrMissing(res, broadcast);
        return;
      }
      announceIntentChange(broadcast.row);
      res.status(200).json(toPaymentIntentDTO(broadcast.row));
    }),
  );

  return router;
}
