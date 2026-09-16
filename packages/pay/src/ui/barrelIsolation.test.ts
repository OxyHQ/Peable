/**
 * The root barrel must not be able to reach `src/ui`.
 *
 * `@peable.to/pay`'s root entry is imported by servers and by test suites that
 * install neither React nor `@oxy.so/bloom`. `tsc` resolves the specifier of a
 * re-export whether or not anything ever calls it — and it resolves the
 * specifier of an `import()` even though the call is lazy — so a single line of
 * `export * from './ui'` would drag React, React Native, Bloom and
 * `react-native-qrcode-svg` into every consumer's type graph and turn four
 * optional peers into hard install requirements.
 *
 * The failure is resolver-asymmetric, which is why it needs a test rather than a
 * rule: a web/Vite consumer resolves this package through `dist/types/**` under
 * `skipLibCheck`, where the missing modules are invisible, while a Metro
 * consumer fails the build. So the side most likely to add the re-export is the
 * side least likely to see it break.
 *
 * This walks the real module graph from `src/index.ts` instead of grepping for
 * the string: the barrel could reach the UI through any intermediate file.
 */

import { describe, test, expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const SRC = resolve(import.meta.dir, '..');
const ROOT_BARREL = join(SRC, 'index.ts');

/** Bare specifiers no consumer of the ROOT entry is required to have installed. */
const FORBIDDEN_PACKAGES = [
  'react',
  'react/jsx-runtime',
  'react-native',
  'react-native-qrcode-svg',
];

const SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

async function reachableFrom(entry: string): Promise<Map<string, string[]>> {
  const seen = new Map<string, string[]>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;

    const source = await readFile(file, 'utf8');
    const bare: string[] = [];
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1]!;
      if (!specifier.startsWith('.')) {
        bare.push(specifier);
        continue;
      }
      queue.push(await resolveRelative(dirname(file), specifier));
    }
    seen.set(file, bare);
  }

  return seen;
}

async function resolveRelative(from: string, specifier: string): Promise<string> {
  const base = resolve(from, specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  throw new Error(`Cannot resolve ${specifier} from ${from}`);
}

describe('root barrel isolation', () => {
  test('nothing reachable from the root entry lives under src/ui', async () => {
    const graph = await reachableFrom(ROOT_BARREL);
    const leaked = [...graph.keys()]
      .map((file) => relative(SRC, file))
      .filter((file) => file.startsWith('ui/'));

    expect(leaked).toEqual([]);
  });

  test('nothing reachable from the root entry names React, React Native or the QR renderer', async () => {
    const graph = await reachableFrom(ROOT_BARREL);
    const leaked: string[] = [];
    for (const [file, specifiers] of graph) {
      for (const specifier of specifiers) {
        const pkg = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0]!;
        if (FORBIDDEN_PACKAGES.includes(specifier) || pkg === '@oxy.so/bloom') {
          leaked.push(`${relative(SRC, file)} -> ${specifier}`);
        }
      }
    }

    expect(leaked).toEqual([]);
  });

  test('the walk is real — it finds the UI entry when started there', async () => {
    // Without this, a broken resolver that returned an empty graph would make
    // both tests above pass forever.
    const graph = await reachableFrom(join(SRC, 'ui', 'index.ts'));
    const files = [...graph.keys()].map((file) => relative(SRC, file));
    expect(files).toContain('ui/PeablePaySheet.tsx');
    expect([...graph.values()].flat()).toContain('@oxy.so/bloom/dialog');
    expect([...graph.values()].flat()).toContain('react-native-qrcode-svg');
  });
});
