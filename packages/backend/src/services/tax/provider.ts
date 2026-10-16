import type {
  TaxAddress,
  TaxBehavior,
  TaxBreakdownEntry,
  TaxRegistrationScheme,
} from '@peable.to/shared-types';

/**
 * A tax calculation provider. Peable decides WHETHER a sale is taxed (by its
 * own registrations and the customer's evidenced location); a provider is
 * asked only for HOW MUCH, and only for a sale a registration covers.
 *
 * A provider is independent of the settlement rail: the same calculation
 * prices a card payment, a FairCoin payment or any further fiat provider's.
 */
export interface TaxProvider {
  readonly id: string;
  /** Whether this provider calculates in live mode (real registrations). */
  readonly livemode: boolean;
  calculate(input: TaxProviderCalculationInput): Promise<TaxProviderCalculation>;
  /** Readiness of the provider account (e.g. Stripe Tax activated, head office set). */
  status(): Promise<TaxProviderStatus>;
  /** Mirror an approved registration onto the provider account, idempotently. */
  syncRegistration?(registration: TaxProviderRegistration): Promise<{ providerRef: string }>;
  /** End a mirrored registration at `expiresAt`. */
  endRegistration?(providerRef: string, expiresAt: Date): Promise<void>;
  /** Set the provider account's head office when it has none; refuse a different one. */
  ensureHeadOffice?(address: TaxAddress): Promise<void>;
}

export interface TaxProviderCalculationInput {
  currency: string;
  customer: TaxAddress;
  shipFrom: TaxAddress | null;
  lineItems: {
    reference: string;
    amount: number;
    quantity: number;
    taxCode: string;
    taxBehavior: TaxBehavior;
  }[];
  /** Calculation-level idempotency, so a retried request is the same calculation. */
  idempotencyKey: string;
}

export interface TaxProviderCalculation {
  providerRef: string | null;
  livemode: boolean;
  lineItems: {
    reference: string;
    amount: number;
    amountTax: number;
    taxBehavior: TaxBehavior;
    breakdown: TaxBreakdownEntry[];
  }[];
  /** The provider's own expiry of this calculation, when it has one. */
  expiresAt: Date | null;
}

export interface TaxProviderStatus {
  active: boolean;
  headOffice: TaxAddress | null;
  /** Provider-side reason the account cannot calculate yet, if any. */
  missing: string[];
}

export interface TaxProviderRegistration {
  country: string;
  state: string | null;
  scheme: TaxRegistrationScheme;
  activeFrom: Date;
  expiresAt: Date | null;
}

/** Fail closed: the provider could not answer, so nothing may be quoted. */
export class TaxProviderUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`tax provider unavailable: ${reason}`);
    this.name = 'TaxProviderUnavailableError';
  }
}
