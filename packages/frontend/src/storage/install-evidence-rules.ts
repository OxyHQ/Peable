/**
 * When this app's install evidence counts (security review round 7, R7-7;
 * the evidence itself is round 6's, `install-evidence.ts`). Pure: the
 * sandbox and the keychain are injected.
 *
 * The round-6 evidence was a file in the app sandbox: the wallet databases
 * the sandbox held when this build first looked. A sandbox survives a backup
 * restore to ANOTHER phone — an unencrypted Finder/iTunes backup carries the
 * file but no keychain item — and on that phone the shared keychain group
 * holds only what other apps wrote there. The file still named the wallets,
 * so a phrase another app planted under one of their ids was adoptable.
 *
 * Now the record carries a random nonce, and the same nonce is written to the
 * wallet's own keychain group "this device only", which no backup carries to
 * another phone. The evidence counts only while both agree:
 *
 * - a record whose nonce the keychain does not hold — restored elsewhere, or
 *   written by the unbound round-6 format — is NO evidence, and is never
 *   recomputed (the restored databases would only say the same thing again);
 * - with no record, this build looks once: the sandbox's databases, unless a
 *   round-6 record is there (then nothing: it cannot be told apart from a
 *   restored one), bound to a fresh nonce written and read back BEFORE the
 *   record is;
 * - a keychain that cannot be read or written throws: the caller asks again
 *   later rather than conclude anything.
 */
import type { InstallEvidence } from './wallet-keys';

/** The app's sandbox, as the evidence needs it. */
export interface EvidenceSandbox {
  /** The bound record's text, `null` when there is none. */
  readRecord(): Promise<string | null>;
  /** Whether the unbound round-6 record is there. */
  hasUnboundRecord(): Promise<boolean>;
  /** The file names in the SQLite directory. */
  databaseFileNames(): Promise<string[]>;
  writeRecord(text: string): Promise<void>;
}

/** The nonce item in the wallet's own keychain group, written "this device only". */
export interface EvidenceBinding {
  read(): Promise<string | null>;
  write(nonce: string): Promise<void>;
}

const NONE: InstallEvidence = { walletIds: new Set() };

/** A recorded evidence file: its wallet ids and nonce; `null` when it does not parse. */
export function parseInstallEvidence(
  raw: string,
): { walletIds: Set<string>; nonce: string | null } | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { walletIds, nonce } = parsed as { walletIds?: unknown; nonce?: unknown };
    if (!Array.isArray(walletIds)) return null;
    return {
      walletIds: new Set(walletIds.filter((id): id is string => typeof id === 'string')),
      nonce: typeof nonce === 'string' && nonce.length > 0 ? nonce : null,
    };
  } catch {
    return null;
  }
}

/**
 * The evidence, by the rules above. `walletIdsOf` reads wallet ids from the
 * database file names; `newNonce` makes the nonce. Sandbox failures answer
 * no evidence; keychain failures throw.
 */
export async function decideInstallEvidence(
  sandbox: EvidenceSandbox,
  binding: EvidenceBinding,
  walletIdsOf: (names: readonly string[]) => Set<string>,
  newNonce: () => string,
): Promise<InstallEvidence> {
  let recorded: string | null;
  let unbound: boolean;
  try {
    recorded = await sandbox.readRecord();
    unbound = recorded === null && (await sandbox.hasUnboundRecord());
  } catch {
    return NONE;
  }
  if (recorded !== null) {
    const record = parseInstallEvidence(recorded);
    if (!record || record.nonce === null) return NONE;
    return (await binding.read()) === record.nonce ? { walletIds: record.walletIds } : NONE;
  }
  let walletIds = new Set<string>();
  if (!unbound) {
    try {
      walletIds = walletIdsOf(await sandbox.databaseFileNames());
    } catch {
      return NONE;
    }
  }
  const nonce = newNonce();
  await binding.write(nonce);
  if ((await binding.read()) !== nonce) {
    throw new Error('The install evidence could not be bound to this phone.');
  }
  try {
    await sandbox.writeRecord(JSON.stringify({ walletIds: [...walletIds], nonce }));
  } catch {
    return NONE;
  }
  return { walletIds };
}
