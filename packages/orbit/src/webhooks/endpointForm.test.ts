import { describe, expect, it } from 'bun:test';
import { buildEndpointBody, describeEnabledEvents, EMPTY_ENDPOINT_FORM } from './endpointForm';

describe('buildEndpointBody', () => {
  it('defaults to every event and trims what was typed', () => {
    expect(
      buildEndpointBody({ ...EMPTY_ENDPOINT_FORM, url: ' https://shop.example/hook ' }),
    ).toEqual({ ok: true, body: { url: 'https://shop.example/hook', enabled_events: ['*'] } });
  });

  it('splits events on spaces and commas, once each, and keeps a description', () => {
    expect(
      buildEndpointBody({
        url: 'https://shop.example/hook',
        events: 'payment_intent.settled, payment_intent.failed payment_intent.settled',
        description: ' orders ',
      }),
    ).toEqual({
      ok: true,
      body: {
        url: 'https://shop.example/hook',
        enabled_events: ['payment_intent.settled', 'payment_intent.failed'],
        description: 'orders',
      },
    });
  });

  it('refuses a missing URL or no events', () => {
    expect(buildEndpointBody({ ...EMPTY_ENDPOINT_FORM, url: 'shop.example' })).toEqual({
      ok: false,
      error: 'url',
    });
    expect(
      buildEndpointBody({ ...EMPTY_ENDPOINT_FORM, url: 'https://shop.example', events: ' , ' }),
    ).toEqual({ ok: false, error: 'events' });
  });
});

describe('describeEnabledEvents', () => {
  it('reads * as every event', () => {
    expect(describeEnabledEvents({ enabled_events: ['*'] }, 'All events')).toBe('All events');
    expect(
      describeEnabledEvents(
        { enabled_events: ['payment_intent.settled', 'payment_intent.failed'] },
        'All events',
      ),
    ).toBe('payment_intent.settled, payment_intent.failed');
  });
});
