import { describe, expect, test } from 'bun:test';
import {
  Peable,
  peableForOxyService,
  PEABLE_SERVICE_AUDIENCE,
  type PeableOxyHost,
} from '../src/index';
import { PaymentIntentsResource } from '../src/resources/paymentIntents';
import { PaymentLinksResource } from '../src/resources/paymentLinks';
import { CheckoutResource, CheckoutSessionsResource } from '../src/resources/checkoutSessions';
import { WebhooksResource } from '../src/resources/webhooks';

describe('Peable', () => {
  test('wires paymentIntents/paymentLinks/checkout.sessions/webhooks', () => {
    const peable = new Peable({ publicKey: 'oxy_dk_test', secret: 'sk_test' });

    expect(peable.paymentIntents).toBeInstanceOf(PaymentIntentsResource);
    expect(peable.paymentLinks).toBeInstanceOf(PaymentLinksResource);
    expect(peable.checkout).toBeInstanceOf(CheckoutResource);
    expect(peable.checkout.sessions).toBeInstanceOf(CheckoutSessionsResource);
    expect(peable.webhooks).toBeInstanceOf(WebhooksResource);
  });

  test('throws when publicKey is missing (delegates to resolveConfig)', () => {
    expect(() => new Peable({ publicKey: '', secret: 'sk_test' })).toThrow(/publicKey/);
  });

  test('throws when secret is missing', () => {
    expect(() => new Peable({ publicKey: 'oxy_dk_test', secret: '' })).toThrow(/secret/);
  });

  test('wires the same namespaces from a tokenProvider alone', () => {
    const peable = new Peable({
      tokenProvider: { getToken: async () => 'token', invalidate: () => {} },
    });

    expect(peable.paymentIntents).toBeInstanceOf(PaymentIntentsResource);
    expect(peable.checkout.sessions).toBeInstanceOf(CheckoutSessionsResource);
    expect(peable.webhooks).toBeInstanceOf(WebhooksResource);
  });

  test('refuses a tokenProvider together with a credential', () => {
    const tokenProvider = { getToken: async () => 'token', invalidate: () => {} };
    const both = { tokenProvider, publicKey: 'oxy_dk_test', secret: 'sk_test' };
    // @ts-expect-error — the config union forbids both; this is the runtime guard.
    expect(() => new Peable(both)).toThrow(/not both/);
  });

  test('refuses neither a tokenProvider nor a credential', () => {
    // @ts-expect-error — the config union requires one of the two.
    expect(() => new Peable({})).toThrow(/tokenProvider/);
  });
});

test('own factory uses canonical shared transport and snapshots requester context', async () => {
  const received: Parameters<PeableOxyHost['createServiceClient']>[0][] = [];
  let disposed = 0;
  const oxy: PeableOxyHost = {
    createServiceClient(options) {
      received.push(options);
      const fetch = Object.assign(
        async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
          expect(new Headers(init?.headers).has('authorization')).toBe(false);
          return Response.json({ id: options.requester?.accountId });
        },
        { preconnect: globalThis.fetch.preconnect },
      );
      return {
        fetch,
        dispose() {
          disposed++;
        },
      };
    },
  };
  const requester = { accountId: 'A', requesterContext: 'proof-A' };
  const a = peableForOxyService({ oxy, requester, baseURL: 'https://receiver.test' });
  requester.accountId = 'B';
  requester.requesterContext = 'proof-B';
  const b = peableForOxyService({ oxy, requester });
  expect(received[0]).toEqual({
    baseURL: 'https://receiver.test',
    audience: PEABLE_SERVICE_AUDIENCE,
    requester: { accountId: 'A', requesterContext: 'proof-A' },
  });
  expect((await a.paymentIntents.retrieve('pi_a')).id).toBe('A');
  expect((await b.paymentIntents.retrieve('pi_b')).id).toBe('B');
  a.dispose();
  b.dispose();
  expect(disposed).toBe(2);
  // @ts-expect-error — external credentials and workload identity are exclusive.
  expect(() => new Peable({ oxy, publicKey: 'external', secret: 'secret' })).toThrow(
    /cannot be combined/,
  );
});
