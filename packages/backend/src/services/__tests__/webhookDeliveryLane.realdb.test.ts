/**
 * Where a delivery may go, judged at delivery time against a real server
 * (ADR 0014 D4).
 *
 * Two defects, each with its production row:
 *
 * - The exact bypass: `we_dcc4e42ee41ae60ad31bde53`, a LIVE endpoint at
 *   `http://127.0.0.1:9/ssrf`, was written by migration 0040's backfill, which
 *   copied `merchants.webhook_url` (validated only as `z.string().url()`) with
 *   nothing but a scheme check — never through `webhookUrlProblem`. The outbox
 *   now judges the stored URL by that same rule before every delivery, sends
 *   nothing, and disables the endpoint `url_refused`.
 * - Oxy's own endpoint (`https://api.oxy.so/billing/peable/events`) failed
 *   every attempt: inside the VPC `api.oxy.so` resolves to a private address,
 *   which `safeFetch` refuses. A VERIFIED first-party merchant's endpoint on
 *   Oxy's own API (the SDK's `isFirstPartyServiceUrl`) is sent through Oxy's
 *   transport; everything else stays on `safeFetch`.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { SsrfRejection, type SafeFetchResult } from '@oxy.so/core/server';
import { PEABLE_API_VERSION } from '@peable.to/contracts';
import { verifyWebhook } from '@peable.to/shared-types';
import { must } from '../../__tests__/helpers/must';
import { syncMerchantAuthority, type MerchantRow } from '../../db/merchants/merchantRepository';
import { findDeliveryForMerchant } from '../../db/webhooks/webhookDeliveryRepository';
import {
  findEndpointForMerchant,
  insertEndpoint,
  type WebhookEndpointRow,
} from '../../db/webhooks/webhookEndpointRepository';
import { newId } from '../../lib/ids';
import type { FirstPartyFetchFn, SafeFetchFn } from '../webhookDispatcher';
import { generateWebhookSecret } from '../webhookEndpoints';
import { runWebhookOutboxPass } from '../webhookOutbox';
import {
  POSTGRES_TESTS_ENABLED,
  gatewayDb,
  resetGatewayTables,
  seedDelivery,
  seedIntent,
  seedMerchant,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';

useGatewayDatabase();

const OXY_EVENTS_URL = 'https://api.oxy.so/billing/peable/events';

interface Sent {
  readonly lane: 'public' | 'first_party';
  readonly url: string;
  readonly body: string;
  readonly signature: string;
}

/** Both transports, recording which one each attempt took and what it sent. */
function transports(answer: { public?: number | Error; firstParty?: number | Error } = {}) {
  const sent: Sent[] = [];
  const safeFetch: SafeFetchFn = async (url, options) => {
    sent.push({
      lane: 'public',
      url,
      body: typeof options?.body === 'string' ? options.body : '',
      signature: options?.headers?.['Peable-Signature'] ?? '',
    });
    const outcome = answer.public ?? 200;
    if (outcome instanceof Error) throw outcome;
    const response = new IncomingMessage(new Socket());
    response.destroy = () => response;
    const result: SafeFetchResult = { response, status: outcome, headers: {}, finalUrl: url };
    return result;
  };
  const firstPartyFetch: FirstPartyFetchFn = async (url, init) => {
    const headers = new Headers(init.headers);
    sent.push({
      lane: 'first_party',
      url,
      body: typeof init.body === 'string' ? init.body : '',
      signature: headers.get('Peable-Signature') ?? '',
    });
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const outcome = answer.firstParty ?? 200;
    if (outcome instanceof Error) throw outcome;
    return new Response('{"received":true}', { status: outcome });
  };
  return { safeFetch, firstPartyFetch, sent };
}

/**
 * An endpoint written straight through the repository, WITHOUT the route's
 * `webhookUrlProblem` — what the 0040 backfill did.
 */
async function storedEndpoint(
  merchant: MerchantRow,
  url: string,
): Promise<{ endpoint: WebhookEndpointRow; secret: string }> {
  const secret = generateWebhookSecret();
  const endpoint = await insertEndpoint(gatewayDb(), {
    publicId: newId('we'),
    merchantId: merchant.id,
    url,
    enabledEvents: ['*'],
    metadata: {},
    apiVersion: PEABLE_API_VERSION,
    secret,
  });
  if (endpoint === 'limit_reached') throw new Error('endpoint limit reached');
  return { endpoint, secret };
}

async function merchantOf(options: { live: boolean; firstParty: boolean }): Promise<MerchantRow> {
  const merchant = await seedMerchant(
    options.live ? { environment: 'production', network: 'mainnet' } : {},
  );
  return syncMerchantAuthority(gatewayDb(), merchant, { firstParty: options.firstParty });
}

async function deliverOnce(
  merchant: MerchantRow,
  url: string,
  answer: Parameters<typeof transports>[0] = {},
) {
  const { endpoint, secret } = await storedEndpoint(merchant, url);
  const intent = await seedIntent(merchant);
  const delivery = await seedDelivery(merchant, intent, { endpoint, pending: true });
  const io = transports(answer);
  const pass = await runWebhookOutboxPass({
    safeFetch: io.safeFetch,
    firstPartyFetch: io.firstPartyFetch,
  });
  const after = must(await findDeliveryForMerchant(gatewayDb(), delivery.id, merchant.id));
  const endpointAfter = must(
    await findEndpointForMerchant(gatewayDb(), endpoint.publicId, merchant.id),
  );
  return { pass, sent: io.sent, delivery: after, endpoint: endpointAfter, secret };
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('a stored URL the registration rule refuses', () => {
  beforeEach(async () => {
    await resetGatewayTables();
  });

  test('the production bypass: a live http://127.0.0.1:9 endpoint is never fetched and is disabled url_refused', async () => {
    const merchant = await merchantOf({ live: true, firstParty: false });

    const { sent, delivery, endpoint } = await deliverOnce(merchant, 'http://127.0.0.1:9/ssrf');

    expect(sent).toHaveLength(0);
    expect(delivery.lastStatus).toBe('failed');
    expect(delivery.lastError).toBe(
      'webhook endpoint url refused: a live-mode webhook endpoint must use https',
    );
    expect(endpoint.status).toBe('disabled');
    expect(endpoint.disabledReason).toBe('url_refused');
  });

  test.each([
    ['https://127.0.0.1:9/ssrf', 'url must use port 80 or 443'],
    ['https://[::1]/hook', 'url must not point at a private, loopback or reserved address'],
    [
      'https://[::ffff:127.0.0.1]/hook',
      'url must not point at a private, loopback or reserved address',
    ],
    // WHATWG URL canonicalizes the numeric forms to 127.0.0.1 before the check.
    ['https://0x7f.0.0.1/hook', 'url must not point at a private, loopback or reserved address'],
    ['https://2130706433/hook', 'url must not point at a private, loopback or reserved address'],
    ['https://127.1/hook', 'url must not point at a private, loopback or reserved address'],
    [
      'https://%31%32%37.0.0.1/hook',
      'url must not point at a private, loopback or reserved address',
    ],
    [
      'https://169.254.169.254/latest',
      'url must not point at a private, loopback or reserved address',
    ],
    ['https://localhost./hook', 'url must name a public host'],
    ['https://a.localhost/hook', 'url must name a public host'],
    ['https://user:pass@merchant.example/hook', 'url must not carry credentials'],
  ])('%s is refused before any lane, even for a first-party merchant', async (url, problem) => {
    const merchant = await merchantOf({ live: true, firstParty: true });

    const { sent, delivery, endpoint } = await deliverOnce(merchant, url);

    expect(sent).toHaveLength(0);
    expect(delivery.lastError).toBe(`webhook endpoint url refused: ${problem}`);
    expect(endpoint.disabledReason).toBe('url_refused');
  });

  test('a test-mode http endpoint on a public host is still delivered (the rule, not a stricter one)', async () => {
    const merchant = await merchantOf({ live: false, firstParty: false });

    const { sent, delivery, endpoint } = await deliverOnce(
      merchant,
      'http://merchant.example/hook',
    );

    expect(sent.map((s) => s.lane)).toEqual(['public']);
    expect(delivery.lastStatus).toBe('delivered');
    expect(endpoint.status).toBe('enabled');
  });
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('the delivery lane', () => {
  beforeEach(async () => {
    await resetGatewayTables();
  });

  test("a first-party merchant's endpoint on Oxy's API goes through Oxy's transport, signed over the same bytes", async () => {
    const merchant = await merchantOf({ live: true, firstParty: true });

    const { sent, delivery, endpoint, secret } = await deliverOnce(merchant, OXY_EVENTS_URL);

    expect(sent.map((s) => s.lane)).toEqual(['first_party']);
    const [post] = sent;
    expect(must(post).url).toBe(OXY_EVENTS_URL);
    expect(
      verifyWebhook(
        secret,
        must(post).body,
        must(post).signature,
        300,
        Math.floor(Date.now() / 1000),
      ),
    ).toBe(true);
    expect(delivery.lastStatus).toBe('delivered');
    expect(endpoint.failingSince).toBeNull();
  });

  test('both lanes classify the same: a 503 from Oxy is retried, a 400 refused, a transport failure retried', async () => {
    const merchant = await merchantOf({ live: true, firstParty: true });

    const busy = await deliverOnce(merchant, OXY_EVENTS_URL, { firstParty: 503 });
    expect(busy.delivery.lastStatus).toBe('pending');
    expect(busy.delivery.lastError).toBe('target responded 503');
    expect(busy.endpoint.failingSince).not.toBeNull();

    await resetGatewayTables();
    const other = await merchantOf({ live: true, firstParty: true });
    const refused = await deliverOnce(other, OXY_EVENTS_URL, { firstParty: 400 });
    expect(refused.delivery.lastStatus).toBe('failed');
    expect(refused.delivery.lastError).toBe('target responded 400');

    await resetGatewayTables();
    const third = await merchantOf({ live: true, firstParty: true });
    const down = await deliverOnce(third, OXY_EVENTS_URL, {
      firstParty: new TypeError('fetch failed'),
    });
    expect(down.delivery.lastStatus).toBe('pending');
    expect(down.delivery.lastError).toBe('upstream error: first-party transport: fetch failed');
  });

  test("a third-party merchant naming Oxy's API stays on safeFetch, which refuses its private address", async () => {
    const merchant = await merchantOf({ live: true, firstParty: false });

    const { sent, delivery } = await deliverOnce(merchant, OXY_EVENTS_URL, {
      public: new SsrfRejection('hostname resolves to blocked range'),
    });

    expect(sent.map((s) => s.lane)).toEqual(['public']);
    expect(delivery.lastStatus).toBe('failed');
    expect(delivery.lastError).toBe('ssrf rejection: hostname resolves to blocked range');
  });

  test.each([
    'https://api.oxy.so.evil.com/billing/peable/events',
    'https://evil.com/api.oxy.so',
    'https://auth.oxy.so/billing/peable/events',
    'https://api.oxy.so./billing/peable/events',
  ])('%s from a first-party merchant stays on safeFetch', async (url) => {
    const merchant = await merchantOf({ live: true, firstParty: true });

    const { sent } = await deliverOnce(merchant, url);

    expect(sent.map((s) => s.lane)).toEqual(['public']);
  });

  test('a public name with private DNS (evil.com) is still refused by safeFetch for a first-party merchant', async () => {
    const merchant = await merchantOf({ live: true, firstParty: true });

    const { sent, delivery } = await deliverOnce(merchant, 'https://evil.com/hook', {
      public: new SsrfRejection('hostname resolves to blocked range'),
    });

    expect(sent.map((s) => s.lane)).toEqual(['public']);
    expect(delivery.lastError).toBe('ssrf rejection: hostname resolves to blocked range');
  });
});
