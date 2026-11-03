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
  network: null,
  xpub: null,
  webhook_url: 'https://shop.example/hook',
  required_confirmations: 6,
  display_name: 'Shop',
  created: 1,
  updated_at: 2,
};

describe('buildRegisterBody', () => {
  it('sends nothing for an empty form: a card-only merchant with gateway defaults', () => {
    expect(buildRegisterBody(EMPTY_MERCHANT_FORM)).toEqual({ ok: true, body: {} });
  });

  it('sends what was typed, trimmed, and the FairCoin half only as a pair', () => {
    expect(
      buildRegisterBody({
        ...EMPTY_MERCHANT_FORM,
        displayName: ' Shop ',
        webhookUrl: 'https://shop.example/hook',
        webhookSecret: 'whsec',
        requiredConfirmations: '3',
        network: 'testnet',
        xpub: ' tpubABC ',
      }),
    ).toEqual({
      ok: true,
      body: {
        display_name: 'Shop',
        webhook_url: 'https://shop.example/hook',
        webhook_secret: 'whsec',
        required_confirmations: 3,
        network: 'testnet',
        xpub: 'tpubABC',
      },
    });
    // A network without a key is not half a registration: it is none.
    expect(buildRegisterBody({ ...EMPTY_MERCHANT_FORM, network: 'mainnet' })).toEqual({
      ok: true,
      body: {},
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
      webhookUrl: '  ',
      requiredConfirmations: '2',
    };
    expect(buildMerchantPatch(merchant, form)).toEqual({
      ok: true,
      body: {
        display_name: null,
        description: 'Fresh bread',
        webhook_url: null,
        required_confirmations: 2,
      },
    });
  });

  it('sends a new secret and keeps the stored one when blank', () => {
    expect(
      buildMerchantPatch(merchant, { ...formFromMerchant(merchant), webhookSecret: ' new ' }),
    ).toEqual({ ok: true, body: { webhook_secret: 'new' } });
  });

  it('never fills the form with a secret', () => {
    expect(formFromMerchant(merchant).webhookSecret).toBe('');
  });
});
