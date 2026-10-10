/**
 * Tests for the NODE_BLOOM peer gate (NB-1).
 *
 * FairCoin core (Dash-derived) applies Misbehaving(100) — an outright
 * ban — to any peer that sends `filterload`, `filteradd`, or `filterclear`
 * without the recipient having NODE_BLOOM in its advertised services. The
 * wallet is SPV and ALWAYS sends `filterload` on connect, so a peer that
 * does not advertise NODE_BLOOM would get our IP banned the moment the SPV
 * client transitions it to "ready".
 *
 * These tests drive a {@link Peer} through a real version/verack handshake
 * with a stubbed socket and assert that:
 *
 *   - A peer that advertises NODE_NETWORK only (no NODE_BLOOM) is
 *     disconnected on handshake completion with a clear reason, and
 *     `onReady` is never invoked.
 *   - A peer that advertises NODE_NETWORK + NODE_BLOOM reaches "ready" and
 *     `onReady` is fired exactly once.
 */

import { describe, test, expect } from 'bun:test';
import { Peer, type SocketConnection, type SocketProvider } from './peer';
import { buildMessage, serializeVersion, type VersionPayload } from './messages';
import { getNetwork } from '@fairco.in/core';

const NODE_NETWORK = 1n;
const NODE_BLOOM = 1n << 2n;

/**
 * In-memory {@link SocketConnection} that records bytes written by the Peer
 * and lets the test inject inbound bytes by calling the registered onData
 * callback directly.
 */
class FakeSocket implements SocketConnection {
  readonly written: Uint8Array[] = [];
  private connectCb: (() => void) | undefined;
  private dataCb: ((data: Uint8Array) => void) | undefined;
  destroyed = false;

  onConnect(cb: () => void): void {
    this.connectCb = cb;
  }
  onData(cb: (data: Uint8Array) => void): void {
    this.dataCb = cb;
  }
  onClose(_cb: () => void): void {
    /* no test here emits `close` (see destroy below) */
  }
  onError(_cb: (err: Error) => void): void {
    /* no-op for these tests */
  }
  write(data: Uint8Array): void {
    this.written.push(data);
  }
  destroy(): void {
    this.destroyed = true;
    // Real Node sockets emit `close` asynchronously after `destroy()`, and
    // `Peer.disconnect()` already does the bookkeeping (state = "disconnected",
    // cleanup) before reaching us. Re-entering Peer here would loop forever
    // through handleDisconnect → cleanup → destroy.
  }

  /** Drive the connect callback synchronously in the test. */
  fireConnect(): void {
    this.connectCb?.();
  }
  /** Feed bytes to the peer as if they came from the remote side. */
  feed(data: Uint8Array): void {
    this.dataCb?.(data);
  }
}

class FakeSocketProvider implements SocketProvider {
  readonly sockets: FakeSocket[] = [];
  connect(_host: string, _port: number): SocketConnection {
    const sock = new FakeSocket();
    this.sockets.push(sock);
    return sock;
  }
}

function makeVersionFrame(network: ReturnType<typeof getNetwork>, services: bigint): Uint8Array {
  const payload: VersionPayload = {
    version: network.protocolVersion,
    services,
    timestamp: BigInt(Math.floor(Date.now() / 1000)),
    addrRecv: { services, ip: new Uint8Array(16), port: 0 },
    addrFrom: { services, ip: new Uint8Array(16), port: 0 },
    nonce: 0x1234_5678_9abc_def0n,
    userAgent: '/FakePeer:0.0.1/',
    startHeight: 100,
    relay: true,
  };
  return buildMessage('version', serializeVersion(payload), new Uint8Array(network.magicBytes));
}

function makeVerackFrame(network: ReturnType<typeof getNetwork>): Uint8Array {
  return buildMessage('verack', new Uint8Array(0), new Uint8Array(network.magicBytes));
}

interface DriveResult {
  readyCount: number;
  disconnectReasons: string[];
  socket: FakeSocket;
}

function driveHandshake(remoteServices: bigint): DriveResult {
  const network = getNetwork('mainnet');
  const provider = new FakeSocketProvider();
  let readyCount = 0;
  const disconnectReasons: string[] = [];

  const peer = new Peer(
    { host: '10.0.0.1', port: network.p2pPort, network },
    {
      onReady: () => {
        readyCount++;
      },
      onMessage: () => {
        /* not exercised */
      },
      onDisconnect: (_p, reason) => {
        disconnectReasons.push(reason);
      },
      onError: () => {
        /* not exercised */
      },
    },
    provider,
  );

  peer.connect();
  const sock = provider.sockets[0];
  // Drive the handshake: open the socket so Peer sends its own version, then
  // feed the remote version + verack so Peer's handshake completes.
  sock.fireConnect();
  sock.feed(makeVersionFrame(network, remoteServices));
  sock.feed(makeVerackFrame(network));

  return { readyCount, disconnectReasons, socket: sock };
}

describe('NB-1: NODE_BLOOM gate on the version handshake', () => {
  test('peer advertising only NODE_NETWORK is disconnected, never reaches ready', () => {
    const { readyCount, disconnectReasons, socket } = driveHandshake(NODE_NETWORK);
    expect(readyCount).toBe(0);
    expect(disconnectReasons.length).toBeGreaterThan(0);
    expect(disconnectReasons[0]).toContain('NODE_BLOOM');
    // The socket must be torn down so no further bytes leak through.
    expect(socket.destroyed).toBe(true);
  });

  test('peer advertising NODE_NETWORK + NODE_BLOOM transitions to ready', () => {
    const { readyCount, disconnectReasons } = driveHandshake(NODE_NETWORK | NODE_BLOOM);
    expect(readyCount).toBe(1);
    expect(disconnectReasons).toEqual([]);
  });

  test('peer advertising no services at all is disconnected', () => {
    const { readyCount, disconnectReasons } = driveHandshake(0n);
    expect(readyCount).toBe(0);
    expect(disconnectReasons[0]).toContain('NODE_BLOOM');
  });
});
