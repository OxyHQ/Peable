import { test, expect } from 'bun:test';
import { validateAddress, getNetwork } from '@fairco.in/core';
import { parsePaymentRequest } from './payment-request';

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
