import { test, expect } from 'bun:test';
import {
  SOCIAL_SOURCE_APP_MAX_LENGTH,
  SOCIAL_SOURCE_REF_MAX_LENGTH,
  type SocialNextAddressRequest,
  type SocialNextAddressResponse,
  type SocialPayment,
  type EnrichmentResult,
  type EnrichRequest,
  type EnrichResponse,
} from '../social';

test('SocialNextAddressResponse shape compiles and round-trips through JSON', () => {
  const value: SocialNextAddressResponse = { address: 'TAbC123', index: 3 };
  expect(JSON.parse(JSON.stringify(value))).toEqual(value);
});

/**
 * The context is OPTIONAL on both sides of the round trip, and that is the
 * property the "tip a post" flow rests on: a plain person-to-person payment
 * sends no source and is answered without one.
 */
test('SocialNextAddressRequest and SocialPayment carry an optional source', () => {
  const plain: SocialNextAddressRequest = { network: 'testnet' };
  const tip: SocialNextAddressRequest = {
    network: 'testnet',
    source: { app: 'mention', ref: 'post_abc123' },
  };
  const appOnly: SocialNextAddressRequest = { network: 'mainnet', source: { app: 'mention' } };

  expect(JSON.parse(JSON.stringify(tip))).toEqual(tip);
  // `undefined` is not a JSON value, so an absent source must be an ABSENT key
  // and not `source: null` — a client checking `'source' in payment` would
  // otherwise render a context nobody sent.
  expect(Object.keys(JSON.parse(JSON.stringify(plain)))).toEqual(['network']);
  expect(Object.keys(JSON.parse(JSON.stringify(appOnly.source ?? {})))).toEqual(['app']);
});

test('SocialPayment is assignable with and without a source', () => {
  const base = {
    address: 'TAbC123',
    direction: 'received',
    counterparty: { kind: 'user', username: 'alice' },
    createdAt: '2026-07-19T00:00:00.000Z',
  } as const;
  const withSource: SocialPayment = { ...base, source: { app: 'mention', ref: 'post_1' } };
  const without: SocialPayment = { ...base };

  expect(withSource.source?.app).toBe('mention');
  expect(without.source).toBeUndefined();
});

/**
 * The bounds are published because they are what a request is REFUSED for. They
 * are also what the backend's zod schema and the column CHECKs both read, so a
 * change here is a change to all three at once — which is the point.
 */
test('the source bounds are published and id-shaped, not prose-shaped', () => {
  expect([SOCIAL_SOURCE_APP_MAX_LENGTH, SOCIAL_SOURCE_REF_MAX_LENGTH]).toEqual([32, 128]);
});

test('EnrichmentResult supports all three kinds', () => {
  const merchant: EnrichmentResult = {
    kind: 'merchant',
    displayName: 'Mercaria',
    avatarFileId: 'file_1',
    description: 'Marketplace',
  };
  const user: EnrichmentResult = {
    kind: 'user',
    displayName: 'Alice',
    username: 'alice',
    avatarFileId: 'file_2',
  };
  const unknown: EnrichmentResult = { kind: 'unknown' };
  expect(merchant.kind).toBe('merchant');
  expect(user.kind).toBe('user');
  expect(unknown.kind).toBe('unknown');
});

test('EnrichRequest / EnrichResponse round-trip', () => {
  const req: EnrichRequest = { addresses: ['TAbC123', 'TDeF456'] };
  const res: EnrichResponse = {
    data: {
      TAbC123: { kind: 'unknown' },
      TDeF456: { kind: 'merchant', displayName: 'Shop' },
    },
  };
  expect(Object.keys(res.data)).toEqual(req.addresses);
});
