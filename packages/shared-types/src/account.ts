// The merchant's fiat account (ADR 0015 §1) — `GET /v1/account`.
//
// Orbit's funds never reach a Peable bank account: a merchant that takes fiat
// has its OWN provider account, opened and onboarded through Peable, and this
// object mirrors it. Everything here is what the provider last reported; the
// provider is the authority and Orbit never decides readiness itself.
//
// A marketplace's sellers (`/v1/connected_accounts`) are provider accounts too,
// and a platform reads one of them in this same shape by sending
// `Peable-Account: ca_…` to `GET /v1/account`.

/** A capability's state as the provider reports it; `null` means never requested. */
export type AccountCapabilityStatus = 'active' | 'pending' | 'inactive';

/** Whose account this is: the merchant's own, or one of its marketplace sellers. */
export type AccountType = 'merchant' | 'connected';

/**
 * What the provider is waiting on. Requirement IDENTIFIERS only
 * (`individual.verification.document`), never their values: the gateway
 * records that a document is owed and never learns what it says.
 */
export interface AccountRequirements {
  currently_due: string[];
  eventually_due: string[];
  past_due: string[];
  /** Submitted and being checked — nothing for the merchant to do. */
  pending_verification: string[];
  /** Why charges or payouts are disabled, in the provider's own code, or `null`. */
  disabled_reason: string | null;
}

export interface AccountBusinessProfile {
  name: string | null;
  url: string | null;
  support_email: string | null;
  support_url: string | null;
  product_description: string | null;
  /** Merchant category code. */
  mcc: string | null;
}

export const PAYOUT_INTERVALS = ['manual', 'daily', 'weekly', 'monthly'] as const;
export type PayoutInterval = (typeof PAYOUT_INTERVALS)[number];

export const PAYOUT_WEEKLY_ANCHORS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;
export type PayoutWeeklyAnchor = (typeof PAYOUT_WEEKLY_ANCHORS)[number];

/**
 * When the provider pays the balance out. `manual` means only an explicit
 * `POST /v1/payouts` does — the provider still executes it; Orbit never moves
 * the money itself (ADR 0015 §4).
 */
export interface AccountPayoutSchedule {
  interval: PayoutInterval;
  /** Days between a payment and its funds becoming payable; `null` when not reported. */
  delay_days: number | null;
  /** `weekly` only. */
  weekly_anchor: PayoutWeeklyAnchor | null;
  /** `monthly` only: the day of the month, 1–31. */
  monthly_anchor: number | null;
}

export interface AccountSettings {
  payouts: {
    schedule: AccountPayoutSchedule | null;
    /** What the merchant's bank statement shows for a payout. */
    statement_descriptor: string | null;
  };
  payments: {
    /** What a cardholder's statement shows — the merchant is the merchant of record. */
    statement_descriptor: string | null;
  };
  branding: {
    primary_color: string | null;
    secondary_color: string | null;
  };
}

export interface Account {
  /** `ca_…` — the same id space as a marketplace seller. */
  id: string;
  object: 'account';
  /** `true` for a `production` merchant (ADR 0017). */
  livemode: boolean;
  type: AccountType;
  /** ISO 3166-1 alpha-2. Fixed at the provider once created. */
  country: string;
  default_currency: string | null;
  business_profile: AccountBusinessProfile;
  capabilities: {
    card_payments: AccountCapabilityStatus | null;
    transfers: AccountCapabilityStatus | null;
  };
  requirements: AccountRequirements;
  /** Whether the account can take payments as merchant of record (`on_behalf_of`). */
  charges_enabled: boolean;
  /** Whether the provider will pay this account's balance out. */
  payouts_enabled: boolean;
  settings: AccountSettings;
  /** The last provider read; `null` before the first one completed. */
  last_synced_at: number | null;
  created: number;
}

/** `POST /v1/account`: the account's settings, written to the provider and read back. */
export interface UpdateAccountParams {
  /**
   * Opening the account: required the first time (when the merchant has none),
   * refused afterwards — a provider account's country cannot change.
   */
  country?: string;
  business_type?: 'individual' | 'company';
  business_profile?: Partial<AccountBusinessProfile>;
  settings?: {
    payouts?: {
      schedule?: {
        interval: PayoutInterval;
        delay_days?: number;
        weekly_anchor?: PayoutWeeklyAnchor;
        monthly_anchor?: number;
      };
      statement_descriptor?: string;
    };
    payments?: { statement_descriptor?: string };
    branding?: { primary_color?: string; secondary_color?: string };
  };
}

/** `POST /v1/account_links`: hosted onboarding (or an update of what was submitted). */
export interface CreateAccountLinkParams {
  refresh_url: string;
  return_url: string;
  /** Defaults to `account_onboarding`. */
  type?: 'account_onboarding' | 'account_update';
}
