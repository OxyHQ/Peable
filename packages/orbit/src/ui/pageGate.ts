import { errorState, type ErrorState } from './errorState';

/**
 * What `OrbitScreen` renders for a page, from whether the page needs a
 * merchant and what the merchant probe answered. Pure, so every screen's
 * outcome for a first run, a refusal and an outage is tested once
 * (`screenStates.test.ts`).
 *
 * - `loading`  — the probe is in flight: a skeleton.
 * - `setup`    — no merchant in this mode: "Set up payments" for the page.
 * - `state`    — a refusal or explanation (permission, session…) for the page.
 * - `degraded` — the probe FAILED: a banner over the page, which still renders.
 * - `page`     — the page.
 */
export type PageGate =
  | { kind: 'loading' }
  | { kind: 'setup' }
  | { kind: 'state'; state: ErrorState }
  | { kind: 'degraded'; state: Extract<ErrorState, { kind: 'failure' | 'invalid' }> }
  | { kind: 'page' };

export interface MerchantProbe {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  /** `null`: the application has no merchant in this mode. */
  data: unknown;
}

export function pageGate(merchant: 'required' | 'optional', probe: MerchantProbe): PageGate {
  if (merchant === 'optional') return { kind: 'page' };
  if (probe.isPending) return { kind: 'loading' };
  if (probe.isError) {
    const state = errorState(probe.error);
    if (state.kind === 'merchant_missing') return { kind: 'setup' };
    if (state.kind === 'failure' || state.kind === 'invalid') return { kind: 'degraded', state };
    return { kind: 'state', state };
  }
  if (probe.data === null) return { kind: 'setup' };
  return { kind: 'page' };
}
