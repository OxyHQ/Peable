import type {
  AccountPayoutSchedule,
  CreateAccountLinkParams,
  CreatePayoutParams,
  CurrencyCode,
  PayoutInterval,
  PayoutWeeklyAnchor,
  UpdateAccountParams,
} from '@peable.to/shared-types';
import { isOrbitApiError } from '../api/transport';
import {
  exceedsBaseUnits,
  normalizeCurrency,
  ORBIT_CURRENCY_DECIMALS,
  parseAmountInput,
} from '../format/money';
import { ORBIT_WEEKLY_ANCHORS } from './vocabulary';

export type FormResult<T, E extends string> = { ok: true; body: T } | { ok: false; error: E };

// --- Pay out -------------------------------------------------------------

/** What the Pay out form holds: the amount as typed, and the currency picked. */
export interface PayoutForm {
  amount: string;
  currency: string;
}

export type PayoutFormError = 'amount' | 'currency' | 'exceeds';

/**
 * The `POST …/payouts` body, or why not. `available` is the payable figure per
 * currency (`payableCurrencies`); asking for more is refused here so the
 * merchant is told before the provider is asked. FairCoin is never payable.
 */
export function buildPayoutBody(
  form: PayoutForm,
  available: readonly { currency: string; amount: string }[],
): FormResult<CreatePayoutParams, PayoutFormError> {
  const currency = normalizeCurrency(form.currency);
  const balance = available.find((entry) => entry.currency === currency);
  if (!balance || currency === 'FAIR' || !Object.hasOwn(ORBIT_CURRENCY_DECIMALS, currency)) {
    return { ok: false, error: 'currency' };
  }
  const amount = parseAmountInput(form.amount, currency);
  if (amount === null) return { ok: false, error: 'amount' };
  if (exceedsBaseUnits(amount, balance.amount)) return { ok: false, error: 'exceeds' };
  return { ok: true, body: { amount, currency: currency as CurrencyCode } };
}

/** A payout instruction kept with its `Idempotency-Key` until its outcome is known. */
export interface PendingPayout {
  key: string;
  body: CreatePayoutParams;
}

/** Where a scope's unanswered payout instruction is kept across reloads. */
export function pendingPayoutStorageKey(scope: {
  applicationId: string;
  environment: string;
}): string {
  return `peable-orbit:pending-payout:${scope.applicationId}:${scope.environment}`;
}

/** A stored pending payout, read defensively: anything malformed is no pending payout. */
export function parsePendingPayout(raw: string | null | undefined): PendingPayout | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingPayout> | null;
    const body = value?.body;
    if (
      typeof value?.key !== 'string' ||
      !body ||
      typeof body.amount !== 'string' ||
      !/^[1-9][0-9]*$/.test(body.amount) ||
      typeof body.currency !== 'string'
    ) {
      return null;
    }
    const currency = normalizeCurrency(body.currency);
    if (!Object.hasOwn(ORBIT_CURRENCY_DECIMALS, currency) || currency === 'FAIR') return null;
    return { key: value.key, body: { amount: body.amount, currency: currency as CurrencyCode } };
  } catch {
    return null;
  }
}

/**
 * Whether a failed payout instruction may still have been executed — no
 * answer, or a 5xx — so the SAME key must be retried rather than a new
 * instruction made. A 4xx is the gateway's answer: nothing was paid out.
 */
export function payoutOutcomeUnknown(error: unknown): boolean {
  if (!isOrbitApiError(error)) return true;
  return error.status === 0 || error.status >= 500;
}

/** Decimal places the amount field takes for `currency` (for the hint). */
export function amountDecimals(currency: string): number {
  const code = normalizeCurrency(currency);
  return Object.hasOwn(ORBIT_CURRENCY_DECIMALS, code)
    ? ORBIT_CURRENCY_DECIMALS[code as CurrencyCode]
    : 0;
}

// --- Payout schedule -----------------------------------------------------

export interface ScheduleForm {
  interval: PayoutInterval;
  /** Days, as typed; empty keeps the provider's current delay. */
  delayDays: string;
  weeklyAnchor: PayoutWeeklyAnchor | '';
  /** 1–31, as typed. */
  monthlyAnchor: string;
}

export type ScheduleFormError = 'delay' | 'weekly' | 'monthly';

export function formFromSchedule(schedule: AccountPayoutSchedule | null): ScheduleForm {
  return {
    interval: schedule?.interval ?? 'manual',
    delayDays:
      schedule?.delay_days === null || schedule?.delay_days === undefined
        ? ''
        : String(schedule.delay_days),
    weeklyAnchor: schedule?.weekly_anchor ?? '',
    monthlyAnchor:
      schedule?.monthly_anchor === null || schedule?.monthly_anchor === undefined
        ? ''
        : String(schedule.monthly_anchor),
  };
}

/** A whole number within `[min, max]`, or `undefined`. */
function wholeIn(text: string, min: number, max: number): number | undefined {
  const trimmed = text.trim();
  if (!/^[0-9]+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

export const MAX_DELAY_DAYS = 365;

/**
 * `POST …/account` with `settings.payouts.schedule`, carrying only the anchor
 * its interval uses — the provider refuses a weekly anchor on a monthly
 * schedule.
 */
export function buildScheduleBody(
  form: ScheduleForm,
): FormResult<UpdateAccountParams, ScheduleFormError> {
  const schedule: NonNullable<
    NonNullable<NonNullable<UpdateAccountParams['settings']>['payouts']>['schedule']
  > = { interval: form.interval };
  if (form.delayDays.trim()) {
    const delay = wholeIn(form.delayDays, 1, MAX_DELAY_DAYS);
    if (delay === undefined) return { ok: false, error: 'delay' };
    schedule.delay_days = delay;
  }
  if (form.interval === 'weekly') {
    if (!form.weeklyAnchor || !ORBIT_WEEKLY_ANCHORS.includes(form.weeklyAnchor)) {
      return { ok: false, error: 'weekly' };
    }
    schedule.weekly_anchor = form.weeklyAnchor;
  }
  if (form.interval === 'monthly') {
    const day = wholeIn(form.monthlyAnchor, 1, 31);
    if (day === undefined) return { ok: false, error: 'monthly' };
    schedule.monthly_anchor = day;
  }
  return { ok: true, body: { settings: { payouts: { schedule } } } };
}

// --- Opening the account -------------------------------------------------

export interface CreateAccountForm {
  country: string;
  businessType: 'individual' | 'company';
}

export const EMPTY_CREATE_ACCOUNT_FORM: CreateAccountForm = {
  country: '',
  businessType: 'company',
};

/** The first `POST …/account`: an ISO 3166-1 alpha-2 country, upper-cased, and the business type. */
export function buildCreateAccountBody(
  form: CreateAccountForm,
): FormResult<UpdateAccountParams, 'country'> {
  const country = form.country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return { ok: false, error: 'country' };
  return { ok: true, body: { country, business_type: form.businessType } };
}

// --- Onboarding link -----------------------------------------------------

/** Where Orbit's Account page lives, so the provider sends the merchant back to it. */
export const ACCOUNT_PATH = '/account';

/**
 * The `POST …/account_links` body: both URLs point back at Orbit's Account
 * page; `refresh_url` marks an expired link so the page can mint a fresh one.
 * Always `account_onboarding`, which the provider also uses to collect what is
 * owed later.
 */
export function onboardingLinkBody(origin: string): CreateAccountLinkParams {
  const base = origin.replace(/\/+$/, '');
  return {
    return_url: `${base}${ACCOUNT_PATH}`,
    refresh_url: `${base}${ACCOUNT_PATH}?refresh=1`,
    type: 'account_onboarding',
  };
}

/** The origin of a URL (`https://orbit.peable.to/x` → `https://orbit.peable.to`), or it unchanged. */
export function originOf(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i.exec(url.trim());
  return match?.[1] ?? url.trim();
}
