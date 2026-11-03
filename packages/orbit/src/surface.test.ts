import { expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
/** UI module mocks must not contaminate the Orbit's process-wide Bun tests. */
it('passes the isolated authenticated Orbit surface regression', async () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url).href);
  const child = Bun.spawn(['bun', 'test', 'test-support/orbit-surface.test.tsx'], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exit, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exit !== 0) throw new Error(`${out}\n${err}`);
  expect(exit).toBe(0);
}, 30000);
