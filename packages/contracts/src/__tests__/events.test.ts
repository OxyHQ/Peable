import { describe, expect, test } from 'bun:test';
import { buildOpenApiDocument } from '../openapi';
import { webhookEvents } from '../openapi/webhooks';
import { eventSchema } from '../resources/events/events';
import {
  TARGETED_WEBHOOK_EVENT_TYPES,
  WEBHOOK_ENABLED_EVENTS,
  WEBHOOK_EVENT_OBJECTS,
  WEBHOOK_EVENT_TYPES,
} from '../vocabulary/events';

const endpoint = {
  id: 'we_1',
  object: 'webhook_endpoint',
  livemode: false,
  url: 'https://example.com/hook',
  description: null,
  enabled_events: ['*'],
  status: 'enabled',
  disabled_reason: null,
  api_version: '2026-11-03',
  metadata: {},
  created: 1793750000,
  updated_at: 1793750000,
};

const testEvent = {
  id: 'evt_1',
  object: 'event',
  type: 'webhook_endpoint.test',
  created: 1793750400,
  livemode: false,
  api_version: '2026-11-03',
  data: { object: endpoint },
  request: { id: null, idempotency_key: null },
};

describe('the event vocabulary', () => {
  test('every event type names the object it carries', () => {
    expect(WEBHOOK_EVENT_TYPES).toEqual(Object.keys(WEBHOOK_EVENT_OBJECTS) as never);
    expect(new Set(WEBHOOK_EVENT_TYPES).size).toBe(WEBHOOK_EVENT_TYPES.length);
  });

  test('enabled_events is `*` and every type but the targeted ones', () => {
    expect(WEBHOOK_ENABLED_EVENTS[0]).toBe('*');
    expect(WEBHOOK_ENABLED_EVENTS).toHaveLength(
      WEBHOOK_EVENT_TYPES.length - TARGETED_WEBHOOK_EVENT_TYPES.length + 1,
    );
    for (const targeted of TARGETED_WEBHOOK_EVENT_TYPES)
      expect(WEBHOOK_ENABLED_EVENTS as readonly string[]).not.toContain(targeted);
  });
});

describe('the Event schema', () => {
  test('accepts an event whose object is the one its type names', () => {
    expect(eventSchema.safeParse(testEvent).success).toBe(true);
  });

  test("refuses an object that is valid for another type but not for this event's", () => {
    const customerAsTest = {
      ...testEvent,
      data: {
        object: {
          id: 'cus_1',
          object: 'customer',
          livemode: false,
          email: null,
          name: null,
          phone: null,
          description: null,
          address: null,
          shipping: null,
          invoice_settings: { default_payment_method: null },
          metadata: {},
          balance: '0',
          currency: null,
          test_clock: null,
          created: 1793750000,
        },
      },
    };
    const parsed = eventSchema.safeParse(customerAsTest);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path.slice(0, 2)).toEqual(['data', 'object']);
  });

  test('refuses a field the envelope does not have', () => {
    expect(eventSchema.safeParse({ ...testEvent, pending_webhooks: 1 }).success).toBe(false);
  });
});

describe('the webhooks section', () => {
  test('documents every event type once, with a description', () => {
    const contracts = webhookEvents();
    expect(contracts.map((event) => event.type)).toEqual([...WEBHOOK_EVENT_TYPES]);
    for (const event of contracts) expect(event.description?.length ?? 0).toBeGreaterThan(0);
    expect(Object.keys(buildOpenApiDocument().webhooks).sort()).toEqual(
      [...WEBHOOK_EVENT_TYPES].sort(),
    );
  });

  test("narrows each body's `type` and `data.object` to that event type", () => {
    const webhooks = buildOpenApiDocument().webhooks as Record<
      string,
      { post: { requestBody: { content: { 'application/json': { schema: unknown } } } } }
    >;
    const body = webhooks['webhook_endpoint.test']?.post.requestBody.content['application/json']
      .schema as {
      properties: { type: { const: string }; data: { properties: { object: { $ref: string } } } };
    };
    expect(body.properties.type.const).toBe('webhook_endpoint.test');
    expect(body.properties.data.properties.object.$ref).toBe(
      '#/components/schemas/WebhookEndpoint',
    );
  });
});
