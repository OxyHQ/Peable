/**
 * A signal that aborts after `ms`, or as soon as `parent` aborts.
 *
 * React Native's AbortSignal (Hermes) has neither `AbortSignal.timeout` nor
 * `AbortSignal.any`; calling either throws before the request is sent. This
 * uses only an AbortController and a timer, so the same code runs on Hermes,
 * browsers, Node and Bun.
 *
 * Call `dispose()` once the response BODY has been read, not when the headers
 * arrive: the deadline bounds the whole exchange.
 *
 * Imports nothing: `./display` imports this file, and that entry must pull in
 * no other code (see `display.ts`).
 */
export interface TimeoutSignal {
  signal: AbortSignal;
  dispose: () => void;
}

export function timeoutSignal(
  ms: number,
  parent?: AbortSignal,
  message = 'The request timed out',
): TimeoutSignal {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent?.reason);
  const timer = setTimeout(() => {
    const reason = new Error(message);
    reason.name = 'TimeoutError';
    controller.abort(reason);
  }, ms);
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener('abort', onParentAbort);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}
