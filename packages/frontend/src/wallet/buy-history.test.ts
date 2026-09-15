/**
 * Tests for buy-order status policy.
 *
 * Which statuses are terminal decides two things that are easy to get wrong in
 * opposite directions: polling a DELIVERED order forever (wasted requests on
 * every visit to the Buy screen), or stopping too early and freezing an order
 * on screen at a status the bridge has already moved past — which for a user
 * who has just paid looks exactly like their money vanishing.
 *
 * The list is pinned against the full `BuyOrderStatus` union so adding a status
 * to the API without classifying it here shows up as a failure rather than
 * silently defaulting to "keep polling".
 */

import { describe, test, expect } from "bun:test";
import {
  isTerminalBuyStatus,
  needsStatusRefresh,
  type BuyHistoryEntry,
} from "./buy-history";
import type { BuyOrderStatus } from "../api/buy";

const ALL_STATUSES: readonly BuyOrderStatus[] = [
  "AWAITING_PAYMENT",
  "PAYMENT_DETECTED",
  "SWAPPING",
  "BURNING",
  "DELIVERING",
  "DELIVERED",
  "FAILED",
  "EXPIRED",
];

const entry = (status: BuyOrderStatus): BuyHistoryEntry => ({
  id: "6a66119e91d13c76b5fc6ae2",
  fairAmountSats: 100_000_000n,
  paymentCurrency: "USDC_BASE",
  paymentAmountFormatted: "0.516487",
  paymentSymbol: "USDC",
  status,
  createdAt: 1_785_073_993,
  updatedAt: 1_785_073_993,
  deliveryTxId: null,
  errorMessage: null,
});

describe("isTerminalBuyStatus", () => {
  test("the bridge never moves away from these", () => {
    expect(isTerminalBuyStatus("DELIVERED")).toBe(true);
    expect(isTerminalBuyStatus("FAILED")).toBe(true);
    expect(isTerminalBuyStatus("EXPIRED")).toBe(true);
  });

  test("everything in flight stays refreshable", () => {
    for (const status of [
      "AWAITING_PAYMENT",
      "PAYMENT_DETECTED",
      "SWAPPING",
      "BURNING",
      "DELIVERING",
    ] as const) {
      expect(isTerminalBuyStatus(status)).toBe(false);
    }
  });

  test("exactly these statuses are terminal, checked against the API union", () => {
    // Pins the classification against every status the API can return, so a
    // status added upstream without being classified here fails the suite.
    expect(ALL_STATUSES.filter(isTerminalBuyStatus)).toEqual([
      "DELIVERED",
      "FAILED",
      "EXPIRED",
    ]);
  });
});

describe("needsStatusRefresh", () => {
  test("an order awaiting payment is polled", () => {
    expect(needsStatusRefresh(entry("AWAITING_PAYMENT"))).toBe(true);
  });

  test("an order mid-flight is polled — the user is waiting on money", () => {
    expect(needsStatusRefresh(entry("SWAPPING"))).toBe(true);
    expect(needsStatusRefresh(entry("DELIVERING"))).toBe(true);
  });

  test("a finished order is never polled again", () => {
    expect(needsStatusRefresh(entry("DELIVERED"))).toBe(false);
    expect(needsStatusRefresh(entry("FAILED"))).toBe(false);
    expect(needsStatusRefresh(entry("EXPIRED"))).toBe(false);
  });
});
