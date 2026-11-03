import { cp, mkdir } from 'node:fs/promises';
const target = new URL('../dist/esm/ui/assets/', import.meta.url);
await mkdir(target, { recursive: true });
for (const name of ['peable.png', 'success.ogg', 'failed.ogg', 'success.m4a', 'failed.m4a']) {
  await cp(new URL(`../src/ui/assets/${name}`, import.meta.url), new URL(name, target));
}
