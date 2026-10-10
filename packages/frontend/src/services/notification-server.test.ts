/**
 * Tests for the notification-server HTTP client (spec §4.1 wire contract).
 *
 * These mock global `fetch` and assert the EXACT request the wallet makes:
 * the URL, method, and body shape the Explorer expects — and, critically, that
 * the registration body carries only the watch-only xpub and never any private
 * material (mnemonic / seed / xprv / privateKey). That invariant is what keeps
 * registration non-custodial and safe to run while the wallet is PIN-locked.
 */

import { describe, test, expect, afterEach, mock } from 'bun:test';
import {
  registerForPush,
  unregisterFromPush,
  normalizeServerUrl,
  type RegisterInput,
} from './notification-server';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * Install a fetch mock that records each call and replies with `response`.
 * Returns the array calls are pushed into.
 */
function installFetch(response: Response): CapturedCall[] {
  const calls: CapturedCall[] = [];
  const fetchMock = mock(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers: Record<string, string> = {};
      const rawHeaders = init?.headers;
      if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
        for (const [key, value] of Object.entries(rawHeaders)) {
          headers[key] = String(value);
        }
      }
      const rawBody = typeof init?.body === 'string' ? init.body : '{}';
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers,
        body: JSON.parse(rawBody) as Record<string, unknown>,
      });
      return response;
    },
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const INPUT: RegisterInput = {
  serverUrl: 'https://explorer.fairco.in',
  xpub: 'xpubFAKEaccountkey',
  scriptType: 'p2pkh',
  gapLimit: 20,
  network: 'mainnet',
  deviceToken: 'device-token-abc',
  platform: 'android',
  confirmations: 1,
  events: ['incoming_pending', 'incoming_confirmed', 'outgoing_confirmed'],
};

describe('registerForPush', () => {
  test('POSTs the exact wire-contract body and returns the subscriptionId', async () => {
    const calls = installFetch(
      jsonResponse({
        subscriptionId: 'sub_123',
        watchedTo: { receive: 25, change: 25 },
      }),
    );

    const result = await registerForPush(INPUT);

    expect(result.subscriptionId).toBe('sub_123');
    expect(result.watchedTo).toEqual({ receive: 25, change: 25 });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe('https://explorer.fairco.in/api/notifications/register');
    expect(call.method).toBe('POST');
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.body).toEqual({
      xpub: 'xpubFAKEaccountkey',
      scriptType: 'p2pkh',
      gapLimit: 20,
      network: 'mainnet',
      deviceToken: 'device-token-abc',
      platform: 'android',
      confirmations: 1,
      events: ['incoming_pending', 'incoming_confirmed', 'outgoing_confirmed'],
    });
  });

  test('the body carries NO private-key material', async () => {
    const calls = installFetch(jsonResponse({ subscriptionId: 'sub_1' }));
    await registerForPush(INPUT);

    const body = calls[0].body;
    expect(body.xpub).toBe('xpubFAKEaccountkey');
    for (const forbidden of ['privateKey', 'xprv', 'mnemonic', 'seed', 'wif']) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  test('normalizes a trailing slash in the server URL', async () => {
    const calls = installFetch(jsonResponse({ subscriptionId: 'sub_1' }));
    await registerForPush({ ...INPUT, serverUrl: 'https://explorer.fairco.in/' });
    expect(calls[0].url).toBe('https://explorer.fairco.in/api/notifications/register');
  });

  test('throws on a non-2xx response', async () => {
    installFetch(new Response('nope', { status: 500 }));
    await expect(registerForPush(INPUT)).rejects.toThrow(/HTTP 500/);
  });

  test('throws when the response omits a subscriptionId', async () => {
    installFetch(jsonResponse({ watchedTo: { receive: 1, change: 1 } }));
    await expect(registerForPush(INPUT)).rejects.toThrow(/subscriptionId/);
  });
});

describe('unregisterFromPush', () => {
  test('DELETEs { subscriptionId } to the register endpoint', async () => {
    const calls = installFetch(new Response(null, { status: 200 }));

    await unregisterFromPush('https://explorer.fairco.in', 'sub_123');

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe('https://explorer.fairco.in/api/notifications/register');
    expect(call.method).toBe('DELETE');
    expect(call.body).toEqual({ subscriptionId: 'sub_123' });
  });

  test('throws on a non-2xx response', async () => {
    installFetch(new Response('nope', { status: 404 }));
    await expect(unregisterFromPush('https://explorer.fairco.in', 'sub_x')).rejects.toThrow(
      /HTTP 404/,
    );
  });
});

describe('normalizeServerUrl', () => {
  test('strips trailing slashes and trims', () => {
    expect(normalizeServerUrl('https://a.b/')).toBe('https://a.b');
    expect(normalizeServerUrl('  https://a.b//  ')).toBe('https://a.b');
    expect(normalizeServerUrl('https://a.b')).toBe('https://a.b');
  });
});
