/**
 * Stripe Terminal in the gateway's vocabulary (ADR 0024): a reader's action
 * crosses as codes (never Stripe's prose or the device's IP), an action Orbit
 * did not start is marked as such, and "this account has no Terminal" is
 * recognised.
 */
import { describe, expect, test } from 'bun:test';
import Stripe from 'stripe';
import { isTerminalUnavailableError } from '../client';
import { toAddress, toLiveTerminalReader, toStripeAddress, toTerminalReader } from '../terminal';
import { stripeObjectIds } from '../verify';

function reader(overrides: Record<string, unknown> = {}): Stripe.Terminal.Reader {
  return {
    id: 'tmr_stripe_1',
    object: 'terminal.reader',
    action: {
      type: 'process_payment_intent',
      status: 'failed',
      failure_code: 'card_declined',
      failure_message: 'The card was declined by the issuer for Jenny Rosen',
      api_error: null,
      process_payment_intent: { payment_intent: 'pi_stripe_1' },
    },
    device_sw_version: '2.30.0',
    device_type: 'simulated_wisepos_e',
    ip_address: '192.168.1.42',
    label: 'Front counter',
    last_seen_at: 1793750400,
    livemode: false,
    location: 'tml_stripe_1',
    metadata: {},
    serial_number: 'SN-1',
    status: 'online',
    ...overrides,
  } as unknown as Stripe.Terminal.Reader;
}

describe('Stripe Terminal mapping', () => {
  test('a reader crosses with its action as codes, never prose or its network address', () => {
    const mapped = toTerminalReader(reader());
    expect(mapped).toEqual({
      providerObjectId: 'tmr_stripe_1',
      label: 'Front counter',
      deviceType: 'simulated_wisepos_e',
      serialNumber: 'SN-1',
      status: 'online',
      lastSeenAt: new Date(1793750400 * 1000),
      locationObjectId: 'tml_stripe_1',
      action: {
        type: 'process_payment_intent',
        status: 'failed',
        paymentObjectId: 'pi_stripe_1',
        failureCode: 'card_declined',
      },
    });
    expect(JSON.stringify(mapped)).not.toContain('Jenny');
    expect(JSON.stringify(mapped)).not.toContain('192.168');
  });

  test('a failure code that is not a code is dropped; an action Orbit did not start is "other"', () => {
    const prose = toTerminalReader(
      reader({
        action: {
          type: 'process_payment_intent',
          status: 'failed',
          failure_code: 'The card was declined',
          failure_message: null,
          api_error: null,
          process_payment_intent: { payment_intent: { id: 'pi_stripe_2' } },
        },
      }),
    );
    expect(prose.action).toEqual({
      type: 'process_payment_intent',
      status: 'failed',
      paymentObjectId: 'pi_stripe_2',
      failureCode: null,
    });
    const display = toTerminalReader(
      reader({
        action: {
          type: 'set_reader_display',
          status: 'succeeded',
          failure_code: null,
          failure_message: null,
          api_error: null,
        },
      }),
    );
    expect(display.action).toEqual({
      type: 'other',
      status: 'succeeded',
      paymentObjectId: null,
      failureCode: null,
    });
    expect(toTerminalReader(reader({ action: null })).action).toBeNull();
  });

  test('a deleted reader reads as gone', () => {
    expect(
      toLiveTerminalReader({
        id: 'tmr_stripe_1',
        object: 'terminal.reader',
        deleted: true,
      } as unknown as Stripe.Terminal.DeletedReader),
    ).toBeNull();
    expect(toLiveTerminalReader(null)).toBeNull();
  });

  test('addresses round-trip without blank fields', () => {
    const wire = toAddress({
      line1: '1272 Valencia Street',
      line2: '',
      city: 'San Francisco',
      state: 'CA',
      postal_code: '94110',
      country: 'US',
    });
    expect(wire.line2).toBeNull();
    expect(toStripeAddress(wire)).toEqual({
      country: 'US',
      line1: '1272 Valencia Street',
      city: 'San Francisco',
      state: 'CA',
      postal_code: '94110',
    });
  });

  test('a reader event is keyed by the reader', () => {
    const ids = stripeObjectIds({
      id: 'evt_1',
      object: 'event',
      type: 'terminal.reader.action_succeeded',
      data: { object: reader() },
    } as unknown as Stripe.Event);
    expect(ids['terminal.reader']).toBe('tmr_stripe_1');
  });

  test('"Terminal is not enabled" and a permission refusal are recognised; a busy reader is not', () => {
    const notEnabled = new Stripe.errors.StripeInvalidRequestError({
      type: 'invalid_request_error',
      message: 'Your account has not been activated for Terminal yet.',
    });
    expect(isTerminalUnavailableError(notEnabled)).toBe(true);
    expect(
      isTerminalUnavailableError(
        new Stripe.errors.StripePermissionError({
          type: 'invalid_request_error',
          message: 'The provided key does not have the required permissions',
        }),
      ),
    ).toBe(true);
    expect(
      isTerminalUnavailableError(
        new Stripe.errors.StripeInvalidRequestError({
          type: 'invalid_request_error',
          code: 'terminal_reader_busy',
          message: 'Reader is currently busy processing another request.',
        }),
      ),
    ).toBe(false);
  });
});
