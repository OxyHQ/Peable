/** Approved local test catalogue, never a production offer or entitlement mapping. */
export const LOCAL_TEST_PRODUCT = 'peable_local_mention_plus';
export const LOCAL_TEST_PORTAL = 'bpc_1UXYM9AofUef123LHMEjc7ig';
export const LOCAL_TEST_APP = 'peable-local-stripe-test';
export const LOCAL_TEST_PRICES = {
  month: { id: 'price_1UXYLNAofUef123LlBvYkDuP', amount: 599, plan: 'local-mention-plus-monthly' },
  year: { id: 'price_1UXYLcAofUef123Lj2BeXxxU', amount: 5750, plan: 'local-mention-plus-annual' },
} as const;

/** The local test merchant, with how many webhook endpoints it has. */
export interface LocalTestBillingOwner {
  id: string;
  oxyAppId: string;
  environment: string;
  livemode: boolean;
  webhookEndpoints: number;
}

/** Read the merchant's webhook endpoint count for {@link localTestBillingConfiguration}. */
export async function localTestBillingOwner(
  db: import('../db/postgres').DatabaseOrTransaction,
  merchant: Omit<LocalTestBillingOwner, 'webhookEndpoints'>,
): Promise<LocalTestBillingOwner> {
  const { countEndpointsForMerchant } = await import('../db/webhooks/webhookEndpointRepository');
  return { ...merchant, webhookEndpoints: await countEndpointsForMerchant(db, merchant.id) };
}

export function localTestBillingConfiguration(merchant: LocalTestBillingOwner, accountId: string) {
  if (
    merchant.oxyAppId !== LOCAL_TEST_APP ||
    merchant.environment !== 'development' ||
    merchant.livemode ||
    merchant.webhookEndpoints > 0
  ) {
    throw new Error(
      'Recurring test requires the isolated development merchant without an external webhook target',
    );
  }
  return {
    deployment: { provider: 'stripe' as const, platformAccountId: accountId, livemode: false },
    portalConfigurationRef: LOCAL_TEST_PORTAL,
    observationsEnabled: true,
    // The owned invoice proof makes several bounded provider reads.
    observationTimeoutMs: 10_000,
    cohorts: [
      {
        merchantId: merchant.id,
        oxyAppId: merchant.oxyAppId,
        environment: 'development' as const,
        evidenceRef: 'local-test-approved-mention-plus',
      },
    ],
  };
}

export function requireLocalBillingReturnUrl(value: string | undefined): string {
  let url: URL;
  try {
    url = new URL(value ?? '');
  } catch {
    throw new Error('A loopback HTTPS return URL is required');
  }
  if (
    url.protocol !== 'https:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error('Recurring test return URL must use loopback HTTPS without credentials');
  }
  return url.toString();
}
