import { test, expect } from 'bun:test';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../../server';

test('actual gateway allows anonymous checkout operation header and Peable management, rejects lookalike origins', async () => {
  const gateway = createGateway();
  gateway.httpServer.listen(0);
  const base = `http://127.0.0.1:${(gateway.httpServer.address() as AddressInfo).port}`;
  try {
    for (const origin of [
      'https://checkout.peable.to',
      'https://peable.to',
      'https://checkout.peable.to.attacker.example',
    ]) {
      const response = await fetch(`${base}/v1/payment_links/link_example/payment_intent`, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type,idempotency-key',
        },
      });
      expect(response.status).toBe(204);
      if (origin.endsWith('attacker.example'))
        expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
      else {
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
        expect(response.headers.get('Access-Control-Allow-Headers')).toContain('idempotency-key');
      }
    }
  } finally {
    gateway.io.close();
    gateway.httpServer.close();
  }
});
