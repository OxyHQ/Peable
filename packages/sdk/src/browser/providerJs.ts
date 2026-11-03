// Loading the card provider's own browser SDK, and nothing else from it.
//
// The provider owns its iframe fields and this loader never receives their values.
// A script tag and the official npm loader both load provider-origin frames;
// choosing this dependency-free loader is not a compliance certification.
//
// ## Why the key is not compiled in
//
// `publishableKey` arrives from the gateway, with the confirmation credential,
// on the one response that already proved the caller may pay this payment. The
// checkout is deployed ONCE and serves whichever gateway `VITE_GATEWAY_URL`
// points at, so a key baked into this bundle would be the wrong mode the first
// time a test deployment used the same page — a live card form over a test
// payment, or the reverse.

/** The provider's script, pinned to the versioned URL they publish. */
const PROVIDER_SDK_URL = 'https://js.stripe.com/v3/';

/** Minimal shapes — only what this app calls. The SDK's own types are not a dependency. */
export interface ProviderFieldEvent {
  complete?: boolean;
  empty?: boolean;
  error?: { message?: string };
  brand?: string;
}
export interface ProviderElement {
  mount(selector: string | HTMLElement): void;
  on?(
    event: 'ready' | 'loaderror' | 'change' | 'focus' | 'blur',
    callback: (event?: ProviderFieldEvent) => void,
  ): void;
  update?(options: Record<string, unknown>): void;
  focus?(): void;
  unmount(): void;
  destroy(): void;
}

export interface ProviderElements {
  update?(options: Record<string, unknown>): void;
  create(
    type: 'payment' | 'cardNumber' | 'cardExpiry' | 'cardCvc',
    options?: Record<string, unknown>,
  ): ProviderElement;
  getElement(type: 'payment'): ProviderElement | null;
}

export interface ProviderConfirmResult {
  error?: { message?: string; type?: string };
  paymentIntent?: { status?: string };
}

export interface ProviderSdk {
  elements(options: Record<string, unknown>): ProviderElements;
  createPaymentMethod?(data: {
    type: 'card';
    card: ProviderElement;
    billing_details: { address: { country: string; postal_code: string } };
  }): Promise<{
    error?: { message?: string };
    paymentMethod?: { id: string; card?: { brand?: string; last4?: string } };
  }>;
  confirmCardPayment?(
    clientSecret: string,
    data: {
      payment_method:
        | string
        | {
            card: ProviderElement;
            billing_details: { address: { country: string; postal_code: string } };
          };
      return_url?: string;
    },
  ): Promise<ProviderConfirmResult>;
  confirmPayment(options: {
    elements: ProviderElements;
    confirmParams?: Record<string, unknown>;
    redirect?: 'if_required' | 'always';
  }): Promise<ProviderConfirmResult>;
}

type ProviderFactory = (key: string, options?: Record<string, unknown>) => ProviderSdk;

/**
 * The in-flight or completed load. Module-level because the script is a
 * SINGLETON per document: two components mounting at once must share one load
 * rather than appending two identical tags, and a page that navigates between
 * card intents must not re-fetch it.
 */
let loading: Promise<ProviderFactory> | null = null;

function existingFactory(): ProviderFactory | undefined {
  return (globalThis as { Stripe?: ProviderFactory }).Stripe;
}

/**
 * Load the provider's SDK once, and hand back its factory.
 *
 * Rejects rather than resolving with a stub when the script cannot be reached —
 * an ad blocker, an offline payer, a CSP that forbids the origin. A stub would
 * render a card form with no fields in it, which reads to the payer as the
 * merchant's site being broken.
 */
export function loadProviderSdk(): Promise<ProviderFactory> {
  const already = existingFactory();
  if (already) return Promise.resolve(already);
  if (loading) return loading;

  loading = new Promise<ProviderFactory>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = PROVIDER_SDK_URL;
    script.async = true;
    const timeout = setTimeout(() => {
      loading = null;
      script.remove();
      reject(new Error('the card provider script timed out'));
    }, 15000);
    script.onload = () => {
      clearTimeout(timeout);
      const factory = existingFactory();
      if (factory) {
        resolve(factory);
        return;
      }
      // Loaded and did not define what it was supposed to — a captive portal or
      // a proxy serving something else. Distinguished from a network failure
      // because the fix is different, and a payer reporting either deserves an
      // operator who can tell them apart.
      loading = null;
      reject(new Error('the card provider script loaded but defined nothing'));
    };
    script.onerror = () => {
      clearTimeout(timeout);
      script.remove();
      // Cleared so a retry re-attempts rather than resolving the same rejected
      // promise forever — this is exactly the case a payer retries by hand.
      loading = null;
      reject(new Error('the card provider script could not be loaded'));
    };
    document.head.append(script);
  });

  return loading;
}
