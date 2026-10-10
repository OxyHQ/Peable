import { createMerchantsRouter } from '../../routes/merchants';
/** Local-only cross-repository fixture. Synthetic Oxy auth and downstream; actual
 * Peable SDK HTTP, ownership/cohort routes, migrations and durable outboxes.
 * Never imported by boot. Parent sends JSON lines; each response is prefixed. */
import express, { type RequestHandler } from 'express';
import { createInterface } from 'node:readline';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { Peable } from '@peable.to/sdk';
import {
  signWebhook,
  canonicalBillingAuthority,
  type BillingFinalInvoiceAuthority,
} from '@peable.to/shared-types';
import { createSuiteDatabase, dropSuiteDatabase } from '../../db/testDatabase';
import { insertMerchant } from '../../db/merchants/merchantRepository';
import { insertProviderEvent } from '../../db/providers/providerEventRepository';
import { webhookDeliveries } from '../../db/schema';
import { createBillingRouter } from '../../routes/billing';
import { createBillingService } from '../../services/billing/billingService';
import { createVerifiedBillingBindings } from '../../services/billing/verifiedBindings';
import {
  createStripeBillingProvider,
  type StripeBillingClient,
} from '../../services/billing/stripeBillingProvider';
import { STRIPE_API_VERSION } from '../../services/providers/stripe/client';
import {
  createOwnedBillingRecurringReader,
  createOwnedBillingInvoiceResolver,
} from '../../services/billing/recurringBillingReader';
import { observeRecurringEvent } from '../../services/recurring/recurringObservation';
import { relayRecurringObservations } from '../../services/recurring/recurringDelivery';
for (const name of ['DATABASE_URL', 'TEST_DATABASE_URL']) {
  const value = process.env[name];
  if (!value || !['127.0.0.1', 'localhost'].includes(new URL(value).hostname))
    throw new Error('Fixture requires explicit local PostgreSQL');
}
const localFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init: any) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  if (!['127.0.0.1', 'localhost'].includes(url.hostname))
    throw new Error('Fixture refuses external network');
  return localFetch(input, init);
}) as typeof fetch;
const suite = await createSuiteDatabase();
let server: ReturnType<ReturnType<typeof express>['listen']> | undefined;
let billing: Peable['billing'];
let peable: Peable;
let cohorts: any;
let bindings: ReturnType<typeof createVerifiedBillingBindings>;
let client: StripeBillingClient;
let deployment: any;
let owner: any;
let period: { start: number; end: number };
let store: string;
let cancelled = false;
const refund = 0;
let status = 'active';
let fixtureNow: number | undefined;
let currentInvoice = 'in_fixture';
const invoices: Record<
  string,
  {
    period: { start: number; end: number };
    refund: number;
    line: string;
    pi: string;
    charge: string;
  }
> = {};
const observedClock = () => new Date(fixtureNow ?? Date.now());
async function initialize(input: {
  accountId: string;
  appId: string;
  planId: string;
  periodStart: string;
  periodEnd: string;
  offerId?: string;
  offerVersion?: number;
}) {
  store = input.accountId;
  period = { start: Date.parse(input.periodStart) / 1000, end: Date.parse(input.periodEnd) / 1000 };
  if (!Number.isInteger(period.start) || !Number.isInteger(period.end))
    throw new Error('Fixture requires whole-second period');
  invoices.in_fixture = {
    period: { ...period },
    refund: 0,
    line: 'il_fixture',
    pi: 'pi_fixture',
    charge: 'ch_fixture',
  };
  const merchant = await insertMerchant(suite.db, {
    publicId: `merch_${randomUUID().replaceAll('-', '')}`,
    oxyAppId: input.appId,
    environment: 'production',
    webhookUrl: 'https://example.invalid/synthetic',
    webhookSecret: 'synthetic-only-secret',
  });
  if (!merchant) throw new Error('Merchant fixture missing');
  owner = { merchantId: merchant.id, oxyAppId: merchant.oxyAppId, environment: 'production' };
  deployment = { provider: 'stripe', platformAccountId: 'acct_fixture', livemode: true };
  cohorts = [{ ...owner, ...deployment, evidenceRef: 'synthetic-local-review' }];
  const sub = () => ({
    id: 'sub_fixture',
    customer: 'cus_fixture',
    livemode: true,
    status,
    cancel_at_period_end: cancelled,
    trial_end: null,
    cancel_at: cancelled ? period.end : null,
    canceled_at: null,
    latest_invoice: currentInvoice,
    items: {
      has_more: false,
      data: [
        {
          id: 'si_fixture',
          quantity: 1,
          current_period_start: period.start,
          current_period_end: period.end,
          price: { id: 'price_fixture', recurring: { interval: 'month', interval_count: 1 } },
        },
      ],
    },
  });
  const invoice = (id: string) => ({
    id,
    customer: 'cus_fixture',
    livemode: true,
    status: 'paid',
    pre_payment_credit_notes_amount: 0,
    post_payment_credit_notes_amount: 0,
    currency: 'usd',
    total: 2999,
    amount_paid: 2999,
    amount_due: 2999,
    amount_remaining: 0,
    total_excluding_tax: 2500,
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_fixture' } },
  });
  client = {
    scope: 'platform',
    apiVersion: STRIPE_API_VERSION,
    livemode: true,
    account: async () => ({ id: 'acct_fixture' }),
    createCustomer: async () => ({ id: 'cus_fixture', livemode: true }),
    createCheckout: async () => ({
      id: 'cs_live_fixture',
      customer: 'cus_fixture',
      mode: 'subscription',
      livemode: true,
      url: 'https://checkout.stripe.com/c/synthetic',
      expires_at: Math.floor(Date.now() / 1000) + 300,
    }),
    createPortal: async () => {
      throw new Error('Unused');
    },
    retrievePortalConfiguration: async () => ({
      id: 'bpc_fixture',
      active: true,
      livemode: true,
      features: {
        subscription_update: { enabled: false },
        subscription_cancel: { enabled: true, mode: 'at_period_end' },
      },
    }),
    retrieveCustomer: async () => ({ id: 'cus_fixture', livemode: true }),
    retrievePrice: async () => ({
      id: 'price_fixture',
      livemode: true,
      active: true,
      recurring: { interval: 'month', interval_count: 1 },
    }),
    retrieveCheckout: async () => ({
      id: 'cs_live_fixture',
      customer: 'cus_fixture',
      mode: 'subscription',
      livemode: true,
      status: 'complete',
      subscription: 'sub_fixture',
    }),
    listCheckoutsForSubscription: async () => ({
      has_more: false,
      data: [{ id: 'cs_live_fixture' }],
    }),
    retrieveSubscription: async () => sub(),
    updateSubscription: async () => {
      cancelled = true;
      return sub();
    },
    retrieveInvoice: async (id) => invoice(id),
    listInvoiceLines: async (id) => ({
      has_more: false,
      data: [
        {
          id: invoices[id]!.line,
          invoice: id,
          livemode: true,
          subscription: 'sub_fixture',
          quantity: 1,
          amount: 2500,
          parent: {
            type: 'subscription_item_details',
            subscription_item_details: { subscription: 'sub_fixture', proration: false },
          },
          pricing: { price_details: { price: 'price_fixture' } },
          period: invoices[id]!.period,
        },
      ],
    }),
    listInvoicePayments: async (id) => ({
      has_more: false,
      data: [
        {
          id: `inpay_${id}`,
          invoice: id,
          livemode: true,
          currency: 'usd',
          status: 'paid',
          amount_paid: 2999,
          payment: { type: 'payment_intent', payment_intent: invoices[id]!.pi },
          status_transitions: { paid_at: invoices[id]!.period.start },
        },
      ],
    }),
    listChargeRefunds: async (charge) => {
      const value = Object.values(invoices).find((v) => v.charge === charge);
      if (!value) throw new Error('Unknown fixture charge');
      return {
        has_more: false,
        data: value.refund
          ? [
              {
                id: `re_${charge}`,
                charge,
                payment_intent: value.pi,
                currency: 'usd',
                amount: value.refund,
                status: 'succeeded',
              },
            ]
          : [],
      };
    },
    retrievePaidPaymentIntent: async (pi) => {
      const value = Object.values(invoices).find((v) => v.pi === pi);
      if (!value) throw new Error('Unknown fixture payment');
      return {
        id: pi,
        customer: 'cus_fixture',
        livemode: true,
        currency: 'usd',
        status: 'succeeded',
        amount_received: 2999,
        latest_charge: {
          id: value.charge,
          payment_intent: pi,
          customer: 'cus_fixture',
          currency: 'usd',
          livemode: true,
          paid: true,
          captured: true,
          amount_captured: 2999,
          amount_refunded: value.refund,
          refunded: value.refund === 2999,
          disputed: false,
        },
      };
    },
  };
  bindings = createVerifiedBillingBindings({
    db: suite.db,
    client,
    deployment,
    cohorts,
    now: observedClock,
  });
  const provider = createStripeBillingProvider(deployment, client, {
    portalConfigurationRef: 'bpc_fixture',
  });
  const signingKeys = generateKeyPairSync('ed25519');
  const invoiceAuthorityKeys = {
    fixture: signingKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
  const service = createBillingService({
    db: suite.db,
    provider,
    cohorts,
    verifiedBindings: bindings,
    now: observedClock,
    finalInvoiceAuthority: {
      verificationKeys: invoiceAuthorityKeys,
      async read({ owner: authorityOwner, merchantPublicId, invoice: paid }) {
        const clock = observedClock();
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
            appId: authorityOwner.oxyAppId,
            mode: 'live',
            environment: 'production',
          },
          invoice: {
            platform: 'peable',
            currency: 'USD',
            grossMinorUnits: 2999,
            netMinorUnits: 2500,
            taxMinorUnits: 499,
            merchantFeeMinorUnits: 0,
            taxTreatment: 'inclusive',
            sellerId: 'synthetic-seller',
            invoiceIssuerId: 'synthetic-issuer',
            taxQuoteId: 'synthetic-tax',
            customerLocationEvidenceId: 'synthetic-location',
            taxRateEvidenceId: 'synthetic-rate',
            context: {
              payerAccountId: paid.storeId,
              beneficiaryAccountId: paid.storeId,
              providerSubscriptionId: paid.providerSubscriptionId,
              offerId: input.offerId ?? 'fixture-offer',
              offerVersion: input.offerVersion ?? 1,
              periodStart: paid.periodStart,
              periodEnd: paid.periodEnd,
              mode: 'live',
              environment: 'production',
            },
            issuedAt: clock.toISOString(),
            expiresAt: new Date(
              Math.min(clock.getTime() + 300000, Date.parse(paid.periodEnd)),
            ).toISOString(),
          },
          method: 'card',
          signature: { algorithm: 'Ed25519', keyId: 'fixture', value: '' },
        };
        authority.signature.value = sign(
          null,
          Buffer.from(canonicalBillingAuthority(authority)),
          signingKeys.privateKey,
        ).toString('base64url');
        return authority;
      },
    },
  });

  const auth: RequestHandler = (req, _res, next) => {
    (req as OxyAuthRequest).serviceApp = {
      appId: owner.oxyAppId,
      environment: 'production',
      appName: 'synthetic',
      credentialId: 'synthetic',
      ownerAccountId: 'not-payer',
      tier: 'external',
      scopes: ['payments:read', 'payments:write'],
    };
    next();
  };
  const app = express();
  app.use(express.json());
  app.post('/auth/service-token', (_req, res) =>
    res.json({ data: { token: 'synthetic', expiresIn: 300 } }),
  );
  app.use(createBillingRouter({ requireMerchant: auth, service }));
  app.use(createMerchantsRouter({ requireMerchant: auth }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  peable = new Peable({
    baseURL,
    oxyApiUrl: baseURL,
    publicKey: 'synthetic',
    secret: 'synthetic',
    invoiceAuthorityKeys,
  });
  billing = peable.billing;
  await billing.ensureCustomer(
    { storeId: store, storeName: 'Synthetic fixture' },
    { idempotencyKey: 'fixture-customer' },
  );
  await bindings.importPrice(owner, {
    providerPriceId: 'price_fixture',
    planId: input.planId,
    evidenceRef: 'synthetic-approved-price',
  });
  const checkout = await billing.createCheckoutSession(
    {
      storeId: store,
      planId: input.planId,
      providerCustomerId: 'cus_fixture',
      providerPriceId: 'price_fixture',
      trialDays: 0,
      returnUrl: 'https://example.invalid/return',
    },
    { idempotencyKey: 'fixture-checkout' },
  );
  const correlation = await billing.retrieveCheckout(checkout.id);
  return {
    merchantId: merchant.publicId,
    appId: owner.oxyAppId,
    checkoutId: checkout.id,
    correlation,
    baseURL,
    invoiceAuthorityKeys,
    observationSecret: 'synthetic-only-secret',
  };
}
async function command(message: any) {
  switch (message.method) {
    case 'initialize':
      return initialize(message.input);
    case 'retrieveMerchant':
      return peable.merchants.retrieve();
    case 'retrieveFinalInvoiceAuthority':
      return billing.retrieveFinalInvoiceAuthority(...(message.args as [string, string]));
    case 'retrievePaidInvoice':
      return billing.retrievePaidInvoice(...(message.args as [string, string]));
    case 'retrieveInvoiceState':
      return billing.retrieveInvoiceState(...(message.args as [string, string]));
    case 'retrieveSubscription':
      return billing.retrieveSubscription(message.args[0]);
    case 'cancelAtPeriodEnd':
      return billing.cancelAtPeriodEnd(message.args[0], message.args[1]);
    case 'setState': {
      if (message.input.cancelAtPeriodEnd !== undefined)
        cancelled = message.input.cancelAtPeriodEnd;
      if (message.input.period) {
        period = {
          start: Date.parse(message.input.period.start) / 1000,
          end: Date.parse(message.input.period.end) / 1000,
        };
        fixtureNow = Date.parse(message.input.period.start) + 1000;
      }
      if (message.input.renew) {
        fixtureNow = Date.parse(message.input.renew.start) + 1000;
        period = {
          start: Date.parse(message.input.renew.start) / 1000,
          end: Date.parse(message.input.renew.end) / 1000,
        };
        currentInvoice = message.input.renew.invoiceId ?? 'in_renewal';
        const suffix = currentInvoice.slice(3);
        invoices[currentInvoice] = {
          period: { ...period },
          refund: 0,
          line: `il_${suffix}`,
          pi: `pi_${suffix}`,
          charge: `ch_${suffix}`,
        };
      }
      const invoiceId = message.input.invoiceId ?? currentInvoice;
      if (message.input.refund !== undefined) invoices[invoiceId]!.refund = message.input.refund;
      status = message.input.status ?? status;
      return { ok: true, now: observedClock().toISOString() };
    }
    case 'observe': {
      const type = message.input.type ?? 'invoice.paid';
      const id = await insertProviderEvent(suite.db, {
        provider: 'stripe',
        providerEventId: message.input.id ?? `evt_${randomUUID()}`,
        providerAccountId: null,
        type,
        livemode: true,
        apiVersion: STRIPE_API_VERSION,
        objectIds:
          type === 'charge.refunded'
            ? { charge: 'ch_fixture', payment_intent: 'pi_fixture' }
            : type.startsWith('customer.subscription.')
              ? { subscription: 'sub_fixture' }
              : { invoice: message.input.invoiceId ?? currentInvoice },
        payload: { created: message.input.created ?? 1 },
      });
      if (!id) return { kind: 'duplicate' };
      const options = {
        deployment: { ...deployment, environment: 'production', apiVersion: STRIPE_API_VERSION },
        reader: createOwnedBillingRecurringReader({ db: suite.db, bindings, client }),
        bindOwnedInvoice: createOwnedBillingInvoiceResolver({ db: suite.db, bindings, client }),
      };
      return observeRecurringEvent(id, options);
    }
    case 'relay':
      return relayRecurringObservations({ db: suite.db, cohorts, enabled: message.input?.enabled });
    case 'deliveries': {
      const rows = await suite.db.select().from(webhookDeliveries);
      return rows.map((row) => {
        const raw = JSON.stringify(row.payload);
        const ts = Math.floor(Date.now() / 1000);
        const signature = signWebhook('synthetic-only-secret', raw, ts);
        return {
          event: peable.webhooks.constructEvent(raw, signature, 'synthetic-only-secret'),
          raw,
          signature,
        };
      });
    }
    case 'verifyEvent':
      return peable.webhooks.constructEvent(
        message.args[0],
        message.args[1],
        'synthetic-only-secret',
      );
    case 'shutdown':
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      await dropSuiteDatabase(suite);
      return { ok: true };
    default:
      throw new Error('Unknown fixture command');
  }
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let message: any;
  try {
    message = JSON.parse(line);
    const result = await command(message);
    console.log('OXY_ONE_FIXTURE:' + JSON.stringify({ id: message.id, result }));
    if (message.method === 'shutdown') break;
  } catch {
    console.log(
      'OXY_ONE_FIXTURE:' + JSON.stringify({ id: message?.id, error: 'fixture_command_failed' }),
    );
  }
}
