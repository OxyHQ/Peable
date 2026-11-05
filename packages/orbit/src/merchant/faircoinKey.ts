import type { Merchant } from '@peable.to/shared-types';
import type { OrbitEnvironment, RegisterFaircoinKeyBody } from '../api/dashboard';
import { isOrbitApiError } from '../api/transport';

/**
 * The merchant's FairCoin receiving key (ADR 0021 D5): a live merchant
 * without one cannot take payments, so Orbit treats registering it as a
 * REQUIRED setup step. Presentation only — the gateway is the authority on
 * every rule below, and says so with its own refusals.
 */

export type FaircoinKeyStatus =
  /** Registered; immutable from now on. */
  | 'registered'
  /** Live and missing: the merchant cannot take payments until it registers one. */
  | 'required_live'
  /** Test and missing: orders are created, FairCoin is shown unavailable. */
  | 'required_test';

export function faircoinKeyStatus(
  merchant: Pick<Merchant, 'xpub' | 'environment'>,
): FaircoinKeyStatus {
  if (merchant.xpub !== null) return 'registered';
  return merchant.environment === 'production' ? 'required_live' : 'required_test';
}

export type FaircoinNetwork = RegisterFaircoinKeyBody['network'];

/**
 * The networks this mode may register. A non-production merchant registers
 * testnet only — the gateway's test/live firewall; live offers both.
 */
export function networksFor(environment: OrbitEnvironment): readonly FaircoinNetwork[] {
  return environment === 'production' ? ['mainnet', 'testnet'] : ['testnet'];
}

/** What the key form holds: the text a person typed. */
export interface FaircoinKeyForm {
  network: FaircoinNetwork;
  xpub: string;
}

export function emptyFaircoinKeyForm(environment: OrbitEnvironment): FaircoinKeyForm {
  return { network: environment === 'production' ? 'mainnet' : 'testnet', xpub: '' };
}

export type FaircoinKeyFormError = 'xpub_missing' | 'private_key' | 'network';

/**
 * An extended PRIVATE key's prefixes (BIP32 `xprv`/`tprv` and the SLIP-132
 * variants). Refused here only to spare a person sending one; the gateway's
 * `assertWatchOnly` is what actually refuses it, and never stores it.
 */
const PRIVATE_KEY_PREFIX = /^[xtuvyzXTUVYZ]prv/;

export function buildFaircoinKeyBody(
  form: FaircoinKeyForm,
  environment: OrbitEnvironment,
): { ok: true; body: RegisterFaircoinKeyBody } | { ok: false; error: FaircoinKeyFormError } {
  const xpub = form.xpub.trim();
  if (!xpub) return { ok: false, error: 'xpub_missing' };
  if (PRIVATE_KEY_PREFIX.test(xpub)) return { ok: false, error: 'private_key' };
  if (!networksFor(environment).includes(form.network)) return { ok: false, error: 'network' };
  return { ok: true, body: { network: form.network, xpub } };
}

/** The catalog key of a form error. */
export function faircoinKeyFormErrorKey(error: FaircoinKeyFormError): string {
  return `settings.faircoinKey.error.${error}`;
}

/**
 * The gateway's refusal of a registration, in words: the catalog key, or
 * `null` for anything that is not one of the registration's own refusals
 * (shown with the gateway's message and request id instead).
 */
export function faircoinKeyRefusalKey(error: unknown): string | null {
  if (!isOrbitApiError(error)) return null;
  switch (error.code) {
    case 'already_registered':
      return 'settings.faircoinKey.refusal.already_registered';
    case 'key_in_use':
      return 'settings.faircoinKey.refusal.key_in_use';
    case 'watch_only_violation':
      return 'settings.faircoinKey.refusal.watch_only_violation';
    case 'parameter_invalid':
      return error.param === 'network' ? 'settings.faircoinKey.refusal.network' : null;
    default:
      return null;
  }
}
