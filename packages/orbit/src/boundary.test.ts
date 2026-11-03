import { expect, it } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
async function sources(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) =>
        entry.isDirectory()
          ? sources(join(path, entry.name))
          : /\.(tsx?|jsx?)$/.test(entry.name) && !entry.name.includes('.test.')
            ? [await readFile(join(path, entry.name), 'utf8')]
            : [],
      ),
    )
  ).flat();
}
it('keeps the merchant app independent of wallet code and signing dependencies', async () => {
  const manifest = await Bun.file(new URL('../package.json', import.meta.url)).json();
  expect(manifest.private).toBe(true);
  for (const name of ['@peable.to/pay', '@fairco.in/core', 'react-native-tcp-socket'])
    expect(manifest.dependencies[name]).toBeUndefined();
  const code = (await sources(new URL('.', import.meta.url).pathname)).join('\n');
  expect(code).not.toMatch(/from\s+['"][^'"]*(?:frontend|wallet-store|keystore|spv)[^'"]*['"]/i);
});
