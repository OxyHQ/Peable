import type { Merchant } from '@peable.to/shared-types';
import type { RegisterMerchantBody, UpdateMerchantBody } from '../api/dashboard';

/** What the Settings form holds: every field as the text a person typed. */
export interface MerchantForm {
  displayName: string;
  description: string;
  webhookUrl: string;
  /** Blank means "keep the stored secret" — the gateway never returns it. */
  webhookSecret: string;
  requiredConfirmations: string;
  /** Registration only: `none` registers a card-only merchant. */
  network: 'none' | 'mainnet' | 'testnet';
  xpub: string;
}

export const EMPTY_MERCHANT_FORM: MerchantForm = {
  displayName: '',
  description: '',
  webhookUrl: '',
  webhookSecret: '',
  requiredConfirmations: '',
  network: 'none',
  xpub: '',
};

export function formFromMerchant(merchant: Merchant): MerchantForm {
  return {
    displayName: merchant.display_name ?? '',
    description: merchant.description ?? '',
    webhookUrl: merchant.webhook_url ?? '',
    webhookSecret: '',
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
  const webhookUrl = text(form.webhookUrl);
  const webhookSecret = text(form.webhookSecret);
  if (displayName) body.display_name = displayName;
  if (description) body.description = description;
  if (webhookUrl) body.webhook_url = webhookUrl;
  if (webhookSecret) body.webhook_secret = webhookSecret;
  if (confirmations !== null) body.required_confirmations = confirmations;
  if (form.network !== 'none' && form.xpub.trim()) {
    body.network = form.network;
    body.xpub = form.xpub.trim();
  }
  return { ok: true, body };
}

/**
 * A PATCH carrying only what changed. A cleared optional field is sent as
 * `null` (the gateway's "unset"); a blank secret is left out, because blank
 * means "keep", and a secret cannot be compared with one it never reveals.
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
  const webhookUrl = nullable(form.webhookUrl);
  if (webhookUrl !== (merchant.webhook_url ?? null)) body.webhook_url = webhookUrl;
  const secret = form.webhookSecret.trim();
  if (secret) body.webhook_secret = secret;
  if (confirmations !== null && confirmations !== merchant.required_confirmations) {
    body.required_confirmations = confirmations;
  }
  return { ok: true, body };
}
