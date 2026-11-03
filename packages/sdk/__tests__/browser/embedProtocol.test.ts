import { describe, expect, test } from 'bun:test';
import {
  buildEmbedUrl,
  envelope,
  normalizeOrigin,
  parseEmbedFragment,
  readFrameMessage,
  readHostMessage,
  sessionIdFromClientSecret,
} from '../../src/browser/embedProtocol';

const SESSION = 'cs_0123456789abcdef01234567';
const SECRET = `${SESSION}_secret_00112233445566778899aabbccddeeff`;
const CHECKOUT = 'https://checkout.peable.to';
const frameWindow = { name: 'frame' };
const expected = { origin: CHECKOUT, source: frameWindow, sessionId: SESSION };

function frameEvent(data: unknown, overrides: { origin?: string; source?: unknown } = {}) {
  return { origin: overrides.origin ?? CHECKOUT, source: overrides.source ?? frameWindow, data };
}

describe('session ids and origins', () => {
  test('the session id is the prefix of its client secret', () => {
    expect(sessionIdFromClientSecret(SECRET)).toBe(SESSION);
    expect(sessionIdFromClientSecret('pi_0123456789abcdef01234567_secret_0011223344556677')).toBe(
      null,
    );
    expect(sessionIdFromClientSecret(`${SESSION}_secret_`)).toBe(null);
  });

  test('an origin is normalized, and a non-web URL is not one', () => {
    expect(normalizeOrigin('https://shop.example/cart?x=1')).toBe('https://shop.example');
    expect(normalizeOrigin('javascript:alert(1)')).toBe(null);
    expect(normalizeOrigin('not a url')).toBe(null);
  });
});

describe('buildEmbedUrl / parseEmbedFragment', () => {
  test('round-trip, with the secret only in the fragment', () => {
    const url = buildEmbedUrl({
      checkoutUrl: `${CHECKOUT}/`,
      clientSecret: SECRET,
      hostOrigin: 'https://shop.example/checkout',
      locale: 'es',
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe(CHECKOUT);
    expect(parsed.pathname).toBe(`/embed/${SESSION}`);
    expect(parsed.search).toBe('');
    expect(`${parsed.origin}${parsed.pathname}`).not.toContain('secret');
    expect(parseEmbedFragment(parsed.hash)).toEqual({
      clientSecret: SECRET,
      hostOrigin: 'https://shop.example',
      locale: 'es',
    });
  });

  test('refuses a secret that is not a session one, or a host with no origin', () => {
    expect(() =>
      buildEmbedUrl({
        checkoutUrl: CHECKOUT,
        clientSecret: 'nope',
        hostOrigin: 'https://a.example',
      }),
    ).toThrow();
    expect(() =>
      buildEmbedUrl({ checkoutUrl: CHECKOUT, clientSecret: SECRET, hostOrigin: 'file:///x' }),
    ).toThrow();
    expect(parseEmbedFragment('#cs=nope&origin=https://a.example')).toBe(null);
    expect(parseEmbedFragment(`#cs=${SECRET}`)).toBe(null);
  });
});

describe('readFrameMessage (host side)', () => {
  test('accepts a well-formed message from the frame', () => {
    expect(
      readFrameMessage(frameEvent(envelope({ type: 'ready', session_id: SESSION })), expected),
    ).toEqual({
      type: 'ready',
      session_id: SESSION,
    });
    expect(
      readFrameMessage(
        frameEvent(
          envelope({
            type: 'complete',
            session_id: SESSION,
            success_url: 'https://shop.example/ok',
          }),
        ),
        expected,
      ),
    ).toEqual({ type: 'complete', session_id: SESSION, success_url: 'https://shop.example/ok' });
  });

  test('ignores another origin, another window, another session, and stray traffic', () => {
    const ready = envelope({ type: 'ready', session_id: SESSION });
    expect(readFrameMessage(frameEvent(ready, { origin: 'https://evil.example' }), expected)).toBe(
      null,
    );
    expect(readFrameMessage(frameEvent(ready, { source: { name: 'other' } }), expected)).toBe(null);
    expect(
      readFrameMessage(
        frameEvent(envelope({ type: 'ready', session_id: 'cs_ffffffffffffffffffffffff' })),
        expected,
      ),
    ).toBe(null);
    expect(readFrameMessage(frameEvent({ type: 'ready', session_id: SESSION }), expected)).toBe(
      null,
    );
    expect(readFrameMessage(frameEvent('ready'), expected)).toBe(null);
    expect(readFrameMessage(frameEvent({ ...ready, version: 2 }), expected)).toBe(null);
  });

  test('ignores a malformed resize or complete, and bounds a resize', () => {
    const bad = [
      { type: 'resize', session_id: SESSION, height: 'tall' },
      { type: 'resize', session_id: SESSION, height: -1 },
      { type: 'resize', session_id: SESSION, height: Number.POSITIVE_INFINITY },
      { type: 'complete', session_id: SESSION, success_url: 'javascript:alert(1)' },
      { type: 'complete', session_id: SESSION, success_url: 42 },
      { type: 'error', session_id: SESSION, message: { html: '<b>' } },
      { type: 'navigate', session_id: SESSION, url: 'https://evil.example' },
    ];
    for (const message of bad) {
      expect(
        readFrameMessage(
          frameEvent({ ...message, source: 'peable-checkout', version: 1 }),
          expected,
        ),
      ).toBe(null);
    }
    expect(
      readFrameMessage(
        frameEvent(envelope({ type: 'resize', session_id: SESSION, height: 99_999.2 })),
        expected,
      ),
    ).toEqual({ type: 'resize', session_id: SESSION, height: 10_000 });
  });
});

describe('readHostMessage (frame side)', () => {
  const host = { origin: 'https://shop.example', source: { name: 'parent' }, sessionId: SESSION };

  test('accepts an appearance from the host, and nothing else', () => {
    const appearance = envelope({
      type: 'appearance',
      session_id: SESSION,
      appearance: { theme: 'night' },
    });
    expect(
      readHostMessage({ origin: host.origin, source: host.source, data: appearance }, host),
    ).toEqual({
      type: 'appearance',
      session_id: SESSION,
      appearance: { theme: 'night' },
    });
    expect(
      readHostMessage(
        { origin: 'https://evil.example', source: host.source, data: appearance },
        host,
      ),
    ).toBe(null);
    expect(
      readHostMessage(
        {
          origin: host.origin,
          source: host.source,
          data: { ...appearance, type: 'complete', success_url: 'https://evil.example' },
        },
        host,
      ),
    ).toBe(null);
    expect(
      readHostMessage(
        { origin: host.origin, source: host.source, data: { ...appearance, appearance: ['x'] } },
        host,
      ),
    ).toBe(null);
  });
});
