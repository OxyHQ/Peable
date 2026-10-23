import { test, expect, beforeAll, afterAll } from 'bun:test';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { OxyServer } from '@oxy.so/core/server';
import { peableForOxyService, Peable } from '@peable.to/sdk';
import { PEABLE_SERVICE_AUDIENCE } from '../../oxy';
import { seedMerchant, useGatewayDatabase } from '../../__tests__/helpers/gatewayTestDatabase';
import { createPaymentIntentsRouter } from '../paymentIntents';

// Real TESTNET account xpub for the canonical all-"abandon" + "art" mnemonic —
// public-key-only, cannot spend. Same fixture used across the rest of the suite.
const XPUB =
  'DRKVrRr8WgU4mARJnCLAp77sKJ5h5K79VH8sredx2qPY8BUKogTYqoAXdTAzzvS5MgBDGGWb2Zoa2AwzoLRsbGGkBm1q2r7QSfRYWCizWfvMfPZn';
const APP_ID = 'app_wiring';
const KID = 'wiring-test-key';
const live = new Map<string, Record<string, unknown>>();
let receiverOxy: OxyServer;

// Oxy signs service tokens with Ed25519 under a published kid (oxy ADR 0012).
// This stands in for oxy-api: it serves the public half at the SAME path the
// SDK derives from its base URL, and mints with the private half.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
// A second key, never published: a token it signs must not verify.
const { privateKey: strangerKey } = generateKeyPairSync('ed25519');

function b64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

function servicePayload(claims: Record<string, unknown>): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  return b64url(
    JSON.stringify({
      iat: issuedAt,
      exp: issuedAt + 300,
      type: 'service',
      iss: 'oxy-auth',
      aud: 'oxy-api',
      tier: claims.authority === 'first_party' ? 'internal' : 'external',
      credentialId: 'cred_wiring',
      ownerAccountId: 'acct_wiring',
      environment: 'development',
      ...claims,
    }),
  );
}

// Shaped like what `POST /auth/service-token` mints: EdDSA, `typ`, `kid`.
function signServiceToken(
  claims: Record<string, unknown>,
  key: typeof privateKey = privateKey,
): string {
  const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: KID }));
  const payload = servicePayload(claims);
  const signature = sign(null, Buffer.from(`${header}.${payload}`), key);
  const token = `${header}.${payload}.${b64url(signature)}`;
  const p: Record<string, unknown> = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const authority = p.authority === 'first_party' ? 'first_party' : 'external';
  live.set(token, {
    active: true,
    kind: 'service',
    authority,
    applicationId: p.appId,
    credentialId: p.credentialId,
    accountId: p.ownerAccountId,
    environment: p.environment,
    audience: p.aud,
    expiresAt: new Date(Number(p.exp) * 1000).toISOString(),
    ...(authority === 'external' ? { scopes: p.scopes ?? [] } : {}),
  });
  return token;
}

// The retired shape: HS256 over a shared secret. Nothing in Peable holds that
// secret any more, and no secret should make one of these acceptable.
function signLegacyHs256Token(claims: Record<string, unknown>, secret: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = servicePayload(claims);
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

let jwksServer: Server;
let server: Server;
let baseUrl: string;

useGatewayDatabase();

beforeAll(async () => {
  await seedMerchant({
    publicId: 'merch_test0000000000000001',
    oxyAppId: APP_ID,
    environment: 'development',
    network: 'testnet',
    xpub: XPUB,
  });

  const jwks = express().use(express.json());
  jwks.post('/auth/resources/introspect', (req, res) => {
    if (req.headers.authorization !== 'Bearer receiver-workload') return res.sendStatus(401);
    return res.json(live.get(req.body.token) ?? { active: false });
  });
  jwks.get('/.well-known/jwks.json', (_req, res) => {
    res.json({
      keys: [{ ...publicKey.export({ format: 'jwk' }), use: 'sig', alg: 'EdDSA', kid: KID }],
    });
  });
  jwksServer = jwks.listen(0);
  const oxyApi = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}`;

  // The same calls `server.ts` makes, with no options: verification is the
  // JWKS at the client's base URL and nothing else. A fresh client rather than
  // the `oxy` client, so its key cache is this file's alone.
  receiverOxy = new OxyServer({ baseURL: oxyApi });
  Object.defineProperty(receiverOxy, 'platformServiceToken', {
    value: async () => 'receiver-workload',
  });
  const requireMerchant = receiverOxy.middleware.service({
    expectedAudience: PEABLE_SERVICE_AUDIENCE,
  });
  const optionalServiceAuth = receiverOxy.middleware.auth({
    optional: true,
    expectedAudience: PEABLE_SERVICE_AUDIENCE,
  });

  const app = express();
  app.use(express.json());
  app.use(createPaymentIntentsRouter({ requireMerchant, optionalServiceAuth }));
  server = app.listen(0);
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  receiverOxy.dispose();
  for (const s of [server, jwksServer]) {
    await new Promise<void>((resolve, reject) => {
      s.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test("an EdDSA service token signed by a key in Oxy's JWKS is accepted", async () => {
  const token = signServiceToken({
    appId: APP_ID,
    appName: 'wiring-test',
    scopes: ['payments:write'],
  });
  const res = await fetch(`${baseUrl}/v1/payment_intents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'wiring-1',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ amount: '1000000', network: 'testnet' }),
  });
  expect(res.status).toBe(201);
});

test('a token signed by a key NOT in the JWKS is rejected (401) — proves verification is really wired, not bypassed', async () => {
  const token = signServiceToken({ appId: APP_ID, appName: 'wiring-test' }, strangerKey);
  const res = await fetch(`${baseUrl}/v1/payment_intents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'wiring-2',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ amount: '1000000', network: 'testnet' }),
  });
  expect(res.status).toBe(401);
});

test('a retired HS256 service token is refused, whatever secret signed it', async () => {
  const token = signLegacyHs256Token(
    { appId: APP_ID, appName: 'wiring-test', scopes: ['payments:write'] },
    'any-shared-secret',
  );
  const res = await fetch(`${baseUrl}/v1/payment_intents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'wiring-4',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ amount: '1000000', network: 'testnet' }),
  });
  // 403 on core 1.x (no legacy secret configured), 401 on core 2.x (no HS256
  // branch at all). Either way the request never reaches the handler.
  expect([401, 403]).toContain(res.status);
});

test('no Authorization header at all is rejected (401), the endpoint is not silently open', async () => {
  const res = await fetch(`${baseUrl}/v1/payment_intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'wiring-3' },
    body: JSON.stringify({ amount: '1000000', network: 'testnet' }),
  });
  expect(res.status).toBe(401);
});

// The published receiver rejects a signed credential beyond the issuer's five-minute bound.
test('a correctly signed service token with a 301-second lifetime is rejected', async () => {
  const iat = Math.floor(Date.now() / 1000);
  const token = signServiceToken({
    appId: APP_ID,
    scopes: ['payments:write'],
    iat,
    exp: iat + 301,
  });
  const res = await fetch(`${baseUrl}/v1/payment_intents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'wiring-overlong',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ amount: '1000000', network: 'testnet' }),
  });
  expect(res.status).toBe(401);
});

test('own SDK workload transport has no scopes and still binds merchant and environment', async () => {
  const oxy = new OxyServer({ baseURL: 'https://api.oxy.invalid' });
  let claims: Record<string, unknown> = {
    appId: APP_ID,
    appName: 'own',
    authority: 'first_party',
    credentialId: 'wl_own',
    aud: PEABLE_SERVICE_AUDIENCE,
  };
  Object.defineProperty(oxy, 'workloadServiceToken', {
    value: async (audience: string) => {
      expect(audience).toBe(PEABLE_SERVICE_AUDIENCE);
      return signServiceToken(claims);
    },
  });
  const client = peableForOxyService({ oxy, baseURL: baseUrl });
  try {
    const intent = await client.paymentIntents.create(
      { amount: '1000000', network: 'testnet' },
      { idempotencyKey: 'own-sdk-intent' },
    );
    expect(intent.id.startsWith('pi_')).toBe(true);
    claims = { ...claims, appId: 'unbound-merchant' };
    await expect(client.paymentIntents.retrieve(intent.id)).rejects.toMatchObject({
      statusCode: 403,
    });
    claims = { ...claims, appId: APP_ID, environment: 'production' };
    await expect(client.paymentIntents.retrieve(intent.id)).rejects.toMatchObject({
      statusCode: 403,
    });
    claims = { ...claims, environment: 'development', aud: 'oxy-service:other-product' };
    await expect(client.paymentIntents.retrieve(intent.id)).rejects.toMatchObject({
      statusCode: 401,
    });
  } finally {
    client.dispose();
    oxy.dispose();
  }
});

test('official external customer tokens keep legacy audience, scopes and live revocation', async () => {
  const token = signServiceToken({
    appId: APP_ID,
    appName: 'Official app key',
    tier: 'internal',
    authority: 'external',
    scopes: ['payments:read'],
  });
  const client = new Peable({
    baseURL: baseUrl,
    tokenProvider: { getToken: async () => token, invalidate() {} },
  });
  await expect(
    client.paymentIntents.create(
      { amount: '1000000', network: 'testnet' },
      { idempotencyKey: 'external-no-write' },
    ),
  ).rejects.toMatchObject({ statusCode: 403 });
  live.delete(token);
  await expect(client.paymentIntents.retrieve('pi_missing')).rejects.toMatchObject({
    statusCode: 401,
  });
  client.dispose();
});

test('own authority is refused after live revocation', async () => {
  const token = signServiceToken({
    appId: APP_ID,
    appName: 'Own',
    authority: 'first_party',
    credentialId: 'wl_own',
    aud: PEABLE_SERVICE_AUDIENCE,
  });
  live.delete(token);
  expect(
    (
      await fetch(`${baseUrl}/v1/payment_intents/pi_missing`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
  ).toBe(401);
});

test('own merchant identity cannot stand in for an unproven requester account', async () => {
  const token = signServiceToken({
    appId: APP_ID,
    appName: 'Own',
    authority: 'first_party',
    credentialId: 'wl_proof',
    aud: PEABLE_SERVICE_AUDIENCE,
  });
  expect(
    (
      await fetch(`${baseUrl}/v1/payment_intents/pi_missing`, {
        headers: {
          authorization: `Bearer ${token}`,
          'X-Oxy-User-Id': 'another-account',
          'X-Oxy-Requester-Context': 'unproven-context',
        },
      })
    ).status,
  ).toBe(403);
});
