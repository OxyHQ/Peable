import { describe, expect, test } from 'bun:test';
import { createInitQueue } from './init-queue';

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe('the wallet init queue is a mutex (R7-9)', () => {
  test('a call made while a task runs waits for it — it is never run inline', async () => {
    const queue = createInitQueue();
    let running = 0;
    let most = 0;
    const order: string[] = [];
    const task = (name: string) => async () => {
      running += 1;
      most = Math.max(most, running);
      order.push(`${name}:start`);
      await tick();
      await tick();
      order.push(`${name}:end`);
      running -= 1;
    };
    const first = queue(task('a'));
    await tick(); // `a` is in flight: the old queue ran the next call inline here
    const second = queue(task('b'));
    const third = queue(task('c'));
    await Promise.all([first, second, third]);
    expect(most).toBe(1);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  test('a failed task rejects its caller and does not block the next', async () => {
    const queue = createInitQueue();
    const failed = queue(async () => {
      throw new Error('boom');
    });
    let ran = false;
    const next = queue(async () => {
      ran = true;
    });
    await expect(failed).rejects.toThrow('boom');
    await next;
    expect(ran).toBe(true);
  });
});
