import { describe, expect, it } from 'bun:test';
import { HDKey } from '@scure/bip32';
import { MAX_SOCIAL_RECEIVE_INDEX, deriveSocialReceiveAddress, getNetwork } from '@fairco.in/core';
import { MAX_DERIVATION_INDEX } from '../schema/valueSets';

/**
 * `integer` is the right column type for both derivation counters ONLY while
 * the derivable index space fits in it. That is true today — and it is a
 * property of two packages this repository does not own, so it is pinned here
 * rather than remembered.
 *
 * Were the space to widen, `integer` would silently start REFUSING legal
 * indices: a merchant would stop being able to take payments at a point nobody
 * chose, with a `22003` naming a column rather than the reason. Were it to
 * narrow, the column would accept an index that cannot be derived at all.
 *
 * No database needed, so this always runs — including for a developer with no
 * container, which is the audience most likely to change a column type.
 */

/** `@scure/bip32`'s hardened boundary. Every index at or above it needs a private key. */
const HARDENED_OFFSET = 0x80000000;

describe('the derivation index bound', () => {
  it("is exactly int4's ceiling", () => {
    expect(MAX_DERIVATION_INDEX).toBe(2 ** 31 - 1);
  });

  it('agrees with the social-receive scheme, which enforces its own bound', () => {
    expect(MAX_DERIVATION_INDEX).toBe(MAX_SOCIAL_RECEIVE_INDEX);
    expect(MAX_SOCIAL_RECEIVE_INDEX).toBe(HARDENED_OFFSET - 1);
  });

  /**
   * The bound is REAL on the social path — asserted by crossing it, not by
   * reading the constant that defines it. Comparing `MAX_SOCIAL_RECEIVE_INDEX`
   * against itself would pass however the scheme behaved.
   */
  it('refuses a hardened index on the social path', () => {
    const identityPublicKey = new HDKey({
      privateKey: new Uint8Array(32).fill(7),
      depth: 0,
    }).publicKey;
    expect(identityPublicKey).not.toBeNull();

    const network = getNetwork('testnet');
    // One below the boundary derives; the boundary itself does not.
    expect(
      typeof deriveSocialReceiveAddress(identityPublicKey!, MAX_DERIVATION_INDEX, network),
    ).toBe('string');
    expect(() =>
      deriveSocialReceiveAddress(identityPublicKey!, HARDENED_OFFSET, network),
    ).toThrow();
  });

  /**
   * And on the merchant path, where nothing checks the index explicitly: the
   * node is public-only by construction (`deriveIntentAddress` refuses an
   * extended key carrying a private key), and `@scure/bip32` cannot derive a
   * hardened child without one. The refusal comes from the cryptography, so it
   * cannot be removed by editing this repository.
   */
  it('cannot derive a hardened child from a watch-only node', () => {
    // A chain code is required for ANY derivation, hardened or not — without
    // one `deriveChild` throws "No publicKey or chainCode set", which would
    // make both assertions below pass for the wrong reason.
    const publicOnly = new HDKey({
      privateKey: new Uint8Array(32).fill(9),
      chainCode: new Uint8Array(32).fill(3),
      depth: 0,
    }).wipePrivateData();
    expect(publicOnly.privateKey).toBeNull();

    expect(() => publicOnly.deriveChild(MAX_DERIVATION_INDEX)).not.toThrow();
    expect(() => publicOnly.deriveChild(HARDENED_OFFSET)).toThrow(
      'Could not derive hardened child key',
    );
  });
});
