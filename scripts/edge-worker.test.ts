import { expect, test } from 'bun:test';

const entries = ['../packages/frontend/worker/index.js', '../packages/checkout/worker/index.js'];
for (const entry of entries) {
  test(`${entry}: returns the asset response unchanged`, async () => {
    const worker = (await import(entry)).default;
    const response = new Response('asset', {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public,max-age=31536000,immutable',
      },
    });
    const result = await worker.fetch(
      new Request('https://example.com/private-image.png?user=secret'),
      { ASSETS: { fetch: async () => response } },
      { waitUntil: () => {} },
    );
    expect(result.status).toBe(200);
    expect(result.headers.get('Content-Type')).toBe('image/png');
    expect(result.headers.get('Cache-Control')).toContain('immutable');
    expect(await result.text()).toBe('asset');
  });
  test(`${entry}: asset failures preserve the original error`, async () => {
    const worker = (await import(entry)).default;
    const error = new Error('asset failure');
    await expect(
      worker.fetch(
        new Request('https://example.com/file.png'),
        {
          ASSETS: {
            fetch: async () => {
              throw error;
            },
          },
        },
        { waitUntil: () => {} },
      ),
    ).rejects.toBe(error);
  });
}

// The wallet's Worker (peable.to) owns the cache policy of the Expo export's
// content-hashed files: a year, immutable, and never for the SPA shell that the
// asset server returns for a hashed name this deploy lacks.
const frontend = '../packages/frontend/worker/index.js';
const HASHED = 'https://peable.to/_expo/static/js/web/entry-0123456789abcdef0123456789abcdef.js';
const assets = (response: Response) => ({ ASSETS: { fetch: async () => response } });

test(`${frontend}: a hashed asset is immutable for a year, body and type intact`, async () => {
  const worker = (await import(frontend)).default;
  const result = await worker.fetch(
    new Request(HASHED),
    assets(
      new Response('js', {
        headers: {
          'Content-Type': 'application/javascript',
          'Cache-Control': 'public, max-age=0, must-revalidate',
          ETag: '"abc"',
        },
      }),
    ),
    { waitUntil: () => {} },
  );
  expect(result.status).toBe(200);
  expect(result.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  expect(result.headers.get('Content-Type')).toBe('application/javascript');
  expect(result.headers.get('ETag')).toBe('"abc"');
  expect(await result.text()).toBe('js');
});

test(`${frontend}: a hashed-asset miss is an uncached 404, never the SPA shell`, async () => {
  const worker = (await import(frontend)).default;
  const result = await worker.fetch(
    new Request(HASHED),
    assets(
      new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    ),
    { waitUntil: () => {} },
  );
  expect(result.status).toBe(404);
  expect(result.headers.get('Cache-Control')).toBe('no-store');
});

test(`${frontend}: the shell and unhashed files keep the asset server's policy`, async () => {
  const worker = (await import(frontend)).default;
  for (const path of ['/', '/@someone', '/manifest.json']) {
    const response = new Response('x', {
      headers: { 'Cache-Control': 'public, max-age=0, must-revalidate' },
    });
    const result = await worker.fetch(new Request(`https://peable.to${path}`), assets(response), {
      waitUntil: () => {},
    });
    expect(result).toBe(response);
  }
});
