/**
 * `PeableElements` against a fake provider and a fake gateway: what it mounts,
 * how it is styled, and — the point — that a confirmation resolves on the
 * GATEWAY's word, never on the provider's callback alone.
 */
import { describe, expect, test } from 'bun:test';
import type { PaymentIntent, SetupIntent } from '@peable.to/shared-types';
import {
  createPeableElementsWith,
  decidePayment,
  decideSetup,
  type ElementsDependencies,
  providerAmount,
} from '../../src/browser/elements';
import type { PeableCheckoutClient, PeableClientAction } from '../../src/browser/payerClient';
import type {
  ProviderConfirmResult,
  ProviderElement,
  ProviderElements,
  ProviderSdk,
} from '../../src/browser/providerJs';
import { cardIntentFixture } from '../support/intentFixture';

const PI = {
  id: 'pi_0123456789abcdef01234567',
  client_secret: 'pi_0123456789abcdef01234567_secret_aa',
};

interface FakeNode {
  className: string;
  textContent: string;
  style: { props: Record<string, string>; setProperty(name: string, value: string): void };
  children: FakeNode[];
  attributes: Record<string, string>;
  append(...nodes: FakeNode[]): void;
  replaceChildren(...nodes: FakeNode[]): void;
  setAttribute(name: string, value: string): void;
  remove(): void;
}

function node(): FakeNode {
  return {
    className: '',
    textContent: '',
    style: {
      props: {},
      setProperty(name, value) {
        this.props[name] = value;
      },
    },
    children: [],
    attributes: {},
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = nodes;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    remove() {},
  };
}

function harness(options: {
  gateway: PaymentIntent[];
  provider?: ProviderConfirmResult;
  submitError?: string;
  setups?: SetupIntent[];
}) {
  const elementsCalls: Record<string, unknown>[] = [];
  const created: Array<{ type: string; mounted: unknown }> = [];
  const confirmCalls: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const providerElements: ProviderElements = {
    create(type) {
      const record: { type: string; mounted: unknown } = { type, mounted: null };
      created.push(record);
      const element: ProviderElement = {
        mount(target) {
          record.mounted = target;
        },
        on() {},
        unmount() {},
        destroy() {},
      };
      return element;
    },
    getElement: () => null,
    update(opts) {
      updates.push(opts);
    },
    submit: async () => (options.submitError ? { error: { message: options.submitError } } : {}),
  };
  const sdk: ProviderSdk = {
    elements(opts) {
      elementsCalls.push(opts);
      return providerElements;
    },
    async confirmPayment(opts) {
      confirmCalls.push(opts as unknown as Record<string, unknown>);
      return options.provider ?? { paymentIntent: { status: 'succeeded' } };
    },
    async confirmSetup(opts) {
      confirmCalls.push(opts as unknown as Record<string, unknown>);
      return { setupIntent: { status: 'succeeded' } };
    },
  };
  const keys: string[] = [];
  let reads = 0;
  const gateway = [...options.gateway];
  const setups = [...(options.setups ?? [])];
  let setupReads = 0;
  const action: PeableClientAction = {
    object: 'client_action',
    kind: 'client_secret',
    value: 'pi_provider_secret',
    publishable_key: 'pk_test_1',
  };
  const payer = {
    async getPaymentIntent() {
      const index = Math.min(reads, gateway.length - 1);
      reads += 1;
      const intent = gateway[index];
      if (!intent) throw new Error('no gateway state');
      return intent;
    },
    async subscribe() {
      throw new Error('realtime unavailable');
    },
    async getClientAction() {
      return action;
    },
    async getSetupClientAction() {
      return { ...action, value: 'seti_provider_secret' };
    },
    async getSetupIntent() {
      const index = Math.min(setupReads, setups.length - 1);
      setupReads += 1;
      const setup = setups[index];
      if (!setup) throw new Error('no setup state');
      return setup;
    },
  } as unknown as PeableCheckoutClient;
  const host = node();
  const deps: ElementsDependencies = {
    loadProvider: async () => (key: string) => {
      keys.push(key);
      return sdk;
    },
    payer,
    createContainer: () => node() as unknown as HTMLElement,
    resolveTarget: (target) => (target === '#pay' ? (host as unknown as Element) : null),
    locationHref: () => 'https://shop.example/checkout',
    pollMs: 5,
  };
  return {
    deps,
    keys,
    elementsCalls,
    created,
    confirmCalls,
    updates,
    host,
    readCount: () => reads,
  };
}

const declined = (message: string, updatedAt: number) =>
  cardIntentFixture({
    status: 'requires_payment_method',
    last_payment_error: {
      type: 'card_error',
      code: 'card_declined',
      decline_code: 'generic_decline',
      message,
    },
    updated_at: updatedAt,
  } as Partial<PaymentIntent>);

describe('pure decisions', () => {
  test('providerAmount takes a base-unit string, refuses FAIR and junk', () => {
    expect(providerAmount('1999', 'EUR')).toBe(1999);
    expect(() => providerAmount('19.99', 'EUR')).toThrow();
    expect(() => providerAmount('100', 'FAIR')).toThrow();
    expect(() => providerAmount('99999999999999999999', 'USD')).toThrow();
  });

  test('a decline already on the payment before confirming is not this attempt’s answer', () => {
    const before = declined('old decline', 10);
    expect(decidePayment(before, before).kind).toBe('pending');
    expect(decidePayment(declined('new decline', 11), before)).toMatchObject({
      kind: 'failed',
      error: { type: 'payment_failed', message: 'new decline' },
    });
    expect(decidePayment(cardIntentFixture({ status: 'requires_action' }), null).kind).toBe(
      'pending',
    );
    expect(decidePayment(cardIntentFixture({ status: 'succeeded' }), null)).toMatchObject({
      kind: 'resolved',
      status: 'succeeded',
    });
    expect(decidePayment(cardIntentFixture({ status: 'canceled' }), null)).toMatchObject({
      kind: 'failed',
      error: { type: 'canceled' },
    });
  });

  test('a setup is decided by its own status', () => {
    const base = { status: 'requires_action', last_setup_error: null } as unknown as SetupIntent;
    expect(decideSetup(base, null).kind).toBe('pending');
    expect(decideSetup({ ...base, status: 'succeeded' }, null)).toMatchObject({ kind: 'resolved' });
  });
});

describe('createPeableElements', () => {
  test('mounts the provider element inside Peable chrome styled by the appearance', async () => {
    const h = harness({ gateway: [cardIntentFixture()] });
    const elements = createPeableElementsWith(h.deps, {
      publishableKey: 'pk_test_1',
      amount: '2700',
      currency: 'EUR',
      locale: 'es',
      appearance: { theme: 'flat', variables: { colorPrimary: '#ff0066' } },
    });
    const element = elements.create('payment', { label: 'Card' });
    await element.mount('#pay');

    expect(h.keys).toEqual(['pk_test_1']);
    expect(h.elementsCalls[0]).toMatchObject({
      mode: 'payment',
      amount: 2700,
      currency: 'eur',
      locale: 'es',
      paymentMethodTypes: ['card'],
      appearance: { theme: 'flat', variables: { colorPrimary: '#ff0066' } },
    });
    expect(h.created.map((c) => c.type)).toEqual(['payment']);
    const container = h.host.children[0];
    expect(container?.className).toBe('peable-element peable-element--payment');
    expect(container?.style.props['--peable-color-primary']).toBe('#ff0066');
    expect(container?.children[0]?.textContent).toBe('Card');
    expect(h.created[0]?.mounted).toBe(container?.children[1]);
  });

  test('expressCheckout and address are the provider elements of those names', async () => {
    const h = harness({ gateway: [cardIntentFixture()] });
    const elements = createPeableElementsWith(h.deps, {
      publishableKey: 'pk_test_1',
      currency: 'EUR',
    });
    await elements.create('expressCheckout').mount('#pay');
    await elements.create('address', { provider: { mode: 'billing' } }).mount('#pay');
    expect(h.created.map((c) => c.type)).toEqual(['expressCheckout', 'address']);
    expect(h.elementsCalls).toHaveLength(1);
  });

  test('update passes appearance and amount to the provider', async () => {
    const h = harness({ gateway: [cardIntentFixture()] });
    const elements = createPeableElementsWith(h.deps, {
      publishableKey: 'pk_test_1',
      amount: '100',
      currency: 'USD',
    });
    await elements.create('payment').mount('#pay');
    await elements.update({ amount: '250', appearance: { theme: 'night' } });
    expect(h.updates[0]).toMatchObject({ amount: 250, appearance: { theme: 'night' } });
  });

  test('confirmPayment does not resolve on the provider callback: it waits for the gateway', async () => {
    const requiresAction = cardIntentFixture({ status: 'requires_action' });
    const succeeded = cardIntentFixture({
      status: 'succeeded',
      updated_at: requiresAction.updated_at + 5,
    });
    // baseline, then three polls still requires_action, then the webhook lands.
    const h = harness({
      gateway: [requiresAction, requiresAction, requiresAction, requiresAction, succeeded],
    });
    const elements = createPeableElementsWith(h.deps, {
      publishableKey: 'pk_test_1',
      amount: '2700',
      currency: 'EUR',
    });
    await elements.create('payment').mount('#pay');

    const result = await elements.confirmPayment({ paymentIntent: PI, timeoutMs: 2_000 });

    expect(h.confirmCalls[0]).toMatchObject({
      clientSecret: 'pi_provider_secret',
      redirect: 'if_required',
      confirmParams: { return_url: 'https://shop.example/checkout' },
    });
    expect(h.readCount()).toBeGreaterThanOrEqual(5);
    expect(result).toMatchObject({ status: 'succeeded' });
  });

  test('a gateway that never decides answers pending at the timeout, never success', async () => {
    const requiresAction = cardIntentFixture({ status: 'requires_action' });
    const h = harness({ gateway: [requiresAction] });
    const elements = createPeableElementsWith(h.deps, {
      publishableKey: 'pk_test_1',
      amount: '2700',
      currency: 'EUR',
    });
    const result = await elements.confirmPayment({ paymentIntent: PI, timeoutMs: 40 });
    expect(result).toMatchObject({
      status: 'pending',
      paymentIntent: { status: 'requires_action' },
    });
  });

  test('a fresh decline from the gateway is an error, a provider error is returned as is', async () => {
    const before = declined('old decline', 10);
    const h = harness({ gateway: [before, before, declined('Your card was declined.', 20)] });
    const elements = createPeableElementsWith(h.deps, {
      publishableKey: 'pk_test_1',
      amount: '2700',
      currency: 'EUR',
    });
    const result = await elements.confirmPayment({ paymentIntent: PI, timeoutMs: 2_000 });
    expect(result).toMatchObject({
      error: { type: 'payment_failed', message: 'Your card was declined.' },
    });

    const refused = harness({
      gateway: [cardIntentFixture()],
      provider: { error: { type: 'card_error', message: 'Insufficient funds' } },
    });
    const second = createPeableElementsWith(refused.deps, {
      publishableKey: 'pk_test_1',
      amount: '1',
      currency: 'EUR',
    });
    expect(await second.confirmPayment({ paymentIntent: PI })).toEqual({
      error: { type: 'card_error', message: 'Insufficient funds' },
    });
  });

  test('a field validation error stops before anything is confirmed', async () => {
    const h = harness({
      gateway: [cardIntentFixture()],
      submitError: 'Your card number is incomplete.',
    });
    const elements = createPeableElementsWith(h.deps, {
      publishableKey: 'pk_test_1',
      amount: '1',
      currency: 'EUR',
    });
    const result = await elements.confirmPayment({ paymentIntent: PI });
    expect(result).toEqual({
      error: { type: 'validation_error', message: 'Your card number is incomplete.' },
    });
    expect(h.confirmCalls).toHaveLength(0);
  });

  test('mounting for an existing payment fetches the credential and key from the gateway', async () => {
    const h = harness({ gateway: [cardIntentFixture()] });
    const elements = createPeableElementsWith(h.deps, { paymentIntent: PI });
    await elements.create('payment').mount('#pay');
    expect(h.keys).toEqual(['pk_test_1']);
    expect(h.elementsCalls[0]).toMatchObject({ clientSecret: 'pi_provider_secret' });
  });

  test('confirmSetup polls the SetupIntent until the gateway says succeeded', async () => {
    const pending = {
      id: 'seti_1',
      status: 'requires_action',
      last_setup_error: null,
    } as unknown as SetupIntent;
    const done = { ...pending, status: 'succeeded' } as SetupIntent;
    const h = harness({ gateway: [cardIntentFixture()], setups: [pending, pending, done] });
    const elements = createPeableElementsWith(h.deps, {
      publishableKey: 'pk_test_1',
      mode: 'setup',
      currency: 'EUR',
    });
    const result = await elements.confirmSetup({
      setupIntent: { id: 'seti_1', client_secret: 'seti_1_secret_x' },
      timeoutMs: 2_000,
    });
    expect(h.elementsCalls[0]).toMatchObject({ mode: 'setup', setupFutureUsage: 'off_session' });
    expect(h.confirmCalls[0]).toMatchObject({ clientSecret: 'seti_provider_secret' });
    expect(result).toMatchObject({ status: 'succeeded', setupIntent: { id: 'seti_1' } });
  });
});
