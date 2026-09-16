/**
 * Turning anything that can go wrong into one of six sentences a payer can act on.
 *
 * The package throws `Error`s written for a developer reading a stack trace —
 * `"Insufficient funds in selected coins: need 1234 m⊜, selected 900 m⊜"`,
 * `"broadcast failed: HTTP 500"`. Rendering those verbatim is the failure this
 * module exists to prevent: the payer cannot tell "you don't have enough" from
 * "the network is down" from "we have a bug", and those three have three
 * different next actions.
 *
 * Classification is STAGE-AWARE, and that is load-bearing rather than tidy.
 * Nothing local is thrown during broadcast — every local refusal in
 * `sendPayment` (selection, the change-address guard, the fee cross-check, the
 * signing guards) happens BEFORE a single byte goes to the network, and each has
 * a message this file recognises. So an unrecognised error in the `send` stage
 * is, by elimination, the daemon's own answer, and the honest thing to say is
 * that the network refused it.
 */

import { COIN_TICKER, formatFair } from '@fairco.in/core';

const KEYLESS_TYPE = 'keyless_recipient';

/** Where in the flow the failure happened. The classifier needs this. */
export type PayStage = 'resolve' | 'prepare' | 'send';

export type PayFailureKind =
  | 'recipient-cannot-receive'
  | 'insufficient-funds'
  | 'no-fee-rate'
  | 'broadcast-rejected'
  | 'unavailable'
  | 'unknown';

export interface PayFailure {
  readonly kind: PayFailureKind;
  readonly stage: PayStage;
  /** The one line the sheet shows large. */
  readonly title: string;
  /** What the thing that failed actually said. Shown small, or not at all. */
  readonly detail: string | null;
}

/**
 * The three shapes a "this person cannot be paid yet" rejection arrives in.
 *
 * The gateway answers `409` with `error.type === 'keyless_recipient'`
 * (`backend/src/routes/social.ts`). Whether the CALLER's `resolveAddress` passes
 * that through as a status, as a typed body, or as a named error class depends
 * entirely on which client it used — the Peable app throws
 * `KeylessRecipientError`, a raw `fetch` caller has only the status. Recognising
 * one shape and not the others would surface a normal, expected, explainable
 * state ("they haven't set up their wallet") as a generic crash message.
 */
export function isKeylessRecipient(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    name?: unknown;
    status?: unknown;
    code?: unknown;
    type?: unknown;
    error?: { type?: unknown } | null;
  };

  if (candidate.name === 'KeylessRecipientError') return true;
  if (candidate.code === KEYLESS_TYPE || candidate.type === KEYLESS_TYPE) return true;
  if (candidate.error?.type === KEYLESS_TYPE) return true;

  // Status alone, with no body to read. 409 is the ONLY conflict this route
  // answers, so on a reservation call it can mean nothing else.
  return candidate.status === 409;
}

/**
 * Local refusals from `sendPayment` that mean a BUG here, not a network answer.
 *
 * They are listed so the `send`-stage fallback stays true. Without this list a
 * change address the wallet does not own — a defect that would have taken the
 * payer's money — would be reported to them as "the network turned it down",
 * which is both false and un-debuggable.
 */
const LOCAL_SEND_GUARDS = [
  /^refusing to send/i,
  /^cannot sign for/i,
  /^no selected utxo/i,
  /target value must be positive/i,
];

const INSUFFICIENT_FUNDS = /insufficient funds/i;
const NO_FEE_RATE = /fee estimate|feeperbyte must be/i;
const UNAVAILABLE = /network request failed|fetch failed|failed to fetch|timeout|econnrefused|HTTP 5\d\d/i;

/**
 * The one entry point. `stage` is not optional because the same message means
 * different things depending on where it came from, and the caller always knows.
 */
export function classifyPayFailure(stage: PayStage, error: unknown): PayFailure {
  const detail = messageOf(error);

  if (stage === 'resolve' && isKeylessRecipient(error)) {
    return {
      kind: 'recipient-cannot-receive',
      stage,
      title: "They can't receive payments yet",
      detail: null,
    };
  }

  if (detail !== null && INSUFFICIENT_FUNDS.test(detail)) {
    return insufficientFunds(stage, detail);
  }

  if (detail !== null && NO_FEE_RATE.test(detail)) {
    return {
      kind: 'no-fee-rate',
      stage,
      // Deliberately not "try again with a different fee": there is no fee to
      // fall back to. `resolveFeePerByte` refuses to guess a rate precisely
      // because a guessed one below the relay minimum produces a payment that
      // silently never arrives.
      title: "We couldn't price this payment",
      detail,
    };
  }

  if (stage === 'send' && detail !== null && LOCAL_SEND_GUARDS.some((p) => p.test(detail))) {
    return { kind: 'unknown', stage, title: 'Something went wrong', detail };
  }

  if (detail !== null && UNAVAILABLE.test(detail)) {
    return {
      kind: 'unavailable',
      stage,
      title: "We couldn't reach the network",
      detail,
    };
  }

  if (stage === 'send') {
    return {
      kind: 'broadcast-rejected',
      stage,
      title: 'The network turned this payment down',
      detail,
    };
  }

  return { kind: 'unknown', stage, title: 'Something went wrong', detail };
}

/**
 * The insufficient-funds failure built from a QUOTE rather than from a throw.
 *
 * `quotePayment` reports it as a flag and never raises, because a UI asks for a
 * quote on every keystroke. So this path has no `Error` to classify and has
 * something better instead: the largest amount that WOULD go through.
 */
export function insufficientFundsFailure(maxSendableSat: bigint): PayFailure {
  return insufficientFunds('prepare', null, maxSendableSat);
}

/** What the sheet offers after a failure. */
export type PayRecovery = 'edit' | 'restart';

/**
 * Where a failure lets the payer go back to.
 *
 * A `send`-stage failure NEVER returns to the reviewed payment for a one-tap
 * retry, and that is a money decision rather than a UX one. The transaction was
 * signed and handed to the network; a lost response is indistinguishable from a
 * rejection, so the same inputs may already be spent. Re-confirming the same
 * reviewed payment would ask the payer to send a second time on the strength of
 * an outcome nobody knows. Starting over re-reads the chain, so the second
 * attempt is priced against what actually happened.
 */
export function recoveryFor(stage: PayStage): PayRecovery {
  return stage === 'send' ? 'restart' : 'edit';
}

function insufficientFunds(
  stage: PayStage,
  detail: string | null,
  maxSendableSat?: bigint,
): PayFailure {
  return {
    kind: 'insufficient-funds',
    stage,
    title: "You don't have enough to cover this",
    detail:
      maxSendableSat !== undefined
        ? `Most you can send right now: ${formatFair(maxSendableSat)} ${COIN_TICKER}`
        : detail,
  };
}

function messageOf(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error.trim() !== '') return error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  return null;
}
