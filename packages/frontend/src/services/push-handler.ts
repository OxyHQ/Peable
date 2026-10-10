/**
 * Silent-push handler (spec §4.2): turns a data-only push carrying `{ txid,
 * event }` into an on-device local notification whose amount is composed HERE,
 * from the synced transaction — never from the push payload (Google/Apple never
 * see amounts or addresses).
 *
 * On a wake the handler fetches the transaction from the configured server's
 * Explorer read API, computes the delta to the wallet's watched addresses, and
 * posts the matching local notification: a received alert for the incoming
 * events, a send-confirmed alert for `outgoing_confirmed`. A txid that doesn't
 * touch this wallet posts nothing.
 *
 * ## Testability / import safety
 *
 * The core {@link createPushHandler} is dependency-injected and imports only the
 * pure `@fairco.in/core` amount helpers, so its unit test runs without loading
 * react-native. The production {@link handleIncomingPush} lazily `require`s the
 * native pieces (notifications, wallet store, prefs) inside its body.
 */

import { parseFairToUnits } from '@fairco.in/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An output (or resolved input prevout) reduced to what the delta needs. */
export interface PushTxEntry {
  /** Addresses the entry pays to (P2PKH → one). Empty when unresolvable. */
  addresses: string[];
  /** Value in FAIR (as the Explorer returns it — a decimal, not base units). */
  value: number;
}

/** The subset of a transaction the delta computation reads. */
export interface PushTransaction {
  /** Outputs of the transaction. */
  vout: PushTxEntry[];
  /** Resolved input prevouts (coinbase / unresolved inputs omitted). */
  vin: PushTxEntry[];
}

export interface PushHandlerDeps {
  /** Fetch the transaction, or null when it can't be resolved. */
  fetchTransaction: (txid: string) => Promise<PushTransaction | null>;
  /** The wallet's watched addresses; empty while locked / no wallet. */
  getWalletAddresses: () => string[];
  /** Post the "received X FAIR" local notification (amount in base units). */
  notifyReceived: (amountUnits: bigint, txid: string) => Promise<void>;
  /** Post the "your send confirmed" local notification (amount in base units). */
  notifySentConfirmed: (amountUnits: bigint, txid: string) => Promise<void>;
}

export interface PushHandler {
  handleIncomingPush: (data: { txid: string; event: string }) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Convert a FAIR decimal (from the Explorer) into base units without floating
 * point error, by routing through the string-based `parseFairToUnits`. Values
 * from the chain are non-negative; an unparseable value contributes 0.
 */
function fairToUnits(fair: number): bigint {
  if (!Number.isFinite(fair) || fair < 0) return 0n;
  return parseFairToUnits(fair.toFixed(8)) ?? 0n;
}

function sumOursUnits(entries: PushTxEntry[], ours: Set<string>): bigint {
  let total = 0n;
  for (const entry of entries) {
    if (entry.addresses.some((address) => ours.has(address))) {
      total += fairToUnits(entry.value);
    }
  }
  return total;
}

export function createPushHandler(deps: PushHandlerDeps): PushHandler {
  async function handleIncomingPush(data: { txid: string; event: string }): Promise<void> {
    const tx = await deps.fetchTransaction(data.txid);
    if (!tx) return;

    const ours = new Set(deps.getWalletAddresses());
    if (ours.size === 0) return;

    const receivedUnits = sumOursUnits(tx.vout, ours);
    const spentUnits = sumOursUnits(tx.vin, ours);

    if (data.event === 'outgoing_confirmed') {
      // Amount that left the wallet = our spent inputs minus change back to us.
      const net = spentUnits - receivedUnits;
      if (net > 0n) {
        await deps.notifySentConfirmed(net, data.txid);
      }
      return;
    }

    // Incoming events (pending / confirmed): net credit to the wallet.
    const net = receivedUnits - spentUnits;
    if (net > 0n) {
      await deps.notifyReceived(net, data.txid);
    }
  }

  return { handleIncomingPush };
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

/** Explorer verbose-transaction shapes we read (see Explorer `VerboseTransaction`). */
interface RawScriptPubKey {
  addresses?: string[];
}
interface RawVout {
  value?: number;
  scriptPubKey?: RawScriptPubKey;
}
interface RawPrevout {
  value?: number;
  addresses?: string[];
}
interface RawVin {
  prevout?: RawPrevout;
}
interface RawTransaction {
  vout?: RawVout[];
  vin?: RawVin[];
}

function mapExplorerTransaction(raw: RawTransaction): PushTransaction {
  const vout: PushTxEntry[] = (raw.vout ?? []).map((out) => ({
    addresses: out.scriptPubKey?.addresses ?? [],
    value: typeof out.value === 'number' ? out.value : 0,
  }));
  const vin: PushTxEntry[] = [];
  for (const input of raw.vin ?? []) {
    // Coinbase / unresolved inputs carry no prevout; they can't be ours.
    if (input.prevout) {
      vin.push({
        addresses: input.prevout.addresses ?? [],
        value: typeof input.prevout.value === 'number' ? input.prevout.value : 0,
      });
    }
  }
  return { vout, vin };
}

/**
 * Bounded retry for the tx read. A silent push (especially `incoming_pending`)
 * fires on mempool first-seen, so the Explorer node can briefly 5xx or return
 * `transaction: null` before it resolves the txid. A few short retries close
 * that propagation gap while staying well inside the OS's background-execution
 * budget.
 */
const MAX_TX_FETCH_ATTEMPTS = 3;
const TX_FETCH_BACKOFF_MS = 600;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Handle a silent push in production: sync the txid against the configured
 * server and post the composed local notification. Safe to call from the
 * notification-received listener / background task. Never throws — a failed
 * fetch just posts nothing (normal SPV sync reconciles on next app open).
 */
export async function handleIncomingPush(data: { txid: string; event: string }): Promise<void> {
  const settings = require('./notification-settings') as typeof import('./notification-settings');
  const notifications = require('./notifications') as typeof import('./notifications');
  const { useWalletStore, getActiveWalletAddresses } =
    require('../wallet/wallet-store') as typeof import('../wallet/wallet-store');
  const { normalizeServerUrl } =
    require('./notification-server') as typeof import('./notification-server');

  const handler = createPushHandler({
    fetchTransaction: async (txid) => {
      let url: string;
      try {
        const prefs = await settings.getNotificationPrefs();
        const base = normalizeServerUrl(prefs.serverUrl);
        const network = useWalletStore.getState().network;
        url = `${base}/api/transaction/${encodeURIComponent(txid)}?network=${network}`;
      } catch {
        return null;
      }

      // Retry on a transient failure / not-yet-resolved tx (propagation gap).
      for (let attempt = 0; attempt < MAX_TX_FETCH_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          await delay(TX_FETCH_BACKOFF_MS * attempt);
        }
        try {
          const response = await fetch(url);
          if (!response.ok) continue;
          const body: unknown = await response.json();
          if (body === null || typeof body !== 'object') continue;
          const raw = (body as { transaction?: unknown }).transaction;
          if (raw === null || typeof raw !== 'object') continue;
          return mapExplorerTransaction(raw as RawTransaction);
        } catch {
          // Network hiccup — retry within the attempt budget.
        }
      }
      return null;
    },
    getWalletAddresses: getActiveWalletAddresses,
    notifyReceived: notifications.scheduleReceivedNotification,
    notifySentConfirmed: notifications.scheduleSentConfirmedNotification,
  });

  await handler.handleIncomingPush(data);
}
