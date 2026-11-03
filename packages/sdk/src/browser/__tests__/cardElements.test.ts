import { describe, expect, it } from 'bun:test';
import {
  EXPRESS_CHECKOUT_OPTIONS,
  availableWallets,
  delayedProcessingNotice,
  mountCardElements,
  readRedirectReturn,
  withoutRedirectParams,
} from '../cardElements';
import type { ProviderFieldEvent, ProviderSdk } from '../providerJs';

/** A provider SDK that records what it was asked to do and lets a suite fire element events. */
function fakeProvider(confirmError?: { message?: string }) {
  const created: { type: string; options?: Record<string, unknown>; mountedOn?: unknown }[] = [];
  const handlers = new Map<string, (event?: ProviderFieldEvent) => void>();
  const destroyed: string[] = [];
  const confirms: Record<string, unknown>[] = [];
  const elementsCalls: Record<string, unknown>[] = [];
  const byType = new Map<string, { destroy(): void }>();
  const sdk = {
    elements(options: Record<string, unknown>) {
      elementsCalls.push(options);
      return {
        create(type: string, options?: Record<string, unknown>) {
          const record: (typeof created)[number] = { type, ...(options ? { options } : {}) };
          created.push(record);
          const element = {
            mount(target: unknown) {
              record.mountedOn = target;
            },
            on(event: string, callback: (event?: ProviderFieldEvent) => void) {
              handlers.set(`${type}:${event}`, callback);
            },
            unmount() {},
            destroy() {
              destroyed.push(type);
            },
          };
          byType.set(type, element);
          return element;
        },
        getElement(type: string) {
          return (byType.get(type) as never) ?? null;
        },
      };
    },
    async confirmPayment(options: Record<string, unknown>) {
      confirms.push(options);
      return confirmError ? { error: confirmError } : {};
    },
  } as unknown as ProviderSdk;
  return { sdk, created, handlers, destroyed, confirms, elementsCalls };
}

const paymentTarget = { id: 'fields' } as unknown as HTMLElement;
const walletTarget = { id: 'wallets' } as unknown as HTMLElement;

describe('mountCardElements', () => {
  it('mounts wallets above the payment fields on one elements instance', () => {
    const provider = fakeProvider();
    mountCardElements({
      sdk: provider.sdk,
      clientSecret: 'pi_x_secret_y',
      paymentTarget,
      walletTarget,
      returnUrl: 'https://checkout.example/i/pi_1',
    });
    expect(provider.elementsCalls).toEqual([{ clientSecret: 'pi_x_secret_y' }]);
    expect(provider.created.map((entry) => entry.type)).toEqual(['expressCheckout', 'payment']);
    expect(provider.created[0]?.mountedOn).toBe(walletTarget);
    expect(provider.created[1]?.mountedOn).toBe(paymentTarget);
    // The provider's own consumer wallet stays off: Orbit's checkout is not its brand.
    expect(provider.created[0]?.options).toEqual({ ...EXPRESS_CHECKOUT_OPTIONS });
    // No wallet twice: the payment fields stop offering what the slot shows.
    expect(provider.created[1]?.options?.wallets).toEqual({
      applePay: 'never',
      googlePay: 'never',
    });
  });

  it('mounts only the payment fields when no wallet slot is given', () => {
    const provider = fakeProvider();
    mountCardElements({ sdk: provider.sdk, clientSecret: 's', paymentTarget, returnUrl: 'r' });
    expect(provider.created.map((entry) => entry.type)).toEqual(['payment']);
    expect(provider.created[0]?.options?.wallets).toBeUndefined();
  });

  it('reports the wallets the device can run, and none when it can run none', () => {
    const provider = fakeProvider();
    const seen: (readonly string[])[] = [];
    mountCardElements({
      sdk: provider.sdk,
      clientSecret: 's',
      paymentTarget,
      walletTarget,
      returnUrl: 'r',
      onWalletsChange: (wallets) => seen.push(wallets),
    });
    provider.handlers.get('expressCheckout:ready')?.({
      availablePaymentMethods: { applePay: true, googlePay: false, link: true },
    });
    provider.handlers.get('expressCheckout:ready')?.({});
    provider.handlers.get('expressCheckout:loaderror')?.();
    expect(seen).toEqual([['apple_pay'], [], []]);
  });

  it('confirms through one path and never calls an accepted confirmation a payment', async () => {
    const provider = fakeProvider();
    const handle = mountCardElements({
      sdk: provider.sdk,
      clientSecret: 's',
      paymentTarget,
      returnUrl: 'https://checkout.example/i/pi_1',
    });
    expect(await handle.confirm()).toEqual({ kind: 'accepted' });
    expect(provider.confirms[0]).toMatchObject({
      redirect: 'if_required',
      confirmParams: { return_url: 'https://checkout.example/i/pi_1' },
    });
  });

  it('reports a decline, and fails the wallet sheet on a wallet decline', async () => {
    const provider = fakeProvider({ message: 'Your card was declined.' });
    const outcomes: unknown[] = [];
    let failed = 0;
    const handle = mountCardElements({
      sdk: provider.sdk,
      clientSecret: 's',
      paymentTarget,
      walletTarget,
      returnUrl: 'r',
      onWalletOutcome: (outcome) => outcomes.push(outcome),
    });
    expect(await handle.confirm()).toEqual({
      kind: 'declined',
      message: 'Your card was declined.',
    });
    provider.handlers.get('expressCheckout:confirm')?.({
      paymentFailed: () => {
        failed += 1;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failed).toBe(1);
    expect(outcomes).toEqual([{ kind: 'declined', message: 'Your card was declined.' }]);
  });

  it("destroys the provider's frames", () => {
    const provider = fakeProvider();
    const handle = mountCardElements({
      sdk: provider.sdk,
      clientSecret: 's',
      paymentTarget,
      walletTarget,
      returnUrl: 'r',
    });
    handle.destroy();
    expect(provider.destroyed.sort()).toEqual(['expressCheckout', 'payment']);
  });
});

describe('wallet availability', () => {
  it('is what the provider probed, never assumed', () => {
    expect(availableWallets(undefined)).toEqual([]);
    expect(availableWallets({ availablePaymentMethods: { googlePay: true } })).toEqual([
      'google_pay',
    ]);
  });
});

describe('redirect returns', () => {
  it('reads a return as "came back", not as paid', () => {
    expect(
      readRedirectReturn(
        '?payment_intent=pi_p&payment_intent_client_secret=pi_p_secret&redirect_status=succeeded',
      ),
    ).toEqual({ outcome: 'returned' });
    expect(readRedirectReturn('?payment_intent_client_secret=x&redirect_status=failed')).toEqual({
      outcome: 'failed',
    });
    expect(readRedirectReturn('?session=cs_1')).toBeNull();
  });

  it("strips the provider's client secret from the address", () => {
    expect(
      withoutRedirectParams(
        'https://checkout.example/i/pi_1?x=1&payment_intent=pi_p&payment_intent_client_secret=s&redirect_status=succeeded',
      ),
    ).toBe('https://checkout.example/i/pi_1?x=1');
  });
});

describe('delayed processing', () => {
  const base = { rail: 'card' as const, status: 'processing' as const };
  it('says a bank debit takes days, definitely only when nothing else was possible', () => {
    expect(delayedProcessingNotice({ ...base, payment_method_types: ['sepa_debit'] })).toBe(
      'Bank debit submitted — this can take a few business days.',
    );
    expect(
      delayedProcessingNotice({ ...base, payment_method_types: ['card', 'sepa_debit'] }),
    ).toContain('If you paid by bank debit');
    expect(delayedProcessingNotice({ ...base, payment_method_types: ['card'] })).toBeNull();
    expect(
      delayedProcessingNotice({
        ...base,
        status: 'succeeded',
        payment_method_types: ['sepa_debit'],
      }),
    ).toBeNull();
  });
});
