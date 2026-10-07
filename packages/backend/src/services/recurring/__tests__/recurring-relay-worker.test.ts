import { describe, expect, it } from 'bun:test';
import type { Database } from '../../../db/postgres';
import { startRecurringRelay } from '../recurring-relay-worker';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 15));

describe('recurring relay recovery worker', () => {
  it('never touches the database without explicit enablement', async () => {
    let calls = 0;
    const stop = startRecurringRelay({ db: {} as Database, cohorts: [] }, {
      intervalMs: 1, pass: async () => { calls++; return { kind: 'disabled', enqueued: 0 }; },
    });
    await tick(); stop(); expect(calls).toBe(0);
  });

  it('retries failed durable passes, excludes overlap and stops polling', async () => {
    let calls = 0;
    let failures = 0;
    let release: (() => void) | undefined;
    const stop = startRecurringRelay({ enabled: true, db: {} as Database, cohorts: [] }, {
      intervalMs: 1,
      onError: () => { failures++; },
      pass: async () => {
        calls++;
        if (calls === 1) throw new Error('temporary failure');
        await new Promise<void>((resolve) => { release = resolve; });
        return { kind: 'relayed', enqueued: 1 };
      },
    });
    try {
      await tick();
      expect(failures).toBe(1); expect(calls).toBe(2);
      await tick(); expect(calls).toBe(2);
      stop(); release?.(); await tick(); expect(calls).toBe(2);
    } finally { stop(); release?.(); }
  });
});
