import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
async function verify(target) {
  if (typeof target === 'string') {
    if (!target.startsWith('./dist/')) return;
    await access(new URL(target, root));
  } else if (target && typeof target === 'object') {
    await Promise.all(Object.values(target).map(verify));
  }
}
await verify(manifest.exports);
const ui = manifest.exports['./checkout/ui'];
if (!ui || 'require' in ui)
  throw new Error('Checkout UI must remain an optional ESM/native entry.');
for (const name of ['peable.png', 'success.ogg', 'failed.ogg', 'success.m4a', 'failed.m4a']) {
  await access(new URL(`dist/esm/ui/assets/${name}`, root));
}
console.log(`Verified checkout UI exports and brand assets in ${fileURLToPath(root)}.`);
