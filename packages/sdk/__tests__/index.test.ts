import { describe, expect, test } from 'bun:test';
import { Peable } from '../src/index';
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
