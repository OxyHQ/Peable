import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Io } from '../src/io.js';

/** A captured terminal: what a command printed, and the answers it is given. */
export interface TestIo extends Io {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly abort: () => void;
  /** Every stdout and stderr line, in one string, for "never printed" assertions. */
  printed(): string;
}

export function testIo(
  env: NodeJS.ProcessEnv,
  answers: { prompt?: string; secret?: string } = {},
): TestIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const controller = new AbortController();
  return {
    env,
    stdout,
    stderr,
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
    prompt: async () => answers.prompt ?? '',
    readSecret: async () => answers.secret ?? '',
    interrupt: controller.signal,
    abort: () => controller.abort(),
    printed: () => [...stdout, ...stderr].join('\n'),
  };
}

/** A temporary HOME for one case; removed by `cleanup`. */
export async function tempHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(join(tmpdir(), 'peable-cli-'));
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

export interface Received {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

export type Route = (request: Received, response: ServerResponse) => void | Promise<void>;

/** A local HTTP server answering through `route`, recording every request. */
export async function serve(
  route: Route,
): Promise<{ url: string; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      const entry: Received = {
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        body,
      };
      received.push(entry);
      void route(entry, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    received,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Request-Id': 'req_test' });
  response.end(JSON.stringify(body));
}

/** The Oxy mint's answer, as the SDK expects it. */
export function mintToken(response: ServerResponse): void {
  json(response, 200, { data: { token: 'svc_token', expiresIn: 3600 } });
}

export const merchant = (livemode: boolean) => ({
  id: 'merch_test',
  object: 'merchant',
  livemode,
  oxy_app_id: 'app_1',
  environment: livemode ? 'production' : 'development',
  network: livemode ? 'mainnet' : 'testnet',
  xpub: 'tpub',
  required_confirmations: 1,
  display_name: 'Test Shop',
  created: 1,
});
