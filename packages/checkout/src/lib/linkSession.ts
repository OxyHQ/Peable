// Reuse-if-open for `/l/:linkId` (spec §6): a payer who reloads or re-visits
// a payment link should land back on the SAME in-flight `PaymentIntent`
// rather than minting a new receive address every time. The server always
// mints fresh on request — this module is what decides, client-side,
// whether the page even needs to ask for a fresh one.
import { getPaymentIntent } from './intentClient';
import { canStillBePaid, type PaymentIntent } from '@peable.to/shared-types';

export interface OpenIntentRef {
  id: string;
  clientSecret: string;
}

function storageKey(linkId: string): string {
  return `peable:link-intent:${linkId}`;
}

/** Raw sessionStorage read — does NOT check whether the referenced intent is
 * still open; callers that need that go through `getReusableIntentForLink`. */
export function getOpenIntentForLink(linkId: string): OpenIntentRef | null {
  const raw = sessionStorage.getItem(storageKey(linkId));
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof (parsed as { id?: unknown }).id === 'string' &&
    typeof (parsed as { clientSecret?: unknown }).clientSecret === 'string'
  ) {
    return parsed as OpenIntentRef;
  }
  return null;
}

export function rememberIntentForLink(linkId: string, intent: OpenIntentRef): void {
  sessionStorage.setItem(storageKey(linkId), JSON.stringify(intent));
}

export function forgetIntentForLink(linkId: string): void {
  sessionStorage.removeItem(storageKey(linkId));
}

function isExpired(intent: PaymentIntent): boolean {
  return intent.expires_at * 1000 <= Date.now();
}

/**
 * True when a remembered intent is still safe to reuse as-is: the payer can
 * still complete a payment against it, and it is not past its own `expires_at`.
 *
 * This used to ask whether the status was a LEAF of the transition table, which
 * meant `settled` right up until `settled` gained the refund edges — after
 * which a settled payment stopped looking finished and this function started
 * reusing it, showing a payer who had already paid their old receipt forever
 * with no way to pay the link again. `canStillBePaid` asks the question in the
 * payer's terms instead: is `settled` still reachable from here.
 */
function isReusable(intent: PaymentIntent): boolean {
  return canStillBePaid(intent.status) && !isExpired(intent);
}

/**
 * The reuse-if-open decision for `/l/:linkId`: re-fetch a remembered intent
 * (if any) and reuse it when it's still open; otherwise fall through so the
 * caller mints a fresh one and remembers it via `rememberIntentForLink`.
 * Never mints itself — payment links have no SDK client core (only payment
 * intents do), so minting is a plain `POST` the route makes directly.
 */
export async function getReusableIntentForLink(linkId: string): Promise<PaymentIntent | null> {
  const remembered = getOpenIntentForLink(linkId);
  if (!remembered) return null;

  let intent: PaymentIntent;
  try {
    intent = await getPaymentIntent(remembered.id, remembered.clientSecret);
  } catch {
    forgetIntentForLink(linkId);
    return null;
  }

  if (!isReusable(intent)) {
    forgetIntentForLink(linkId);
    return null;
  }
  return intent;
}
