/**
 * A FairCoin node's JSON-RPC, for the testnet canary only
 * (`docs/audits/2026-11-06-mainnet-gate/`).
 *
 * The credentials are read from the node's own `faircoin.conf`, named by
 * `CANARY_NODE_CONF`, so they never travel through an environment variable, a
 * command line or a log.
 */
import { readFileSync } from 'node:fs';

export interface FaircoinNode {
  call<T>(method: string, params?: readonly unknown[]): Promise<T>;
}

export function nodeFromConf(confPath: string): FaircoinNode {
  const conf = new Map<string, string>();
  for (const line of readFileSync(confPath, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) conf.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const user = conf.get('rpcuser');
  const password = conf.get('rpcpassword');
  const port = conf.get('rpcport');
  if (!user || !password || !port)
    throw new Error(`${confPath} names no rpcuser/rpcpassword/rpcport`);
  const url = `http://127.0.0.1:${port}/`;
  const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  return {
    async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization },
        body: JSON.stringify({ jsonrpc: '1.0', id: method, method, params }),
      });
      const body = (await response.json()) as { result: T; error: { message: string } | null };
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result;
    },
  };
}

/** Mine `count` blocks on the node's own wallet (testnet PoW phase only). */
export async function mine(node: FaircoinNode, count: number): Promise<number> {
  const start = await node.call<number>('getblockcount');
  await node.call('setgenerate', [true, 1]);
  try {
    for (let waited = 0; waited < 600_000; waited += 250) {
      if ((await node.call<number>('getblockcount')) >= start + count) break;
      await Bun.sleep(250);
    }
  } finally {
    await node.call('setgenerate', [false]);
  }
  return node.call<number>('getblockcount');
}
