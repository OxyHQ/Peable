// `PeableElements` — Peable's Elements: the card provider's own secure fields
// (Payment Element, Express Checkout for wallets, Address Element), mounted
// inside Peable chrome and styled by one `appearance`, with `confirmPayment` /
// `confirmSetup` helpers that resolve on the GATEWAY's word.
//
// ## Card data never touches Peable
//
// Every field a card number, expiry or security code is typed into is a
// provider frame from the provider's origin (`providerJs.ts`). Peable's chrome
// is a container, a label and an error line around it.
//
// ## Success is the gateway's, not the browser's
//
// The provider resolving a confirmation means it ACCEPTED the attempt — 3-D
// Secure may still be pending and the processor still deciding. The helpers
// therefore wait for the payment (or setup) as the gateway holds it, driven by
// the provider's verified webhook: realtime first, a REST poll beside it, and
// a timeout that answers `pending` rather than guessing.
import type { CurrencyCode, PaymentIntent, SetupIntent } from '@peable.to/shared-types';
import { type Appearance, toCssVariables, toProviderAppearance } from './appearance';
import { EXPRESS_CHECKOUT_OPTIONS } from './cardElements';
import { createPeableCheckout, type PeableCheckoutClient } from './payerClient';
import {
  loadProviderSdk,
  type ProviderElement,
  type ProviderElements,
  type ProviderFactory,
  type ProviderSdk,
} from './providerJs';

export type PeableElementType = 'payment' | 'expressCheckout' | 'address';

export interface CreatePeableElementsOptions {
  /**
   * The provider's PUBLIC key for the payment's mode — on a hosted session it
   * is `CheckoutSessionPublic.publishable_key`. Not needed when
   * `paymentIntent` / `setupIntent` is given: the gateway answers it with the
   * credential.
   */
  publishableKey?: string;
  /** The PROVIDER's client secret, when you already hold it. */
  clientSecret?: string;
  /** Mount for an existing Peable payment (`pi_…` + its `client_secret`). */
  paymentIntent?: { id: string; client_secret: string };
  /** Mount for an existing Peable SetupIntent. */
  setupIntent?: { id: string; client_secret: string };
  /**
   * Deferred flow — the fields mount BEFORE the payment exists (a Checkout
   * Session creates it when the payer confirms). Default `payment`.
   */
  mode?: 'payment' | 'setup';
  /** Deferred `payment` mode: the amount in base units (a string, as on the wire). */
  amount?: string;
  currency?: CurrencyCode;
  appearance?: Appearance;
  locale?: string;
  /** Gateway base URL. Default `https://api.peable.to`. */
  gatewayUrl?: string;
}

export interface PeableElementOptions {
  /** A visible label above the fields; none by default. */
  label?: string;
  /** Passed to the provider's element as is (layout, wallets, …). */
  provider?: Record<string, unknown>;
}

export type PeableElementEvent = 'ready' | 'change' | 'focus' | 'blur' | 'loaderror';

export interface PeableElement {
  readonly type: PeableElementType;
  /** Mount into `target`; resolves once the provider's fields are in place. */
  mount(target: string | Element): Promise<void>;
  unmount(): void;
  destroy(): void;
  on(event: PeableElementEvent, callback: (event?: unknown) => void): void;
}

export type PeableConfirmError = {
  type:
    | 'validation_error'
    | 'card_error'
    | 'provider_error'
    | 'payment_failed'
    | 'canceled'
    | 'unavailable';
  message: string;
};

export type PeablePaymentResult =
  | {
      /** What the GATEWAY says the payment is. */
      status: 'succeeded' | 'processing' | 'requires_capture';
      paymentIntent: PaymentIntent;
    }
  | {
      /** The gateway has not decided within `timeoutMs`; keep watching the payment. */
      status: 'pending';
      paymentIntent: PaymentIntent;
    }
  | { error: PeableConfirmError; paymentIntent?: PaymentIntent };

export type PeableSetupResult =
  | { status: 'succeeded' | 'processing'; setupIntent: SetupIntent }
  | { status: 'pending'; setupIntent: SetupIntent }
  | { error: PeableConfirmError; setupIntent?: SetupIntent };

export interface ConfirmOptions {
  /** Where the provider sends the payer back after a redirect (3-D Secure). Default: this page. */
  return_url?: string;
  /** How long to wait for the gateway. Default 60 s. */
  timeoutMs?: number;
}

export interface PeableElements {
  create(type: PeableElementType, options?: PeableElementOptions): PeableElement;
  /** Re-style every element, or (deferred mode) change the amount shown to wallets. */
  update(options: { appearance?: Appearance; amount?: string }): Promise<void>;
  confirmPayment(
    params: { paymentIntent: { id: string; client_secret: string } } & ConfirmOptions,
  ): Promise<PeablePaymentResult>;
  confirmSetup(
    params: { setupIntent: { id: string; client_secret: string } } & ConfirmOptions,
  ): Promise<PeableSetupResult>;
}

/** What `createPeableElements` reaches for, injectable for tests. */
export interface ElementsDependencies {
  loadProvider(): Promise<ProviderFactory>;
  payer: PeableCheckoutClient;
  createContainer(): HTMLElement;
  resolveTarget(target: string | Element): Element | null;
  locationHref(): string;
  /** Poll interval of the gateway wait. Default 2 s. */
  pollMs?: number;
}

// ---- Pure decisions (unit-tested) ------------------------------------------

/** The provider's amount for a base-unit string — minor units as a number. */
export function providerAmount(amount: string, currency: CurrencyCode): number {
  if (!/^(0|[1-9][0-9]*)$/.test(amount)) throw new TypeError('amount must be a base-unit string');
  if (currency === 'FAIR') throw new TypeError('FairCoin is not paid through card fields');
  const value = Number(amount);
  if (!Number.isSafeInteger(value)) {
    throw new TypeError('amount is out of range for the card provider');
  }
  return value;
}

export type GatewayDecision<T> =
  | { kind: 'pending' }
  | { kind: 'resolved'; status: 'succeeded' | 'processing' | 'requires_capture'; object: T }
  | { kind: 'failed'; error: PeableConfirmError; object: T };

/**
 * What the gateway's payment says about the attempt just made. `baseline` is
 * the payment as read BEFORE confirming, so a decline recorded by an earlier
 * attempt is not mistaken for this one's answer.
 */
export function decidePayment(
  intent: PaymentIntent,
  baseline: PaymentIntent | null,
): GatewayDecision<PaymentIntent> {
  switch (intent.status) {
    case 'succeeded':
    case 'processing':
    case 'requires_capture':
      return { kind: 'resolved', status: intent.status, object: intent };
    case 'canceled':
      return {
        kind: 'failed',
        error: { type: 'canceled', message: 'This payment was canceled.' },
        object: intent,
      };
    case 'requires_payment_method': {
      const error = intent.last_payment_error;
      if (!error) return { kind: 'pending' };
      const stale =
        baseline !== null &&
        baseline.updated_at === intent.updated_at &&
        JSON.stringify(baseline.last_payment_error) === JSON.stringify(error);
      if (stale) return { kind: 'pending' };
      return {
        kind: 'failed',
        error: { type: 'payment_failed', message: error.message ?? 'The payment failed.' },
        object: intent,
      };
    }
    default:
      return { kind: 'pending' };
  }
}

export function decideSetup(
  setup: SetupIntent,
  baseline: SetupIntent | null,
): GatewayDecision<SetupIntent> {
  switch (setup.status) {
    case 'succeeded':
    case 'processing':
      return { kind: 'resolved', status: setup.status, object: setup };
    case 'canceled':
      return {
        kind: 'failed',
        error: { type: 'canceled', message: 'This setup was canceled.' },
        object: setup,
      };
    case 'requires_payment_method': {
      const error = setup.last_setup_error;
      if (!error) return { kind: 'pending' };
      if (baseline && JSON.stringify(baseline.last_setup_error) === JSON.stringify(error)) {
        return { kind: 'pending' };
      }
      return {
        kind: 'failed',
        error: { type: 'payment_failed', message: error.message ?? 'The card could not be saved.' },
        object: setup,
      };
    }
    default:
      return { kind: 'pending' };
  }
}

/**
 * Watch `read` (and `subscribe`, when given) until `decide` answers or
 * `timeoutMs` passes. Resolves with the decision and the last object seen.
 */
export async function awaitGateway<T>(params: {
  read: () => Promise<T>;
  subscribe?: (onUpdate: (object: T) => void) => Promise<{ unsubscribe(): void }>;
  decide: (object: T) => GatewayDecision<T>;
  timeoutMs: number;
  pollMs: number;
}): Promise<{ decision: GatewayDecision<T>; last: T | null }> {
  let last: T | null = null;
  let settle: (value: { decision: GatewayDecision<T>; last: T | null }) => void = () => {};
  const done = new Promise<{ decision: GatewayDecision<T>; last: T | null }>((resolve) => {
    settle = resolve;
  });
  let finished = false;
  const observe = (object: T): void => {
    if (finished) return;
    last = object;
    const decision = params.decide(object);
    if (decision.kind !== 'pending') {
      finished = true;
      settle({ decision, last });
    }
  };
  const poll = async (): Promise<void> => {
    try {
      observe(await params.read());
    } catch {
      // A failed read is not an answer; the next tick (or the socket) is.
    }
  };

  const live: { subscription: { unsubscribe(): void } | null } = { subscription: null };
  params
    .subscribe?.(observe)
    .then((sub) => {
      if (finished) sub.unsubscribe();
      else live.subscription = sub;
    })
    .catch(() => {
      // Realtime unavailable: the poll below carries the wait.
    });
  const timer = setInterval(() => void poll(), params.pollMs);
  const timeout = setTimeout(() => {
    if (finished) return;
    finished = true;
    settle({ decision: { kind: 'pending' }, last });
  }, params.timeoutMs);
  void poll();

  const result = await done;
  clearInterval(timer);
  clearTimeout(timeout);
  live.subscription?.unsubscribe();
  return result;
}

// ---- The elements ------------------------------------------------------------

function defaultDependencies(gatewayUrl: string | undefined): ElementsDependencies {
  return {
    loadProvider: loadProviderSdk,
    payer: createPeableCheckout({ gatewayUrl }),
    createContainer: () => document.createElement('div'),
    resolveTarget: (target) =>
      typeof target === 'string' ? document.querySelector(target) : target,
    locationHref: () => window.location.href,
  };
}

interface ProviderContext {
  sdk: ProviderSdk;
  elements: ProviderElements;
  /** Whether the elements were created before the payment (`submit()` + `clientSecret` at confirm). */
  deferred: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 2_000;

function message(error: { message?: string } | undefined, fallback: string): string {
  return error?.message ?? fallback;
}

/** Create Peable's Elements over the card provider's secure fields. */
export function createPeableElements(options: CreatePeableElementsOptions = {}): PeableElements {
  return createPeableElementsWith(defaultDependencies(options.gatewayUrl), options);
}

/** {@link createPeableElements} with explicit dependencies. */
export function createPeableElementsWith(
  deps: ElementsDependencies,
  options: CreatePeableElementsOptions,
): PeableElements {
  let appearance = options.appearance;
  const containers = new Set<HTMLElement>();
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;

  async function initialize(): Promise<ProviderContext> {
    const factory = await deps.loadProvider();
    let publishableKey = options.publishableKey;
    let clientSecret = options.clientSecret;
    if (!clientSecret && (options.paymentIntent || options.setupIntent)) {
      const action = options.paymentIntent
        ? await deps.payer.getClientAction(
            options.paymentIntent.id,
            options.paymentIntent.client_secret,
          )
        : await deps.payer.getSetupClientAction(
            options.setupIntent?.id ?? '',
            options.setupIntent?.client_secret ?? '',
          );
      if (action.kind !== 'client_secret') {
        throw new Error('this payment cannot be completed with card fields');
      }
      clientSecret = action.value;
      publishableKey ??= action.publishable_key;
    }
    if (!publishableKey) throw new Error('the card provider has no publishable key here');
    const sdk = factory(publishableKey);
    const shared = {
      appearance: toProviderAppearance(appearance),
      ...(options.locale ? { locale: options.locale } : {}),
    };
    if (clientSecret) {
      return { sdk, elements: sdk.elements({ ...shared, clientSecret }), deferred: false };
    }
    const mode = options.mode ?? 'payment';
    const currency = options.currency;
    if (!currency) throw new Error('a deferred element needs a currency');
    const elements = sdk.elements({
      ...shared,
      mode,
      currency: currency.toLowerCase(),
      paymentMethodTypes: ['card'],
      ...(mode === 'payment'
        ? { amount: providerAmount(options.amount ?? '0', currency) }
        : { setupFutureUsage: 'off_session' }),
    });
    return { sdk, elements, deferred: true };
  }

  let context: Promise<ProviderContext> | null = null;
  const provider = (): Promise<ProviderContext> => {
    context ??= initialize().catch((error: unknown) => {
      context = null;
      throw error;
    });
    return context;
  };

  function applyChrome(container: HTMLElement): void {
    for (const [name, value] of Object.entries(toCssVariables(appearance))) {
      container.style.setProperty(name, value);
    }
  }

  function create(
    type: PeableElementType,
    elementOptions: PeableElementOptions = {},
  ): PeableElement {
    const listeners: Array<[PeableElementEvent, (event?: unknown) => void]> = [];
    let providerElement: ProviderElement | null = null;
    let container: HTMLElement | null = null;
    let destroyed = false;

    return {
      type,
      async mount(target) {
        const host = deps.resolveTarget(target);
        if (!host) throw new Error(`no element matches ${String(target)}`);
        container = deps.createContainer();
        container.className = `peable-element peable-element--${type}`;
        applyChrome(container);
        containers.add(container);
        const fields = deps.createContainer();
        fields.className = 'peable-element__fields';
        const error = deps.createContainer();
        error.className = 'peable-element__error';
        error.setAttribute('role', 'alert');
        if (elementOptions.label) {
          const label = deps.createContainer();
          label.className = 'peable-element__label';
          label.textContent = elementOptions.label;
          container.append(label);
        }
        container.append(fields, error);
        host.replaceChildren(container);

        const { elements } = await provider();
        if (destroyed) return;
        // Wallets take the one Express Checkout configuration the hosted page
        // and the pay widget use (`cardElements.ts`); a caller's options refine it.
        providerElement = elements.create(
          type,
          type === 'expressCheckout'
            ? { ...EXPRESS_CHECKOUT_OPTIONS, ...elementOptions.provider }
            : elementOptions.provider,
        );
        providerElement.on?.('change', (event) => {
          error.textContent = event?.error?.message ?? '';
        });
        for (const [name, callback] of listeners) providerElement.on?.(name, callback);
        providerElement.mount(fields);
      },
      unmount() {
        providerElement?.unmount();
        container?.remove();
      },
      destroy() {
        destroyed = true;
        providerElement?.destroy();
        providerElement = null;
        if (container) {
          containers.delete(container);
          container.remove();
        }
      },
      on(event, callback) {
        listeners.push([event, callback]);
        providerElement?.on?.(event, callback);
      },
    };
  }

  async function credential(
    kind: 'payment' | 'setup',
    id: string,
    secret: string,
  ): Promise<string | PeableConfirmError> {
    try {
      const action =
        kind === 'payment'
          ? await deps.payer.getClientAction(id, secret)
          : await deps.payer.getSetupClientAction(id, secret);
      if (action.kind !== 'client_secret') {
        return { type: 'unavailable', message: 'This payment cannot be completed here.' };
      }
      return action.value;
    } catch (error) {
      return {
        type: 'unavailable',
        message: error instanceof Error ? error.message : 'This payment cannot be completed now.',
      };
    }
  }

  return {
    create,
    async update(next) {
      if (next.appearance !== undefined) {
        appearance = next.appearance;
        for (const container of containers) applyChrome(container);
      }
      if (!context) return;
      const { elements } = await context;
      elements.update?.({
        ...(next.appearance !== undefined
          ? { appearance: toProviderAppearance(next.appearance) }
          : {}),
        ...(next.amount !== undefined && options.currency
          ? { amount: providerAmount(next.amount, options.currency) }
          : {}),
      });
    },

    async confirmPayment(params) {
      const { sdk, elements, deferred } = await provider();
      if (deferred && elements.submit) {
        const submitted = await elements.submit();
        if (submitted.error) {
          return {
            error: {
              type: 'validation_error',
              message: message(submitted.error, 'Check the card details.'),
            },
          };
        }
      }
      const { id, client_secret: secret } = params.paymentIntent;
      // Read BEFORE confirming, so an earlier attempt's decline is not this one's answer.
      const baseline = await deps.payer.getPaymentIntent(id, secret).catch(() => null);
      const providerSecret = await credential('payment', id, secret);
      if (typeof providerSecret !== 'string') return { error: providerSecret };
      const result = await sdk.confirmPayment({
        elements,
        clientSecret: providerSecret,
        redirect: 'if_required',
        confirmParams: { return_url: params.return_url ?? deps.locationHref() },
      });
      if (result.error) {
        return {
          error: {
            type: result.error.type === 'card_error' ? 'card_error' : 'provider_error',
            message: message(result.error, 'This card could not be charged.'),
          },
        };
      }
      const { decision, last } = await awaitGateway<PaymentIntent>({
        read: () => deps.payer.getPaymentIntent(id, secret),
        subscribe: (onUpdate) =>
          deps.payer.subscribe(id, secret, onUpdate).then((sub) => ({
            unsubscribe: () => sub.unsubscribe(),
          })),
        decide: (intent) => decidePayment(intent, baseline),
        timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        pollMs,
      });
      if (decision.kind === 'resolved') {
        return { status: decision.status, paymentIntent: decision.object };
      }
      if (decision.kind === 'failed')
        return { error: decision.error, paymentIntent: decision.object };
      const seen = last ?? baseline;
      if (seen) return { status: 'pending', paymentIntent: seen };
      return { error: { type: 'unavailable', message: 'The payment could not be read.' } };
    },

    async confirmSetup(params) {
      const { sdk, elements, deferred } = await provider();
      if (!sdk.confirmSetup) {
        return { error: { type: 'unavailable', message: 'Saving a card is not available here.' } };
      }
      if (deferred && elements.submit) {
        const submitted = await elements.submit();
        if (submitted.error) {
          return {
            error: {
              type: 'validation_error',
              message: message(submitted.error, 'Check the card details.'),
            },
          };
        }
      }
      const { id, client_secret: secret } = params.setupIntent;
      const baseline = await deps.payer.getSetupIntent(id, secret).catch(() => null);
      const providerSecret = await credential('setup', id, secret);
      if (typeof providerSecret !== 'string') return { error: providerSecret };
      const result = await sdk.confirmSetup({
        elements,
        clientSecret: providerSecret,
        redirect: 'if_required',
        confirmParams: { return_url: params.return_url ?? deps.locationHref() },
      });
      if (result.error) {
        return {
          error: {
            type: result.error.type === 'card_error' ? 'card_error' : 'provider_error',
            message: message(result.error, 'This card could not be saved.'),
          },
        };
      }
      // SetupIntents have no realtime room: the poll is the wait.
      const { decision, last } = await awaitGateway<SetupIntent>({
        read: () => deps.payer.getSetupIntent(id, secret),
        decide: (setup) => decideSetup(setup, baseline),
        timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        pollMs,
      });
      if (decision.kind === 'resolved') {
        return {
          status: decision.status === 'requires_capture' ? 'processing' : decision.status,
          setupIntent: decision.object,
        };
      }
      if (decision.kind === 'failed')
        return { error: decision.error, setupIntent: decision.object };
      const seen = last ?? baseline;
      if (seen) return { status: 'pending', setupIntent: seen };
      return { error: { type: 'unavailable', message: 'The setup could not be read.' } };
    },
  };
}
