import type { Merchant } from '@peable.to/shared-types';
import type { OrbitEnvironment, RegisterMerchantBody, UpdateMerchantBody } from '../api/dashboard';

/** What the Settings form holds: every field as the text a person typed. */
export interface MerchantForm {
  displayName: string;
  description: string;
  requiredConfirmations: string;
  /**
   * Registration only. The FairCoin receiving key is REQUIRED to take payments
   * (ADR 0021 D5); `none` registers without it, to be registered once later.
   */
  network: 'none' | 'mainnet' | 'testnet';
  xpub: string;
}

export const EMPTY_MERCHANT_FORM: MerchantForm = {
  displayName: '',
  description: '',
  requiredConfirmations: '',
  network: 'none',
  xpub: '',
};

/**
 * A registration form that starts on the FairCoin key: the network this mode
 * may register (testnet in test mode, mainnet in live), so the key field is
 * shown from the start rather than hidden behind "card only".
 */
export function emptyMerchantForm(environment: OrbitEnvironment): MerchantForm {
  return {
    ...EMPTY_MERCHANT_FORM,
    network: environment === 'production' ? 'mainnet' : 'testnet',
  };
}

export function formFromMerchant(merchant: Merchant): MerchantForm {
  return {
    displayName: merchant.display_name ?? '',
    description: merchant.description ?? '',
    requiredConfirmations: String(merchant.required_confirmations),
    network: merchant.network ?? 'none',
    xpub: merchant.xpub ?? '',
  };
}

export type FormResult<T> = { ok: true; body: T } | { ok: false; error: 'confirmations' };

/** A whole number of 1 or more, or `null` for an empty field; `undefined` when invalid. */
function parseConfirmations(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^[1-9][0-9]*$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * The registration body: only what was filled in, so the gateway's defaults
 * apply to the rest. The FairCoin half is sent whole or not at all, as the
 * gateway requires.
 */
export function buildRegisterBody(form: MerchantForm): FormResult<RegisterMerchantBody> {
  const confirmations = parseConfirmations(form.requiredConfirmations);
  if (confirmations === undefined) return { ok: false, error: 'confirmations' };
  const body: RegisterMerchantBody = {};
  const text = (value: string) => value.trim() || undefined;
  const displayName = text(form.displayName);
  const description = text(form.description);
  if (displayName) body.display_name = displayName;
  if (description) body.description = description;
  if (confirmations !== null) body.required_confirmations = confirmations;
  if (form.network !== 'none' && form.xpub.trim()) {
    body.network = form.network;
    body.xpub = form.xpub.trim();
  }
  return { ok: true, body };
}

/**
 * A PATCH carrying only what changed. A cleared optional field is sent as
 * `null` (the gateway's "unset").
 */
export function buildMerchantPatch(
  merchant: Merchant,
  form: MerchantForm,
): FormResult<UpdateMerchantBody> {
  const confirmations = parseConfirmations(form.requiredConfirmations);
  if (confirmations === undefined) return { ok: false, error: 'confirmations' };
  const body: UpdateMerchantBody = {};
  const nullable = (value: string) => value.trim() || null;

  const displayName = nullable(form.displayName);
  if (displayName !== (merchant.display_name ?? null)) body.display_name = displayName;
  const description = nullable(form.description);
  if (description !== (merchant.description ?? null)) body.description = description;
  if (confirmations !== null && confirmations !== merchant.required_confirmations) {
    body.required_confirmations = confirmations;
  }
  return { ok: true, body };
}
