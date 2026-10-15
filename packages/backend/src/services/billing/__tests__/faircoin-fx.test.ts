import { describe, expect, it } from 'bun:test';
import { createExplorerFaircoinQuote, faircoinBaseUnitsForUsd } from '../faircoin-fx';
describe('USD commercial price to exact expiring FAIR settlement quote', () => {
  it('rounds up exactly to 1e-8 FAIR without cent/base-unit confusion', () => {
    expect(faircoinBaseUnitsForUsd(2999, '0.12')).toBe('24991666667');
    expect(faircoinBaseUnitsForUsd(2999, '1')).toBe('2999000000');
    expect(faircoinBaseUnitsForUsd(1, '3')).toBe('333334');
    expect(faircoinBaseUnitsForUsd(1, '1e-8')).toBe('100000000000000');
    expect(faircoinBaseUnitsForUsd(2999, '0.1200')).toBe('24991666667');
    for (const rate of ['0', '-1', 'NaN', 'Infinity', '1e900', '0.1garbage'])
      expect(() => faircoinBaseUnitsForUsd(2999, rate)).toThrow();
  });
  it('uses fresh source evidence and refuses a stale/missing quote', async () => {
    const now = new Date();
    const read = (value: unknown) => (async () => Response.json(value)) as unknown as typeof fetch;
    const quote = await createExplorerFaircoinQuote(2999, {
      now,
      fetch: read({ price: { usd: 0.12 }, timestamp: now.toISOString() }),
    });
    expect(quote.amountBaseUnits).toBe('24991666667');
    expect(Date.parse(quote.expiresAt) - +now).toBe(600_000);
    for (const body of [
      { price: null },
      { price: { usd: 0.12 } },
      { price: { usd: 0.12 }, timestamp: new Date(+now - 120_001).toISOString() },
      { price: { usd: 0.12 }, timestamp: new Date(+now + 2000).toISOString() },
    ]) {
      await expect(createExplorerFaircoinQuote(2999, { now, fetch: read(body) })).rejects.toThrow();
    }
  });
});
