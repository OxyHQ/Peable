import { isIPv4, isIPv6 } from 'node:net';
import type { Request, RequestHandler, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { sendError } from './http';

/**
 * The per-PAYER bound on fresh FairCoin addresses from the anonymous payer
 * routes (ADR 0021 D9, amended 2026-11-06): a hosted checkout's FairCoin
 * confirm and a hosted invoice's FairCoin pay, keyed by the client address
 * (`req.ip`, which `oxyTrustProxy` makes the real client behind Cloudflare and
 * the ALB). Each such request may reserve a fresh address in the recipient's
 * wallet, whose watch set every address joins for ever; the recipient's own
 * daily bound (`services/faircoin/addressPool.ts`) is what no number of
 * payers can pass, and this keeps one payer from spending it alone.
 *
 * In front of the general public limiter (30 requests per 15 minutes per
 * client), counted only for FairCoin. In memory, so per task.
 *
 * Keyed by {@link payerNetworkKey}: an IPv6 client is one /56, as in
 * `@oxy.so/core`'s `createOxyRateLimit`, so a host rotating through its /64
 * (or its whole /56) is still one payer.
 */
export const FAIRCOIN_PAYER_WINDOW_MS = 60 * 60 * 1000;
export const FAIRCOIN_PAYER_MAX = 20;

export function createFaircoinPayerLimit(): RequestHandler {
  return rateLimit({
    windowMs: FAIRCOIN_PAYER_WINDOW_MS,
    limit: FAIRCOIN_PAYER_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => payerNetworkKey(req.ip ?? req.socket.remoteAddress),
    handler: (_req, res) => {
      sendError(
        res,
        429,
        'rate_limit_error',
        'too many FairCoin payments requested from this connection — try again later, or pay another way',
      );
    },
  });
}

/**
 * Run a limiter by hand, inside a handler that has already decided the request
 * counts; `true` when it let the request through (else it answered 429).
 */
export async function passesLimit(
  limiter: RequestHandler,
  req: Request,
  res: Response,
): Promise<boolean> {
  let through = false;
  await limiter(req, res, () => {
    through = true;
  });
  return through;
}

/**
 * The bits of an IPv6 client address that name ONE payer: the /56 an ISP hands
 * a site, the same prefix `@oxy.so/core`'s rate limiter buckets by.
 */
const IPV6_SUBNET_BITS = 56;

/**
 * The per-payer key of a client address (`req.ip`): an IPv4 address as is, an
 * IPv4-mapped IPv6 one (`::ffff:203.0.113.7`) as the IPv4 address it maps, and
 * any other IPv6 address as its /56 prefix (`2001:db8:aa:bb00::/56`), so the
 * 2^72 addresses one host can rotate through count as one payer.
 *
 * `@oxy.so/core` does not export its key helper (`createOxyRateLimit`'s
 * `hashAnonymousIp`, `dist/esm/server/rateLimit.js`), and this package's
 * `express-rate-limit` is v7, which has no `ipKeyGenerator`; the masking below
 * replicates core's `ipv6Hextets` / `maskIPv6` exactly (zone id dropped, `::`
 * expanded, an embedded dotted quad folded into two hextets, an unparseable
 * literal left as it is). It differs only in what it does not need: no HMAC
 * (the key never leaves this task's memory), and a mapped IPv4 address is
 * keyed as the IPv4 address, in any spelling — core keys a `::ffff:`-prefixed
 * literal unmasked, the same bucket per address, and folding it makes one
 * client one payer whichever socket family it arrived on.
 */
export function payerNetworkKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  if (!isIPv6(ip)) return ip;
  const hextets = ipv6Hextets(ip);
  if (!hextets) return ip;
  // `::ffff:a.b.c.d` in any spelling: the IPv4 client it maps.
  if (hextets.slice(0, 5).every((hextet) => hextet === 0) && hextets[5] === 0xffff) {
    const [high = 0, low = 0] = hextets.slice(6);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }
  return maskIPv6(ip, IPV6_SUBNET_BITS);
}

/** Expand an IPv6 literal (handling `::` and an embedded IPv4) to 8 numeric hextets, or null if unparseable. */
function ipv6Hextets(ip: string): number[] | null {
  let addr = ip;
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);
  const lastColon = addr.lastIndexOf(':');
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes('.')) {
    const v4 = addr.slice(lastColon + 1);
    if (!isIPv4(v4)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4.split('.').map((part) => Number.parseInt(part, 10));
    addr = `${addr.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 1) {
    groups = head;
  } else {
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return null;
    groups = [...head, ...new Array<string>(missing).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  const hextets = groups.map((group) => Number.parseInt(group || '0', 16));
  if (hextets.some((value) => Number.isNaN(value) || value < 0 || value > 0xffff)) return null;
  return hextets;
}

/** An IPv6 address masked to its /`bits` prefix, as `h:h:h:h:h:h:h:h/bits` (lowercase hex). */
function maskIPv6(ip: string, bits: number): string {
  const hextets = ipv6Hextets(ip);
  if (!hextets) return ip;
  const masked = hextets.map((hextet, index) => {
    const groupStart = index * 16;
    if (groupStart >= bits) return 0;
    const keepBits = Math.min(16, bits - groupStart);
    const mask = keepBits >= 16 ? 0xffff : (0xffff << (16 - keepBits)) & 0xffff;
    return hextet & mask;
  });
  return `${masked.map((hextet) => hextet.toString(16)).join(':')}/${bits}`;
}
