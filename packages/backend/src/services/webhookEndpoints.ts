/**
 * Rules for a webhook endpoint that are not a column's: what URL may be
 * registered, and how a signing secret is minted (ADR 0014 D4).
 */
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { ALLOWED_PORTS, BLOCKED_HOSTNAMES, MAX_URL_LENGTH, isBlockedIp } from '@oxy.so/core/server';

/** 32 random bytes — the same strength as the HMAC-SHA256 key it is. */
const SECRET_ENTROPY_BYTES = 32;

/** A fresh signing secret. Peable mints it; a merchant never chooses one. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(SECRET_ENTROPY_BYTES).toString('hex')}`;
}

/**
 * Why `raw` cannot be a webhook endpoint, or `null` when it can.
 *
 * The SAME rules the dispatcher's `safeFetch` applies at delivery time, judged
 * now on what can be judged without DNS: a URL refused here is one every
 * delivery would refuse, so the merchant hears it from the create rather than
 * from a delivery log three days later. DNS is not resolved here — it can
 * change after the check — so a public name that resolves to a private address
 * is still refused per attempt by `safeFetch`.
 *
 * - `https` always; `http` only for a test-mode endpoint (Stripe's rule: live
 *   events carry real payment data and never travel in clear text).
 * - ports 80/443 only, no credentials in the URL, at most `MAX_URL_LENGTH`.
 * - no loopback/private/metadata IP literal and no blocked host name.
 */
export function webhookUrlProblem(raw: string, livemode: boolean): string | null {
  if (raw.length > MAX_URL_LENGTH) return `url must be at most ${MAX_URL_LENGTH} characters`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'url is not a valid URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'url must use https';
  }
  if (url.protocol === 'http:' && livemode) {
    return 'a live-mode webhook endpoint must use https';
  }
  if (url.username !== '' || url.password !== '') {
    return 'url must not carry credentials';
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!ALLOWED_PORTS.has(port)) {
    return `url must use port ${[...ALLOWED_PORTS].join(' or ')}`;
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (host === '' || BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost')) {
    return 'url must name a public host';
  }
  if (isIP(host) !== 0 && isBlockedIp(host)) {
    return 'url must not point at a private, loopback or reserved address';
  }
  return null;
}
