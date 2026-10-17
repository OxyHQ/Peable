import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { EXPLORER_BASE_URL } from '@fairco.in/core';
import {
  convertDisplayAmount,
  formatDisplayUnits,
  readDisplayRates,
  type DisplayRates,
} from '../display';
const now = Date.now();
const rates: DisplayRates = {
  usdPerFair: '0.3',
  eurPerFair: '0.27',
  source: 'official',
  observedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 120000).toISOString(),
};
describe('display amounts never authorize payments', () => {
  it('converts USD to EUR and FAIR at their real precision', () => {
    expect(
      convertDisplayAmount({ units: '100', currency: 'USD', displayCurrency: 'EUR', rates, now }),
    ).toBe('0.90 EUR');
    expect(
      convertDisplayAmount({ units: '100', currency: 'USD', displayCurrency: 'FAIR', rates, now }),
    ).toBe('3.33333333 FAIR');
    expect(
      convertDisplayAmount({
        units: '100000001',
        currency: 'FAIR',
        displayCurrency: 'USD',
        rates,
        now,
      }),
    ).toBe('0.30 USD');
  });
  it('preserves FAIR base units exactly and rounds fiat once', () => {
    expect(
      convertDisplayAmount({
        units: '9007199254740993',
        currency: 'FAIR',
        displayCurrency: 'FAIR',
      }),
    ).toBe('90071992.54740993 FAIR');
    expect(
      convertDisplayAmount({
        units: '50000000',
        currency: 'FAIR',
        displayCurrency: 'USD',
        rates: { ...rates, usdPerFair: '0.01' },
        now,
      }),
    ).toBe('0.01 USD');
    expect(formatDisplayUnits(123n, 0, 'JPY')).toBe('123 JPY');
  });
  it('keeps canonical amounts visible but never falls back to stale conversion', () => {
    expect(
      convertDisplayAmount({
        units: '100',
        currency: 'USD',
        displayCurrency: 'EUR',
        rates,
        now: now + 120001,
      }),
    ).toBeNull();
    expect(
      convertDisplayAmount({ units: '100', currency: 'USD', displayCurrency: 'EUR' }),
    ).toBeNull();
    expect(convertDisplayAmount({ units: '100', currency: 'USD', displayCurrency: 'USD' })).toBe(
      '1.00 USD',
    );
  });
  it('rejects malformed amount units', () => {
    for (const units of ['-1', 'NaN', '1e8', '1.0'])
      expect(() =>
        convertDisplayAmount({ units, currency: 'FAIR', displayCurrency: 'FAIR' }),
      ).toThrow();
  });
  it('requires fresh timestamped official rates, no fetch fallback', async () => {
    const fetcher = (body: unknown, status = 200) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const body = { price: 0.3, source: 'wfair-base', updatedAt: new Date(now).toISOString() };
    const liveRates = await readDisplayRates({ fetch: fetcher(body), now });
    expect(liveRates.usdPerFair).toBe('0.3');
    expect(liveRates.eurPerFair).toBeNull();
    expect(
      convertDisplayAmount({
        units: '100',
        currency: 'USD',
        displayCurrency: 'FAIR',
        rates: liveRates,
        now,
      }),
    ).toBe('3.33333333 FAIR');
    expect(
      convertDisplayAmount({
        units: '100',
        currency: 'USD',
        displayCurrency: 'EUR',
        rates: liveRates,
        now,
      }),
    ).toBeNull();
    for (const invalid of [
      null,
      { price: body.price },
      { ...body, updatedAt: new Date(now - 120001).toISOString() },
      { ...body, updatedAt: new Date(now + 2000).toISOString() },
      { ...body, source: 'manual' },
      { ...body, price: 0 },
      { ...body, price: { usd: 0.3, eur: 0.27 } },
    ])
      await expect(readDisplayRates({ fetch: fetcher(invalid), now })).rejects.toThrow();
    await expect(readDisplayRates({ fetch: fetcher({}, 403), now })).rejects.toThrow();
  });
});

describe('display entry stays portable', () => {
  it('imports only the import-free timeout helper, so a non-tree-shaking bundler pulls in no wallet code', () => {
    const imports = (file: string) =>
      [
        ...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(
          /^\s*(?:import|export)\b[^;]*\bfrom\s+'([^']+)'/gm,
        ),
      ].map((match) => match[1]);
    expect(imports('../display.ts')).toEqual(['./core/timeoutSignal']);
    expect(imports('../core/timeoutSignal.ts')).toEqual([]);
  });
  it('reads the core Explorer without AbortSignal.any/timeout and honours the caller signal', async () => {
    const statics = AbortSignal as unknown as Record<'any' | 'timeout', unknown>;
    const saved = { any: statics.any, timeout: statics.timeout };
    statics.any = undefined;
    statics.timeout = undefined;
    try {
      const caller = new AbortController();
      let seen: { url: string; signal: AbortSignal } | undefined;
      const fetcher = (async (url: string, init: RequestInit) => {
        seen = { url, signal: init.signal as AbortSignal };
        caller.abort();
        return new Response(
          JSON.stringify({
            price: 0.3,
            source: 'wfair-base',
            updatedAt: new Date(now).toISOString(),
          }),
        );
      }) as unknown as typeof fetch;
      await readDisplayRates({ fetch: fetcher, signal: caller.signal, now });
      expect(seen?.url).toBe(`${EXPLORER_BASE_URL}/api/price`);
      expect(seen?.signal.aborted).toBe(true);
    } finally {
      Object.assign(statics, saved);
    }
  });
});
