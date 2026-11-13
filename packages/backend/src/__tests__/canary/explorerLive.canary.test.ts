/** Read-only operational reachability, separate from deterministic client CI.
 * Opt in explicitly; keep the production 10s request bound and 20s test bound. */
import { expect, test } from 'bun:test';
import { getTip } from '../../services/explorer';

test.skipIf(process.env.CANARY_EXPLORER_LIVE !== '1')(
  'live mainnet Explorer returns a positive authoritative tip',
  async () => {
    expect(await getTip('mainnet')).toBeGreaterThan(0);
  },
  20000,
);
