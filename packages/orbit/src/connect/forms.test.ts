import { describe, expect, it } from 'bun:test';
import type { ConnectedAccount, Transfer } from '@peable.to/shared-types';
import {
  buildSellerBody,
  canReverse,
  EMPTY_SELLER_FORM,
  newReversalRef,
  parsePendingReversal,
  parseReversalAmount,
  pendingReversalStorageKey,
  reversibleAmount,
  sellerLinkBody,
  sellerReadiness,
} from './forms';

const requirements = {
  currently_due: [],
  eventually_due: [],
  past_due: [],
  pending_verification: [],
  disabled_reason: null,
};

function seller(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
  return {
    id: 'ca_1',
    object: 'connected_account',
    livemode: false,
    external_ref: 'store-1',
    rails: ['card'],
    faircoin: null,
    country: 'ES',
    default_currency: 'eur',
    payable: true,
    payouts_enabled: true,
    charges_enabled: true,
    transfers_capability: 'active',
    card_payments_capability: 'active',
    requirements,
    last_synced_at: 1,
    created: 1,
    updated_at: 1,
    ...overrides,
  };
}

function transfer(overrides: Partial<Transfer> = {}): Transfer {
  return {
    id: 'tr_1',
    object: 'transfer',
    livemode: false,
    external_ref: 'order-1',
    connected_account: 'ca_1',
    payment_intent: 'pi_1',
    amount: '1000',
    currency: 'EUR',
    amount_reversed: '250',
    status: 'partially_reversed',
    failure_message: null,
    created: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe('buildSellerBody', () => {
  it('opens a card seller with an upper-cased country', () => {
    expect(
      buildSellerBody({ ...EMPTY_SELLER_FORM, externalRef: ' store-1 ', country: 'es' }),
    ).toEqual({
      ok: true,
      body: { external_ref: 'store-1', country: 'ES', business_type: 'company' },
    });
  });

  it('opens a FairCoin-only seller naming their Oxy user, never a key', () => {
    expect(
      buildSellerBody({
        ...EMPTY_SELLER_FORM,
        externalRef: 'fair-1',
        card: false,
        faircoin: true,
        oxyUserId: 'user_1',
      }),
    ).toEqual({
      ok: true,
      body: { external_ref: 'fair-1', faircoin: { network: 'testnet', oxy_user_id: 'user_1' } },
    });
  });

  it('names the first field that is wrong', () => {
    expect(buildSellerBody(EMPTY_SELLER_FORM)).toEqual({ ok: false, error: 'externalRef' });
    const named = { ...EMPTY_SELLER_FORM, externalRef: 'x' };
    expect(buildSellerBody({ ...named, card: false })).toEqual({ ok: false, error: 'rail' });
    expect(buildSellerBody({ ...named, country: 'Spain' })).toEqual({
      ok: false,
      error: 'country',
    });
    expect(buildSellerBody({ ...named, card: false, faircoin: true, oxyUserId: ' ' })).toEqual({
      ok: false,
      error: 'oxyUserId',
    });
    expect(buildSellerBody({ ...named, externalRef: 'x'.repeat(256) }).ok).toBe(false);
  });
});

describe('sellerLinkBody', () => {
  it('brings whoever finishes back to the seller’s page', () => {
    expect(sellerLinkBody('https://orbit.peable.to/', 'ca_1', 'card')).toEqual({
      return_url: 'https://orbit.peable.to/connect/ca_1',
      refresh_url: 'https://orbit.peable.to/connect/ca_1?refresh=1',
      rail: 'card',
    });
  });
});

describe('sellerReadiness', () => {
  it('is ready only when every rail it has can be paid, and its own FairCoin key is registered', () => {
    const active = {
      network: 'testnet' as const,
      status: 'active' as const,
      oxy_user_id: 'u',
      registered_at: 1,
    };
    expect(sellerReadiness(seller({ rails: ['card', 'faircoin'], faircoin: active }))).toBe(
      'ready',
    );
    expect(sellerReadiness(seller({ rails: ['faircoin'], faircoin: active, payable: false }))).toBe(
      'ready',
    );
    // A card-only seller owes its FairCoin key (ADR 0021 D5).
    expect(sellerReadiness(seller())).toBe('pending');
    expect(
      sellerReadiness(seller({ rails: ['card', 'faircoin'], faircoin: active, payable: false })),
    ).toBe('pending');
    expect(
      sellerReadiness(
        seller({
          rails: ['card', 'faircoin'],
          faircoin: {
            network: 'testnet',
            status: 'pending',
            oxy_user_id: 'u',
            registered_at: null,
          },
        }),
      ),
    ).toBe('pending');
    expect(
      sellerReadiness(
        seller({ requirements: { ...requirements, disabled_reason: 'requirements.past_due' } }),
      ),
    ).toBe('restricted');
  });
});

describe('reversals', () => {
  it('reverses no more than is left, in the settlement’s own decimals', () => {
    expect(reversibleAmount(transfer())).toBe('750');
    expect(parseReversalAmount('7.50', transfer())).toEqual({ ok: true, body: '750' });
    expect(parseReversalAmount('7.51', transfer())).toEqual({ ok: false, error: 'exceeds' });
    expect(parseReversalAmount('1.001', transfer())).toEqual({ ok: false, error: 'amount' });
    expect(parseReversalAmount('0', transfer())).toEqual({ ok: false, error: 'amount' });
  });

  it('offers a reversal only on a paid settlement with something left', () => {
    expect(canReverse(transfer())).toBe(true);
    expect(canReverse(transfer({ status: 'reversed', amount_reversed: '1000' }))).toBe(false);
    expect(canReverse(transfer({ status: 'pending', amount_reversed: '0' }))).toBe(false);
  });

  it('keeps a pending reversal per scope and settlement, read defensively', () => {
    const scope = { applicationId: 'app_1', environment: 'development' };
    expect(pendingReversalStorageKey(scope, 'tr_1')).toBe(
      'peable-orbit:pending-reversal:app_1:development:tr_1',
    );
    const pending = {
      transfer: 'tr_1',
      body: { amount: '100', external_ref: newReversalRef('u-1') },
    };
    expect(parsePendingReversal(JSON.stringify(pending), 'tr_1')).toEqual(pending);
    expect(parsePendingReversal(JSON.stringify(pending), 'tr_2')).toBeNull();
    expect(
      parsePendingReversal(
        JSON.stringify({ ...pending, body: { amount: '1', external_ref: 'x' } }),
        'tr_1',
      ),
    ).toBeNull();
    expect(parsePendingReversal('{', 'tr_1')).toBeNull();
    expect(parsePendingReversal(null, 'tr_1')).toBeNull();
  });
});
