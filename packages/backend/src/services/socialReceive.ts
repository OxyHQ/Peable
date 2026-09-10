import { getNetwork, hexToBytes, deriveSocialReceiveAddress } from "@fairco.in/core";
import type { NetworkType } from "@fairco.in/core";
import { oxyClient } from "@oxy.so/core";
import { getDb } from "../db/postgres";
import {
  readReservedThrough,
  reserveNextSocialReceiveIndex,
} from "../db/social/receiveCursor";

/**
 * First index this reservation flow ever hands out. Index 0 is the
 * recipient's stable default/favourite address — computed on-device from the
 * identity key, never reserved through the backend (spec §4.3).
 *
 * Stated here as well as in `db/schema/social.ts`, which is where the CHECK
 * constraints are derived from. The two are pinned equal by
 * `db/__tests__/socialReceiveCursor.realdb.test.ts` — a service that disagreed
 * with the constraint would be refused by the database rather than silently
 * handing out index 0.
 */
export const SOCIAL_RECEIVE_FIRST_FRESH_INDEX = 1;

const SECP256K1_VERIFICATION_METHOD_TYPE = "EcdsaSecp256k1VerificationKey2019";

/**
 * Resolve `oxyUserId`'s identity secp256k1 public key from their DID document
 * (`GET /u/:userId/did.json`, public — no auth). Returns `null` for a
 * KEYLESS (custodial) account: no `identity` auth method, hence no
 * `EcdsaSecp256k1VerificationKey2019` verification method to derive from.
 */
export async function resolveIdentityPublicKey(
  oxyUserId: string,
): Promise<Uint8Array | null> {
  const doc = await oxyClient.resolveDid(oxyUserId);
  const vm = doc.verificationMethod.find(
    (entry) => entry.type === SECP256K1_VERIFICATION_METHOD_TYPE,
  );
  if (!vm || !("publicKeyHex" in vm)) {
    return null;
  }
  return hexToBytes(vm.publicKeyHex);
}

/**
 * Atomically claim the next unused social-receive index for `oxyUserId` and
 * derive its FairCoin address — the user-identity equivalent of
 * `reserveNextAddress` (merchant flow), reusing the SAME public-only
 * derivation primitive (`deriveSocialReceiveAddress`, published from
 * `@fairco.in/core`). The backend only ever handles the recipient's PUBLIC
 * identity key; it never sees or stores a private key.
 *
 * Returns `null` when the recipient is keyless (no identity key to derive
 * from) — callers surface the "invite them to set up Peable" flow (spec
 * §4.5) instead of a send.
 *
 * Lazily creates the per-user cursor on first use (no merchant-style
 * pre-registration exists for an ordinary user). The create and the claim are
 * ONE statement — `INSERT … ON CONFLICT DO UPDATE`, in
 * `db/social/receiveCursor.ts` — so two concurrent first payments converge on
 * the unique index rather than racing between a create and a separate
 * increment. There is no "the cursor vanished" branch to get wrong any more,
 * because there is no window in which it could vanish.
 */
export async function reserveNextSocialAddress(
  oxyUserId: string,
  network: NetworkType,
): Promise<{ index: number; address: string } | null> {
  const identityPublicKey = await resolveIdentityPublicKey(oxyUserId);
  if (!identityPublicKey) {
    return null;
  }

  const index = await reserveNextSocialReceiveIndex(getDb(), oxyUserId, network);
  const address = deriveSocialReceiveAddress(identityPublicKey, index, getNetwork(network));
  return { index, address };
}

/**
 * Read-only counterpart to {@link reserveNextSocialAddress}: the highest
 * social-receive index EVER reserved for `oxyUserId` on `network`, without
 * reserving another one. Backs `GET /v1/social/me/cursor` (cursor-sync fix
 * for the silent-desync finding — see `SocialReceiveCursorResponse`).
 *
 * `social_receive_cursors.next_derivation_index` always holds the NEXT index
 * this user's cursor will hand out (post-increment value, per
 * `reserveNextSocialAddress`'s claim above), so the highest index already
 * reserved is one less than that. `0` when no cursor exists yet (the user has
 * never had an address reserved on this network).
 */
export async function getReservedThrough(
  oxyUserId: string,
  network: NetworkType,
): Promise<number> {
  return readReservedThrough(getDb(), oxyUserId, network);
}
