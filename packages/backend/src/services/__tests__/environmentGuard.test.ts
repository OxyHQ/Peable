/**
 * Test and live in one deployment (ADR 0017), at the seam that selects.
 *
 * The gateway separates merchant ROWS by environment — `merchants` is unique on
 * `(oxy_app_id, environment)` and `resolveMerchant` resolves by both. What
 * isolates MONEY is which key a call is sent with, and a deployment now holds a
 * test key and a live key side by side. Three properties are asserted here:
 *
 *  1. the classification of a key, including the restricted (`rk_`) forms;
 *  2. the configuration: each mode optional, and a key in the wrong mode's
 *     variable refuses to boot rather than quietly serving the other world;
 *  3. the selection rule — production ⟺ live — over every environment.
 */
import { describe, expect, test } from 'bun:test';
import { MERCHANT_ENVIRONMENTS } from '@peable.to/shared-types';
import { classifyStripeKey, loadConfig } from '../../config';
import { environmentMatchesMode, providerModeFor } from '../providers/environmentGuard';
import { providerModeOf } from '../providers/provider';

describe('classifying a Stripe secret key', () => {
  test('reads a RESTRICTED live key as live', () => {
    // `rk_live_…` failed an old `startsWith('sk_live_')` test. A restricted key
    // is the recommended shape for a platform with a narrow permission set,
    // which is exactly this gateway.
    expect(classifyStripeKey('rk_live_51Abcdef')).toBe('live');
    expect(classifyStripeKey('sk_live_51Abcdef')).toBe('live');
  });

  test('reads both test forms as test', () => {
    expect(classifyStripeKey('sk_test_51Abcdef')).toBe('test');
    expect(classifyStripeKey('rk_test_51Abcdef')).toBe('test');
  });

  test('refuses to guess a mode it does not recognise', () => {
    expect(classifyStripeKey(undefined)).toBe('unknown');
    expect(classifyStripeKey('')).toBe('unknown');
    expect(classifyStripeKey('whsec_something')).toBe('unknown');
    // A mode word appearing anywhere in the key is not the mode.
    expect(classifyStripeKey('sk_test_live_abcdef')).toBe('test');
    expect(classifyStripeKey('pk_live_abcdef')).toBe('unknown');
  });
});

describe('both modes in one configuration', () => {
  const base = { DATABASE_URL: 'postgres://peable:peable@localhost:5439/peable' };
  const testMode = {
    STRIPE_SECRET_KEY_TEST: 'rk_test_abc',
    STRIPE_WEBHOOK_SECRET_TEST: 'whsec_platform_test',
    STRIPE_CONNECT_WEBHOOK_SECRET_TEST: 'whsec_connect_test',
  };
  const liveMode = {
    STRIPE_SECRET_KEY_LIVE: 'rk_live_abc',
    STRIPE_WEBHOOK_SECRET_LIVE: 'whsec_platform_live',
    STRIPE_CONNECT_WEBHOOK_SECRET_LIVE: 'whsec_connect_live',
  };

  test('holds both keys at once, each in its own mode', () => {
    const config = loadConfig({ ...base, STRIPE_ENABLED: 'true', ...testMode, ...liveMode });
    expect(config.stripe.test?.secretKey).toBe('rk_test_abc');
    expect(config.stripe.test?.livemode).toBe(false);
    expect(config.stripe.test?.cardRail).toBe(true);
    expect(config.stripe.live?.secretKey).toBe('rk_live_abc');
    expect(config.stripe.live?.livemode).toBe(true);
    expect(config.stripe.live?.cardRail).toBe(true);
    expect(config.stripe.live?.webhookSecret).toBe('whsec_platform_live');
  });

  test('each mode is optional — a missing key is a mode that does not exist', () => {
    const config = loadConfig({ ...base, STRIPE_ENABLED: 'true', ...testMode });
    expect(config.stripe.test?.cardRail).toBe(true);
    expect(config.stripe.live).toBeUndefined();
  });

  test('a key alone serves tax and billing but not the card rail', () => {
    const config = loadConfig({ ...base, STRIPE_SECRET_KEY_LIVE: 'sk_live_abc' });
    expect(config.stripe.live?.secretKey).toBe('sk_live_abc');
    expect(config.stripe.live?.cardRail).toBe(false);
  });

  test('a mode missing a webhook secret keeps its card rail off', () => {
    const config = loadConfig({
      ...base,
      STRIPE_ENABLED: 'true',
      ...testMode,
      STRIPE_CONNECT_WEBHOOK_SECRET_TEST: '',
    });
    expect(config.stripe.test?.cardRail).toBe(false);
  });

  test('a live key in the TEST variable refuses to boot', () => {
    // The mistake that would charge real cards for every development
    // credential. A warning that turned the mode off would leave the operator
    // with a deployment quietly lacking the mode they meant to configure.
    expect(() => loadConfig({ ...base, STRIPE_SECRET_KEY_TEST: 'rk_live_abc' })).toThrow(
      /STRIPE_SECRET_KEY_TEST must be a test key/,
    );
    expect(() => loadConfig({ ...base, STRIPE_SECRET_KEY_LIVE: 'sk_test_abc' })).toThrow(
      /STRIPE_SECRET_KEY_LIVE must be a live key/,
    );
  });

  test('an unrecognisable key refuses to boot', () => {
    expect(() => loadConfig({ ...base, STRIPE_SECRET_KEY_LIVE: 'some-vault-reference' })).toThrow(
      /not a recognised Stripe secret key/,
    );
  });

  test('a publishable key of the other mode refuses to boot', () => {
    expect(() =>
      loadConfig({ ...base, ...testMode, STRIPE_PUBLISHABLE_KEY_TEST: 'pk_live_abc' }),
    ).toThrow(/STRIPE_PUBLISHABLE_KEY_TEST must be a pk_test_/);
    expect(() =>
      loadConfig({ ...base, ...liveMode, STRIPE_PUBLISHABLE_KEY_LIVE: 'pk_test_abc' }),
    ).toThrow(/STRIPE_PUBLISHABLE_KEY_LIVE must be a pk_live_/);
  });

  test('the error never quotes the key', () => {
    let message = '';
    try {
      loadConfig({ ...base, STRIPE_SECRET_KEY_TEST: 'rk_live_supersecret' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('supersecret');
  });

  test('the single-key variable is gone, not a fallback', () => {
    const config = loadConfig({ ...base, STRIPE_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_x' });
    expect(config.stripe.test).toBeUndefined();
    expect(config.stripe.live).toBeUndefined();
  });
});

describe('the credential selects the mode', () => {
  test('production is the ONLY environment that acts live', () => {
    for (const environment of MERCHANT_ENVIRONMENTS) {
      expect(providerModeFor(environment)).toBe(environment === 'production' ? 'live' : 'test');
      expect(environmentMatchesMode(environment, true)).toBe(environment === 'production');
      expect(environmentMatchesMode(environment, false)).toBe(environment !== 'production');
    }
  });

  test('a stored livemode reads back as its mode', () => {
    expect(providerModeOf(true)).toBe('live');
    expect(providerModeOf(false)).toBe('test');
  });
});
