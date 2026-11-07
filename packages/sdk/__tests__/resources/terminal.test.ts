/**
 * Terminal (Stripe's `terminal.*`, ADR 0024): the generated methods reach the
 * right routes, every write that can be replayed sends an idempotency key, and
 * a connection token is minted fresh.
 */
import { describe, expect, test } from 'bun:test';
import type { TerminalLocation, TerminalReader } from '@peable.to/shared-types';
import { createMockFetch, type CapturedRequest } from '../support/mockFetch';
import { buildTestClient, resources, serviceTokenMintResponse } from '../support/testGateway';

const LOCATION: TerminalLocation = {
  id: 'tml_1',
  object: 'terminal.location',
  livemode: false,
  display_name: 'Valencia Street',
  address: {
    line1: '1272 Valencia Street',
    line2: null,
    city: 'San Francisco',
    state: 'CA',
    postal_code: '94110',
    country: 'US',
  },
  metadata: {},
};

const READER: TerminalReader = {
  id: 'tmr_1',
  object: 'terminal.reader',
  livemode: false,
  label: 'Front counter',
  device_type: 'simulated_wisepos_e',
  serial_number: 'SN-1',
  status: 'online',
  last_seen_at: 1_793_750_400,
  location: 'tml_1',
  action: {
    type: 'process_payment_intent',
    status: 'in_progress',
    failure_code: null,
    failure_message: null,
    process_payment_intent: {
      payment_intent: 'pi_1',
      process_config: { enable_customer_cancellation: false, skip_tipping: true },
    },
  },
  metadata: {},
};

function gateway(body: unknown) {
  return createMockFetch((req) => {
    if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
    return { status: 200, json: body };
  });
}

function callOf(requests: CapturedRequest[]): CapturedRequest {
  const call = requests.find((r) => !r.url.includes('/auth/service-token'));
  if (!call) throw new Error('no gateway call was made');
  return call;
}

describe('terminal', () => {
  test('locations.create posts the name and address with an idempotency key', async () => {
    const mock = gateway(LOCATION);
    const location = await resources(buildTestClient(mock.fetch)).terminal.locations.create({
      display_name: 'Valencia Street',
      address: { line1: '1272 Valencia Street', country: 'US' },
    });
    expect(location.id).toBe('tml_1');
    const call = callOf(mock.requests);
    expect([call.method, new URL(call.url).pathname]).toEqual(['POST', '/v1/terminal/locations']);
    expect(call.headers.get('Idempotency-Key')).toBeTruthy();
  });

  test('readers: register, process a PaymentIntent, cancel the action, delete', async () => {
    const created = gateway(READER);
    await resources(buildTestClient(created.fetch)).terminal.readers.create({
      registration_code: 'simulated-wpe',
      location: 'tml_1',
    });
    expect(new URL(callOf(created.requests).url).pathname).toBe('/v1/terminal/readers');

    const processing = gateway(READER);
    const reader = await resources(
      buildTestClient(processing.fetch),
    ).terminal.readers.processPaymentIntent('tmr_1', { payment_intent: 'pi_1' });
    expect(reader.action?.status).toBe('in_progress');
    const call = callOf(processing.requests);
    expect([call.method, new URL(call.url).pathname]).toEqual([
      'POST',
      '/v1/terminal/readers/tmr_1/process_payment_intent',
    ]);
    expect(JSON.parse(call.body ?? '{}')).toEqual({ payment_intent: 'pi_1' });
    expect(call.headers.get('Idempotency-Key')).toBeTruthy();

    const canceling = gateway(READER);
    await resources(buildTestClient(canceling.fetch)).terminal.readers.cancelAction('tmr_1');
    expect(new URL(callOf(canceling.requests).url).pathname).toBe(
      '/v1/terminal/readers/tmr_1/cancel_action',
    );

    const deleting = gateway({ id: 'tmr_1', object: 'terminal.reader', deleted: true });
    await resources(buildTestClient(deleting.fetch)).terminal.readers.del('tmr_1');
    expect(callOf(deleting.requests).method).toBe('DELETE');
  });

  test('connection tokens and the simulated tap', async () => {
    const token = gateway({
      object: 'terminal.connection_token',
      secret: 'pst_1',
      location: 'tml_1',
    });
    const minted = await resources(buildTestClient(token.fetch)).terminal.connectionTokens.create({
      location: 'tml_1',
    });
    expect(minted.secret).toBe('pst_1');
    expect(new URL(callOf(token.requests).url).pathname).toBe('/v1/terminal/connection_tokens');

    const tap = gateway({ ...READER, action: { ...READER.action, status: 'succeeded' } });
    await resources(buildTestClient(tap.fetch)).testHelpers.terminal.readers.presentPaymentMethod(
      'tmr_1',
    );
    expect(new URL(callOf(tap.requests).url).pathname).toBe(
      '/v1/test_helpers/terminal/readers/tmr_1/present_payment_method',
    );
  });
});
