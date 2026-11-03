import type { Request, Response } from 'express';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { liveTailHub, type LiveTailChannel } from '../services/liveTail';
import { sendError } from './http';

/**
 * Serve a live tail as Server-Sent Events: `GET /v1/events/stream` and
 * `GET /v1/request_logs/stream`, what `peable listen` and `peable logs tail`
 * read.
 *
 * ## Why SSE, and not a Socket.IO namespace
 *
 * It is one ordinary `GET`, so it runs the same chain as every merchant route —
 * the global rate limiter, `requireMerchant` (an Oxy service token, verified
 * exactly as for a list), `requireAuthenticated`, `requireScope` — with no
 * second authentication path to keep in step. Socket.IO's only namespace here
 * is the anonymous payer channel, and a service-authenticated one would be a
 * new handshake verifier for one consumer. A CLI reads SSE with `fetch` alone.
 *
 * ## The wire
 *
 * ```
 * retry: 3000
 *
 * event: ready
 * data: {"object":"live_stream","livemode":false}
 *
 * id: evt_…
 * event: event
 * data: {…the object exactly as the API (and a webhook) renders it…}
 *
 * : keepalive
 * ```
 *
 * A client that reconnects sends `Last-Event-ID` (EventSource does it on its
 * own): the stream first replays, oldest first, what committed after that id
 * (at most {@link RESUME_LIMIT}), so a reconnect — including the one forced
 * every {@link MAX_STREAM_LIFETIME_MS} — loses nothing. An id this caller cannot
 * read is ignored rather than refused, so a client retrying a stale id does not
 * loop on an error.
 *
 * ## Bounds
 *
 * Test mode only (403 `test_mode_only` for a live credential) — the tail is a
 * development tool, and `services/liveTail.ts` explains why live transactions
 * never signal it. At most {@link MAX_STREAMS_PER_MERCHANT} streams per merchant
 * per task. A stream lives at most {@link MAX_STREAM_LIFETIME_MS} and then ends,
 * so a credential that was revoked stops streaming at its next reconnect
 * instead of never. A comment every {@link HEARTBEAT_MS} keeps the load
 * balancer's and the edge's idle timeouts from cutting a quiet stream.
 */

export const MAX_STREAMS_PER_MERCHANT = 10;
export const MAX_STREAM_LIFETIME_MS = 15 * 60 * 1000;
export const HEARTBEAT_MS = 15_000;
/** How many committed rows a resume replays at most. */
export const RESUME_LIMIT = 100;
/** How many ids a stream remembers sending, so a replay and a live signal never send one row twice. */
const SENT_MEMORY = 1_000;
const RETRY_MS = 3_000;

export interface LiveStreamSource<Row> {
  readonly channel: LiveTailChannel;
  /** The SSE `event:` name of a row. */
  readonly eventName: string;
  /** One row by INTERNAL id, inside the stream's merchant (and the API's retention), or null. */
  load(id: string): Promise<Row | null>;
  /** A `Last-Event-ID` (public id) → the internal id, inside the stream's merchant, or null. */
  resolveCursor(publicId: string): Promise<string | null>;
  /** The rows committed after the row `internalId`, oldest first, at most `limit`. */
  after(internalId: string, limit: number): Promise<Row[]>;
  /** The stream's own filter (`types`, `status`, …). */
  matches(row: Row): boolean;
  internalId(row: Row): string;
  publicId(row: Row): string;
  /** The row exactly as the API renders it. */
  render(row: Row): object;
}

/** Refuse a live-mode caller. The one answer every test-mode-only route gives. */
export function refuseLivemode(res: Response, merchant: MerchantRow, what: string): boolean {
  if (!merchant.livemode) return false;
  sendError(
    res,
    403,
    'permission_error',
    `${what} is only available in test mode; use a test-mode (non-production) credential.`,
    'test_mode_only',
  );
  return true;
}

export async function serveLiveStream<Row>(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  source: LiveStreamSource<Row>,
): Promise<void> {
  if (refuseLivemode(res, merchant, 'This stream')) return;
  if (liveTailHub.count(source.channel, merchant.id) >= MAX_STREAMS_PER_MERCHANT) {
    sendError(
      res,
      429,
      'rate_limit_error',
      `At most ${MAX_STREAMS_PER_MERCHANT} streams may be open at once; close one first.`,
      'too_many_streams',
    );
    return;
  }

  // A stream is not a request a merchant reads back in their log: it would be
  // a row whose duration is the stream's lifetime, and `peable logs tail`
  // would log its own connection.
  res.locals.skipRequestLog = true;

  const lastEventId = req.header('Last-Event-ID');
  let cursor = lastEventId ? await source.resolveCursor(lastEventId) : null;

  const sent = new Set<string>();
  let closed = false;
  let queue: Promise<void> = Promise.resolve();

  const write = (chunk: string): void => {
    if (!closed) res.write(chunk);
  };
  const send = (row: Row): void => {
    const id = source.internalId(row);
    cursor = id;
    if (sent.has(id) || !source.matches(row)) return;
    sent.add(id);
    if (sent.size > SENT_MEMORY) {
      const oldest = sent.values().next().value;
      if (oldest !== undefined) sent.delete(oldest);
    }
    write(
      `id: ${source.publicId(row)}\nevent: ${source.eventName}\ndata: ${JSON.stringify(source.render(row))}\n\n`,
    );
  };
  // One task at a time, in arrival order, so rows go out in the order they
  // were signalled and a replay never interleaves with a live row.
  const enqueue = (task: () => Promise<void>): void => {
    queue = queue.then(task).catch((error: unknown) => {
      console.error(`[${String(res.locals.requestId)}] live stream: a row failed to load`, error);
    });
  };
  const replay = async (): Promise<void> => {
    if (cursor === null) return;
    for (const row of await source.after(cursor, RESUME_LIMIT)) send(row);
  };

  const unsubscribe = await liveTailHub.subscribe(source.channel, merchant.id, {
    onRow: (rowId) =>
      enqueue(async () => {
        const row = await source.load(rowId);
        if (row) send(row);
      }),
    onResync: () => enqueue(replay),
  });

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  // Proxies that buffer by default (nginx) must pass every frame through.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  write(`retry: ${RETRY_MS}\n\n`);
  write(
    `event: ready\ndata: ${JSON.stringify({ object: 'live_stream', livemode: merchant.livemode })}\n\n`,
  );
  if (cursor !== null) enqueue(replay);

  const heartbeat = setInterval(() => write(': keepalive\n\n'), HEARTBEAT_MS);
  heartbeat.unref?.();
  const lifetime = setTimeout(() => res.end(), MAX_STREAM_LIFETIME_MS);
  lifetime.unref?.();

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(lifetime);
    void unsubscribe();
  };
  // The RESPONSE's close, never the request's: a GET's request side closes as
  // soon as its (empty) body is read, long before the client goes away.
  res.on('close', close);
}
