// The card rail's payer surface in a browser: the provider's Express Checkout
// element (wallets) above its Payment Element (card and the local methods the
// intent offers), on ONE `elements({ clientSecret })` instance, confirmed
// through ONE path.
//
// Plain DOM and no framework, so the hosted checkout (React) and
// `PeableCheckout.mount` (any page) share it — one answer to "how does a card
// payment get confirmed in a browser", not two.
//
// ## What this never does
//
// It never sees a card number, an IBAN or a bank login: every field is the
// provider's own iframe, served from its origin (PCI SAQ-A). And it never
// decides that a payment succeeded. `confirmPayment` resolving means the
// provider ACCEPTED a confirmation; 3-D Secure may still be pending, a bank
// redirect may still be out, and a SEPA Debit stays `processing` for days. The
// authoritative status is the gateway's, over the socket, from a verified
// provider event.
import type { PaymentIntent } from '@peable.to/shared-types';
import type { ProviderElements, ProviderFieldEvent, ProviderSdk } from './providerJs';

/** The wallets the Express Checkout element is allowed to offer. */
export type ExpressWallet = 'apple_pay' | 'google_pay';

/**
 * The Express Checkout element's options: Apple Pay and Google Pay, and
 * nothing else. The provider's own consumer wallet and the third-party buttons
 * it can add are turned off explicitly — Orbit's checkout carries Peable's
 * offer, not a processor's brand (`docs/integrations/payment-provider-boundary.md`).
 */
export const EXPRESS_CHECKOUT_OPTIONS: Readonly<Record<string, unknown>> = Object.freeze({
  paymentMethods: {
    applePay: 'auto',
    googlePay: 'auto',
    link: 'never',
    paypal: 'never',
    amazonPay: 'never',
    klarna: 'never',
  },
});

/**
 * Which wallets the Express Checkout element said it can run, from its `ready`
 * event. Empty when it can run none (`availablePaymentMethods` is `undefined`
 * on a device with no wallet) — the signal to hide the slot rather than leave
 * an empty box a payer would read as broken.
 */
export function availableWallets(event: ProviderFieldEvent | undefined): ExpressWallet[] {
  const methods = event?.availablePaymentMethods;
  if (!methods) return [];
  const wallets: ExpressWallet[] = [];
  if (methods.applePay === true) wallets.push('apple_pay');
  if (methods.googlePay === true) wallets.push('google_pay');
  return wallets;
}

/** The query parameters the provider appends when a redirect-based method returns. */
const REDIRECT_PARAMS = [
  'payment_intent',
  'payment_intent_client_secret',
  'redirect_status',
] as const;

/**
 * What a return from a redirect-based method (a bank's page for iDEAL,
 * Bancontact or EPS; a 3-D Secure challenge) says — and it says little.
 *
 *  - `returned`: the payer came back from the bank. NOT a payment: the page
 *    shows "confirming" until the gateway's status arrives.
 *  - `failed`: the bank or the payer abandoned it; the form is offered again.
 *
 * `null` when this page load is not such a return.
 */
export function readRedirectReturn(search: string): { outcome: 'returned' | 'failed' } | null {
  const params = new URLSearchParams(search);
  const status = params.get('redirect_status');
  if (status === null || !params.has('payment_intent_client_secret')) return null;
  return {
    outcome: status === 'failed' || status === 'requires_payment_method' ? 'failed' : 'returned',
  };
}

/**
 * The same URL without the redirect parameters. The provider's client secret
 * is one of them, and it should not stay in the address bar, the history or a
 * link a payer copies.
 */
export function withoutRedirectParams(href: string): string {
  const url = new URL(href);
  for (const name of REDIRECT_PARAMS) url.searchParams.delete(name);
  return url.toString();
}

/** Methods whose result arrives days after the payer confirms. */
const DELAYED_METHODS = new Set(['sepa_debit']);

/**
 * What a `processing` card-rail payment should tell its payer, when the wait
 * may be days rather than seconds. `null` for an ordinary processing payment.
 *
 * Definite when every offered method is a delayed one; hedged when the payer
 * could also have paid by card, because the intent does not say which they
 * used and a card payment told "a few business days" is told something false.
 */
export function delayedProcessingNotice(
  intent: Pick<PaymentIntent, 'rail' | 'status' | 'payment_method_types'>,
): string | null {
  if (intent.rail !== 'card' || intent.status !== 'processing') return null;
  const delayed = intent.payment_method_types.filter((type) => DELAYED_METHODS.has(type));
  if (delayed.length === 0) return null;
  return delayed.length === intent.payment_method_types.length
    ? 'Bank debit submitted — this can take a few business days.'
    : 'If you paid by bank debit, it can take a few business days to complete.';
}

/** What a confirmation attempt came to, as far as this page can know. */
export type CardConfirmOutcome =
  /** The provider accepted the confirmation. Not a payment — wait for the gateway. */
  | { readonly kind: 'accepted' }
  /** Declined, incomplete or abandoned: recoverable, the fields stay. */
  | { readonly kind: 'declined'; readonly message: string };

export interface CardElementsOptions {
  readonly sdk: ProviderSdk;
  /** The PROVIDER's client secret, from `POST …/client_action` — never stored. */
  readonly clientSecret: string;
  /** Where the Payment Element (card and local methods) mounts. */
  readonly paymentTarget: HTMLElement;
  /** Where the Express Checkout element (wallets) mounts; omitted for no wallets. */
  readonly walletTarget?: HTMLElement | null;
  /**
   * Where a redirect-based method returns the payer: the page itself, never the
   * merchant's success URL — a return proves only that the payer came back.
   */
  readonly returnUrl: string;
  /** The wallets the device can run, once the provider has probed; `[]` means hide the slot. */
  readonly onWalletsChange?: (wallets: readonly ExpressWallet[]) => void;
  /** A wallet confirmation's outcome (it is started from the wallet sheet, not from `confirm`). */
  readonly onWalletOutcome?: (outcome: CardConfirmOutcome) => void;
  /** Extra Payment Element options (appearance, layout). */
  readonly paymentOptions?: Readonly<Record<string, unknown>>;
}

export interface CardElementsHandle {
  readonly elements: ProviderElements;
  /** Confirm with the Payment Element's current method. */
  confirm(): Promise<CardConfirmOutcome>;
  /** Destroy the provider's frames. The host removes its own nodes. */
  destroy(): void;
}

const DECLINED_FALLBACK = 'This payment could not be completed.';

/**
 * Mount the wallets and the payment fields for one card payment.
 *
 * The Payment Element renders the methods the INTENT offers — chosen at the
 * gateway from the merchant's configuration and the currency — so no method
 * list is decided here. When a wallet slot is mounted, the Payment Element
 * stops offering the same wallets, so a payer never sees Apple Pay twice.
 */
export function mountCardElements(options: CardElementsOptions): CardElementsHandle {
  const { sdk, returnUrl } = options;
  const elements = sdk.elements({ clientSecret: options.clientSecret });
  const confirmParams = { return_url: returnUrl };

  async function confirmWith(): Promise<CardConfirmOutcome> {
    const result = await sdk.confirmPayment({ elements, redirect: 'if_required', confirmParams });
    return result.error
      ? { kind: 'declined', message: result.error.message ?? DECLINED_FALLBACK }
      : { kind: 'accepted' };
  }

  const walletTarget = options.walletTarget ?? null;
  if (walletTarget !== null) {
    const express = elements.create('expressCheckout', { ...EXPRESS_CHECKOUT_OPTIONS });
    express.on?.('ready', (event) => {
      options.onWalletsChange?.(availableWallets(event));
    });
    express.on?.('loaderror', () => {
      options.onWalletsChange?.([]);
    });
    express.on?.('confirm', (event) => {
      void confirmWith()
        .then((outcome) => {
          if (outcome.kind === 'declined') event?.paymentFailed?.({ reason: 'fail' });
          options.onWalletOutcome?.(outcome);
        })
        .catch((cause: unknown) => {
          event?.paymentFailed?.({ reason: 'fail' });
          options.onWalletOutcome?.({
            kind: 'declined',
            message: cause instanceof Error ? cause.message : DECLINED_FALLBACK,
          });
        });
    });
    express.mount(walletTarget);
  }

  const payment = elements.create('payment', {
    ...options.paymentOptions,
    ...(walletTarget !== null ? { wallets: { applePay: 'never', googlePay: 'never' } } : {}),
  });
  payment.mount(options.paymentTarget);

  return {
    elements,
    confirm: confirmWith,
    destroy() {
      // React (or the host) removes OUR nodes; the iframes are the provider's,
      // and one left attached to a detached parent is a live frame per navigation.
      elements.getElement('expressCheckout')?.destroy();
      elements.getElement('payment')?.destroy();
    },
  };
}
