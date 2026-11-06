import { describe, expect, test } from 'bun:test';
import type { CheckoutSessionPublic, PaymentIntent } from '@peable.to/shared-types';
import {
  baseUnits,
  billingAddressParams,
  faircoinRefusal,
  faircoinTransferState,
  hostedUrlFor,
  intentRequest,
  intentSettlement,
  intentSource,
  isFaircoinPayment,
  matchesExpectation,
  needsBillingLocation,
  paymentInFlight,
  sessionCollection,
  sessionFaircoin,
  sessionRequest,
  sessionSettlement,
  sessionSource,
  sheetSourceFromUrl,
  shippingDetailsParams,
  type FaircoinPaymentIntent,
} from '../../src/ui/sheetCheckout';
import { formatCheckoutAmount, formatFairAmount } from '../../src/ui/amount';
import { publicSessionFixture } from '../support/checkoutFixture';
import {
  cardIntentFixture,
  paymentIntentFixture,
  processingFixture,
} from '../support/intentFixture';

const SESSION_ID = 'cs_0123456789abcdef01234567';
const SESSION_SECRET = `${SESSION_ID}_secret_0123456789abcdef`;
const INTENT_ID = 'pi_0123456789abcdef01234567';
const INTENT_SECRET = `${INTENT_ID}_secret_0123456789abcdef`;

function session(overrides: Partial<CheckoutSessionPublic> = {}): CheckoutSessionPublic {
  return { ...publicSessionFixture, ...overrides };
}

function faircoinIntent(overrides: Partial<PaymentIntent> = {}): FaircoinPaymentIntent {
  const intent = paymentIntentFixture(overrides);
  if (!isFaircoinPayment(intent)) throw new Error('fixture is not a FairCoin payment');
  return intent;
}

const quote = {
  currency: 'EUR' as const,
  amount: '2700',
  rate: '0.05',
  price: { source: 'wfair-base' as const, usd_per_fair: '0.054', observed_at: 1_000 },
  reference_rates: null,
  quoted_at: 1_000,
  expires_at: 1_600,
};

describe('sources', () => {
  test('a session source comes from its secret alone', () => {
    expect(sessionSource(SESSION_SECRET)).toEqual({
      type: 'checkout_session',
      id: SESSION_ID,
      clientSecret: SESSION_SECRET,
    });
    expect(sessionSource('cs_short_secret_x')).toBeNull();
  });

  test('an intent source refuses a secret that is not the intent’s', () => {
    expect(intentSource(INTENT_ID, INTENT_SECRET)?.type).toBe('payment_intent');
    expect(
      intentSource(INTENT_ID, 'pi_ffffffffffffffffffffffff_secret_0123456789abcdef'),
    ).toBeNull();
    expect(intentSource('pi_nothex', INTENT_SECRET)).toBeNull();
  });

  test('a hosted URL round-trips, and only on the checkout origin with a matching secret', () => {
    for (const source of [
      { type: 'checkout_session' as const, id: SESSION_ID, clientSecret: SESSION_SECRET },
      { type: 'payment_intent' as const, id: INTENT_ID, clientSecret: INTENT_SECRET },
    ]) {
      const url = hostedUrlFor(source);
      expect(url.startsWith('https://checkout.peable.to/')).toBe(true);
      expect(sheetSourceFromUrl(url)).toEqual(source);
    }
    expect(
      sheetSourceFromUrl(`https://evil.example/c/${SESSION_ID}#cs=${SESSION_SECRET}`),
    ).toBeNull();
    expect(
      sheetSourceFromUrl(
        `https://checkout.peable.to/c/cs_ffffffffffffffffffffffff#cs=${SESSION_SECRET}`,
      ),
    ).toBeNull();
    expect(
      sheetSourceFromUrl(`https://checkout.peable.to/c/${SESSION_ID}?cs=${SESSION_SECRET}`),
    ).toBeNull();
    expect(sheetSourceFromUrl('not a url')).toBeNull();
    expect(
      sheetSourceFromUrl(
        `http://localhost:5173/c/${SESSION_ID}#cs=${SESSION_SECRET}`,
        'http://localhost:5173',
      )?.id,
    ).toBe(SESSION_ID);
  });
});

describe('amounts', () => {
  test('a base-unit string is a safe integer or nothing', () => {
    expect(baseUnits('2700')).toBe(2700);
    expect(baseUnits('0')).toBe(0);
    expect(baseUnits('027')).toBeNull();
    expect(baseUnits('1.5')).toBeNull();
    expect(baseUnits('99999999999999999999')).toBeNull();
  });

  test('FAIR is formatted exactly from its base units', () => {
    expect(formatFairAmount('150000000', 'en')).toBe('1.5 FAIR');
    expect(formatFairAmount('100000000', 'en')).toBe('1 FAIR');
    expect(formatFairAmount('1', 'en')).toBe('0.00000001 FAIR');
    expect(formatFairAmount('123456789000', 'es')).toBe('1234,56789 FAIR');
    expect(formatCheckoutAmount(150_000_000, 'FAIR', 'en')).toBe('1.5 FAIR');
    expect(() => formatFairAmount('-1', 'en')).toThrow();
  });

  test('the reviewed order must be the order', () => {
    const order = { amount: '2700', currency: 'eur', livemode: false };
    expect(matchesExpectation(order, undefined)).toBe(true);
    expect(matchesExpectation(order, { amount: '2700', currency: 'EUR' })).toBe(true);
    expect(matchesExpectation(order, { amount: '2700', currency: 'EUR', livemode: true })).toBe(
      false,
    );
    expect(matchesExpectation(order, { amount: '2701', currency: 'EUR' })).toBe(false);
    expect(matchesExpectation(order, { amount: '2700', currency: 'USD' })).toBe(false);
  });
});

describe('what a session asks for', () => {
  test('a plan or a digital order never asks for a shipping address', () => {
    const collection = sessionCollection(
      session({ customer_details: { ...publicSessionFixture.customer_details, email: 'a@b.co' } }),
    );
    expect(collection).toEqual({
      contact: false,
      shipping: false,
      billingAddress: false,
      unsupported: null,
    });
    expect(sessionRequest(session(), ['card']).requiresShipping).toBe(false);
  });

  test('a shipping address only when the session collects one', () => {
    const shipped = session({ shipping_address_collection: { allowed_countries: ['ES'] } });
    expect(sessionCollection(shipped).shipping).toBe(true);
    expect(sessionRequest(shipped, ['card']).requiresShipping).toBe(true);
  });

  test('an email only when the session has none', () => {
    expect(sessionCollection(session()).contact).toBe(true);
    expect(sessionCollection(session({ contact_collection: 'merchant_account' })).contact).toBe(
      false,
    );
    expect(
      sessionCollection(
        session({ contact_collection: 'merchant_account', billing_address_collection: 'required' }),
      ).billingAddress,
    ).toBe(true);
    expect(sessionRequest(session(), []).requiresContact).toBe(true);
  });

  test('a billing location when tax or the merchant needs one, until it is recorded', () => {
    const taxed = session({ automatic_tax: { enabled: true, status: 'requires_location_inputs' } });
    expect(sessionCollection(taxed).billingAddress).toBe(true);
    expect(needsBillingLocation(taxed)).toBe(true);
    expect(
      needsBillingLocation({
        ...taxed,
        customer_details: {
          ...taxed.customer_details,
          address: {
            line1: null,
            line2: null,
            city: null,
            state: null,
            postal_code: null,
            country: 'ES',
          },
        },
      }),
    ).toBe(false);
    expect(needsBillingLocation(session({ billing_address_collection: 'required' }))).toBe(true);
    expect(needsBillingLocation(session())).toBe(false);
  });

  test('what only the hosted page collects is named, not guessed', () => {
    expect(sessionCollection(session({ mode: 'setup' })).unsupported).toBe('setup');
    expect(
      sessionCollection(session({ phone_number_collection: { enabled: true } })).unsupported,
    ).toBe('phone');
    expect(sessionCollection(session({ tax_id_collection: { enabled: true } })).unsupported).toBe(
      'tax_id',
    );
    expect(
      sessionCollection(session({ consent_collection: { terms_of_service: 'required' } }))
        .unsupported,
    ).toBe('terms');
  });

  test('a discounted order with exclusive tax is not read as tax-inclusive', () => {
    const request = sessionRequest(
      session({
        automatic_tax: { enabled: true, status: 'complete' },
        amount_subtotal: '3000',
        amount_total: '2970',
        total_details: { amount_discount: '300', amount_tax: '270', amount_shipping: '0' },
      }),
      ['card'],
    );
    expect(request.tax?.inclusive).toBe(false);
  });

  test('the request carries the gateway’s amounts and tax as priced', () => {
    const taxed = session({
      automatic_tax: { enabled: true, status: 'complete' },
      amount_subtotal: '3000',
      amount_total: '3630',
      total_details: { amount_discount: '0', amount_tax: '630', amount_shipping: '0' },
    });
    const request = sessionRequest(taxed, ['card', 'faircoin'], {
      merchant: 'Mention',
      recurring: { interval: 'month' },
      itemDetail: () => 'Monthly',
    });
    expect(request.merchant).toBe('Mention');
    expect(request.currency).toBe('EUR');
    expect(request.dueTodayMinorUnits).toBe(3630);
    expect(request.tax).toEqual({
      subtotalMinorUnits: 3000,
      taxMinorUnits: 630,
      totalMinorUnits: 3630,
      inclusive: false,
    });
    expect(request.recurring).toEqual({ amountMinorUnits: 3630, interval: 'month' });
    expect(request.items[0]?.detail).toBe('Monthly');
    expect(request.paymentMethods).toEqual(['card', 'faircoin']);
  });
});

describe('FairCoin', () => {
  test('always listed: available, or disabled with the gateway’s reason', () => {
    expect(sessionFaircoin(session())).toEqual({ available: true });
    expect(
      sessionFaircoin(
        session({
          faircoin: { available: false, unavailable_reason: 'faircoin_wallet_missing' },
        }),
      ),
    ).toEqual({ available: false, reason: 'faircoin_wallet_missing' });
    expect(sessionFaircoin(session({ mode: 'setup', faircoin: null }))).toEqual({
      available: false,
      reason: 'not_offered',
    });
  });

  test('a refusal code is the reason the payer reads', () => {
    expect(faircoinRefusal('faircoin_price_unavailable')).toBe('price_unavailable');
    expect(faircoinRefusal('faircoin_wallet_missing')).toBe('faircoin_wallet_missing');
    expect(faircoinRefusal('parameter_missing')).toBeNull();
    expect(faircoinRefusal(undefined)).toBeNull();
  });

  test('the transfer state follows the payment, and a lapsed quote is expired', () => {
    const base = faircoinIntent();
    const quoted = faircoinIntent({ faircoin: { ...base.faircoin, quote } });
    expect(faircoinTransferState(quoted, 1_000)).toBe('awaiting');
    expect(faircoinTransferState(quoted, 1_600)).toBe('expired');
    const processing = processingFixture();
    if (!isFaircoinPayment(processing)) throw new Error('fixture');
    expect(faircoinTransferState(processing, 0)).toBe('detected');
    expect(
      faircoinTransferState(
        { ...processing, faircoin: { ...processing.faircoin, confirmations: 1 } },
        0,
      ),
    ).toBe('processing');
    expect(faircoinTransferState(faircoinIntent({ status: 'succeeded' }), 0)).toBe('succeeded');
    expect(
      faircoinTransferState(
        faircoinIntent({ status: 'canceled', cancellation_reason: 'abandoned' }),
        0,
      ),
    ).toBe('expired');
    // Retired because the recipient's key was replaced (ADR 0002): the order
    // takes a fresh request, exactly as after a lapsed one.
    expect(
      faircoinTransferState(
        faircoinIntent({ status: 'canceled', cancellation_reason: 'recipient_key_changed' }),
        0,
      ),
    ).toBe('expired');
    expect(
      faircoinTransferState(
        faircoinIntent({ status: 'canceled', cancellation_reason: 'underpaid' }),
        0,
      ),
    ).toBe('failure');
  });

  test('a card intent is not a FairCoin payment', () => {
    expect(isFaircoinPayment(cardIntentFixture())).toBe(false);
    expect(isFaircoinPayment(null)).toBe(false);
  });
});

describe('settlement', () => {
  test('a session settles when the gateway closes it', () => {
    expect(sessionSettlement(session())).toBeNull();
    expect(sessionSettlement(session({ status: 'complete' }))).toBe('complete');
    expect(sessionSettlement(session({ status: 'expired' }))).toBe('expired');
  });

  test('a single payment settles at its terminal status', () => {
    expect(intentSettlement(cardIntentFixture())).toBeNull();
    expect(intentSettlement(cardIntentFixture({ status: 'succeeded' }))).toBe('complete');
    expect(intentSettlement(cardIntentFixture({ status: 'canceled' }))).toBe('expired');
  });

  test('a payment moving money cannot change method', () => {
    expect(paymentInFlight(null)).toBe(false);
    expect(paymentInFlight(paymentIntentFixture())).toBe(false);
    expect(paymentInFlight(processingFixture())).toBe(true);
    expect(paymentInFlight(cardIntentFixture({ status: 'requires_capture' }))).toBe(true);
  });

  test('a FairCoin payment of a fiat order is shown in the order’s currency', () => {
    const base = faircoinIntent();
    const request = intentRequest(
      faircoinIntent({ faircoin: { ...base.faircoin, quote } }),
      { merchant: 'Seller', items: [] },
      ['faircoin'],
    );
    expect(request.currency).toBe('EUR');
    expect(request.dueTodayMinorUnits).toBe(2700);
    expect(request.requiresShipping).toBe(false);
  });
});

describe('shipping details', () => {
  test('complete fields become the gateway’s shipping_details; anything missing is null', () => {
    expect(
      shippingDetailsParams({
        name: ' Ada ',
        address: 'Calle 1',
        city: 'Madrid',
        postalCode: '28001',
        country: 'es',
      }),
    ).toEqual({
      name: 'Ada',
      address: { line1: 'Calle 1', city: 'Madrid', postal_code: '28001', country: 'ES' },
    });
    expect(
      shippingDetailsParams({
        name: 'Ada',
        address: '',
        city: 'Madrid',
        postalCode: '28001',
        country: 'ES',
      }),
    ).toBeNull();
    expect(
      shippingDetailsParams({
        name: 'Ada',
        address: 'Calle 1',
        city: 'Madrid',
        postalCode: '28001',
        country: 'Spain',
      }),
    ).toBeNull();
  });
});

test('US and Canadian tax billing retains the explicitly supplied region and requires it', () => {
  for (const country of ['US', 'CA']) {
    const taxed = session({ automatic_tax: { enabled: true, status: 'requires_location_inputs' } });
    const address = {
      line1: null,
      line2: null,
      city: null,
      country,
      state: null,
      postal_code: '19802',
    };
    expect(
      needsBillingLocation({ ...taxed, customer_details: { ...taxed.customer_details, address } }),
    ).toBe(true);
    expect(
      needsBillingLocation({
        ...taxed,
        customer_details: {
          ...taxed.customer_details,
          address: { ...address, state: country === 'US' ? 'DE' : 'ON' },
        },
      }),
    ).toBe(false);
    expect(
      needsBillingLocation({
        ...taxed,
        customer_details: {
          ...taxed.customer_details,
          address: { ...address, state: country === 'US' ? 'DE' : 'ON', postal_code: '' },
        },
      }),
    ).toBe(true);
  }
  expect(billingAddressParams({ country: ' us ', postcode: ' 19802 ', state: ' de ' })).toEqual({
    country: 'US',
    postal_code: '19802',
    state: 'DE',
  });
  expect(billingAddressParams({ country: 'US', postcode: '19802' })).toEqual({
    country: 'US',
    postal_code: '19802',
  });
});
