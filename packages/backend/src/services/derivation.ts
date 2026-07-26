import { HDKey } from "@scure/bip32";
import { publicKeyToAddress } from "@fairco.in/core";
import type { NetworkConfig } from "@fairco.in/core";

/**
 * Derive a per-intent FairCoin receive address from a merchant's **watch-only**
 * account xpub. Public-key-only by construction: `HDKey.fromExtendedKey` yields
 * a node that can spawn child public keys but never signs.
 *
 * The `if (node.privateKey) throw` guard is the non-custody legal firewall — if
 * a merchant ever hands us a private extended key (`xprv`), we refuse it rather
 * than silently gaining the ability to spend their funds.
 */
export function deriveIntentAddress(
  xpub: string,
  change: number,
  index: number,
  network: NetworkConfig,
): string {
  const node = assertWatchOnly(xpub, network);

  const child = node.deriveChild(change).deriveChild(index);
  if (!child.publicKey) {
    throw new Error("failed to derive public key from watch-only xpub");
  }

  return publicKeyToAddress(child.publicKey, network);
}

/**
 * Parse an extended key and REFUSE it if it can sign.
 *
 * The non-custody firewall, callable on its own. `deriveIntentAddress` runs it
 * before deriving, and `PUT /v1/wallet/me/xpub` runs it before STORING — a key
 * is accepted into this system at exactly one standard, and the check happens
 * at the boundary rather than at first use. A key that never gets derived from
 * would otherwise sit in the database unexamined.
 *
 * Throws, rather than returning a boolean, so a caller cannot forget to look:
 * an ignored `false` would be a silently custodial gateway.
 *
 * @returns the parsed watch-only node, so the caller that needs to derive does
 *   not parse the same key twice.
 */
export function assertWatchOnly(xpub: string, network: NetworkConfig): HDKey {
  const node = HDKey.fromExtendedKey(xpub, {
    public: network.bip32.public,
    private: network.bip32.private,
  });

  if (node.privateKey) {
    throw new Error(
      "watch-only violation: extended key carries a private key",
    );
  }

  return node;
}
