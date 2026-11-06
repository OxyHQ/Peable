import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { type BuildOptions, build, type Metafile, type Plugin, transform } from 'esbuild';

// The entries an app bundles for a browser or a phone, and what they may reach.
//
// Two failures, both shipped once and both invisible to `tsc` and to every
// unit test:
//
//  - A Node-only module. `@peable.to/sdk` 1.0.0's `./checkout/ui` imported
//    `PAYMENT_METHOD_CURRENCIES` from the `@peable.to/shared-types` barrel, whose
//    `webhookSigner` imports `node:crypto`, and Mention's Android bundle failed
//    to resolve it. Every dependency is followed here, third-party ones
//    included, so a dependency that starts importing a builtin fails too.
//  - Bytes from a barrel. Metro (Expo web, React Native) ships every module an
//    entry reaches, used or not, so the `@peable.to/contracts/vocabulary`
//    barrel behind the SDK's error classes cost Mention ~58 KiB. The bytes
//    counted are the minified size of each module the resolver reached, not a
//    tree-shaken output.
//
// The peers the app itself provides (React, React Native, Bloom, the QR/SVG
// renderers) stay external: they are the platform, not Peable's dependencies.

const root = resolve(import.meta.dir, '..');

const NODE_BUILTINS = new Set(builtinModules);
const isNodeBuiltin = (specifier: string) =>
  specifier.startsWith('node:') || NODE_BUILTINS.has(specifier.split('/')[0] ?? specifier);

/** The server-side webhook signer: never in a payer's or a phone's bundle, whatever it imports. */
const SERVER_ONLY_MODULE = /\/webhookSigner\.(ts|js)$/;

const APP_PEER =
  /^(react|react-dom|react-native|react-native-svg|react-native-qrcode-svg|@oxy\.so\/bloom)(\/|$)/;

const platformExternals: Plugin = {
  name: 'platform-externals',
  setup(bundle) {
    bundle.onResolve({ filter: /^[^./]/ }, ({ path }) =>
      isNodeBuiltin(path) || APP_PEER.test(path) ? { external: true } : undefined,
    );
  },
};

const BUILD: BuildOptions = {
  absWorkingDir: root,
  bundle: true,
  write: false,
  metafile: true,
  outfile: 'bundle.js',
  format: 'esm',
  platform: 'browser',
  conditions: ['react-native'],
  jsx: 'automatic',
  loader: { '.png': 'empty', '.m4a': 'empty', '.ogg': 'empty' },
  logLevel: 'silent',
  plugins: [platformExternals],
};

async function graph(options: BuildOptions): Promise<Metafile> {
  const { metafile } = await build({ ...BUILD, ...options });
  if (metafile === undefined) throw new Error('esbuild produced no metafile');
  return metafile;
}

/** Every Node-only reach in a graph, as `<module> -> <builtin or server-only module>`. */
function nodeOnlyReach(metafile: Metafile): string[] {
  return Object.entries(metafile.inputs).flatMap(([path, { imports }]) => [
    ...imports
      .filter((edge) => edge.external && isNodeBuiltin(edge.path))
      .map((edge) => `${path} -> ${edge.path}`),
    ...(SERVER_ONLY_MODULE.test(path) ? [`${path} (server-only)`] : []),
  ]);
}

/** The modules of the Peable packages an entry depends on, keyed `<package>/<file>`, with their minified bytes. */
async function peableModules(metafile: Metafile): Promise<Map<string, number>> {
  const modules = new Map<string, number>();
  for (const path of Object.keys(metafile.inputs)) {
    const match = /(contracts|shared-types)\/dist\/esm\/(.+)$/.exec(path);
    if (match === null) continue;
    const { code } = await transform(readFileSync(resolve(root, path), 'utf8'), {
      loader: 'js',
      minify: true,
    });
    modules.set(`${match[1]}/${match[2]}`, code.length);
  }
  return modules;
}

interface Entry {
  /** Source file of the published entry. */
  readonly source: string;
  /**
   * The modules of `@peable.to/contracts` / `@peable.to/shared-types` it may
   * reach, or `undefined` where only the Node-only rule applies (the
   * shared-types subpaths still import the vocabulary barrel).
   */
  readonly peable?: readonly string[];
}

// `@peable.to/sdk/checkout`: the error classes read `vocabulary/errors`, and
// the payer client's socket path `vocabulary/realtime`.
// `/checkout/ui`: the method list reads `paymentMethodConfigurations` and the
// fiat set in `money` it is built from; `PeableSheetCheckout` drives an order
// through the payer client, whose errors read `vocabulary/errors` and whose
// socket path reads `vocabulary/realtime`.
// `/display`, `@peable.to/pay/ui`: none.
const ENTRIES: Readonly<Record<string, Entry>> = {
  '@peable.to/sdk/checkout': {
    source: 'packages/sdk/src/checkout.ts',
    peable: ['contracts/vocabulary/errors.js', 'contracts/vocabulary/realtime.js'],
  },
  '@peable.to/sdk/checkout/ui': {
    source: 'packages/sdk/src/ui/index.ts',
    peable: [
      'contracts/vocabulary/errors.js',
      'contracts/vocabulary/money.js',
      'contracts/vocabulary/paymentMethodConfigurations.js',
      'contracts/vocabulary/realtime.js',
    ],
  },
  '@peable.to/sdk/display': { source: 'packages/sdk/src/display.ts', peable: [] },
  '@peable.to/pay/ui': { source: 'packages/pay/src/ui/index.ts', peable: [] },
  '@peable.to/shared-types/tax': { source: 'packages/shared-types/src/tax.ts' },
  '@peable.to/shared-types/reporting': { source: 'packages/shared-types/src/reporting.ts' },
};

// Minified bytes the Peable packages may add to one entry. Measured at 11,626
// (`checkout`) and 1,072 (`checkout/ui`); through the barrels they were 31,693
// (20 modules) and 46,961 (52 modules).
const CEILING_BYTES = 14 * 1024;

describe('browser and React Native entries', () => {
  for (const [name, { source, peable }] of Object.entries(ENTRIES)) {
    test(`${name} reaches no Node-only module`, async () => {
      expect(nodeOnlyReach(await graph({ entryPoints: [resolve(root, source)] }))).toEqual([]);
    });
    if (peable !== undefined)
      test(`${name} bundles only the vocabulary it reads`, async () => {
        const modules = await peableModules(await graph({ entryPoints: [resolve(root, source)] }));
        expect([...modules.keys()].sort()).toEqual([...peable].sort());
        const bytes = [...modules.values()].reduce((sum, size) => sum + size, 0);
        expect(bytes).toBeLessThanOrEqual(CEILING_BYTES);
      });
  }
});

describe('the gate can fail', () => {
  // `@peable.to/sdk` 1.0.0's `ui/intentMethods.ts`, verbatim: the import that
  // broke Mention's Android bundle.
  const sdk100CheckoutUi = {
    stdin: {
      contents: "export { PAYMENT_METHOD_CURRENCIES } from '@peable.to/shared-types';",
      resolveDir: resolve(root, 'packages/sdk/src/ui'),
      sourcefile: 'intentMethods.ts',
      loader: 'ts' as const,
    },
  };

  test('the shared-types barrel reaches node:crypto through the webhook signer', async () => {
    const reach = nodeOnlyReach(await graph(sdk100CheckoutUi));
    expect(reach).toContainEqual(expect.stringMatching(/webhookSigner\.js -> node:crypto$/));
    expect(reach).toContainEqual(expect.stringMatching(/webhookSigner\.js \(server-only\)$/));
  });

  test('a bare builtin is Node-only too', async () => {
    const reach = nodeOnlyReach(
      await graph({
        stdin: { contents: "import 'fs'; import 'crypto';", resolveDir: root, loader: 'ts' },
      }),
    );
    expect(reach).toEqual(['<stdin> -> fs', '<stdin> -> crypto']);
  });

  test('a barrel import is more than the vocabulary an entry reads', async () => {
    const modules = await peableModules(await graph(sdk100CheckoutUi));
    expect(modules.has('contracts/vocabulary/index.js')).toBe(true);
    expect([...modules.values()].reduce((sum, size) => sum + size, 0)).toBeGreaterThan(
      CEILING_BYTES,
    );
  });
});
