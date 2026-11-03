import { describe, expect, it } from 'bun:test';
import type { Account } from '@peable.to/shared-types';
import { buildBusinessBody, businessFormOf } from './businessForm';

function account(): Account {
  return {
    business_profile: {
      name: 'Shop',
      url: 'https://shop.example',
      support_email: null,
      support_url: null,
      product_description: null,
      mcc: '5734',
    },
    settings: {
      payments: { statement_descriptor: 'SHOP' },
      payouts: { statement_descriptor: null, schedule: null },
      branding: { primary_color: null, secondary_color: null },
    },
  } as unknown as Account;
}

describe('businessFormOf', () => {
  it('reads the profile and the descriptors, unset as empty', () => {
    expect(businessFormOf(account())).toEqual({
      name: 'Shop',
      url: 'https://shop.example',
      supportEmail: '',
      supportUrl: '',
      productDescription: '',
      mcc: '5734',
      statementDescriptor: 'SHOP',
      payoutDescriptor: '',
    });
  });
});

describe('buildBusinessBody', () => {
  const current = businessFormOf(account());

  it('sends only what changed, profile and settings apart', () => {
    expect(
      buildBusinessBody(
        { ...current, supportEmail: ' help@shop.example ', statementDescriptor: 'SHOP ONLINE' },
        current,
      ),
    ).toEqual({
      ok: true,
      body: {
        business_profile: { support_email: 'help@shop.example' },
        settings: { payments: { statement_descriptor: 'SHOP ONLINE' } },
      },
    });
    expect(buildBusinessBody({ ...current, payoutDescriptor: 'SHOP PAYOUT' }, current)).toEqual({
      ok: true,
      body: { settings: { payouts: { statement_descriptor: 'SHOP PAYOUT' } } },
    });
  });

  it('answers no body when nothing changed', () => {
    expect(buildBusinessBody({ ...current, name: ' Shop ' }, current)).toEqual({
      ok: true,
      body: null,
    });
  });

  it('refuses what the gateway would, and emptying a field that has a value', () => {
    expect(buildBusinessBody({ ...current, url: 'shop' }, current)).toEqual({
      ok: false,
      error: { field: 'url', reason: 'invalid' },
    });
    expect(buildBusinessBody({ ...current, mcc: '57' }, current)).toEqual({
      ok: false,
      error: { field: 'mcc', reason: 'invalid' },
    });
    expect(buildBusinessBody({ ...current, statementDescriptor: 'A*B*C*D' }, current)).toEqual({
      ok: false,
      error: { field: 'statementDescriptor', reason: 'invalid' },
    });
    expect(buildBusinessBody({ ...current, name: '' }, current)).toEqual({
      ok: false,
      error: { field: 'name', reason: 'cannotClear' },
    });
  });
});
