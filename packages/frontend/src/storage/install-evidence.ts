/**
 * This app's own evidence that it ran on this phone before (security review
 * round 6, R6-4): the wallet ids whose SQLite database (`db-name.ts`) the app
 * sandbox held when this build FIRST looked — recorded once, in the sandbox,
 * and never recomputed, so a database this build creates later (for a wallet
 * id another app planted in the shared keychain group, say) never becomes
 * evidence. Nothing here is read from or written to a keychain group: no
 * other app can write this app's sandbox.
 *
 * Any failure answers "no evidence", which takes nothing from the shared
 * group: the safe side of the keychain move (`keychain-groups.ts`).
 */
import { Directory, File, Paths } from 'expo-file-system';
import { defaultDatabaseDirectory } from 'expo-sqlite';
import { type InstallEvidence, walletIdOfDatabaseFile } from './wallet-keys';

const EVIDENCE_FILE = 'peable-install-evidence-v1.json';

function fileUri(path: string): string {
  return path.startsWith('file:') ? path : `file://${path}`;
}

/** Parse a recorded evidence file; `null` when it does not parse (then: no evidence). */
export function parseInstallEvidence(raw: string): InstallEvidence | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const ids = (parsed as { walletIds?: unknown }).walletIds;
    if (!Array.isArray(ids)) return null;
    return { walletIds: new Set(ids.filter((id): id is string => typeof id === 'string')) };
  } catch {
    return null;
  }
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

export async function readInstallEvidence(): Promise<InstallEvidence> {
  const none: InstallEvidence = { walletIds: new Set() };
  try {
    const record = new File(Paths.document, EVIDENCE_FILE);
    if (record.exists) return parseInstallEvidence(await record.text()) ?? none;
    const directory =
      typeof defaultDatabaseDirectory === 'string'
        ? new Directory(fileUri(defaultDatabaseDirectory))
        : null;
    const names =
      directory?.exists === true
        ? directory
            .list()
            .filter((entry): entry is File => entry instanceof File)
            .map((entry) => entry.name)
        : [];
    const walletIds = walletIdsOfDatabaseFiles(names);
    record.create();
    record.write(JSON.stringify({ walletIds: [...walletIds] }));
    return { walletIds };
  } catch {
    return none;
  }
}
