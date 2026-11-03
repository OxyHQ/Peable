/**
 * Payment method breadth on the card rail: what a configuration offers, which
 * methods a payment carries, and the provider binding behind both.
 *
 * ## Availability is an intersection, and the answer says which side failed
 *
 * A method is offered when the merchant turned it on (or left Orbit's default
 * on), the provider can process it at all (`PROVIDER_PAYMENT_METHODS`), a
 * wallet's card rail is on, and — per payment — the currency is one it takes
 * (`PAYMENT_METHOD_CURRENCIES`). The configuration says why a method cannot be
 * offered (`unavailable_reason`) rather than hiding it: truthful UI
 * (`docs/integrations/payment-provider-boundary.md`).
 *
 * ## The provider binding is pushed lazily, and never behind its row
 *
 * A configuration's provider object is created the first time a payment needs
 * it, per mode, and pushed again whenever its row's `version` moved since — so
 * a method the merchant turned off is never offered by a stale provider copy.
 */
import {
  CARD_RAIL_PAYMENT_METHOD_TYPES,
  PAYMENT_METHOD_CONFIGURATION_TYPES,
  PAYMENT_METHOD_CURRENCIES,
  type CardRailPaymentMethodType,
  type CurrencyCode,
  type PaymentMethodConfiguration,
  type PaymentMethodConfigurationEntry,
  type PaymentMethodConfigurationType,
} from '@peable.to/shared-types';
import {
  ensureDefaultConfiguration,
  findConfigurationBinding,
  findConfigurationByPublicId,
  upsertConfigurationBinding,
  type PaymentMethodConfigurationRow,
} from '../../db/paymentMethods/paymentMethodConfigurationRepository';
import { getDb } from '../../db/postgres';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { toUnix } from '../../lib/time';
import {
  isPaymentMethodConfiguringProvider,
  PROVIDER_PAYMENT_METHODS,
  type PaymentProvider,
  type ProviderId,
} from '../providers/provider';

/**
 * Orbit's default per method, for a merchant who never chose. Cards and the two
 * wallets over them are on — what every payer can use; local methods are off
 * until the merchant opts in, because each comes with its own settlement time
 * (SEPA Debit takes days) a merchant should choose knowingly.
 */
export const DEFAULT_PREFERENCES: Readonly<Record<PaymentMethodConfigurationType, 'on' | 'off'>> =
  Object.freeze({
    card: 'on',
    apple_pay: 'on',
    google_pay: 'on',
    sepa_debit: 'off',
    ideal: 'off',
    bancontact: 'off',
    eps: 'off',
    bizum: 'off',
  });

const WALLETS: ReadonlySet<PaymentMethodConfigurationType> = new Set(['apple_pay', 'google_pay']);

/** The provider a merchant's card payments go through. One today. */
const CARD_PROVIDER: ProviderId = 'stripe';

function preferenceOf(
  row: PaymentMethodConfigurationRow,
  type: PaymentMethodConfigurationType,
): 'on' | 'off' {
  return row.preferences[type] ?? DEFAULT_PREFERENCES[type];
}

/** One method of a configuration, as the wire shows it. */
export function entryFor(
  row: PaymentMethodConfigurationRow,
  type: PaymentMethodConfigurationType,
  provider: ProviderId = CARD_PROVIDER,
): PaymentMethodConfigurationEntry {
  const value = preferenceOf(row, type);
  const supported = PROVIDER_PAYMENT_METHODS[provider].includes(type);
  const unavailable_reason = !supported
    ? 'provider_unsupported'
    : WALLETS.has(type) && preferenceOf(row, 'card') === 'off'
      ? 'requires_card'
      : null;
  return {
    available: value === 'on' && unavailable_reason === null,
    display_preference: { preference: row.preferences[type] ?? 'none', value },
    unavailable_reason,
    currencies: PAYMENT_METHOD_CURRENCIES[type],
  };
}

export function toPaymentMethodConfigurationDTO(
  row: PaymentMethodConfigurationRow,
): PaymentMethodConfiguration {
  const entries = Object.fromEntries(
    PAYMENT_METHOD_CONFIGURATION_TYPES.map((type) => [type, entryFor(row, type)]),
  ) as Record<PaymentMethodConfigurationType, PaymentMethodConfigurationEntry>;
  return {
    id: row.publicId,
    object: 'payment_method_configuration',
    livemode: row.livemode,
    name: row.name,
    active: row.active,
    is_default: row.isDefault,
    created: toUnix(row.createdAt),
    updated_at: toUnix(row.updatedAt),
    ...entries,
  };
}

/**
 * The card-rail types a payment in `currency` carries under `row`: every
 * available method that takes the currency, wallets folded into `card`.
 */
export function cardRailTypesFor(
  row: PaymentMethodConfigurationRow,
  currency: CurrencyCode,
): CardRailPaymentMethodType[] {
  const offered = new Set<CardRailPaymentMethodType>();
  for (const type of PAYMENT_METHOD_CONFIGURATION_TYPES) {
    const entry = entryFor(row, type);
    if (!entry.available || !(entry.currencies as readonly string[]).includes(currency)) continue;
    offered.add(WALLETS.has(type) ? 'card' : (type as CardRailPaymentMethodType));
  }
  return CARD_RAIL_PAYMENT_METHOD_TYPES.filter((type) => offered.has(type));
}

/** A payment-method parameter on a PaymentIntent create that cannot be honoured — a 400. */
export class PaymentMethodsParameterError extends Error {
  constructor(
    message: string,
    readonly param: string,
    readonly code: 'parameter_invalid' | 'resource_missing' = 'parameter_invalid',
  ) {
    super(message);
    this.name = 'PaymentMethodsParameterError';
  }
}

/** What a card payment offers, decided ONCE at creation. */
export interface CardPaymentMethods {
  readonly types: CardRailPaymentMethodType[];
  /** The configuration they came from, or `null` when the merchant named the types. */
  readonly configuration: PaymentMethodConfigurationRow | null;
}

/**
 * Decide a card payment's methods.
 *
 *  - a saved `payment_method` charges as what it is: `['card']`;
 *  - `payment_method_types` named: exactly those, each one the provider
 *    processes and that takes the currency;
 *  - otherwise the named configuration (active, the merchant's own) or the
 *    merchant's default, filtered by currency — and at least one must remain.
 *
 * @throws {PaymentMethodsParameterError}
 */
export async function resolveCardPaymentMethods(
  merchant: MerchantRow,
  currency: CurrencyCode,
  input: {
    readonly paymentMethodTypes?: readonly string[] | undefined;
    readonly paymentMethodConfiguration?: string | undefined;
    readonly savedPaymentMethod: boolean;
  },
): Promise<CardPaymentMethods> {
  if (input.paymentMethodTypes !== undefined && input.paymentMethodConfiguration !== undefined) {
    throw new PaymentMethodsParameterError(
      'name payment_method_types or payment_method_configuration, not both',
      'payment_method_configuration',
    );
  }
  if (input.paymentMethodTypes !== undefined) {
    const types = [...new Set(input.paymentMethodTypes)];
    for (const type of types) {
      if (!(CARD_RAIL_PAYMENT_METHOD_TYPES as readonly string[]).includes(type)) {
        throw new PaymentMethodsParameterError(
          `'${type}' is not a card-rail payment method type`,
          'payment_method_types',
        );
      }
      const known = type as CardRailPaymentMethodType;
      if (!PROVIDER_PAYMENT_METHODS[CARD_PROVIDER].includes(known)) {
        throw new PaymentMethodsParameterError(
          `'${type}' is not offered by the processing provider`,
          'payment_method_types',
        );
      }
      if (!(PAYMENT_METHOD_CURRENCIES[known] as readonly string[]).includes(currency)) {
        throw new PaymentMethodsParameterError(
          `'${type}' does not take payments in ${currency}`,
          'payment_method_types',
        );
      }
    }
    if (input.savedPaymentMethod && (types.length !== 1 || types[0] !== 'card')) {
      throw new PaymentMethodsParameterError(
        "a payment charged to a saved card takes payment_method_types ['card']",
        'payment_method_types',
      );
    }
    return { types: types as CardRailPaymentMethodType[], configuration: null };
  }
  if (input.savedPaymentMethod) {
    if (input.paymentMethodConfiguration !== undefined) {
      throw new PaymentMethodsParameterError(
        'a payment charged to a saved card names no payment_method_configuration',
        'payment_method_configuration',
      );
    }
    return { types: ['card'], configuration: null };
  }

  const db = getDb();
  let configuration: PaymentMethodConfigurationRow;
  if (input.paymentMethodConfiguration !== undefined) {
    const named = await findConfigurationByPublicId(
      db,
      merchant.id,
      input.paymentMethodConfiguration,
    );
    if (!named) {
      throw new PaymentMethodsParameterError(
        `no such payment method configuration: '${input.paymentMethodConfiguration}'`,
        'payment_method_configuration',
        'resource_missing',
      );
    }
    if (!named.active) {
      throw new PaymentMethodsParameterError(
        'this payment method configuration is not active',
        'payment_method_configuration',
      );
    }
    configuration = named;
  } else {
    configuration = await ensureDefaultConfiguration(db, merchant.id);
  }
  const types = cardRailTypesFor(configuration, currency);
  if (types.length === 0) {
    throw new PaymentMethodsParameterError(
      `no payment method this configuration offers takes payments in ${currency}`,
      'payment_method_configuration',
    );
  }
  return { types, configuration };
}

/** The provider has no configuration capability: a 503 for the request that needed one. */
export class PaymentMethodConfigurationsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentMethodConfigurationsUnavailableError';
  }
}

/**
 * The provider configuration behind `row`, created or pushed when the binding
 * is missing or behind the row's version. Idempotent per version at the
 * provider (`pmc:<pmc_…>:<provider>:v<version>`).
 */
export async function ensureProviderConfiguration(
  row: PaymentMethodConfigurationRow,
  provider: PaymentProvider,
): Promise<string> {
  const db = getDb();
  const binding = await findConfigurationBinding(db, row.id, provider.id);
  if (binding !== null && binding.syncedVersion >= row.version) return binding.providerObjectId;
  if (!isPaymentMethodConfiguringProvider(provider)) {
    throw new PaymentMethodConfigurationsUnavailableError(
      `the ${provider.id} rail cannot hold a payment method configuration`,
    );
  }
  const methods = Object.fromEntries(
    PROVIDER_PAYMENT_METHODS[provider.id].map((type) => [
      type,
      entryFor(row, type, provider.id).available ? 'on' : 'off',
    ]),
  ) as Partial<Record<PaymentMethodConfigurationType, 'on' | 'off'>>;
  const saved = await provider.savePaymentMethodConfiguration({
    ...(binding !== null ? { providerObjectId: binding.providerObjectId } : {}),
    configurationId: row.publicId,
    methods,
    idempotencyKey: `pmc:${row.publicId}:${provider.id}:v${String(row.version)}`,
  });
  await upsertConfigurationBinding(db, {
    configurationId: row.id,
    provider: provider.id,
    providerObjectId: saved.providerObjectId,
    syncedVersion: row.version,
  });
  return saved.providerObjectId;
}
