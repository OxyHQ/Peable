import { bytesToHex, getNetwork, hexToBytes, deriveSocialReceiveAddress } from '@fairco.in/core';
import type { NetworkType } from '@fairco.in/core';
import type { DidDocument } from '@oxy.so/contracts';
import type { ServiceHttpClient } from '@oxy.so/core/server';
import type { SocialPaymentSource } from '@peable.to/shared-types';
import { oxy } from '../oxy';
import { getDb } from '../db/postgres';
import { lockRecipientPool } from '../db/payments/faircoinAddressPool';
import { readReservedThrough } from '../db/social/receiveCursor';
import {
  countAttributionsSince,
  findLatestAttributionForPair,
  insertSendAttribution,
} from '../db/social/sendAttribution';
import {
  addressUsage,
  FaircoinCapacityError,
  reserveFreshAddress,
  UNPAID_WINDOW_SECONDS,
} from './faircoin/addressPool';

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

const SECP256K1_VERIFICATION_METHOD_TYPE = 'EcdsaSecp256k1VerificationKey2019';

/**
 * Fragment of the account's OWN identity key in a DID document. Oxy emits it
 * first (`buildDidDocument`), then any additional linked-device keys.
 */
const ACCOUNT_KEY_FRAGMENT = '#key-1';

type IdentityKeyResolver = (oxyUserId: string) => Promise<Uint8Array | null>;
let identityKeyResolver: IdentityKeyResolver | null = null;

/**
 * Replace how identity keys are resolved (tests: a deterministic key per
 * account instead of a DID read); `null` restores the DID read. Answers the
 * previous resolver so a suite can put it back.
 */
export function useIdentityKeyResolver(
  next: IdentityKeyResolver | null,
): IdentityKeyResolver | null {
  const previous = identityKeyResolver;
  identityKeyResolver = next;
  return previous;
}

/** How a DID document is fetched: Oxy's own transport, or a suite's stand-in. */
export type DidTransport = (url: string, init: RequestInit) => Promise<Response>;
let didTransport: DidTransport | null = null;

/** Replace the DID document transport (tests); `null` restores Oxy's. Answers the previous one. */
export function useDidTransport(next: DidTransport | null): DidTransport | null {
  const previous = didTransport;
  didTransport = next;
  return previous;
}

/** Oxy did not answer the identity document (an outage, or an account it does not know). */
export class IdentityDocumentUnavailableError extends Error {
  constructor(oxyUserId: string, status: number | null) {
    super(
      `the identity document of ${oxyUserId} could not be read${status === null ? '' : ` (Oxy answered ${status})`}`,
    );
    this.name = 'IdentityDocumentUnavailableError';
  }
}

let didClient: ServiceHttpClient | null = null;

/**
 * Oxy's transport for a DID read: the workload-authenticated service client
 * (it is charged to Peable's credential, not to the fleet's shared address),
 * or — where this process has no workload identity, a developer's machine —
 * the same public, unauthenticated request. Neither has a response cache.
 */
const oxyDidTransport: DidTransport = async (url, init) => {
  try {
    didClient ??= oxy.createServiceClient({ baseURL: oxy.baseURL, audience: 'oxy-api' });
    return await didClient.fetch(url, init);
  } catch {
    // The DID document is public: the anonymous request reads the same bytes.
    return fetch(url, init);
  }
};

/**
 * Read `oxyUserId`'s DID document FRESH (ADR 0002, amended 2026-11-06).
 *
 * Not `oxy.identity.resolveDid`: the SDK caches that read for a minute, and a
 * reservation made from a cached document derives the address from a key the
 * recipient may have just replaced — and writes that key back onto the cursor,
 * switching off the rotated device's receive. The SDK offers no bypass, so this
 * is Peable's own request to the same public route, `cache: 'no-store'`, with
 * `Cache-Control: no-cache` asking anything in front of Oxy to revalidate
 * (Oxy serves the document `public, max-age=300`). The `#key-1` rule below is
 * unchanged.
 *
 * @throws {IdentityDocumentUnavailableError}
 */
async function fetchDidDocument(oxyUserId: string): Promise<DidDocument> {
  const url = new URL(`/u/${encodeURIComponent(oxyUserId)}/did.json`, oxy.baseURL).toString();
  let response: Response;
  try {
    response = await (didTransport ?? oxyDidTransport)(url, {
      method: 'GET',
      cache: 'no-store',
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    });
  } catch {
    throw new IdentityDocumentUnavailableError(oxyUserId, null);
  }
  if (!response.ok) throw new IdentityDocumentUnavailableError(oxyUserId, response.status);
  return (await response.json()) as DidDocument;
}

/**
 * Resolve `oxyUserId`'s identity secp256k1 public key from their DID document
 * (`GET /u/:userId/did.json`, public — no auth), read FRESH on every call (see
 * {@link fetchDidDocument}). Returns `null` for a KEYLESS (custodial) account:
 * no `identity` auth method, hence no `EcdsaSecp256k1VerificationKey2019`
 * verification method of its own to derive from.
 *
 * It picks `#key-1` BY NAME — the account's own key. A document may list more
 * than one identity key, and taking whichever came first meant the address a
 * payer derives could belong to a key the recipient's device does not hold:
 * money at an address nobody can spend, chosen by list order.
 *
 * @throws {IdentityDocumentUnavailableError} Oxy could not be asked.
 */
export async function resolveIdentityPublicKey(oxyUserId: string): Promise<Uint8Array | null> {
  if (identityKeyResolver) return identityKeyResolver(oxyUserId);
  const doc = await fetchDidDocument(oxyUserId);
  const secp256k1 = (doc.verificationMethod ?? []).filter(
    (entry) => entry.type === SECP256K1_VERIFICATION_METHOD_TYPE && 'publicKeyHex' in entry,
  );
  const vm = secp256k1.find((entry) => entry.id.endsWith(ACCOUNT_KEY_FRAGMENT));
  if (!vm || !('publicKeyHex' in vm)) {
    return null;
  }
  return hexToBytes(vm.publicKeyHex);
}

/**
 * The account's CURRENT identity key as Peable records keys: lowercase hex of
 * the `#key-1` bytes the DID publishes (`bytesToHex`), so one key has one
 * spelling and two recorded keys compare as strings. `null` for a keyless
 * account. Read fresh.
 *
 * @throws {IdentityDocumentUnavailableError}
 */
export async function resolveIdentityPublicKeyHex(oxyUserId: string): Promise<string | null> {
  const key = await resolveIdentityPublicKey(oxyUserId);
  return key === null ? null : bytesToHex(key);
}

/**
 * Fresh `@username` addresses per recipient per network per day (ADR 0021 D9,
 * amended 2026-11-06). A sender asking again before paying is handed the
 * address it already holds ({@link reuseUnpaidSocialAddress}) and adds
 * nothing, so this bounds what DISTINCT senders can add to a recipient's watch
 * set — far above how many new people pay one person in a day.
 */
export const MAX_FRESH_SOCIAL_ADDRESSES = 500;

let maxFreshSocial = MAX_FRESH_SOCIAL_ADDRESSES;

/** Replace the bound (tests); `null` restores {@link MAX_FRESH_SOCIAL_ADDRESSES}. Answers the previous one. */
export function useMaxFreshSocialAddresses(next: number | null): number {
  const previous = maxFreshSocial;
  maxFreshSocial = next ?? MAX_FRESH_SOCIAL_ADDRESSES;
  return previous;
}

/**
 * Hand `senderUserId` a FRESH address of `recipientUserId`'s Peable wallet and
 * record it — ONE transaction: the recipient's lock, its daily bound, the
 * cursor's one statement (`reserveFreshAddress`) and the attribution row. The
 * attribution is the address's record — what the recipient's wallet syncs
 * (`GET /v1/social/me/receive_addresses`) — so an address is never handed out
 * without it, and because it commits with the cursor's row lock the sync's
 * index order is exact. Derived from the recipient's PUBLIC identity key, read
 * fresh before the transaction (ADR 0002); the gateway never sees a private
 * key.
 *
 * Returns `null` when the recipient is keyless (no identity key to derive
 * from) — callers surface the "invite them to set up Peable" flow (spec §4.5).
 *
 * @throws {FaircoinCapacityError} {@link MAX_FRESH_SOCIAL_ADDRESSES} fresh
 *   `@username` addresses of the recipient's were handed out in the last day;
 *   nothing reserved.
 */
export async function reserveSocialSendAddress(input: {
  readonly senderUserId: string;
  readonly recipientUserId: string;
  readonly network: NetworkType;
  readonly source?: SocialPaymentSource;
  /**
   * The id of the sender's latest attribution for this recipient as the
   * caller read it before deciding a fresh address was needed (`null`: none).
   * Under the lock, a different latest one means a concurrent request of the
   * same sender just reserved: it is handed back instead of a second fresh
   * address, so concurrency cannot give one sender two unpaid addresses.
   */
  readonly seenLatestAttributionId?: string | null;
}): Promise<{ index: number; address: string; identityPublicKey: string } | null> {
  // Fresh, never cached: the key a reservation derives from and records is the
  // one the recipient's DID publishes NOW (ADR 0002, amended 2026-11-06).
  const identityPublicKey = await resolveIdentityPublicKey(input.recipientUserId);
  if (!identityPublicKey) return null;

  return getDb().transaction(async (tx) => {
    await lockRecipientPool(tx, input.recipientUserId, input.network);
    if (input.seenLatestAttributionId !== undefined) {
      const latest = await findLatestAttributionForPair(
        tx,
        input.senderUserId,
        input.recipientUserId,
        input.network,
      );
      if (latest && latest.id !== input.seenLatestAttributionId) {
        return {
          index: latest.derivationIndex,
          address: latest.address,
          identityPublicKey: bytesToHex(identityPublicKey),
        };
      }
    }
    const fresh = await countAttributionsSince(
      tx,
      input.recipientUserId,
      input.network,
      UNPAID_WINDOW_SECONDS,
    );
    if (fresh >= maxFreshSocial) throw new FaircoinCapacityError();
    const reserved = await reserveFreshAddress(
      tx,
      input.recipientUserId,
      input.network,
      identityPublicKey,
    );
    const row = await insertSendAttribution(tx, {
      address: reserved.address,
      network: input.network,
      senderUserId: input.senderUserId,
      recipientUserId: input.recipientUserId,
      derivationIndex: reserved.derivationIndex,
      identityPublicKey: reserved.identityPublicKey,
      // Recorded AFTER the reservation and an input to nothing before it: a
      // request carrying a source and one carrying none reserve the same
      // index — the context is something the recipient reads later.
      ...(input.source ? { source: input.source } : {}),
    });
    // `reserveFreshAddress` skipped every recorded address, so a conflict here
    // is a bug; never hand out an address its record does not hold.
    if (!row) throw new Error(`the @username address ${reserved.address} was already attributed`);
    return {
      index: reserved.derivationIndex,
      address: reserved.address,
      identityPublicKey: reserved.identityPublicKey,
    };
  });
}

/**
 * Read-only counterpart to {@link reserveSocialSendAddress}: the highest
 * social-receive index EVER reserved for `oxyUserId` on `network`, without
 * reserving another one. Backs `GET /v1/social/me/cursor` (cursor-sync fix
 * for the silent-desync finding — see `SocialReceiveCursorResponse`).
 *
 * `social_receive_cursors.next_derivation_index` always holds the NEXT index
 * this user's cursor will hand out (post-increment value), so the highest index already
 * reserved is one less than that. `0` when no cursor exists yet (the user has
 * never had an address reserved on this network).
 *
 * Carries the identity key those addresses were derived from, so the caller's
 * device can check it still derives from the same one.
 */
export async function getReservedThrough(
  oxyUserId: string,
  network: NetworkType,
): Promise<{ reservedThrough: number; identityPublicKey: string | null }> {
  return readReservedThrough(getDb(), oxyUserId, network);
}

/**
 * The address `senderUserId` was last handed for paying `recipientUserId`, when
 * nothing was ever paid to it (ADR 0021 D9) — so a sender asking again, however
 * often, holds at most ONE unpaid address in the recipient's tree, and the
 * recipient's cursor grows with real payments and distinct senders rather than
 * with requests.
 *
 * Handed back only when it still derives from the recipient's CURRENT key (a
 * rotated key's tree is one nobody scans, ADR 0002) and the chain shows it
 * received nothing. An Explorer that cannot tell (`unknown`, testnet's node)
 * hands nothing back: the caller reserves a fresh address, as before. A
 * refusal names the latest attribution it saw, which the caller hands to
 * {@link reserveSocialSendAddress} so a concurrent request of the same sender
 * is answered with the address that one just got.
 */
export async function reuseUnpaidSocialAddress(
  senderUserId: string,
  recipientUserId: string,
  network: NetworkType,
): Promise<
  | { reusable: true; attributionId: string; index: number; address: string }
  | { reusable: false; latestAttributionId: string | null }
> {
  const latest = await findLatestAttributionForPair(
    getDb(),
    senderUserId,
    recipientUserId,
    network,
  );
  if (!latest) return { reusable: false, latestAttributionId: null };
  const no = { reusable: false, latestAttributionId: latest.id } as const;
  const identityPublicKey = await resolveIdentityPublicKey(recipientUserId);
  if (!identityPublicKey) return no;
  const derived = deriveSocialReceiveAddress(
    identityPublicKey,
    latest.derivationIndex,
    getNetwork(network),
  );
  if (derived !== latest.address) return no;
  if ((await addressUsage(latest.address, network)) !== 'unused') return no;
  return {
    reusable: true,
    attributionId: latest.id,
    index: latest.derivationIndex,
    address: latest.address,
  };
}
