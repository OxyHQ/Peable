/**
 * `PeableCheckout.mountCheckout` against a fake environment: the iframe it
 * builds, and which `message` events it believes.
 */
import { describe, expect, test } from 'bun:test';
import {
  type EmbeddedCheckoutEnvironment,
  mountCheckoutIn,
  type MountCheckoutOptions,
} from '../../src/browser/embeddedCheckout';
import { envelope } from '../../src/browser/embedProtocol';
import { PeableCheckout } from '../../src/browser/mount';
import { PeableInvalidRequestError } from '../../src/core/errors';

const SESSION = 'cs_0123456789abcdef01234567';
const SECRET = `${SESSION}_secret_00112233445566778899aabbccddeeff`;
const CHECKOUT = 'https://checkout.peable.to';

interface FakeIframe {
  src: string;
  title: string;
  attributes: Record<string, string>;
  style: Record<string, string>;
  contentWindow: {
    posted: Array<{ data: unknown; origin: string }>;
    postMessage(data: unknown, origin: string): void;
  };
  removed: boolean;
  setAttribute(name: string, value: string): void;
  remove(): void;
}

function fakeEnvironment() {
  const listeners = new Set<(event: MessageEvent) => void>();
  const assigned: string[] = [];
  const frames: FakeIframe[] = [];
  const container = {
    children: [] as unknown[],
    replaceChildren(...nodes: unknown[]) {
      this.children = nodes;
    },
  };
  const env: EmbeddedCheckoutEnvironment = {
    document: {
      createElement: () => {
        const frame: FakeIframe = {
          src: '',
          title: '',
          attributes: {},
          style: {},
          contentWindow: {
            posted: [],
            postMessage(data, origin) {
              this.posted.push({ data, origin });
            },
          },
          removed: false,
          setAttribute(name, value) {
            this.attributes[name] = value;
          },
          remove() {
            this.removed = true;
          },
        };
        frames.push(frame);
        return frame as unknown as HTMLIFrameElement;
      },
      querySelector: (selector) =>
        selector === '#checkout' ? (container as unknown as Element) : null,
    },
    window: {
      location: {
        origin: 'https://shop.example',
        assign: (url) => {
          assigned.push(url);
        },
      },
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    },
  };
  const dispatch = (data: unknown, overrides: { origin?: string; source?: unknown } = {}) => {
    const frame = frames[0];
    for (const listener of listeners) {
      listener({
        origin: overrides.origin ?? CHECKOUT,
        source: overrides.source ?? frame?.contentWindow,
        data,
      } as unknown as MessageEvent);
    }
  };
  return { env, frames, container, assigned, listeners, dispatch };
}

function mount(options: Partial<MountCheckoutOptions> = {}) {
  const fake = fakeEnvironment();
  const instance = mountCheckoutIn(fake.env, '#checkout', { clientSecret: SECRET, ...options });
  const frame = fake.frames[0];
  if (!frame) throw new Error('no frame');
  return { ...fake, instance, frame };
}

describe('mountCheckout', () => {
  test('is on PeableCheckout beside mount', () => {
    expect(typeof PeableCheckout.mountCheckout).toBe('function');
    expect(typeof PeableCheckout.mount).toBe('function');
  });

  test('frames the session from checkout.peable.to with the secret in the fragment', () => {
    const { frame, container } = mount({ locale: 'fr' });
    const url = new URL(frame.src);
    expect(url.origin).toBe(CHECKOUT);
    expect(url.pathname).toBe(`/embed/${SESSION}`);
    expect(url.search).toBe('');
    expect(url.hash).toContain(`cs=${SECRET}`);
    expect(url.hash).toContain(`origin=${encodeURIComponent('https://shop.example')}`);
    expect(url.hash).toContain('locale=fr');
    expect(frame.attributes.allow).toBe('payment');
    expect(frame.attributes.sandbox).toBe(
      'allow-scripts allow-same-origin allow-forms allow-popups',
    );
    expect(frame.title).toBe('Peable checkout');
    expect(container.children).toEqual([frame]);
  });

  test('refuses a target that is missing or a secret that is not a session one', () => {
    const fake = fakeEnvironment();
    expect(() => mountCheckoutIn(fake.env, '#nowhere', { clientSecret: SECRET })).toThrow(
      PeableInvalidRequestError,
    );
    expect(() => mountCheckoutIn(fake.env, '#checkout', { clientSecret: 'pi_x_secret_y' })).toThrow(
      PeableInvalidRequestError,
    );
  });

  test('sends the appearance on ready and on update, to the checkout origin only', () => {
    const { frame, dispatch, instance } = mount({ appearance: { theme: 'night' } });
    dispatch(envelope({ type: 'ready', session_id: SESSION }));
    expect(frame.contentWindow.posted).toEqual([
      {
        data: envelope({ type: 'appearance', session_id: SESSION, appearance: { theme: 'night' } }),
        origin: CHECKOUT,
      },
    ]);
    instance.updateAppearance({ theme: 'flat' });
    expect(frame.contentWindow.posted[1]?.origin).toBe(CHECKOUT);
    expect(frame.contentWindow.posted[1]?.data).toMatchObject({ appearance: { theme: 'flat' } });
  });

  test('resizes on a resize from the frame, ignores one from anywhere else', () => {
    const { frame, dispatch } = mount();
    dispatch(envelope({ type: 'resize', session_id: SESSION, height: 812 }));
    expect(frame.style.height).toBe('812px');
    dispatch(envelope({ type: 'resize', session_id: SESSION, height: 50 }), {
      origin: 'https://evil.example',
    });
    dispatch(envelope({ type: 'resize', session_id: SESSION, height: 60 }), { source: {} });
    expect(frame.style.height).toBe('812px');
  });

  test('complete calls onComplete once, with the session and its success url', () => {
    const completions: unknown[] = [];
    const { dispatch, assigned } = mount({ onComplete: (event) => completions.push(event) });
    const complete = envelope({
      type: 'complete',
      session_id: SESSION,
      success_url: 'https://shop.example/thanks?cs=x',
    });
    dispatch(complete);
    dispatch(complete);
    expect(completions).toEqual([
      { sessionId: SESSION, successUrl: 'https://shop.example/thanks?cs=x' },
    ]);
    expect(assigned).toEqual([]);
  });

  test('without onComplete, complete navigates to the success url', () => {
    const { dispatch, assigned } = mount();
    dispatch(
      envelope({ type: 'complete', session_id: SESSION, success_url: 'https://shop.example/ok' }),
    );
    expect(assigned).toEqual(['https://shop.example/ok']);
  });

  test('a forged complete from another origin does nothing', () => {
    const completions: unknown[] = [];
    const { dispatch, assigned } = mount({ onComplete: (event) => completions.push(event) });
    dispatch(
      envelope({ type: 'complete', session_id: SESSION, success_url: 'https://evil.example' }),
      {
        origin: 'https://evil.example',
      },
    );
    expect(completions).toEqual([]);
    expect(assigned).toEqual([]);
  });

  test('expired and error reach their callbacks', () => {
    const seen: string[] = [];
    const { dispatch } = mount({
      onExpired: () => seen.push('expired'),
      onError: (event) => seen.push(`error:${event.message}`),
    });
    dispatch(envelope({ type: 'expired', session_id: SESSION }));
    dispatch(envelope({ type: 'error', session_id: SESSION, message: 'boom' }));
    expect(seen).toEqual(['expired', 'error:boom']);
  });

  test('destroy removes the frame and stops listening', () => {
    const { frame, instance, listeners, dispatch } = mount();
    instance.destroy();
    expect(frame.removed).toBe(true);
    expect(listeners.size).toBe(0);
    dispatch(envelope({ type: 'resize', session_id: SESSION, height: 900 }));
    expect(frame.style.height).toBe('600px');
  });
});
