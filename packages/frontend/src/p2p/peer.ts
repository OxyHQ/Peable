/**
 * Single FairCoin P2P peer connection.
 *
 * Handles TCP framing, the version/verack handshake, and ping/pong keepalive.
 * Uses a pluggable SocketProvider so both React Native (react-native-tcp-socket)
 * and Electron (Node.js `net`) can supply the underlying transport.
 */

import type { NetworkConfig } from '@fairco.in/core';
import {
  type MessageHeader,
  type VersionPayload,
  HEADER_SIZE,
  MAX_MESSAGE_SIZE,
  buildMessage,
  ipv4ToMappedIPv6,
  parseHeader,
  parsePong,
  parseVersion,
  serializePing,
  serializeVersion,
} from './messages';

// ---------------------------------------------------------------------------
// Socket abstraction
// ---------------------------------------------------------------------------

export interface SocketConnection {
  onConnect(callback: () => void): void;
  onData(callback: (data: Uint8Array) => void): void;
  onClose(callback: () => void): void;
  onError(callback: (err: Error) => void): void;
  write(data: Uint8Array): void;
  destroy(): void;
}

export interface SocketProvider {
  connect(host: string, port: number): SocketConnection;
}

// ---------------------------------------------------------------------------
// Peer types
// ---------------------------------------------------------------------------

export type PeerState = 'disconnected' | 'connecting' | 'connected' | 'handshaking' | 'ready';

export interface PeerConfig {
  host: string;
  port: number;
  network: NetworkConfig;
}

export interface PeerEvents {
  onReady: (peer: Peer) => void;
  onMessage: (peer: Peer, command: string, payload: Uint8Array) => void;
  onDisconnect: (peer: Peer, reason: string) => void;
  onError: (peer: Peer, error: Error) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_AGENT = '/FAIRWallet:1.0.0/';

// Service flag advertised by peers in their `version` message. The wallet is
// an SPV client and depends on the `filterload` / `filteradd` / `filterclear`
// commands: FairCoin core (Dash-derived) hard-disconnects (and applies a
// Misbehaving(100) ban) any peer that sends `filterload` to a node which has
// not advertised NODE_BLOOM. We therefore refuse to use peers missing this
// flag — without that check the wallet sends `filterload` blindly and gets
// banned by the very seeds it depends on.
const NODE_NETWORK = 1n;
const NODE_BLOOM = 1n << 2n;
/**
 * Mask of services the wallet REQUIRES a peer to advertise before we will
 * use it for SPV (header sync + bloom-filtered merkle blocks + tx broadcast).
 * Exported so the peer manager can reason about it too.
 */
export const REQUIRED_PEER_SERVICES = NODE_NETWORK | NODE_BLOOM;

const PING_INTERVAL_MS = 120_000; // 2 minutes
const HANDSHAKE_TIMEOUT_MS = 30_000; // 30 seconds

// ---------------------------------------------------------------------------
// Peer
// ---------------------------------------------------------------------------

export class Peer {
  readonly host: string;
  readonly port: number;

  private readonly network: NetworkConfig;
  private readonly events: PeerEvents;
  private readonly socketProvider: SocketProvider;
  private readonly magic: Uint8Array;

  private socket: SocketConnection | undefined;
  private recvBuffer: Uint8Array = new Uint8Array(0);
  private _state: PeerState = 'disconnected';
  private _bestHeight = 0;
  private _services = 0n;
  private _userAgent = '';
  private _versionNonce = 0n;

  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPingNonce = 0n;
  private versionReceived = false;
  private verackReceived = false;

  constructor(config: PeerConfig, events: PeerEvents, socketProvider: SocketProvider) {
    this.host = config.host;
    this.port = config.port;
    this.network = config.network;
    this.events = events;
    this.socketProvider = socketProvider;

    this.magic = new Uint8Array(config.network.magicBytes);
  }

  // -----------------------------------------------------------------------
  // Public accessors
  // -----------------------------------------------------------------------

  get state(): PeerState {
    return this._state;
  }

  get bestHeight(): number {
    return this._bestHeight;
  }

  get services(): bigint {
    return this._services;
  }

  get userAgent(): string {
    return this._userAgent;
  }

  get id(): string {
    return `${this.host}:${this.port}`;
  }

  // -----------------------------------------------------------------------
  // Connection lifecycle
  // -----------------------------------------------------------------------

  connect(): void {
    if (this._state !== 'disconnected') {
      return;
    }

    this._state = 'connecting';
    this.recvBuffer = new Uint8Array(0);
    this.versionReceived = false;
    this.verackReceived = false;

    try {
      this.socket = this.socketProvider.connect(this.host, this.port);
    } catch (err) {
      this._state = 'disconnected';
      this.events.onError(this, err instanceof Error ? err : new Error(String(err)));
      return;
    }

    this.socket.onConnect(() => {
      this._state = 'connected';
      this.startHandshake();
    });

    this.socket.onData((data: Uint8Array) => {
      this.onSocketData(data);
    });

    this.socket.onClose(() => {
      this.handleDisconnect('connection closed');
    });

    this.socket.onError((err: Error) => {
      this.events.onError(this, err);
      this.handleDisconnect(`error: ${err.message}`);
    });
  }

  disconnect(): void {
    this.cleanup();
    if (this.socket) {
      this.socket.destroy();
      this.socket = undefined;
    }
    this._state = 'disconnected';
  }

  // -----------------------------------------------------------------------
  // Sending messages
  // -----------------------------------------------------------------------

  sendMessage(command: string, payload: Uint8Array): void {
    if (this._state === 'disconnected' || this._state === 'connecting') {
      return;
    }
    if (!this.socket) {
      return;
    }
    const message = buildMessage(command, payload, this.magic);
    this.socket.write(message);
  }

  // -----------------------------------------------------------------------
  // Handshake
  // -----------------------------------------------------------------------

  private startHandshake(): void {
    this._state = 'handshaking';

    // Generate a random nonce for our version message
    const nonceBytes = new Uint8Array(8);
    crypto.getRandomValues(nonceBytes);
    const view = new DataView(nonceBytes.buffer, nonceBytes.byteOffset, nonceBytes.byteLength);
    this._versionNonce = view.getBigUint64(0, true);

    const now = BigInt(Math.floor(Date.now() / 1000));
    const zeroAddr = new Uint8Array(16);

    const versionPayload: VersionPayload = {
      version: this.network.protocolVersion,
      services: NODE_NETWORK,
      timestamp: now,
      addrRecv: {
        services: NODE_NETWORK,
        ip: ipv4ToMappedIPv6(this.host),
        port: this.port,
      },
      addrFrom: {
        services: NODE_NETWORK,
        ip: zeroAddr,
        port: 0,
      },
      nonce: this._versionNonce,
      userAgent: USER_AGENT,
      startHeight: 0,
      relay: true,
    };

    const payload = serializeVersion(versionPayload);
    this.sendMessage('version', payload);

    // Set handshake timeout
    this.handshakeTimer = setTimeout(() => {
      if (this._state === 'handshaking') {
        this.handleDisconnect('handshake timeout');
      }
    }, HANDSHAKE_TIMEOUT_MS);
  }

  private checkHandshakeComplete(): void {
    if (this.versionReceived && this.verackReceived && this._state === 'handshaking') {
      if (this.handshakeTimer !== undefined) {
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = undefined;
      }

      // Gate: refuse to use a peer that did not advertise NODE_BLOOM. The
      // wallet is SPV and relies on `filterload` / `filteradd` /
      // `filterclear`; FairCoin core (Dash-derived) applies Misbehaving(100)
      // — an outright ban — to any peer that sends those messages without
      // having NODE_BLOOM advertised on the other side. If we let such a
      // peer transition to "ready" the SPV client would dutifully send
      // `filterload`, get us banned, and burn the IP for future
      // reconnections. Disconnect cleanly here and let peer-manager pick
      // another candidate from `knownAddresses`.
      if ((this._services & REQUIRED_PEER_SERVICES) !== REQUIRED_PEER_SERVICES) {
        this.handleDisconnect('peer does not advertise NODE_BLOOM');
        return;
      }

      this._state = 'ready';
      this.startPingTimer();
      this.events.onReady(this);
    }
  }

  // -----------------------------------------------------------------------
  // Data reception and message parsing
  // -----------------------------------------------------------------------

  private onSocketData(data: Uint8Array): void {
    // Append to buffer
    const combined = new Uint8Array(this.recvBuffer.length + data.length);
    combined.set(this.recvBuffer, 0);
    combined.set(data, this.recvBuffer.length);
    this.recvBuffer = combined;

    // Try to extract complete messages
    this.processBuffer();
  }

  private processBuffer(): void {
    while (this.recvBuffer.length >= HEADER_SIZE) {
      let header: MessageHeader;
      try {
        header = parseHeader(this.recvBuffer);
      } catch {
        this.handleDisconnect('malformed header');
        return;
      }

      // Validate magic
      if (!this.magicMatches(header.magic)) {
        this.handleDisconnect('magic mismatch');
        return;
      }

      // Guard against oversized messages
      if (header.payloadSize > MAX_MESSAGE_SIZE) {
        this.handleDisconnect('message too large');
        return;
      }

      const totalSize = HEADER_SIZE + header.payloadSize;
      if (this.recvBuffer.length < totalSize) {
        // Incomplete message, wait for more data
        break;
      }

      // Extract payload
      const payload = this.recvBuffer.slice(HEADER_SIZE, totalSize);

      // Advance buffer
      this.recvBuffer = this.recvBuffer.slice(totalSize);

      // Dispatch
      this.handleMessage(header.command, payload);
    }
  }

  private magicMatches(received: Uint8Array): boolean {
    for (let i = 0; i < 4; i++) {
      if (received[i] !== this.magic[i]) {
        return false;
      }
    }
    return true;
  }

  // -----------------------------------------------------------------------
  // Message dispatch
  // -----------------------------------------------------------------------

  private handleMessage(command: string, payload: Uint8Array): void {
    switch (command) {
      case 'version':
        this.handleVersion(payload);
        break;
      case 'verack':
        this.handleVerack();
        break;
      case 'ping':
        this.handlePing(payload);
        break;
      case 'pong':
        this.handlePongMessage(payload);
        break;
      default:
        // Forward all other messages to the events handler
        if (this._state === 'ready') {
          this.events.onMessage(this, command, payload);
        }
        break;
    }
  }

  private handleVersion(payload: Uint8Array): void {
    try {
      const version = parseVersion(payload);
      this._bestHeight = version.startHeight;
      this._services = version.services;
      this._userAgent = version.userAgent;
      this.versionReceived = true;

      // Send verack in response
      this.sendMessage('verack', new Uint8Array(0));
      this.checkHandshakeComplete();
    } catch (err) {
      this.events.onError(this, err instanceof Error ? err : new Error(String(err)));
      this.handleDisconnect('invalid version message');
    }
  }

  private handleVerack(): void {
    this.verackReceived = true;
    this.checkHandshakeComplete();
  }

  private handlePing(payload: Uint8Array): void {
    // Reply with pong using the same nonce
    this.sendMessage('pong', payload);
  }

  private handlePongMessage(payload: Uint8Array): void {
    let nonce: bigint;
    try {
      nonce = parsePong(payload);
    } catch {
      // Malformed pong is non-fatal — the connection remains valid.
      // The peer simply sent an unparseable response to our ping.
      return;
    }
    // A correctly-behaving peer echoes the exact nonce we sent. A mismatch means
    // the peer is buggy or replaying stale frames; surface it and drop the peer
    // rather than trusting its keepalive (review finding L6).
    if (nonce !== this.lastPingNonce) {
      this.events.onError(
        this,
        new Error(`pong nonce mismatch (expected ${this.lastPingNonce}, got ${nonce})`),
      );
      this.handleDisconnect('pong nonce mismatch');
    }
  }

  // -----------------------------------------------------------------------
  // Keepalive
  // -----------------------------------------------------------------------

  private startPingTimer(): void {
    this.pingTimer = setInterval(() => {
      if (this._state !== 'ready') {
        return;
      }
      const nonceBytes = new Uint8Array(8);
      crypto.getRandomValues(nonceBytes);
      const view = new DataView(nonceBytes.buffer, nonceBytes.byteOffset, nonceBytes.byteLength);
      this.lastPingNonce = view.getBigUint64(0, true);
      this.sendMessage('ping', serializePing(this.lastPingNonce));
    }, PING_INTERVAL_MS);
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  private cleanup(): void {
    if (this.pingTimer !== undefined) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    if (this.handshakeTimer !== undefined) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
  }

  private handleDisconnect(reason: string): void {
    if (this._state === 'disconnected') {
      return;
    }
    this.cleanup();
    if (this.socket) {
      this.socket.destroy();
      this.socket = undefined;
    }
    this._state = 'disconnected';
    this.events.onDisconnect(this, reason);
  }
}
