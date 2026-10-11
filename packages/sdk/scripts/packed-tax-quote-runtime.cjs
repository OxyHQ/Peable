const assert = require('node:assert/strict');
const { Peable } = require('@peable.to/sdk');
const { generateKeyPairSync, sign } = require('node:crypto');
const { canonicalBillingTaxQuote } = require('@peable.to/shared-types');
const quote = {
  schemaVersion: 1,
  source: {
    merchantId: 'merch_fixture',
    appId: 'app_fixture',
    storeId: 'payer_fixture',
    planId: 'plan_fixture',
    mode: 'test',
    environment: 'development',
  },
  quote: {
    id: 'quote_fixture',
    currency: 'USD',
    grossMinorUnits: 2999,
    netMinorUnits: 2500,
    taxMinorUnits: 499,
    taxTreatment: 'inclusive',
    sellerId: 'seller_fixture',
    invoiceIssuerId: 'issuer_fixture',
    taxRemitterId: 'remitter_fixture',
    taxServiceRef: 'tax_fixture',
    country: 'RO',
    coverageEvidenceId: 'coverage_fixture',
    taxRateEvidenceId: 'rate_fixture',
    customerLocationEvidenceId: 'location_fixture',
    quotedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  },
  signature: { algorithm: 'Ed25519', keyId: 'fixture', value: 'A'.repeat(86) },
};
const { privateKey } = generateKeyPairSync('ed25519');
quote.signature.value = sign(
  null,
  Buffer.from(canonicalBillingTaxQuote(quote)),
  privateKey,
).toString('base64url');
const checkout = {
  providerCustomerId: 'cus_fixture',
  providerPriceId: 'price_fixture',
  storeId: 'payer_fixture',
  planId: 'plan_fixture',
  trialDays: 0,
  returnUrl: 'https://example.invalid/return',
  taxQuote: quote,
};
let dispatched = 0;
global.fetch = async (url, init) => {
  const parsed = new URL(String(url));
  assert.equal(parsed.origin, 'http://127.0.0.1:1');
  if (parsed.pathname === '/auth/service-token')
    return new Response(JSON.stringify({ data: { token: 'synthetic', expiresIn: 300 } }));
  assert.equal(parsed.pathname, '/v1/billing/checkout_sessions');
  assert.deepEqual(JSON.parse(init.body), checkout);
  assert.equal(init.headers['Idempotency-Key'], 'personal-checkout:fixture');
  dispatched++;
  return new Response(
    JSON.stringify({
      id: 'cs_test_fixture',
      url: 'https://example.invalid/fixture',
      expiresAt: quote.quote.expiresAt,
    }),
  );
};
(async () => {
  const client = new Peable({
    baseURL: 'http://127.0.0.1:1',
    oxyApiUrl: 'http://127.0.0.1:1',
    publicKey: 'synthetic',
    secret: 'synthetic',
  });
  await client.billing.createCheckoutSession(checkout, {
    idempotencyKey: 'personal-checkout:fixture',
  });
  assert.equal(dispatched, 1);
  console.log('Packed quote contract and full quote transport passed; no sockets opened');
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
