/**
 * Tests never reach the FairCoin Explorer or the ECB (ADR 0021 D4): every test
 * file starts with fixed, FRESH sources — 0.5 USD per FAIR, 1.25 USD per EUR —
 * read at the moment they are asked, so a quote is always fresh. A test about
 * staleness or an outage installs its own with `useQuoteSources`.
 */
import { useQuoteSources } from '../../services/faircoin/quote';

export const TEST_USD_PER_FAIR = '0.5';
export const TEST_USD_PER_EUR = '1.25';

useQuoteSources({
  readPrice: async () => ({ usdPerFair: TEST_USD_PER_FAIR, observedAt: new Date() }),
  readReferenceRates: async () => ({
    perEur: { EUR: '1', USD: TEST_USD_PER_EUR, GBP: '0.85', CHF: '0.95', JPY: '160' },
    observedAt: new Date(),
  }),
});
