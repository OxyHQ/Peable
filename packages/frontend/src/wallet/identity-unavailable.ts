/**
 * "This key cannot be read right now" — never "this key is not here"
 * (`@oxy.so/core` 7.40.0, security review R7-4).
 *
 * With a `publicKey` selector, `KeyManager.deriveScopedSeed` and
 * `signSocialReceive` answer `null` only when the key is DEFINITIVELY not held
 * on this device, and throw `IdentityUnavailableError` when it may be: a locked
 * keychain, a ring that could not be read, a Commons that is busy, updating or
 * did not answer. `listRetiredIdentityKeys` throws
 * `RetiredKeyRingUnreadableError` for the same reason.
 *
 * Every wallet path treats such a throw — and any other throw from a key read,
 * since only `null` is definitive — as "try again later": it never opens
 * another key in its place, never calls the key replaced, never retires,
 * unbinds or hides a row, never switches social receive off and never shows
 * sign-in or "set up your wallet". Matched by NAME, as core asks
 * (`error.name === 'IdentityUnavailableError'`): Metro can bundle two copies
 * of core, and `instanceof` across them is false.
 */

const UNAVAILABLE_ERROR_NAMES: ReadonlySet<string> = new Set([
  'IdentityUnavailableError',
  'RetiredKeyRingUnreadableError',
]);

/** Whether `error` is core's "cannot tell now" for an identity key read. */
export function isIdentityUnavailable(error: unknown): boolean {
  return error instanceof Error && UNAVAILABLE_ERROR_NAMES.has(error.name);
}

/**
 * The wallet's own form of the error, with a message a person can act on (the
 * screens show `error.message`). Keeps core's name, so a caller further up
 * still recognises it with {@link isIdentityUnavailable}, and core's error as
 * its `cause`.
 */
export class WalletKeyUnavailableError extends Error {
  override readonly name = 'IdentityUnavailableError';

  constructor(cause?: unknown) {
    super(
      "Your wallet key can't be read right now: the phone may be locked or Commons busy. Nothing was changed or sent. Try again in a moment.",
      cause === undefined ? undefined : { cause },
    );
  }
}

/** `error` as a {@link WalletKeyUnavailableError} when it is core's "cannot tell now", else unchanged. */
export function asWalletKeyError(error: unknown): unknown {
  return isIdentityUnavailable(error) && !(error instanceof WalletKeyUnavailableError)
    ? new WalletKeyUnavailableError(error)
    : error;
}
