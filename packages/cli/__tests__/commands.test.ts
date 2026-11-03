/**
 * The commands end to end: the real `main`, a temporary HOME, and a local
 * fake gateway (which also answers the Oxy token mint) — so what is asserted
 * is what reaches the gateway, what is stored, and what is printed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { WebhooksResource, WEBHOOK_SIGNATURE_HEADER } from '@peable.to/sdk';
import { configPath } from '../src/config.js';
import { FIXTURES, TRIGGERABLE_EVENTS } from '../src/fixtures.js';
import { main } from '../src/main.js';
import { CLI_VERSION } from '../src/version.js';
import { json, merchant, mintToken, serve, tempHome, testIo, type Received } from './support.js';
import pkg from '../package.json' with { type: 'json' };

const SECRET = 'oxy_secret_value_never_printed';

let home = '';
let cleanup: () => Promise<void> = async () => undefined;
const closers: (() => Promise<void>)[] = [];
let livemode = false;
/** Frames the fake stream sends after `ready`. */
let streamFrames: string[] = [];

function intent(id: string, status: string) {
  return { id, object: 'payment_intent', status, amount: '100000000', currency: 'FAIR' };
}

async function gatewayRoute(request: Received, response: ServerResponse): Promise<void> {
  const path = request.path.split('?')[0];
  if (path === '/auth/service-token') return mintToken(response);
  if (path === '/v1/merchants/me') return json(response, 200, merchant(livemode));
  if (path === '/v1/events/stream') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('event: ready\ndata: {"object":"live_stream","livemode":false}\n\n');
    for (const frame of streamFrames) response.write(frame);
    return;
  }
  if (path === '/v1/payment_intents' && request.method === 'POST') {
    return json(response, 201, intent('pi_new', 'requires_action'));
  }
  if (path === '/v1/payment_intents' && request.method === 'GET') {
    return json(response, 200, {
      object: 'list',
      data: [intent('pi_1', 'succeeded')],
      has_more: false,
      url: '/v1/payment_intents',
    });
  }
  if (path?.startsWith('/v1/test_helpers/payment_intents/')) {
    const body = JSON.parse(request.body) as { outcome?: string };
    return json(
      response,
      200,
      intent('pi_new', body.outcome === 'underpaid' ? 'canceled' : 'succeeded'),
    );
  }
  if (path === '/v1/payment_intents/pi_new/cancel') {
    return json(response, 200, intent('pi_new', 'canceled'));
  }
  if (path === '/v1/products' && request.method === 'POST') {
    return json(response, 200, { id: 'prod_1', object: 'product', active: true });
  }
  if (path === '/v1/products/prod_1' && request.method === 'DELETE') {
    return json(response, 200, { id: 'prod_1', object: 'product', deleted: true });
  }
  if (path === '/v1/prices' && request.method === 'POST') {
    return json(response, 200, { id: 'price_1', object: 'price', active: true });
  }
  if (path === '/v1/webhook_endpoints' && request.method === 'GET') {
    return json(response, 200, { object: 'list', data: [], has_more: false, url: path });
  }
  if (path === '/v1/webhook_endpoints' && request.method === 'POST') {
    return json(response, 200, {
      id: 'we_1',
      object: 'webhook_endpoint',
      url: 'https://shop.example/hook',
      status: 'enabled',
      secret: 'whsec_endpoint_secret',
    });
  }
  return json(response, 404, { error: { type: 'invalid_request_error', message: 'no route' } });
}

let gateway: Awaited<ReturnType<typeof serve>>;

beforeEach(async () => {
  ({ home, cleanup } = await tempHome());
  livemode = false;
  streamFrames = [];
  gateway = await serve(gatewayRoute);
  closers.push(gateway.close);
});
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await cleanup();
});

async function login(args: string[] = []) {
  const io = testIo({ HOME: home }, { prompt: 'oxy_dk_public', secret: SECRET });
  const code = await main(
    ['login', '--base-url', gateway.url, '--oxy-api-url', gateway.url, ...args],
    io,
  );
  return { code, io };
}

test('--version prints the package version', async () => {
  const io = testIo({ HOME: home });
  expect(await main(['--version'], io)).toBe(0);
  expect(io.stdout).toEqual([CLI_VERSION]);
  expect(CLI_VERSION).toBe(pkg.version);
});

describe('login / whoami / logout', () => {
  test('stores the verified credential 0600, and never prints the secret', async () => {
    const { code, io } = await login();
    expect(code).toBe(0);
    expect(io.printed()).toContain('merch_test');
    expect(io.printed()).not.toContain(SECRET);

    const path = configPath({ HOME: home });
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(await readFile(path, 'utf8'));
    expect(stored.profiles.default).toEqual({
      base_url: gateway.url,
      oxy_api_url: gateway.url,
      test: { public_key: 'oxy_dk_public', secret: SECRET, merchant: 'merch_test' },
    });
    // The mint saw the credential; the gateway saw only the minted token.
    const mint = gateway.received.find((r) => r.path === '/auth/service-token');
    expect(JSON.parse(mint?.body ?? '{}')).toEqual({ apiKey: 'oxy_dk_public', apiSecret: SECRET });
    const me = gateway.received.find((r) => r.path === '/v1/merchants/me');
    expect(me?.headers.authorization).toBe('Bearer svc_token');

    const whoami = testIo({ HOME: home });
    expect(await main(['whoami'], whoami)).toBe(0);
    expect(whoami.stdout.join('')).toContain('merch_test (Test Shop) — test mode, testnet');
    expect(whoami.printed()).not.toContain(SECRET);
  });

  test('refuses a credential whose mode is not the one asked for, storing nothing', async () => {
    livemode = true;
    const { code, io } = await login();
    expect(code).toBe(2);
    expect(io.stderr.join('')).toContain('live-mode credential');
    await expect(readFile(configPath({ HOME: home }), 'utf8')).rejects.toThrow();
    expect((await login(['--live'])).code).toBe(0);
  });

  test('logout removes the profile; a command after it says how to log in', async () => {
    await login(['--profile', 'shop']);
    const io = testIo({ HOME: home });
    expect(await main(['logout', '--profile', 'shop'], io)).toBe(0);
    const after = testIo({ HOME: home });
    expect(await main(['whoami', '--profile', 'shop'], after)).toBe(2);
    expect(after.stderr.join('')).toContain('peable login --profile shop');
  });
});

describe('listen', () => {
  test('forwards each streamed event, signed with the printed session secret', async () => {
    await login();
    const event = {
      id: 'evt_1',
      object: 'event',
      type: 'payment_intent.succeeded',
      created: 1_789_776_000,
      livemode: false,
      api_version: '2026-11-03',
      data: { object: intent('pi_1', 'succeeded') },
      request: { id: null, idempotency_key: null },
    };
    streamFrames = [`id: evt_1\nevent: event\ndata: ${JSON.stringify(event)}\n\n`];
    const io = testIo({ HOME: home });
    const verified: unknown[] = [];
    const receiver = await serve((request, response) => {
      const secret = /whsec_[0-9a-f]{64}/.exec(io.stderr.join('\n'))?.[0] ?? '';
      verified.push(
        new WebhooksResource().constructEvent(
          request.body,
          String(request.headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()]),
          secret,
        ),
      );
      response.writeHead(200);
      response.end();
      io.abort();
    });
    closers.push(receiver.close);

    const code = await main(
      ['listen', '--forward-to', `${receiver.url}/webhooks`, '--events', 'payment_intent.*'],
      io,
    );
    expect(code).toBe(0);
    expect(io.stderr.join('\n')).toMatch(
      /Ready! Your webhook signing secret is whsec_[0-9a-f]{64}/,
    );
    expect(verified).toEqual([event]);
    expect(io.stdout.join('\n')).toContain('--> payment_intent.succeeded [evt_1]');
    expect(io.stdout.join('\n')).toContain(`<--  [200] POST ${receiver.url}/webhooks [evt_1]`);
    const stream = gateway.received.find((r) => r.path.startsWith('/v1/events/stream'));
    expect(stream?.path).toBe('/v1/events/stream?types=payment_intent.*');
    expect(io.printed()).not.toContain(SECRET);
  });

  test('is refused in live mode, before anything is opened', async () => {
    const io = testIo({ HOME: home });
    expect(await main(['listen', '--live'], io)).toBe(2);
    expect(io.stderr.join('')).toContain('test mode only');
    expect(gateway.received).toEqual([]);
  });

  test('refuses a --forward-to that is not an http(s) URL', async () => {
    await login();
    const io = testIo({ HOME: home });
    expect(await main(['listen', '--forward-to', 'ftp://x'], io)).toBe(2);
  });
});

describe('trigger', () => {
  test('every fixture causes the event it is listed under', () => {
    for (const name of TRIGGERABLE_EVENTS) {
      expect(FIXTURES[name].causes as readonly string[]).toContain(name);
    }
  });

  test('an unsupported event prints the supported list', async () => {
    const io = testIo({ HOME: home });
    expect(await main(['trigger', 'charge.refunded'], io)).toBe(2);
    const printed = io.stderr.join('\n');
    expect(printed).toContain("'charge.refunded' cannot be triggered");
    for (const name of TRIGGERABLE_EVENTS) expect(printed).toContain(name);
  });

  test('payment_intent.succeeded creates a testnet intent and simulates its payment', async () => {
    await login();
    const io = testIo({ HOME: home });
    expect(await main(['trigger', 'payment_intent.succeeded'], io)).toBe(0);
    const calls = gateway.received
      .filter((r) => r.path.startsWith('/v1/') && r.path !== '/v1/merchants/me')
      .map((r) => `${r.method} ${r.path} ${r.body}`);
    expect(calls).toEqual([
      'POST /v1/payment_intents {"amount":"100000000","network":"testnet","metadata":{"created_by":"peable trigger"}}',
      'POST /v1/test_helpers/payment_intents/pi_new/simulate_faircoin_payment {"outcome":"settled"}',
    ]);
    expect(io.stdout.join('')).toContain('payment_intent.processing, payment_intent.succeeded');
  });

  test('payment_intent.canceled cancels; webhook_endpoint.test needs an endpoint', async () => {
    await login();
    expect(await main(['trigger', 'payment_intent.canceled'], testIo({ HOME: home }))).toBe(0);
    expect(gateway.received.map((r) => r.path)).toContain('/v1/payment_intents/pi_new/cancel');
    const io = testIo({ HOME: home });
    expect(await main(['trigger', 'webhook_endpoint.test'], io)).toBe(1);
    expect(io.stderr.join('')).toContain('peable webhook_endpoints create');
  });

  test('the catalog fixtures create, price and delete a product', async () => {
    await login();
    expect(await main(['trigger', 'product.deleted'], testIo({ HOME: home }))).toBe(0);
    expect(await main(['trigger', 'price.created'], testIo({ HOME: home }))).toBe(0);
    const calls = gateway.received
      .filter((r) => r.path.startsWith('/v1/') && r.path !== '/v1/merchants/me')
      .map((r) => `${r.method} ${r.path}`);
    expect(calls).toEqual([
      'POST /v1/products',
      'DELETE /v1/products/prod_1',
      'POST /v1/products',
      'POST /v1/prices',
    ]);
    const price = gateway.received.find((r) => r.path === '/v1/prices');
    expect(JSON.parse(price?.body ?? '{}')).toMatchObject({
      product: 'prod_1',
      currency: 'EUR',
      unit_amount: '1000',
    });
  });

  test('is refused in live mode', async () => {
    const io = testIo({ HOME: home });
    expect(await main(['trigger', 'payment_intent.created', '--live'], io)).toBe(2);
  });
});

describe('resource commands', () => {
  test('payment_intents list prints one line per intent, or the JSON page', async () => {
    await login();
    const io = testIo({ HOME: home });
    expect(await main(['payment_intents', 'list', '--limit', '3'], io)).toBe(0);
    expect(io.stdout.join('')).toContain('pi_1  succeeded  100000000 FAIR');
    expect(gateway.received.at(-1)?.path).toBe('/v1/payment_intents?limit=3');
    const asJson = testIo({ HOME: home });
    expect(await main(['payment_intents', 'list', '--json'], asJson)).toBe(0);
    expect(JSON.parse(asJson.stdout.join(''))).toMatchObject({ object: 'list' });
  });

  test('payment_intents create sends --amount, --metadata and testnet by default', async () => {
    await login();
    const io = testIo({ HOME: home });
    expect(
      await main(
        ['payment_intents', 'create', '--amount', '5000', '--metadata', 'order=42', '--json'],
        io,
      ),
    ).toBe(0);
    expect(JSON.parse(gateway.received.at(-1)?.body ?? '{}')).toEqual({
      amount: '5000',
      network: 'testnet',
      metadata: { order: '42' },
    });
    expect(await main(['payment_intents', 'create'], testIo({ HOME: home }))).toBe(2);
  });

  test('webhook_endpoints create prints the endpoint secret once', async () => {
    await login();
    const io = testIo({ HOME: home });
    expect(
      await main(['webhook_endpoints', 'create', '--url', 'https://shop.example/hook'], io),
    ).toBe(0);
    expect(JSON.parse(gateway.received.at(-1)?.body ?? '{}')).toEqual({
      url: 'https://shop.example/hook',
      enabled_events: ['*'],
    });
    expect(io.stdout.join('\n')).toContain('Signing secret (shown once): whsec_endpoint_secret');
  });

  test('an API error prints its message, code and request id, and exits 1', async () => {
    await login();
    const io = testIo({ HOME: home });
    expect(await main(['payment_intents', 'retrieve', 'pi_missing'], io)).toBe(1);
    expect(io.stderr.join('')).toContain('Error: no route');
    expect(io.stderr.join('')).toContain('request: req_test');
  });

  test('an unknown command or flag is a usage error', async () => {
    expect(await main(['nope'], testIo({ HOME: home }))).toBe(2);
    expect(await main(['payment_intents', 'list', '--bogus'], testIo({ HOME: home }))).toBe(2);
  });
});
