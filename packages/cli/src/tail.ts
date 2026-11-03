import type { Peable, RequestLogMethod, RequestLogStatusFilter } from '@peable.to/sdk';
import { forwardEvent, generateSessionSecret } from './forward.js';
import type { Io } from './io.js';
import { timestamp } from './output.js';

/**
 * The two long-running commands: `peable listen` and `peable logs tail`. Both
 * read a TEST-MODE live tail through the SDK (`events.stream`,
 * `requestLogs.stream`), which reconnects and resumes on its own; both end on
 * Ctrl-C.
 */

export interface ListenOptions {
  readonly peable: Peable;
  readonly io: Io;
  /** Where to POST each event, signed. Absent: print only. */
  readonly forwardTo?: string | undefined;
  /** Exact types or `prefix.*`. Absent: every event. */
  readonly events?: readonly string[] | undefined;
  /** Print each event's full JSON. */
  readonly printJson?: boolean;
  /** The session secret; generated when absent (a suite passes one to compare). */
  readonly secret?: string;
  /** Ends the command (Ctrl-C). */
  readonly signal: AbortSignal;
}

/**
 * `peable listen`: every event of the test-mode merchant as it is recorded,
 * signed with a secret this session generates and printed once, and POSTed to
 * `forwardTo` — in order, one at a time, so a receiver sees events in the
 * order they were recorded.
 */
export async function runListen(options: ListenOptions): Promise<void> {
  const { io } = options;
  const secret = options.secret ?? generateSessionSecret();
  let connected = false;
  const stream = options.peable.events.stream(
    options.events && options.events.length > 0 ? { types: options.events.join(',') } : {},
    {
      signal: options.signal,
      onConnect: () => {
        if (connected) {
          io.err(`${timestamp()}   Reconnected.`);
          return;
        }
        connected = true;
        io.err(`Ready! Your webhook signing secret is ${secret} (^C to quit)`);
        if (options.forwardTo) io.err(`Forwarding events to ${options.forwardTo}`);
      },
      onDisconnect: (error) => {
        if (error !== undefined) {
          io.err(
            `${timestamp()}   Connection lost (${error instanceof Error ? error.message : String(error)}); reconnecting…`,
          );
        }
      },
    },
  );

  for await (const event of stream) {
    printEvent(io, event, options.printJson === true);
    if (!options.forwardTo) continue;
    const result = await forwardEvent(event, { url: options.forwardTo, secret });
    io.out(
      result.ok
        ? `${timestamp()}  <--  [${String(result.status)}] POST ${options.forwardTo} [${event.id}] ${String(result.durationMs)}ms`
        : `${timestamp()}  <--  [ERR] POST ${options.forwardTo} [${event.id}] ${result.error}`,
    );
  }
}

function printEvent(
  io: Io,
  event: { readonly id: string; readonly type: string; readonly created: number },
  json: boolean,
): void {
  io.out(`${timestamp(new Date(event.created * 1000))}   --> ${event.type} [${event.id}]`);
  if (json) io.out(JSON.stringify(event, null, 2));
}

export interface LogsTailOptions {
  readonly peable: Peable;
  readonly io: Io;
  readonly status?: RequestLogStatusFilter | undefined;
  readonly method?: RequestLogMethod | undefined;
  readonly json?: boolean;
  readonly signal: AbortSignal;
}

/** `peable logs tail`: the merchant's requests as they are answered. */
export async function runLogsTail(options: LogsTailOptions): Promise<void> {
  const { io } = options;
  let connected = false;
  const stream = options.peable.requestLogs.stream(
    {
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.method !== undefined ? { method: options.method } : {}),
    },
    {
      signal: options.signal,
      onConnect: () => {
        if (!connected) io.err('Getting ready... tailing your request log (^C to quit)');
        connected = true;
      },
    },
  );
  for await (const log of stream) {
    if (options.json === true) {
      io.out(JSON.stringify(log));
      continue;
    }
    io.out(
      `${timestamp(new Date(log.created * 1000))} [${String(log.status)}] ${log.method} ${log.path} [${log.id}] ${String(log.duration_ms)}ms${log.idempotency_key ? ` (Idempotency-Key ${log.idempotency_key})` : ''}`,
    );
  }
}
