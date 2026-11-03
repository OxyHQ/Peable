import { cp, mkdir } from 'node:fs/promises';
const target = new URL('../dist/esm/ui/assets/', import.meta.url);
await mkdir(target, { recursive: true });
await cp(new URL('../src/ui/assets/peable.png', import.meta.url), new URL('peable.png', target));
