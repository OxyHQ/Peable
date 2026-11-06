import { describe, expect, test } from 'bun:test';
import * as contract from '@peable.to/contracts/vocabulary/receiveTree';
import {
  SOCIAL_RECEIVE_GAP_LIMIT,
  SOCIAL_RECEIVE_INDEX_LIMIT,
  SOCIAL_RECEIVE_MAX_WATCHED,
  planSocialReceiveWindow,
} from './social-receive';

// The gateway refuses to mint `index >= SOCIAL_RECEIVE_INDEX_LIMIT` (ADR 0021
// D9, amended 2026-11-06; `db/social/receiveCursor.ts` and its realdb test pin
// that side). This file pins the OTHER side: with the wallet's own window plan,
// every index below that limit is watched once it is the highest reserved, and
// the wallet is not capped — and the first index the gateway refuses is exactly
// the first one the wallet could not watch with its gap above it. Both sides
// read one constant, so changing the window without the ceiling fails here.

describe('the gateway ceiling and the wallet window are one bound', () => {
  test('the wallet reads the contract constants, not copies of them', () => {
    expect(SOCIAL_RECEIVE_MAX_WATCHED).toBe(contract.SOCIAL_RECEIVE_MAX_WATCHED);
    expect(SOCIAL_RECEIVE_GAP_LIMIT).toBe(contract.SOCIAL_RECEIVE_GAP_LIMIT);
    expect(SOCIAL_RECEIVE_INDEX_LIMIT).toBe(contract.SOCIAL_RECEIVE_INDEX_LIMIT);
    expect(SOCIAL_RECEIVE_INDEX_LIMIT).toBe(SOCIAL_RECEIVE_MAX_WATCHED - SOCIAL_RECEIVE_GAP_LIMIT);
  });

  test('every index the gateway may mint is watched, gap included, and never caps the wallet', () => {
    // A fresh wallet (nothing watched) and one that already watches everything
    // below the reservation: both must reach the reserved index.
    for (let reserved = 1; reserved < SOCIAL_RECEIVE_INDEX_LIMIT; reserved += 1) {
      for (const highestWatched of [-1, reserved - 1]) {
        const plan = planSocialReceiveWindow({
          highestWatched,
          highestUsed: -1,
          highestReserved: reserved,
        });
        expect(plan.capped).toBe(false);
        const reach = plan.extension
          ? plan.extension.start + plan.extension.count - 1
          : highestWatched;
        expect(reach).toBeGreaterThanOrEqual(reserved + SOCIAL_RECEIVE_GAP_LIMIT);
        expect(reach).toBeLessThanOrEqual(SOCIAL_RECEIVE_MAX_WATCHED - 1);
      }
    }
  });

  test('the first index the gateway refuses is the first one that would cap the wallet', () => {
    const refused = planSocialReceiveWindow({
      highestWatched: -1,
      highestUsed: -1,
      highestReserved: SOCIAL_RECEIVE_INDEX_LIMIT,
    });
    expect(refused.capped).toBe(true);
    const last = planSocialReceiveWindow({
      highestWatched: -1,
      highestUsed: -1,
      highestReserved: SOCIAL_RECEIVE_INDEX_LIMIT - 1,
    });
    expect(last.capped).toBe(false);
    expect(last.extension).toEqual({ start: 0, count: SOCIAL_RECEIVE_MAX_WATCHED });
  });
});
