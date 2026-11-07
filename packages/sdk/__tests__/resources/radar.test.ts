/**
 * Risk rules and reviews (ADR 0022): the routes, method names, query
 * spellings and bodies an integrator would otherwise guess.
 */
import { describe, expect, test } from 'bun:test';
import type { RadarRule, Review } from '@peable.to/shared-types';
import { Peable } from '../../src/index';
import { type CapturedRequest, createMockFetch } from '../support/mockFetch';
import {
  buildTestClient,
  resources,
  serviceTokenMintResponse,
  TEST_GATEWAY_URL,
} from '../support/testGateway';

const RULE: RadarRule = {
  id: 'rule_1',
  object: 'radar.rule',
  livemode: false,
  action: 'block',
  predicate: ":card_country: not in ('ES')",
  description: null,
  enabled: true,
  version: 1,
  created: 1793750400,
  updated: 1793750400,
};

const REVIEW: Review = {
  id: 'prv_1',
  object: 'review',
  livemode: false,
  open: true,
  reason: 'rule',
  opened_reason: 'rule',
  closed_reason: null,
  payment_intent: 'pi_1',
  charge: 'ch_1',
  rule: { id: 'rule_1', action: 'review', predicate: ':amount: > 1', version: 1 },
  created: 1793750400,
  closed_at: null,
};

function harness(reply: unknown) {
  const gateway: CapturedRequest[] = [];
  const mock = createMockFetch((request) => {
    if (!request.url.startsWith(TEST_GATEWAY_URL)) return serviceTokenMintResponse();
    gateway.push(request);
    return { status: 200, json: reply };
  });
  return { client: buildTestClient(mock.fetch), gateway };
}

function route(gateway: CapturedRequest[]): [string, string] {
  const request = gateway.at(-1);
  if (!request) throw new Error('no gateway request was made');
  return [request.method, decodeURIComponent(request.url.slice(TEST_GATEWAY_URL.length))];
}

const body = (gateway: CapturedRequest[]) => JSON.parse(gateway.at(-1)?.body ?? '{}');
const list = <T>(data: T[]) => ({ object: 'list', data, has_more: false, url: '/v1/x' });

describe('risk rules and reviews', () => {
  test('the client carries radar and reviews', () => {
    const peable = new Peable({
      tokenProvider: { getToken: async () => 'token', invalidate: () => undefined },
    });
    expect(typeof peable.radar.rules).toBe('object');
    expect(typeof peable.radar.evaluations).toBe('object');
    expect(typeof peable.reviews).toBe('object');
  });

  test('rules: create, update, retrieve, delete', async () => {
    const { client, gateway } = harness(RULE);
    const rules = resources(client).radar.rules;
    await rules.create({ action: 'block', predicate: ":card_country: not in ('ES')" });
    expect(route(gateway)).toEqual(['POST', '/v1/radar/rules']);
    expect(body(gateway)).toEqual({ action: 'block', predicate: ":card_country: not in ('ES')" });
    await rules.update('rule_1', { enabled: false });
    expect(route(gateway)).toEqual(['POST', '/v1/radar/rules/rule_1']);
    await rules.retrieve('rule_1');
    expect(route(gateway)).toEqual(['GET', '/v1/radar/rules/rule_1']);
    await rules.del('rule_1');
    expect(route(gateway)).toEqual(['DELETE', '/v1/radar/rules/rule_1']);
  });

  test('lists: rules, evaluations, reviews', async () => {
    const { client, gateway } = harness(list([REVIEW]));
    const sdk = resources(client);
    await sdk.radar.rules.list({ action: 'review', enabled: true });
    expect(route(gateway)).toEqual(['GET', '/v1/radar/rules?action=review&enabled=true']);
    await sdk.radar.evaluations.list({ payment_intent: 'pi_1' });
    expect(route(gateway)).toEqual(['GET', '/v1/radar/evaluations?payment_intent=pi_1']);
    await sdk.reviews.list({ open: true });
    expect(route(gateway)).toEqual(['GET', '/v1/reviews?open=true']);
  });

  test('reviews: approve and refuse', async () => {
    const { client, gateway } = harness(REVIEW);
    const reviews = resources(client).reviews;
    await reviews.approve('prv_1');
    expect(route(gateway)).toEqual(['POST', '/v1/reviews/prv_1/approve']);
    await reviews.refuse('prv_1', { reason: 'fraudulent' });
    expect(route(gateway)).toEqual(['POST', '/v1/reviews/prv_1/refuse']);
    expect(body(gateway)).toEqual({ reason: 'fraudulent' });
  });
});
