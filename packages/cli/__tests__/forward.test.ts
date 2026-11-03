import { afterEach, describe, expect, test } from 'bun:test';
import { WebhooksResource, WEBHOOK_SIGNATURE_HEADER } from '@peable.to/sdk';
import { forwardEvent, generateSessionSecret, signForDelivery } from '../src/forward.js';
import { serve } from './support.js';

const EVENT = {
  id: 'evt_1',
  object: 'event',
  type: 'payment_intent.succeeded',
  created: 1_789_776_000,
  livemode: false,
  api_version: '2026-11-03',
  data: { object: { id: 'pi_1', object: 'payment_intent', status: 'succeeded' } },
  request: { id: 'req_1', idempotency_key: null },
};

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

describe('signing', () => {
  test('a session secret has the shape the gateway generates', () => {
    expect(generateSessionSecret()).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(generateSessionSecret()).not.toBe(generateSessionSecret());
  });

  test("the SDK's constructEvent verifies what the CLI signs, and nothing else", () => {
    const secret = generateSessionSecret();
    const { body, signature } = signForDelivery(EVENT, secret);
    const webhooks = new WebhooksResource();
    expect(webhooks.constructEvent(body, signature, secret)).toEqual(EVENT as never);
    expect(() => webhooks.constructEvent(body, signature, generateSessionSecret())).toThrow();
    expect(() => webhooks.constructEvent(`${body} `, signature, secret)).toThrow();
  });
});

describe('forwarding', () => {
  test('POSTs the signed event to a local server and reports its status', async () => {
    const secret = generateSessionSecret();
    const verified: unknown[] = [];
    const receiver = await serve((request, response) => {
      const signature = String(request.headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()]);
      verified.push(new WebhooksResource().constructEvent(request.body, signature, secret));
      response.writeHead(204);
      response.end();
    });
    closers.push(receiver.close);

    const result = await forwardEvent(EVENT, { url: `${receiver.url}/webhooks`, secret });
    expect(result).toMatchObject({ ok: true, status: 204 });
    expect(verified).toEqual([EVENT]);
    const [request] = receiver.received;
    expect(request?.method).toBe('POST');
    expect(request?.path).toBe('/webhooks');
    expect(request?.headers['content-type']).toBe('application/json');
    expect(String(request?.headers['user-agent'])).toStartWith('peable-cli/');
  });

  test('a receiver error is a status, an unreachable one an error — never a throw', async () => {
    const receiver = await serve((_request, response) => {
      response.writeHead(500);
      response.end('boom');
    });
    closers.push(receiver.close);
    const secret = generateSessionSecret();
    expect(await forwardEvent(EVENT, { url: receiver.url, secret })).toMatchObject({
      ok: true,
      status: 500,
    });
    const port = new URL(receiver.url).port;
    await receiver.close();
    closers.pop();
    const unreachable = await forwardEvent(EVENT, { url: `http://127.0.0.1:${port}`, secret });
    expect(unreachable.ok).toBe(false);
  });

  test('a server that never answers times out', async () => {
    const receiver = await serve(() => undefined);
    closers.push(receiver.close);
    const result = await forwardEvent(EVENT, {
      url: receiver.url,
      secret: generateSessionSecret(),
      timeoutMs: 100,
    });
    expect(result).toEqual({ ok: false, error: 'no answer within 100ms' });
  });
});
