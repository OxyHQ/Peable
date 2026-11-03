// Shared test harness: a minimal injectable `fetch` stub that records every
// request it receives and replies from a handler. Used by every layer of the
// SDK's test suite (`core/*`, `resources/*`) so each test only has to
// describe request→response routing, not re-implement a fetch mock.

export interface CapturedRequest {
  method: string;
  url: string;
  headers: Headers;
  body: string | undefined;
}

export interface MockResponseSpec {
  status: number;
  json?: unknown;
  /** Raw text body — mutually exclusive with `json`. Used to test malformed/empty bodies. */
  text?: string;
  /** Extra response headers (`Request-Id`, …). */
  headers?: Record<string, string>;
}

export type MockFetchHandler = (
  request: CapturedRequest,
) => MockResponseSpec | Promise<MockResponseSpec>;

export interface MockFetch {
  fetch: typeof fetch;
  requests: CapturedRequest[];
}

function toRequestBody(init: RequestInit | undefined): string | undefined {
  return typeof init?.body === 'string' ? init.body : undefined;
}

export function createMockFetch(handler: MockFetchHandler): MockFetch {
  const requests: CapturedRequest[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const captured: CapturedRequest = {
      method: init?.method ?? 'GET',
      url,
      headers: new Headers(init?.headers),
      body: toRequestBody(init),
    };
    requests.push(captured);

    const spec = await handler(captured);
    const body = spec.json !== undefined ? JSON.stringify(spec.json) : (spec.text ?? '');
    return new Response(body, {
      status: spec.status,
      headers: { 'Content-Type': 'application/json', ...spec.headers },
    });
  }) as typeof fetch;

  return { fetch: fetchImpl, requests };
}
