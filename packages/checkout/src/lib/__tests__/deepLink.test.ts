import { test, expect } from 'bun:test';
import { getNetwork, publicKeyToAddress, validateAddress } from '@fairco.in/core';
import { buildPayDeepLink } from '../deepLink';
// Cross-package import of the WALLET's REAL parser — proves this app's deep
// link is actually consumable by the wallet, not just "looks right" by
// re-reading the parser's source. Money-critical: a param mismatch here
// means the wallet silently rejects the payer's link.
import { parsePaymentRequest } from '../../../../frontend/src/pay/payment-request';

// Same fixture address + network-detection technique as the wallet's own
// payment-request.test.ts, so this is verified against a REAL, checksum-valid
// FairCoin address, not a plausible-looking placeholder string.
const ADDR = 'FAHUJmcTfwvRYCcDXAzsu7YRiittDC8Jek';
const NET = validateAddress(ADDR, getNetwork('mainnet')) ? 'mainnet' : 'testnet';
const ID = 'pi_0123456789abcdef01234567';
const SECRET = `${ID}_secret_00112233445566778899aabbccddeeff`;

test('round-trips through the wallet real parser', () => {
  const link = buildPayDeepLink({
    intentId: ID,
    clientSecret: SECRET,
    address: ADDR,
    amount: '150000000',
    network: NET,
  });

  const parsed = parsePaymentRequest(link);

  expect(parsed).not.toBeNull();
  expect(parsed?.intentId).toBe(ID);
  expect(parsed?.clientSecret).toBe(SECRET);
  expect(parsed?.address).toBe(ADDR);
  expect(parsed?.amount).toBe(150000000n);
  expect(parsed?.network).toBe(NET);
});

test('round-trips a client secret containing URL-reserved characters', () => {
  // The parser only requires the secret to START with `${intentId}_secret_`
  // — the rest is opaque. Exercises encodeURIComponent/decodeURIComponent
  // symmetry for a character `URLSearchParams` would encode differently
  // (`+` becomes a form-encoded space there, not `encodeURIComponent`'s
  // `%2B` — see the "why not URLSearchParams" comment in deepLink.ts).
  const secretWithReservedChars = `${ID}_secret_a+b c&d=e`;

  const link = buildPayDeepLink({
    intentId: ID,
    clientSecret: secretWithReservedChars,
    address: ADDR,
    amount: '1',
    network: NET,
  });

  const parsed = parsePaymentRequest(link);

  expect(parsed).not.toBeNull();
  expect(parsed?.clientSecret).toBe(secretWithReservedChars);
});

test('a multi-seller payment carries every output and no address (ADR 0021 D6)', () => {
  const link = buildPayDeepLink({
    intentId: ID,
    clientSecret: SECRET,
    outputs: [
      { address: ADDR, amount: '800' },
      { address: 'FSecondSellerAddress', amount: '200' },
    ],
    amount: '1000',
    network: NET,
  });
  const query = new Map(
    link
      .slice(link.indexOf('?') + 1)
      .split('&')
      .map((pair) => pair.split('=').map(decodeURIComponent) as [string, string]),
  );
  expect(query.get('outputs')).toBe(`${ADDR}:800,FSecondSellerAddress:200`);
  expect(query.get('amount')).toBe('1000');
  // A wallet that predates multi-output payments finds no address and refuses.
  expect(query.has('address')).toBe(false);
});

test('a multi-seller link round-trips through the wallet real parser (ADR 0021 D6)', () => {
  // Any compressed secp256k1 point gives a valid address: the generator G.
  const g = Uint8Array.from(
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
      .match(/../g)
      ?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
  const second = publicKeyToAddress(g, getNetwork(NET));
  const link = buildPayDeepLink({
    intentId: ID,
    clientSecret: SECRET,
    outputs: [
      { address: ADDR, amount: '800' },
      { address: second, amount: '200' },
    ],
    amount: '1000',
    network: NET,
  });
  const parsed = parsePaymentRequest(link);
  expect(parsed?.address).toBeNull();
  expect(parsed?.amount).toBe(1000n);
  expect(parsed?.outputs).toEqual([
    { address: ADDR, amount: 800n },
    { address: second, amount: 200n },
  ]);
});
