import { describe, test, expect, mock } from 'bun:test';
import { bytesToHex, hexToBytes } from '@fairco.in/core';
import { getPublicKey } from '@noble/secp256k1';
import {
  commonsOrganizationWalletUrl,
  decideActingSubject,
  resolveOrganizationWallet,
  type OrganizationWalletDeps,
} from './organization-wallet';

const ORG_ID = '0123456789abcdef01234567';
const KEY_A = bytesToHex(getPublicKey(hexToBytes('cc'.repeat(32)), false));
const KEY_A_COMPRESSED = bytesToHex(getPublicKey(hexToBytes('cc'.repeat(32)), true));
const KEY_B = bytesToHex(getPublicKey(hexToBytes('dd'.repeat(32)), false));

function forbidden(): Error {
  return Object.assign(new Error('ORGANIZATION_KEY_FORBIDDEN'), { status: 403 });
}

/** Core's "cannot tell now" (`@oxy.so/core` 7.40.0, R7-4), matched by name. */
function identityUnavailable(): Error {
  return Object.assign(new Error('The key this payment needs cannot be read right now.'), {
    name: 'IdentityUnavailableError',
  });
}

function deps(overrides: Partial<OrganizationWalletDeps> = {}): OrganizationWalletDeps {
  return {
    hasIdentityKeystore: true,
    readIdentityKey: mock(async () => ({ publicKey: KEY_A })),
    readDevicePublicKey: mock(async () => KEY_A),
    holdsKey: mock(async () => false),
    ...overrides,
  };
}

describe('decideActingSubject', () => {
  test('a person, with or without an explicit kind', () => {
    expect(decideActingSubject({ id: 'u1' })).toEqual({ kind: 'personal', accountId: 'u1' });
    expect(decideActingSubject({ id: 'u1', kind: 'personal' })).toEqual({
      kind: 'personal',
      accountId: 'u1',
    });
  });

  test('acting as an organization is the organization', () => {
    expect(decideActingSubject({ id: ORG_ID, kind: 'organization' })).toEqual({
      kind: 'organization',
      accountId: ORG_ID,
    });
  });

  test("any other account kind has no wallet here — never the person's under its name", () => {
    for (const kind of ['project', 'bot', 'channel', 'community']) {
      expect(decideActingSubject({ id: 'x', kind }).kind).toBe('unsupported');
    }
  });
});

describe('resolveOrganizationWallet', () => {
  test('ready when this phone holds the key the organization publishes', async () => {
    const d = deps();
    expect(await resolveOrganizationWallet(ORG_ID, d)).toEqual({
      status: 'ready',
      publishedPublicKey: KEY_A,
    });
    expect(d.readIdentityKey).toHaveBeenCalledWith(ORG_ID);
    expect(d.readDevicePublicKey).toHaveBeenCalledWith(ORG_ID);
  });

  test('compares keys by point, not by encoding', async () => {
    const d = deps({ readDevicePublicKey: mock(async () => KEY_A_COMPRESSED) });
    expect((await resolveOrganizationWallet(ORG_ID, d)).status).toBe('ready');
  });

  test('keyless organization (no #key-1): set it up in Commons, whatever this phone holds', async () => {
    const d = deps({ readIdentityKey: mock(async () => ({ publicKey: null })) });
    expect(await resolveOrganizationWallet(ORG_ID, d)).toEqual({ status: 'keyless' });
    expect(d.readDevicePublicKey).not.toHaveBeenCalled();
  });

  test('keyless is shown on web too', async () => {
    const d = deps({
      hasIdentityKeystore: false,
      readIdentityKey: mock(async () => ({ publicKey: null })),
    });
    expect(await resolveOrganizationWallet(ORG_ID, d)).toEqual({ status: 'keyless' });
  });

  test('a non-owner/admin (403) is told only owners and admins can', async () => {
    const d = deps({
      readIdentityKey: mock(async () => {
        throw forbidden();
      }),
    });
    expect(await resolveOrganizationWallet(ORG_ID, d)).toEqual({ status: 'forbidden' });
    expect(d.readDevicePublicKey).not.toHaveBeenCalled();
  });

  test('the organization has a key, this phone does not: add it in Commons', async () => {
    const d = deps({ readDevicePublicKey: mock(async () => null) });
    expect(await resolveOrganizationWallet(ORG_ID, d)).toEqual({ status: 'not-on-device' });
    // Only once a selected derivation said so: the device read alone is `null`
    // while the keychain is locked too.
    expect(d.holdsKey).toHaveBeenCalledWith(ORG_ID, KEY_A);
  });

  test('the device read answered nothing but the key is held: open it', async () => {
    const d = deps({
      readDevicePublicKey: mock(async () => null),
      holdsKey: mock(async () => true),
    });
    expect(await resolveOrganizationWallet(ORG_ID, d)).toEqual({
      status: 'ready',
      publishedPublicKey: KEY_A,
    });
  });

  describe('a key that cannot be read now (IdentityUnavailableError) is "try again"', () => {
    test('never not-on-device when the derivation cannot tell', async () => {
      const d = deps({
        readDevicePublicKey: mock(async () => null),
        holdsKey: mock(async () => {
          throw identityUnavailable();
        }),
      });
      expect(await resolveOrganizationWallet(ORG_ID, d)).toEqual({ status: 'key-unavailable' });
    });

    test('never not-on-device or replaced-key when the device read throws', async () => {
      const d = deps({
        readDevicePublicKey: mock(async () => {
          throw identityUnavailable();
        }),
      });
      expect(await resolveOrganizationWallet(ORG_ID, d)).toEqual({ status: 'key-unavailable' });
      expect(d.holdsKey).not.toHaveBeenCalled();
    });

    test('Oxy unreachable and the device read throws: key-unavailable, not a guess', async () => {
      const d = deps({
        readIdentityKey: mock(async () => {
          throw Object.assign(new Error('offline'), { status: 0 });
        }),
        readDevicePublicKey: mock(async () => {
          throw identityUnavailable();
        }),
      });
      expect(await resolveOrganizationWallet(ORG_ID, d)).toEqual({ status: 'key-unavailable' });
    });
  });

  test('this phone holds a replaced key: open it, with social receive off', async () => {
    const d = deps({ readDevicePublicKey: mock(async () => KEY_B) });
    expect(await resolveOrganizationWallet(ORG_ID, d)).toEqual({
      status: 'replaced-key',
      publishedPublicKey: KEY_A,
    });
  });

  test('web with a key is read-only, and never asks for a device key', async () => {
    const d = deps({ hasIdentityKeystore: false });
    expect(await resolveOrganizationWallet(ORG_ID, d)).toEqual({ status: 'read-only' });
    expect(d.readDevicePublicKey).not.toHaveBeenCalled();
  });

  test('Oxy unreachable: a phone holding the key opens it unverified', async () => {
    const d = deps({
      readIdentityKey: mock(async () => {
        throw Object.assign(new Error('offline'), { status: 0 });
      }),
    });
    expect(await resolveOrganizationWallet(ORG_ID, d)).toEqual({
      status: 'ready',
      publishedPublicKey: null,
    });
  });

  test('Oxy unreachable and no key on this phone: unavailable, not a guess', async () => {
    const d = deps({
      readIdentityKey: mock(async () => {
        throw Object.assign(new Error('bad gateway'), { status: 502 });
      }),
      readDevicePublicKey: mock(async () => null),
    });
    expect(await resolveOrganizationWallet(ORG_ID, d)).toEqual({ status: 'unavailable' });
  });
});

describe('commonsOrganizationWalletUrl', () => {
  test("opens Commons' Organization wallet screen for this organization", () => {
    expect(commonsOrganizationWalletUrl(ORG_ID)).toBe(`commons://organization-wallets/${ORG_ID}`);
  });
});
