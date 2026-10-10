/**
 * Which adapter serves which provider.
 *
 * ONE lookup, and it is provider-neutral on purpose: every caller knows which
 * provider a payment belongs to and needs whatever can act on it, without any
 * of them naming Stripe.
 *
 * ## Why it answers `undefined` instead of throwing
 *
 * `getStripeClient()` throws without a secret key, and most deployments — and
 * every test that does not exercise the rail — have none. A registry that
 * constructed the adapter anyway would move that throw from "asked for a rail
 * that is off" to "took a checkout and blew up mid-request". `undefined` is an
 * ordinary answer with an ordinary cause: this deployment has not configured
 * that rail. A caller that genuinely needs an adapter says so itself rather
 * than being handed a throw.
 *
 * Each rail is gated on its OWN configuration here rather than at its call
 * sites, so "is this rail available" has exactly one answer.
 */

import { config } from '../../config';
import type { PaymentProvider, ProviderId } from './provider';
import { StripePaymentProvider } from './stripe/stripeProvider';

let stripeInstance: StripePaymentProvider | undefined;

/**
 * The adapter for a provider, if this deployment has one.
 *
 * One instance per process. The adapter is cheap and holds no connection — the
 * SDK client it calls is the lazy singleton in `client.ts` — but constructing
 * it while the rail is OFF would defeat the point of the gate above.
 */
export function resolveProvider(provider: ProviderId): PaymentProvider | undefined {
  if (provider === 'stripe') {
    if (!config.stripe.enabled) return undefined;
    stripeInstance ??= new StripePaymentProvider();
    return stripeInstance;
  }
  return undefined;
}

/** Drop the instances. Test support — a suite must not inherit another's state. */
export function resetProviders(): void {
  stripeInstance = undefined;
}

/**
 * The provider that serves the card rail on this deployment.
 *
 * A single named question rather than a `resolveProvider('stripe')` at every
 * call site: the day a second fiat provider exists, "which provider does a card
 * payment use" becomes a real decision (per merchant, per currency, per
 * country), and it will be made HERE rather than in six routes.
 */
export function resolveCardProvider(): PaymentProvider | undefined {
  return resolveProvider('stripe');
}
