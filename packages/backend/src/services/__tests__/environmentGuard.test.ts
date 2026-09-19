/**
 * Test/live isolation, at the one seam that enforces it.
 *
 * The gateway already separated merchant ROWS by environment — `merchants` is
 * unique on `(oxy_app_id, environment)` and `resolveMerchant` resolves by both.
 * What it never did was compare the environment of the credential that reached
 * a route against the MODE of the key the provider adapter holds, which is
 * process-wide and comes from one `STRIPE_SECRET_KEY`. Separate rows and one
 * key means a `development` credential creating live charges.
 *
 * Two properties are asserted here and they are different:
 *
 *  1. the classification of the key, including the restricted (`rk_`) forms
 *     that the old `startsWith('sk_live_')` test read as TEST;
 *  2. the pairing rule itself, over every environment, in both modes.
 */
import { describe, expect, test } from "bun:test";
import { MERCHANT_ENVIRONMENTS } from "@peable.to/shared-types";
import { classifyStripeKey, loadConfig } from "../../config";
import {
  EnvironmentModeMismatchError,
  assertEnvironmentMatchesProvider,
  environmentMatchesMode,
} from "../providers/environmentGuard";

describe("classifying a Stripe secret key", () => {
  test("reads a RESTRICTED live key as live", () => {
    // The bug this replaces: `rk_live_…` failed `startsWith('sk_live_')`, so a
    // deployment holding a restricted LIVE key reported `livemode: false`. Every
    // live webhook was then dropped as a mode mismatch and every development
    // credential was cleared to charge live cards. A restricted key is the
    // recommended shape for a platform with a narrow permission set, which is
    // exactly this gateway.
    expect(classifyStripeKey("rk_live_51Abcdef")).toBe("live");
    expect(classifyStripeKey("sk_live_51Abcdef")).toBe("live");
  });

  test("reads both test forms as test", () => {
    expect(classifyStripeKey("sk_test_51Abcdef")).toBe("test");
    expect(classifyStripeKey("rk_test_51Abcdef")).toBe("test");
  });

  test("refuses to guess a mode it does not recognise", () => {
    expect(classifyStripeKey(undefined)).toBe("unknown");
    expect(classifyStripeKey("")).toBe("unknown");
    expect(classifyStripeKey("whsec_something")).toBe("unknown");
    // A mode word appearing anywhere in the key is not the mode. The prefix is
    // the pair `sk_`/`rk_` plus `live_`/`test_`, matched as a prefix, so a key
    // whose random suffix happens to contain `live` is still a test key.
    expect(classifyStripeKey("sk_test_live_abcdef")).toBe("test");
    expect(classifyStripeKey("pk_live_abcdef")).toBe("unknown");
  });
});

describe("a rail whose key mode cannot be read stays off", () => {
  const complete = {
    DATABASE_URL: "postgres://peable:peable@localhost:5439/peable",
    STRIPE_ENABLED: "true",
    STRIPE_WEBHOOK_SECRET: "whsec_platform",
    STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect",
  };

  test("a recognised key turns it on", () => {
    const config = loadConfig({ ...complete, STRIPE_SECRET_KEY: "sk_test_abc" });
    expect(config.stripe.enabled).toBe(true);
    expect(config.stripe.keyMode).toBe("test");
    expect(config.stripe.livemode).toBe(false);
  });

  test("a restricted live key turns it on IN LIVE MODE", () => {
    const config = loadConfig({ ...complete, STRIPE_SECRET_KEY: "rk_live_abc" });
    expect(config.stripe.enabled).toBe(true);
    expect(config.stripe.livemode).toBe(true);
  });

  test("an unclassifiable key leaves it off", () => {
    // Everything downstream is derived from the classification — the ingress
    // livemode filter and this guard — so a rail enabled with an unreadable key
    // would run with both of them answering from a guess.
    const config = loadConfig({ ...complete, STRIPE_SECRET_KEY: "some-vault-reference" });
    expect(config.stripe.enabled).toBe(false);
  });
});

describe("an environment may only act on its own mode", () => {
  test("production is the ONLY environment that may act live", () => {
    for (const environment of MERCHANT_ENVIRONMENTS) {
      expect(environmentMatchesMode(environment, true)).toBe(environment === "production");
      expect(environmentMatchesMode(environment, false)).toBe(environment !== "production");
    }
  });

  test("the guard is silent when they agree", () => {
    // `config.stripe.livemode` is false in this suite — no key is configured —
    // so the three non-production environments pass and production does not.
    expect(() => {
      assertEnvironmentMatchesProvider("development");
    }).not.toThrow();
    expect(() => {
      assertEnvironmentMatchesProvider("staging");
    }).not.toThrow();
  });

  test("and names both sides when they do not", () => {
    let thrown: unknown;
    try {
      assertEnvironmentMatchesProvider("production");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EnvironmentModeMismatchError);
    // The message has to say which credential and which mode, because the
    // operator reading it is looking at two configurations and needs to know
    // which one to change.
    expect((thrown as Error).message).toContain("production");
    expect((thrown as Error).message).toContain("test mode");
  });
});
