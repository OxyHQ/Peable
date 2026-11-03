import { afterAll, beforeAll } from 'bun:test';
import { config, type StripeConfig, type StripeModeConfig } from '../../config';
import type { ProviderMode } from '../../services/providers/provider';

/**
 * One mode's configuration as a suite needs it (ADR 0017): a well-formed key of
 * that mode, both endpoint secrets, and the card rail ON. Never a real key — a
 * suite that reaches the SDK through it fails authentication, which is the
 * point: tests drive fakes through the registry.
 */
export function stripeModeFixture(
  mode: ProviderMode,
  overrides: Partial<StripeModeConfig> = {},
): StripeModeConfig {
  return {
    mode,
    livemode: mode === 'live',
    secretKey: `rk_${mode}_fixture`,
    publishableKey: undefined,
    webhookSecret: `whsec_platform_${mode}_fixture`,
    webhookSecretPrevious: undefined,
    connectWebhookSecret: `whsec_connect_${mode}_fixture`,
    connectWebhookSecretPrevious: undefined,
    cardRail: true,
    ...overrides,
  };
}

/**
 * Replace the process configuration's Stripe modes and hand back the undo.
 *
 * The config is a process singleton every module reads at call time, so a
 * suite that changes it must put it back — `afterAll(restore)`.
 */
export function setStripeModes(modes: Partial<StripeConfig>): () => void {
  const before: StripeConfig = { test: config.stripe.test, live: config.stripe.live };
  config.stripe.test = 'test' in modes ? modes.test : undefined;
  config.stripe.live = 'live' in modes ? modes.live : undefined;
  return () => {
    config.stripe.test = before.test;
    config.stripe.live = before.live;
  };
}

/**
 * For a suite that processes stored provider EVENTS: the drain refuses an event
 * whose mode holds no key (ADR 0017), so the suite holds one — but with the card
 * rail OFF, so nothing it does can resolve a real adapter and reach the network.
 * A suite that wants provider calls injects a fake through the registry.
 */
export function useStripeKeys(
  modes: readonly ProviderMode[] = ['test'],
  /** ON only for a suite whose registry is faked — the real one would reach Stripe. */
  options: { readonly cardRail?: boolean } = {},
): void {
  let restore: () => void = () => undefined;
  beforeAll(() => {
    restore = setStripeModes(
      Object.fromEntries(
        modes.map((mode) => [
          mode,
          stripeModeFixture(mode, { cardRail: options.cardRail ?? false }),
        ]),
      ),
    );
  });
  afterAll(() => {
    restore();
  });
}
