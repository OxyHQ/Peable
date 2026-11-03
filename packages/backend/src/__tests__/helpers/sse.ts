/**
 * A minimal Server-Sent Events reader for the live-tail suites: open a stream,
 * then `next()` the frames in order, each with a deadline so a frame that
 * never comes fails the case instead of hanging it.
 */
export interface SseFrame {
  readonly id?: string;
  readonly event: string;
  readonly data: string;
}

export interface SseStream {
  readonly status: number;
  readonly headers: Headers;
  /** The next frame, or a rejection after `timeoutMs`. */
  next(timeoutMs?: number): Promise<SseFrame>;
  /** Resolves `null` when no frame arrives within `ms` — for asserting silence. */
  quiet(ms: number): Promise<SseFrame | null>;
  close(): void;
}

export async function openSse(
  url: string,
  headers: Record<string, string> = {},
): Promise<SseStream> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const frames: SseFrame[] = [];
  const waiters: ((frame: SseFrame) => void)[] = [];
  const deliver = (frame: SseFrame) => {
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  };

  if (response.body && response.headers.get('content-type')?.startsWith('text/event-stream')) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');
            let id: string | undefined;
            let event = 'message';
            const data: string[] = [];
            for (const line of block.split('\n')) {
              if (line.startsWith(':') || line.startsWith('retry:')) continue;
              if (line.startsWith('id: ')) id = line.slice(4);
              else if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) data.push(line.slice(6));
            }
            if (data.length > 0) deliver({ ...(id ? { id } : {}), event, data: data.join('\n') });
          }
        }
      } catch {
        // Aborted by `close()`.
      }
    })();
  }

  const take = (timeoutMs: number): Promise<SseFrame | null> => {
    const ready = frames.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const waiter = (frame: SseFrame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        resolve(null);
      }, timeoutMs);
      waiters.push(waiter);
    });
  };

  return {
    status: response.status,
    headers: response.headers,
    async next(timeoutMs = 3_000) {
      const frame = await take(timeoutMs);
      if (!frame) throw new Error(`no SSE frame within ${String(timeoutMs)}ms`);
      return frame;
    },
    quiet: (ms) => take(ms),
    close: () => controller.abort(),
  };
}
