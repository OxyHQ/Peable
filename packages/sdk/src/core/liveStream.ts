// A live tail — `GET /v1/events/stream`, `GET /v1/request_logs/stream` — read
// as an async iterable of the objects it carries (Server-Sent Events).
//
// The gateway ends every stream after at most 15 minutes, and a network can
// drop one at any time; the iterator reconnects on its own, sending the last
// id it yielded as `Last-Event-ID`, so the gateway replays whatever committed
// in between and nothing is lost or repeated. It stops only when `signal`
// aborts (the iterator then simply ends) or the gateway REFUSES the stream —
// a 4xx such as a live credential's `test_mode_only` — which is thrown.

import type { GatewayClient, RestClientStreamOptions } from './client';
import type { QueryValue } from './list';
import { PeableError } from './errors';

export interface LiveStreamOptions {
  /** Ends the stream; the iterator returns once it aborts. */
  signal?: AbortSignal;
  /** Called every time the stream is (re)established and ready to deliver. */
  onConnect?: () => void;
  /** Called when the connection dropped and the iterator is about to reconnect. */
  onDisconnect?: (error: unknown) => void;
}

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

/** Whether a failure is the gateway refusing the stream, rather than the connection failing. */
function isRefusal(error: unknown): boolean {
  return (
    error instanceof PeableError &&
    error.statusCode !== undefined &&
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    error.statusCode !== 408 &&
    error.statusCode !== 429
  );
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

interface Frame {
  id?: string;
  event: string;
  data: string;
}

/** The frames of one SSE response body, as they arrive. */
async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<Frame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
        let id: string | undefined;
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line === '' || line.startsWith(':')) continue;
          const separator = line.indexOf(':');
          const field = separator === -1 ? line : line.slice(0, separator);
          let value = separator === -1 ? '' : line.slice(separator + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'id') id = value;
          else if (field === 'event') event = value;
          else if (field === 'data') data.push(value);
        }
        if (data.length > 0)
          yield { ...(id === undefined ? {} : { id }), event, data: data.join('\n') };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Iterate the `eventName` objects of the stream at `path`, reconnecting as
 * described above.
 */
export async function* liveStream<T>(
  client: GatewayClient,
  path: string,
  eventName: string,
  query: Readonly<Record<string, QueryValue>>,
  options: LiveStreamOptions = {},
  request: Pick<
    RestClientStreamOptions,
    'apiVersion' | 'peableAccount' | 'acceptsPeableAccount'
  > = {},
): AsyncGenerator<T> {
  const { signal } = options;
  let lastEventId: string | undefined;
  let backoff = MIN_BACKOFF_MS;
  while (!signal?.aborted) {
    try {
      const response = await client.stream(path, {
        ...request,
        query,
        ...(signal ? { signal } : {}),
        ...(lastEventId === undefined ? {} : { headers: { 'Last-Event-ID': lastEventId } }),
      });
      if (!response.body) throw new Error('the stream answered with no body');
      let ready = false;
      for await (const frame of frames(response.body)) {
        if (frame.event === 'ready') {
          ready = true;
          backoff = MIN_BACKOFF_MS;
          options.onConnect?.();
          continue;
        }
        if (frame.event !== eventName) continue;
        if (frame.id !== undefined) lastEventId = frame.id;
        yield JSON.parse(frame.data) as T;
      }
      if (signal?.aborted) return;
      options.onDisconnect?.(undefined);
      // The gateway ended a stream it had opened (its lifetime): reconnect at
      // once. One that ended before it was ready backs off like an error.
      if (ready) continue;
    } catch (error) {
      if (signal?.aborted) return;
      if (isRefusal(error)) throw error;
      options.onDisconnect?.(error);
    }
    await sleep(backoff + Math.floor(Math.random() * backoff * 0.2), signal);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}
