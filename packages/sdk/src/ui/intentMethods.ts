import {
  PAYMENT_METHOD_CURRENCIES,
  type PaymentMethodConfigurationType,
} from '@peable.to/contracts/vocabulary/paymentMethodConfigurations';
import type { CurrencyCode, PaymentIntent } from '@peable.to/shared-types';
import type { CheckoutPaymentMethod } from '@oxy.so/bloom/checkout-sheet';

/**
 * The card-rail methods a payer can be shown, in the order they are listed.
 * Wallets first (one tap), then card, then the local bank methods.
 */
export const INTENT_METHOD_ORDER = [
  'apple_pay',
  'google_pay',
  'card',
  'sepa_debit',
  'ideal',
  'bancontact',
  'eps',
] as const satisfies readonly PaymentMethodConfigurationType[];
export type IntentMethodType = (typeof INTENT_METHOD_ORDER)[number];

/**
 * Why a method is listed and cannot be chosen. Each is a fact about THIS
 * payment or THIS device, never a fixture:
 *
 *  - `currency` — the method does not take a payment in this currency;
 *  - `notOffered` — the merchant's configuration does not offer it here;
 *  - `requiresCard` — a wallet rides on card payments, and this one takes none;
 *  - `checking` — the provider has not yet said whether this device can run it;
 *  - `device` — the provider probed and this device or browser cannot run it;
 *  - `host` — the method needs a step (a bank redirect) this host does not run;
 *    it remains payable in the browser checkout.
 */
export type IntentMethodUnavailableReason =
  | 'currency'
  | 'notOffered'
  | 'requiresCard'
  | 'checking'
  | 'device'
  | 'host';

export interface IntentMethodAvailability {
  readonly type: IntentMethodType;
  readonly kind: NonNullable<CheckoutPaymentMethod['kind']>;
  readonly available: boolean;
  readonly reason: IntentMethodUnavailableReason | null;
}

/** What the HOST can run — reported by the host and the provider, never assumed from the platform name. */
export interface IntentMethodCapabilities {
  /**
   * The wallets the provider's own probe says this device runs; `undefined`
   * while it has not answered. A wallet is never assumed from `Platform.OS`:
   * Apple Pay on an iPhone without a card in Wallet is still not available.
   */
  readonly wallets?: readonly ('apple_pay' | 'google_pay')[];
  /**
   * Whether the host can complete a redirect-based bank method (iDEAL,
   * Bancontact, EPS) and a mandate-based one (SEPA Debit). The Bloom sheet's
   * split card fields cannot; a browser checkout can.
   */
  readonly localMethods?: boolean;
}

const KIND: Readonly<Record<IntentMethodType, NonNullable<CheckoutPaymentMethod['kind']>>> = {
  apple_pay: 'wallet',
  google_pay: 'wallet',
  card: 'card',
  sepa_debit: 'account',
  ideal: 'account',
  bancontact: 'account',
  eps: 'account',
};

function isWallet(type: IntentMethodType): type is 'apple_pay' | 'google_pay' {
  return type === 'apple_pay' || type === 'google_pay';
}

function takesCurrency(type: IntentMethodType, currency: CurrencyCode): boolean {
  return (PAYMENT_METHOD_CURRENCIES[type] as readonly string[]).includes(currency);
}

/**
 * Every card-rail method, and whether THIS payment on THIS host can use it.
 *
 * The intent's `payment_method_types` is the gateway's answer to what the
 * merchant offers on this payment (configuration × currency); a wallet is a
 * card payment, so it is offered exactly when `card` is. Nothing here turns a
 * method on that the intent lacks, and nothing is hidden: an unavailable
 * method is listed with its reason (`payment-provider-boundary.md`, truthful
 * UI). A FairCoin intent has no card-rail methods and answers `[]`.
 */
export function intentMethodAvailability(
  intent: Pick<PaymentIntent, 'rail' | 'currency' | 'payment_method_types'>,
  capabilities: IntentMethodCapabilities = {},
): IntentMethodAvailability[] {
  if (intent.rail !== 'card') return [];
  const offered = new Set<string>(intent.payment_method_types);
  return INTENT_METHOD_ORDER.map((type) => {
    const reason = ((): IntentMethodUnavailableReason | null => {
      if (!takesCurrency(type, intent.currency)) return 'currency';
      if (isWallet(type)) {
        if (!offered.has('card')) return 'requiresCard';
        if (capabilities.wallets === undefined) return 'checking';
        return capabilities.wallets.includes(type) ? null : 'device';
      }
      if (!offered.has(type)) return 'notOffered';
      if (type !== 'card' && capabilities.localMethods !== true) return 'host';
      return null;
    })();
    return { type, kind: KIND[type], available: reason === null, reason };
  });
}

/** Reasons that say nothing a payer can act on: the method is simply not part of this payment. */
const HIDDEN_REASONS: ReadonlySet<IntentMethodUnavailableReason | null> = new Set([
  'currency',
  'notOffered',
  'requiresCard',
]);

/**
 * The same answer as Bloom checkout-sheet methods: `disabled` with the reason
 * as `detail`, so the sheet lists the method and never lets it be selected.
 * Methods that are not part of this payment (its currency, the merchant's
 * choice, a wallet on a payment that takes no card) are left out — a payer has
 * nothing to learn from "not offered" — while the ones this payment offers and
 * the device or host cannot run stay visible, with why.
 */
export function intentCheckoutMethods(
  intent: Pick<PaymentIntent, 'rail' | 'currency' | 'payment_method_types'>,
  capabilities: IntentMethodCapabilities,
  label: (key: string) => string,
): CheckoutPaymentMethod[] {
  return intentMethodAvailability(intent, capabilities)
    .filter((method) => !HIDDEN_REASONS.has(method.reason))
    .map((method) => ({
      id: method.type,
      label: label(`method.${method.type}`),
      kind: method.kind,
      ...(method.available
        ? {}
        : { disabled: true, detail: label(`method.unavailable.${method.reason}`) }),
    }));
}
