/**
 * Pure, DOM-free coverage for `browser/mount.ts` (Fase 2 SDK plan, Task 6):
 * intent-id derivation/validation, the `peable://pay` deep-link builder, the
 * mobile/desktop heuristic, and the typed event emitter. `PeableCheckout.mount`
 * itself touches `document`/`window`/`navigator` and is verified in a real
 * foregrounded browser tab instead (Step 3, deferred — see the Task 6 report),
 * per this repo's AGENTS.md rule that headless runners can't catch DOM/timer
 * issues.
 */
import { describe, expect, test } from 'bun:test';
import type { PaymentIntent } from '@peable.to/shared-types';
import { getNetwork, validateAddress } from '@fairco.in/core';
import {
  buildPayDeepLink,
  payDeepLinkFor,
  PeableRailUnsupportedError,
  createEmitter,
  deriveIntentId,
  isMobileUserAgent,
  type PayDeepLinkParams,
} from '../../src/browser/mount';
import { PeableInvalidRequestError, PeableApiError, PeableError } from '../../src/core/errors';
// The wallet's REAL deep-link parser — imported directly (not re-implemented)
// so the round-trip test below proves byte-for-byte compatibility instead of
// just asserting against my own possibly-mistaken re-reading of its contract.
import { parsePaymentRequest } from '../../../frontend/src/pay/payment-request';

const ADDR = 'FAHUJmcTfwvRYCcDXAzsu7YRiittDC8Jek';
// Same fixture + same network-detection idiom as the wallet's own
// `payment-request.test.ts` — `parsePaymentRequest` validates `address`
// against `network`, so which chain this address is actually valid on must
// be detected rather than assumed.
const NET = validateAddress(ADDR, getNetwork('mainnet')) ? 'mainnet' : 'testnet';

const INTENT: PaymentIntent = {
  id: 'pi_0123456789abcdef01234567',
  object: 'payment_intent',
  status: 'created',
  rail: 'faircoin',
  amount: '150000000',
  currency: 'FAIR',
  network: NET,
  address: ADDR,
  merchantId: 'merch_1',
  txid: null,
  confirmations: 0,
  clientSecret: 'pi_0123456789abcdef01234567_secret_00112233445566778899aabbccddeeff',
  metadata: {},
  expiresAt: '2026-07-20T00:00:00.000Z',
  createdAt: '2026-07-19T00:00:00.000Z',
  updatedAt: '2026-07-19T00:00:00.000Z',
};

describe('deriveIntentId', () => {
  const ID = 'pi_0123456789abcdef01234567';
  const SECRET = `${ID}_secret_00112233445566778899aabbccddeeff`;

  test('derives the id from clientSecret when intentId is omitted', () => {
    expect(deriveIntentId(SECRET)).toBe(ID);
  });

  test('accepts an explicit intentId that matches the clientSecret', () => {
    expect(deriveIntentId(SECRET, ID)).toBe(ID);
  });

  test('throws PeableInvalidRequestError when clientSecret has no derivable pi_ id', () => {
    expect(() => deriveIntentId('not-a-real-secret')).toThrow(PeableInvalidRequestError);
  });

  test('throws when an explicit intentId does not match the pi_ id shape', () => {
    expect(() => deriveIntentId(SECRET, 'merch_notapaymentintent')).toThrow(
      PeableInvalidRequestError,
    );
  });

  test('throws when clientSecret does not belong to the given/derived intentId', () => {
    const otherId = 'pi_ffffffffffffffffffffffff';
    expect(() => deriveIntentId(SECRET, otherId)).toThrow(PeableInvalidRequestError);
  });

  test('throws for an empty clientSecret', () => {
    expect(() => deriveIntentId('')).toThrow(PeableInvalidRequestError);
  });
});

describe('buildPayDeepLink', () => {
  const ID = 'pi_0123456789abcdef01234567';
  const SECRET = `${ID}_secret_00112233445566778899aabbccddeeff`;

  const PARAMS: PayDeepLinkParams = {
    intentId: ID,
    clientSecret: SECRET,
    address: ADDR,
    amount: '150000000',
    network: NET,
  };

  test('produces the exact peable://pay param contract', () => {
    const link = buildPayDeepLink(PARAMS);
    expect(link).toBe(
      `peable://pay?intent=${ID}&secret=${SECRET}&address=${ADDR}&amount=150000000&network=${NET}`,
    );
  });

  test("round-trips through the wallet's real parsePaymentRequest byte-for-byte", () => {
    const link = buildPayDeepLink(PARAMS);
    const parsed = parsePaymentRequest(link);

    expect(parsed).not.toBeNull();
    expect(parsed?.intentId).toBe(PARAMS.intentId);
    expect(parsed?.clientSecret).toBe(PARAMS.clientSecret);
    expect(parsed?.address).toBe(PARAMS.address);
    expect(parsed?.amount).toBe(BigInt(PARAMS.amount));
    expect(parsed?.network).toBe(PARAMS.network);
  });

  test('percent-encodes values and still round-trips (raw decodeURIComponent, not form-urlencoded)', () => {
    // A crafted address containing '&' and '=' would break naive query
    // concatenation; encodeURIComponent must escape it and the wallet's
    // decodeURIComponent-based parser must recover it exactly.
    const trickyAddress = `${ADDR}&evil=1`;
    const link = buildPayDeepLink({ ...PARAMS, address: trickyAddress });

    // The wallet's parser rejects this address as invalid FairCoin address
    // shape (expected — it's not a real address), but MUST still decode the
    // `address` field back to the exact original string rather than letting
    // the embedded '&'/'=' fragment a different param — prove that via the
    // raw query split, the same way `parsePaymentRequest`'s `parseQuery` does.
    const query = link.slice(link.indexOf('?') + 1);
    const rawAddressPair = query.split('&').find((pair) => pair.startsWith('address='));
    expect(rawAddressPair).toBeDefined();
    const decoded = decodeURIComponent((rawAddressPair ?? '').slice('address='.length));
    expect(decoded).toBe(trickyAddress);
  });
});

describe('isMobileUserAgent', () => {
  test.each([
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8)',
    'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',
    'Mozilla/5.0 (iPod touch; CPU iPhone OS 17_0 like Mac OS X)',
  ])('recognizes a mobile user agent: %s', (ua) => {
    expect(isMobileUserAgent(ua)).toBe(true);
  });

  test.each([
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  ])('does not flag a desktop user agent: %s', (ua) => {
    expect(isMobileUserAgent(ua)).toBe(false);
  });
});

describe('createEmitter', () => {
  test('invokes a registered handler with the emitted payload', () => {
    const emitter = createEmitter();
    const received: PaymentIntent[] = [];
    emitter.on('settled', (intent) => received.push(intent));

    emitter.emit('settled', INTENT);

    expect(received).toEqual([INTENT]);
  });

  test('multiple handlers on the same event all fire', () => {
    const emitter = createEmitter();
    let calls = 0;
    emitter.on('confirming', () => {
      calls += 1;
    });
    emitter.on('confirming', () => {
      calls += 1;
    });

    emitter.emit('confirming', INTENT);

    expect(calls).toBe(2);
  });

  test('a handler registered for a different event never fires', () => {
    const emitter = createEmitter();
    let settledCalls = 0;
    let failedCalls = 0;
    emitter.on('settled', () => {
      settledCalls += 1;
    });
    emitter.on('failed', () => {
      failedCalls += 1;
    });

    emitter.emit('settled', INTENT);

    expect(settledCalls).toBe(1);
    expect(failedCalls).toBe(0);
  });

  test('emitting an event with no registered handlers does not throw', () => {
    const emitter = createEmitter();
    expect(() => emitter.emit('error', new PeableApiError('boom'))).not.toThrow();
  });

  test('removeAll tears down every handler for every event', () => {
    const emitter = createEmitter();
    let calls = 0;
    emitter.on('settled', () => {
      calls += 1;
    });
    emitter.on('error', () => {
      calls += 1;
    });

    emitter.removeAll();
    emitter.emit('settled', INTENT);
    emitter.emit('error', new PeableError('api_error', 'boom'));

    expect(calls).toBe(0);
  });
});

describe('payDeepLinkFor', () => {
  /**
   * The narrowing that stops an empty address reaching the wallet.
   *
   * `address` and `network` became nullable with the card rail (gateway ADR
   * 0001 D6). The tempting fix at the call site was `?? ''`, which mints
   * `peable://pay?...&address=&network=` — structurally a valid link, and one
   * that sends a payer nowhere. These two cases are what make that impossible.
   */
  test('refuses an intent that is not a chain payment', () => {
    const card = {
      ...INTENT,
      rail: 'card',
      currency: 'EUR',
      address: null,
      network: null,
    } as unknown as PaymentIntent;

    expect(() => payDeepLinkFor(card)).toThrow(PeableRailUnsupportedError);
  });

  test('builds the same link as buildPayDeepLink for a faircoin intent', () => {
    expect(payDeepLinkFor(INTENT)).toBe(
      buildPayDeepLink({
        intentId: INTENT.id,
        clientSecret: INTENT.clientSecret,
        address: INTENT.address as string,
        amount: INTENT.amount,
        network: INTENT.network as NonNullable<PaymentIntent['network']>,
      }),
    );
  });

  /** A faircoin intent whose chain fields somehow went missing is refused too —
   *  the rail label alone is not the guarantee, the fields are. */
  test('refuses a faircoin intent with no address', () => {
    const broken = { ...INTENT, address: null } as unknown as PaymentIntent;
    expect(() => payDeepLinkFor(broken)).toThrow(PeableRailUnsupportedError);
  });
});
