import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// A local terminal page only. It neither inspects provider state nor grants access.
const directory = join(homedir(), '.local/share/peable-stripe-test/tls');
const [key, cert] = await Promise.all([
  readFile(join(directory, 'localhost.key')),
  readFile(join(directory, 'localhost.crt')),
]);
const server = createServer({ key, cert }, (_request, response) => {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Local test checkout</title><h1>Returned from test checkout</h1><p>Check the signed webhook and subscription readback in Peable to verify the outcome. This page grants no access.</p></html>',
  );
});
server.listen(4311, '127.0.0.1', () =>
  console.info('Local test return page: https://127.0.0.1:4311/return (self-signed certificate)'),
);
process.once('SIGTERM', () => server.close());
process.once('SIGINT', () => server.close());
