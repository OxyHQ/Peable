/**
 * The webhook ingress, through the REAL middleware chain.
 *
 * The thing under test is not the handler — it is the ORDER `server.ts` mounts
 * things in. A unit test of `handleDelivery` passes identically whether
 * `express.json()` runs first or not, and the failure that ordering causes is
 * total: every delivery Stripe ever sends is rejected as a forgery, in
 * production, with a green build.
 *
 * So every case here goes through `createGateway()` over a real socket, and the
 * decisive case runs the SAME router behind a deliberately json-parsed chain to
 * show it fails there. That pair is what makes a future reorder a red build.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { createGateway } from '../../server';
import { createProviderWebhooksRouter } from '../providerWebhooks';
import { config, type StripeConfig } from '../../config';
import { stripeModeFixture } from '../../__tests__/helpers/stripeModes';
import { resetProviders } from '../../services/providers/registry';
import { providerEvents } from '../../db/schema';
import { gatewayDb, useGatewayDatabase } from '../../__tests__/helpers/gatewayTestDatabase';
import { POSTGRES_TESTS_ENABLED } from '../../db/testDatabase';

const PLATFORM_SECRET = 'whsec_platform_test_secret';
const CONNECT_SECRET = 'whsec_connect_test_secret';

/**
 * The rail is turned on by mutating the loaded config, NOT by setting env vars.
 *
 * `config.ts` snapshots `process.env` once, at import time, and `bun test` runs
 * every file in one process — so a `process.env.STRIPE_* = …` at the top of this
 * file is read only if this file happens to be the first to import `config`,
 * which it is when run alone and is not when run with the suite. That version of
 * this test passed on its own and failed in CI. Everything that reads these
 * values does so per call (`resolveProvider` checks `enabled`,
 * `verifyEventForScope` reads the secrets), so assigning here is enough and is
 * order-independent.
 */
const REAL_STRIPE_CONFIG: StripeConfig = { test: config.stripe.test, live: config.stripe.live };
/** The LIVE mode's endpoint secrets — different objects at Stripe, different secrets here. */
const LIVE_PLATFORM_SECRET = 'whsec_platform_live_secret';
const LIVE_CONNECT_SECRET = 'whsec_connect_live_secret';

/** Both modes held at once (ADR 0017), each with its own two endpoint secrets. */
function bothModes(): StripeConfig {
  return {
    test: stripeModeFixture('test', {
      webhookSecret: PLATFORM_SECRET,
      connectWebhookSecret: CONNECT_SECRET,
    }),
    live: stripeModeFixture('live', {
      webhookSecret: LIVE_PLATFORM_SECRET,
      connectWebhookSecret: LIVE_CONNECT_SECRET,
    }),
  };
}

/**
 * Stripe's signature scheme, reimplemented rather than mocked.
 *
 * `t=<unix>,v1=<hex hmac-sha256 of "<t>.<payload>">`. Building it here is what
 * makes these tests exercise real verification: a mocked `constructEvent` would
 * pass against a router that never verifies anything.
 */
function signStripe(payload: string, secret: string, timestamp?: number): string {
  const t = timestamp ?? Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${String(t)},v1=${signature}`;
}

let eventCounter = 0;

/** A well-formed Stripe event body, with a fresh id unless one is given. */
function eventBody(overrides: Record<string, unknown> = {}): string {
  eventCounter += 1;
  return JSON.stringify({
    id: `evt_test_${String(eventCounter)}`,
    object: 'event',
    api_version: '2026-07-29.dahlia',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: `pi_stripe_${String(eventCounter)}`,
        object: 'payment_intent',
        amount: 2500,
        currency: 'eur',
        status: 'succeeded',
        metadata: { peable_intent_id: 'pi_public_1' },
      },
    },
    ...overrides,
  });
}

let gatewayServer: Server | undefined;
let gatewayUrl = '';
let parsedServer: Server | undefined;
let parsedUrl = '';

async function post(
  baseUrl: string,
  path: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('provider webhook ingress, real chain', () => {
  useGatewayDatabase();

  beforeAll(async () => {
    Object.assign(config.stripe, bothModes());
    // Another suite may have resolved the adapter while the rail was off, and
    // `resolveProvider` memoizes. Dropping the instance makes this suite's
    // answer depend on this suite's config rather than on file order.
    resetProviders();

    // The real assembly, with only the auth middlewares stubbed — those are
    // constructed from secrets a test deployment does not have, and NONE of them
    // sits in front of the webhook router, which is the whole point.
    const passthrough = (_req: unknown, _res: unknown, next: () => void) => {
      next();
    };
    const gateway = createGateway({
      requireMerchant: passthrough as never,
      optionalServiceAuth: passthrough as never,
      requireOxyUser: passthrough as never,
      publicRateLimit: passthrough as never,
    });
    gatewayServer = gateway.httpServer.listen(0);
    gatewayUrl = `http://127.0.0.1:${String((gatewayServer.address() as AddressInfo).port)}`;

    // The counterexample: the SAME router, behind a JSON parser. This is what
    // `server.ts` would look like if someone moved the mount below
    // `express.json()` "for consistency".
    const parsedApp = express();
    parsedApp.use(express.json());
    parsedApp.use(createProviderWebhooksRouter());
    parsedServer = parsedApp.listen(0);
    parsedUrl = `http://127.0.0.1:${String((parsedServer.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    // Put the deployment's real answer back: a later file asserting that the
    // rail is OFF must not inherit this one's fixture.
    Object.assign(config.stripe, REAL_STRIPE_CONFIG);
    resetProviders();

    await new Promise<void>((resolve) => {
      if (!gatewayServer) return resolve();
      gatewayServer.close(() => {
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      if (!parsedServer) return resolve();
      parsedServer.close(() => {
        resolve();
      });
    });
  });

  test('the rail is configured, so these cases test signatures and not a missing secret', () => {
    // Guards every assertion below: with the rail off the ingress answers
    // `not_configured` for ANY body, and a test suite full of 400s would look
    // like it was testing verification when it was testing nothing.
    expect(config.stripe.test?.cardRail).toBe(true);
    expect(config.stripe.live?.cardRail).toBe(true);
  });

  test('a correctly signed platform delivery is accepted and stored', async () => {
    const body = eventBody();
    const parsed = JSON.parse(body) as { id: string };
    const { status, json } = await post(gatewayUrl, '/v1/webhooks/stripe', body, {
      'Stripe-Signature': signStripe(body, PLATFORM_SECRET),
    });

    expect(status).toBe(200);
    expect(json).toEqual({ received: true, duplicate: false });

    const rows = await gatewayDb().select().from(providerEvents);
    const stored = rows.find((row) => row.providerEventId === parsed.id);
    expect(stored).toBeDefined();
    // Platform scope carries no account — the NULL half of the dedupe key.
    expect(stored?.providerAccountId).toBeNull();
    expect(stored?.processedAt).toBeNull();
  });

  /**
   * THE ordering test.
   *
   * The identical bytes and the identical signature: accepted through the real
   * chain, refused through a chain whose JSON parser reached the stream first.
   * If someone moves the mount in `server.ts`, the first half of this goes red.
   */
  test('the SAME delivery verifies through the real chain and fails behind express.json()', async () => {
    const body = eventBody();
    const signature = signStripe(body, PLATFORM_SECRET);

    const real = await post(gatewayUrl, '/v1/webhooks/stripe', body, {
      'Stripe-Signature': signature,
    });
    expect(real.status).toBe(200);
    expect(real.json.received).toBe(true);

    const behindJson = await post(parsedUrl, '/v1/webhooks/stripe', body, {
      'Stripe-Signature': signature,
    });
    expect(behindJson.status).toBe(400);
    expect(behindJson.json).toEqual({ received: false, error: 'invalid_signature' });
  });

  /**
   * The retry, answered the same way as the original.
   *
   * A duplicate must be 200: any other answer makes Stripe retry a delivery that
   * is already stored, forever.
   */
  test('a redelivery is a duplicate, still 200, and stores nothing new', async () => {
    const body = eventBody();
    const signature = signStripe(body, PLATFORM_SECRET);
    const parsed = JSON.parse(body) as { id: string };

    const first = await post(gatewayUrl, '/v1/webhooks/stripe', body, {
      'Stripe-Signature': signature,
    });
    const second = await post(gatewayUrl, '/v1/webhooks/stripe', body, {
      'Stripe-Signature': signature,
    });

    expect(first.json).toEqual({ received: true, duplicate: false });
    expect(second.status).toBe(200);
    expect(second.json).toEqual({ received: true, duplicate: true });

    const rows = await gatewayDb().select().from(providerEvents);
    expect(rows.filter((row) => row.providerEventId === parsed.id)).toHaveLength(1);
  });

  /**
   * The two endpoints do not share a secret, and this is the case that proves
   * it. A platform secret accepted on the connect path would mean one leaked
   * secret could forge events for any connected account.
   */
  test('the connect endpoint refuses a platform signature, and accepts its own', async () => {
    const body = eventBody({ account: 'acct_connected_1' });

    const wrongSecret = await post(gatewayUrl, '/v1/webhooks/stripe/connect', body, {
      'Stripe-Signature': signStripe(body, PLATFORM_SECRET),
    });
    expect(wrongSecret.status).toBe(400);
    expect(wrongSecret.json.error).toBe('invalid_signature');

    const rightSecret = await post(gatewayUrl, '/v1/webhooks/stripe/connect', body, {
      'Stripe-Signature': signStripe(body, CONNECT_SECRET),
    });
    expect(rightSecret.status).toBe(200);

    const rows = await gatewayDb().select().from(providerEvents);
    const stored = rows.find(
      (row) => row.providerEventId === (JSON.parse(body) as { id: string }).id,
    );
    // The connected account came off the envelope, not off the path.
    expect(stored?.providerAccountId).toBe('acct_connected_1');
  });

  /** ...and the reverse: a connect secret is not accepted on the platform path. */
  test('the platform endpoint refuses a connect signature', async () => {
    const body = eventBody();
    const { status, json } = await post(gatewayUrl, '/v1/webhooks/stripe', body, {
      'Stripe-Signature': signStripe(body, CONNECT_SECRET),
    });
    expect(status).toBe(400);
    expect(json.error).toBe('invalid_signature');
  });

  test('a forged body with a valid-looking signature is refused and stores nothing', async () => {
    const body = eventBody();
    const tampered = body.replace('2500', '1');
    const { status, json } = await post(gatewayUrl, '/v1/webhooks/stripe', tampered, {
      // Signed over the ORIGINAL bytes — exactly what an attacker who captured a
      // delivery and edited the amount would present.
      'Stripe-Signature': signStripe(body, PLATFORM_SECRET),
    });

    expect(status).toBe(400);
    expect(json.error).toBe('invalid_signature');

    const rows = await gatewayDb().select().from(providerEvents);
    expect(
      rows.find((row) => row.providerEventId === (JSON.parse(body) as { id: string }).id),
    ).toBeUndefined();
  });

  test('a delivery with no signature header at all is refused before any work', async () => {
    const { status, json } = await post(gatewayUrl, '/v1/webhooks/stripe', eventBody(), {});
    expect(status).toBe(400);
    expect(json).toEqual({ received: false, error: 'missing_signature' });
  });

  /**
   * A stale timestamp.
   *
   * Stripe's tolerance window is what stops a captured delivery being replayed
   * days later. Verification is real, so an old `t=` fails even though the HMAC
   * over `<t>.<payload>` is itself correct.
   */
  test('a replayed delivery outside the tolerance window is refused', async () => {
    const body = eventBody();
    const ancient = Math.floor(Date.now() / 1000) - 60 * 60 * 24;
    const { status, json } = await post(gatewayUrl, '/v1/webhooks/stripe', body, {
      'Stripe-Signature': signStripe(body, PLATFORM_SECRET, ancient),
    });
    expect(status).toBe(400);
    expect(json.error).toBe('invalid_signature');
  });

  /**
   * Both modes arrive on the SAME paths (ADR 0017). The secret that verifies a
   * delivery decides its mode, and the stored row records it — that is what
   * the drain routes processing by.
   */
  test('a live event signed with the live secret is accepted and stored as live', async () => {
    const body = eventBody({ livemode: true });
    const parsed = JSON.parse(body) as { id: string };
    const { status, json } = await post(gatewayUrl, '/v1/webhooks/stripe', body, {
      'Stripe-Signature': signStripe(body, LIVE_PLATFORM_SECRET),
    });
    expect(status).toBe(200);
    expect(json).toEqual({ received: true, duplicate: false });

    const rows = await gatewayDb().select().from(providerEvents);
    expect(rows.find((row) => row.providerEventId === parsed.id)?.livemode).toBe(true);
  });

  test('a live connect event verifies against the live CONNECT secret only', async () => {
    const body = eventBody({ livemode: true, account: 'acct_seller_live' });
    const wrong = await post(gatewayUrl, '/v1/webhooks/stripe/connect', body, {
      'Stripe-Signature': signStripe(body, LIVE_PLATFORM_SECRET),
    });
    expect(wrong.status).toBe(400);
    const right = await post(gatewayUrl, '/v1/webhooks/stripe/connect', body, {
      'Stripe-Signature': signStripe(body, LIVE_CONNECT_SECRET),
    });
    expect(right.status).toBe(200);
  });

  /**
   * A body claiming the OTHER mode than the secret that signed it.
   *
   * Stripe never signs a live event with a test endpoint's secret, so this is
   * somebody holding one mode's secret forging the other mode's event — a
   * leaked test secret must not be able to settle a live payment. Refused, 400,
   * nothing stored.
   */
  test('a live event signed with the TEST secret is refused and not stored', async () => {
    const body = eventBody({ livemode: true });
    const parsed = JSON.parse(body) as { id: string };
    const { status, json } = await post(gatewayUrl, '/v1/webhooks/stripe', body, {
      'Stripe-Signature': signStripe(body, PLATFORM_SECRET),
    });
    expect(status).toBe(400);
    expect(json.error).toBe('invalid_signature');

    const rows = await gatewayDb().select().from(providerEvents);
    expect(rows.find((row) => row.providerEventId === parsed.id)).toBeUndefined();
  });

  test('a test event signed with the LIVE secret is refused too', async () => {
    const body = eventBody({ livemode: false });
    const { status } = await post(gatewayUrl, '/v1/webhooks/stripe', body, {
      'Stripe-Signature': signStripe(body, LIVE_PLATFORM_SECRET),
    });
    expect(status).toBe(400);
  });

  /**
   * An event of a mode this deployment has no key for: its secret is not held
   * either, so nothing can verify it — refused like any bad signature.
   */
  test('an event of a mode with no configured key is refused with 400', async () => {
    const before = config.stripe.live;
    config.stripe.live = undefined;
    try {
      const body = eventBody({ livemode: true });
      const parsed = JSON.parse(body) as { id: string };
      const { status, json } = await post(gatewayUrl, '/v1/webhooks/stripe', body, {
        'Stripe-Signature': signStripe(body, LIVE_PLATFORM_SECRET),
      });
      expect(status).toBe(400);
      expect(json.error).toBe('invalid_signature');
      const rows = await gatewayDb().select().from(providerEvents);
      expect(rows.find((row) => row.providerEventId === parsed.id)).toBeUndefined();
    } finally {
      config.stripe.live = before;
    }
  });

  /**
   * The payload is stored REDACTED.
   *
   * `provider_events` is the one table a support query reads, so a raw Stripe
   * body in it would make every such query a disclosure of a payer's name,
   * address and card details.
   */
  test('what lands in the table is redacted, not the bytes Stripe sent', async () => {
    const body = eventBody({
      data: {
        object: {
          id: 'pi_stripe_redact',
          object: 'payment_intent',
          amount: 2500,
          currency: 'eur',
          status: 'succeeded',
          receipt_email: 'payer@example.com',
          billing_details: { address: { line1: '1 Real Street' } },
        },
      },
    });
    const parsed = JSON.parse(body) as { id: string };
    await post(gatewayUrl, '/v1/webhooks/stripe', body, {
      'Stripe-Signature': signStripe(body, PLATFORM_SECRET),
    });

    const rows = await gatewayDb().select().from(providerEvents);
    const stored = rows.find((row) => row.providerEventId === parsed.id);
    const serialized = JSON.stringify(stored?.payload);
    expect(serialized).not.toContain('payer@example.com');
    expect(serialized).not.toContain('1 Real Street');
    // ...and the reconciliation fields survived, or the row would be useless.
    expect(serialized).toContain('pi_stripe_redact');
    expect(serialized).toContain('2500');
  });

  /**
   * The webhook paths are NOT behind the global rate limiter.
   *
   * Every Stripe delivery arrives from a small pool of Stripe's own addresses,
   * so a per-IP bucket is one bucket for the whole provider: an incident backlog
   * being redelivered would trip it and Stripe would retry into the same bucket
   * until it disabled the endpoint. A burst has to come back 2xx.
   */
  test('a burst of deliveries is not rate-limited', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () => {
        const body = eventBody();
        return post(gatewayUrl, '/v1/webhooks/stripe', body, {
          'Stripe-Signature': signStripe(body, PLATFORM_SECRET),
        });
      }),
    );
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(results.some((result) => result.status === 429)).toBe(false);
  });
});
