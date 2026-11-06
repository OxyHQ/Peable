import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { isNotFoundError } from '@oxy.so/core';
import { oxy } from '../oxy';
import { getRequiredOxyUserId } from '@oxy.so/core/server';
import {
  type SocialNextAddressResponse,
  type SocialPayment,
  type SocialPaymentsResponse,
  type SocialReceiveAddressesResponse,
  type SocialReceiveCursorResponse,
  socialNextAddressParams,
  socialPaymentsQuery,
  socialReceiveAddressesQuery,
  socialReceiveCursorQuery,
} from '@peable.to/contracts';
import { SOCIAL_RECEIVE_ADDRESSES_PAGE_DEFAULT } from '@peable.to/contracts/vocabulary';
import { config } from '../config';
import {
  getReservedThrough,
  IdentityDocumentUnavailableError,
  reserveSocialSendAddress,
  resolveIdentityPublicKeyHex,
  reuseUnpaidSocialAddress,
} from '../services/socialReceive';
import { FaircoinCapacityError } from '../services/faircoin/addressPool';
import { getDb } from '../db/postgres';
import { listReceiveAddresses } from '../db/social/receiveAddresses';
import { listAttributionsForViewer, updateAttributionSource } from '../db/social/sendAttribution';
import { ENRICH_MAX_ADDRESSES, enrichAddresses } from '../services/enrichment';
import { passesLimit } from '../lib/faircoinPayerLimit';
import { sendError, sendValidationError, wrap } from '../lib/http';
import { toSocialPaymentSource } from '../lib/serialize';
import { toUnix } from '../lib/time';

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

/**
 * Fresh `@username` addresses one SENDER may be handed, across every recipient,
 * per hour (ADR 0021 D9, amended 2026-11-06) — the per-payer bound beside the
 * pair limiter and the recipient's daily one. Only a fresh address counts: an
 * address handed again to the sender that holds it adds nothing to anyone's
 * watch set. Per task, like every in-memory limiter here.
 */
export const NEXT_ADDRESS_SENDER_WINDOW_MS = 60 * 60 * 1000;
export const NEXT_ADDRESS_SENDER_MAX = 30;

/** Carries the resolved (sender, recipient) rate-limit key from the handler to `nextAddressPairLimiter`'s `keyGenerator`, set just before invoking it (recipient isn't known until after the username lookup). */
interface PairRateLimitedRequest extends Request {
  socialNextAddressPairKey?: string;
  socialNextAddressSenderKey?: string;
}

/**
 * Build the social-send REST router (spec §4.4 step 3, §4.5, §4.8 bullets
 * 2-3).
 *
 * `requireOxyUser` is handed in (`server.ts` passes the process's one, from
 * `lib/http.ts`) so tests can bypass a real Oxy bearer token with a stub that
 * populates `req.userId`; in production it is the PAYER's own signed-in Oxy
 * session, distinct from the merchant service-auth `paymentIntents.ts` uses.
 */
export function createSocialRouter(deps: { requireOxyUser: RequestHandler }): Router {
  const { requireOxyUser } = deps;
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
    keyGenerator: (req) => (req as PairRateLimitedRequest).socialNextAddressPairKey ?? 'unknown',
    handler: (_req, res) => {
      sendError(
        res,
        429,
        'rate_limit_error',
        'too many address reservations for this recipient — try again shortly',
      );
    },
  });

  const nextAddressSenderLimiter = rateLimit({
    windowMs: NEXT_ADDRESS_SENDER_WINDOW_MS,
    limit: NEXT_ADDRESS_SENDER_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req as PairRateLimitedRequest).socialNextAddressSenderKey ?? 'unknown',
    handler: (_req, res) => {
      sendError(
        res,
        429,
        'rate_limit_error',
        'too many new payment addresses requested from this account — try again later',
      );
    },
  });

  router.post(
    '/v1/social/:username/next_address',
    requireOxyUser,
    wrap(async (req, res) => {
      const senderUserId = getRequiredOxyUserId(req);

      const parsed = socialNextAddressParams.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
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
          'invalid_request_error',
          `paying by @username is not enabled on ${network}`,
        );
        return;
      }

      const { username } = req.params;
      if (!username) {
        sendError(res, 400, 'invalid_request_error', 'username is required');
        return;
      }

      let recipient: { id: string };
      try {
        recipient = await oxy.users.byUsername(username);
      } catch (err) {
        if (isNotFoundError(err)) {
          sendError(res, 404, 'invalid_request_error', 'recipient not found');
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
        sendError(res, 502, 'api_error', 'failed to resolve recipient — try again');
        return;
      }

      if (recipient.id === senderUserId) {
        sendError(res, 400, 'invalid_request_error', 'cannot pay yourself');
        return;
      }

      // Anti-grief: bound how often THIS sender can ask about THIS recipient
      // (see `nextAddressPairLimiter` above); over budget, the limiter has
      // already written the 429.
      (req as PairRateLimitedRequest).socialNextAddressPairKey = `${senderUserId}:${recipient.id}`;
      if (!(await passesLimit(nextAddressPairLimiter, req, res))) return;

      // The same sender asking again before paying is handed the address it
      // already holds (ADR 0021 D9): one unpaid address per (sender,
      // recipient), however often it asks — the bound the limiter above
      // cannot give, being per task and per window.
      const unpaid = await reuseUnpaidSocialAddress(senderUserId, recipient.id, network);
      if (unpaid) {
        await updateAttributionSource(getDb(), unpaid.attributionId, source);
        const body: SocialNextAddressResponse = { address: unpaid.address, index: unpaid.index };
        res.status(200).json(body);
        return;
      }

      // A FRESH address: the sender's own hourly bound, then the recipient's
      // daily one, the reservation and its record in one transaction
      // (`reserveSocialSendAddress`, ADR 0021 D9).
      (req as PairRateLimitedRequest).socialNextAddressSenderKey = senderUserId;
      if (!(await passesLimit(nextAddressSenderLimiter, req, res))) return;
      let reservation: Awaited<ReturnType<typeof reserveSocialSendAddress>>;
      try {
        reservation = await reserveSocialSendAddress({
          senderUserId,
          recipientUserId: recipient.id,
          network,
          ...(source ? { source } : {}),
        });
      } catch (err) {
        if (!(err instanceof FaircoinCapacityError)) throw err;
        // 503, not 409: a 409 on this route is the keyless recipient, and the
        // wallet and `@peable.to/pay` read it so from the status alone.
        sendError(
          res,
          503,
          'api_error',
          'this person was asked to be paid by too many new senders today; try again later',
          'faircoin_capacity_reached',
        );
        return;
      }
      if (!reservation) {
        sendError(
          res,
          409,
          'invalid_request_error',
          'recipient has not set up an Oxy identity yet',
          'keyless_recipient',
        );
        return;
      }

      const body: SocialNextAddressResponse = {
        address: reservation.address,
        index: reservation.index,
      };
      res.status(200).json(body);
    }),
  );

  router.get(
    '/v1/social/me/cursor',
    requireOxyUser,
    wrap(async (req, res) => {
      const oxyUserId = getRequiredOxyUserId(req);

      const parsed = socialReceiveCursorQuery.safeParse(req.query);
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }

      // Read-only: reserves nothing, so a device can poll it freely to
      // resync its watch window (spec cursor-sync fix).
      const { reservedThrough, identityPublicKey } = await getReservedThrough(
        oxyUserId,
        parsed.data.network,
      );
      // The caller's CURRENT `#key-1`, read fresh (ADR 0002, amended
      // 2026-11-06): the device compares its key with THIS — the cursor's key
      // says only what the last reservation used, and may be a replaced one.
      let accountIdentityPublicKey: string | null;
      try {
        accountIdentityPublicKey = await resolveIdentityPublicKeyHex(oxyUserId);
      } catch (err) {
        if (!(err instanceof IdentityDocumentUnavailableError)) throw err;
        sendError(res, 503, 'api_error', 'your identity key could not be read; try again');
        return;
      }
      const body: SocialReceiveCursorResponse = {
        reserved_through: reservedThrough,
        identity_public_key: identityPublicKey,
        account_identity_public_key: accountIdentityPublicKey,
      };
      res.status(200).json(body);
    }),
  );

  /**
   * Every FairCoin address handed out in the caller's Peable wallet (ADR 0021
   * D9, amended 2026-11-06): the set the wallet watches, paged by the
   * derivation index — a monotonic sync cursor (`db/social/receiveAddresses.ts`).
   * For whoever the session acts as, like the cursor: an organization's
   * addresses when acting as it. Every key the account has had, each address
   * with its own. Read-only.
   */
  router.get(
    '/v1/social/me/receive_addresses',
    requireOxyUser,
    wrap(async (req, res) => {
      const accountId = getRequiredOxyUserId(req);
      const parsed = socialReceiveAddressesQuery.safeParse(req.query);
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      const { network } = parsed.data;
      const page = await listReceiveAddresses(
        getDb(),
        accountId,
        network,
        parsed.data.after ?? 0,
        parsed.data.limit ?? SOCIAL_RECEIVE_ADDRESSES_PAGE_DEFAULT,
      );
      const body: SocialReceiveAddressesResponse = {
        addresses: page.addresses.map((row) => ({
          address: row.address,
          derivation_index: row.derivationIndex,
          identity_public_key: row.identityPublicKey,
          network: row.network,
          created: toUnix(row.createdAt),
        })),
        has_more: page.hasMore,
        sync_cursor: page.syncCursor,
      };
      res.setHeader('Cache-Control', 'no-store');
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
    '/v1/social/me/payments',
    requireOxyUser,
    wrap(async (req, res) => {
      const oxyUserId = getRequiredOxyUserId(req);

      const parsed = socialPaymentsQuery.safeParse(req.query);
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
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
        direction: row.senderUserId === oxyUserId ? 'sent' : 'received',
        counterparty: enriched[row.address] ?? { kind: 'unknown' },
        // Display-only, like `counterparty`, and handed back exactly as the
        // paying app sent it: `toSocialPaymentSource` copies the two columns
        // and reads into neither. Omitted entirely for a payment nobody gave
        // a context to.
        source: toSocialPaymentSource(row),
        created: toUnix(row.createdAt),
      }));

      const body: SocialPaymentsResponse = { payments };
      res.status(200).json(body);
    }),
  );

  return router;
}
