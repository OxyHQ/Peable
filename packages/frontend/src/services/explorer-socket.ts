/**
 * Explorer realtime WebSocket client (singleton).
 *
 * Holds a single connection to the Explorer's `/api/ws` channel and keeps the
 * TanStack Query cache live: when the chain tip advances it patches the new
 * block height straight into `["networkStats", network]` and invalidates that
 * query so the canonical stats (supply / masternode count / height) refresh from
 * `/api/stats` — no polling required for the network section.
 *
 * The connection is resilient and self-healing: exponential-backoff reconnects,
 * an application-level ping/pong heartbeat with a staleness watchdog, and it is
 * a safe no-op whenever the socket can't be opened. Frame validation lives in
 * `explorer-events.ts`; this module owns only the connection lifecycle.
 *
 * Lifecycle is driven by `useExplorerRealtime` (foreground-gated). Nothing here
 * runs until `start()` is called, so importing this module has no side effects.
 */

import { EXPLORER_BASE_URL, type NetworkType } from '@fairco.in/core';
import { queryClient } from './query-client';
import { type NetworkStats } from './market';
import {
  SUBSCRIBED_EVENTS,
  parseTipUpdate,
  parseServerError,
  type TipUpdate,
} from './explorer-events';

/** Explorer WS endpoint, derived from the HTTP base (http→ws, https→wss). */
const WS_URL = `${EXPLORER_BASE_URL.replace(/^http/, 'ws')}/api/ws`;

/** How often to send an application ping while connected. */
const HEARTBEAT_MS = 25_000;
/** No inbound frame for this long ⇒ treat the socket as dead and reconnect. */
const STALE_TIMEOUT_MS = 60_000;
const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

type OutgoingMessage =
  | { type: 'subscribe'; network: NetworkType; events: readonly string[] }
  | { type: 'change-network'; network: NetworkType }
  | { type: 'ping'; network: NetworkType };

class ExplorerSocketController {
  private ws: WebSocket | null = null;
  private network: NetworkType = 'mainnet';
  private started = false;
  private reconnectDelay = INITIAL_RECONNECT_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt = 0;

  /** Open the socket for `network` (idempotent; realigns network if running). */
  start(network: NetworkType): void {
    if (this.started) {
      this.setNetwork(network);
      return;
    }
    this.started = true;
    this.network = network;
    this.connect();
  }

  /** Point the live connection at a different network. No-op if unchanged. */
  setNetwork(network: NetworkType): void {
    if (network === this.network) return;
    this.network = network;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Move the server-side connection and re-assert our subscriptions; the
      // Explorer filters broadcasts by the connection's current network.
      this.send({ type: 'change-network', network });
      this.sendSubscribe();
    }
  }

  /** Close the socket and stop all reconnect/heartbeat timers. */
  stop(): void {
    this.started = false;
    this.clearTimers();
    const ws = this.ws;
    if (ws) {
      this.detach(ws);
      this.ws = null;
      ws.close(1000, 'client stop');
    }
    this.reconnectDelay = INITIAL_RECONNECT_MS;
  }

  private connect(): void {
    if (!this.started) return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(WS_URL);
    } catch {
      // Construction failed (e.g. WebSocket unavailable) — retry with backoff.
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = INITIAL_RECONNECT_MS;
      this.lastActivityAt = Date.now();
      // Align the connection's network, then subscribe to the events we act on.
      this.send({ type: 'change-network', network: this.network });
      this.sendSubscribe();
      this.startHeartbeat();
    };

    ws.onmessage = (event: MessageEvent) => {
      this.lastActivityAt = Date.now();
      this.handleMessage(event.data);
    };

    ws.onerror = () => {
      // RN/browsers fire `error` then `close`; reconnection is driven by
      // `onclose`, so there's nothing to do here but avoid throwing.
    };

    ws.onclose = () => {
      this.clearHeartbeat();
      if (this.ws === ws) this.ws = null;
      if (this.started) this.scheduleReconnect();
    };
  }

  private handleMessage(payload: unknown): void {
    const raw = typeof payload === 'string' ? payload : null;
    if (raw === null) return;

    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      // Malformed frame from the public socket — drop it, never fatal.
      return;
    }

    const tip = parseTipUpdate(frame);
    if (tip) {
      if (tip.network === this.network) this.applyTip(tip);
      return;
    }

    const serverError = parseServerError(frame);
    if (serverError) {
      console.warn(`[explorer-socket] server error ${serverError.code}: ${serverError.message}`);
    }
    // Any other frame (ping/pong, subscribe acks, network-stats) needs no action.
  }

  private applyTip(tip: TipUpdate): void {
    const queryKey = ['networkStats', tip.network] as const;
    // Optimistically bump the height so the ticker advances the instant a block
    // lands; only patch an existing snapshot — never invent one before the first
    // HTTP load. The invalidate then pulls the canonical stats from /api/stats.
    queryClient.setQueryData<NetworkStats>(queryKey, (prev) =>
      prev ? { ...prev, blockHeight: tip.height } : prev,
    );
    void queryClient.invalidateQueries({ queryKey });
  }

  private send(message: OutgoingMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private sendSubscribe(): void {
    this.send({
      type: 'subscribe',
      network: this.network,
      events: SUBSCRIBED_EVENTS,
    });
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // Our pings always draw a pong, so a stretch with no inbound frame at all
      // means the link is gone (a dropped connection with no close event). Kill
      // it and let backoff reconnect.
      if (Date.now() - this.lastActivityAt > STALE_TIMEOUT_MS) {
        this.reconnectNow();
        return;
      }
      this.send({ type: 'ping', network: this.network });
    }, HEARTBEAT_MS);
  }

  private reconnectNow(): void {
    const ws = this.ws;
    if (ws) {
      this.detach(ws);
      this.ws = null;
      ws.close();
    }
    this.clearHeartbeat();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
      this.connect();
    }, delay);
  }

  private detach(ws: WebSocket): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearHeartbeat();
  }
}

/** App-wide Explorer realtime socket. Driven by `useExplorerRealtime`. */
export const explorerSocket = new ExplorerSocketController();
