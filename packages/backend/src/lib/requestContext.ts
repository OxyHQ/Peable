import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';
import type { WebhookEventRequest } from '@peable.to/shared-types';
import { requestIdOf } from './requestId';

/**
 * The API request a change is being made under — what an event records as its
 * `request` (Stripe's `event.request`, ADR 0014 D4).
 *
 * An event is written deep inside a service (`transitionIntent`, the refund
 * and account services), several calls away from the route that caused it, and
 * the same services run from background loops that no request caused. Threading
 * a request id through every one of those signatures would put an HTTP concept
 * in the money code; this carries it beside the call instead, and a background
 * loop simply has none.
 *
 * Opened by the routes that act for a merchant — the `idempotent` layer on every
 * merchant `POST`, and the dashboard's writes — AFTER the body is parsed. It is
 * deliberately not opened by `requestIdMiddleware`: that runs before
 * `express.json()`, whose stream callbacks do not carry an async context, and a
 * provider's or Oxy's inbound notification is not the merchant's API call.
 */
interface RequestContext {
  readonly requestId: string;
  idempotencyKey: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` (and everything it awaits) as part of the API request `requestId`. */
export function runInRequestContext<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId, idempotencyKey: null }, fn);
}

/** Record the `Idempotency-Key` the current request was admitted with. */
export function setRequestIdempotencyKey(key: string): void {
  const context = storage.getStore();
  if (context) context.idempotencyKey = key;
}

/** What an event caused right now records as its `request`. */
export function currentEventRequest(): WebhookEventRequest {
  const context = storage.getStore();
  return {
    id: context?.requestId ?? null,
    idempotency_key: context?.idempotencyKey ?? null,
  };
}

/**
 * The same context as a middleware, for a route that acts for a merchant but
 * is not behind the `idempotent` layer (the dashboard's writes). Mounted after
 * the body parser, like every route.
 */
export const requestContextMiddleware: RequestHandler = (_req, res, next) => {
  const requestId = requestIdOf(res);
  if (requestId === undefined) {
    next();
    return;
  }
  runInRequestContext(requestId, next);
};
