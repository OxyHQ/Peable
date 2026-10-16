import {
  createFaircoinBillingService,
  faircoinBillingConfigurationSchema,
} from './faircoinBillingService';
import { createPrivateKey, type KeyObject } from 'node:crypto';
import {
  CARD_QUOTE_LIFETIME_MS,
  createPeableTaxQuoteCalculator,
  PEABLE_TAX_SERVICE_REF,
} from '../tax/billingTaxQuotes';
import { billingTaxOfferSchema, type BillingTaxCheckoutAdapter } from './tax-checkout';
import {
  createPeableCardInvoiceAuthority,
  createStripeInvoiceTaxRecorder,
  createStripePeableTaxCheckout,
  type StripeInvoiceTaxRecorder,
} from './stripeTaxCheckout';
import type { TaxService } from '../tax/taxService';
import { findMerchantByAppEnvironment } from '../../db/merchants/merchantRepository';
import type { FaircoinRenewalExecutor } from './faircoin-renewal-consumer';
import { createPublicKey } from 'node:crypto';
import type { BillingTaxQuoteCalculator } from './tax-quote';
import type { FinalInvoiceAuthorityReader } from './invoice-authority';
import { z } from 'zod';
import { config } from '../../config';
import type { Database } from '../../db/postgres';
import { stripeBillingClient } from '../providers/stripe/client';
import {
  billingDeploymentSchema,
  billingOwnerSchema,
  billingReference,
  BillingError,
} from './contracts';
import { createBillingService, type BillingCheckoutOperationReader } from './billingService';
import { createStripeBillingProvider, type StripeBillingClient } from './stripeBillingProvider';
import { createVerifiedBillingBindings } from './verifiedBindings';
import { billingRailId, type BillingOwner } from './contracts';
import { createMultiRailBillingService, type BillingRail } from './rails';
import { loadPinnedSigningKey, reportMountedSigningKey } from './signingKey';
import {
  createOwnedBillingRecurringReader,
  createOwnedBillingInvoiceResolver,
} from './recurringBillingReader';
import { STRIPE_API_VERSION } from '../providers/stripe/client';

const cohortConfiguration = z
  .object({
    deployment: billingDeploymentSchema,
    faircoinExecutorRef: billingReference.optional(),
    faircoinActors: z
      .array(
        z
          .object({
            payerAccountId: billingReference,
            merchantId: billingReference,
            appId: billingReference,
            mode: z.enum(['live', 'test']),
            environment: z.enum(['development', 'staging', 'production']),
          })
          .strict(),
      )
      .min(1)
      .max(20)
      .optional(),
    observationsEnabled: z.boolean().default(false),
    taxQuoteAdapterRef: billingReference.optional(),
    taxCheckoutAdapterRef: billingReference.optional(),
    finalInvoiceAuthorityAdapterRef: billingReference.optional(),
    checkoutOperationReaderRef: billingReference.optional(),
    /** Peable Tax only: the pinned key its quotes and invoices are signed with. */
    invoiceSigningKeyId: billingReference.optional(),
    portalConfigurationRef: z.string().regex(/^bpc_[A-Za-z0-9]+$/),
    cohorts: z
      .array(
        billingOwnerSchema
          .extend({
            evidenceRef: billingReference,
            requireTaxQuote: z.boolean().default(false),
            /** Peable Tax only: the bound prices it quotes, with their tax treatment. */
            offers: z.array(billingTaxOfferSchema).min(1).max(50).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
/** Only trusted deployment composition registers adapters. Configuration selects
 * an existing name; it cannot load arbitrary modules, URLs or provider secrets. */
export interface BillingRuntimeAdapters {
  invoiceSigningKeys?: Readonly<Record<string, string | KeyObject>>;
  checkoutOperationReaders?: Readonly<Record<string, BillingCheckoutOperationReader>>;
  faircoinExecutors?: Readonly<Record<string, FaircoinRenewalExecutor>>;
  taxCheckoutAdapters?: Readonly<Record<string, BillingTaxCheckoutAdapter>>;
  taxQuoteCalculators?: Readonly<Record<string, BillingTaxQuoteCalculator>>;
  finalInvoiceAuthorities?: Readonly<Record<string, FinalInvoiceAuthorityReader>>;
  /** Peable Tax, which `taxQuoteAdapterRef: "peable_tax"` quotes through. */
  taxService?: TaxService;
}
function pinnedKeys(keys: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const copy = z.record(billingReference, z.string().min(1)).parse(keys);
  if (Object.keys(copy).length < 1 || Object.keys(copy).length > 20)
    throw new Error('Fiscal adapter requires pinned verification keys');
  for (const value of Object.values(copy)) {
    if (
      !value.startsWith('-----BEGIN PUBLIC KEY-----') ||
      createPublicKey(value).asymmetricKeyType !== 'ed25519'
    )
      throw new Error('Fiscal adapter requires public Ed25519 keys');
  }
  return Object.freeze(copy);
}
/** Workers and observers a rail contributes besides its service. */
type StripeRail = Awaited<ReturnType<typeof configureStripeRail>>;
interface ConfiguredRail {
  rail: BillingRail;
  renewals?: StripeRail['renewals'];
  observations?: Extract<StripeRail, { observations: unknown }>['observations'];
  relay?: Extract<StripeRail, { relay: unknown }>['relay'];
  invoiceTax?: StripeInvoiceTaxRecorder;
}
interface RailContext {
  db: Database;
  body: Record<string, unknown>;
  injectedClient?: StripeBillingClient;
  adapters: BillingRuntimeAdapters;
}
const sameOwner = (left: BillingOwner, right: BillingOwner) =>
  left.merchantId === right.merchantId &&
  left.oxyAppId === right.oxyAppId &&
  left.environment === right.environment;

/** References the native rail mints; disjoint from every opaque provider id. */
const FAIRCOIN_REFS = {
  customer: /^cus_fair[0-9a-f]{64}$/,
  subscription: /^sub_fair[0-9a-f]{64}$/,
  checkout: /^cs_(live|test)_fair[0-9a-f]{64}$/,
} as const;

/** The billing signing key named `keyId`: an injected one, else the mounted
 * production key, which must be that pinned key. Tax quotes and invoices are
 * signed under the same id, so consumers verify both with one pinned key. */
async function resolveSigningKey(
  adapters: BillingRuntimeAdapters,
  keyId: string,
): Promise<string | KeyObject | undefined> {
  const injected = adapters.invoiceSigningKeys?.[keyId];
  if (injected) return injected;
  const keyFile = config.billingInvoicePrivateKeyFile;
  if (!keyFile) return undefined;
  const mounted = await loadPinnedSigningKey(keyFile);
  if (mounted.keyId !== keyId) throw new Error('Billing must sign with its configured pinned key');
  return mounted.privateKey;
}

/** FairCoin native: watch-only settlement, payer-initiated periods, signed
 * invoices. Needs no Stripe credential. */
async function configureFaircoinRail({ db, body, adapters }: RailContext): Promise<ConfiguredRail> {
  const native = faircoinBillingConfigurationSchema.parse(body);
  const cohortOf = (owner: BillingOwner) =>
    native.cohorts.find((cohort) => sameOwner(cohort, owner));
  let calculator = adapters.taxQuoteCalculators?.[native.taxQuoteAdapterRef];
  const signingKey = await resolveSigningKey(adapters, native.invoiceSigningKeyId);
  if (!calculator && native.taxQuoteAdapterRef === PEABLE_TAX_SERVICE_REF && signingKey) {
    if (!adapters.taxService) throw new Error('Peable Tax quotes require the tax service');
    // Every amount comes from Peable Tax; the merchant's approved tax settings
    // are the commercial gate, checked per quote rather than at boot.
    calculator = createPeableTaxQuoteCalculator({
      db,
      tax: adapters.taxService,
      offers: (owner) => cohortOf(owner)?.offers ?? [],
      signingKey: typeof signingKey === 'string' ? createPrivateKey(signingKey) : signingKey,
      keyId: native.invoiceSigningKeyId,
    });
  }
  if (!calculator || !signingKey)
    throw new Error('Native FairCoin billing requires Peable Tax and a pinned invoice signing key');
  const service = createFaircoinBillingService({
    db,
    configuration: native,
    taxQuoteCalculator: calculator,
    invoiceSigningKey: signingKey,
  });
  // Watch-only payment intent settlement + its durable webhook outbox are the
  // existing gateway workers. No Stripe client or automatic renewal executor.
  return {
    rail: {
      id: 'faircoin',
      settlement: 'faircoin',
      renewal: 'payer_initiated',
      service,
      refPatterns: FAIRCOIN_REFS,
      serves: (owner) => cohortOf(owner) !== undefined,
      taxQuotes: (owner) => cohortOf(owner) !== undefined,
      offers: (owner) =>
        (cohortOf(owner)?.offers ?? []).map((offer) => ({
          providerPriceId: offer.providerPriceId,
          planId: offer.planId,
          interval: offer.interval,
          currency: offer.currency,
          grossMinorUnits: offer.grossMinorUnits,
          taxTreatment: offer.taxTreatment,
        })),
    },
  };
}

/** Rails by name. A further fiat provider registers its own factory here,
 * producing a `BillingRail` with namespaced references. */
const RAIL_FACTORIES: Readonly<Record<string, (context: RailContext) => Promise<ConfiguredRail>>> =
  { stripe: configureStripeRail, faircoin: configureFaircoinRail };

/**
 * Boot opt-in. No JSON means no client construction or provider call.
 *
 * `PEABLE_BILLING_COHORT` is either ONE rail's configuration — the shape every
 * deployment used before rails coexisted, still read unchanged (a Stripe
 * configuration, or `rail: "faircoin"` with the native one) — or
 * `{ "rails": [ { "rail": "stripe", … }, { "rail": "faircoin", … } ] }`, where
 * each entry is exactly that rail's single configuration. Rails are in
 * preference order: the first one serving a merchant answers every request that
 * names no rail, so adding a rail after an existing one changes nothing for its
 * existing callers or subscribers.
 */
export async function configureBillingRuntime(
  db: Database,
  raw = config.billingCohortConfig,
  injectedClient?: StripeBillingClient,
  adapters: BillingRuntimeAdapters = {},
) {
  if (raw === undefined) {
    await reportMountedSigningKey(config.billingInvoicePrivateKeyFile);
    return undefined;
  }
  let entries: Record<string, unknown>[];
  try {
    const requested = z.record(z.unknown()).parse(JSON.parse(raw));
    entries = Object.hasOwn(requested, 'rails')
      ? z
          .object({ rails: z.array(z.record(z.unknown())).min(1).max(8) })
          .strict()
          .parse(requested).rails
      : [requested];
  } catch {
    throw new Error('Invalid PEABLE_BILLING_COHORT configuration');
  }
  const configured: ConfiguredRail[] = [];
  for (const entry of entries) {
    const { rail: name = 'stripe', ...body } = entry;
    const parsedName = billingRailId.safeParse(name);
    const factory =
      parsedName.success && Object.hasOwn(RAIL_FACTORIES, parsedName.data)
        ? RAIL_FACTORIES[parsedName.data]
        : undefined;
    if (!factory) throw new Error('Invalid PEABLE_BILLING_COHORT configuration');
    if (configured.some((existing) => existing.rail.id === parsedName.data))
      throw new Error('Each billing rail may be configured once');
    configured.push(await factory({ db, body, injectedClient, adapters }));
  }
  if (!configured.some((entry) => entry.rail.id === 'faircoin'))
    await reportMountedSigningKey(config.billingInvoicePrivateKeyFile);
  const single = <K extends 'renewals' | 'observations' | 'relay' | 'invoiceTax'>(key: K) => {
    const present = configured.flatMap((entry) => (entry[key] ? [entry[key]] : []));
    if (present.length > 1) throw new Error(`Only one billing rail may provide ${key}`);
    return present[0] as ConfiguredRail[K];
  };
  return {
    service: createMultiRailBillingService(configured.map((entry) => entry.rail)),
    renewals: single('renewals'),
    observations: single('observations'),
    relay: single('relay'),
    /** Peable Tax on the card rail: commits a quoted card sale when it is paid. */
    invoiceTax: single('invoiceTax'),
  };
}

/** The Stripe platform rail (fiat). Its configuration is the original
 * `PEABLE_BILLING_COHORT` shape, byte for byte. */
async function configureStripeRail({ db, body, injectedClient, adapters }: RailContext) {
  let parsed: z.infer<typeof cohortConfiguration>;
  try {
    parsed = cohortConfiguration.parse(body);
  } catch {
    throw new Error('Invalid PEABLE_BILLING_COHORT configuration');
  }
  if (!!parsed.faircoinExecutorRef !== !!parsed.faircoinActors)
    throw new Error('Renewal executor requires explicit actor scope');
  const executor =
    parsed.faircoinExecutorRef &&
    Object.hasOwn(adapters.faircoinExecutors ?? {}, parsed.faircoinExecutorRef)
      ? adapters.faircoinExecutors?.[parsed.faircoinExecutorRef]
      : undefined;
  if (parsed.faircoinExecutorRef && !executor)
    throw new Error('Configured renewal executor is unavailable');
  for (const actor of parsed.faircoinActors ?? []) {
    const merchant = await findMerchantByAppEnvironment(db, actor.appId, actor.environment);
    if (
      !merchant ||
      merchant.publicId !== actor.merchantId ||
      !parsed.cohorts.some(
        (cohort) =>
          cohort.merchantId === merchant.id &&
          cohort.oxyAppId === actor.appId &&
          (parsed.deployment.livemode ? 'live' : 'test') === actor.mode &&
          cohort.environment === actor.environment,
      )
    )
      throw new Error('Renewal actor is outside configured cohorts');
  }
  const renewals =
    executor && parsed.faircoinActors
      ? { db, executor, actors: structuredClone(parsed.faircoinActors) }
      : undefined;
  const checkoutOperationReader =
    parsed.checkoutOperationReaderRef &&
    Object.hasOwn(adapters.checkoutOperationReaders ?? {}, parsed.checkoutOperationReaderRef)
      ? adapters.checkoutOperationReaders?.[parsed.checkoutOperationReaderRef]
      : undefined;
  if (parsed.checkoutOperationReaderRef && !checkoutOperationReader)
    throw new Error('Configured checkout operation reader is unavailable');
  if (!injectedClient && (!config.stripe.secretKey || config.stripe.keyMode === 'unknown'))
    throw new Error('Recurring billing requires the configured platform Stripe key');
  const client = injectedClient ?? stripeBillingClient();
  const cohorts = parsed.cohorts.map(({ offers: _offers, ...owner }) => ({
    ...owner,
    ...parsed.deployment,
  }));
  const cohortOf = (owner: BillingOwner) => cohorts.find((cohort) => sameOwner(cohort, owner));
  const offersOf = (owner: BillingOwner) =>
    parsed.cohorts.find((cohort) => sameOwner(cohort, owner))?.offers ?? [];
  // Peable Tax on the card rail: one reference selects Peable's own quote,
  // checkout and invoice signer together (ADR 0012). Without it nothing below
  // is constructed and the rail is exactly the platform rail it always was.
  const peableTax = parsed.taxQuoteAdapterRef === PEABLE_TAX_SERVICE_REF;
  const builtIn = peableTax
    ? await configurePeableCardTax({ db, client, adapters, parsed, offersOf })
    : undefined;
  if (
    !peableTax &&
    (parsed.taxCheckoutAdapterRef === PEABLE_TAX_SERVICE_REF ||
      parsed.finalInvoiceAuthorityAdapterRef === PEABLE_TAX_SERVICE_REF)
  )
    throw new Error('Peable Tax checkout and invoices require its tax quotes');
  const selectedTax =
    builtIn?.calculator ??
    (parsed.taxQuoteAdapterRef &&
    Object.hasOwn(adapters.taxQuoteCalculators ?? {}, parsed.taxQuoteAdapterRef)
      ? adapters.taxQuoteCalculators?.[parsed.taxQuoteAdapterRef]
      : undefined);
  const selectedInvoice =
    builtIn?.authority ??
    (parsed.finalInvoiceAuthorityAdapterRef &&
    Object.hasOwn(adapters.finalInvoiceAuthorities ?? {}, parsed.finalInvoiceAuthorityAdapterRef)
      ? adapters.finalInvoiceAuthorities?.[parsed.finalInvoiceAuthorityAdapterRef]
      : undefined);
  if (
    (parsed.taxQuoteAdapterRef && !selectedTax) ||
    (parsed.finalInvoiceAuthorityAdapterRef && !selectedInvoice)
  )
    throw new Error('Configured fiscal adapter is unavailable');
  const selectedCheckout =
    builtIn?.checkout ??
    (parsed.taxCheckoutAdapterRef &&
    Object.hasOwn(adapters.taxCheckoutAdapters ?? {}, parsed.taxCheckoutAdapterRef)
      ? adapters.taxCheckoutAdapters?.[parsed.taxCheckoutAdapterRef]
      : undefined);
  if (
    (parsed.taxCheckoutAdapterRef || builtIn) &&
    (!selectedCheckout || !selectedTax || !selectedInvoice)
  )
    throw new Error('Fiscal checkout requires configured checkout, quote and invoice adapters');
  if (parsed.cohorts.some((cohort) => cohort.requireTaxQuote) && !selectedCheckout)
    throw new Error('Quote-required cohort needs a fiscal checkout adapter');
  const taxCheckoutAdapter = selectedCheckout
    ? {
        resolveOffer: (
          owner: Parameters<BillingTaxCheckoutAdapter['resolveOffer']>[0],
          price: string,
        ) => selectedCheckout.resolveOffer(owner, price),
        createCheckout: (
          input: Parameters<BillingTaxCheckoutAdapter['createCheckout']>[0],
          key: string,
        ) => selectedCheckout.createCheckout(input, key),
      }
    : undefined;
  const taxQuoteCalculator = selectedTax
    ? {
        ...selectedTax,
        resolveProduct: (
          owner: Parameters<BillingTaxQuoteCalculator['resolveProduct']>[0],
          plan: string,
          price?: string,
        ) =>
          price === undefined
            ? selectedTax.resolveProduct(owner, plan)
            : selectedTax.resolveProduct(owner, plan, price),
        readCustomerLocation: (
          owner: Parameters<BillingTaxQuoteCalculator['readCustomerLocation']>[0],
          evidence: string,
        ) => selectedTax.readCustomerLocation(owner, evidence),
        calculate: (input: Parameters<BillingTaxQuoteCalculator['calculate']>[0]) =>
          selectedTax.calculate(input),
        verificationKeys: pinnedKeys(selectedTax.verificationKeys),
      }
    : undefined;
  const finalInvoiceAuthority = selectedInvoice
    ? {
        read: (input: Parameters<FinalInvoiceAuthorityReader['read']>[0]) =>
          selectedInvoice.read(input),
        verificationKeys: pinnedKeys(selectedInvoice.verificationKeys),
        ...(selectedInvoice.signsTaxLines ? { signsTaxLines: true } : {}),
      }
    : undefined;
  if (cohorts.some((owner) => (owner.environment === 'production') !== parsed.deployment.livemode))
    throw new BillingError('identity_conflict');
  const provider = createStripeBillingProvider(parsed.deployment, client, {
    portalConfigurationRef: parsed.portalConfigurationRef,
  });
  // An invalid account or unsafe Portal setting is a boot failure before listening.
  await provider.verifyDeployment();
  await provider.verifyPortalConfiguration();
  const verifiedBindings = createVerifiedBillingBindings({
    db,
    client,
    deployment: parsed.deployment,
    cohorts,
  });
  const service = createBillingService({
    db,
    provider,
    cohorts,
    verifiedBindings,
    taxQuoteCalculator,
    checkoutOperationReader,
    taxCheckoutAdapter,
    finalInvoiceAuthority,
  });
  const rail: BillingRail = {
    id: 'stripe',
    settlement: 'fiat',
    renewal: 'automatic',
    service,
    // Opaque Stripe ids (`cus_…`, `sub_…`, `cs_…`): the catch-all rail, so every
    // subscriber created before rails coexisted routes here unchanged.
    serves: (owner) => cohortOf(owner) !== undefined,
    taxQuotes: (owner) =>
      cohortOf(owner) !== undefined &&
      taxQuoteCalculator !== undefined &&
      (!builtIn || offersOf(owner).length > 0),
    // Prices are the app's own Stripe prices, bound through verified bindings;
    // a Peable Tax cohort lists the ones it quotes.
    offers: (owner) => {
      const offers = offersOf(owner);
      return builtIn && offers.length
        ? offers.map((offer) => ({
            providerPriceId: offer.providerPriceId,
            planId: offer.planId,
            interval: offer.interval,
            currency: offer.currency,
            grossMinorUnits: offer.grossMinorUnits,
            taxTreatment: offer.taxTreatment,
          }))
        : null;
    },
  };
  const invoiceTax = builtIn
    ? createStripeInvoiceTaxRecorder({
        db,
        client,
        deployment: parsed.deployment,
        bindings: verifiedBindings,
      })
    : undefined;
  // No recurring queue access until the reviewed cohort explicitly opts in.
  if (!parsed.observationsEnabled) return { rail, renewals, ...(invoiceTax ? { invoiceTax } : {}) };
  const environment = cohorts[0]?.environment;
  if (!environment || cohorts.some((cohort) => cohort.environment !== environment)) {
    throw new Error('Recurring observations require one deployment environment');
  }
  return {
    rail,
    renewals,
    observations: {
      deployment: { ...parsed.deployment, environment, apiVersion: STRIPE_API_VERSION },
      reader: createOwnedBillingRecurringReader({ db, bindings: verifiedBindings, client }),
      bindOwnedInvoice: createOwnedBillingInvoiceResolver({
        db,
        bindings: verifiedBindings,
        client,
      }),
    },
    relay: { enabled: true as const, db, cohorts },
    ...(invoiceTax ? { invoiceTax } : {}),
  };
}

/** Peable's own quote calculator, Checkout adapter and invoice signer for a
 * Stripe rail entry that names `taxQuoteAdapterRef: "peable_tax"`. */
async function configurePeableCardTax(input: {
  db: Database;
  client: StripeBillingClient;
  adapters: BillingRuntimeAdapters;
  parsed: z.infer<typeof cohortConfiguration>;
  offersOf: (owner: BillingOwner) => readonly z.infer<typeof billingTaxOfferSchema>[];
}) {
  const { db, client, adapters, parsed, offersOf } = input;
  if (
    (parsed.taxCheckoutAdapterRef ?? PEABLE_TAX_SERVICE_REF) !== PEABLE_TAX_SERVICE_REF ||
    (parsed.finalInvoiceAuthorityAdapterRef ?? PEABLE_TAX_SERVICE_REF) !== PEABLE_TAX_SERVICE_REF
  )
    throw new Error('Peable Tax quotes are charged and signed by Peable Tax');
  if (!parsed.invoiceSigningKeyId)
    throw new Error('Peable Tax on the card rail requires invoiceSigningKeyId');
  if (!adapters.taxService) throw new Error('Peable Tax quotes require the tax service');
  const raw = await resolveSigningKey(adapters, parsed.invoiceSigningKeyId);
  if (!raw) throw new Error('Peable Tax on the card rail requires a pinned invoice signing key');
  const signingKey = typeof raw === 'string' ? createPrivateKey(raw) : raw;
  return {
    calculator: createPeableTaxQuoteCalculator({
      db,
      tax: adapters.taxService,
      offers: offersOf,
      signingKey,
      keyId: parsed.invoiceSigningKeyId,
      quoteLifetimeMs: CARD_QUOTE_LIFETIME_MS,
    }),
    checkout: createStripePeableTaxCheckout({ db, client, offers: offersOf }),
    authority: createPeableCardInvoiceAuthority({
      db,
      signingKey,
      keyId: parsed.invoiceSigningKeyId,
    }),
  };
}
