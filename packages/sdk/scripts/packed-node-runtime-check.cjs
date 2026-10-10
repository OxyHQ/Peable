// Executed against installed tarballs by verify-billing-packed.mjs.
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { Peable, WebhooksResource } = require('@peable.to/sdk');
const calls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  assert.equal(url.origin, 'http://127.0.0.1:1'); // Never open a socket.
  calls.push({ path: url.pathname, method: init.method, headers: init.headers });
  if (url.pathname === '/auth/service-token') {
    return new Response(
      JSON.stringify({ data: { token: 'synthetic-service-token', expiresIn: 300 } }),
      { status: 200 },
    );
  }
  assert.equal(init.headers.Authorization, 'Bearer synthetic-service-token');
  if (
    url.pathname ===
    '/v1/billing/subscriptions/sub_fixture%2Fowned/invoice_states/in_fixture%2Fowned'
  ) {
    return new Response(JSON.stringify({ invoiceId: 'in_fixture/owned', state: 'paid' }), {
      status: 200,
    });
  }
  if (url.pathname === '/v1/billing/subscriptions/sub_fixture%2Fowned/cancel_at_period_end') {
    assert.equal(init.headers['Idempotency-Key'], 'same-owned-action');
    return new Response(
      JSON.stringify({ providerSubscriptionId: 'sub_fixture/owned', cancelAtPeriodEnd: true }),
      { status: 200 },
    );
  }
  throw new Error('Unexpected fixture request');
};
(async () => {
  const client = new Peable({
    publicKey: 'synthetic',
    secret: 'synthetic',
    baseURL: 'http://127.0.0.1:1',
    oxyApiUrl: 'http://127.0.0.1:1',
  });
  assert.equal(
    (await client.billing.retrieveInvoiceState('sub_fixture/owned', 'in_fixture/owned')).state,
    'paid',
  );
  assert.equal(
    (
      await client.billing.cancelAtPeriodEnd('sub_fixture/owned', {
        idempotencyKey: 'same-owned-action',
      })
    ).cancelAtPeriodEnd,
    true,
  );
  assert.equal(calls.length, 3); // Cached service token; no duplicate mint.
  const time = Math.floor(Date.now() / 1000);
  const raw = JSON.stringify({
    id: 'evt_fixture',
    object: 'event',
    type: 'billing.observation.updated',
    created: new Date().toISOString(),
    data: {
      object: {
        object: 'billing_observation',
        resourceKind: 'invoice',
        resourceId: 'in_fixture',
        revision: 1,
        observedAt: new Date().toISOString(),
      },
    },
  });
  const signature = createHmac('sha256', 'synthetic').update(`${time}.${raw}`).digest('hex');
  assert.equal(
    new WebhooksResource().constructEvent(raw, `t=${time},v1=${signature}`, 'synthetic').type,
    'billing.observation.updated',
  );
  assert.throws(() =>
    new WebhooksResource().constructEvent(`${raw} `, `t=${time},v1=${signature}`, 'synthetic'),
  );
  require('@peable.to/sdk/checkout');
  console.log(
    'Packed Node runtime: public billing transport, token caching, encoded refs, idempotency, observation verification and checkout entry passed; all fetches mocked.',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
