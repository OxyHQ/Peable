import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLACES } from '../data/places';

const frontend = join(dirname(fileURLToPath(import.meta.url)), '../..');

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.[jt]sx?$/.test(entry.name) && !entry.name.includes('.test.') ? [path] : [];
    }),
  );
  return nested.flat();
}

describe('Peable accepts currency payments without offering currency exchange', () => {
  test('the route tree has no currency-purchase screen, including direct deep links', async () => {
    const routes = (await sources(join(frontend, 'app'))).map((path) =>
      relative(join(frontend, 'app'), path),
    );
    expect(routes.filter((route) => /(^|\/)(buy|sell)(\/|\.)/.test(route))).toEqual([]);
    // Removing currency sales must not remove ordinary payment approval or transfers.
    expect(routes).toContain('pay/[intent].tsx');
    expect(routes).toContain('(tabs)/send.tsx');
    expect(routes).toContain('(tabs)/receive.tsx');
  });

  test('application code cannot call the inherited bridge purchase API', async () => {
    const files = [
      ...(await sources(join(frontend, 'app'))),
      ...(await sources(join(frontend, 'src'))),
    ];
    const violations: string[] = [];
    for (const path of files) {
      const source = await readFile(path, 'utf8');
      if (
        /bridge\.fairco\.in|\/api\/buy\/(quote|status)|requestBuyQuote|BUY_BASE_URL|t\(['"]wallet\.buy/.test(
          source,
        )
      ) {
        violations.push(relative(frontend, path));
      }
    }
    expect(violations).toEqual([]);
  });

  test('merchant places do not advertise currency exchange or cash-out', () => {
    expect(PLACES.length).toBeGreaterThan(0);
    for (const place of PLACES) {
      expect(place).not.toHaveProperty('acceptsFairToFiat');
      expect(place).not.toHaveProperty('fiatPayoutMethods');
      expect(place).not.toHaveProperty('maxFiatPayout');
      expect(place.category as string).not.toBe('atm');
    }
  });
});
