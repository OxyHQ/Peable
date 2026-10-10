import { test, expect } from 'bun:test';
import { signWebhook, verifyWebhook } from '../webhookSigner';

const SECRET = 'whsec_test_secret';
const RAW_BODY = JSON.stringify({ id: 'evt_123', type: 'payment_intent.settled' });
const TIMESTAMP = 1700000000;
const TOLERANCE_SEC = 300;
// Stable vector: HMAC-SHA256 over `${TIMESTAMP}.${RAW_BODY}` keyed by SECRET.
const EXPECTED_HEADER =
  't=1700000000,v1=02b01667b628438dddffe52578043279a46c4411afabc2b83998986bb312ef33';

test('signWebhook produces a stable Stripe-style signature header', () => {
  expect(signWebhook(SECRET, RAW_BODY, TIMESTAMP)).toBe(EXPECTED_HEADER);
});

test('verifyWebhook accepts a valid header within tolerance', () => {
  const header = signWebhook(SECRET, RAW_BODY, TIMESTAMP);
  expect(verifyWebhook(SECRET, RAW_BODY, header, TOLERANCE_SEC, TIMESTAMP + 10)).toBe(true);
});

test('verifyWebhook rejects a tampered body', () => {
  const header = signWebhook(SECRET, RAW_BODY, TIMESTAMP);
  const tampered = JSON.stringify({ id: 'evt_123', type: 'payment_intent.settled', amount: '999' });
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
