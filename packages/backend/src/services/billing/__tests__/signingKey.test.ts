import { describe, expect, it } from 'bun:test';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PEABLE_BILLING_AUTHORITY_KEYS } from '@peable.to/shared-types';
import { loadPinnedSigningKey } from '../signingKey';

const pem = (key: ReturnType<typeof generateKeyPairSync>['privateKey']) =>
  key.export({ type: 'pkcs8', format: 'pem' }).toString();

describe('the mounted billing signing key', () => {
  it('is named by its pinned public half and refused when nothing pins it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'peable-signing-'));
    const pinned = generateKeyPairSync('ed25519');
    const stranger = generateKeyPairSync('ed25519');
    const pins = {
      'key-a': pinned.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
    await writeFile(join(dir, 'pinned.pem'), pem(pinned.privateKey));
    await writeFile(join(dir, 'stranger.pem'), pem(stranger.privateKey));
    await writeFile(
      join(dir, 'rsa.pem'),
      pem(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey),
    );
    await writeFile(join(dir, 'public.pem'), pins['key-a']);
    expect((await loadPinnedSigningKey(join(dir, 'pinned.pem'), pins)).keyId).toBe('key-a');
    await expect(loadPinnedSigningKey(join(dir, 'stranger.pem'), pins)).rejects.toThrow('pinned');
    await expect(loadPinnedSigningKey(join(dir, 'rsa.pem'), pins)).rejects.toThrow('Ed25519');
    await expect(loadPinnedSigningKey(join(dir, 'public.pem'), pins)).rejects.toThrow();
    await expect(loadPinnedSigningKey(join(dir, 'absent.pem'), pins)).rejects.toThrow();
  });

  it('pins only well-formed Ed25519 public keys for production', () => {
    expect(Object.keys(PEABLE_BILLING_AUTHORITY_KEYS).length).toBeGreaterThan(0);
    for (const value of Object.values(PEABLE_BILLING_AUTHORITY_KEYS))
      expect(createPublicKey(value).asymmetricKeyType).toBe('ed25519');
  });
});
