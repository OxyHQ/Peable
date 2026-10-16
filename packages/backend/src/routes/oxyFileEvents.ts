/**
 * Oxy's file events: `POST /v1/webhooks/oxy/files` (ADR 0043 D9).
 *
 * Oxy tells every application that references a file when that file is
 * deleted, blocked, trashed, restored or changes visibility, signed with the
 * endpoint's own secret: `oxy-signature: t=<unix>,v1=<HMAC-SHA256(secret,
 * "<t>.<raw body>")>`. Register this URL in the Oxy console (Webhooks → File
 * events) or with `oxy.apps.setFilesWebhook`; Oxy first POSTs a
 * `webhook.challenge`, which is echoed, and returns the secret once — it goes
 * in `OXY_FILES_WEBHOOK_SECRET`.
 *
 * ## Mounted BEFORE `express.json()` and the global rate limiter
 *
 * For the reasons `routes/providerWebhooks.ts` gives for Stripe, which hold
 * here unchanged: the signature covers the exact bytes, so a JSON parser that
 * reaches the stream first breaks every delivery; and every delivery comes
 * from Oxy's own small set of addresses, so a per-IP bucket would be one bucket
 * for all of Oxy. `express.raw`'s limit bounds what an unauthenticated caller
 * can make this allocate, and an unverifiable body is refused before any
 * database access.
 *
 * ## No Oxy auth
 *
 * The signature is the authenticity story. A bearer would add nothing: Oxy
 * delivers with no token, and the secret is what proves the sender.
 *
 * ## Answers
 *
 * 200 = recorded (or already recorded). 400 = not a verifiable file event;
 * Oxy retries it and that is harmless. 503 = no secret configured yet; Oxy
 * retries with backoff, so events sent before the secret is deployed are not
 * lost. Any other failure is a 500, also retried.
 */
import express, { Router, type Request, type Response } from 'express';
import {
  FileEventVerificationError,
  type FileEvent,
  type FileWebhookChallenge,
  verifyFileEventSignature,
} from '@oxy.so/core/server';
import { config } from '../config';
import { applyFileEvent } from '../services/oxyFiles/fileEvents';

export const OXY_FILE_EVENTS_PATH = '/v1/webhooks/oxy/files';

/** A file event is a few hundred bytes; this is the whole budget of an unauthenticated body. */
const RAW_BODY_LIMIT = '64kb';

export interface OxyFileEventsDeps {
  /** The secrets to accept, newest first. Default: `OXY_FILES_WEBHOOK_SECRET` then `_PREVIOUS`. */
  readonly secrets?: () => readonly string[];
  readonly apply?: typeof applyFileEvent;
}

function configuredSecrets(): readonly string[] {
  return [config.oxyFiles.webhookSecret, config.oxyFiles.webhookSecretPrevious].filter(
    (secret): secret is string => typeof secret === 'string' && secret.length > 0,
  );
}

type Verified =
  | { readonly kind: 'event'; readonly event: FileEvent | FileWebhookChallenge }
  | { readonly kind: 'unconfigured' }
  | { readonly kind: 'rejected'; readonly reason: string };

/**
 * Verify against every configured secret. The challenge is answered without
 * one (it is how the endpoint gets its first secret), so with no secret the
 * only thing accepted is a challenge.
 */
function verify(raw: Buffer, req: Request, secrets: readonly string[]): Verified {
  const candidates = secrets.length > 0 ? secrets : [''];
  let reason = 'not a file event';
  for (const secret of candidates) {
    try {
      return { kind: 'event', event: verifyFileEventSignature(raw, req.headers, secret) };
    } catch (error) {
      if (!(error instanceof FileEventVerificationError)) throw error;
      if (secrets.length === 0) return { kind: 'unconfigured' };
      reason = error.message;
    }
  }
  return { kind: 'rejected', reason };
}

export function createOxyFileEventsRouter(deps: OxyFileEventsDeps = {}): Router {
  const secrets = deps.secrets ?? configuredSecrets;
  const apply = deps.apply ?? applyFileEvent;
  const router = Router();

  router.post(
    OXY_FILE_EVENTS_PATH,
    express.raw({ type: () => true, limit: RAW_BODY_LIMIT }),
    (req: Request, res: Response, next) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const verified = verify(raw, req, secrets());
      if (verified.kind === 'unconfigured') {
        res.status(503).json({ received: false, error: 'file events are not configured' });
        return;
      }
      if (verified.kind === 'rejected') {
        res.status(400).json({ received: false, error: verified.reason });
        return;
      }
      const { event } = verified;
      if (event.type === 'webhook.challenge') {
        res.status(200).json({ challenge: event.challenge });
        return;
      }
      apply(event)
        .then((outcome) => {
          res.status(200).json({ received: true, duplicate: outcome.kind === 'duplicate' });
        })
        .catch(next);
    },
  );

  return router;
}
