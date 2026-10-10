// `PeableCheckout.mount(...)` — the embeddable "Pay with Peable" button
// (Fase 2 SDK plan, Task 6). Plain DOM, no framework, so it embeds on any
// site. Renders a button into the host element, fetches + subscribes to the
// payment intent via the Task 5 payer client, drives a typed
// `settled`/`confirming`/`failed`/`error` event emitter, and on click either
// opens the `peable://pay` deep link (mobile) or shows a QR of it (desktop).
//
// Same `./core/*` boundary as `payerClient.ts`: the only import from `./core`
// is `core/errors.ts`, a pure status-mapper with no service-token/secret
// machinery, so it carries none of the merchant-authed code out of bounds for
// this browser bundle.
import createQrCode from 'qrcode-generator';
import type { PaymentIntent, PaymentIntentStatus } from '@peable.to/shared-types';
import { createPeableCheckout } from './payerClient';
import { PeableApiError, PeableError, PeableInvalidRequestError } from '../core/errors';

// ---------------------------------------------------------------------------
// Intent id derivation (pure, unit-tested independently of the DOM).
// ---------------------------------------------------------------------------

/**
 * `pi_` followed by ≥24 lowercase hex chars — the Gateway's payment-intent id
 * format. Mirrors `INTENT_ID_PATTERN` in the wallet's
 * `packages/frontend/src/pay/payment-request.ts` byte-for-byte, and matches
 * what `newId('pi')` in `packages/backend/src/lib/ids.ts` actually mints (12
 * random bytes → 24 hex chars).
 */
const INTENT_ID_PATTERN = /^pi_[0-9a-f]{24,}$/;

/**
 * Derive and validate the payment intent id for `mount()`. When `intentId` is
 * omitted, the id IS the prefix of `clientSecret` before `_secret_`
 * (`clientSecretFor` in `packages/backend/src/lib/ids.ts` mints
 * `${id}_secret_<hex>`, so `clientSecret.split('_secret_')[0]` recovers it).
 * Either way the result must look like a real Gateway-minted id AND
 * `clientSecret` must actually belong to it — a malformed or mismatched pair
 * is a caller integration bug, and `mount()` must never render a button
 * wired to a bogus id.
 */
export function deriveIntentId(clientSecret: string, intentId?: string): string {
  const id = intentId ?? clientSecret.split('_secret_')[0] ?? '';
  if (!INTENT_ID_PATTERN.test(id)) {
    throw new PeableInvalidRequestError(
      `PeableCheckout.mount: invalid or missing payment intent id ("${id}") — ` +
        'pass `intentId` explicitly or a well-formed `clientSecret`',
    );
  }
  if (!clientSecret.startsWith(`${id}_secret_`)) {
    throw new PeableInvalidRequestError(
      'PeableCheckout.mount: clientSecret does not belong to the given intentId',
    );
  }
  return id;
}

// ---------------------------------------------------------------------------
// Deep link (pure, unit-tested independently of the DOM).
// ---------------------------------------------------------------------------

/** The `peable://pay` deep-link scheme + host — mirrors `PAYMENT_REQUEST_PREFIX`
 * in the wallet's `packages/frontend/src/pay/payment-request.ts`. */
const PAYMENT_REQUEST_PREFIX = 'peable://pay';

export interface PayDeepLinkParams {
  intentId: string;
  clientSecret: string;
  /**
   * The intent's watch-only receive address. FairCoin rail only — this link is
   * a chain payment request and there is nothing to put here for a card.
   */
  address: string;
  /** Base-unit integer string (m⊜) — `PaymentIntent['amount']`'s own shape. */
  amount: string;
  network: NonNullable<PaymentIntent['network']>;
}

/**
 * Thrown when a deep link is asked for on an intent that has no chain payment
 * behind it.
 *
 * `address` and `network` became nullable when the card rail landed (gateway
 * ADR 0001 D6), and the tempting fix was a `?? ''` at the call site. That would
 * mint `peable://pay?...&address=&network=` — a link the wallet's parser
 * accepts structurally and which sends a payer to an empty address. Failing
 * here is the only safe direction.
 */
export class PeableRailUnsupportedError extends PeableError {
  constructor(rail: string) {
    // Extends `PeableError`, not `Error`: the widget reports everything through
    // its `error` event, whose payload type is `PeableError`, and a bare `Error`
    // would arrive there only after being flattened into a `PeableApiError`
    // that a caller cannot tell apart from a network failure.
    // `invalid_request_error`, because that is what it is: the caller asked
    // this widget for a surface the intent does not have. Nothing went wrong
    // upstream and retrying cannot help.
    super(
      'invalid_request_error',
      `the '${rail}' rail has no wallet deep link; it is not a chain payment`,
    );
    this.name = 'PeableRailUnsupportedError';
    Object.setPrototypeOf(this, PeableRailUnsupportedError.prototype);
  }
}

/**
 * Build the deep link for an intent, refusing any intent that is not a chain
 * payment. The narrowing is what lets `buildPayDeepLink` keep non-null fields.
 */
export function payDeepLinkFor(intent: PaymentIntent): string {
  if (intent.rail !== 'faircoin' || intent.address === null || intent.network === null) {
    throw new PeableRailUnsupportedError(intent.rail);
  }
  return buildPayDeepLink({
    intentId: intent.id,
    clientSecret: intent.clientSecret,
    address: intent.address,
    amount: intent.amount,
    network: intent.network,
  });
}

/**
 * Build an `peable://pay?...` deep link. Param names AND percent-encoding
 * must match the wallet's parser byte-for-byte
 * (`packages/frontend/src/pay/payment-request.ts`'s `parseQuery`, which
 * splits on `&` then `=` and `decodeURIComponent`s each side raw) —
 * deliberately built by hand with `encodeURIComponent` rather than
 * `URLSearchParams`, whose `application/x-www-form-urlencoded` encoding
 * (e.g. space → `+`) is a different scheme than plain `decodeURIComponent`
 * expects on the other end.
 */
export function buildPayDeepLink(params: PayDeepLinkParams): string {
  const pairs: Array<[string, string]> = [
    ['intent', params.intentId],
    ['secret', params.clientSecret],
    ['address', params.address],
    ['amount', params.amount],
    ['network', params.network],
  ];
  const query = pairs
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${PAYMENT_REQUEST_PREFIX}?${query}`;
}

/** Only a phone can plausibly have the Peable wallet app installed to catch
 * the `peable://` deep link — desktop gets a QR to scan with it instead. */
const MOBILE_USER_AGENT_PATTERN = /Android|iPhone|iPad|iPod/i;

export function isMobileUserAgent(userAgent: string): boolean {
  return MOBILE_USER_AGENT_PATTERN.test(userAgent);
}

// ---------------------------------------------------------------------------
// Typed event emitter (pure, unit-tested independently of the DOM).
// ---------------------------------------------------------------------------

export interface PeableCheckoutEventMap {
  settled: PaymentIntent;
  confirming: PaymentIntent;
  failed: PaymentIntent;
  error: PeableError;
}

type CheckoutEventName = keyof PeableCheckoutEventMap;
type CheckoutEventHandler<K extends CheckoutEventName> = (
  payload: PeableCheckoutEventMap[K],
) => void;

interface CheckoutEmitter {
  on<K extends CheckoutEventName>(event: K, handler: CheckoutEventHandler<K>): void;
  emit<K extends CheckoutEventName>(event: K, payload: PeableCheckoutEventMap[K]): void;
  removeAll(): void;
}

/**
 * A minimal typed pub/sub. The public `on`/`emit` are fully type-checked per
 * event; the internal `Map` necessarily erases each handler's specific
 * payload type (it stores handlers for every event key in one collection),
 * so the single cast at the storage boundary is intentional, not a type-safety
 * hole — nothing outside this function ever sees the erased type.
 */
export function createEmitter(): CheckoutEmitter {
  const handlers = new Map<CheckoutEventName, Set<CheckoutEventHandler<CheckoutEventName>>>();

  return {
    on(event, handler) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler as CheckoutEventHandler<CheckoutEventName>);
      handlers.set(event, set);
    },
    emit(event, payload) {
      const set = handlers.get(event);
      if (!set) return;
      for (const handler of set) {
        (handler as CheckoutEventHandler<typeof event>)(payload);
      }
    },
    removeAll() {
      handlers.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// DOM rendering — exercised only by the real-browser Step 3 check (deferred;
// see the Task 6 report), not by the headless unit suite.
// ---------------------------------------------------------------------------

const BUTTON_CLASS = 'peable-checkout-button';
const OVERLAY_CLASS = 'peable-checkout-qr-overlay';

/** Statuses that still accept a payment — everything else disables the button. */
const PAYABLE_STATUSES: ReadonlySet<PaymentIntentStatus> = new Set([
  'created',
  'awaiting_approval',
  'approved',
]);

function resolveTarget(target: string | Element): Element {
  const element = typeof target === 'string' ? document.querySelector(target) : target;
  if (!(element instanceof Element)) {
    throw new PeableInvalidRequestError(
      typeof target === 'string'
        ? `PeableCheckout.mount: no element matches selector "${target}"`
        : 'PeableCheckout.mount: target is not a DOM Element',
    );
  }
  return element;
}

function renderButton(container: Element): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = BUTTON_CLASS;
  button.textContent = 'Pay with Peable';
  button.disabled = true; // enabled once the initial snapshot loads
  button.style.cssText =
    'padding:12px 24px;border-radius:8px;border:none;background:#5b21b6;' +
    'color:#fff;font:600 15px system-ui,sans-serif;cursor:pointer;';
  container.replaceChildren(button);
  return button;
}

function updateButton(button: HTMLButtonElement, intent: PaymentIntent): void {
  button.disabled = !PAYABLE_STATUSES.has(intent.status);
  switch (intent.status) {
    case 'settled':
      button.textContent = 'Paid';
      break;
    case 'confirming':
      button.textContent = 'Confirming…';
      break;
    case 'broadcast':
      button.textContent = 'Payment received';
      break;
    case 'failed':
    case 'expired':
    case 'rejected':
      button.textContent = 'Payment unavailable';
      break;
    default:
      button.textContent = 'Pay with Peable';
  }
}

/**
 * Show a QR of the deep link for a desktop payer to scan with the wallet
 * app. `qr.createSvgTag()` is `qrcode-generator`'s own trusted output — a
 * grid of `<rect>` "modules" encoding `deepLink` as opaque data, never as
 * literal SVG text — so assigning it via `innerHTML` carries no injection
 * risk from `deepLink`'s content.
 */
function showQrOverlay(deepLink: string): void {
  const qr = createQrCode(0, 'M'); // type 0 = auto-sized, level M = 15% error correction
  qr.addData(deepLink);
  qr.make();

  const overlay = document.createElement('div');
  overlay.className = OVERLAY_CLASS;
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;' +
    'justify-content:center;background:rgba(0,0,0,0.5);';
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.remove();
  });

  const card = document.createElement('div');
  card.style.cssText =
    'background:#fff;border-radius:12px;padding:24px;display:flex;' +
    'flex-direction:column;align-items:center;gap:12px;';
  card.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });

  const caption = document.createElement('p');
  caption.textContent = 'Scan with the Peable app';
  caption.style.cssText = 'margin:0;font:500 14px system-ui,sans-serif;color:#111;';

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = 'Close';
  closeButton.style.cssText =
    'padding:8px 16px;border-radius:6px;border:1px solid #d1d5db;background:#fff;' +
    'font:500 14px system-ui,sans-serif;cursor:pointer;';
  closeButton.addEventListener('click', () => overlay.remove());

  card.append(caption, closeButton);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

export interface PeableCheckoutMountOptions {
  /** The payment intent's `client_secret` — the payer's proof of possession. */
  clientSecret: string;
  /** Payment intent id. Derived from `clientSecret` when omitted — see {@link deriveIntentId}. */
  intentId?: string;
  /** Gateway base URL, forwarded to {@link createPeableCheckout}. Default `https://api.peable.to`. */
  gatewayUrl?: string;
}

export interface PeableCheckoutInstance {
  on<K extends CheckoutEventName>(event: K, handler: CheckoutEventHandler<K>): void;
  /** Unsubscribes from realtime updates and removes the button from the DOM. */
  destroy(): void;
}

function toPeableError(error: unknown): PeableError {
  if (error instanceof PeableError) return error;
  return new PeableApiError(error instanceof Error ? error.message : String(error));
}

/**
 * Render the "Pay with Peable" button into `target` and start tracking the
 * payment intent. Returns synchronously — before any network call resolves —
 * so a caller's `.on(...)` registrations (called immediately after `mount()`
 * returns, in the same synchronous tick) are always in place before the
 * first `settled`/`confirming`/`failed`/`error` event can fire on the
 * following microtask.
 */
function mount(target: string | Element, opts: PeableCheckoutMountOptions): PeableCheckoutInstance {
  const element = resolveTarget(target);
  const intentId = deriveIntentId(opts.clientSecret, opts.intentId);
  const clientSecret = opts.clientSecret;

  const emitter = createEmitter();
  const payerClient = createPeableCheckout({ gatewayUrl: opts.gatewayUrl });
  const button = renderButton(element);

  let latestIntent: PaymentIntent | null = null;
  let subscription: { unsubscribe(): void } | null = null;
  let destroyed = false;

  function handleIntentUpdate(intent: PaymentIntent): void {
    latestIntent = intent;
    updateButton(button, intent);
    if (intent.status === 'settled') {
      emitter.emit('settled', intent);
    } else if (intent.status === 'confirming') {
      emitter.emit('confirming', intent);
    } else if (
      intent.status === 'failed' ||
      intent.status === 'expired' ||
      intent.status === 'rejected'
    ) {
      emitter.emit('failed', intent);
    }
  }

  button.addEventListener('click', () => {
    if (!latestIntent) return; // initial snapshot hasn't loaded yet
    // A card intent has no wallet to deep-link into. `error` rather than a
    // throw into an event handler nobody is listening to: this widget's whole
    // contract is that a host page learns what happened through `on(...)`, and
    // an uncaught exception here would leave the button silently dead.
    let deepLink: string;
    try {
      deepLink = payDeepLinkFor(latestIntent);
    } catch (err) {
      emitter.emit('error', toPeableError(err));
      return;
    }
    if (isMobileUserAgent(navigator.userAgent)) {
      window.location.href = deepLink;
    } else {
      showQrOverlay(deepLink);
    }
  });

  // `destroyed` closes a race a caller CAN legitimately hit: calling
  // `destroy()` while `getPaymentIntent`/`subscribe` is still in flight (e.g.
  // the host page unmounts the widget immediately). Without this guard, a
  // subscription created AFTER `destroy()` ran would overwrite `subscription`
  // (still `null` at destroy time) and never get torn down — a leaked socket
  // connection for the rest of the tab's life.
  void payerClient
    .getPaymentIntent(intentId, clientSecret)
    .then((intent) => {
      if (destroyed) return null;
      handleIntentUpdate(intent);
      return payerClient.subscribe(intentId, clientSecret, handleIntentUpdate);
    })
    .then((sub) => {
      if (!sub) return;
      if (destroyed) {
        sub.unsubscribe();
        return;
      }
      subscription = sub;
    })
    .catch((error: unknown) => {
      if (destroyed) return;
      emitter.emit('error', toPeableError(error));
    });

  return {
    on(event, handler) {
      emitter.on(event, handler);
    },
    destroy() {
      destroyed = true;
      subscription?.unsubscribe();
      emitter.removeAll();
      button.remove();
    },
  };
}

export const PeableCheckout = { mount };
