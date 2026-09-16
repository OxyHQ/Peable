/**
 * Which screen the sheet is on, and what it is allowed to send.
 *
 * All of it is pure, and none of it imports React. The component below is a
 * renderer for this file's output and an emitter of its events, which is the
 * only way the interesting properties are testable at all: no React Native
 * renderer is configured in this monorepo (`packages/checkout` tests React DOM
 * through happy-dom, which cannot mount an RN tree), so a state machine left
 * inside a component here would ship untested.
 *
 * Two of those properties are about money rather than screens:
 *
 * 1. **Nothing is sent that was not reviewed.** `sendRequestFor` builds the
 *    `PaymentRequest` from the `ReviewedPayment` the confirm step rendered —
 *    including `feePerByte`. Letting `sendPayment` re-fetch the rate would price
 *    the payment at whatever the Explorer says a second later, and the payer is
 *    charged a fee no screen ever showed them.
 *
 * 2. **A stale attempt cannot decide anything.** Every async result carries the
 *    `attempt` it started under, and the reducer drops results from a superseded
 *    one. Without it: type 10, Continue, go back, type 2, Continue — and the
 *    first quote lands second, so the review screen shows a fee for 10 while the
 *    payer believes they are sending 2.
 */

import { explorerTxUrl, buildFairCoinURI, formatUnits } from '@fairco.in/core';
import type { NetworkType } from '@fairco.in/core';
import type { PaymentQuote, PaymentRequest } from '../payment';
import { amountInputFor, parseAmountInput, type AmountEntry } from './amount';
import {
  classifyPayFailure,
  insufficientFundsFailure,
  recoveryFor,
  type PayFailure,
  type PayRecovery,
  type PayStage,
} from './failure';

/** The exact payment the confirm step rendered, and the only thing that is sent. */
export interface ReviewedPayment {
  readonly to: string;
  readonly amountSat: bigint;
  readonly feeSat: bigint;
  readonly totalSat: bigint;
  /** The rate `quotePayment` priced this at. Passed back verbatim. */
  readonly feePerByte: number;
}

/**
 * What a surface with no way to sign offers instead: the address, and the same
 * request as a `faircoin:` URI for the phone that CAN sign it.
 */
export interface HandoffOffer {
  readonly to: string;
  readonly amountSat: bigint;
  readonly uri: string;
}

export interface PaidPayment {
  readonly txid: string;
  readonly to: string;
  readonly amountSat: bigint;
  readonly feeSat: bigint;
  readonly explorerUrl: string;
}

export type PayState =
  | { readonly step: 'amount'; readonly attempt: number; readonly input: string; readonly entry: AmountEntry }
  | { readonly step: 'preparing'; readonly attempt: number; readonly input: string; readonly amountSat: bigint }
  | { readonly step: 'review'; readonly attempt: number; readonly input: string; readonly reviewed: ReviewedPayment }
  | { readonly step: 'handoff'; readonly attempt: number; readonly input: string; readonly offer: HandoffOffer }
  | { readonly step: 'sending'; readonly attempt: number; readonly input: string; readonly reviewed: ReviewedPayment }
  | { readonly step: 'paid'; readonly attempt: number; readonly input: string; readonly paid: PaidPayment }
  | {
      readonly step: 'failed';
      readonly attempt: number;
      readonly input: string;
      readonly failure: PayFailure;
      readonly recovery: PayRecovery;
    };

export type PayEvent =
  | { readonly type: 'amount-typed'; readonly text: string }
  | { readonly type: 'preset-picked'; readonly amountSat: bigint }
  /** The payer asked to continue. Starts a new attempt. */
  | { readonly type: 'continue' }
  | { readonly type: 'prepared'; readonly attempt: number; readonly reviewed: ReviewedPayment }
  | { readonly type: 'handoff'; readonly attempt: number; readonly offer: HandoffOffer }
  /** The payer confirmed the reviewed payment. Starts a new attempt. */
  | { readonly type: 'confirm' }
  | { readonly type: 'paid'; readonly attempt: number; readonly paid: PaidPayment }
  | { readonly type: 'failed'; readonly attempt: number; readonly failure: PayFailure }
  | { readonly type: 'edit' }
  | { readonly type: 'restart' };

export function initialPayState(input = ''): PayState {
  return { step: 'amount', attempt: 0, input, entry: parseAmountInput(input) };
}

/**
 * The whole navigation of the sheet, as one total function.
 *
 * Every unhandled (state, event) pair returns the state UNCHANGED rather than
 * throwing. A reducer that threw on a late result would crash the sheet for the
 * one thing it is most likely to see — a request that resolved after the payer
 * moved on — and a crash in a payment surface reads as a lost payment.
 */
export function payReducer(state: PayState, event: PayEvent): PayState {
  switch (event.type) {
    case 'amount-typed':
      // Only from the amount step. Anywhere else the field is not on screen, and
      // accepting the event would rewrite the amount under a rendered quote.
      if (state.step !== 'amount') return state;
      return { ...state, input: event.text, entry: parseAmountInput(event.text) };

    case 'preset-picked': {
      if (state.step !== 'amount') return state;
      const input = amountInputFor(event.amountSat);
      return { ...state, input, entry: parseAmountInput(input) };
    }

    case 'continue':
      // An amount that did not parse cannot start an attempt. The button is
      // disabled for it too, but the guard is here because the button is not the
      // only thing that can fire this (keyboard submit, an automated tap).
      if (state.step !== 'amount' || state.entry.kind !== 'ok') return state;
      return {
        step: 'preparing',
        attempt: state.attempt + 1,
        input: state.input,
        amountSat: state.entry.amountSat,
      };

    case 'prepared':
      if (state.step !== 'preparing' || event.attempt !== state.attempt) return state;
      return { step: 'review', attempt: state.attempt, input: state.input, reviewed: event.reviewed };

    case 'handoff':
      if (state.step !== 'preparing' || event.attempt !== state.attempt) return state;
      return { step: 'handoff', attempt: state.attempt, input: state.input, offer: event.offer };

    case 'confirm':
      if (state.step !== 'review') return state;
      // The SAME `reviewed` object carries forward, by reference. Rebuilding it
      // here from anything else is how a confirm step and a send disagree.
      return {
        step: 'sending',
        attempt: state.attempt + 1,
        input: state.input,
        reviewed: state.reviewed,
      };

    case 'paid':
      if (state.step !== 'sending' || event.attempt !== state.attempt) return state;
      return { step: 'paid', attempt: state.attempt, input: state.input, paid: event.paid };

    case 'failed':
      // Accepted from either in-flight step only. A failure from an attempt the
      // payer has already abandoned must not replace the screen they are on.
      if (state.step !== 'preparing' && state.step !== 'sending') return state;
      if (event.attempt !== state.attempt) return state;
      return {
        step: 'failed',
        attempt: state.attempt,
        input: state.input,
        failure: event.failure,
        recovery: recoveryFor(event.failure.stage),
      };

    case 'edit':
      if (state.step === 'sending' || state.step === 'paid') return state;
      // A failure whose recovery is `restart` must not be walked back into with
      // the typed amount intact: that is the signed-and-broadcast case, where
      // resuming means re-sending inputs that may already be spent. It has to go
      // through `restart`, which re-reads the chain.
      if (state.step === 'failed' && state.recovery === 'restart') return state;
      // A new attempt number, so anything still in flight from the attempt being
      // abandoned can no longer land.
      return {
        step: 'amount',
        attempt: state.attempt + 1,
        input: state.input,
        entry: parseAmountInput(state.input),
      };

    case 'restart':
      // Keeps counting rather than resetting to zero. Attempt numbers only work
      // as a filter while they are never reused: restarting to 0 and continuing
      // would produce a second attempt 1, which is exactly the number a request
      // still in flight from before the restart is stamped with.
      return {
        step: 'amount',
        attempt: state.attempt + 1,
        input: '',
        entry: parseAmountInput(''),
      };
  }
}

/**
 * The quote, turned into either a reviewable payment or the refusal to show one.
 *
 * `feeSat` and `totalSat` are `null` on an unaffordable quote, and this is the
 * only place that is checked. A review built from a null fee would render an
 * empty fee row and a confirm button over a payment that cannot be built.
 */
export type PreparedOutcome =
  | { readonly kind: 'review'; readonly reviewed: ReviewedPayment }
  | { readonly kind: 'failed'; readonly failure: PayFailure };

export function prepareFromQuote(
  quote: PaymentQuote,
  to: string,
  amountSat: bigint,
): PreparedOutcome {
  if (quote.insufficientFunds || quote.feeSat === null || quote.totalSat === null) {
    return { kind: 'failed', failure: insufficientFundsFailure(quote.maxSendableSat) };
  }
  return {
    kind: 'review',
    reviewed: {
      to,
      amountSat,
      feeSat: quote.feeSat,
      totalSat: quote.totalSat,
      feePerByte: quote.feePerByte,
    },
  };
}

/**
 * The request `sendPayment` is called with — every money field copied from the
 * reviewed payment, none of them recomputed.
 *
 * `feePerByte` in particular: omitting it makes `sendPayment` ask the Explorer
 * for a fresh rate, and the fee on the receipt is then a number the confirm
 * screen never showed. That is the whole reason `PaymentQuote` carries the rate
 * it priced at.
 */
export function sendRequestFor(
  reviewed: ReviewedPayment,
  seed: Uint8Array,
  network: NetworkType,
  minConfirmations?: number,
): PaymentRequest {
  return {
    seed,
    network,
    minConfirmations,
    to: reviewed.to,
    amountSat: reviewed.amountSat,
    feePerByte: reviewed.feePerByte,
  };
}

/**
 * The receipt. The fee is the one the TRANSACTION pays (from `PaymentResult`),
 * not the one the quote predicted — those agree today because `feePaidBy`
 * refuses to send when they do not, and a receipt should still report what
 * happened rather than what was forecast.
 */
export function paidFrom(
  reviewed: ReviewedPayment,
  result: { readonly txid: string; readonly feeSat: bigint },
): PaidPayment {
  return {
    txid: result.txid,
    to: reviewed.to,
    amountSat: reviewed.amountSat,
    feeSat: result.feeSat,
    explorerUrl: explorerTxUrl(result.txid),
  };
}

/**
 * The offer for a surface that cannot sign.
 *
 * The amount goes into the URI as a FAIR DECIMAL, not as base units, because
 * BIP21's `amount` is denominated in whole coins and every wallet that parses
 * this — including `parseFairCoinURI` — reads it that way. Handing it
 * `1000000000` base units would open the payer's phone prefilled with a billion
 * FAIR. `formatUnits` and not `formatFair`: the latter inserts thousands
 * separators, which a URI parser reads as malformed and drops.
 */
export function handoffFor(to: string, amountSat: bigint, label?: string): HandoffOffer {
  return { to, amountSat, uri: buildFairCoinURI(to, formatUnits(amountSat), label) };
}

export { classifyPayFailure, type PayFailure, type PayRecovery, type PayStage };
