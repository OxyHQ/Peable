import type {
  PaymentMethodConfiguration,
  PaymentMethodConfigurationEntry,
  PaymentMethodConfigurationType,
  PaymentMethodDomainWalletStatus,
  PaymentMethodUnavailableReason,
} from '@peable.to/shared-types';
import { ORBIT_CURRENCY_DECIMALS } from '../format/money';
import { labelFor, t } from '../i18n';

/**
 * Every method a configuration lists, in the order Orbit shows them. Restated
 * from `PAYMENT_METHOD_CONFIGURATION_TYPES` (see `format/money.ts` for why) and
 * pinned to it by `configuration.test.ts`.
 */
export const ORBIT_PAYMENT_METHOD_TYPES: readonly PaymentMethodConfigurationType[] = [
  'faircoin',
  'card',
  'apple_pay',
  'google_pay',
  'sepa_debit',
  'ideal',
  'bancontact',
  'eps',
  'bizum',
];

export function paymentMethodLabel(type: PaymentMethodConfigurationType): string {
  return labelFor('methods.type', type);
}

/** Why a method cannot be offered, in plain words. */
export function unavailableReasonText(reason: PaymentMethodUnavailableReason): string {
  return labelFor('methods.reason', reason);
}

/** Every fiat currency the card rail takes — a method on all of them says so. */
const ALL_FIAT = Object.keys(ORBIT_CURRENCY_DECIMALS).filter((code) => code !== 'FAIR');

/** "All currencies", "EUR only", or "EUR, GBP". */
export function currenciesText(currencies: readonly string[]): string {
  if (ALL_FIAT.every((code) => currencies.includes(code))) return t('methods.currencies.all');
  if (currencies.length === 1)
    return t('methods.currencies.only', { currency: currencies[0] ?? '' });
  return currencies.join(', ');
}

/**
 * What the merchant chose, in one word: their own `on`/`off`, or Orbit's
 * default (`none`) followed by the value it currently resolves to.
 */
export function preferenceText(entry: PaymentMethodConfigurationEntry): string {
  if (entry.locked) return t('methods.preference.locked');
  const { preference, value } = entry.display_preference;
  if (preference === 'none') {
    return t('methods.preference.default', {
      value: labelFor('methods.preference.value', value),
    });
  }
  return t(preference === 'on' ? 'methods.preference.on' : 'methods.preference.off');
}

/**
 * Whether the toggle can be changed at all. A locked method (FairCoin, always
 * offered — ADR 0021) cannot be turned off, and a method the provider does not
 * offer cannot be turned on, so both switches are disabled — shown, never
 * hidden. A wallet waiting on cards can still be set: its preference takes
 * effect when cards are on.
 */
export function canToggle(entry: PaymentMethodConfigurationEntry): boolean {
  return !entry.locked && entry.unavailable_reason !== 'provider_unsupported';
}

/**
 * The notes under a method, in words: why a locked method cannot be changed,
 * and what the owner can do about an unavailable FairCoin (set up the owning
 * account's Peable wallet, ADR 0021 D5).
 */
export function methodNotes(entry: PaymentMethodConfigurationEntry): string[] {
  const notes: string[] = [];
  if (entry.locked) notes.push(t('methods.locked'));
  if (entry.unavailable_reason === 'faircoin_wallet_missing') {
    notes.push(t('methods.faircoinWalletMissing'));
  }
  if (entry.unavailable_reason === 'faircoin_network_closed') {
    notes.push(t('methods.faircoinNetworkClosed'));
  }
  return notes;
}

/** The update body that turns one method on or off, and nothing else. */
export function preferenceUpdate(
  type: PaymentMethodConfigurationType,
  on: boolean,
): {
  [K in PaymentMethodConfigurationType]?: { display_preference: { preference: 'on' | 'off' } };
} {
  return { [type]: { display_preference: { preference: on ? 'on' : 'off' } } };
}

/** The configuration a screen starts on: the default, else the first. */
export function defaultConfiguration(
  configurations: readonly PaymentMethodConfiguration[],
): PaymentMethodConfiguration | undefined {
  return configurations.find((configuration) => configuration.is_default) ?? configurations[0];
}

/** A wallet's standing on a domain, in words. */
export function walletStatusText(status: PaymentMethodDomainWalletStatus): string {
  if (status.status === 'active') return t('domains.wallet.active');
  return status.status_details?.error_message
    ? t('domains.wallet.inactiveDetail', { message: status.status_details.error_message })
    : t('domains.wallet.inactive');
}

/**
 * Normalise what a merchant typed into a hostname, or explain the refusal.
 * The gateway validates again; this only catches the common slips (a scheme,
 * a path, upper case) before a round trip.
 */
export function parseDomainInput(
  input: string,
): { ok: true; domain: string } | { ok: false; message: string } {
  const value = input.trim().toLowerCase();
  if (!value) return { ok: false, message: t('domains.invalid.empty') };
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(value)) {
    return { ok: false, message: t('domains.invalid.scheme') };
  }
  if (/[/:?#\s@]/.test(value)) {
    return { ok: false, message: t('domains.invalid.path') };
  }
  const labels = value.split('.');
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (value.length > 253 || labels.length < 2 || !labels.every((part) => label.test(part))) {
    return { ok: false, message: t('domains.invalid.name') };
  }
  return { ok: true, domain: value };
}
