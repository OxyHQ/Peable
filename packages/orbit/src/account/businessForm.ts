import type { Account, AccountBusinessProfile, UpdateAccountParams } from '@peable.to/shared-types';

/**
 * Settings › Business details: the business profile and statement descriptors
 * of the merchant's own account, written with `POST …/account` (the provider
 * stores them; Orbit reads them back). The rules mirror the gateway's
 * `updateAccountBodySchema`, so a value is refused here before it is sent.
 *
 * A field can be CHANGED but not removed — the account API takes no `null` —
 * so emptying a field that has a value is refused with its own reason, rather
 * than silently keeping the old value.
 */
export interface BusinessForm {
  name: string;
  url: string;
  supportEmail: string;
  supportUrl: string;
  productDescription: string;
  mcc: string;
  statementDescriptor: string;
  payoutDescriptor: string;
}

export type BusinessField = keyof BusinessForm;
export type BusinessFormError = { field: BusinessField; reason: 'invalid' | 'cannotClear' };

export function businessFormOf(account: Account): BusinessForm {
  const profile = account.business_profile;
  return {
    name: profile.name ?? '',
    url: profile.url ?? '',
    supportEmail: profile.support_email ?? '',
    supportUrl: profile.support_url ?? '',
    productDescription: profile.product_description ?? '',
    mcc: profile.mcc ?? '',
    statementDescriptor: account.settings.payments.statement_descriptor ?? '',
    payoutDescriptor: account.settings.payouts.statement_descriptor ?? '',
  };
}

const isUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};
const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320;
/** 5–22 characters, none of `< > \ ' " *` — the card networks' rule. */
const isDescriptor = (value: string) => /^[^<>\\'"*]{5,22}$/.test(value);

const RULES: Record<BusinessField, (value: string) => boolean> = {
  name: (value) => value.length >= 1 && value.length <= 200,
  url: (value) => value.length <= 2048 && isUrl(value),
  supportEmail: isEmail,
  supportUrl: (value) => value.length <= 2048 && isUrl(value),
  productDescription: (value) => value.length <= 1000,
  mcc: (value) => /^[0-9]{4}$/.test(value),
  statementDescriptor: isDescriptor,
  payoutDescriptor: isDescriptor,
};

const PROFILE_FIELDS: Record<
  'name' | 'url' | 'supportEmail' | 'supportUrl' | 'productDescription' | 'mcc',
  keyof AccountBusinessProfile
> = {
  name: 'name',
  url: 'url',
  supportEmail: 'support_email',
  supportUrl: 'support_url',
  productDescription: 'product_description',
  mcc: 'mcc',
};

/**
 * The `POST …/account` body carrying only what changed, or the first field
 * that is wrong. `null` body: nothing changed.
 */
export function buildBusinessBody(
  form: BusinessForm,
  current: BusinessForm,
): { ok: true; body: UpdateAccountParams | null } | { ok: false; error: BusinessFormError } {
  const changed: Partial<Record<BusinessField, string>> = {};
  for (const field of Object.keys(RULES) as BusinessField[]) {
    const value = form[field].trim();
    if (value === current[field].trim()) continue;
    if (!value) return { ok: false, error: { field, reason: 'cannotClear' } };
    if (!RULES[field](value)) return { ok: false, error: { field, reason: 'invalid' } };
    changed[field] = value;
  }
  if (Object.keys(changed).length === 0) return { ok: true, body: null };

  const profile: Partial<Record<keyof AccountBusinessProfile, string>> = {};
  for (const [field, wire] of Object.entries(PROFILE_FIELDS) as [
    keyof typeof PROFILE_FIELDS,
    keyof AccountBusinessProfile,
  ][]) {
    const value = changed[field];
    if (value !== undefined) profile[wire] = value;
  }
  const body: UpdateAccountParams = {};
  if (Object.keys(profile).length) body.business_profile = profile;
  const settings: NonNullable<UpdateAccountParams['settings']> = {};
  if (changed.statementDescriptor !== undefined) {
    settings.payments = { statement_descriptor: changed.statementDescriptor };
  }
  if (changed.payoutDescriptor !== undefined) {
    settings.payouts = { statement_descriptor: changed.payoutDescriptor };
  }
  if (Object.keys(settings).length) body.settings = settings;
  return { ok: true, body };
}
