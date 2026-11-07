/**
 * Which key an identity wallet opens with (security review round 5, R5-1):
 * one the account vouches for, proven held by a selected derivation — never
 * the device's unselected key, which another Oxy app could have planted.
 */
import { describe, expect, test } from 'bun:test';
import { bytesToHex, hexToBytes } from '@fairco.in/core';
import { getPublicKey } from '@noble/secp256k1';
import { decideIdentityKey, type IdentityKeyDeps } from './identity-key';

const pub = (secret: string): string => bytesToHex(getPublicKey(hexToBytes(secret), true));
const pubUncompressed = (secret: string): string =>
  bytesToHex(getPublicKey(hexToBytes(secret), false));
const CURRENT = pub('11'.repeat(32));
const OLD = pub('22'.repeat(32));
const PLANTED = pub('33'.repeat(32));

/** A device holding `held`: a selected derivation answers only for those keys. */
function deps(
  held: readonly string[],
  overrides: Partial<IdentityKeyDeps> = {},
): IdentityKeyDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    accountKeys: { current: CURRENT, history: new Set([CURRENT, OLD]) },
    storedKey: null,
    deviceHint: async () => null,
    derive: async (key) => {
      asked.push(key);
      return held.includes(key) ? new Uint8Array(32).fill(1) : null;
    },
    ...overrides,
    asked,
  };
}

describe('decideIdentityKey', () => {
  test("opens the account's current key when this device holds it, whatever its encoding", async () => {
    const decision = await decideIdentityKey(
      deps([CURRENT], {
        accountKeys: {
          current: pubUncompressed('11'.repeat(32)),
          history: new Set([CURRENT]),
        },
      }),
    );
    expect(decision).toMatchObject({ kind: 'current', key: CURRENT });
  });

  test('a key planted in the shared keychain group never opens (R5-1)', async () => {
    // The device "holds" the planted key and says so; the account never had it.
    const d = deps([PLANTED], { deviceHint: async () => PLANTED });
    const decision = await decideIdentityKey(d);
    expect(decision).toEqual({ kind: 'none', reason: 'not-held' });
    expect(d.asked).not.toContain(PLANTED);
  });

  test('a stored key the account no longer names never opens', async () => {
    const decision = await decideIdentityKey(deps([PLANTED], { storedKey: PLANTED }));
    expect(decision).toEqual({ kind: 'none', reason: 'not-held' });
  });

  test('a replaced key this device holds opens, held — receivable never', async () => {
    const stored = await decideIdentityKey(deps([OLD], { storedKey: OLD }));
    expect(stored).toMatchObject({ kind: 'held', key: OLD, reason: 'replaced' });
    const hinted = await decideIdentityKey(deps([OLD], { deviceHint: async () => OLD }));
    expect(hinted).toMatchObject({ kind: 'held', key: OLD, reason: 'replaced' });
  });

  test('offline: only the key this wallet stored opens', async () => {
    const offline = await decideIdentityKey(
      deps([CURRENT], { accountKeys: null, storedKey: CURRENT, deviceHint: async () => PLANTED }),
    );
    expect(offline).toMatchObject({ kind: 'held', key: CURRENT, reason: 'offline' });
    const nothingStored = await decideIdentityKey(
      deps([CURRENT, PLANTED], { accountKeys: null, deviceHint: async () => PLANTED }),
    );
    expect(nothingStored).toEqual({ kind: 'none', reason: 'unverified' });
  });

  describe('a key that cannot be read now (core 7.40.0, R7-4) is "try again"', () => {
    /** Core's `IdentityUnavailableError`, matched by name across bundled copies. */
    const unavailable = (): Error =>
      Object.assign(new Error('The identity slots cannot be read right now.'), {
        name: 'IdentityUnavailableError',
      });
    /** A device holding `held`, whose keychain cannot be read for `locked`. */
    const lockedFor =
      (locked: readonly string[], held: readonly string[]) => async (key: string) => {
        if (locked.includes(key)) throw unavailable();
        return held.includes(key) ? new Uint8Array(32).fill(1) : null;
      };

    test('the current key locked: unavailable, never not-held (no "set up your Oxy ID")', async () => {
      const decision = await decideIdentityKey(deps([], { derive: lockedFor([CURRENT], []) }));
      expect(decision).toEqual({ kind: 'none', reason: 'unavailable' });
    });

    test('the current key locked: a held previous key is NEVER opened as replaced', async () => {
      // The person rotated on this phone and it keeps OLD in its ring; opening
      // OLD as `replaced` would switch social receive off for a locked keychain.
      const d = deps([OLD], { storedKey: OLD, derive: lockedFor([CURRENT], [OLD]) });
      const decision = await decideIdentityKey(d);
      expect(decision).toEqual({ kind: 'none', reason: 'unavailable' });
      expect(d.asked).toEqual([]);
    });

    test('any throw counts: only null is definitive', async () => {
      const decision = await decideIdentityKey(
        deps([], {
          derive: async () => {
            throw new Error('Commons is gone');
          },
        }),
      );
      expect(decision).toEqual({ kind: 'none', reason: 'unavailable' });
    });

    test('offline with the stored key locked: unavailable, never not-held', async () => {
      const decision = await decideIdentityKey(
        deps([], { accountKeys: null, storedKey: CURRENT, derive: lockedFor([CURRENT], []) }),
      );
      expect(decision).toEqual({ kind: 'none', reason: 'unavailable' });
    });

    test('a stored previous key locked after the current one is definitively absent', async () => {
      const decision = await decideIdentityKey(
        deps([], { storedKey: OLD, derive: lockedFor([OLD], []) }),
      );
      expect(decision).toEqual({ kind: 'none', reason: 'unavailable' });
    });

    test('a device hint that cannot be read is no answer either', async () => {
      const decision = await decideIdentityKey(
        deps([], {
          deviceHint: async () => {
            throw unavailable();
          },
        }),
      );
      expect(decision).toEqual({ kind: 'none', reason: 'unavailable' });
    });

    test('once the keychain opens, the same device opens its current key', async () => {
      let locked = true;
      const derive = async (key: string) => {
        if (locked) throw unavailable();
        return key === CURRENT ? new Uint8Array(32).fill(1) : null;
      };
      expect(await decideIdentityKey(deps([], { derive }))).toEqual({
        kind: 'none',
        reason: 'unavailable',
      });
      locked = false;
      expect(await decideIdentityKey(deps([], { derive }))).toMatchObject({
        kind: 'current',
        key: CURRENT,
      });
    });
  });
});
