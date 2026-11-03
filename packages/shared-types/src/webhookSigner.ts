import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Compute the hex HMAC-SHA256 of the signed payload `${timestamp}.${rawBody}`.
 * The signed payload binds the timestamp to the body so a captured signature
 * cannot be replayed against a different body or a shifted timestamp.
 */
function computeSignature(secret: string, rawBody: string, timestamp: number): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/**
 * Produce a Stripe-style signature header for an outbound webhook:
 * `t=${timestamp},v1=${hex}` — with one `v1=` per secret.
 *
 * Several secrets are what make a rotation gapless: while an endpoint's rolled
 * secret is still inside its overlap window, every delivery is signed with
 * BOTH, so a receiver verifying with either one accepts it.
 */
export function signWebhook(
  secret: string | readonly string[],
  rawBody: string,
  timestamp: number,
): string {
  const secrets = typeof secret === 'string' ? [secret] : secret;
  if (secrets.length === 0) throw new Error('signWebhook needs at least one secret');
  const signatures = secrets.map((s) => `v1=${computeSignature(s, rawBody, timestamp)}`);
  return `t=${timestamp},${signatures.join(',')}`;
}

interface ParsedHeader {
  timestamp: number;
  signatures: string[];
}

function parseHeader(header: string): ParsedHeader | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't') {
      const parsed = Number(value);
      if (Number.isInteger(parsed)) timestamp = parsed;
    } else if (key === 'v1') {
      signatures.push(value);
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/**
 * Constant-time hex-string comparison. Returns false for unequal-length inputs
 * (timingSafeEqual throws on mismatched buffer lengths) instead of throwing.
 */
function constantTimeEqualHex(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'hex');
  const bufferB = Buffer.from(b, 'hex');
  if (bufferA.length === 0 || bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Verify a webhook signature header against the raw body.
 *
 * - Parses `t` and EVERY `v1` from the header.
 * - Rejects if the timestamp drifts more than `toleranceSec` from `nowSec`.
 * - Accepts when any `v1` matches the signature computed with any of
 *   `secret` — so a receiver mid-rotation can pass both of its secrets, and a
 *   delivery signed during the sender's overlap window verifies against
 *   either.
 */
export function verifyWebhook(
  secret: string | readonly string[],
  rawBody: string,
  header: string,
  toleranceSec: number,
  nowSec: number,
): boolean {
  const parsed = parseHeader(header);
  if (parsed === null) return false;
  if (Math.abs(nowSec - parsed.timestamp) > toleranceSec) return false;
  const secrets = typeof secret === 'string' ? [secret] : secret;
  let matched = false;
  // Every comparison runs, so the time taken does not say which one matched.
  for (const candidate of secrets) {
    if (candidate.length === 0) continue;
    const expected = computeSignature(candidate, rawBody, parsed.timestamp);
    for (const signature of parsed.signatures) {
      if (constantTimeEqualHex(expected, signature)) matched = true;
    }
  }
  return matched;
}
