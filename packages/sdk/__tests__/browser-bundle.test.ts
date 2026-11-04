import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build, type Plugin, transform } from 'esbuild';

// What an app pays for the browser entries, counted the way Metro (Expo web,
// React Native) bundles them: every module an entry reaches ships whole, so a
// barrel import costs every module behind the barrel, used or not. A bundler
// that tree-shakes hides that, which is why the bytes here are not esbuild's
// output but the minified size of each module its resolver reached. The
// `@peable.to/contracts/vocabulary` barrel, reached through the error classes
// and `shared-types`, cost Mention's Plus checkout ~58 KiB.
//
// Third-party packages stay external: this gate is about what the Peable
// packages bring, and a dependency's own size is its release's concern.

const root = resolve(import.meta.dir, '..');

const peableOnly: Plugin = {
  name: 'peable-only',
  setup(bundle) {
    bundle.onResolve({ filter: /^[^./]/ }, ({ path }) =>
      path.startsWith('@peable.to/') ? undefined : { external: true },
    );
  },
};

/** Every module outside the SDK's own `src/` an entry reaches, keyed `<package>/<file>`, with its minified bytes. */
async function foreignModules(entry: string): Promise<Map<string, number>> {
  const { metafile } = await build({
    entryPoints: [resolve(root, entry)],
    absWorkingDir: root,
    bundle: true,
    write: false,
    metafile: true,
    outfile: 'bundle.js',
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    loader: { '.png': 'empty', '.m4a': 'empty', '.ogg': 'empty' },
    logLevel: 'silent',
    plugins: [peableOnly],
  });
  const modules = new Map<string, number>();
  for (const path of Object.keys(metafile.inputs)) {
    if (path.startsWith('src/')) continue;
    const { code } = await transform(readFileSync(resolve(root, path), 'utf8'), {
      loader: 'js',
      minify: true,
    });
    const match = /(contracts|shared-types)\/dist\/esm\/(.+)$/.exec(path);
    modules.set(match ? `${match[1]}/${match[2]}` : path, code.length);
  }
  return modules;
}

// The vocabulary modules each entry reads, and nothing else from a Peable
// package: the error classes read `errors` (`ERROR_CODES`, `errorDocUrl`), the
// sheet's method list reads `paymentMethodConfigurations` and the fiat set in
// `money` it is built from. `shared-types` is types-only in both.
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  'src/checkout.ts': ['contracts/vocabulary/errors.js'],
  'src/ui/index.ts': [
    'contracts/vocabulary/money.js',
    'contracts/vocabulary/paymentMethodConfigurations.js',
  ],
};

// Minified bytes the Peable packages may add to one entry. Measured at 11,626
// (`checkout`) and 1,072 (`checkout/ui`); through the barrels they were 31,693
// (20 modules) and 46,961 (52 modules).
const CEILING_BYTES = 14 * 1024;

describe('browser entries bundle only the vocabulary they read', () => {
  for (const [entry, allowed] of Object.entries(ALLOWED))
    test(entry, async () => {
      const modules = await foreignModules(entry);
      expect([...modules.keys()].sort()).toEqual([...allowed].sort());
      const bytes = [...modules.values()].reduce((sum, size) => sum + size, 0);
      expect(bytes).toBeLessThanOrEqual(CEILING_BYTES);
    });
});
