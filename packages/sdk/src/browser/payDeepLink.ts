// The `peable://pay` deep link — the one place a FairCoin payment becomes a
// request the Peable wallet opens. Shared by the pay-button widget
// (`mount.ts`), the payer sheet (`../ui/PeableSheetCheckout.tsx`) and, through
// the `./checkout` entry, the hosted checkout. Pure: no DOM, no network.
import type { PaymentIntent } from '@peable.to/shared-types';
import { PeableError } from '../core/errors';

/** The `peable://pay` deep-link scheme + host — mirrors `PAYMENT_REQUEST_PREFIX`
 * in the wallet's `packages/frontend/src/pay/payment-request.ts`. */
const PAYMENT_REQUEST_PREFIX = 'peable://pay';

/** One output of a FairCoin payment's transaction (ADR 0021 D6). */
export interface PayDeepLinkOutput {
  readonly address: string;
  /** Base-unit integer string (m⊜). */
  readonly amount: string;
}

interface PayDeepLinkCommon {
  intentId: string;
  clientSecret: string;
  /** Base-unit integer string (m⊜) — `PaymentIntent['amount']`'s own shape: the sum of every output. */
  amount: string;
  network: NonNullable<PaymentIntent['faircoin']>['network'];
}

/**
 * A payment to ONE address (the payee's Peable wallet, ADR 0021 D5), or the
 * ordered `outputs` of a payment that pays several accounts in one
 * transaction (ADR 0021 D6). FairCoin rail only — this link is a chain payment
 * request and there is nothing to put here for a card.
 */
export type PayDeepLinkParams = PayDeepLinkCommon &
  (
    | { address: string; outputs?: undefined }
    | { address?: undefined; outputs: readonly PayDeepLinkOutput[] }
  );

/**
 * Thrown when a deep link is asked for on an intent that has no chain payment
 * behind it.
 *
 * A card intent's `faircoin` is `null` (gateway ADR 0001 D6, ADR 0019), and
 * the tempting fix would be a `?? ''` at the call site. That would
 * mint `peable://pay?...&address=&network=` — a link the wallet's parser
 * accepts structurally and which sends a payer to an empty address. Failing
 * here is the only safe direction.
 */
export class PeableRailUnsupportedError extends PeableError {
  constructor(rail: string) {
    // Extends `PeableError`, not `Error`: the widget reports everything through
    // its `error` event, whose payload type is `PeableError`, and a bare `Error`
    // would arrive there only after being flattened into a `PeableAPIError`
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
  if (intent.rail !== 'faircoin' || intent.faircoin === null) {
    throw new PeableRailUnsupportedError(intent.rail);
  }
  return buildPayDeepLink({
    intentId: intent.id,
    clientSecret: intent.client_secret,
    outputs: intent.faircoin.outputs,
    amount: intent.amount,
    network: intent.faircoin.network,
  });
}

/**
 * Whether a FairCoin payment can be paid from ANY wallet — a `faircoin:` URI
 * names one address, so a payment of several outputs (ADR 0021 D6) is the
 * Peable wallet's only.
 */
export function payableByExternalWallet(intent: PaymentIntent): boolean {
  return intent.faircoin !== null && intent.faircoin.outputs.length === 1;
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
  const outputs: readonly PayDeepLinkOutput[] =
    params.outputs ??
    (params.address !== undefined ? [{ address: params.address, amount: params.amount }] : []);
  if (outputs.length === 0) {
    throw new PeableError('invalid_request_error', 'a FairCoin payment request needs an output');
  }
  // One output: exactly the long-standing form. Several: `outputs` and NO
  // `address`, so a wallet that predates ADR 0021 D6 refuses the request
  // rather than paying the whole amount to the first seller.
  const [only] = outputs;
  const destination: Array<[string, string]> =
    outputs.length === 1 && only
      ? [['address', only.address]]
      : [['outputs', outputs.map((output) => `${output.address}:${output.amount}`).join(',')]];
  const pairs: Array<[string, string]> = [
    ['intent', params.intentId],
    ['secret', params.clientSecret],
    ...destination,
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
