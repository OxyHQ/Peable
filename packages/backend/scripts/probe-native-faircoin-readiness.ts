/** Public, read-only probe. Does not create checkouts, sign or broadcast funds. */
import { EXPLORER_BASE_URL } from '@fairco.in/core';
import { readDisplayRates, convertDisplayAmount } from '../../sdk/src/display';
import { createExplorerFaircoinQuote } from '../src/services/billing/faircoin-fx';

const checks = {
  quote: () => createExplorerFaircoinQuote(2999),
  display: async () => {
    const rates = await readDisplayRates({ includeEur: true });
    return {
      rates,
      usdPrice: '29.99 USD',
      fairEstimate: convertDisplayAmount({
        units: '2999',
        currency: 'USD',
        displayCurrency: 'FAIR',
        rates,
      }),
      eurEstimate: convertDisplayAmount({
        units: '2999',
        currency: 'USD',
        displayCurrency: 'EUR',
        rates,
      }),
    };
  },
  mainnet: () => chain('mainnet'),
  testnet: () => chain('testnet'),
};

async function chain(network: string) {
  const response = await fetch(`${EXPLORER_BASE_URL}/api/stats?network=${network}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Peable/1.0' },
    signal: AbortSignal.timeout(8000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const body = (await response.json()) as {
    network?: unknown;
    stats?: { blockHeight?: unknown; connections?: unknown };
  };
  const height = body?.stats?.blockHeight;
  if (body?.network !== network || !Number.isSafeInteger(height))
    throw new Error('invalid_chain_response');
  return {
    network,
    blockHeight: height,
    connections: body.stats?.connections,
    initialized: typeof height === 'number' && height > 0,
  };
}

const results = await Promise.all(
  Object.entries(checks).map(async ([name, check]) => {
    try {
      return { name, ok: true, result: await check() };
    } catch (error) {
      return {
        name,
        ok: false,
        error: error instanceof Error ? error.message : 'probe_failed',
      };
    }
  }),
);
console.log(
  JSON.stringify(
    { checkedAt: new Date().toISOString(), readOnly: true, settlementVerified: false, results },
    null,
    2,
  ),
);
if (results.some((result) => !result.ok)) process.exitCode = 1;
