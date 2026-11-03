import { test, expect } from 'bun:test';
import { signWebhook, verifyWebhook } from '../webhookSigner';

const SECRET = 'whsec_test_secret';
const RAW_BODY = JSON.stringify({ id: 'evt_123', type: 'payment_intent.succeeded' });
const TIMESTAMP = 1700000000;
const TOLERANCE_SEC = 300;
// Stable vector: HMAC-SHA256 over `${TIMESTAMP}.${RAW_BODY}` keyed by SECRET.
const EXPECTED_HEADER =
  't=1700000000,v1=4a444f0b337026383657499c82ee16800bfbef2ca4a9c2391a7c1e21f262d969';

test('signWebhook produces a stable Stripe-style signature header', () => {
  expect(signWebhook(SECRET, RAW_BODY, TIMESTAMP)).toBe(EXPECTED_HEADER);
});

test('verifyWebhook accepts a valid header within tolerance', () => {
  const header = signWebhook(SECRET, RAW_BODY, TIMESTAMP);
  expect(verifyWebhook(SECRET, RAW_BODY, header, TOLERANCE_SEC, TIMESTAMP + 10)).toBe(true);
});

test('verifyWebhook rejects a tampered body', () => {
  const header = signWebhook(SECRET, RAW_BODY, TIMESTAMP);
  const tampered = JSON.stringify({
    id: 'evt_123',
    type: 'payment_intent.succeeded',
    amount: '999',
  });
  expect(verifyWebhook(SECRET, tampered, header, TOLERANCE_SEC, TIMESTAMP + 10)).toBe(false);
});

test('verifyWebhook rejects a stale timestamp beyond tolerance', () => {
  const header = signWebhook(SECRET, RAW_BODY, TIMESTAMP);
  expect(
    verifyWebhook(SECRET, RAW_BODY, header, TOLERANCE_SEC, TIMESTAMP + TOLERANCE_SEC + 1),
  ).toBe(false);
});

test('verifyWebhook rejects a future timestamp beyond tolerance', () => {
  const header = signWebhook(SECRET, RAW_BODY, TIMESTAMP);
  expect(
    verifyWebhook(SECRET, RAW_BODY, header, TOLERANCE_SEC, TIMESTAMP - TOLERANCE_SEC - 1),
  ).toBe(false);
});

test('verifyWebhook rejects a header with a wrong v1 signature', () => {
  const wrong = `t=${TIMESTAMP},v1=${'0'.repeat(64)}`;
  expect(verifyWebhook(SECRET, RAW_BODY, wrong, TOLERANCE_SEC, TIMESTAMP + 10)).toBe(false);
});

test('verifyWebhook rejects a malformed header', () => {
  expect(verifyWebhook(SECRET, RAW_BODY, 'not-a-signature', TOLERANCE_SEC, TIMESTAMP)).toBe(false);
});

test('verifyWebhook rejects a v1 of an unequal length without throwing', () => {
  const shortSig = `t=${TIMESTAMP},v1=deadbeef`;
  expect(verifyWebhook(SECRET, RAW_BODY, shortSig, TOLERANCE_SEC, TIMESTAMP)).toBe(false);
});

test('signWebhook with two secrets carries one v1 per secret, the first unchanged', () => {
  const header = signWebhook([SECRET, 'whsec_previous'], RAW_BODY, TIMESTAMP);
  expect(header.startsWith(EXPECTED_HEADER)).toBe(true);
  expect(header.split(',').filter((part) => part.startsWith('v1='))).toHaveLength(2);
});

test('verifyWebhook accepts a dual-signed header with EITHER secret (rotation overlap)', () => {
  const header = signWebhook(['whsec_new', 'whsec_old'], RAW_BODY, TIMESTAMP);
  expect(verifyWebhook('whsec_new', RAW_BODY, header, TOLERANCE_SEC, TIMESTAMP)).toBe(true);
  expect(verifyWebhook('whsec_old', RAW_BODY, header, TOLERANCE_SEC, TIMESTAMP)).toBe(true);
  expect(verifyWebhook('whsec_other', RAW_BODY, header, TOLERANCE_SEC, TIMESTAMP)).toBe(false);
});

test('verifyWebhook accepts a list of receiver secrets when any one matches', () => {
  const header = signWebhook('whsec_new', RAW_BODY, TIMESTAMP);
  expect(
    verifyWebhook(['whsec_old', 'whsec_new'], RAW_BODY, header, TOLERANCE_SEC, TIMESTAMP),
  ).toBe(true);
  expect(verifyWebhook(['whsec_old', ''], RAW_BODY, header, TOLERANCE_SEC, TIMESTAMP)).toBe(false);
});

test('signWebhook refuses an empty secret list', () => {
  expect(() => signWebhook([], RAW_BODY, TIMESTAMP)).toThrow();
});
