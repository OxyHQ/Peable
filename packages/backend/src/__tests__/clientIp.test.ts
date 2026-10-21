/**
 * `req.ip` on the real gateway app is the client, whether or not Cloudflare
 * proxies the hostname in front of the ALB. Every per-IP limit here
 * (`createOxyRateLimit`, the public limiter, `routes/social.ts`) keys on it.
 *
 * The request is built on the app's own `request` prototype, so this is
 * Express's real `req.ip` getter under the trust function `createGateway` set.
 */
import { afterAll, expect, test } from 'bun:test';
import type { Request } from 'express';
import { createGateway } from '../server';

const gateway = createGateway();

afterAll(() => {
  gateway.io.close();
});

function ipOf(peer: string, forwardedFor?: string): string | undefined {
  const socket = { remoteAddress: peer };
  const req = Object.create(gateway.app.request) as Request;
  Object.assign(req, {
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
    socket,
    connection: socket,
  });
  return req.ip;
}

test('DNS-only hostname: the ALB (private peer) appended the client', () => {
  expect(ipOf('10.0.1.23', '203.0.113.5')).toBe('203.0.113.5');
});

test('Cloudflare-proxied hostname: the ALB appended a Cloudflare edge, Cloudflare appended the client', () => {
  expect(ipOf('10.0.1.23', '203.0.113.5, 172.70.1.2')).toBe('203.0.113.5');
});

test('a forged left prefix is never believed', () => {
  expect(ipOf('10.0.1.23', '1.2.3.4, 203.0.113.5')).toBe('203.0.113.5');
  expect(ipOf('10.0.1.23', '1.2.3.4, 203.0.113.5, 172.70.1.2')).toBe('203.0.113.5');
});

test('a public socket peer is the client; its X-Forwarded-For is ignored', () => {
  expect(ipOf('198.51.100.7', '1.2.3.4')).toBe('198.51.100.7');
});
