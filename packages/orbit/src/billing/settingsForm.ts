import type {
  BillingSettings,
  DunningFinalAction,
  DunningInvoiceAction,
  UpdateBillingSettingsParams,
} from '@peable.to/shared-types';

/**
 * The billing settings form (ADR 0018 §6): strings as typed, parsed and
 * diffed against the stored settings into the one body `POST /billing_settings`
 * takes. The bounds are the gateway's (`BILLING_SETTINGS_LIMITS`), restated
 * for the browser and pinned by `settingsForm.test.ts`.
 */
export const ORBIT_BILLING_LIMITS = {
  retriesMax: 8,
  retryDaysMax: 60,
  daysUntilDueMax: 365,
  invoicePrefixPattern: '^[A-Z0-9]{3,12}$',
} as const;

export const DUNNING_FINAL_ACTION_OPTIONS: readonly DunningFinalAction[] = [
  'cancel',
  'unpaid',
  'past_due',
];
export const DUNNING_INVOICE_ACTION_OPTIONS: readonly DunningInvoiceAction[] = [
  'mark_uncollectible',
  'leave_open',
];

export interface SettingsForm {
  invoicePrefix: string;
  defaultDaysUntilDue: string;
  /** Comma- or space-separated days, each after the previous attempt: `1, 3, 5, 7`. */
  retrySchedule: string;
  finalAction: DunningFinalAction;
  invoiceAction: DunningInvoiceAction;
  emailInvoiceFinalized: boolean;
  emailPaymentFailed: boolean;
}

export type SettingsFormError = 'invoicePrefix' | 'defaultDaysUntilDue' | 'retrySchedule';

export function settingsFormOf(settings: BillingSettings): SettingsForm {
  return {
    invoicePrefix: settings.invoice_prefix,
    defaultDaysUntilDue: String(settings.default_days_until_due),
    retrySchedule: settings.dunning.retry_schedule_days.join(', '),
    finalAction: settings.dunning.final_action,
    invoiceAction: settings.dunning.invoice_action,
    emailInvoiceFinalized: settings.emails.invoice_finalized,
    emailPaymentFailed: settings.emails.payment_failed,
  };
}

/**
 * `"1, 3, 5, 7"` → `[1, 3, 5, 7]`. Empty is a valid schedule (no retries: the
 * final action runs after the first failure). `null` for anything else — a
 * non-integer, a day out of range, too many retries.
 */
export function parseRetrySchedule(text: string): number[] | null {
  const parts = text
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length > ORBIT_BILLING_LIMITS.retriesMax) return null;
  const days: number[] = [];
  for (const part of parts) {
    if (!/^[1-9][0-9]*$/.test(part)) return null;
    const day = Number(part);
    if (day > ORBIT_BILLING_LIMITS.retryDaysMax) return null;
    days.push(day);
  }
  return days;
}

/** The total length of a schedule in days — what the form explains back. */
export function scheduleWindowDays(days: readonly number[]): number {
  return days.reduce((sum, day) => sum + day, 0);
}

export type SettingsBodyResult =
  | { ok: true; body: UpdateBillingSettingsParams }
  | { ok: false; error: SettingsFormError };

/** Only what changed, so a save never rewrites a field someone else just set. */
export function buildSettingsBody(
  form: SettingsForm,
  current: BillingSettings,
): SettingsBodyResult {
  const prefix = form.invoicePrefix.trim().toUpperCase();
  if (!new RegExp(ORBIT_BILLING_LIMITS.invoicePrefixPattern).test(prefix)) {
    return { ok: false, error: 'invoicePrefix' };
  }
  const daysText = form.defaultDaysUntilDue.trim();
  if (
    !/^(0|[1-9][0-9]*)$/.test(daysText) ||
    Number(daysText) > ORBIT_BILLING_LIMITS.daysUntilDueMax
  ) {
    return { ok: false, error: 'defaultDaysUntilDue' };
  }
  const schedule = parseRetrySchedule(form.retrySchedule);
  if (schedule === null) return { ok: false, error: 'retrySchedule' };

  const body: UpdateBillingSettingsParams = {};
  if (prefix !== current.invoice_prefix) body.invoice_prefix = prefix;
  if (Number(daysText) !== current.default_days_until_due) {
    body.default_days_until_due = Number(daysText);
  }
  const dunning: NonNullable<UpdateBillingSettingsParams['dunning']> = {};
  if (schedule.join(',') !== current.dunning.retry_schedule_days.join(',')) {
    dunning.retry_schedule_days = schedule;
  }
  if (form.finalAction !== current.dunning.final_action) dunning.final_action = form.finalAction;
  if (form.invoiceAction !== current.dunning.invoice_action) {
    dunning.invoice_action = form.invoiceAction;
  }
  if (Object.keys(dunning).length > 0) body.dunning = dunning;
  const emails: NonNullable<UpdateBillingSettingsParams['emails']> = {};
  if (form.emailInvoiceFinalized !== current.emails.invoice_finalized) {
    emails.invoice_finalized = form.emailInvoiceFinalized;
  }
  if (form.emailPaymentFailed !== current.emails.payment_failed) {
    emails.payment_failed = form.emailPaymentFailed;
  }
  if (Object.keys(emails).length > 0) body.emails = emails;
  return { ok: true, body };
}

/** A feature's `lookup_key`: what an app checks, so it is stable and plain. */
export const FEATURE_LOOKUP_KEY = /^[A-Za-z0-9_.:-]{1,80}$/;

export type FeatureFormResult =
  | { ok: true; body: { lookup_key: string; name: string } }
  | { ok: false; error: 'lookupKey' | 'name' };

export function buildFeatureBody(form: { lookupKey: string; name: string }): FeatureFormResult {
  const lookupKey = form.lookupKey.trim();
  if (!FEATURE_LOOKUP_KEY.test(lookupKey)) return { ok: false, error: 'lookupKey' };
  const name = form.name.trim();
  if (name.length < 1 || name.length > 80) return { ok: false, error: 'name' };
  return { ok: true, body: { lookup_key: lookupKey, name } };
}
