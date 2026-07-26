/**
 * Tests for single-peer send selection.
 *
 * The original implementation returned the first ready peer in insertion order,
 * every time. Two consequences, both observed live:
 *
 *  - One peer carried every `getblocks` of a sync for the lifetime of the app.
 *  - If that peer was behind, it answered with nothing, the sync loop read the
 *    lack of progress as "caught up", and the wallet sat 10,922 blocks behind
 *    the network while its UI said "Synced" — 187.33.154.215 was serving height
 *    25,110 against a network tip of 78,689.
 */

import { describe, test, expect } from "bun:test";
import { selectSendTarget, type SendCandidate } from "./peer-manager";

interface TestPeer extends SendCandidate {
  readonly id: string;
}

const peer = (id: string, bestHeight: number, state = "ready"): TestPeer => ({
  id,
  bestHeight,
  state,
});

describe("selectSendTarget", () => {
  test("returns undefined when no peer is ready", () => {
    expect(selectSendTarget([], 0, 0)).toBeUndefined();
    expect(
      selectSendTarget([peer("a", 100, "connecting")], 0, 0),
    ).toBeUndefined();
  });

  test("skips a peer that is behind the requested height", () => {
    const stale = peer("stale", 25_110);
    const current = peer("current", 78_689);

    const target = selectSendTarget([stale, current], 0, 67_768);

    expect(target?.peer.id).toBe("current");
  });

  test("never returns a stale peer, whatever the cursor", () => {
    const peers = [peer("stale", 25_110), peer("a", 78_689), peer("b", 78_700)];

    for (let cursor = 0; cursor < 10; cursor++) {
      expect(selectSendTarget(peers, cursor, 67_768)?.peer.id).not.toBe(
        "stale",
      );
    }
  });

  test("rotates across eligible peers instead of pinning the first", () => {
    const peers = [peer("a", 80_000), peer("b", 80_000), peer("c", 80_000)];

    const picked: string[] = [];
    let cursor = 0;
    for (let i = 0; i < 6; i++) {
      const target = selectSendTarget(peers, cursor, 1);
      if (!target) throw new Error("expected a target");
      picked.push(target.peer.id);
      cursor = target.nextCursor;
    }

    expect(picked).toEqual(["a", "b", "c", "a", "b", "c"]);
  });

  test("falls back to any ready peer when none are ahead", () => {
    // Non-sync traffic (a broadcast retry, a filterload) must still go out even
    // if every peer happens to be behind us.
    const peers = [peer("a", 10), peer("b", 20)];

    const target = selectSendTarget(peers, 0, 99_999);

    if (!target) throw new Error("expected a fallback target");
    expect(["a", "b"]).toContain(target.peer.id);
  });

  test("ignores peers that are not ready when rotating", () => {
    const peers = [
      peer("connecting", 90_000, "connecting"),
      peer("ready1", 90_000),
      peer("ready2", 90_000),
    ];

    const first = selectSendTarget(peers, 0, 1);
    const second = selectSendTarget(peers, first?.nextCursor ?? 0, 1);

    expect(first?.peer.id).toBe("ready1");
    expect(second?.peer.id).toBe("ready2");
  });
});
