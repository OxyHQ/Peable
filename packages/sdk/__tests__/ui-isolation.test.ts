import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import ts from 'typescript';
const root = resolve(import.meta.dir, '..');
function graph(entry: string) {
  const files = new Set<string>();
  const external = new Set<string>();
  function visit(file: string) {
    if (files.has(file)) return;
    files.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    function follow(specifier: string) {
      if (!specifier.startsWith('.')) {
        external.add(specifier);
        return;
      }
      const base = resolve(dirname(file), specifier.replace(/\.js$/, ''));
      const target = [
        `${base}.ts`,
        `${base}.tsx`,
        resolve(base, 'index.ts'),
        resolve(base, 'index.tsx'),
      ].find(existsSync);
      if (!target) throw new Error(`Unresolved source import ${specifier} from ${file}`);
      visit(target);
    }
    function walk(node: ts.Node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        follow(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const first = node.arguments[0];
        if (first && ts.isStringLiteral(first)) follow(first.text);
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
  visit(resolve(root, entry));
  return { files, external };
}
describe('optional checkout UI boundary', () => {
  for (const entry of ['src/index.ts', 'src/checkout.ts'])
    test(`${entry} never imports UI peers or the UI module graph`, () => {
      const result = graph(entry);
      expect(
        [...result.files].filter((file) => relative(root, file).startsWith('src/ui/')),
      ).toEqual([]);
      expect(
        [...result.external].filter((name) =>
          /^(react($|\/)|react-native($|\/)|@oxy\.so\/bloom($|\/))/.test(name),
        ),
      ).toEqual([]);
    });
  test('UI has only native/ESM/types export conditions and optional peer requirements', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    const ui = pkg.exports['./checkout/ui'];
    expect(ui.require).toBeUndefined();
    expect(ui.import.types).toBe('./dist/types/ui/index.d.ts');
    expect(ui['react-native'].default).toBe('./dist/esm/ui/index.js');
    for (const peer of ['react', 'react-native', '@oxy.so/bloom'])
      expect(pkg.peerDependenciesMeta[peer].optional).toBe(true);
    expect(readFileSync(resolve(root, 'src/ui/index.ts'), 'utf8')).not.toContain(
      'PeableCheckoutPreview',
    );
  });
});
