import { findMerchantByAppEnvironment } from '../../../db/merchants/merchantRepository';
import { must } from '../../../__tests__/helpers/must';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  canonicalBillingAuthority,
  type BillingFinalInvoiceAuthority,
} from '@peable.to/shared-types';
import type { FinalInvoiceAuthorityReader } from '../invoice-authority';
import { bindRecurringObject } from '../../../db/recurring/recurringMirrorRepository';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type Stripe from 'stripe';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { Peable } from '@peable.to/sdk';
import {
  gatewayDb,
  POSTGRES_TESTS_ENABLED,
  resetGatewayTables,
  seedMerchant,
  useGatewayDatabase,
} from '../../../__tests__/helpers/gatewayTestDatabase';
import {
  bindBillingObject,
  claimBillingOperation,
  completeBillingOperation,
} from '../../../db/billing/billingRepository';
import { billingOperations, billingObjectBindings, recurringMirrors } from '../../../db/schema';
import { createBillingRouter } from '../../../routes/billing';
import { createVerifiedBillingBindings } from '../verifiedBindings';
import { configureBillingRuntime } from '../configuredBilling';
import { createBillingService, type BillingCohort } from '../billingService';
import { createStripeBillingProvider, type StripeBillingClient } from '../stripeBillingProvider';
import { STRIPE_API_VERSION } from '../../providers/stripe/client';
import type { BillingOwner } from '../contracts';
const deployment = {
  provider: 'stripe' as const,
  platformAccountId: 'acct_platform',
  livemode: false,
};
const now = new Date('2026-10-03T12:00:00Z');
const customerInput = { storeId: 'store:one', storeName: 'Synthetic Store' };
const checkout = {
  providerCustomerId: 'cus_one',
  providerPriceId: 'price_one',
  trialDays: 0,
  returnUrl: 'https://example.invalid/billing?from=plans',
  storeId: 'store:one',
  planId: 'plan:one',
};
function stripeSubscription(cancel = false) {
  const item = {
    id: 'si_one',
    current_period_start: 1791028800,
    current_period_end: 1793707200,
    quantity: 1,
    price: { id: 'price_one', recurring: { interval: 'month' as const, interval_count: 1 } },
  };
  // SDK fields used by the projection are checked against the installed release.
  const checkedItem: Pick<
    Stripe.SubscriptionItem,
    'id' | 'current_period_start' | 'current_period_end' | 'quantity'
  > = item;
  const value = {
    id: 'sub_one',
    customer: 'cus_one',
    livemode: false,
    status: 'active' as const,
    cancel_at_period_end: cancel,
    trial_end: null,
    cancel_at: cancel ? 1793707200 : null,
    canceled_at: null,
  } satisfies Pick<
    Stripe.Subscription,
    | 'id'
    | 'customer'
    | 'livemode'
    | 'status'
    | 'cancel_at_period_end'
    | 'trial_end'
    | 'cancel_at'
    | 'canceled_at'
  >;
  return { ...value, items: { has_more: false, data: [{ ...item, ...checkedItem }] } };
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)(
  'I08 billing HTTP SDK platform adapter / real PostgreSQL',
  () => {
    useGatewayDatabase();
    let owner: BillingOwner;
    let other: BillingOwner;
    let server: Server;
    let base: string;
    let calls: Array<{ method: string; params?: unknown; key?: string }>;
    let portalUpdate: boolean;
    let portalImmediate: boolean;
    let accountId: string;
    let failCustomer: boolean;
    let cancelled: boolean;
    let finalAuthorityReader: FinalInvoiceAuthorityReader | undefined;
    let time: Date;
    let client: StripeBillingClient;
    let verified: ReturnType<typeof createVerifiedBillingBindings>;
    let hasCheckout: boolean;
    let hasMore: boolean;
    let checkoutCustomer: string;
    let subscriptionPrice: string;
    let checkoutStatus: string;
    let duplicateCheckout: boolean;
    let retry401: boolean;
    const request = async (path: string, token = 'owner', body?: unknown, key?: string) =>
      fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const sdk = () =>
      new Peable({
        baseURL: base,
        oxyApiUrl: base,
        publicKey: 'fixture-public',
        secret: 'fixture-secret',
      }).billing;
    async function bindSubscription() {
      const c = await bindBillingObject(gatewayDb(), deployment, owner, {
        kind: 'customer',
        providerRef: 'cus_one',
        externalSubjectRef: 'store:one',
        bindingEvidenceRef: 'fixture:verified-import',
      });
      const p = await bindBillingObject(gatewayDb(), deployment, owner, {
        kind: 'price',
        providerRef: 'price_one',
        planRef: 'plan:one',
        bindingEvidenceRef: 'fixture:verified-import',
      });
      await bindBillingObject(gatewayDb(), deployment, owner, {
        kind: 'subscription',
        providerRef: 'sub_one',
        externalSubjectRef: 'store:one',
        planRef: 'plan:one',
        customerBindingId: c.id,
        priceBindingId: p.id,
        bindingEvidenceRef: 'fixture:verified-import',
      });
    }
    beforeEach(async () => {
      await resetGatewayTables();
      cancelled = false;
      calls = [];
      portalUpdate = false;
      portalImmediate = false;
      accountId = deployment.platformAccountId;
      failCustomer = false;
      time = new Date(now);
      hasCheckout = false;
      hasMore = false;
      duplicateCheckout = false;
      retry401 = false;
      checkoutCustomer = 'cus_one';
      subscriptionPrice = 'price_one';
      checkoutStatus = 'complete';
      const a = await seedMerchant();
      const b = await seedMerchant();
      owner = { merchantId: a.id, oxyAppId: a.oxyAppId, environment: a.environment };
      other = { merchantId: b.id, oxyAppId: b.oxyAppId, environment: b.environment };
      client = {
        scope: 'platform',
        apiVersion: STRIPE_API_VERSION,
        livemode: false,
        async account() {
          calls.push({ method: 'account' });
          return { id: accountId };
        },
        async createCustomer(params, key) {
          calls.push({ method: 'customer', params, key });
          if (failCustomer) throw new Error('synthetic timeout');
          return { id: 'cus_one', livemode: false };
        },
        async createCheckout(params, key) {
          calls.push({ method: 'checkout', params, key });
          return {
            id: 'cs_test_a11fixture',
            customer: 'cus_one',
            mode: 'subscription',
            livemode: false,
            url: 'https://checkout.stripe.com/c/synthetic',
            expires_at: 1791032400,
          };
        },
        async createPortal(params, key) {
          calls.push({ method: 'portal', params, key });
          return {
            id: 'bps_one',
            customer: 'cus_one',
            configuration: 'bpc_one',
            on_behalf_of: null,
            livemode: false,
            url: 'https://billing.stripe.com/synthetic',
          };
        },
        async retrievePortalConfiguration() {
          calls.push({ method: 'portalConfig' });
          return {
            id: 'bpc_one',
            active: true,
            livemode: false,
            features: {
              subscription_update: { enabled: portalUpdate },
              subscription_cancel: {
                enabled: true,
                mode: portalImmediate ? 'immediately' : 'at_period_end',
              },
            },
          };
        },
        async retrieveSubscription() {
          calls.push({ method: 'retrieve' });
          const snapshot = stripeSubscription(cancelled);
          must(snapshot.items.data[0]).price.id = subscriptionPrice;
          return snapshot;
        },
        async updateSubscription(ref, params, key) {
          calls.push({ method: 'cancel', params: { ref, ...params }, key });
          cancelled = true;
          return stripeSubscription(true);
        },
        async retrieveCustomer(id) {
          calls.push({ method: 'readCustomer' });
          return { id, livemode: false, metadata: { storeId: 'forged' } };
        },
        async retrievePrice(id) {
          calls.push({ method: 'readPrice' });
          return {
            id,
            livemode: false,
            active: true,
            recurring: { interval: 'month', interval_count: 1 },
            metadata: { planId: 'forged' },
          };
        },
        async listCheckoutsForSubscription() {
          calls.push({ method: 'listCheckout' });
          return {
            has_more: hasMore,
            data: !hasCheckout
              ? []
              : duplicateCheckout
                ? [{ id: 'cs_test_a11fixture' }, { id: 'cs_test_other' }]
                : [{ id: 'cs_test_a11fixture' }],
          };
        },
        async retrieveCheckout(id) {
          calls.push({ method: 'readCheckout' });
          return {
            id,
            mode: 'subscription',
            customer: checkoutCustomer,
            subscription: 'sub_one',
            status: checkoutStatus,
            livemode: false,
            metadata: { storeId: 'forged' },
          };
        },
      };
      const provider = createStripeBillingProvider(deployment, client, {
        portalConfigurationRef: 'bpc_one',
        now: () => time,
      });
      const cohorts: BillingCohort[] = [
        { ...owner, ...deployment, evidenceRef: 'fixture:approved-cohort' },
      ];
      verified = createVerifiedBillingBindings({
        db: gatewayDb(),
        client,
        deployment,
        cohorts,
        now: () => time,
      });
      finalAuthorityReader = undefined;
      const service = createBillingService({
        db: gatewayDb(),
        provider,
        cohorts,
        verifiedBindings: verified,
        now: () => time,
        get finalInvoiceAuthority() {
          return finalAuthorityReader;
        },
      });
      const auth: RequestHandler = (req, _res, next) => {
        if (retry401) {
          retry401 = false;
          _res.status(401).json({ error: { message: 'synthetic_expiry' } });
          return;
        }
        const token = req.header('Authorization')?.replace('Bearer ', '');
        const selected = token === 'other' ? other : owner;
        if (token !== 'missing')
          (req as OxyAuthRequest).serviceApp = {
            appId: selected.oxyAppId,
            environment: selected.environment,
            appName: 'fixture',
            credentialId: 'fixture',
            ownerAccountId: 'not-the-payer',
            tier: 'external',
            scopes: token === 'noScope' ? [] : ['payments:read', 'payments:write'],
          };
        next();
      };
      const app = express();
      app.use(express.json());
      // Synthetic Oxy authority only; SDK mint/retry and the actual HTTP/domain/SQL path run.
      app.post('/auth/service-token', (req, res) => {
        if (req.body.apiKey !== 'fixture-public' || req.body.apiSecret !== 'fixture-secret') {
          res.sendStatus(401);
          return;
        }
        res.json({ data: { token: 'owner', expiresIn: 300 } });
      });
      app.use(createBillingRouter({ requireMerchant: auth, service }));
      server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterEach(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    it('executes five SDK methods with store/receipt references and no Connect or financial decisions', async () => {
      expect(await sdk().ensureCustomer(customerInput, { idempotencyKey: 'customer:one' })).toEqual(
        { providerCustomerId: 'cus_one' },
      );
      const c = (await gatewayDb().select().from(billingObjectBindings))[0];
      if (!c) throw new Error('Missing customer');
      const p = await bindBillingObject(gatewayDb(), deployment, owner, {
        kind: 'price',
        providerRef: 'price_one',
        planRef: 'plan:one',
        bindingEvidenceRef: 'fixture:verified-import',
      });
      await bindBillingObject(gatewayDb(), deployment, owner, {
        kind: 'subscription',
        providerRef: 'sub_one',
        externalSubjectRef: 'store:one',
        planRef: 'plan:one',
        customerBindingId: c.id,
        priceBindingId: p.id,
        bindingEvidenceRef: 'fixture:verified-import',
      });
      expect(
        (await sdk().createCheckoutSession(checkout, { idempotencyKey: 'checkout:one' })).expiresAt,
      ).toBe('2026-10-03T13:00:00.000Z');
      expect(
        (
          await sdk().createPortalSession(
            { providerCustomerId: 'cus_one', returnUrl: checkout.returnUrl },
            { idempotencyKey: 'portal:one' },
          )
        ).expiresAt,
      ).toBe('2026-10-03T12:01:00.000Z');
      expect(await sdk().retrieveSubscription('sub_one')).toMatchObject({
        storeId: 'store:one',
        planId: 'plan:one',
        providerCustomerId: 'cus_one',
        cancelAtPeriodEnd: false,
      });
      expect(
        await sdk().cancelAtPeriodEnd('sub_one', { idempotencyKey: 'cancel:one' }),
      ).toMatchObject({ cancelAtPeriodEnd: true, storeId: 'store:one' });
      expect(calls.find((c) => c.method === 'cancel')?.params).toEqual({
        ref: 'sub_one',
        cancel_at_period_end: true,
      });
      expect(calls.find((c) => c.method === 'checkout')?.params).toMatchObject({
        mode: 'subscription',
        customer: 'cus_one',
        line_items: [{ price: 'price_one', quantity: 1 }],
        success_url: 'https://example.invalid/billing?from=plans&billing=complete',
      });
      expect(JSON.stringify(calls)).not.toContain('on_behalf_of');
      expect(JSON.stringify(calls)).not.toContain('transfer_data');
    });
    it('reuses customer for renamed store and new key without another provider effect', async () => {
      await sdk().ensureCustomer(customerInput, { idempotencyKey: 'customer:one' });
      expect(
        await sdk().ensureCustomer(
          { ...customerInput, storeName: 'Renamed' },
          { idempotencyKey: 'customer:one' },
        ),
      ).toEqual({ providerCustomerId: 'cus_one' });
      expect(
        await sdk().ensureCustomer(
          { ...customerInput, storeName: 'Renamed' },
          { idempotencyKey: 'customer:two' },
        ),
      ).toEqual({ providerCustomerId: 'cus_one' });
      expect(calls.filter((c) => c.method === 'customer')).toHaveLength(1);
    });
    it('denies other cohort, missing scopes and missing auth before provider effects', async () => {
      for (const [token, status] of [
        ['other', 404],
        ['noScope', 403],
        ['missing', 401],
      ] as const)
        expect(
          (await request('/v1/billing/customers', token, customerInput, 'customer:one')).status,
        ).toBe(status);
      expect(calls).toHaveLength(0);
    });
    it('rejects unknown price, foreign store and invented owner/payer fields before checkout', async () => {
      await bindSubscription();
      for (const body of [
        { ...checkout, providerPriceId: 'price_unknown' },
        { ...checkout, storeId: 'store:other' },
        { ...checkout, subjectAccountId: 'invented' },
        { ...checkout, merchantId: other.merchantId },
      ])
        expect(
          (await request('/v1/billing/checkout_sessions', 'owner', body, 'checkout:one')).status,
        ).toBeGreaterThanOrEqual(400);
      expect(calls).toHaveLength(0);
    });
    it('replays checkout while fresh and refuses expired URL without another effect', async () => {
      await bindSubscription();
      const first = await sdk().createCheckoutSession(checkout, { idempotencyKey: 'checkout:one' });
      expect(
        await sdk().createCheckoutSession(checkout, { idempotencyKey: 'checkout:one' }),
      ).toEqual(first);
      time = new Date('2026-10-03T14:00:00Z');
      expect(
        (await request('/v1/billing/checkout_sessions', 'owner', checkout, 'checkout:one')).status,
      ).toBe(409);
      expect(calls.filter((c) => c.method === 'checkout')).toHaveLength(1);
    });
    it('checks platform account before the first effect', async () => {
      accountId = 'acct_wrong';
      expect(
        (await request('/v1/billing/customers', 'owner', customerInput, 'customer:one')).status,
      ).toBe(409);
      expect(calls.filter((c) => c.method === 'customer')).toHaveLength(0);
    });
    it('refuses portal configuration drift on the next call and immediate cancellation', async () => {
      await bindSubscription();
      await sdk().createPortalSession(
        { providerCustomerId: 'cus_one', returnUrl: checkout.returnUrl },
        { idempotencyKey: 'portal:one' },
      );
      portalUpdate = true;
      expect(
        (
          await request(
            '/v1/billing/portal_sessions',
            'owner',
            { providerCustomerId: 'cus_one', returnUrl: checkout.returnUrl },
            'portal:one',
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await request(
            '/v1/billing/portal_sessions',
            'owner',
            { providerCustomerId: 'cus_one', returnUrl: checkout.returnUrl },
            'portal:two',
          )
        ).status,
      ).toBe(409);
      portalUpdate = false;
      portalImmediate = true;
      expect(
        (
          await request(
            '/v1/billing/portal_sessions',
            'owner',
            { providerCustomerId: 'cus_one', returnUrl: checkout.returnUrl },
            'portal:three',
          )
        ).status,
      ).toBe(409);
      expect(calls.filter((c) => c.method === 'portal')).toHaveLength(1);
    });
    it('retains indeterminate result after timeout and retries same remote idempotency key', async () => {
      failCustomer = true;
      expect(
        (await request('/v1/billing/customers', 'owner', customerInput, 'customer:one')).status,
      ).toBe(503);
      expect((await gatewayDb().select().from(billingOperations))[0]?.state).toBe('indeterminate');
      failCustomer = false;
      await sdk().ensureCustomer(customerInput, { idempotencyKey: 'customer:one' });
      const effects = calls.filter((c) => c.method === 'customer');
      expect(effects).toHaveLength(2);
      expect(effects[0]?.key).toBe(effects[1]?.key);
    });
    async function completedCheckout() {
      await sdk().ensureCustomer(customerInput, { idempotencyKey: 'customer:one' });
      await verified.importPrice(owner, {
        providerPriceId: 'price_one',
        planId: 'plan:one',
        evidenceRef: 'fixture:verified-price',
      });
      await sdk().createCheckoutSession(checkout, { idempotencyKey: 'checkout:one' });
      hasCheckout = true;
    }
    it('binds exact completed checkout concurrently after URL expiry, ignoring arbitrary metadata', async () => {
      await completedCheckout();
      time = new Date('2026-10-03T14:00:00Z');
      const result = await Promise.all([
        sdk().retrieveSubscription('sub_one'),
        sdk().retrieveSubscription('sub_one'),
      ]);
      expect(result[0]).toEqual(result[1]);
      expect(result[0]).toMatchObject({ storeId: 'store:one', planId: 'plan:one' });
      expect(
        (await gatewayDb().select().from(billingObjectBindings)).filter(
          (value) => value.kind === 'subscription',
        ),
      ).toHaveLength(1);
      expect(await gatewayDb().select().from(recurringMirrors)).toHaveLength(1);
    });
    it('uniformly refuses unknown, ambiguous, incomplete or mismatched checkout correlation', async () => {
      expect((await request('/v1/billing/subscriptions/sub_one')).status).toBe(404);
      await completedCheckout();
      for (const variant of ['more', 'duplicate', 'incomplete', 'customer', 'price']) {
        hasMore = variant === 'more';
        duplicateCheckout = variant === 'duplicate';
        checkoutStatus = variant === 'incomplete' ? 'open' : 'complete';
        checkoutCustomer = variant === 'customer' ? 'cus_other' : 'cus_one';
        subscriptionPrice = variant === 'price' ? 'price_other' : 'price_one';
        if (variant === 'price')
          await verified.importPrice(owner, {
            providerPriceId: 'price_other',
            planId: 'plan:other',
            evidenceRef: 'fixture:other-price',
          });
        const response = await request('/v1/billing/subscriptions/sub_one');
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: { message: 'not_found' } });
      }
      expect(
        (await gatewayDb().select().from(billingObjectBindings)).filter(
          (value) => value.kind === 'subscription',
        ),
      ).toHaveLength(0);
    });
    it('does not adopt a completed checkout whose durable intent belongs to another merchant', async () => {
      const customer = await bindBillingObject(gatewayDb(), deployment, other, {
        kind: 'customer',
        providerRef: 'cus_other',
        externalSubjectRef: 'store:other',
        bindingEvidenceRef: 'fixture:other',
      });
      const price = await bindBillingObject(gatewayDb(), deployment, other, {
        kind: 'price',
        providerRef: 'price_other',
        planRef: 'plan:other',
        bindingEvidenceRef: 'fixture:other',
      });
      const claim = await claimBillingOperation(
        gatewayDb(),
        deployment,
        other,
        {
          operation: 'checkout',
          idempotencyKey: 'checkout:other',
          requestDigest: 'a'.repeat(64),
          customerBindingId: customer.id,
          priceBindingId: price.id,
        },
        now,
      );
      if (claim.kind !== 'claimed') throw new Error('Expected claim');
      await gatewayDb().transaction((tx) =>
        completeBillingOperation(
          tx,
          claim.operation,
          claim.leaseToken,
          { url: 'https://checkout.stripe.com/synthetic', expiresAt: '2026-10-03T13:00:00Z' },
          'cs_test_a11fixture',
          now,
        ),
      );
      hasCheckout = true;
      expect((await request('/v1/billing/subscriptions/sub_one')).status).toBe(404);
      expect(calls.filter((value) => value.method === 'readCheckout')).toHaveLength(0);
    });
    it('imports explicit evidence only within approved cohort and preserves store instead of metadata', async () => {
      await expect(
        verified.importCustomer(other, {
          providerCustomerId: 'cus_other',
          storeId: 'store:other',
          evidenceRef: 'fixture:import',
        }),
      ).rejects.toThrow('not_found');
      expect(calls).toHaveLength(0);
      const value = await verified.importCustomer(owner, {
        providerCustomerId: 'cus_one',
        storeId: 'store:one',
        evidenceRef: 'fixture:import',
      });
      expect(value.externalSubjectRef).toBe('store:one');
    });
    it('keeps absent boot configuration inactive and rejects another platform or unsafe portal at boot', async () => {
      expect(await configureBillingRuntime(gatewayDb(), undefined, client)).toBeUndefined();
      expect(calls).toHaveLength(0);
      const raw = JSON.stringify({
        deployment,
        portalConfigurationRef: 'bpc_one',
        cohorts: [{ ...owner, evidenceRef: 'fixture:cohort' }],
      });
      accountId = 'acct_wrong';
      await expect(configureBillingRuntime(gatewayDb(), raw, client)).rejects.toThrow(
        'identity_conflict',
      );
      accountId = deployment.platformAccountId;
      portalUpdate = true;
      await expect(configureBillingRuntime(gatewayDb(), raw, client)).rejects.toThrow(
        'identity_conflict',
      );
    });
    it('requires own registered fiscal adapters and pinned public keys before provider boot', async () => {
      const configuration = {
        deployment,
        portalConfigurationRef: 'bpc_one',
        cohorts: [{ ...owner, evidenceRef: 'fixture:cohort' }],
        finalInvoiceAuthorityAdapterRef: 'fiscal_one',
      };
      const raw = JSON.stringify(configuration);
      await expect(configureBillingRuntime(gatewayDb(), raw, client)).rejects.toThrow(
        'unavailable',
      );
      const adapter = {
        verificationKeys: {},
        read: async () => {
          throw new Error('fixture unavailable');
        },
      };
      await expect(
        configureBillingRuntime(gatewayDb(), raw, client, {
          finalInvoiceAuthorities: Object.create({ fiscal_one: adapter }),
        }),
      ).rejects.toThrow('unavailable');
      await expect(
        configureBillingRuntime(gatewayDb(), raw, client, {
          finalInvoiceAuthorities: { fiscal_one: adapter },
        }),
      ).rejects.toThrow('pinned verification keys');
      expect(calls).toHaveLength(0);
      const keys = generateKeyPairSync('ed25519');
      const valid = {
        ...adapter,
        verificationKeys: {
          fixture: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        },
      };
      expect(
        (
          await configureBillingRuntime(gatewayDb(), raw, client, {
            finalInvoiceAuthorities: { fiscal_one: valid },
          })
        )?.service,
      ).toBeDefined();
    });
    it('composes renewal workers with public merchant identities only within owned cohorts', async () => {
      const merchant = await findMerchantByAppEnvironment(
        gatewayDb(),
        owner.oxyAppId,
        owner.environment,
      );
      if (!merchant) throw new Error('Expected fixture merchant');
      const actor = {
        payerAccountId: 'payer_fixture',
        merchantId: merchant.publicId,
        appId: owner.oxyAppId,
        mode: 'test' as const,
        environment: owner.environment,
      };
      const configuration = {
        deployment,
        portalConfigurationRef: 'bpc_one',
        cohorts: [{ ...owner, evidenceRef: 'fixture:cohort' }],
        faircoinExecutorRef: 'wallet_fixture',
        faircoinActors: [actor],
      };
      const executor = {
        domain: 'fixture-provider-v1',
        recover: async () => ({ kind: 'not_found' as const }),
        execute: async () => ({ kind: 'indeterminate' as const }),
      };
      const adapters = { faircoinExecutors: { wallet_fixture: executor } };
      expect(merchant.publicId).not.toBe(owner.merchantId);
      expect(
        (
          await configureBillingRuntime(
            gatewayDb(),
            JSON.stringify(configuration),
            client,
            adapters,
          )
        )?.renewals?.actors,
      ).toEqual([actor]);
      await expect(
        configureBillingRuntime(
          gatewayDb(),
          JSON.stringify({
            ...configuration,
            faircoinActors: [{ ...actor, merchantId: owner.merchantId }],
          }),
          client,
          adapters,
        ),
      ).rejects.toThrow('outside configured cohorts');
      await expect(
        configureBillingRuntime(
          gatewayDb(),
          JSON.stringify({
            ...configuration,
            faircoinActors: [{ ...actor, appId: other.oxyAppId }],
          }),
          client,
          adapters,
        ),
      ).rejects.toThrow('outside configured cohorts');
    });
    it('composes owned observations only when explicitly enabled', async () => {
      const configuration = {
        deployment,
        portalConfigurationRef: 'bpc_one',
        cohorts: [{ ...owner, evidenceRef: 'fixture:cohort' }],
      };
      const disabled = await configureBillingRuntime(
        gatewayDb(),
        JSON.stringify(configuration),
        client,
      );
      expect(disabled?.service).toBeDefined();
      expect(disabled?.observations).toBeUndefined();
      expect(disabled?.relay).toBeUndefined();
      expect(disabled?.renewals).toBeUndefined();
      await expect(
        configureBillingRuntime(
          gatewayDb(),
          JSON.stringify({ ...configuration, faircoinExecutorRef: 'wallet_fixture' }),
          client,
        ),
      ).rejects.toThrow('explicit actor scope');
      await expect(
        configureBillingRuntime(
          gatewayDb(),
          JSON.stringify({
            ...configuration,
            faircoinExecutorRef: 'wallet_fixture',
            faircoinActors: [
              {
                payerAccountId: 'payer_fixture',
                merchantId: owner.merchantId,
                appId: owner.oxyAppId,
                mode: deployment.livemode ? 'live' : 'test',
                environment: owner.environment,
              },
            ],
          }),
          client,
        ),
      ).rejects.toThrow('unavailable');
      const enabled = await configureBillingRuntime(
        gatewayDb(),
        JSON.stringify({ ...configuration, observationsEnabled: true }),
        client,
      );
      expect(enabled?.observations?.deployment.environment).toBe(owner.environment);
      expect(enabled?.observations?.bindOwnedInvoice).toBeFunction();
      expect(enabled?.relay?.enabled).toBe(true);
      expect(enabled?.relay?.cohorts).toEqual([
        { ...owner, ...deployment, evidenceRef: 'fixture:cohort' },
      ]);
      await bindRecurringObject(
        gatewayDb(),
        { ...deployment, environment: other.environment, apiVersion: STRIPE_API_VERSION },
        {
          merchantId: other.merchantId,
          providerAccountId: null,
          kind: 'subscription',
          objectRef: 'sub_outside',
          bindingEvidenceRef: 'fixture:foreign',
        },
      );
      calls.length = 0;
      if (!enabled?.observations) throw new Error('Expected observation composition');
      await expect(
        enabled.observations.reader.readSnapshot({
          deployment: enabled.observations.deployment,
          providerAccountId: null,
          kind: 'subscription',
          objectRef: 'sub_outside',
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('not_found');
      expect(calls).toHaveLength(0);
    });
    it('SDK refreshes once after 401 and preserves the mutation key', async () => {
      retry401 = true;
      expect(await sdk().ensureCustomer(customerInput, { idempotencyKey: 'customer:one' })).toEqual(
        { providerCustomerId: 'cus_one' },
      );
      expect(calls.filter((value) => value.method === 'customer')).toHaveLength(1);
      expect((await gatewayDb().select().from(billingOperations))[0]?.idempotencyKey).toBe(
        'customer:one',
      );
    });

    it('exposes exact durable checkout correlation and rejects another merchant', async () => {
      await sdk().ensureCustomer(customerInput, { idempotencyKey: 'customer:correlation' });
      await bindBillingObject(gatewayDb(), deployment, owner, {
        kind: 'price',
        providerRef: 'price_one',
        planRef: 'plan:one',
        bindingEvidenceRef: 'fixture:price',
      });
      const hosted = await sdk().createCheckoutSession(checkout, {
        idempotencyKey: 'checkout:correlation',
      });
      expect(hosted.id).toBe('cs_test_a11fixture');
      const observed = await sdk().retrieveCheckout(hosted.id);
      expect(observed).toMatchObject({
        id: hosted.id,
        status: 'complete',
        storeId: 'store:one',
        planId: 'plan:one',
        subscription: { providerSubscriptionId: 'sub_one' },
      });
      expect((await request(`/v1/billing/checkout_sessions/${hosted.id}`, 'other')).status).toBe(
        404,
      );
    });
    it('reconciles same cancellation intent and allows a new action after external resume', async () => {
      await bindSubscription();
      await sdk().cancelAtPeriodEnd('sub_one', { idempotencyKey: 'cancel:action1' });
      await sdk().cancelAtPeriodEnd('sub_one', { idempotencyKey: 'cancel:action1' });
      expect(calls.filter((c) => c.method === 'cancel')).toHaveLength(1);
      cancelled = false;
      expect(
        (
          await request(
            '/v1/billing/subscriptions/sub_one/cancel_at_period_end',
            'owner',
            {},
            'cancel:action1',
          )
        ).status,
      ).toBe(409);
      expect(calls.filter((c) => c.method === 'cancel')).toHaveLength(1);
      await sdk().cancelAtPeriodEnd('sub_one', { idempotencyKey: 'cancel:action2' });
      expect(cancelled).toBe(true);
      expect(calls.filter((c) => c.method === 'cancel')).toHaveLength(2);
    });

    it('serves paid-period evidence via scoped SDK with exact merchant isolation', async () => {
      await bindSubscription();
      const invoice = {
        id: 'in_one',
        customer: 'cus_one',
        livemode: false,
        status: 'paid',
        pre_payment_credit_notes_amount: 0,
        post_payment_credit_notes_amount: 0,
        currency: 'usd',
        total: 2999,
        amount_paid: 2999,
        amount_due: 2999,
        amount_remaining: 0,
        total_excluding_tax: 2500,
        parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_one' } },
      };
      client.listChargeRefunds = async () => ({ has_more: false, data: [] });
      client.retrieveInvoice = async () => invoice;
      client.listInvoiceLines = async () => ({
        has_more: false,
        data: [
          {
            id: 'il_one',
            invoice: 'in_one',
            livemode: false,
            subscription: 'sub_one',
            quantity: 1,
            amount: 2500,
            parent: {
              type: 'subscription_item_details',
              subscription_item_details: { subscription: 'sub_one', proration: false },
            },
            pricing: { price_details: { price: 'price_one' } },
            period: { start: 1791028800, end: 1793707200 },
          },
        ],
      });
      client.listInvoicePayments = async () => ({
        has_more: false,
        data: [
          {
            id: 'inpay_one',
            invoice: 'in_one',
            livemode: false,
            currency: 'usd',
            status: 'paid',
            amount_paid: 2999,
            payment: { type: 'payment_intent', payment_intent: 'pi_one' },
            status_transitions: { paid_at: 1791028800 },
          },
        ],
      });
      client.retrievePaidPaymentIntent = async () => ({
        id: 'pi_one',
        customer: 'cus_one',
        livemode: false,
        currency: 'usd',
        status: 'succeeded',
        amount_received: 2999,
        latest_charge: {
          id: 'ch_one',
          payment_intent: 'pi_one',
          customer: 'cus_one',
          currency: 'usd',
          livemode: false,
          paid: true,
          captured: true,
          amount_captured: 2999,
          amount_refunded: 0,
          refunded: false,
          disputed: false,
        },
      });
      expect(await sdk().retrievePaidInvoice('sub_one', 'in_one')).toMatchObject({
        invoiceId: 'in_one',
        storeId: 'store:one',
        planId: 'plan:one',
        amountPaid: '2999',
        netAmount: '2500',
        taxAmount: '499',
      });
      expect(
        (await request('/v1/billing/subscriptions/sub_one/paid_invoices/in_one', 'other')).status,
      ).toBe(404);
      expect(
        (await request('/v1/billing/subscriptions/sub_one/paid_invoices/in_one', 'noScope')).status,
      ).toBe(403);
      expect(await sdk().retrieveInvoiceState('sub_one', 'in_one')).toMatchObject({
        state: 'paid',
        amountRefunded: '0',
      });
      expect(
        (await request('/v1/billing/subscriptions/sub_one/invoice_authorities/in_one')).status,
      ).toBe(404);
      expect(
        (
          await request('/v1/billing/tax_quotes', 'owner', {
            storeId: 'store:one',
            planId: 'plan:one',
            customerLocationEvidenceId: 'location_fixture',
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await request('/v1/billing/tax_quotes', 'noScope', {
            storeId: 'store:one',
            planId: 'plan:one',
            customerLocationEvidenceId: 'location_fixture',
          })
        ).status,
      ).toBe(403);
      const keys = generateKeyPairSync('ed25519');
      const verificationKeys = {
        fixture: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      };
      time = new Date();
      finalAuthorityReader = {
        verificationKeys,
        async read({ owner: invoiceOwner, merchantPublicId, invoice: paid }) {
          const authority: BillingFinalInvoiceAuthority = {
            schemaVersion: 1,
            source: {
              invoiceId: paid.invoiceId,
              paymentIntentId: paid.paymentIntentId,
              customerId: paid.providerCustomerId,
              subscriptionId: paid.providerSubscriptionId,
              priceId: paid.providerPriceId,
              planId: paid.planId,
              merchantId: merchantPublicId,
              appId: invoiceOwner.oxyAppId,
              mode: 'test',
              environment: invoiceOwner.environment,
            },
            invoice: {
              platform: 'peable',
              currency: paid.currency,
              grossMinorUnits: 2999,
              netMinorUnits: 2500,
              taxMinorUnits: 499,
              merchantFeeMinorUnits: 0,
              taxTreatment: 'inclusive',
              sellerId: 'seller_fixture',
              invoiceIssuerId: 'issuer_fixture',
              taxQuoteId: 'quote_fixture',
              customerLocationEvidenceId: 'location_fixture',
              taxRateEvidenceId: 'rate_fixture',
              context: {
                payerAccountId: paid.storeId,
                beneficiaryAccountId: paid.storeId,
                providerSubscriptionId: paid.providerSubscriptionId,
                offerId: 'offer_fixture',
                offerVersion: 1,
                periodStart: paid.periodStart,
                periodEnd: paid.periodEnd,
                mode: 'test',
                environment: invoiceOwner.environment,
              },
              issuedAt: time.toISOString(),
              expiresAt: new Date(time.getTime() + 60_000).toISOString(),
            },
            method: 'card',
            signature: { algorithm: 'Ed25519', keyId: 'fixture', value: '' },
          };
          authority.signature.value = sign(
            null,
            Buffer.from(canonicalBillingAuthority(authority)),
            keys.privateKey,
          ).toString('base64url');
          return authority;
        },
      };
      const verifiedSdk = new Peable({
        baseURL: base,
        oxyApiUrl: base,
        publicKey: 'fixture-public',
        secret: 'fixture-secret',
        invoiceAuthorityKeys: verificationKeys,
      });
      expect(
        await verifiedSdk.billing.retrieveFinalInvoiceAuthority('sub_one', 'in_one'),
      ).toMatchObject({
        source: { invoiceId: 'in_one', appId: owner.oxyAppId },
        invoice: { grossMinorUnits: 2999 },
      });
      expect(
        (await request('/v1/billing/subscriptions/sub_one/invoice_authorities/in_one', 'other'))
          .status,
      ).toBe(404);
      expect(
        (await request('/v1/billing/subscriptions/sub_one/invoice_authorities/in_one', 'noScope'))
          .status,
      ).toBe(403);

      expect(
        (await request('/v1/billing/subscriptions/sub_one/invoice_states/in_one', 'other')).status,
      ).toBe(404);
      expect(
        (await request('/v1/billing/subscriptions/sub_one/invoice_states/in_one', 'noScope'))
          .status,
      ).toBe(403);
      invoice.amount_paid = 1;
      expect(
        (await request('/v1/billing/subscriptions/sub_one/paid_invoices/in_one')).status,
      ).not.toBe(200);
    });
  },
);
