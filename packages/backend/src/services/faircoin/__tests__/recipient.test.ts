/**
 * Who receives FairCoin and whether they can (ADR 0021 D5): the owning
 * account's Peable wallet, ADR 0002's network gate, and every reason FairCoin
 * says it cannot be paid with — never hidden.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { config } from '../../../config';
import { useIdentityKeyResolver } from '../../socialReceive';
import { useQuoteSources } from '../quote';
import { faircoinAvailability, faircoinNetworkOf, faircoinRecipientOf } from '../recipient';

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

describe('the recipient', () => {
  test("the merchant's owner, or the seller's own account", () => {
    expect(faircoinRecipientOf({ ownerAccountId: 'acct_owner' })).toBe('acct_owner');
    expect(
      faircoinRecipientOf({ ownerAccountId: 'acct_owner' }, { faircoinOxyUserId: 'user_s' }),
    ).toBe('user_s');
    expect(faircoinRecipientOf({ ownerAccountId: null })).toBeNull();
  });

  test("a merchant's network is its environment's", () => {
    expect(faircoinNetworkOf({ network: null, environment: 'production' })).toBe('mainnet');
    expect(faircoinNetworkOf({ network: null, environment: 'development' })).toBe('testnet');
    expect(faircoinNetworkOf({ network: 'testnet', environment: 'production' })).toBe('testnet');
  });
});

describe('availability', () => {
  test('ready: a wallet, an open network, a fresh price', async () => {
    expect(
      await faircoinAvailability({
        network: 'testnet',
        currency: 'EUR',
        recipientAccountId: 'acct_a',
      }),
    ).toEqual({ available: true, unavailable_reason: null });
  });

  test("no wallet — a keyless account, or an owner not seen yet — is 'faircoin_wallet_missing'", async () => {
    for (const recipientAccountId of ['keyless_org', null]) {
      expect(
        await faircoinAvailability({ network: 'testnet', currency: 'FAIR', recipientAccountId }),
      ).toEqual({ available: false, unavailable_reason: 'faircoin_wallet_missing' });
    }
  });

  test("mainnet waits for the deployment's gate (ADR 0002)", async () => {
    expect(config.socialPayNetwork).toBe('testnet');
    expect(
      await faircoinAvailability({
        network: 'mainnet',
        currency: 'FAIR',
        recipientAccountId: 'acct_a',
      }),
    ).toEqual({ available: false, unavailable_reason: 'faircoin_network_closed' });
  });

  test("Oxy unreachable is said as such, not as 'no wallet'", async () => {
    const previous = useIdentityKeyResolver(async () => {
      throw new Error('ECONNREFUSED');
    });
    restores.push(() => useIdentityKeyResolver(previous));
    expect(
      await faircoinAvailability({
        network: 'testnet',
        currency: 'FAIR',
        recipientAccountId: 'acct_b',
      }),
    ).toEqual({ available: false, unavailable_reason: 'temporarily_unavailable' });
  });

  test("a fiat order with no fresh price is 'price_unavailable'", async () => {
    restores.push(
      useQuoteSources({
        readPrice: async () => {
          throw new Error('down');
        },
        readReferenceRates: async () => ({
          perEur: { EUR: '1', USD: '1.25' },
          observedAt: new Date(),
        }),
      }),
    );
    expect(
      await faircoinAvailability({
        network: 'testnet',
        currency: 'USD',
        recipientAccountId: 'acct_c',
      }),
    ).toEqual({ available: false, unavailable_reason: 'price_unavailable' });
  });
});
