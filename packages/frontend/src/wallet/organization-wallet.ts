/**
 * Which wallet the signed-in person is looking at, and — when they act as an
 * organization — whether this phone may open it (oxy ADRs 0001 and 0061,
 * Peable ADR 0021 D5).
 *
 * A person acting as an organization sees the ORGANIZATION's Peable wallet:
 * its merchant payments land there (ADR 0021 D5), derived from the
 * organization's DID `#key-1`. That key is created and held in Commons by the
 * organization's owners and admins; this app reaches it only by derivation
 * (`deriveScopedSeed` / `signSocialReceive` with `{ accountId }`). Nothing here
 * ever falls back to the person's own key: an organization address derived
 * from a person's key would follow that person out of the organization.
 *
 * Pure decisions over injected reads, so the whole table is unit-tested
 * without Oxy, Commons or a device.
 */

import { getErrorStatus } from '@oxy.so/core';
import { compressedPublicKeyHex } from './social-receive';

/**
 * Commons' screen for one organization's Peable wallet
 * (`packages/commons/app/(tabs)/(settings)/organization-wallets/[accountId].tsx`
 * in the oxy repo — Settings → Organizations → Organization wallets). Route
 * groups add no URL segment, so the deep-link path is
 * `/organization-wallets/<id>`. That one screen covers every case an owner
 * meets: create the key, add the phrase another owner holds, or replace it.
 */
export function commonsOrganizationWalletUrl(accountId: string): string {
  return `commons://organization-wallets/${encodeURIComponent(accountId)}`;
}

/** Who the session acts as, as far as the wallet is concerned. */
export type ActingSubject =
  | { readonly kind: 'personal'; readonly accountId: string }
  | { readonly kind: 'organization'; readonly accountId: string }
  /** A project, bot, channel or community: no Peable wallet of its own here. */
  | { readonly kind: 'unsupported'; readonly accountId: string };

/**
 * The acting account's kind decides. `kind` absent reads as `personal` (the
 * column's default, per `@oxy.so/core`'s `User`). Any other non-personal kind
 * has no organization key (ADR 0061 D1), so it gets no wallet rather than the
 * person's under another account's name.
 */
export function decideActingSubject(account: {
  readonly id: string;
  readonly kind?: string | null;
}): ActingSubject {
  const kind = account.kind ?? 'personal';
  if (kind === 'personal') return { kind: 'personal', accountId: account.id };
  if (kind === 'organization') return { kind: 'organization', accountId: account.id };
  return { kind: 'unsupported', accountId: account.id };
}

/**
 * What the organization's wallet can be on this host:
 *
 *   ready         this phone holds the organization's key: open the wallet
 *                 (`publishedPublicKey` is `#key-1`, or `null` when Oxy could
 *                 not be asked and the cursor check is the only comparison)
 *   replaced-key  this phone holds a key the organization has since REPLACED:
 *                 open it — what that key received is spendable only with it —
 *                 but social receive stays off (ADR 0002)
 *   read-only     no keystore (web): everything that needs no key
 *   keyless       no `#key-1` yet: the owners set it up in Commons (D8)
 *   not-on-device the organization has a key, this phone does not: an owner
 *                 adds it in Commons (D5)
 *   forbidden     the person is not an owner or admin (403
 *                 `ORGANIZATION_KEY_FORBIDDEN`): only they can hold the key
 *   unavailable   Oxy could not be asked and this phone holds no key
 */
export type OrganizationWalletStatus =
  | { readonly status: 'ready'; readonly publishedPublicKey: string | null }
  | { readonly status: 'replaced-key'; readonly publishedPublicKey: string }
  | { readonly status: 'read-only' }
  | { readonly status: 'keyless' }
  | { readonly status: 'not-on-device' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'unavailable' };

export interface OrganizationWalletDeps {
  /** Whether this host has an identity keystore (`hasIdentityKeystore`). */
  readonly hasIdentityKeystore: boolean;
  /** `oxy.accounts.identityKey.get` — throws on 403 for a non-owner/admin. */
  readonly readIdentityKey: (accountId: string) => Promise<{ publicKey: string | null }>;
  /** `getOrganizationPublicKey` — the key THIS phone reaches, or `null`. */
  readonly readDevicePublicKey: (accountId: string) => Promise<string | null>;
}

const FORBIDDEN = 403;

export async function resolveOrganizationWallet(
  accountId: string,
  deps: OrganizationWalletDeps,
): Promise<OrganizationWalletStatus> {
  let published: string | null;
  try {
    published = (await deps.readIdentityKey(accountId)).publicKey;
  } catch (error) {
    if (getErrorStatus(error) === FORBIDDEN) return { status: 'forbidden' };
    // Oxy could not answer. A web host shows what needs no key either way; a
    // phone that holds the organization's key opens it (offline, like the
    // personal wallet) and leaves the comparison to the cursor sync; a phone
    // without it has nothing to open and must not guess why.
    if (!deps.hasIdentityKeystore) return { status: 'read-only' };
    const device = await deps.readDevicePublicKey(accountId);
    return device ? { status: 'ready', publishedPublicKey: null } : { status: 'unavailable' };
  }

  // No `#key-1`: the organization has no wallet yet, whatever this phone holds.
  if (published === null) return { status: 'keyless' };
  if (!deps.hasIdentityKeystore) return { status: 'read-only' };

  const device = await deps.readDevicePublicKey(accountId);
  if (device === null) return { status: 'not-on-device' };
  return compressedPublicKeyHex(device) === compressedPublicKeyHex(published)
    ? { status: 'ready', publishedPublicKey: published }
    : { status: 'replaced-key', publishedPublicKey: published };
}
