/**
 * Peable payment-request deep link — parser + contract.
 *
 * A merchant/Gateway hands the payer an `peable://pay?...` link (QR or button)
 * that fully describes one payment intent:
 *
 *   peable://pay?intent=<pi_...>&secret=<client_secret>&address=<addr>
 *               &amount=<base_units>&network=<mainnet|testnet>
 *
 * A payment of SEVERAL outputs — a marketplace order that pays every seller its
 * share in one transaction (Peable ADR 0021 D6) — carries no `address`; it lists
 * every output instead, `amount` being their sum:
 *
 *   peable://pay?intent=…&secret=…&network=…&amount=<total>
 *               &outputs=<addr>:<base_units>,<addr>:<base_units>,…
 *
 * `parsePaymentRequest` turns that URL into a validated {@link ParsedPaymentRequest}
 * or returns `null` for anything malformed — so the deep-link router only ever
 * pushes the approve screen for a well-formed, self-consistent request. The
 * approve screen re-derives the same values from its route params and pays the
 * `address` for `amount`, then reports the txid to the Gateway with `intentId` +
 * `clientSecret` (possession of the secret is the payer's authorization).
 */

import { getNetwork, validateAddress, type NetworkType } from '@fairco.in/core';

/** The `peable://pay` deep-link scheme + host that carries a payment request. */
const PAYMENT_REQUEST_PREFIX = 'peable://pay';

/** One output of a payment request: an address and the base units it receives. */
export interface PaymentRequestOutput {
  readonly address: string;
  readonly amount: bigint;
}

/** A fully validated, self-consistent Peable payment request. */
export interface ParsedPaymentRequest {
  /** Payment intent id (`pi_<hex>`). */
  intentId: string;
  /** The intent's client secret — the payer's proof of possession. */
  clientSecret: string;
  /**
   * The receive address of a one-output request (validated for `network`);
   * `null` when the request pays several outputs (read `outputs`).
   */
  address: string | null;
  /** Total to pay, in base units (m⊜) — the sum of `outputs`. Always positive. */
  amount: bigint;
  /** Every output the ONE transaction pays, in order; one for the legacy form. */
  outputs: readonly PaymentRequestOutput[];
  /** Chain the payment must settle on. */
  network: NetworkType;
}

/** The most outputs one request may carry (Peable's `MAX_PAYMENT_RECIPIENTS`). */
export const MAX_PAYMENT_REQUEST_OUTPUTS = 50;

/** `pi_` followed by lowercase hex — the Gateway's payment-intent id format. */
const INTENT_ID_PATTERN = /^pi_[0-9a-f]{24,}$/;

function isNetworkType(value: string): value is NetworkType {
  return value === 'mainnet' || value === 'testnet';
}

/**
 * Split the query string of an `peable://pay` URL into a key→value map. Values
 * are percent-decoded; a malformed escape (which makes `decodeURIComponent`
 * throw) surfaces as `null` so the caller rejects the whole request.
 */
function parseQuery(query: string): Map<string, string> | null {
  const params = new Map<string, string>();
  if (query.length === 0) {
    return params;
  }
  try {
    for (const pair of query.split('&')) {
      if (pair.length === 0) {
        continue;
      }
      const eq = pair.indexOf('=');
      const rawKey = eq === -1 ? pair : pair.slice(0, eq);
      const rawValue = eq === -1 ? '' : pair.slice(eq + 1);
      params.set(decodeURIComponent(rawKey), decodeURIComponent(rawValue));
    }
  } catch {
    // A malformed percent-escape means the link is corrupt — reject it whole
    // rather than acting on partially-decoded payment fields.
    return null;
  }
  return params;
}

/** A positive base-unit integer string, or `null`. */
function positiveAmount(raw: string): bigint | null {
  // Never a float: reject a sign, a decimal point, or any non-digit.
  if (!/^\d+$/.test(raw)) return null;
  const amount = BigInt(raw);
  return amount > 0n ? amount : null;
}

/**
 * Parse an `outputs` value (`<addr>:<amount>,…`) for `network`, checking it
 * pays exactly `total`: every address valid and distinct, every amount
 * positive, at most {@link MAX_PAYMENT_REQUEST_OUTPUTS}. `null` otherwise.
 */
export function parsePaymentOutputs(
  raw: string,
  network: NetworkType,
  total: bigint,
): PaymentRequestOutput[] | null {
  const entries = raw.split(',');
  if (entries.length === 0 || entries.length > MAX_PAYMENT_REQUEST_OUTPUTS) return null;
  const outputs: PaymentRequestOutput[] = [];
  const seen = new Set<string>();
  let sum = 0n;
  for (const entry of entries) {
    const colon = entry.lastIndexOf(':');
    if (colon <= 0) return null;
    const address = entry.slice(0, colon);
    const amount = positiveAmount(entry.slice(colon + 1));
    if (amount === null || seen.has(address)) return null;
    if (!validateAddress(address, getNetwork(network))) return null;
    seen.add(address);
    sum += amount;
    outputs.push({ address, amount });
  }
  return sum === total ? outputs : null;
}

/** The `outputs` value for a list of outputs — {@link parsePaymentOutputs}'s inverse. */
export function formatPaymentOutputs(outputs: readonly PaymentRequestOutput[]): string {
  return outputs.map((output) => `${output.address}:${output.amount.toString()}`).join(',');
}

/**
 * Validate a payment request's fields — the ONE check behind both the deep
 * link ({@link parsePaymentRequest}) and the approve screen's route params
 * ({@link paymentRequestFromParams}).
 */
function validatePaymentRequest(
  params: ReadonlyMap<string, string | undefined>,
): ParsedPaymentRequest | null {
  const intentId = params.get('intent') ?? '';
  const clientSecret = params.get('secret') ?? '';
  const address = params.get('address') ?? '';
  const outputsRaw = params.get('outputs') ?? '';
  const networkRaw = params.get('network') ?? '';

  if (!INTENT_ID_PATTERN.test(intentId)) {
    return null;
  }

  // The client secret is minted as `${intentId}_secret_<hex>`; tying it back to
  // the intent id rejects a mismatched (mis-pasted / spoofed) id/secret pair.
  if (!clientSecret.startsWith(`${intentId}_secret_`)) {
    return null;
  }

  if (!isNetworkType(networkRaw)) {
    return null;
  }
  const network = networkRaw;

  const amount = positiveAmount(params.get('amount') ?? '');
  if (amount === null) {
    return null;
  }

  // Exactly one form: one `address`, or the `outputs` list.
  if (address.length > 0 === outputsRaw.length > 0) {
    return null;
  }
  if (outputsRaw.length > 0) {
    const outputs = parsePaymentOutputs(outputsRaw, network, amount);
    if (outputs === null) return null;
    const single = outputs.length === 1 ? outputs[0] : undefined;
    return { intentId, clientSecret, address: single?.address ?? null, amount, outputs, network };
  }

  if (!validateAddress(address, getNetwork(network))) {
    return null;
  }
  return { intentId, clientSecret, address, amount, outputs: [{ address, amount }], network };
}

/**
 * Parse and fully validate an `peable://pay?...` deep link.
 *
 * Returns `null` unless every field is present and self-consistent: the scheme
 * matches, `intent` looks like a `pi_` id, `secret` belongs to that intent,
 * `network` is a known chain, `amount` is a positive base-unit integer, and
 * either `address` is a valid FairCoin address on that chain or `outputs` lists
 * valid, distinct addresses whose amounts sum to `amount`.
 */
export function parsePaymentRequest(uri: string): ParsedPaymentRequest | null {
  const trimmed = uri.trim();
  if (!trimmed.startsWith(PAYMENT_REQUEST_PREFIX)) {
    return null;
  }

  const rest = trimmed.slice(PAYMENT_REQUEST_PREFIX.length);
  // Only the bare host or a `?query` may follow — guard against `peable://payX`.
  if (rest.length > 0 && !rest.startsWith('?')) {
    return null;
  }
  const query = rest.startsWith('?') ? rest.slice(1) : '';

  const params = parseQuery(query);
  if (!params) {
    return null;
  }
  return validatePaymentRequest(params);
}

/** The approve screen's route params for a validated request (`/pay/[intent]`). */
export function paymentRequestRouteParams(request: ParsedPaymentRequest): Record<string, string> {
  const base = {
    intent: request.intentId,
    secret: request.clientSecret,
    amount: request.amount.toString(),
    network: request.network,
  };
  return request.outputs.length === 1 && request.address !== null
    ? { ...base, address: request.address }
    : { ...base, outputs: formatPaymentOutputs(request.outputs) };
}

/**
 * Re-derive (and re-validate) a request from the approve screen's route params:
 * a direct navigation may arrive incomplete, and is then `null`.
 */
export function paymentRequestFromParams(
  params: Readonly<Record<string, string | string[] | undefined>>,
): ParsedPaymentRequest | null {
  const map = new Map<string, string | undefined>();
  for (const key of ['intent', 'secret', 'address', 'outputs', 'amount', 'network']) {
    const value = params[key];
    map.set(key, typeof value === 'string' ? value : undefined);
  }
  return validatePaymentRequest(map);
}
