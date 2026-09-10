/**
 * Keyless-account handling: an Oxy account with no self-sovereign identity key
 * on this device cannot derive a wallet (spec §4.1 — see `deriveIdentitySeed`
 * in `identity-wallet.ts`, backed by `KeyManager.deriveScopedSeed` returning
 * `null`). Route the user to Commons — the ecosystem identity vault — to
 * CREATE an Oxy ID, or, if the server shows an identity that just isn't on
 * this device yet, to Commons' recovery-phrase import screen to sync it.
 * Peable is a Relying Party; it never mints or imports identities itself.
 */

/**
 * Commons deep link that starts Oxy ID creation
 * (`packages/commons/app/(auth)/create-identity/index.tsx`). Commons'
 * `(auth)` group segment is invisible to expo-router's deep-link resolver, so
 * the path is `/create-identity`. That screen self-triggers key generation on
 * mount (no navigation state required from the caller), so it is safe to
 * deep-link into directly.
 */
export const COMMONS_CREATE_IDENTITY_URL = "commons://create-identity";

/**
 * Commons deep link that opens the recovery-phrase import screen
 * (`packages/commons/app/(auth)/import-identity/index.tsx`) — the REAL
 * "bring an existing identity to a new device" flow. Commons' registered
 * schemes are `commons` and `oxycommons` (`packages/commons/app.config.js`);
 * either works, `commons://` is used for brevity to match the create URL.
 */
export const COMMONS_IMPORT_IDENTITY_URL = "commons://import-identity";

export type KeylessAction = { kind: "create" | "sync"; url: string };

/**
 * True when the account already has a self-sovereign identity verification
 * method on the server (present on some device), vs. a fully keyless
 * (password-only) account. A `webauthn` (passkey) entry does not count — a
 * passkey-only account stays custodial and still cannot derive a wallet (see
 * `AuthMethodEntry` in `@oxy.so/contracts`, whose `type` union is exactly
 * `'identity' | 'webauthn'`).
 */
export function hasIdentityAuthMethod(methods: readonly { type?: string }[]): boolean {
  return methods.some((m) => m.type === "identity");
}

/**
 * Decide what a keyless-on-this-device user should do: create a new Oxy ID
 * (no identity anywhere) or open Commons to import an existing one onto this
 * device.
 */
export function resolveKeylessAction(serverHasIdentity: boolean): KeylessAction {
  return serverHasIdentity
    ? { kind: "sync", url: COMMONS_IMPORT_IDENTITY_URL }
    : { kind: "create", url: COMMONS_CREATE_IDENTITY_URL };
}
