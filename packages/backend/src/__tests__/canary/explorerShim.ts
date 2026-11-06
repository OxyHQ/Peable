/**
 * The FairCoin Explorer's HTTP API, answered from a private testnet node — the
 * testnet canary's chain (`docs/audits/2026-11-06-mainnet-gate/`).
 *
 * The public testnet has no chain to pay on (the Explorer reports height 0 and
 * no peers, and its DNS seeds do not resolve, 2026-11-06), so the canary runs
 * its own node and serves the endpoints the gateway (`services/explorer.ts`)
 * and `@peable.to/pay` read, in the Explorer's shapes. `/api/price` is the REAL
 * Explorer's, so a fiat quote is priced at the live FAIR/USD rate.
 *
 *   CANARY_NODE_CONF=<faircoin.conf> bun src/__tests__/canary/explorerShim.ts <port>
 */
import { nodeFromConf } from './faircoinNode';

const confPath = process.env.CANARY_NODE_CONF;
if (!confPath) throw new Error('CANARY_NODE_CONF names the node faircoin.conf');
const node = nodeFromConf(confPath);
const LIVE_EXPLORER = 'https://explorer.fairco.in';

interface RawVout {
  value: number;
  n: number;
  scriptPubKey: { type: string; hex: string; addresses?: string[] };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.argv[2] ?? 46480),
  async fetch(request) {
    const url = new URL(request.url);
    const network = url.searchParams.get('network');
    if (url.pathname === '/api/price') {
      // Re-served as JSON: the upstream's content-encoding must not ride along
      // on a body that was already decoded.
      const live = await fetch(`${LIVE_EXPLORER}/api/price`);
      return json(await live.json(), live.status);
    }
    if (network !== 'testnet') return json({ error: 'the canary chain is testnet' }, 400);
    try {
      if (url.pathname === '/api/stats') {
        return json({ stats: { blockHeight: await node.call<number>('getblockcount') }, network });
      }
      if (url.pathname === '/api/fee-estimate') {
        return json({ feePerKb: 0.0001, feePerByte: 10, network });
      }
      const tx = url.pathname.match(/^\/api\/transaction\/([0-9a-f]{64})$/);
      if (tx) {
        const raw = await node.call<{ txid: string; confirmations?: number; vout: RawVout[] }>(
          'getrawtransaction',
          [tx[1], 1],
        );
        return json({
          transaction: { txid: raw.txid, confirmations: raw.confirmations ?? 0, vout: raw.vout },
          network,
        });
      }
      const address = url.pathname.match(/^\/api\/address\/([1-9A-HJ-NP-Za-km-z]+)$/);
      if (address) {
        const query = { addresses: [address[1]] };
        const [utxos, txids] = await Promise.all([
          node.call<unknown[]>('getaddressutxos', [query]),
          node.call<string[]>('getaddresstxids', [query]),
        ]);
        return json({ addressInfo: { txCount: txids.length, utxos }, network });
      }
      if (url.pathname === '/api/tx/broadcast' && request.method === 'POST') {
        const { hex } = (await request.json()) as { hex: string };
        return json({ txid: await node.call<string>('sendrawtransaction', [hex]) });
      }
      return json({ error: 'not found' }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  },
});
console.log(`explorer shim on http://127.0.0.1:${server.port}`);
