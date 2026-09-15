/**
 * Pure crash-log policy: redaction and trimming.
 *
 * Lives in its own module — separate from `crash-log.ts` which depends on the
 * platform key-value store — so the redaction rules can be unit-tested without
 * dragging the React Native storage adapter into the bun test runner (which
 * cannot load `react-native/index.js`). Same split as
 * `pin-attempts-policy.ts` vs `pin-attempts.ts`.
 *
 * REDACTION IS NOT OPTIONAL. This is a wallet: an error message or stack frame
 * can quote whatever string was being processed when it threw — a mnemonic, a
 * WIF, an xprv. The log lives in ordinary (unencrypted) key-value storage and
 * is meant to be shown and shared, so every entry is scrubbed by
 * {@link redactSecrets} before it is stored.
 */

/** How many entries to keep. Oldest are dropped first. */
export const MAX_CRASH_ENTRIES = 20;

export interface CrashEntry {
  /** Unix seconds. */
  readonly at: number;
  /** Error constructor name, e.g. "TypeError". */
  readonly name: string;
  readonly message: string;
  readonly stack: string;
  /** True for a global handler crash, false for one caught by the boundary. */
  readonly fatal: boolean;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const REDACTED = "[redacted]";

// 12–24 space-separated lowercase words: a BIP39 mnemonic. Requires 11+ words
// so ordinary English prose in an error message survives intact.
const MNEMONIC_RE = /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g;
// 64+ hex chars: a raw private key, a seed, or an extended key's payload.
const LONG_HEX_RE = /\b[0-9a-fA-F]{64,}\b/g;
// Extended keys carry their own prefix and are unambiguous.
const XPRV_RE = /\b[xt]prv[1-9A-HJ-NP-Za-km-z]{20,}\b/g;
// Base58 of WIF length. Deliberately narrow (51–52 chars) so addresses
// (~34 chars) and txids (hex, handled above) are untouched.
const WIF_RE = /\b[1-9A-HJ-NP-Za-km-z]{51,52}\b/g;

/**
 * Strip anything that could be key material from a string before it is
 * persisted. Order matters: extended keys are matched before the generic WIF
 * pattern so they are labelled by the more specific rule.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(MNEMONIC_RE, REDACTED)
    .replace(XPRV_RE, REDACTED)
    .replace(LONG_HEX_RE, REDACTED)
    .replace(WIF_RE, REDACTED);
}

// ---------------------------------------------------------------------------
// Entry construction
// ---------------------------------------------------------------------------

/** Build a redacted, storable entry from an arbitrary thrown value. */
export function toCrashEntry(
  error: unknown,
  fatal: boolean,
  at: number,
): CrashEntry {
  const isError = error instanceof Error;
  return {
    at,
    name: isError ? error.name : typeof error,
    message: redactSecrets(isError ? error.message : String(error)),
    stack: redactSecrets(isError ? (error.stack ?? "") : ""),
    fatal,
  };
}

/** Append an entry, keeping only the newest {@link MAX_CRASH_ENTRIES}. */
export function appendCrashEntry(
  entries: readonly CrashEntry[],
  entry: CrashEntry,
  max: number = MAX_CRASH_ENTRIES,
): CrashEntry[] {
  return [...entries, entry].slice(-max);
}
