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
  eurPerFair: '0.267260579064587973',
  eurReference: {
    usdPerEur: '1.1225',
    source:
      'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?lastNObservations=1&format=csvdata',
    observedAt: new Date(now - (now % 86_400_000)).toISOString(),
    expiresAt: new Date(now - (now % 86_400_000) + 4 * 86_400_000).toISOString(),
  },
  source: 'official',
  observedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 120000).toISOString(),
};
describe('display amounts never authorize payments', () => {
  it('converts USD to EUR and FAIR at their real precision', () => {
    expect(
      convertDisplayAmount({ units: '100', currency: 'USD', displayCurrency: 'EUR', rates, now }),
    ).toBe('0.89 EUR');
    expect(
      convertDisplayAmount({ units: '10000', currency: 'USD', displayCurrency: 'EUR', rates, now }),
    ).toBe('89.09 EUR');
    expect(
      convertDisplayAmount({
        units: '100000000',
        currency: 'FAIR',
        displayCurrency: 'EUR',
        rates,
        now,
      }),
    ).toBe('0.27 EUR');
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
    const ecbCsv = (date: string, value = '1.1225', status = 'A') =>
      [
        'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS',
        `EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,${date},${value},${status}`,
      ].join('\n');
    const ecbDate = new Date(now - (now % 86_400_000)).toISOString().slice(0, 10);
    const fetcher = (body: unknown, status = 200, csv = ecbCsv(ecbDate)) =>
      (async (url: string | URL | Request) =>
        String(url).startsWith('https://data-api.ecb.europa.eu/')
          ? new Response(csv, { status })
          : new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const body = { price: 0.3, source: 'wfair-base', updatedAt: new Date(now).toISOString() };
    const liveRates = await readDisplayRates({ fetch: fetcher(body), now });
    expect(liveRates.usdPerFair).toBe('0.3');
    expect(liveRates.eurPerFair).toBe('0.267260579064587973');
    expect(liveRates.eurReference?.usdPerEur).toBe('1.1225');
    expect(liveRates.eurReference?.source).toContain(
      'data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A',
    );
    expect(liveRates.eurReference?.observedAt).toBe(`${ecbDate}T00:00:00.000Z`);
    expect(liveRates.eurReference?.expiresAt).toBe(
      new Date(Date.parse(`${ecbDate}T00:00:00.000Z`) + 4 * 86_400_000).toISOString(),
    );
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
    ).toBe('0.89 EUR');
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

  it('accepts the latest ECB observation across non-publication days but expires it after four days', async () => {
    const ecbCsv = (date: string) =>
      [
        'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS',
        `EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,${date},1.1225,A`,
      ].join('\n');
    const body = { price: 0.3, source: 'wfair-base', updatedAt: new Date(now).toISOString() };
    const sunday = Date.parse('2026-10-18T12:00:00.000Z');
    const fridayCsv = ecbCsv('2026-10-16');
    const weekendBody = { ...body, updatedAt: new Date(sunday).toISOString() };
    const atWeekend = await readDisplayRates({
      fetch: (async (url: string | URL | Request) =>
        String(url).startsWith('https://data-api.ecb.europa.eu/')
          ? new Response(fridayCsv)
          : new Response(JSON.stringify(weekendBody))) as unknown as typeof fetch,
      now: sunday,
    });
    expect(atWeekend.eurReference?.observedAt).toBe('2026-10-16T00:00:00.000Z');
    expect(
      convertDisplayAmount({
        units: '100',
        currency: 'USD',
        displayCurrency: 'EUR',
        rates: atWeekend,
        now: sunday,
      }),
    ).toBe('0.89 EUR');

    const stale = await readDisplayRates({
      fetch: (async (url: string | URL | Request) =>
        String(url).startsWith('https://data-api.ecb.europa.eu/')
          ? new Response(ecbCsv('2026-10-14'))
          : new Response(JSON.stringify(weekendBody))) as unknown as typeof fetch,
      now: sunday,
    });
    expect(stale.usdPerFair).toBe('0.3');
    expect(stale.eurReference).toBeNull();
    expect(
      convertDisplayAmount({
        units: '100',
        currency: 'USD',
        displayCurrency: 'EUR',
        rates: stale,
        now: sunday,
      }),
    ).toBeNull();
    expect(
      convertDisplayAmount({
        units: '100',
        currency: 'USD',
        displayCurrency: 'USD',
        rates: stale,
        now: sunday,
      }),
    ).toBe('1.00 USD');
  });

  it('degrades only EUR for malformed, non-authoritative, stale or unavailable ECB data', async () => {
    const date = new Date(now - (now % 86_400_000)).toISOString().slice(0, 10);
    const ecbCsv = (
      row: string,
      header = 'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS',
    ) => `${header}\n${row}`;
    const body = { price: 0.3, source: 'wfair-base', updatedAt: new Date(now).toISOString() };
    const invalidCsv = [
      ecbCsv(`EXR.D.EUR.USD.SP00.A,D,USD,EUR,SP00,A,${date},1.1225,A`),
      ecbCsv(`EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,${date},1.1225,E`),
      ecbCsv(`EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,${date},0,A`),
      ecbCsv(`EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,${date},1e30,A`),
      ecbCsv(`EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,not-a-date,1.1225,A`),
      ecbCsv(`EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,${date},1.1225,A`, 'wrong,header'),
      ecbCsv(
        `EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,${date},1.1225,A\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,${date},1.1225,A`,
      ),
    ];
    for (const csv of invalidCsv) {
      const result = await readDisplayRates({
        fetch: (async (url: string | URL | Request) =>
          String(url).startsWith('https://data-api.ecb.europa.eu/')
            ? new Response(csv)
            : new Response(JSON.stringify(body))) as unknown as typeof fetch,
        now,
      });
      expect(result.usdPerFair).toBe('0.3');
      expect(result.eurReference).toBeNull();
      expect(result.eurPerFair).toBeNull();
      expect(
        convertDisplayAmount({
          units: '100',
          currency: 'USD',
          displayCurrency: 'USD',
          rates: result,
          now,
        }),
      ).toBe('1.00 USD');
    }

    const failed = await readDisplayRates({
      fetch: (async (url: string | URL | Request) =>
        String(url).startsWith('https://data-api.ecb.europa.eu/')
          ? new Response('', { status: 503 })
          : new Response(JSON.stringify(body))) as unknown as typeof fetch,
      now,
    });
    expect(failed.usdPerFair).toBe('0.3');
    expect(failed.eurReference).toBeNull();
  });

  it('bounds an ECB request and keeps the USD display rate available after timeout', async () => {
    const body = { price: 0.3, source: 'wfair-base', updatedAt: new Date(now).toISOString() };
    const started = Date.now();
    const rates = await readDisplayRates({
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        if (!String(url).startsWith('https://data-api.ecb.europa.eu/'))
          return new Response(JSON.stringify(body));
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('request aborted by timeout')),
            { once: true },
          );
        });
      }) as unknown as typeof fetch,
      now,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(2400);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(rates.usdPerFair).toBe('0.3');
    expect(rates.eurReference).toBeNull();
    expect(rates.eurPerFair).toBeNull();
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
        if (String(url).startsWith('https://data-api.ecb.europa.eu/')) return new Response('');
        seen = { url: String(url), signal: init.signal as AbortSignal };
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
