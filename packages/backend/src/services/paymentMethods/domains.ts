/**
 * Payment method domains (`pmd_…`): the web domains a merchant serves payment
 * pages from, registered at the provider so Apple Pay and Google Pay run there.
 *
 * The provider is asked first and the row records its answer: a registration
 * the provider refused must not read as one Orbit holds. The wallets' standing
 * (`active` / `inactive`) is the provider's word, rendered in Peable's.
 */
import type { PaymentMethodDomain } from '@peable.to/shared-types';
import {
  findDomainByName,
  insertDomain,
  updateDomainStanding,
  type DomainStanding,
  type PaymentMethodDomainRow,
} from '../../db/paymentMethods/paymentMethodConfigurationRepository';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { getDb } from '../../db/postgres';
import { toUnix } from '../../lib/time';
import { selectCardProvider, selectStoredProvider } from '../providers/environmentGuard';
import {
  isDomainRegisteringProvider,
  type DomainRegisteringProvider,
  type ProviderId,
  type ProviderPaymentMethodDomain,
} from '../providers/provider';

/** A domain the merchant cannot register — a 400 naming `domain_name`. */
export class DomainParameterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainParameterError';
  }
}

/** The domain is registered — by another merchant on this deployment — a 409. */
export class DomainTakenError extends Error {
  constructor() {
    super('this domain is already registered for wallets by another account');
    this.name = 'DomainTakenError';
  }
}

/** The rail cannot register domains in this mode — a 503. */
export class DomainsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainsUnavailableError';
  }
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Peable's own hosts: the hosted checkout's domain is registered by Peable for
 * every merchant, and no merchant may claim a name under it.
 */
const RESERVED_SUFFIXES = ['peable.to', 'oxy.so', 'kaana.ai'] as const;

/**
 * A hostname as the wallets verify it: lowercase, no scheme, port, path, IP
 * literal or trailing dot, at least two labels, an alphabetic top-level label.
 * The same rule as `payment_method_domains_domain_name_check`.
 */
export function normalizeDomainName(input: string): string {
  const name = input.trim().toLowerCase().replace(/\.$/, '');
  if (name.length === 0 || name.length > 253) {
    throw new DomainParameterError('domain_name must be a hostname of at most 253 characters');
  }
  if (/[/:@?#\s]/.test(name)) {
    throw new DomainParameterError(
      'domain_name is a bare hostname: no scheme, port, path or credentials (example.com, shop.example.com)',
    );
  }
  const labels = name.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    throw new DomainParameterError('domain_name must be a hostname such as shop.example.com');
  }
  if (!/^[a-z]/.test(labels.at(-1) ?? '')) {
    throw new DomainParameterError('domain_name must be a hostname, not an IP address');
  }
  if (RESERVED_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`))) {
    throw new DomainParameterError(
      'Peable and Oxy domains are registered by Peable; name a domain you serve',
    );
  }
  return name;
}

function standingOf(domain: ProviderPaymentMethodDomain): DomainStanding {
  return {
    enabled: domain.enabled,
    applePayStatus: domain.applePay.status,
    applePayError: domain.applePay.status === 'active' ? null : domain.applePay.error,
    googlePayStatus: domain.googlePay.status,
    googlePayError: domain.googlePay.status === 'active' ? null : domain.googlePay.error,
  };
}

function registeringProvider(
  provider: ReturnType<typeof selectCardProvider>,
  mode: string,
): DomainRegisteringProvider {
  if (!provider) {
    throw new DomainsUnavailableError(
      `the card rail is not configured for ${mode} mode on this deployment`,
    );
  }
  if (!isDomainRegisteringProvider(provider)) {
    throw new DomainsUnavailableError(`the ${provider.id} rail cannot register domains`);
  }
  return provider;
}

function storedProvider(row: PaymentMethodDomainRow): DomainRegisteringProvider {
  return registeringProvider(
    selectStoredProvider(row.provider as ProviderId, row.livemode),
    row.livemode ? 'live' : 'test',
  );
}

/**
 * Register `domainName` for `merchant`. A domain the merchant already holds is
 * answered as it stands (`created: false`) — registering twice is not two
 * domains.
 */
export async function createPaymentMethodDomain(
  merchant: MerchantRow,
  params: { readonly domainName: string; readonly enabled: boolean },
): Promise<{ domain: PaymentMethodDomainRow; created: boolean }> {
  const domainName = normalizeDomainName(params.domainName);
  const db = getDb();
  const existing = await findDomainByName(db, merchant.id, domainName);
  if (existing) return { domain: existing, created: false };

  const provider = registeringProvider(
    selectCardProvider(merchant.environment),
    merchant.livemode ? 'live' : 'test',
  );
  const registered = await provider.createPaymentMethodDomain({
    domainName,
    enabled: params.enabled,
    // Per merchant and name: a retry is the same registration.
    idempotencyKey: `pmd:${merchant.publicId}:${domainName}`,
  });
  const inserted = await insertDomain(db, {
    merchantId: merchant.id,
    domainName,
    provider: provider.id,
    providerObjectId: registered.providerObjectId,
    ...standingOf(registered),
  });
  if (inserted) return { domain: inserted, created: true };
  // A racing request of this merchant won, or the provider object is another
  // merchant's — the second is the only one that is not this merchant's row.
  const raced = await findDomainByName(db, merchant.id, domainName);
  if (raced) return { domain: raced, created: false };
  throw new DomainTakenError();
}

export async function setPaymentMethodDomainEnabled(
  row: PaymentMethodDomainRow,
  enabled: boolean,
): Promise<PaymentMethodDomainRow> {
  const answer = await storedProvider(row).updatePaymentMethodDomain({
    providerObjectId: row.providerObjectId,
    enabled,
  });
  return (await updateDomainStanding(getDb(), row.id, standingOf(answer))) ?? row;
}

/** Ask the wallets to verify the domain again (`…/validate`), and record the answer. */
export async function validatePaymentMethodDomain(
  row: PaymentMethodDomainRow,
): Promise<PaymentMethodDomainRow> {
  const answer = await storedProvider(row).validatePaymentMethodDomain(row.providerObjectId);
  return (await updateDomainStanding(getDb(), row.id, standingOf(answer))) ?? row;
}

export function toPaymentMethodDomainDTO(row: PaymentMethodDomainRow): PaymentMethodDomain {
  const wallet = (status: 'active' | 'inactive', error: string | null) => ({
    status,
    status_details: status === 'inactive' && error !== null ? { error_message: error } : null,
  });
  return {
    id: row.publicId,
    object: 'payment_method_domain',
    livemode: row.livemode,
    domain_name: row.domainName,
    enabled: row.enabled,
    apple_pay: wallet(row.applePayStatus, row.applePayError),
    google_pay: wallet(row.googlePayStatus, row.googlePayError),
    created: toUnix(row.createdAt),
  };
}
