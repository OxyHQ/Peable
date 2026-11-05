/**
 * The module mocks every session/link/embed suite installs — in ONE place,
 * because `mock.module` replaces a module process-wide: a factory that omits
 * an export breaks whichever other file imports it next, in bun's run order.
 * So every mock here exports the module's WHOLE surface, and each suite
 * steers it through the mutable `mocks` object rather than its own factory.
 */
import * as realCheckout from '@peable.to/sdk/checkout';
import { mock } from 'bun:test';
import type {
  CheckoutSessionPublic,
  ConfirmCheckoutSessionPublicParams,
  PaymentIntent,
  PaymentLinkSessionStart,
  PublicPaymentLink,
  UpdateCheckoutSessionPublicParams,
} from '@peable.to/shared-types';

type IntentListener = (intent: PaymentIntent) => void;

export const mocks = {
  getCheckoutSession: mock(async (_id: string, _secret: string): Promise<CheckoutSessionPublic> => {
    throw new Error('getCheckoutSession not configured');
  }),
  updateCheckoutSession: mock(
    async (
      _id: string,
      _secret: string,
      _params: UpdateCheckoutSessionPublicParams,
    ): Promise<CheckoutSessionPublic> => {
      throw new Error('updateCheckoutSession not configured');
    },
  ),
  confirmCheckoutSession: mock(
    async (
      _id: string,
      _secret: string,
      _params?: ConfirmCheckoutSessionPublicParams,
    ): Promise<CheckoutSessionPublic> => {
      throw new Error('confirmCheckoutSession not configured');
    },
  ),
  getPaymentLink: mock(async (_id: string): Promise<PublicPaymentLink> => {
    throw new Error('getPaymentLink not configured');
  }),
  startPaymentLinkSession: mock(
    async (
      _id: string,
      _params: { amount?: string },
      _key?: string,
    ): Promise<PaymentLinkSessionStart> => {
      throw new Error('startPaymentLinkSession not configured');
    },
  ),
  getSetupClientAction: mock(async (_id: string, _secret: string) => ({
    object: 'client_action' as const,
    kind: 'client_secret' as const,
    value: 'seti_provider_secret',
    publishable_key: 'pk_test_abc',
  })),
  getPaymentIntent: mock(async (_id: string, _secret: string): Promise<PaymentIntent> => {
    throw new Error('getPaymentIntent not configured');
  }),
  getClientAction: mock(async (_id: string, _secret: string) => ({
    object: 'client_action' as const,
    kind: 'client_secret' as const,
    value: 'pi_provider_secret',
    publishable_key: 'pk_test_abc',
  })),
  redirectTo: mock((_url: string) => undefined),
  /** The latest realtime listener, so a suite can push a gateway update. */
  intentListener: null as IntentListener | null,
  /** What the provider's `confirmPayment` / `confirmSetup` answer. */
  confirmResult: {} as { error?: { message?: string } },
  confirmPayment: mock(async () => mocks.confirmResult),
  confirmSetup: mock(async () => mocks.confirmResult),
  elementsOptions: [] as Record<string, unknown>[],
};

export function resetMocks(): void {
  for (const value of Object.values(mocks)) {
    if (typeof value === 'function' && 'mockClear' in value) value.mockClear();
  }
  mocks.intentListener = null;
  mocks.confirmResult = {};
  mocks.elementsOptions = [];
}

export function installCheckoutMocks(): void {
  mock.module('../lib/sessionClient', () => ({
    getCheckoutSession: (id: string, secret: string) => mocks.getCheckoutSession(id, secret),
    updateCheckoutSession: (
      id: string,
      secret: string,
      params: UpdateCheckoutSessionPublicParams,
    ) => mocks.updateCheckoutSession(id, secret, params),
    confirmCheckoutSession: (
      id: string,
      secret: string,
      params?: ConfirmCheckoutSessionPublicParams,
    ) => mocks.confirmCheckoutSession(id, secret, params),
    getPaymentLink: (id: string) => mocks.getPaymentLink(id),
    startPaymentLinkSession: (id: string, params: { amount?: string }, key?: string) =>
      mocks.startPaymentLinkSession(id, params, key),
    getSetupClientAction: (id: string, secret: string) => mocks.getSetupClientAction(id, secret),
  }));
  mock.module('../lib/intentClient', () => ({
    getPaymentIntent: (id: string, secret: string) => mocks.getPaymentIntent(id, secret),
    subscribe: async (_id: string, _secret: string, onUpdate: IntentListener) => {
      mocks.intentListener = onUpdate;
      return () => undefined;
    },
    submitTx: async () => {
      throw new Error('submitTx is not exercised');
    },
    getClientAction: (id: string, secret: string) => mocks.getClientAction(id, secret),
  }));
  mock.module('../lib/redirect', () => ({
    redirectTo: (url: string) => mocks.redirectTo(url),
  }));
  const element = () => ({
    mount: () => undefined,
    on: () => undefined,
    unmount: () => undefined,
    destroy: () => undefined,
  });
  // The REAL card surface over a fake provider: what is asserted is the page.
  mock.module('../lib/providerJs', () => ({
    mountCardElements: realCheckout.mountCardElements,
    readRedirectReturn: realCheckout.readRedirectReturn,
    withoutRedirectParams: realCheckout.withoutRedirectParams,
    delayedProcessingNotice: realCheckout.delayedProcessingNotice,
    loadProviderSdk: async () => () => ({
      elements: (options: Record<string, unknown>) => {
        mocks.elementsOptions.push(options);
        const payment = element();
        return { create: () => payment, getElement: () => payment };
      },
      confirmPayment: mocks.confirmPayment,
    }),
    confirmSetupOf: () => mocks.confirmSetup,
    resetProviderSdkForTesting: () => undefined,
  }));
  // The FairCoin QR draws to a <canvas>, which happy-dom does not render.
  mock.module('qr-creator/dist/qr-creator.es6.min.js', () => ({
    default: { render: () => undefined },
  }));
}
