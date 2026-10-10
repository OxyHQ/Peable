/**
 * HTTP client for the notification server's watch-only registration endpoint
 * (Explorer, spec §4.1).
 *
 * The wallet registers its **watch-only account xpub** plus a gap limit and a
 * native push token; the server derives the receive/change addresses itself and
 * sends a silent push when one is paid. The registration body carries NO private
 * key — only the public extended key — so this works while the wallet is
 * PIN-locked and can never grant spend capability.
 *
 * Fetch-only (no native modules), so the unit test can exercise it directly.
 */

import type { NotificationEvent } from './notification-settings';

/** The registration request. `serverUrl` selects the host; it is NOT sent in the body. */
export interface RegisterInput {
  serverUrl: string;
  xpub: string;
  scriptType: 'p2pkh';
  gapLimit: number;
  network: 'mainnet' | 'testnet';
  deviceToken: string;
  platform: 'android' | 'ios';
  confirmations: number;
  events: NotificationEvent[];
}

export interface RegisterResponse {
  subscriptionId: string;
  watchedTo?: { receive: number; change: number };
}

const REGISTER_PATH = '/api/notifications/register';

/** Strip a trailing slash (or several) so URL joins never double up on `/`. */
export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function parseWatchedTo(value: unknown): RegisterResponse['watchedTo'] {
  if (value === null || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.receive === 'number' && typeof obj.change === 'number') {
    return { receive: obj.receive, change: obj.change };
  }
  return undefined;
}

/**
 * Register the watch-only xpub for background push. POSTs the exact spec §4.1
 * body (no private material) and returns the opaque `subscriptionId`. Throws on
 * a non-2xx response or a body missing the id, so the caller can retry.
 */
export async function registerForPush(input: RegisterInput): Promise<RegisterResponse> {
  const base = normalizeServerUrl(input.serverUrl);

  // Explicit field whitelist — the body is exactly the wire contract and never
  // includes a private key, mnemonic, or seed.
  const body = {
    xpub: input.xpub,
    scriptType: input.scriptType,
    gapLimit: input.gapLimit,
    network: input.network,
    deviceToken: input.deviceToken,
    platform: input.platform,
    confirmations: input.confirmations,
    events: input.events,
  };

  const response = await fetch(`${base}${REGISTER_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Notification registration failed: HTTP ${response.status}`);
  }

  const data: unknown = await response.json();
  if (data === null || typeof data !== 'object') {
    throw new Error('Notification registration returned an unexpected body');
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.subscriptionId !== 'string' || obj.subscriptionId.length === 0) {
    throw new Error('Notification registration returned no subscriptionId');
  }

  return {
    subscriptionId: obj.subscriptionId,
    watchedTo: parseWatchedTo(obj.watchedTo),
  };
}

/**
 * Cancel a registration (notifications off, wallet delete, token rotation).
 * DELETEs `{ subscriptionId }`; throws on a non-2xx response.
 */
export async function unregisterFromPush(serverUrl: string, subscriptionId: string): Promise<void> {
  const base = normalizeServerUrl(serverUrl);
  const response = await fetch(`${base}${REGISTER_PATH}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscriptionId }),
  });

  if (!response.ok) {
    throw new Error(`Notification unregistration failed: HTTP ${response.status}`);
  }
}
