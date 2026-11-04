/**
 * A recording fake card provider for billing suites: payments are created and
 * confirmed in memory, and `confirmPlan` decides how the next confirms answer.
 * Install it with {@link installFakeCardProvider} BEFORE importing the gateway;
 * the registry mock answers with the fakes only while `enabled` is true, so
 * every other suite in the same `bun test` run sees the real registry.
 */
import { mock } from 'bun:test';
import type { ProviderMode, ProviderPaymentResult } from '../../services/providers/provider';

export interface FakeCardProvider {
  /** How the next confirms answer, consumed in order; `succeed` when empty. */
  readonly confirmPlan: ('succeed' | 'decline')[];
  /** `<mode>:<call>[:<detail>]`, in order. */
  readonly calls: string[];
  /** The payments created, by provider id, with the method they were made for. */
  readonly payments: Map<string, ProviderPaymentResult & { amount: string; method?: string }>;
  enabled: boolean;
}

export async function installFakeCardProvider(): Promise<FakeCardProvider> {
  const state: FakeCardProvider = {
    confirmPlan: [],
    calls: [],
    payments: new Map(),
    enabled: false,
  };
  let counter = 0;
  const provider = (mode: ProviderMode) => ({
    id: 'stripe' as const,
    createPayment: async (request: {
      amount: { amount: string };
      paymentMethodObjectId?: string;
      customerObjectId?: string;
    }) => {
      state.calls.push(`${mode}:createPayment:${request.amount.amount}`);
      const id = `pi_fake_${++counter}`;
      const result = {
        providerObjectId: id,
        status: request.paymentMethodObjectId
          ? ('requires_confirmation' as const)
          : ('requires_payment_method' as const),
        clientAction: { kind: 'client_secret' as const, value: `${id}_secret` },
        amount: request.amount.amount,
        ...(request.paymentMethodObjectId ? { method: request.paymentMethodObjectId } : {}),
      };
      state.payments.set(id, result);
      return result;
    },
    confirm: async (request: { providerObjectId: string }) => {
      const outcome = state.confirmPlan.shift() ?? 'succeed';
      state.calls.push(`${mode}:confirm:${outcome}`);
      const stored = state.payments.get(request.providerObjectId);
      if (!stored) throw new Error('no such fake payment');
      const result =
        outcome === 'succeed'
          ? {
              ...stored,
              status: 'succeeded' as const,
              chargeObjectId: `ch_${request.providerObjectId}`,
            }
          : {
              ...stored,
              status: 'requires_payment_method' as const,
              lastPaymentError: {
                type: 'card_error' as const,
                code: 'card_declined',
                declineCode: 'insufficient_funds',
              },
            };
      state.payments.set(request.providerObjectId, result);
      return result;
    },
    capture: async () => {
      throw new Error('not used');
    },
    cancel: async (request: { providerObjectId: string }) => {
      state.calls.push(`${mode}:cancel`);
      const stored = state.payments.get(request.providerObjectId);
      const result = {
        ...(stored ?? { providerObjectId: request.providerObjectId, amount: '0' }),
        status: 'canceled' as const,
      };
      state.payments.set(request.providerObjectId, result);
      return result;
    },
    refund: async () => {
      throw new Error('not used');
    },
    getStatus: async (id: string) => {
      const stored = state.payments.get(id);
      if (!stored) throw new Error(`no payment ${id}`);
      return stored;
    },
    verifyEvent: async () => {
      throw new Error('not used');
    },
    createCustomer: async () => {
      state.calls.push(`${mode}:createCustomer`);
      return { providerObjectId: `cus_fake_${++counter}` };
    },
  });
  const fakes = { test: provider('test'), live: provider('live') };
  const real = await import('../../services/providers/registry');
  const { resolveProvider, resolveCardProvider } = real;
  mock.module('../../services/providers/registry', () => ({
    ...real,
    resolveProvider: (id: 'stripe', mode: ProviderMode) =>
      state.enabled ? fakes[mode] : resolveProvider(id, mode),
    resolveCardProvider: (mode: ProviderMode) =>
      state.enabled ? fakes[mode] : resolveCardProvider(mode),
  }));
  return state;
}
