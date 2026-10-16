import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PEABLE_BILLING_AUTHORITY_KEYS } from '@peable.to/shared-types';

/** Raw 32-byte Ed25519 public key, for comparison independent of PEM layout. */
function raw(key: KeyObject): string {
  return key.export({ type: 'spki', format: 'der' }).toString('base64');
}

/**
 * Reads the mounted billing signing key and names it by its PINNED public half.
 * A key that is not Ed25519, not private, or whose public half is not pinned is
 * refused: the file is an operator-delivered secret, and signing with a key no
 * consumer can verify would issue authority nobody accepts. Nothing derived
 * from the file's content ever reaches an error message or a log.
 */
export async function loadPinnedSigningKey(
  path: string,
  pinned: Readonly<Record<string, string>> = PEABLE_BILLING_AUTHORITY_KEYS,
): Promise<{ keyId: string; privateKey: KeyObject }> {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(await readFile(path, 'utf8'));
  } catch {
    throw new Error('Billing signing key file is unreadable or not a private key');
  }
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519')
    throw new Error('Billing signing key must be an Ed25519 private key');
  const own = raw(createPublicKey(privateKey));
  const matches = Object.entries(pinned).filter(([, pem]) => raw(createPublicKey(pem)) === own);
  if (matches.length !== 1 || !matches[0])
    throw new Error('Billing signing key is not a pinned Peable billing key');
  return { keyId: matches[0][0], privateKey };
}

/** Boot readiness of a mounted key no configured rail uses yet. Reports, never
 * fails the boot: an unused secret must not take the gateway down. */
export async function reportMountedSigningKey(path: string | undefined): Promise<void> {
  if (!path) return;
  try {
    const { keyId } = await loadPinnedSigningKey(path);
    console.info(`[billing] signing key ${keyId} is mounted and matches its pinned public key`);
  } catch (error) {
    console.error(`[billing] mounted signing key is unusable: ${(error as Error).message}`);
  }
}
