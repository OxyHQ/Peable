import { describe, expect, test } from 'bun:test';
import {
  PAYMENT_INTENT_STATUSES,
  type PaymentIntentRail,
  type PaymentIntentStatus,
} from '@peable.to/shared-types';
import { applyEvent, type IntentEvent } from '../intentState';

/**
 * The state machine (ADR 0019), exhaustively: every event from every status on
 * both rails. The expected table is written out — not derived from the code —
 * so a changed edge is a diff a reviewer reads here.
 *
 * `null` means "throws": the event cannot act from that status on that rail.
 */
type Row = Partial<Record<PaymentIntentStatus, PaymentIntentStatus | null>>;

const RPM = 'requires_payment_method';
const RC = 'requires_confirmation';
const RA = 'requires_action';
const PR = 'processing';
const CAP = 'requires_capture';
const OK = 'succeeded';
const CX = 'canceled';

/** Every status not named in a row throws. Self-transitions are absorbed. */
const CARD: Record<IntentEvent, Row> = {
  broadcast: {},
  confirmed: {},
  underpaid: {},
  reorg_below_threshold: {},
  expire: { [RPM]: CX, [RC]: CX, [RA]: CX, [CX]: CX },
  cancel: { [RPM]: CX, [RC]: CX, [RA]: CX, [CAP]: CX, [CX]: CX },
  card_requires_payment_method: { [RPM]: RPM, [RC]: RPM, [RA]: RPM, [PR]: RPM },
  card_requires_confirmation: { [RPM]: RC, [RC]: RC },
  card_requires_action: { [RPM]: RA, [RC]: RA, [RA]: RA },
  card_processing: { [RPM]: PR, [RC]: PR, [RA]: PR, [CAP]: PR, [PR]: PR },
  card_requires_capture: { [RPM]: CAP, [RC]: CAP, [RA]: CAP, [PR]: CAP, [CAP]: CAP },
  card_succeeded: { [RPM]: OK, [RC]: OK, [RA]: OK, [PR]: OK, [CAP]: OK, [OK]: OK },
  card_failed: { [RPM]: RPM, [RC]: RPM, [RA]: RPM, [PR]: RPM },
  card_canceled: { [RPM]: CX, [RC]: CX, [RA]: CX, [PR]: CX, [CAP]: CX, [CX]: CX },
};

const FAIRCOIN: Record<IntentEvent, Row> = {
  broadcast: { [RA]: PR, [PR]: PR },
  confirmed: { [PR]: OK, [OK]: OK },
  underpaid: { [PR]: CX, [CX]: CX },
  reorg_below_threshold: { [OK]: PR },
  // `requires_payment_method` / `requires_confirmation` cannot exist on the
  // chain (the CHECK refuses them), but the machine answers the table there.
  expire: { [RPM]: CX, [RC]: CX, [RA]: CX, [CX]: CX },
  cancel: { [RPM]: CX, [RC]: CX, [RA]: CX, [CAP]: CX, [CX]: CX },
  card_requires_payment_method: {},
  card_requires_confirmation: {},
  card_requires_action: {},
  card_processing: {},
  card_requires_capture: {},
  card_succeeded: {},
  card_failed: {},
  card_canceled: {},
};

function outcome(
  status: PaymentIntentStatus,
  event: IntentEvent,
  rail: PaymentIntentRail,
): PaymentIntentStatus | null {
  try {
    return applyEvent(status, event, rail);
  } catch {
    return null;
  }
}

for (const [rail, table] of [
  ['card', CARD],
  ['faircoin', FAIRCOIN],
] as const) {
  describe(`${rail}: every event from every status`, () => {
    for (const [event, row] of Object.entries(table) as [IntentEvent, Row][]) {
      test(event, () => {
        for (const status of PAYMENT_INTENT_STATUSES) {
          const expected = row[status] ?? null;
          expect([status, outcome(status, event, rail)]).toEqual([status, expected]);
        }
      });
    }
  });
}

test('a card event never moves a FairCoin payment, even where the statuses match', () => {
  // `processing` and `requires_action` are shared since ADR 0019.
  expect(() => applyEvent('processing', 'card_succeeded', 'faircoin')).toThrow(/card event/);
  expect(() => applyEvent('requires_action', 'card_processing', 'faircoin')).toThrow(/card event/);
});

test('a chain event never moves a card payment', () => {
  expect(() => applyEvent('processing', 'confirmed', 'card')).toThrow(/faircoin event/);
  expect(() => applyEvent('requires_action', 'broadcast', 'card')).toThrow(/faircoin event/);
});

test('nothing leaves a terminal status, bar the reorg', () => {
  for (const rail of ['card', 'faircoin'] as const) {
    for (const event of Object.keys(CARD) as IntentEvent[]) {
      for (const terminal of ['succeeded', 'canceled'] as const) {
        const next = outcome(terminal, event, rail);
        if (next === null || next === terminal) continue;
        expect([rail, event, terminal, next]).toEqual([
          'faircoin',
          'reorg_below_threshold',
          'succeeded',
          'processing',
        ]);
      }
    }
  }
});
