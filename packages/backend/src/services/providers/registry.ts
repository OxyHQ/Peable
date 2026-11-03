/**
 * Which adapter serves which provider, in which mode.
 *
 * ONE lookup, keyed by `(provider, mode)` (ADR 0017), and provider-neutral on
 * purpose: every caller knows which provider a payment belongs to and which
 * mode it lives in, and needs whatever can act on it, without any of them
 * naming Stripe.
 *
 * The MODE is never chosen here. A new operation's mode comes from the
 * credential's environment (`environmentGuard.ts`, the selector) and an
 * operation on a stored object's from the row (`livemode`, read off its
 * merchant) — this module only answers for the mode it is asked about, so it
 * cannot be the place a test credential is handed the live client.
 *
 * ## Why it answers `undefined` instead of throwing
 *
 * `getStripeClient(mode)` throws without that mode's secret key, and most
 * deployments — and every test that does not exercise the rail — lack at least
 * one. A registry that constructed the adapter anyway would move that throw
 * from "asked for a rail that is off" to "took a checkout and blew up
 * mid-request". `undefined` is an ordinary answer with an ordinary cause: this
 * deployment has not configured that rail in that mode, and the caller answers
 * 503 like any other unavailable rail.
 *
 * Each rail is gated on its OWN configuration here rather than at its call
 * sites, so "is this rail available in this mode" has exactly one answer.
 */

import { config } from '../../config';
import {
  PROVIDER_MODES,
  type PaymentProvider,
  type ProviderId,
  type ProviderMode,
} from './provider';
import { StripePaymentProvider, type StripePaymentProviderOptions } from './stripe/stripeProvider';

const stripeInstances: Partial<Record<ProviderMode, StripePaymentProvider>> = {};

/** Trusted startup configuration only; never change the policy of an active adapter. */
export function configureStripePaymentProvider(
  options: StripePaymentProviderOptions,
  factory: (options: StripePaymentProviderOptions) => StripePaymentProvider = (value) =>
    new StripePaymentProvider(value),
): void {
  if (stripeInstances[options.mode]) {
    throw new Error(`Stripe ${options.mode} payment provider is already initialized`);
  }
  stripeInstances[options.mode] = factory(options);
}

/**
 * The adapter for a provider in one mode, if this deployment has it.
 *
 * One instance per `(provider, mode)` per process. The adapter is cheap and
 * holds no connection — the SDK client it calls is the lazy per-mode singleton
 * in `client.ts` — but constructing it while that mode's rail is OFF would
 * defeat the point of the gate above.
 */
export function resolveProvider(
  provider: ProviderId,
  mode: ProviderMode,
): PaymentProvider | undefined {
  if (provider === 'stripe') {
    if (!config.stripe[mode]?.cardRail) return undefined;
    stripeInstances[mode] ??= new StripePaymentProvider({ mode });
    return stripeInstances[mode];
  }
  return undefined;
}

/**
 * Whether this deployment holds the provider's KEY for a mode — a weaker
 * question than `resolveProvider`, which also wants the card rail switched on.
 * A stored event is processed when its mode has a key: what it asks for after
 * receipt (a payment re-read, an account refresh) needs only that.
 */
export function providerModeConfigured(provider: ProviderId, mode: ProviderMode): boolean {
  if (provider === 'stripe') return config.stripe[mode] !== undefined;
  return false;
}

/** The modes in which a provider is available here — what an inbound event may verify against. */
export function availableProviderModes(provider: ProviderId): ProviderMode[] {
  return PROVIDER_MODES.filter((mode) => resolveProvider(provider, mode) !== undefined);
}

/** Drop the instances. Test support — a suite must not inherit another's state. */
export function resetProviders(): void {
  delete stripeInstances.test;
  delete stripeInstances.live;
}

/**
 * The provider that serves the card rail in a mode.
 *
 * A single named question rather than a `resolveProvider('stripe', mode)` at
 * every call site: the day a second fiat provider exists, "which provider does
 * a card payment use" becomes a real decision (per merchant, per currency, per
 * country), and it will be made HERE rather than in six routes.
 */
export function resolveCardProvider(mode: ProviderMode): PaymentProvider | undefined {
  return resolveProvider('stripe', mode);
}
