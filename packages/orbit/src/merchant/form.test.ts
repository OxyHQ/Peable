import { describe, expect, it } from 'bun:test';
import type { Merchant } from '@peable.to/shared-types';
import {
  buildMerchantPatch,
  buildRegisterBody,
  EMPTY_MERCHANT_FORM,
  formFromMerchant,
} from './form';

const merchant: Merchant = {
  id: 'merch_1',
  object: 'merchant',
  livemode: false,
  oxy_app_id: 'app_1',
  environment: 'development',
  network: 'testnet',
  owner_account: 'acct_owner',
  required_confirmations: 6,
  display_name: 'Shop',
  created: 1,
  updated_at: 2,
};

describe('buildRegisterBody', () => {
  it('sends nothing for an empty form: gateway defaults, and never a key (ADR 0021 D5)', () => {
    expect(buildRegisterBody(EMPTY_MERCHANT_FORM)).toEqual({ ok: true, body: {} });
  });

  it('sends what was typed, trimmed', () => {
    expect(
      buildRegisterBody({
        ...EMPTY_MERCHANT_FORM,
        displayName: ' Shop ',
        requiredConfirmations: '3',
      }),
    ).toEqual({
      ok: true,
      body: { display_name: 'Shop', required_confirmations: 3 },
    });
  });

  it('refuses confirmations that are not a whole number of 1 or more', () => {
    for (const value of ['0', '-1', '1.5', 'abc', '01']) {
      expect(buildRegisterBody({ ...EMPTY_MERCHANT_FORM, requiredConfirmations: value })).toEqual({
        ok: false,
        error: 'confirmations',
      });
    }
  });
});

describe('buildMerchantPatch', () => {
  it('sends nothing when nothing changed', () => {
    expect(buildMerchantPatch(merchant, formFromMerchant(merchant))).toEqual({
      ok: true,
      body: {},
    });
  });

  it('sends only the changed fields, a cleared field as null', () => {
    const form = {
      ...formFromMerchant(merchant),
      displayName: '',
      description: 'Fresh bread',
      requiredConfirmations: '2',
    };
    expect(buildMerchantPatch(merchant, form)).toEqual({
      ok: true,
      body: {
        display_name: null,
        description: 'Fresh bread',
        required_confirmations: 2,
      },
    });
  });

  /** Webhook endpoints are their own resource (ADR 0014 D4), not merchant fields. */
  it('carries no webhook field in either body', () => {
    const form = { ...formFromMerchant(merchant), displayName: 'New' };
    expect(JSON.stringify(buildMerchantPatch(merchant, form))).not.toContain('webhook');
    expect(JSON.stringify(buildRegisterBody(form))).not.toContain('webhook');
  });
});
