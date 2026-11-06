import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

test('mounted checkout: open, prepare, retry, correct and change account safely', async () => {
  const process = Bun.spawn(
    ['bun', fileURLToPath(new URL('../support/preparationLifecycle.tsx', import.meta.url))],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [exit, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
  expect(stdout).toContain('Checkout preparation lifecycle: passed');
}, 30_000);
