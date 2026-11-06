import { test, expect } from 'bun:test';
import { validateAddress, getNetwork } from '@fairco.in/core';
import { KeyManager } from '@peable.to/pay';
import {
  formatPaymentOutputs,
  parsePaymentRequest,
  paymentRequestFromParams,
  paymentRequestRouteParams,
} from './payment-request';

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

const ADDR = 'FAHUJmcTfwvRYCcDXAzsu7YRiittDC8Jek';
const NET = validateAddress(ADDR, getNetwork('mainnet')) ? 'mainnet' : 'testnet';
const ID = 'pi_0123456789abcdef01234567';
const SECRET = `${ID}_secret_00112233445566778899aabbccddeeff`;

test('parses a well-formed peable://pay request', () => {
  const url = `peable://pay?intent=${ID}&secret=${SECRET}&address=${ADDR}&amount=150000000&network=${NET}`;
  const parsed = parsePaymentRequest(url);
  expect(parsed).not.toBeNull();
  expect(parsed?.intentId).toBe(ID);
  expect(parsed?.clientSecret).toBe(SECRET);
  expect(parsed?.address).toBe(ADDR);
  expect(parsed?.amount).toBe(150000000n);
  expect(parsed?.network).toBe(NET);
});

test('rejects malformed requests', () => {
  const bad = [
    `faircoin:${ADDR}?amount=1`,
    `peable://pay?intent=${ID}&address=${ADDR}&amount=1&network=${NET}`,
    `peable://pay?intent=${ID}&secret=pi_ffffffffffffffffffffffff_secret_x&address=${ADDR}&amount=1&network=${NET}`,
    `peable://pay?intent=${ID}&secret=${SECRET}&address=${ADDR}&amount=1.5&network=${NET}`,
    `peable://pay?intent=${ID}&secret=${SECRET}&address=${ADDR}&amount=0&network=${NET}`,
    `peable://pay?intent=${ID}&secret=${SECRET}&address=${ADDR}&amount=1&network=regtest`,
    `peable://pay?intent=${ID}&secret=${SECRET}&address=NOTANADDRESS&amount=1&network=${NET}`,
    `peable://payload?x=1`,
  ];
  for (const url of bad) {
    expect(parsePaymentRequest(url)).toBeNull();
  }
});

// A second and third valid address on the same network as ADDR (ADR 0021 D6).
const OTHERS = (() => {
  const keys = KeyManager.fromSeed(new Uint8Array(64).fill(3), getNetwork(NET));
  return keys.getExternalAddresses().slice(0, 2);
})();
const ADDR_B = OTHERS[0] ?? '';
const ADDR_C = OTHERS[1] ?? '';

test('the legacy one-address form is one output', () => {
  const parsed = parsePaymentRequest(
    `peable://pay?intent=${ID}&secret=${SECRET}&address=${ADDR}&amount=150000000&network=${NET}`,
  );
  expect(parsed?.outputs).toEqual([{ address: ADDR, amount: 150000000n }]);
});

test('parses a multi-output request: every output, summing to the amount', () => {
  const outputs = `${ADDR}:100,${ADDR_B}:250,${ADDR_C}:650`;
  const parsed = parsePaymentRequest(
    `peable://pay?intent=${ID}&secret=${SECRET}&amount=1000&network=${NET}&outputs=${encodeURIComponent(outputs)}`,
  );
  expect(parsed).not.toBeNull();
  expect(parsed?.address).toBeNull();
  expect(parsed?.amount).toBe(1000n);
  expect(parsed?.outputs).toEqual([
    { address: ADDR, amount: 100n },
    { address: ADDR_B, amount: 250n },
    { address: ADDR_C, amount: 650n },
  ]);
  // Round trip through the approve screen's route params.
  expect(paymentRequestFromParams(paymentRequestRouteParams(must(parsed)))).toEqual(must(parsed));
  expect(formatPaymentOutputs(must(parsed).outputs)).toBe(outputs);
});

test('rejects a multi-output request that is not exactly one payment', () => {
  const base = `peable://pay?intent=${ID}&secret=${SECRET}&network=${NET}`;
  const bad = [
    // The sum disagrees with the amount.
    `${base}&amount=999&outputs=${ADDR}:100,${ADDR_B}:900`,
    // An address twice.
    `${base}&amount=200&outputs=${ADDR}:100,${ADDR}:100`,
    // A zero or non-integer amount.
    `${base}&amount=100&outputs=${ADDR}:100,${ADDR_B}:0`,
    `${base}&amount=101&outputs=${ADDR}:100,${ADDR_B}:1.0`,
    // An invalid address, or no amount at all.
    `${base}&amount=200&outputs=${ADDR}:100,NOTANADDRESS:100`,
    `${base}&amount=100&outputs=${ADDR}`,
    // Both forms, or more than 50 outputs.
    `${base}&amount=100&address=${ADDR}&outputs=${ADDR}:100`,
    `${base}&amount=51&outputs=${Array.from({ length: 51 }, () => `${ADDR}:1`).join(',')}`,
  ];
  for (const url of bad) {
    expect(parsePaymentRequest(url)).toBeNull();
  }
});

test('route params from a direct navigation are validated like the link', () => {
  expect(
    paymentRequestFromParams({ intent: ID, secret: SECRET, amount: '1', network: NET }),
  ).toBeNull();
  expect(
    paymentRequestFromParams({
      intent: ID,
      secret: SECRET,
      address: ADDR,
      amount: '5',
      network: NET,
    }),
  ).toMatchObject({ address: ADDR, outputs: [{ address: ADDR, amount: 5n }] });
});
