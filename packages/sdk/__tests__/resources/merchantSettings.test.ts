import { describe, expect, test } from 'bun:test';
import { resources } from '../support/testGateway';
import type { MerchantBranding, MerchantEmailSettings } from '@peable.to/shared-types';
import { createMockFetch, type CapturedRequest } from '../support/mockFetch';
import {
  buildTestClient,
  serviceTokenMintResponse,
  TEST_GATEWAY_URL,
} from '../support/testGateway';

function gatewayCallOf(requests: CapturedRequest[]): CapturedRequest | undefined {
  return requests.find((r) => !r.url.includes('/auth/service-token'));
}

const branding: MerchantBranding = {
  object: 'branding_settings',
  livemode: false,
  use_avatar_as_icon: true,
  logo: null,
  primary_color: '#ff0066',
  accent_color: null,
  font: 'inter',
  border_style: 'pill',
  terms_of_service_url: 'https://merchant.example/terms',
  updated_at: 1_789_913_600,
};

const emailSettings: MerchantEmailSettings = {
  object: 'email_settings',
  livemode: false,
  payment_receipts: true,
  refund_notices: true,
  checkout_confirmations: false,
  support_email: 'help@merchant.example',
  updated_at: null,
};

function resourceAnswering(json: unknown) {
  const { fetch: fetchImpl, requests } = createMockFetch((req) => {
    if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
    return { status: 200, json };
  });
  return { merchants: resources(buildTestClient(fetchImpl)).merchants, requests };
}

describe('merchants.branding', () => {
  test('retrieve() GETs /v1/merchants/me/branding', async () => {
    const { merchants, requests } = resourceAnswering(branding);
    const answer = await merchants.branding.retrieve();
    expect(answer.font).toBe('inter');
    const call = gatewayCallOf(requests);
    expect(call?.method).toBe('GET');
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/merchants/me/branding`);
  });

  test('update() POSTs the patch, null resetting a field', async () => {
    const { merchants, requests } = resourceAnswering(branding);
    await merchants.branding.update({ primary_color: '#FF0066', accent_color: null });
    const call = gatewayCallOf(requests);
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/merchants/me/branding`);
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      primary_color: '#FF0066',
      accent_color: null,
    });
  });
});

describe('merchants.emailSettings', () => {
  test('retrieve() GETs /v1/merchants/me/email_settings', async () => {
    const { merchants, requests } = resourceAnswering(emailSettings);
    const answer = await merchants.emailSettings.retrieve();
    expect(answer.payment_receipts).toBe(true);
    expect(gatewayCallOf(requests)?.url).toBe(`${TEST_GATEWAY_URL}/v1/merchants/me/email_settings`);
  });

  test('update() POSTs the toggles', async () => {
    const { merchants, requests } = resourceAnswering(emailSettings);
    await merchants.emailSettings.update({ checkout_confirmations: true, support_email: null });
    const call = gatewayCallOf(requests);
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/merchants/me/email_settings`);
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      checkout_confirmations: true,
      support_email: null,
    });
  });
});
