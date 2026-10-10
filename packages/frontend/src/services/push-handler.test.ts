/**
 * Tests for the silent-push handler core (spec §4.2).
 *
 * Drives {@link createPushHandler} with mocked deps (no native modules). Proves:
 *   - an incoming tx paying us posts a received notification with the amount
 *     derived from the synced transaction (composed on-device, not from the push);
 *   - a txid that doesn't pay us posts nothing;
 *   - `outgoing_confirmed` posts the send-confirmed notification with the amount
 *     that LEFT the wallet (spent inputs minus change back to us);
 *   - an unresolvable txid (fetch → null) and a locked wallet (no addresses)
 *     both post nothing.
 */

import { describe, test, expect, mock } from 'bun:test';
import { createPushHandler, type PushHandlerDeps, type PushTransaction } from './push-handler';

// 1 FAIR = 100_000_000 base units (m⊜).
const UNITS = 100_000_000n;

interface Recorder {
  deps: PushHandlerDeps;
  received: bigint[];
  sent: bigint[];
}

function makeDeps(tx: PushTransaction | null, ourAddresses: string[]): Recorder {
  const received: bigint[] = [];
  const sent: bigint[] = [];
  const deps: PushHandlerDeps = {
    fetchTransaction: mock(async () => tx),
    getWalletAddresses: () => ourAddresses,
    notifyReceived: mock(async (amount: bigint) => {
      received.push(amount);
    }),
    notifySentConfirmed: mock(async (amount: bigint) => {
      sent.push(amount);
    }),
  };
  return { deps, received, sent };
}

describe('createPushHandler.handleIncomingPush', () => {
  test('incoming_confirmed paying us posts a received notification with the synced amount', async () => {
    const tx: PushTransaction = {
      vout: [
        { addresses: ['ours-1'], value: 2.5 },
        { addresses: ['someone-else'], value: 9 },
      ],
      vin: [{ addresses: ['someone-else'], value: 11.5 }],
    };
    const r = makeDeps(tx, ['ours-1']);
    const handler = createPushHandler(r.deps);

    await handler.handleIncomingPush({
      txid: 'tx1',
      event: 'incoming_confirmed',
    });

    expect(r.received).toEqual([(25n * UNITS) / 10n]); // 2.5 FAIR
    expect(r.sent).toHaveLength(0);
  });

  test("a txid that doesn't pay us posts nothing", async () => {
    const tx: PushTransaction = {
      vout: [{ addresses: ['someone-else'], value: 5 }],
      vin: [{ addresses: ['another'], value: 5 }],
    };
    const r = makeDeps(tx, ['ours-1']);
    const handler = createPushHandler(r.deps);

    await handler.handleIncomingPush({
      txid: 'tx2',
      event: 'incoming_confirmed',
    });

    expect(r.received).toHaveLength(0);
    expect(r.sent).toHaveLength(0);
  });

  test('outgoing_confirmed posts the amount that LEFT the wallet (spent minus change)', async () => {
    // We spend a 10 FAIR input; 3 FAIR goes to a recipient, 6.99 change back to
    // us (0.01 fee). Amount that left = 10 - 6.99 = 3.01 FAIR.
    const tx: PushTransaction = {
      vout: [
        { addresses: ['recipient'], value: 3 },
        { addresses: ['ours-change'], value: 6.99 },
      ],
      vin: [{ addresses: ['ours-input'], value: 10 }],
    };
    const r = makeDeps(tx, ['ours-input', 'ours-change']);
    const handler = createPushHandler(r.deps);

    await handler.handleIncomingPush({
      txid: 'tx3',
      event: 'outgoing_confirmed',
    });

    expect(r.sent).toEqual([301_000_000n]); // 3.01 FAIR
    expect(r.received).toHaveLength(0);
  });

  test("posts nothing when the transaction can't be fetched", async () => {
    const r = makeDeps(null, ['ours-1']);
    const handler = createPushHandler(r.deps);

    await handler.handleIncomingPush({
      txid: 'missing',
      event: 'incoming_confirmed',
    });

    expect(r.received).toHaveLength(0);
    expect(r.sent).toHaveLength(0);
  });

  test('posts nothing while locked (no watched addresses)', async () => {
    const tx: PushTransaction = {
      vout: [{ addresses: ['ours-1'], value: 4 }],
      vin: [],
    };
    const r = makeDeps(tx, []);
    const handler = createPushHandler(r.deps);

    await handler.handleIncomingPush({
      txid: 'tx4',
      event: 'incoming_confirmed',
    });

    expect(r.received).toHaveLength(0);
    expect(r.sent).toHaveLength(0);
  });

  test('incoming_pending is treated like a received event', async () => {
    const tx: PushTransaction = {
      vout: [{ addresses: ['ours-1'], value: 1 }],
      vin: [{ addresses: ['someone'], value: 1 }],
    };
    const r = makeDeps(tx, ['ours-1']);
    const handler = createPushHandler(r.deps);

    await handler.handleIncomingPush({
      txid: 'tx5',
      event: 'incoming_pending',
    });

    expect(r.received).toEqual([UNITS]); // 1 FAIR
  });
});
