import { setStripeModes, stripeModeFixture } from '../../../__tests__/helpers/stripeModes';
import { must } from '../../../__tests__/helpers/must';
import { eq } from 'drizzle-orm';
import type { BillingCheckoutOperationReader } from '../billingService';
import type { BillingTaxQuoteCalculator } from '../tax-quote';
import type { BillingTaxCheckoutAdapter } from '../tax-checkout';
import { findMerchantByAppEnvironment } from '../../../db/merchants/merchantRepository';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  canonicalBillingAuthority,
  canonicalBillingTaxQuote,
  type BillingTaxQuote,
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
  requireBillingBinding,
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
import { toUnix } from '../../../lib/time';
const deployment = {
  provider: 'stripe' as const,
  platformAccountId: 'acct_platform',
  livemode: false,
};
const now = new Date('2026-10-03T12:00:00Z');
const customerInput = { store_id: 'store:one', store_name: 'Synthetic Store' };
const checkout = {
  provider_customer_id: 'cus_one',
  provider_price_id: 'price_one',
  trial_days: 0,
  return_url: 'https://example.invalid/billing?from=plans',
  store_id: 'store:one',
  plan_id: 'plan:one',
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
    let checkoutOperationReader: BillingCheckoutOperationReader | undefined;
    let taxCalculator: BillingTaxQuoteCalculator | undefined;
    let taxCheckoutAdapter: BillingTaxCheckoutAdapter | undefined;
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
          return {
            id: accountId,
            charges_enabled: true,
            capabilities: { card_payments: 'active' },
          };
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
          const item = snapshot.items.data[0];
          if (!item) throw new Error('Missing subscription item');
          item.price.id = subscriptionPrice;
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
        embeddedPublishableKey: 'pk_test_fixture',
        now: () => time,
      });
      const cohorts: BillingCohort[] = [
        {
          ...owner,
          ...deployment,
          evidenceRef: 'fixture:approved-cohort',
        },
      ];
      verified = createVerifiedBillingBindings({
        db: gatewayDb(),
        client,
        deployment,
        cohorts,
        now: () => time,
      });
      finalAuthorityReader = undefined;
      checkoutOperationReader = undefined;
      taxCalculator = undefined;
      taxCheckoutAdapter = undefined;
      const service = createBillingService({
        db: gatewayDb(),
        provider,
        cohorts,
        verifiedBindings: verified,
        now: () => time,
        get checkoutOperationReader() {
          return checkoutOperationReader;
        },
        get taxQuoteCalculator() {
          return taxCalculator;
        },
        get taxCheckoutAdapter() {
          return taxCheckoutAdapter;
        },
        get finalInvoiceAuthority() {
          return finalAuthorityReader;
        },
      });
      const auth: RequestHandler = (req, _res, next) => {
        if (retry401) {
          retry401 = false;
          // The gateway's own envelope, as `requireServiceApp` answers an expired token.
          _res.status(401).json({
            error: { type: 'authentication_error', message: 'synthetic_expiry', request_id: null },
          });
          return;
        }
        const token = req.header('Authorization')?.replace('Bearer ', '');
        const selected = token === 'other' ? other : owner;
        if (token !== 'missing')
          (req as OxyAuthRequest).serviceApp = {
            appId: token === 'wrongApp' ? 'app_unknown' : selected.oxyAppId,
            environment: token === 'wrongEnvironment' ? 'staging' : selected.environment,
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
    function configurePaidEvidence() {
      const invoice = {
        id: 'in_one',
        billing_reason: 'subscription_create',
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
      return invoice;
    }
    async function fiscalFixture(quoteLifetimeMs = 60_000) {
      time = new Date();
      await sdk().ensureCustomer(customerInput, { idempotencyKey: 'customer:quoted' });
      await bindBillingObject(gatewayDb(), deployment, owner, {
        kind: 'price',
        providerRef: checkout.provider_price_id,
        planRef: checkout.plan_id,
        bindingEvidenceRef: 'fixture:quoted-price',
      });
      const keys = generateKeyPairSync('ed25519');
      const verificationKeys = {
        fixture: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      };
      const product = {
        configurationApproved: true,
        planId: checkout.plan_id,
        currency: 'USD',
        grossMinorUnits: 2999,
        taxTreatment: 'inclusive',
        sellerId: 'seller_fixture',
        invoiceIssuerId: 'issuer_fixture',
        taxRemitterId: 'remitter_fixture',
        taxServiceRef: 'tax_fixture',
        allowedCountries: ['RO'],
        coverageEvidenceId: 'coverage_fixture',
      };
      const location = {
        id: 'location_fixture',
        storeId: checkout.store_id,
        appId: owner.oxyAppId,
        mode: 'test',
        environment: owner.environment,
        country: 'RO',
        observedAt: time.toISOString(),
        expiresAt: new Date(time.getTime() + 300_000).toISOString(),
      };
      const offer = {
        providerPriceId: checkout.provider_price_id,
        planId: checkout.plan_id,
        offerId: 'offer_fixture',
        offerVersion: 1,
        interval: 'month' as const,
        intervalCount: 1 as const,
        currency: 'USD',
        grossMinorUnits: 2999,
        taxTreatment: 'inclusive' as const,
      };
      const resign = (quote: BillingTaxQuote) => {
        quote.signature.value = sign(
          null,
          Buffer.from(canonicalBillingTaxQuote(quote)),
          keys.privateKey,
        ).toString('base64url');
        return quote;
      };
      taxCalculator = {
        verificationKeys,
        async resolveProduct() {
          return product;
        },
        async readCustomerLocation() {
          return location;
        },
        async calculate({ source }) {
          return resign({
            schema_version: 2,
            source,
            quote: {
              id: 'quote_fixture',
              currency: 'USD',
              gross_minor_units: 2999,
              net_minor_units: 2500,
              tax_minor_units: 499,
              tax_treatment: 'inclusive',
              seller_id: 'seller_fixture',
              invoice_issuer_id: 'issuer_fixture',
              tax_remitter_id: 'remitter_fixture',
              tax_service_ref: 'tax_fixture',
              country: 'RO',
              coverage_evidence_id: 'coverage_fixture',
              tax_rate_evidence_id: 'rate_fixture',
              customer_location_evidence_id: location.id,
              quoted_at: toUnix(time),
              expires_at: toUnix(new Date(time.getTime() + quoteLifetimeMs)),
            },
            signature: { algorithm: 'Ed25519', key_id: 'fixture', value: '' },
          });
        },
      };
      let invoiceMutation = (_authority: BillingFinalInvoiceAuthority) => {};
      finalAuthorityReader = {
        verificationKeys,
        async read({ owner: actor, merchantPublicId, invoice: paid, taxCheckoutSnapshot }) {
          if (!taxCheckoutSnapshot) throw new Error('Missing persisted checkout quote');
          const quote = taxCheckoutSnapshot.taxQuote.quote;
          const authority: BillingFinalInvoiceAuthority = {
            schema_version: 2,
            source: {
              invoice_id: paid.invoice_id,
              payment_intent_id: paid.payment_intent_id,
              customer_id: paid.provider_customer_id,
              subscription_id: paid.provider_subscription_id,
              price_id: paid.provider_price_id,
              plan_id: paid.plan_id,
              merchant_id: merchantPublicId,
              app_id: actor.oxyAppId,
              mode: 'test',
              environment: actor.environment,
            },
            invoice: {
              platform: 'peable',
              currency: quote.currency,
              gross_minor_units: quote.gross_minor_units,
              net_minor_units: quote.net_minor_units,
              tax_minor_units: quote.tax_minor_units,
              merchant_fee_minor_units: 0,
              tax_treatment: quote.tax_treatment,
              seller_id: quote.seller_id,
              invoice_issuer_id: quote.invoice_issuer_id,
              tax_quote_id: quote.id,
              customer_location_evidence_id: quote.customer_location_evidence_id,
              tax_rate_evidence_id: quote.tax_rate_evidence_id,
              context: {
                payer_account_id: paid.store_id,
                beneficiary_account_id: paid.store_id,
                provider_subscription_id: paid.provider_subscription_id,
                offer_id: taxCheckoutSnapshot.offer.offerId,
                offer_version: taxCheckoutSnapshot.offer.offerVersion,
                period_start: paid.period_start,
                period_end: paid.period_end,
                mode: 'test',
                environment: actor.environment,
              },
              issued_at: toUnix(time),
              expires_at: toUnix(time) + 60,
            },
            method: 'card',
            signature: { algorithm: 'Ed25519', key_id: 'fixture', value: '' },
          };
          invoiceMutation(authority);
          authority.signature.value = sign(
            null,
            Buffer.from(canonicalBillingAuthority(authority)),
            keys.privateKey,
          ).toString('base64url');
          return authority;
        },
      };
      taxCheckoutAdapter = {
        async resolveOffer() {
          return offer;
        },
        async createCheckout(input, key) {
          calls.push({ method: 'quotedCheckout', params: input, key });
          return {
            providerObjectRef: 'cs_test_a11fixture',
            providerCustomerId: checkout.provider_customer_id,
            livemode: false,
            url: 'https://example.invalid/quoted-checkout',
            expiresAt: input.snapshot.taxQuote.quote.expires_at,
          };
        },
      };
      const fiscalSdk = new Peable({
        baseURL: base,
        oxyApiUrl: base,
        publicKey: 'fixture-public',
        secret: 'fixture-secret',
        taxQuoteAuthorityKeys: verificationKeys,
        invoiceAuthorityKeys: verificationKeys,
      }).billing;
      const quote = await fiscalSdk.createTaxQuote({
        store_id: checkout.store_id,
        plan_id: checkout.plan_id,
        customer_location_evidence_id: location.id,
      });
      return {
        quote,
        offer,
        location,
        product,
        resign,
        fiscalSdk,
        setInvoiceMutation(fn: typeof invoiceMutation) {
          invoiceMutation = fn;
        },
      };
    }
    it('preserves embedded fiscal checkout through the configured runtime composition', async () => {
      const fixture = await fiscalFixture();
      const adapter = must(taxCheckoutAdapter);
      let embeddedCalls = 0;
      adapter.createEmbeddedCheckout = async (input) => {
        embeddedCalls++;
        return {
          providerObjectRef: 'cs_test_runtime',
          providerCustomerId: checkout.provider_customer_id,
          livemode: false,
          presentation: 'embedded',
          expiresAt: input.snapshot.taxQuote.quote.expires_at,
        };
      };
      const restore = setStripeModes({
        test: stripeModeFixture('test', { publishableKey: 'pk_test_fixture' }),
      });
      try {
        const runtime = must(
          await configureBillingRuntime(
            gatewayDb(),
            JSON.stringify({
              deployment,
              portalConfigurationRef: 'bpc_one',
              cohorts: [{ ...owner, evidenceRef: 'fixture:runtime', requireTaxQuote: true }],
              taxQuoteAdapterRef: 'fixture',
              taxCheckoutAdapterRef: 'fixture',
              finalInvoiceAuthorityAdapterRef: 'fixture',
            }),
            client,
            {
              taxQuoteCalculators: { fixture: must(taxCalculator) },
              taxCheckoutAdapters: { fixture: adapter },
              finalInvoiceAuthorities: { fixture: must(finalAuthorityReader) },
            },
          ),
        );
        const create = must(runtime.service.createEmbeddedCheckoutSession);
        const result = await create(
          owner,
          { ...checkout, tax_quote: fixture.quote },
          'runtime:embedded',
        );
        expect(result).toMatchObject({ id: 'cs_test_runtime', presentation: 'embedded' });
        expect(
          await create(owner, { ...checkout, tax_quote: fixture.quote }, 'runtime:embedded'),
        ).toEqual(result);
        expect(embeddedCalls).toBe(1);
      } finally {
        restore();
      }
    });

    it('creates an owned fiscal embedded session, keeps secrets ephemeral and closes completed/expired actions', async () => {
      const fixture = await fiscalFixture();
      const adapter = must(taxCheckoutAdapter);
      let created = 0;
      adapter.createEmbeddedCheckout = async (input) => {
        created++;
        return {
          providerObjectRef: 'cs_test_embedded',
          providerCustomerId: checkout.provider_customer_id,
          livemode: false,
          presentation: 'embedded',
          expiresAt: input.snapshot.taxQuote.quote.expires_at,
        };
      };
      const raw = {
        id: 'cs_test_embedded',
        customer: checkout.provider_customer_id,
        livemode: false,
        mode: 'subscription',
        ui_mode: 'elements',
        automatic_tax: { enabled: false },
        status: 'open',
        client_secret: 'cs_test_embedded_secret_ephemeral',
        expires_at: fixture.quote.quote.expires_at,
        amount_total: fixture.quote.quote.gross_minor_units,
        currency: 'usd',
        total_details: { amount_tax: fixture.quote.quote.tax_minor_units },
        line_items: {
          has_more: false,
          data: [{ quantity: 1, price: { id: checkout.provider_price_id } }],
        },
      };
      let readCount = 0;
      client.retrieveEmbeddedCheckout = async () => {
        readCount++;
        return structuredClone(raw);
      };
      const configuration = await fixture.fiscalSdk.embeddedCheckoutConfiguration();
      expect(configuration.publishable_key).toBe('pk_test_fixture');
      expect(configuration.scope.app_id).toBe(owner.oxyAppId);
      const input = { ...checkout, tax_quote: fixture.quote };
      const session = await fixture.fiscalSdk.createEmbeddedCheckoutSession(input, {
        idempotencyKey: 'embedded:one',
      });
      expect(session).toEqual({
        id: 'cs_test_embedded',
        presentation: 'embedded',
        expires_at: fixture.quote.quote.expires_at,
      });
      expect(
        await fixture.fiscalSdk.createEmbeddedCheckoutSession(input, {
          idempotencyKey: 'embedded:one',
        }),
      ).toEqual(session);
      expect(created).toBe(1);
      expect(
        (await request('/v1/billing/checkout_sessions', 'owner', input, 'embedded:one')).status,
      ).toBe(409);
      const binding = await fixture.fiscalSdk.retrieveEmbeddedCheckoutAction(session.id);
      expect(binding.status).toBe('open');
      expect(binding.action?.client_secret).toBe(raw.client_secret);
      expect(binding.scope.store_id).toBe(checkout.store_id);
      expect(binding.tax_quote).toEqual(fixture.quote);
      expect(JSON.stringify(await gatewayDb().select().from(billingOperations))).not.toContain(
        raw.client_secret,
      );
      expect(
        (
          await request(
            `/v1/billing/embedded_checkout_sessions/${session.id}/client_action`,
            'other',
          )
        ).status,
      ).toBe(404);
      expect(readCount).toBe(1);
      for (const patch of [
        { amount_total: 1 },
        { currency: 'eur' },
        { customer: 'cus_foreign' },
        { livemode: true },
        { ui_mode: 'hosted' },
        { automatic_tax: { enabled: true } },
        {
          line_items: { has_more: false, data: [{ quantity: 1, price: { id: 'price_foreign' } }] },
        },
      ]) {
        client.retrieveEmbeddedCheckout = async () => ({ ...structuredClone(raw), ...patch });
        expect(
          (await request(`/v1/billing/embedded_checkout_sessions/${session.id}/client_action`)).ok,
        ).toBe(false);
      }
      client.retrieveEmbeddedCheckout = async () => ({
        ...structuredClone(raw),
        status: 'complete',
        client_secret: null,
      });
      expect(await fixture.fiscalSdk.retrieveEmbeddedCheckoutAction(session.id)).toMatchObject({
        status: 'complete',
        action: null,
      });
      client.retrieveEmbeddedCheckout = async () => ({
        ...structuredClone(raw),
        status: 'expired',
        client_secret: null,
      });
      expect(await fixture.fiscalSdk.retrieveEmbeddedCheckoutAction(session.id)).toMatchObject({
        status: 'expired',
        action: null,
      });
      accountId = 'acct_foreign';
      expect((await request('/v1/billing/embedded_checkout_configuration')).ok).toBe(false);
    });
    it('does not offer embedded checkout without configured fiscal authority or a signed quote', async () => {
      expect((await request('/v1/billing/embedded_checkout_configuration')).status).toBe(404);
      expect(
        (
          await request(
            '/v1/billing/embedded_checkout_sessions',
            'owner',
            checkout,
            'embedded:noquote',
          )
        ).status,
      ).toBe(404);
      expect(calls.some((call) => call.method === 'checkout')).toBe(false);
    });
    it('persists the signed inclusive quote through the real HTTP SDK boundary and rejects reuse under another key', async () => {
      const fixture = await fiscalFixture();
      const input = { ...checkout, tax_quote: fixture.quote };
      const first = await fixture.fiscalSdk.createCheckoutSession(input, {
        idempotencyKey: 'quoted:one',
      });
      expect(
        await fixture.fiscalSdk.createCheckoutSession(input, { idempotencyKey: 'quoted:one' }),
      ).toEqual(first);
      expect(
        (await request('/v1/billing/checkout_sessions', 'owner', input, 'quoted:two')).status,
      ).toBe(409);
      const row = (await gatewayDb().select().from(billingOperations)).find(
        (value) => value.operation === 'checkout',
      );
      expect(row?.taxCheckoutSnapshot?.taxQuote).toEqual(fixture.quote);
      expect(row?.taxCheckoutSnapshot?.offer).toEqual(fixture.offer);
      const replacementQuote = structuredClone(fixture.quote);
      replacementQuote.quote.tax_rate_evidence_id = 'rate_replacement';
      fixture.resign(replacementQuote);
      expect(
        (
          await request(
            '/v1/billing/checkout_sessions',
            'owner',
            { ...checkout, tax_quote: replacementQuote },
            'quoted:one',
          )
        ).status,
      ).toBe(409);
      fixture.offer.offerVersion++;
      expect(
        (await request('/v1/billing/checkout_sessions', 'owner', input, 'quoted:one')).status,
      ).toBe(409);
      expect(calls.filter((value) => value.method === 'quotedCheckout')).toHaveLength(1);
      expect(calls.filter((value) => value.method === 'checkout')).toHaveLength(0);
    });
    it('refuses signed foreign actors, expiry, price/offer drift and tampering before any checkout effect', async () => {
      const fixture = await fiscalFixture();
      const mutations = [
        (quote: BillingTaxQuote) => {
          quote.source.merchant_id = 'merch_other';
        },
        (quote: BillingTaxQuote) => {
          quote.source.app_id = 'app_other';
        },
        (quote: BillingTaxQuote) => {
          quote.source.store_id = 'store:other';
        },
        (quote: BillingTaxQuote) => {
          quote.source.plan_id = 'plan:other';
        },
        (quote: BillingTaxQuote) => {
          quote.source.environment = 'production';
          quote.source.mode = 'live';
        },
        (quote: BillingTaxQuote) => {
          quote.quote.expires_at = toUnix(time);
        },
        (quote: BillingTaxQuote) => {
          quote.quote.net_minor_units++;
        },
        (quote: BillingTaxQuote) => {
          quote.quote.seller_id = 'seller_other';
        },
      ];
      for (const mutate of mutations) {
        const quote = structuredClone(fixture.quote);
        mutate(quote);
        fixture.resign(quote);
        expect(
          (
            await request(
              '/v1/billing/checkout_sessions',
              'owner',
              { ...checkout, tax_quote: quote },
              'quoted:bad',
            )
          ).status,
        ).not.toBe(200);
      }
      const tampered = structuredClone(fixture.quote);
      tampered.quote.tax_rate_evidence_id = 'rate_other';
      expect(
        (
          await request(
            '/v1/billing/checkout_sessions',
            'owner',
            { ...checkout, tax_quote: tampered },
            'quoted:tampered',
          )
        ).status,
      ).toBe(502);
      fixture.offer.grossMinorUnits++;
      expect(
        (
          await request(
            '/v1/billing/checkout_sessions',
            'owner',
            { ...checkout, tax_quote: fixture.quote },
            'quoted:price',
          )
        ).status,
      ).toBe(409);
      fixture.offer.grossMinorUnits--;
      fixture.offer.providerPriceId = 'price_other';
      expect(
        (
          await request(
            '/v1/billing/checkout_sessions',
            'owner',
            { ...checkout, tax_quote: fixture.quote },
            'quoted:offer',
          )
        ).status,
      ).toBe(409);
      expect(
        calls.filter((value) => ['checkout', 'quotedCheckout'].includes(value.method)),
      ).toHaveLength(0);
    });
    it('closes quoted checkout when the trusted adapter is absent and preserves legacy checkout explicitly', async () => {
      const fixture = await fiscalFixture();
      taxCheckoutAdapter = undefined;
      expect(
        (
          await request(
            '/v1/billing/checkout_sessions',
            'owner',
            { ...checkout, tax_quote: fixture.quote },
            'quoted:disabled',
          )
        ).status,
      ).toBe(404);
      expect(calls.filter((value) => value.method === 'checkout')).toHaveLength(0);
      client.createCheckout = async () => ({
        id: 'cs_test_a11fixture',
        customer: 'cus_one',
        mode: 'subscription',
        livemode: false,
        url: 'https://example.invalid/legacy-checkout',
        expires_at: Math.floor(time.getTime() / 1000) + 3600,
      });
      expect(
        await sdk().createCheckoutSession(checkout, { idempotencyKey: 'legacy:allowed' }),
      ).toMatchObject({ id: 'cs_test_a11fixture' });
    });
    it('verifies final invoice fiscal fields against the persisted checkout even after quote expiry', async () => {
      // Instants are whole Unix seconds: a 1 s lifetime truncates to an
      // `expires_at` that can already be the current second, and the SDK
      // rightly refuses an expired quote. Two seconds always leaves one.
      const fixture = await fiscalFixture(2000);
      await fixture.fiscalSdk.createCheckoutSession(
        { ...checkout, tax_quote: fixture.quote },
        { idempotencyKey: 'quoted:invoice' },
      );
      hasCheckout = true;
      expect(await sdk().retrieveCheckout('cs_test_a11fixture')).toMatchObject({
        subscription: { provider_subscription_id: 'sub_one' },
      });
      const providerInvoice = configurePaidEvidence();
      await new Promise((resolve) => setTimeout(resolve, 3100));
      time = new Date();
      fixture.product.invoiceIssuerId = 'current_unrelated_issuer';
      expect(
        await fixture.fiscalSdk.retrieveFinalInvoiceAuthority('sub_one', 'in_one'),
      ).toMatchObject({
        invoice: {
          tax_quote_id: fixture.quote.quote.id,
          invoice_issuer_id: 'issuer_fixture',
          context: { offer_version: 1 },
        },
      });
      for (const mutation of [
        (authority: BillingFinalInvoiceAuthority) => {
          authority.invoice.tax_quote_id = 'quote_other';
        },
        (authority: BillingFinalInvoiceAuthority) => {
          authority.invoice.customer_location_evidence_id = 'location_other';
        },
        (authority: BillingFinalInvoiceAuthority) => {
          authority.invoice.seller_id = 'seller_other';
        },
        (authority: BillingFinalInvoiceAuthority) => {
          authority.invoice.tax_rate_evidence_id = 'rate_other';
        },
        (authority: BillingFinalInvoiceAuthority) => {
          authority.invoice.context.offer_version++;
        },
      ]) {
        fixture.setInvoiceMutation(mutation);
        expect(
          (await request('/v1/billing/subscriptions/sub_one/invoice_authorities/in_one')).status,
        ).toBe(502);
      }
      expect(
        (await request('/v1/billing/subscriptions/sub_one/invoice_authorities/in_one', 'other'))
          .status,
      ).toBe(404);
      fixture.setInvoiceMutation(() => {});
      providerInvoice.billing_reason = 'subscription_cycle';
      expect(
        (await request('/v1/billing/subscriptions/sub_one/invoice_authorities/in_one')).status,
      ).toBe(409);
    });
    it('claims a signed quote once under concurrent keys before any provider effect', async () => {
      const fixture = await fiscalFixture();
      const originalAdapter = taxCheckoutAdapter;
      if (!originalAdapter) throw new Error('Missing adapter');
      let release = () => {};
      let entered = () => {};
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      const dispatched = new Promise<void>((resolve) => {
        entered = resolve;
      });
      taxCheckoutAdapter = {
        ...originalAdapter,
        async createCheckout(input, key) {
          entered();
          await paused;
          return originalAdapter.createCheckout(input, key);
        },
      };
      const input = { ...checkout, tax_quote: fixture.quote };
      const first = request(
        '/v1/billing/checkout_sessions',
        'owner',
        input,
        'quoted:concurrent-one',
      );
      try {
        await dispatched;
        expect(
          (await request('/v1/billing/checkout_sessions', 'owner', input, 'quoted:concurrent-two'))
            .status,
        ).toBe(409);
        expect(
          (await request('/v1/billing/checkout_sessions', 'owner', input, 'quoted:concurrent-one'))
            .status,
        ).toBe(409);
      } finally {
        release();
      }
      expect((await first).status).toBe(200);
      expect(calls.filter((value) => value.method === 'quotedCheckout')).toHaveLength(1);
    });
    it('refuses expiry during deployment verification without dispatch and enforces quote-required cohorts', async () => {
      const fixture = await fiscalFixture();
      const account = client.account;
      client.account = async () => {
        time = new Date(time.getTime() + 120_000);
        return account();
      };
      expect(
        (
          await request(
            '/v1/billing/checkout_sessions',
            'owner',
            { ...checkout, tax_quote: fixture.quote },
            'quoted:expired-before-dispatch',
          )
        ).status,
      ).toBe(409);
      expect(
        calls.filter((value) => ['checkout', 'quotedCheckout'].includes(value.method)),
      ).toHaveLength(0);
      const service = createBillingService({
        db: gatewayDb(),
        provider: createStripeBillingProvider(deployment, client, {
          portalConfigurationRef: 'bpc_one',
        }),
        cohorts: [
          { ...owner, ...deployment, evidenceRef: 'fixture:quote-required', requireTaxQuote: true },
        ],
      });
      await expect(
        service.createCheckoutSession(owner, checkout, 'quoted:missing'),
      ).rejects.toThrow('not_found');
      await expect(
        configureBillingRuntime(
          gatewayDb(),
          JSON.stringify({
            deployment,
            portalConfigurationRef: 'bpc_one',
            cohorts: [{ ...owner, evidenceRef: 'fixture:quote-required', requireTaxQuote: true }],
          }),
          client,
        ),
      ).rejects.toThrow('Quote-required cohort');
    });
    it('executes five SDK methods with store/receipt references and no Connect or financial decisions', async () => {
      expect(await sdk().ensureCustomer(customerInput, { idempotencyKey: 'customer:one' })).toEqual(
        { provider_customer_id: 'cus_one' },
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
        (await sdk().createCheckoutSession(checkout, { idempotencyKey: 'checkout:one' }))
          .expires_at,
      ).toBe(1791032400);
      expect(
        (
          await sdk().createPortalSession(
            { provider_customer_id: 'cus_one', return_url: checkout.return_url },
            { idempotencyKey: 'portal:one' },
          )
        ).expires_at,
      ).toBe(1791028860);
      expect(await sdk().retrieveSubscription('sub_one')).toMatchObject({
        store_id: 'store:one',
        plan_id: 'plan:one',
        provider_customer_id: 'cus_one',
        cancel_at_period_end: false,
        current_period_start: 1791028800,
        current_period_end: 1793707200,
      });
      expect(
        await sdk().cancelAtPeriodEnd('sub_one', { idempotencyKey: 'cancel:one' }),
      ).toMatchObject({ cancel_at_period_end: true, store_id: 'store:one', cancel_at: 1793707200 });
      expect(calls.find((c) => c.method === 'cancel')?.params).toEqual({
        ref: 'sub_one',
        cancel_at_period_end: true,
      });
      expect(calls.find((c) => c.method === 'checkout')?.params).toMatchObject({
        mode: 'subscription',
        adaptive_pricing: { enabled: false },
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
          { ...customerInput, store_name: 'Renamed' },
          { idempotencyKey: 'customer:one' },
        ),
      ).toEqual({ provider_customer_id: 'cus_one' });
      expect(
        await sdk().ensureCustomer(
          { ...customerInput, store_name: 'Renamed' },
          { idempotencyKey: 'customer:two' },
        ),
      ).toEqual({ provider_customer_id: 'cus_one' });
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
        { ...checkout, provider_price_id: 'price_unknown' },
        { ...checkout, store_id: 'store:other' },
        { ...checkout, subject_account_id: 'invented' },
        { ...checkout, merchant_id: other.merchantId },
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
        { provider_customer_id: 'cus_one', return_url: checkout.return_url },
        { idempotencyKey: 'portal:one' },
      );
      portalUpdate = true;
      expect(
        (
          await request(
            '/v1/billing/portal_sessions',
            'owner',
            { provider_customer_id: 'cus_one', return_url: checkout.return_url },
            'portal:one',
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await request(
            '/v1/billing/portal_sessions',
            'owner',
            { provider_customer_id: 'cus_one', return_url: checkout.return_url },
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
            { provider_customer_id: 'cus_one', return_url: checkout.return_url },
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
      expect(result[0]).toMatchObject({ store_id: 'store:one', plan_id: 'plan:one' });
      expect(
        (await gatewayDb().select().from(billingObjectBindings)).filter(
          (value) => value.kind === 'subscription',
        ),
      ).toHaveLength(1);
      expect(await gatewayDb().select().from(recurringMirrors)).toHaveLength(1);
    });
    it('refuses a malformed request with 400, naming the field, and accepts no legacy spelling', async () => {
      const legacy = await request(
        '/v1/billing/customers',
        'owner',
        { storeId: 'store:one', storeName: 'Store' },
        'customer:legacy',
      );
      expect(legacy.status).toBe(400);
      expect(await legacy.json()).toMatchObject({
        error: { type: 'invalid_request_error', code: 'parameter_invalid', param: 'store_id' },
      });
      const keyless = await request('/v1/billing/customers', 'owner', {
        store_id: 'store:one',
        store_name: 'Store',
      });
      expect(keyless.status).toBe(400);
      expect(await keyless.json()).toMatchObject({
        error: {
          type: 'invalid_request_error',
          code: 'parameter_invalid',
          message: 'A valid Idempotency-Key header is required.',
        },
      });
      // Refused before any durable claim or provider call.
      expect(await gatewayDb().select().from(billingOperations)).toHaveLength(0);
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
        expect(await response.json()).toMatchObject({
          error: {
            type: 'invalid_request_error',
            code: 'not_found',
            message: 'No such billing object for this merchant.',
          },
        });
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
          { url: 'https://checkout.stripe.com/synthetic', expires_at: 1791032400 },
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
    it('offers FairCoin beside the Stripe cohort, keeps the old single-rail shapes, and refuses an unknown rail', async () => {
      const stripe = {
        deployment,
        portalConfigurationRef: 'bpc_one',
        cohorts: [{ ...owner, evidenceRef: 'fixture:cohort' }],
      };
      const faircoin = {
        rail: 'faircoin',
        cohorts: [
          {
            ...owner,
            offers: [
              {
                providerPriceId: 'price_one',
                planId: 'plan:one',
                offerId: 'offer_one',
                offerVersion: 1,
                interval: 'month',
                intervalCount: 1,
                currency: 'USD',
                grossMinorUnits: 2999,
                taxTreatment: 'inclusive',
              },
            ],
          },
        ],
        priceSource: 'faircoin_explorer_indexed_usd',
        taxQuoteAdapterRef: 'tax_fixture',
        invoiceSigningKeyId: 'invoice_fixture',
      };
      const adapters = {
        taxQuoteCalculators: { tax_fixture: {} as BillingTaxQuoteCalculator },
        invoiceSigningKeys: { invoice_fixture: generateKeyPairSync('ed25519').privateKey },
      };
      const runtime = async (raw: unknown) =>
        must(await configureBillingRuntime(gatewayDb(), JSON.stringify(raw), client, adapters));
      const rails = async (raw: unknown) =>
        (await (await runtime(raw)).service.listRails?.(owner))?.data.map((rail) => [
          rail.rail,
          rail.default,
          rail.offers?.length ?? null,
        ]);
      const both = { rails: [{ rail: 'stripe', ...stripe }, faircoin] };
      expect(await rails(both)).toEqual([
        ['stripe', true, null],
        ['faircoin', false, 1],
      ]);
      // The pre-rails configurations still mean exactly one rail each.
      expect(await rails(stripe)).toEqual([['stripe', true, null]]);
      expect(await rails(faircoin)).toEqual([['faircoin', true, 1]]);
      // A caller that names no rail keeps reaching Stripe, as before FairCoin was added.
      const { service } = await runtime(both);
      expect(await service.ensureCustomer(owner, customerInput, 'customer:one')).toEqual({
        provider_customer_id: 'cus_one',
      });
      expect(calls.filter((call) => call.method === 'customer')).toHaveLength(1);
      // Choosing FairCoin mints its own namespaced customer and touches no provider.
      const native = await service.ensureCustomer(
        owner,
        { ...customerInput, rail: 'faircoin' },
        'customer:fair',
      );
      expect(native.provider_customer_id).toMatch(/^cus_fair[0-9a-f]{64}$/);
      expect(calls.filter((call) => call.method === 'customer')).toHaveLength(1);
      for (const raw of [
        { rails: [faircoin, faircoin] },
        { rails: [{ ...stripe, rail: 'square' }] },
        { rails: [] },
      ])
        await expect(
          configureBillingRuntime(gatewayDb(), JSON.stringify(raw), client, adapters),
        ).rejects.toThrow();
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
      expect(enabled?.observations?.timeoutMs).toBe(2000);
      const bounded = await configureBillingRuntime(
        gatewayDb(),
        JSON.stringify({
          ...configuration,
          observationsEnabled: true,
          observationTimeoutMs: 10_000,
        }),
        client,
      );
      expect(bounded?.observations?.timeoutMs).toBe(10_000);
      for (const observationTimeoutMs of [0, 10_001]) {
        await expect(
          configureBillingRuntime(
            gatewayDb(),
            JSON.stringify({
              ...configuration,
              observationsEnabled: true,
              observationTimeoutMs,
            }),
            client,
          ),
        ).rejects.toThrow();
      }
      expect(enabled?.relay?.enabled).toBe(true);
      expect(enabled?.relay?.cohorts).toEqual([
        { ...owner, ...deployment, evidenceRef: 'fixture:cohort', requireTaxQuote: false },
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
        { provider_customer_id: 'cus_one' },
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
        store_id: 'store:one',
        plan_id: 'plan:one',
        subscription: { provider_subscription_id: 'sub_one' },
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
      const invoice = configurePaidEvidence();
      expect(await sdk().retrievePaidInvoice('sub_one', 'in_one')).toMatchObject({
        invoice_id: 'in_one',
        store_id: 'store:one',
        plan_id: 'plan:one',
        amount_paid: '2999',
        net_amount: '2500',
        tax_amount: '499',
        period_start: 1791028800,
        period_end: 1793707200,
        paid_at: 1791028800,
      });
      expect(
        (await request('/v1/billing/subscriptions/sub_one/paid_invoices/in_one', 'other')).status,
      ).toBe(404);
      expect(
        (await request('/v1/billing/subscriptions/sub_one/paid_invoices/in_one', 'noScope')).status,
      ).toBe(403);
      expect(await sdk().retrieveInvoiceState('sub_one', 'in_one')).toMatchObject({
        state: 'paid',
        amount_refunded: '0',
      });
      expect(
        (await request('/v1/billing/subscriptions/sub_one/invoice_authorities/in_one')).status,
      ).toBe(404);
      expect(
        (
          await request('/v1/billing/tax_quotes', 'owner', {
            store_id: 'store:one',
            plan_id: 'plan:one',
            customer_location_evidence_id: 'location_fixture',
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await request('/v1/billing/tax_quotes', 'noScope', {
            store_id: 'store:one',
            plan_id: 'plan:one',
            customer_location_evidence_id: 'location_fixture',
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
            schema_version: 2,
            source: {
              invoice_id: paid.invoice_id,
              payment_intent_id: paid.payment_intent_id,
              customer_id: paid.provider_customer_id,
              subscription_id: paid.provider_subscription_id,
              price_id: paid.provider_price_id,
              plan_id: paid.plan_id,
              merchant_id: merchantPublicId,
              app_id: invoiceOwner.oxyAppId,
              mode: 'test',
              environment: invoiceOwner.environment,
            },
            invoice: {
              platform: 'peable',
              currency: paid.currency,
              gross_minor_units: 2999,
              net_minor_units: 2500,
              tax_minor_units: 499,
              merchant_fee_minor_units: 0,
              tax_treatment: 'inclusive',
              seller_id: 'seller_fixture',
              invoice_issuer_id: 'issuer_fixture',
              tax_quote_id: 'quote_fixture',
              customer_location_evidence_id: 'location_fixture',
              tax_rate_evidence_id: 'rate_fixture',
              context: {
                payer_account_id: paid.store_id,
                beneficiary_account_id: paid.store_id,
                provider_subscription_id: paid.provider_subscription_id,
                offer_id: 'offer_fixture',
                offer_version: 1,
                period_start: paid.period_start,
                period_end: paid.period_end,
                mode: 'test',
                environment: invoiceOwner.environment,
              },
              issued_at: toUnix(time),
              expires_at: toUnix(time) + 60,
            },
            method: 'card',
            signature: { algorithm: 'Ed25519', key_id: 'fixture', value: '' },
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
        source: { invoice_id: 'in_one', app_id: owner.oxyAppId },
        invoice: { gross_minor_units: 2999 },
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

    it('recovers the exact stored operation after lost response and quote expiry without creating another session', async () => {
      const fixture = await fiscalFixture();
      const key = 'recovery:key:encoded';
      const original = await fixture.fiscalSdk.createCheckoutSession(
        { ...checkout, tax_quote: fixture.quote },
        { idempotencyKey: key },
      );
      time = new Date(fixture.quote.quote.expires_at * 1000 + 1);
      const before = calls.length;
      const params = {
        idempotency_key: key,
        provider_customer_id: checkout.provider_customer_id,
        provider_price_id: checkout.provider_price_id,
        store_id: checkout.store_id,
        plan_id: checkout.plan_id,
      };
      const recovered = await sdk().retrieveCheckoutOperation(params);
      expect(recovered).toMatchObject({
        state: 'succeeded',
        source: { ...params, tax_quote_id: fixture.quote.quote.id },
        checkout: { id: original.id, expires_at: original.expires_at },
      });
      if (recovered.state !== 'succeeded') throw new Error('Expected succeeded');
      expect(recovered.checkout.url).toBeUndefined();
      expect(calls).toHaveLength(before);
      expect(await sdk().retrieveCheckoutOperation(params)).toEqual(recovered);
      const freshProvider = createStripeBillingProvider(deployment, client, {
        portalConfigurationRef: 'bpc_one',
        embeddedPublishableKey: 'pk_test_fixture',
        now: () => time,
      });
      const restarted = createBillingService({
        db: gatewayDb(),
        provider: freshProvider,
        cohorts: [{ ...owner, ...deployment, evidenceRef: 'fixture:restart' }],
        now: () => time,
      });
      expect(await restarted.retrieveCheckoutOperation(owner, params)).toEqual(recovered);
      const foreignDeployment = { ...deployment, platformAccountId: 'acct_other' };
      const foreignProvider = createStripeBillingProvider(foreignDeployment, client, {
        portalConfigurationRef: 'bpc_one',
        embeddedPublishableKey: 'pk_test_fixture',
        now: () => time,
      });
      const foreignService = createBillingService({
        db: gatewayDb(),
        provider: foreignProvider,
        cohorts: [{ ...owner, ...foreignDeployment, evidenceRef: 'fixture:other-platform' }],
        now: () => time,
      });
      await expect(foreignService.retrieveCheckoutOperation(owner, params)).rejects.toThrow(
        'not_found',
      );

      const [operation] = await gatewayDb()
        .select()
        .from(billingOperations)
        .where(eq(billingOperations.idempotencyKey, key));
      if (!operation?.result || !('url' in operation.result) || !('expires_at' in operation.result))
        throw new Error('Expected stored checkout result');
      await gatewayDb()
        .update(billingOperations)
        .set({ result: { url: operation.result.url, expires_at: operation.result.expires_at } })
        .where(eq(billingOperations.id, operation.id));
      expect(await restarted.retrieveCheckoutOperation(owner, params)).toEqual(recovered);
      const contradictory = {
        id: 'cs_test_conflict',
        url: operation.result.url,
        expires_at: operation.result.expires_at,
      };
      await gatewayDb()
        .update(billingOperations)
        .set({ result: contradictory })
        .where(eq(billingOperations.id, operation.id));
      await expect(restarted.retrieveCheckoutOperation(owner, params)).rejects.toThrow(
        'identity_conflict',
      );
      await gatewayDb()
        .update(billingOperations)
        .set({ result: operation.result })
        .where(eq(billingOperations.id, operation.id));
      const query = new URLSearchParams({
        provider_customer_id: checkout.provider_customer_id,
        provider_price_id: checkout.provider_price_id,
        store_id: checkout.store_id,
        plan_id: checkout.plan_id,
      });
      const path = `/v1/billing/checkout_operations/${encodeURIComponent(key)}?${query}`;
      expect((await request(path, 'other')).status).toBe(404);
      expect((await request(path, 'noScope')).status).toBe(403);
      expect((await request(path, 'wrongApp')).status).toBe(403);
      expect((await request(path, 'wrongEnvironment')).status).toBe(403);
      await bindBillingObject(gatewayDb(), deployment, owner, {
        kind: 'customer',
        providerRef: 'cus_second',
        externalSubjectRef: 'store:second',
        bindingEvidenceRef: 'fixture:second',
      });
      await expect(
        sdk().retrieveCheckoutOperation({
          ...params,
          provider_customer_id: 'cus_second',
          store_id: 'store:second',
        }),
      ).rejects.toThrow();
      expect(calls).toHaveLength(before);
    });
    it('keeps absence and uncertain provider acceptance nonterminal and validates read-only recovery proof', async () => {
      const fixture = await fiscalFixture();
      const params = {
        idempotency_key: 'recover:pending',
        provider_customer_id: checkout.provider_customer_id,
        provider_price_id: checkout.provider_price_id,
        store_id: checkout.store_id,
        plan_id: checkout.plan_id,
      };
      const missing = await sdk().retrieveCheckoutOperation(params);
      expect(missing.state).toBe('not_found');
      const customer = await requireBillingBinding(
        gatewayDb(),
        deployment,
        owner,
        'customer',
        params.provider_customer_id,
      );
      const price = await requireBillingBinding(
        gatewayDb(),
        deployment,
        owner,
        'price',
        params.provider_price_id,
      );
      const claim = await claimBillingOperation(
        gatewayDb(),
        deployment,
        owner,
        {
          operation: 'checkout',
          idempotencyKey: params.idempotency_key,
          requestDigest: 'a'.repeat(64),
          customerBindingId: customer.id,
          priceBindingId: price.id,
        },
        time,
      );
      if (claim.kind !== 'claimed') throw new Error('Expected claim');
      time = new Date(time.getTime() + 120_000);
      const before = calls.length;
      expect((await sdk().retrieveCheckoutOperation(params)).state).toBe('pending');
      let reads = 0;
      checkoutOperationReader = {
        async read() {
          reads++;
          return { state: 'not_found' };
        },
      };
      expect((await sdk().retrieveCheckoutOperation(params)).state).toBe('indeterminate');
      checkoutOperationReader = {
        async read(input) {
          reads++;
          return {
            state: 'succeeded',
            ...input,
            providerCustomerId: 'cus_foreign',
            checkout: {
              id: 'cs_test_found',
              url: 'https://example.invalid/recovered',
              expires_at: toUnix(time),
            },
          };
        },
      };
      await expect(sdk().retrieveCheckoutOperation(params)).rejects.toThrow();
      expect(
        (
          await gatewayDb()
            .select()
            .from(billingOperations)
            .where(eq(billingOperations.id, claim.operation.id))
        )[0]?.state,
      ).toBe('pending');
      checkoutOperationReader = {
        async read(input) {
          reads++;
          return {
            state: 'succeeded',
            ...input,
            checkout: {
              id: 'cs_test_found',
              url: 'https://example.invalid/recovered',
              expires_at: toUnix(time) - 1,
            },
          };
        },
      };
      const concurrent = await Promise.all([
        sdk().retrieveCheckoutOperation(params),
        sdk().retrieveCheckoutOperation(params),
      ]);
      expect(
        concurrent.every(
          (value) =>
            value.state === 'succeeded' &&
            value.checkout.id === 'cs_test_found' &&
            !value.checkout.url,
        ),
      ).toBe(true);
      const readCount = reads;
      expect((await sdk().retrieveCheckoutOperation(params)).state).toBe('succeeded');
      expect(reads).toBe(readCount);
      expect(calls).toHaveLength(before);
      expect(fixture.quote).toBeDefined();
    });
    it('discovers and pins the original invoice on first checkout read after renewal through all pages', async () => {
      const fixture = await fiscalFixture();
      const hosted = await fixture.fiscalSdk.createCheckoutSession(
        { ...checkout, tax_quote: fixture.quote },
        { idempotencyKey: 'initial:late' },
      );
      configurePaidEvidence();
      const subscription = client.retrieveSubscription;
      client.retrieveSubscription = async (ref) => ({
        ...((await subscription(ref)) as Record<string, unknown>),
        latest_invoice: 'in_renewal',
      });
      const initial = {
        id: 'in_one',
        customer: 'cus_one',
        livemode: false,
        billing_reason: 'subscription_create',
        parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_one' } },
      };
      const cursors: Array<string | undefined> = [];
      client.listSubscriptionInvoices = async (_ref, cursor) => {
        cursors.push(cursor);
        return cursor
          ? { has_more: false, data: [initial] }
          : {
              has_more: true,
              data: [{ ...initial, id: 'in_renewal', billing_reason: 'subscription_cycle' }],
            };
      };
      const observed = await sdk().retrieveCheckout(hosted.id);
      expect(observed.initial_invoice_id).toBe('in_one');
      expect(observed.subscription?.latest_invoice_id).toBe('in_renewal');
      expect(cursors).toEqual([undefined, 'in_renewal']);
      client.listSubscriptionInvoices = async () => {
        throw new Error('Initial pin must survive restart/provider outage');
      };
      const reloaded = createVerifiedBillingBindings({
        db: gatewayDb(),
        client,
        deployment,
        cohorts: [{ ...owner, ...deployment, evidenceRef: 'fixture:approved-cohort' }],
        now: () => time,
      });
      expect((await reloaded.retrieveCheckout(owner, hosted.id)).initial_invoice_id).toBe('in_one');
    });
    it('does not pin ambiguous, foreign, wrong-price or incomplete initial invoice evidence', async () => {
      const fixture = await fiscalFixture();
      const hosted = await fixture.fiscalSdk.createCheckoutSession(
        { ...checkout, tax_quote: fixture.quote },
        { idempotencyKey: 'initial:invalid' },
      );
      configurePaidEvidence();
      const initial = {
        id: 'in_one',
        customer: 'cus_one',
        livemode: false,
        billing_reason: 'subscription_create',
        parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_one' } },
      };
      client.listSubscriptionInvoices = async () => ({
        has_more: false,
        data: [initial, { ...initial, id: 'in_duplicate' }],
      });
      expect((await sdk().retrieveCheckout(hosted.id)).initial_invoice_id).toBeNull();
      client.listSubscriptionInvoices = async () => ({
        has_more: false,
        data: [{ ...initial, customer: 'cus_foreign' }],
      });
      await expect(sdk().retrieveCheckout(hosted.id)).rejects.toThrow();
      client.listSubscriptionInvoices = async () => ({ has_more: true, data: [] });
      await expect(sdk().retrieveCheckout(hosted.id)).rejects.toThrow();
      client.listSubscriptionInvoices = async () => ({ has_more: false, data: [initial] });
      const lines = client.listInvoiceLines;
      if (!lines) throw new Error('Expected fixture lines');
      client.listInvoiceLines = async () => ({
        has_more: false,
        data: [
          {
            id: 'il_one',
            invoice: 'in_one',
            livemode: false,
            quantity: 1,
            parent: {
              type: 'subscription_item_details',
              subscription_item_details: { subscription: 'sub_one', proration: false },
            },
            pricing: { price_details: { price: 'price_foreign' } },
          },
        ],
      });
      await expect(sdk().retrieveCheckout(hosted.id)).rejects.toThrow();
      expect(
        (
          await gatewayDb()
            .select()
            .from(billingOperations)
            .where(eq(billingOperations.providerObjectRef, hosted.id))
        )[0]?.initialInvoiceRef,
      ).toBeNull();
      client.listInvoiceLines = lines;
    });

    it('rejects a recovered provider session that outlives its immutable fiscal quote', async () => {
      const fixture = await fiscalFixture();
      if (!taxCheckoutAdapter) throw new Error('Expected fiscal fixture');
      taxCheckoutAdapter.createCheckout = async () => {
        throw new Error('Synthetic lost provider response');
      };
      await expect(
        fixture.fiscalSdk.createCheckoutSession(
          { ...checkout, tax_quote: fixture.quote },
          { idempotencyKey: 'recover:quote-ceiling' },
        ),
      ).rejects.toThrow();
      const params = {
        idempotency_key: 'recover:quote-ceiling',
        provider_customer_id: checkout.provider_customer_id,
        provider_price_id: checkout.provider_price_id,
        store_id: checkout.store_id,
        plan_id: checkout.plan_id,
      };
      time = new Date(fixture.quote.quote.expires_at * 1000 + 1);
      checkoutOperationReader = {
        async read(input) {
          return {
            state: 'succeeded',
            ...input,
            checkout: {
              id: 'cs_test_found',
              url: 'https://example.invalid/recovered',
              expires_at: fixture.quote.quote.expires_at + 1,
            },
          };
        },
      };
      await expect(sdk().retrieveCheckoutOperation(params)).rejects.toThrow();
      const [operation] = await gatewayDb()
        .select()
        .from(billingOperations)
        .where(eq(billingOperations.idempotencyKey, params.idempotency_key));
      expect(operation?.state).toBe('indeterminate');
      expect(operation?.providerObjectRef).toBeNull();
      checkoutOperationReader = {
        async read(input) {
          return {
            state: 'succeeded',
            ...input,
            checkout: {
              id: 'cs_test_found',
              url: 'https://example.invalid/recovered',
              expires_at: fixture.quote.quote.expires_at,
            },
          };
        },
      };
      const recovered = await sdk().retrieveCheckoutOperation(params);
      expect(recovered.state).toBe('succeeded');
      expect(recovered.source.tax_quote_id).toBe(fixture.quote.quote.id);
      if (recovered.state !== 'succeeded') throw new Error('Expected succeeded');
      expect(recovered.checkout.url).toBeUndefined();
    });

    it('cannot overwrite completion or reacquired lease while a read-only provider lookup is in flight', async () => {
      await fiscalFixture();
      const customer = await requireBillingBinding(
        gatewayDb(),
        deployment,
        owner,
        'customer',
        checkout.provider_customer_id,
      );
      const price = await requireBillingBinding(
        gatewayDb(),
        deployment,
        owner,
        'price',
        checkout.provider_price_id,
      );
      const params = {
        idempotency_key: 'recover:race',
        provider_customer_id: checkout.provider_customer_id,
        provider_price_id: checkout.provider_price_id,
        store_id: checkout.store_id,
        plan_id: checkout.plan_id,
      };
      const input = {
        operation: 'checkout' as const,
        idempotencyKey: params.idempotency_key,
        requestDigest: 'a'.repeat(64),
        customerBindingId: customer.id,
        priceBindingId: price.id,
      };
      const claim = await claimBillingOperation(gatewayDb(), deployment, owner, input, time);
      if (claim.kind !== 'claimed') throw new Error('Expected claim');
      time = new Date(time.getTime() + 120_000);
      let renewedToken = '';
      checkoutOperationReader = {
        async read(expected) {
          const renewed = await claimBillingOperation(gatewayDb(), deployment, owner, input, time);
          if (renewed.kind !== 'claimed') throw new Error('Expected renewed lease');
          renewedToken = renewed.leaseToken;
          return {
            state: 'succeeded',
            ...expected,
            checkout: {
              id: 'cs_test_discovered',
              url: 'https://example.invalid/discovered',
              expires_at: toUnix(time) + 60,
            },
          };
        },
      };
      expect((await sdk().retrieveCheckoutOperation(params)).state).toBe('pending');
      expect(
        (
          await gatewayDb()
            .select()
            .from(billingOperations)
            .where(eq(billingOperations.id, claim.operation.id))
        )[0]?.leaseToken,
      ).toBe(renewedToken);
      checkoutOperationReader = {
        async read(expected) {
          await gatewayDb().transaction((tx) =>
            completeBillingOperation(
              tx,
              claim.operation,
              renewedToken,
              {
                id: 'cs_test_original',
                url: 'https://example.invalid/original',
                expires_at: toUnix(time) + 60,
              },
              'cs_test_original',
              time,
            ),
          );
          return {
            state: 'succeeded',
            ...expected,
            checkout: {
              id: 'cs_test_discovered',
              url: 'https://example.invalid/discovered',
              expires_at: toUnix(time) + 60,
            },
          };
        },
      };
      const recovered = await sdk().retrieveCheckoutOperation(params);
      expect(recovered.state).toBe('succeeded');
      if (recovered.state !== 'succeeded') throw new Error('Expected succeeded');
      expect(recovered.checkout.id).toBe('cs_test_original');
      expect(
        (
          await gatewayDb()
            .select()
            .from(billingOperations)
            .where(eq(billingOperations.id, claim.operation.id))
        )[0]?.providerObjectRef,
      ).toBe('cs_test_original');
    });
  },
);
