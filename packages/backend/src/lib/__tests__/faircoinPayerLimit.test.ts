/**
 * The per-payer FairCoin limit is keyed by the client's NETWORK, not its exact
 * address (ADR 0021 D9, review round 4): an IPv6 host is handed a /64 or a /56
 * and could otherwise rotate through it for a fresh budget each request.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  createFaircoinPayerLimit,
  FAIRCOIN_PAYER_MAX,
  passesLimit,
  payerNetworkKey,
} from '../faircoinPayerLimit';

describe('payerNetworkKey', () => {
  test('an IPv4 address is its own key', () => {
    expect(payerNetworkKey('203.0.113.7')).toBe('203.0.113.7');
    expect(payerNetworkKey('203.0.113.8')).toBe('203.0.113.8');
  });

  test('an IPv4-mapped IPv6 address is the IPv4 address, in every spelling', () => {
    expect(payerNetworkKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(payerNetworkKey('::FFFF:203.0.113.7')).toBe('203.0.113.7');
    expect(payerNetworkKey('::ffff:cb00:7107')).toBe('203.0.113.7');
    expect(payerNetworkKey('0:0:0:0:0:ffff:203.0.113.7')).toBe('203.0.113.7');
    // Two mapped clients stay two payers.
    expect(payerNetworkKey('::ffff:203.0.113.8')).toBe('203.0.113.8');
  });

  test('an IPv6 address is its /56: rotating inside it is one payer', () => {
    const key = payerNetworkKey('2001:db8:aa:bb01::1');
    expect(key).toBe('2001:db8:aa:bb00:0:0:0:0/56');
    // Another interface id, another /64 of the same /56, another spelling.
    expect(payerNetworkKey('2001:db8:aa:bb01:dead:beef:1:2')).toBe(key);
    expect(payerNetworkKey('2001:db8:aa:bbff::9')).toBe(key);
    expect(payerNetworkKey('2001:0DB8:00AA:BB42:0000:0000:0000:0001')).toBe(key);
    expect(payerNetworkKey('2001:db8:aa:bb01::1%eth0')).toBe(key);
  });

  test('the next /56 is another payer', () => {
    expect(payerNetworkKey('2001:db8:aa:bc00::1')).toBe('2001:db8:aa:bc00:0:0:0:0/56');
    expect(payerNetworkKey('2001:db8:ab:bb01::1')).not.toBe(payerNetworkKey('2001:db8:aa:bb01::1'));
  });

  test('the same masking as @oxy.so/core: a /56 boundary inside a hextet, and an embedded IPv4 tail', () => {
    // Bits 48-55 kept, 56-63 dropped: the fourth hextet keeps its high byte.
    expect(payerNetworkKey('1:2:3:4567::')).toBe('1:2:3:4500:0:0:0:0/56');
    expect(payerNetworkKey('64:ff9b::203.0.113.7')).toBe('64:ff9b:0:0:0:0:0:0/56');
  });

  test('nothing to key on, or not an address, is left as it is', () => {
    expect(payerNetworkKey(undefined)).toBe('unknown');
    expect(payerNetworkKey('')).toBe('unknown');
    expect(payerNetworkKey('not-an-ip')).toBe('not-an-ip');
  });
});

describe('createFaircoinPayerLimit', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(() => {
    const app = express();
    // One proxy hop, as behind the ALB: `req.ip` is the forwarded client.
    app.set('trust proxy', 1);
    const limiter = createFaircoinPayerLimit();
    app.post('/pay', async (req, res) => {
      if (!(await passesLimit(limiter, req, res))) return;
      res.status(204).end();
    });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  const payFrom = async (client: string) =>
    (await fetch(`${baseUrl}/pay`, { method: 'POST', headers: { 'X-Forwarded-For': client } }))
      .status;

  test('a host rotating its IPv6 address through its /56 shares one budget; another network does not', async () => {
    for (let i = 0; i < FAIRCOIN_PAYER_MAX; i += 1) {
      // A different /64 and interface id every time, all in 2001:db8:1:200::/56.
      expect(await payFrom(`2001:db8:1:2${i.toString(16).padStart(2, '0')}::${i + 1}`)).toBe(204);
    }
    expect(await payFrom('2001:db8:1:2ff::abcd')).toBe(429);
    expect(await payFrom('2001:db8:1:300::1')).toBe(204);
    expect(await payFrom('198.51.100.1')).toBe(204);
  });
});
