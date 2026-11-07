import { describe, expect, it } from 'bun:test';
import {
  CURRENCY_CODES,
  SIMULATED_READER_REGISTRATION_PREFIX,
  TERMINAL_LIMITS,
  TERMINAL_READER_ACTION_STATUSES,
  TERMINAL_READER_STATUSES,
  type TerminalReader,
} from '@peable.to/shared-types';
import { OrbitApiError } from '../api/transport';
import {
  actionPaymentIntent,
  addressLine,
  buildCollectBody,
  buildLocationBody,
  buildReaderBody,
  collectionOutcome,
  defaultCurrencyFor,
  EMPTY_LOCATION_FORM,
  EMPTY_READER_FORM,
  isCollecting,
  isTestMode,
  locationFormOf,
  ORBIT_READER_ACTION_STATUSES,
  ORBIT_READER_STATUSES,
  ORBIT_SIMULATED_CODES,
  ORBIT_SIMULATED_PREFIX,
  ORBIT_TERMINAL_LIMITS,
  outcomeTone,
  parseLabel,
  READER_CURRENCIES,
  readerLocationId,
  terminalRefusal,
} from './terminalForm';

describe('the restated value sets', () => {
  it('match shared-types', () => {
    expect([...ORBIT_READER_STATUSES]).toEqual([...TERMINAL_READER_STATUSES]);
    expect([...ORBIT_READER_ACTION_STATUSES]).toEqual([...TERMINAL_READER_ACTION_STATUSES]);
    expect(ORBIT_TERMINAL_LIMITS).toEqual(TERMINAL_LIMITS);
    expect(ORBIT_SIMULATED_PREFIX).toBe(SIMULATED_READER_REGISTRATION_PREFIX);
    for (const code of ORBIT_SIMULATED_CODES)
      expect(code.startsWith(ORBIT_SIMULATED_PREFIX)).toBe(true);
  });

  it('offers every fiat currency to a reader, and never FairCoin', () => {
    expect([...READER_CURRENCIES].sort()).toEqual(
      CURRENCY_CODES.filter((code) => code !== 'FAIR').sort(),
    );
  });
});

describe('buildLocationBody', () => {
  it('sends the trimmed name and only the address lines filled in, the country upper-cased', () => {
    expect(
      buildLocationBody({
        ...EMPTY_LOCATION_FORM,
        displayName: ' Front shop ',
        line1: ' 1 Main St ',
        city: 'Springfield',
        postalCode: ' 62701 ',
        country: 'us',
      }),
    ).toEqual({
      ok: true,
      body: {
        display_name: 'Front shop',
        address: { country: 'US', line1: '1 Main St', city: 'Springfield', postal_code: '62701' },
      },
    });
  });

  it('refuses what the gateway would refuse', () => {
    const named = { ...EMPTY_LOCATION_FORM, displayName: 'Shop', country: 'ES' };
    expect(buildLocationBody({ ...named, displayName: '  ' })).toEqual({
      ok: false,
      error: 'displayName',
    });
    expect(buildLocationBody({ ...named, displayName: 'x'.repeat(101) })).toEqual({
      ok: false,
      error: 'displayName',
    });
    expect(buildLocationBody({ ...named, country: 'ESP' })).toEqual({
      ok: false,
      error: 'country',
    });
    expect(buildLocationBody({ ...named, country: '' })).toEqual({ ok: false, error: 'country' });
    expect(buildLocationBody({ ...named, line1: 'x'.repeat(501) })).toEqual({
      ok: false,
      error: 'line',
    });
    expect(buildLocationBody({ ...named, postalCode: '1'.repeat(41) })).toEqual({
      ok: false,
      error: 'postalCode',
    });
  });

  it('starts an edit from the location and reads its address on one line', () => {
    const location = {
      id: 'tml_1',
      object: 'terminal.location' as const,
      livemode: false,
      display_name: 'Shop',
      address: {
        line1: '1 Main St',
        line2: null,
        city: 'Springfield',
        state: 'IL',
        postal_code: '62701',
        country: 'US',
      },
      metadata: {},
    };
    expect(locationFormOf(location)).toEqual({
      displayName: 'Shop',
      line1: '1 Main St',
      line2: '',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      country: 'US',
    });
    expect(buildLocationBody(locationFormOf(location))).toEqual({
      ok: true,
      body: {
        display_name: 'Shop',
        address: {
          country: 'US',
          line1: '1 Main St',
          city: 'Springfield',
          state: 'IL',
          postal_code: '62701',
        },
      },
    });
    expect(addressLine(location)).toBe('1 Main St, 62701 Springfield, IL, US');
  });
});

describe('buildReaderBody', () => {
  const form = { ...EMPTY_READER_FORM, registrationCode: ' simulated-wpe ', location: 'tml_1' };

  it('registers with the code, the location and an optional label', () => {
    expect(buildReaderBody(form, 'development')).toEqual({
      ok: true,
      body: { registration_code: 'simulated-wpe', location: 'tml_1' },
    });
    expect(
      buildReaderBody(
        { ...form, registrationCode: 'apple-banana-kiwi', label: ' Till 1 ' },
        'production',
      ),
    ).toEqual({
      ok: true,
      body: { registration_code: 'apple-banana-kiwi', location: 'tml_1', label: 'Till 1' },
    });
  });

  it('refuses a simulated code in live mode, a missing code or location, a long label', () => {
    expect(buildReaderBody(form, 'production')).toEqual({ ok: false, error: 'simulatedInLive' });
    expect(buildReaderBody({ ...form, registrationCode: ' ' }, 'development')).toEqual({
      ok: false,
      error: 'registrationCode',
    });
    expect(buildReaderBody({ ...form, location: '' }, 'development')).toEqual({
      ok: false,
      error: 'location',
    });
    expect(buildReaderBody({ ...form, label: 'x'.repeat(101) }, 'development')).toEqual({
      ok: false,
      error: 'label',
    });
  });

  it('parses a new label', () => {
    expect(parseLabel(' Till 2 ')).toBe('Till 2');
    expect(parseLabel('  ')).toBeNull();
    expect(parseLabel('x'.repeat(101))).toBeNull();
  });

  it('tells test mode from live', () => {
    expect(isTestMode('development')).toBe(true);
    expect(isTestMode('production')).toBe(false);
  });
});

describe('buildCollectBody', () => {
  const form = { amount: '12.50', currency: 'usd', description: '', manualCapture: false };

  it('converts the amount to base units exactly, by the currency', () => {
    expect(buildCollectBody(form)).toEqual({ ok: true, body: { amount: '1250', currency: 'USD' } });
    expect(buildCollectBody({ ...form, amount: '1500', currency: 'JPY' })).toEqual({
      ok: true,
      body: { amount: '1500', currency: 'JPY' },
    });
    expect(
      buildCollectBody({ ...form, description: ' Coffee ', manualCapture: true, amount: '0.05' }),
    ).toEqual({
      ok: true,
      body: { amount: '5', currency: 'USD', description: 'Coffee', capture_method: 'manual' },
    });
  });

  it('refuses FairCoin, a zero or over-precise amount, a long description', () => {
    expect(buildCollectBody({ ...form, currency: 'FAIR' })).toEqual({
      ok: false,
      error: 'currency',
    });
    expect(buildCollectBody({ ...form, amount: '0' })).toEqual({ ok: false, error: 'amount' });
    expect(buildCollectBody({ ...form, amount: '1.005' })).toEqual({
      ok: false,
      error: 'amount',
    });
    expect(buildCollectBody({ ...form, amount: '12.5', currency: 'JPY' })).toEqual({
      ok: false,
      error: 'amount',
    });
    expect(buildCollectBody({ ...form, description: 'x'.repeat(501) })).toEqual({
      ok: false,
      error: 'description',
    });
  });

  it('suggests the location country’s currency', () => {
    expect(defaultCurrencyFor('US')).toBe('USD');
    expect(defaultCurrencyFor('gb')).toBe('GBP');
    expect(defaultCurrencyFor('ES')).toBe('EUR');
    expect(defaultCurrencyFor(null)).toBe('EUR');
  });
});

type Action = NonNullable<TerminalReader['action']>;
const action = (overrides: Partial<Action> = {}): Pick<TerminalReader, 'action'> => ({
  action: {
    type: 'process_payment_intent',
    status: 'in_progress',
    failure_code: null,
    failure_message: null,
    process_payment_intent: {
      payment_intent: 'pi_1',
      process_config: { enable_customer_cancellation: false, skip_tipping: true },
    },
    ...overrides,
  },
});
const declined = {
  status: 'requires_payment_method' as const,
  last_payment_error: { code: 'card_declined', message: 'The card was declined.' },
} as never;

describe('collectionOutcome', () => {
  it('follows the reader while it collects', () => {
    expect(collectionOutcome({ action: null }, undefined)).toEqual({ kind: 'none' });
    expect(collectionOutcome(action(), undefined)).toEqual({ kind: 'collecting' });
    expect(isCollecting(action())).toBe(true);
    expect(isCollecting({ action: null })).toBe(false);
    expect(actionPaymentIntent(action())).toBe('pi_1');
    expect(actionPaymentIntent({ action: null })).toBeNull();
  });

  it('reads the payment once the reader is done', () => {
    const done = action({ status: 'succeeded' });
    expect(collectionOutcome(done, undefined)).toEqual({ kind: 'settling' });
    expect(collectionOutcome(done, { status: 'processing', last_payment_error: null })).toEqual({
      kind: 'settling',
    });
    expect(collectionOutcome(done, { status: 'succeeded', last_payment_error: null })).toEqual({
      kind: 'succeeded',
    });
    expect(
      collectionOutcome(done, { status: 'requires_capture', last_payment_error: null }),
    ).toEqual({ kind: 'authorized' });
    expect(collectionOutcome(done, { status: 'canceled', last_payment_error: null })).toEqual({
      kind: 'canceled',
    });
    expect(collectionOutcome(done, declined)).toEqual({
      kind: 'declined',
      message: 'The card was declined.',
    });
  });

  it('says why a failed collection collected nothing', () => {
    expect(
      collectionOutcome(
        action({
          status: 'failed',
          failure_code: 'card_declined',
          failure_message: 'The card was declined.',
        }),
        { status: 'requires_payment_method', last_payment_error: null },
      ),
    ).toEqual({ kind: 'declined', message: 'The card was declined.' });
    expect(collectionOutcome(action({ status: 'failed' }), declined)).toEqual({
      kind: 'declined',
      message: 'The card was declined.',
    });
    expect(
      collectionOutcome(action({ status: 'failed', failure_code: 'customer_canceled' }), undefined),
    ).toEqual({ kind: 'stopped' });
    expect(
      collectionOutcome(
        action({
          status: 'failed',
          failure_code: 'reader_timeout',
          failure_message: 'The reader did not answer in time.',
        }),
        undefined,
      ),
    ).toEqual({ kind: 'failed', message: 'The reader did not answer in time.' });
  });

  it('gives each outcome a tone', () => {
    expect(outcomeTone({ kind: 'succeeded' })).toBe('success');
    expect(outcomeTone({ kind: 'collecting' })).toBe('info');
    expect(outcomeTone({ kind: 'declined', message: null })).toBe('danger');
    expect(outcomeTone({ kind: 'stopped' })).toBe('warning');
  });

  it('reads a reader’s location id, expanded or not', () => {
    expect(readerLocationId({ location: 'tml_1' })).toBe('tml_1');
    expect(readerLocationId({ location: null })).toBeNull();
  });
});

describe('terminalRefusal', () => {
  const refusal = (status: number, code?: string, param?: string) =>
    new OrbitApiError({
      status,
      type: 'invalid_request_error',
      message: 'm',
      ...(code ? { code } : {}),
      ...(param ? { param } : {}),
    });
  it('names each Terminal refusal and nothing else', () => {
    expect(terminalRefusal(refusal(503, 'terminal_unavailable'))).toBe('unavailable');
    expect(terminalRefusal(refusal(409, 'terminal_location_in_use'))).toBe('locationInUse');
    expect(terminalRefusal(refusal(409, 'terminal_reader_busy'))).toBe('readerBusy');
    expect(terminalRefusal(refusal(409, 'terminal_reader_offline'))).toBe('readerOffline');
    expect(terminalRefusal(refusal(403, 'live_payments_gated'))).toBe('liveGated');
    expect(terminalRefusal(refusal(403, 'test_mode_only'))).toBe('testOnly');
    expect(terminalRefusal(refusal(400, 'parameter_invalid', 'registration_code'))).toBe(
      'registrationCode',
    );
    expect(terminalRefusal(refusal(400, 'parameter_invalid', 'amount'))).toBeNull();
    expect(terminalRefusal(new Error('x'))).toBeNull();
  });
});
