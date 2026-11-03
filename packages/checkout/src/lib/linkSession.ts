// Reuse-if-open for `/l/:linkId`: a payer who reloads or re-visits a payment
// link lands back on the SAME open checkout session rather than starting a new
// one each time. Only an id and the session's own secret are remembered, in
// this tab's sessionStorage; whether the session is still open is asked of the
// gateway, never assumed.
import { getCheckoutSession } from './sessionClient';

export interface OpenSessionRef {
  id: string;
  clientSecret: string;
}

const storageKey = (linkId: string) => `peable:link-session:${linkId}`;

export function getRememberedSession(linkId: string): OpenSessionRef | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(storageKey(linkId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { id?: unknown }).id === 'string' &&
      typeof (parsed as { clientSecret?: unknown }).clientSecret === 'string'
    ) {
      return parsed as OpenSessionRef;
    }
  } catch {
    // A corrupt entry is treated as none.
  }
  return null;
}

export function rememberSession(linkId: string, session: OpenSessionRef): void {
  try {
    sessionStorage.setItem(storageKey(linkId), JSON.stringify(session));
  } catch {
    // Storage unavailable: the next visit starts a fresh session, which is safe.
  }
}

export function forgetSession(linkId: string): void {
  try {
    sessionStorage.removeItem(storageKey(linkId));
  } catch {
    // Nothing to forget.
  }
}

/** A remembered session the payer can still use, or `null` (and it is forgotten). */
export async function reusableSessionForLink(linkId: string): Promise<OpenSessionRef | null> {
  const remembered = getRememberedSession(linkId);
  if (!remembered) return null;
  try {
    const session = await getCheckoutSession(remembered.id, remembered.clientSecret);
    if (session.status === 'open' && session.expires_at * 1000 > Date.now()) return remembered;
  } catch {
    // Unreadable: start over.
  }
  forgetSession(linkId);
  return null;
}
