/**
 * This app's own evidence that it ran on this phone before (security review
 * round 6, R6-4; bound to the phone in round 7, R7-7): the wallet ids whose
 * SQLite database (`db-name.ts`) the app sandbox held when this build FIRST
 * looked — recorded once, in the sandbox, and never recomputed, so a database
 * this build creates later (for a wallet id another app planted in the shared
 * keychain group, say) never becomes evidence. No other app can write this
 * app's sandbox. The record counts only while the nonce it carries is in the
 * wallet's own keychain group, written "this device only", so a sandbox
 * restored onto another phone is no evidence there (`install-evidence-rules.ts`).
 *
 * A sandbox failure answers "no evidence", which takes nothing from the
 * shared group: the safe side of the keychain move (`keychain-groups.ts`).
 */
import { bytesToHex } from '@fairco.in/core';
import { Directory, File, Paths } from 'expo-file-system';
import { defaultDatabaseDirectory } from 'expo-sqlite';
import {
  decideInstallEvidence,
  type EvidenceBinding,
  type EvidenceSandbox,
} from './install-evidence-rules';
import { type InstallEvidence, walletIdOfDatabaseFile } from './wallet-keys';

/** The bound record (round 7). */
const EVIDENCE_FILE = 'peable-install-evidence-v2.json';
/** Round 6's record, bound to nothing: never evidence (R7-7). */
const UNBOUND_EVIDENCE_FILE = 'peable-install-evidence-v1.json';

function fileUri(path: string): string {
  return path.startsWith('file:') ? path : `file://${path}`;
}

/** The wallet ids the sandbox's database files name. */
export function walletIdsOfDatabaseFiles(names: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const name of names) {
    const id = walletIdOfDatabaseFile(name);
    if (id !== null) ids.add(id);
  }
  return ids;
}

const sandbox: EvidenceSandbox = {
  readRecord: async () => {
    const record = new File(Paths.document, EVIDENCE_FILE);
    return record.exists ? record.text() : null;
  },
  hasUnboundRecord: async () => new File(Paths.document, UNBOUND_EVIDENCE_FILE).exists,
  databaseFileNames: async () => {
    const directory =
      typeof defaultDatabaseDirectory === 'string'
        ? new Directory(fileUri(defaultDatabaseDirectory))
        : null;
    return directory?.exists === true
      ? directory
          .list()
          .filter((entry): entry is File => entry instanceof File)
          .map((entry) => entry.name)
      : [];
  },
  writeRecord: async (text) => {
    const record = new File(Paths.document, EVIDENCE_FILE);
    record.create();
    record.write(text);
  },
};

function newNonce(): string {
  return bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

/** The evidence, bound to this phone through `binding` (the keychain move supplies it). */
export function readInstallEvidence(binding: EvidenceBinding): Promise<InstallEvidence> {
  return decideInstallEvidence(sandbox, binding, walletIdsOfDatabaseFiles, newNonce);
}
