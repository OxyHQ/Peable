/**
 * Tests for the known-peer cache feed (`SPVClientEvents.onPeerReady`).
 *
 * The `peers` table exists and the wallet reads it on boot
 * (`initialKnownAddresses`), but nothing ever wrote a discovered node into it:
 * `insertPeer` was only reachable from the manual "Add Peer" screen. On a real
 * device the table was empty, so every cold start had to resolve the DNS seeds
 * before it could dial anything — and a seed outage meant no peers at all.
 *
 * `onPeerReady` closes that loop: it fires for each node that completed the
 * version handshake AND passed the NODE_BLOOM gate, which is exactly the set
 * worth remembering. These tests pin that contract:
 *
 *   - A peer that reaches ready is reported once, with its host/port/services.
 *   - A peer rejected by the NODE_BLOOM gate is never reported, so the cache
 *     can't fill up with nodes that would get us banned on reconnect.
 */

import { describe, test, expect } from "bun:test";
import { Peer, type SocketConnection, type SocketProvider } from "./peer";
import type { ReadyPeerInfo } from "./spv-client";
import {
  buildMessage,
  serializeVersion,
  type VersionPayload,
} from "./messages";
import { getNetwork } from "@fairco.in/core";

const NODE_NETWORK = 1n;
const NODE_BLOOM = 1n << 2n;

class FakeSocket implements SocketConnection {
  private connectCb: (() => void) | undefined;
  private dataCb: ((data: Uint8Array) => void) | undefined;

  onConnect(cb: () => void): void {
    this.connectCb = cb;
  }
  onData(cb: (data: Uint8Array) => void): void {
    this.dataCb = cb;
  }
  onClose(_cb: () => void): void {
    /* not exercised */
  }
  onError(_cb: (err: Error) => void): void {
    /* not exercised */
  }
  write(_data: Uint8Array): void {
    /* the handshake bytes we send are not under test here */
  }
  destroy(): void {
    /* Peer.disconnect() already did its own bookkeeping */
  }

  fireConnect(): void {
    this.connectCb?.();
  }
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

function makeVersionFrame(
  network: ReturnType<typeof getNetwork>,
  services: bigint,
): Uint8Array {
  const payload: VersionPayload = {
    version: network.protocolVersion,
    services,
    timestamp: 1_700_000_000n,
    addrRecv: { services, ip: new Uint8Array(16), port: 0 },
    addrFrom: { services, ip: new Uint8Array(16), port: 0 },
    nonce: 0x1234_5678_9abc_def0n,
    userAgent: "/FakePeer:0.0.1/",
    startHeight: 100,
    relay: true,
  };
  return buildMessage(
    "version",
    serializeVersion(payload),
    new Uint8Array(network.magicBytes),
  );
}

function makeVerackFrame(network: ReturnType<typeof getNetwork>): Uint8Array {
  return buildMessage(
    "verack",
    new Uint8Array(0),
    new Uint8Array(network.magicBytes),
  );
}

/**
 * Drive a peer through the handshake with the same `onReady` → `onPeerReady`
 * bridge the SPV client installs, and collect what the cache would be told.
 */
function collectCachedPeers(remoteServices: bigint): ReadyPeerInfo[] {
  const network = getNetwork("mainnet");
  const provider = new FakeSocketProvider();
  const cached: ReadyPeerInfo[] = [];

  const peer = new Peer(
    { host: "203.0.113.7", port: network.p2pPort, network },
    {
      onReady: (p) => {
        cached.push({ host: p.host, port: p.port, services: p.services });
      },
      onMessage: () => {
        /* not exercised */
      },
      onDisconnect: () => {
        /* not exercised */
      },
      onError: () => {
        /* not exercised */
      },
    },
    provider,
  );

  peer.connect();
  const sock = provider.sockets[0];
  sock.fireConnect();
  sock.feed(makeVersionFrame(network, remoteServices));
  sock.feed(makeVerackFrame(network));

  return cached;
}

describe("known-peer cache feed", () => {
  test("a peer that reaches ready is reported once with host/port/services", () => {
    const network = getNetwork("mainnet");
    const cached = collectCachedPeers(NODE_NETWORK | NODE_BLOOM);

    expect(cached).toHaveLength(1);
    expect(cached[0].host).toBe("203.0.113.7");
    expect(cached[0].port).toBe(network.p2pPort);
    expect(cached[0].services & NODE_BLOOM).toBe(NODE_BLOOM);
  });

  test("services survive the bigint → number conversion the DB column uses", () => {
    const cached = collectCachedPeers(NODE_NETWORK | NODE_BLOOM);
    const stored = Number(cached[0].services);

    expect(Number.isSafeInteger(stored)).toBe(true);
    expect(BigInt(stored)).toBe(cached[0].services);
  });

  test("a peer rejected by the NODE_BLOOM gate is never cached", () => {
    expect(collectCachedPeers(NODE_NETWORK)).toHaveLength(0);
  });
});
