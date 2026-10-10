/**
 * `resolveRail` — the one owner of "is this combination a payment at all".
 *
 * Three callers depend on it agreeing with itself: `createIntent`, the
 * payment-link route and the checkout-session route. A link that stored a
 * combination `createIntent` would later refuse is a price a payer can see and
 * can never pay, and the two rows live in different tables, so no constraint
 * spans them. That is what these cases are protecting.
 */
import { describe, expect, test } from 'bun:test';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { NetworkMismatchError, RailMismatchError, resolveRail } from '../createIntent';

const MERCHANT = { id: 'm_1', network: 'testnet' } as unknown as MerchantRow;

describe('resolveRail', () => {
  test('defaults to the faircoin rail, so a pre-rail caller is unchanged', () => {
    expect(resolveRail(MERCHANT, { network: 'testnet' })).toEqual({
      rail: 'faircoin',
      currency: 'FAIR',
      network: 'testnet',
    });
  });

  test('a card intent keeps its fiat currency and carries no network', () => {
    expect(resolveRail(MERCHANT, { rail: 'card', currency: 'EUR' })).toEqual({
      rail: 'card',
      currency: 'EUR',
      network: null,
    });
  });

  test('the card rail requires an explicit currency', () => {
    expect(() => resolveRail(MERCHANT, { rail: 'card' })).toThrow(RailMismatchError);
  });

  test('the card rail cannot settle in FAIR', () => {
    expect(() => resolveRail(MERCHANT, { rail: 'card', currency: 'FAIR' })).toThrow(
      RailMismatchError,
    );
  });

  /**
   * The direction that would otherwise look harmless. A EUR-denominated chain
   * payment needs an FX conversion at settlement time that nothing performs, so
   * the amount stored would be in a unit the arriving coins are not counted in.
   */
  test('the faircoin rail cannot settle in a fiat currency', () => {
    expect(() =>
      resolveRail(MERCHANT, { rail: 'faircoin', currency: 'EUR', network: 'testnet' }),
    ).toThrow(RailMismatchError);
  });

  test('the faircoin rail requires a network', () => {
    expect(() => resolveRail(MERCHANT, { rail: 'faircoin' })).toThrow(RailMismatchError);
  });

  /**
   * Not pedantry: a card intent carrying a network makes the composite
   * reference to `merchants (id, network)` BIND, which ties a card charge to a
   * chain. Refusing here is a 422; letting it through is a constraint violation
   * surfacing as a 500.
   */
  test('the card rail refuses a network rather than ignoring it', () => {
    expect(() =>
      resolveRail(MERCHANT, { rail: 'card', currency: 'EUR', network: 'testnet' }),
    ).toThrow(RailMismatchError);
  });

  /** The network firewall, unchanged by the rail work. */
  test('a faircoin caller naming the wrong chain gets the network error, not the rail one', () => {
    expect(() => resolveRail(MERCHANT, { network: 'mainnet' })).toThrow(NetworkMismatchError);
  });
});
