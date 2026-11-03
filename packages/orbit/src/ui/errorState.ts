import { isOrbitApiError } from '../api/transport';

/**
 * Which state a screen shows for a thrown value. Pure, so the decision is
 * tested once and every screen inherits it through `ErrorNotice`
 * (`OrbitScreen.tsx`).
 *
 * Most of what a gateway refuses is not a failure and is never drawn as one:
 * an application with no merchant in this mode is a first run, a missing
 * permission is something an owner grants, a feature the deployment has not
 * turned on is an explanation. Only what is genuinely broken — no answer, a
 * 5xx, a 429, a body we could not read — is a `failure`, and that is an inline
 * banner over whatever else rendered, never a page-wide headline.
 */
export type ErrorState =
  /** The application has no merchant in this mode: set up payments. */
  | { kind: 'merchant_missing' }
  /** The merchant has no fiat account in this mode: open one. */
  | { kind: 'account_missing' }
  /** Peable Tax is not enabled on this deployment. */
  | { kind: 'feature_unavailable'; feature: 'tax' }
  /**
   * A permission refusal. `permission` names what is missing when the gateway
   * said (`billing:manage`); `membership` is the caller not being a member of
   * the application's Oxy account at all.
   */
  | { kind: 'permission'; permission: string | null; membership: boolean; requestId: string | null }
  /** The Oxy session is no longer valid. */
  | { kind: 'session'; requestId: string | null }
  /** One object the page asked for does not exist (a detail page). */
  | { kind: 'not_found'; message: string; requestId: string | null }
  /** A request the gateway refused for its content (400/409/422). */
  | { kind: 'invalid'; message: string; requestId: string | null }
  /** Broken: no answer, 5xx, 429, an unreadable body, an unknown throw. */
  | {
      kind: 'failure';
      reason: 'network' | 'server' | 'rate_limited' | 'unknown';
      /** The gateway's own sentence, when it gave one. */
      message: string | null;
      requestId: string | null;
    };

/** Pre-`merchant_missing`-code gateways said only this; kept for the deploy window. */
const LEGACY_MERCHANT_MISSING = 'no merchant registered for this application in this environment';
const LEGACY_NOT_A_MEMBER = 'you are not a member of this application';

/** `billing:manage` in "billing:manage is required for tax settings". */
const PERMISSION_IN_MESSAGE = /^([a-z_]+:[a-z_]+) is required\b/;

export function errorState(error: unknown): ErrorState {
  if (isOrbitApiError(error)) {
    const requestId = error.requestId ?? null;
    const { status, code, message } = error;
    if (status === 404 && (code === 'merchant_missing' || message === LEGACY_MERCHANT_MISSING)) {
      return { kind: 'merchant_missing' };
    }
    if (status === 404 && code === 'account_missing') return { kind: 'account_missing' };
    if (status === 404 && code === 'tax_not_enabled') {
      return { kind: 'feature_unavailable', feature: 'tax' };
    }
    if (status === 403 || error.type === 'permission_error') {
      const membership =
        code === 'application_membership_required' ||
        code === 'account_membership_required' ||
        message === LEGACY_NOT_A_MEMBER;
      const permission =
        code === 'permission_required' && error.param
          ? error.param
          : (PERMISSION_IN_MESSAGE.exec(message)?.[1] ?? null);
      return {
        kind: 'permission',
        permission: membership ? null : permission,
        membership,
        requestId,
      };
    }
    if (status === 401) return { kind: 'session', requestId };
    if (status === 404) return { kind: 'not_found', message, requestId };
    if (status === 429) return { kind: 'failure', reason: 'rate_limited', message, requestId };
    if (status >= 500 || status === 0) {
      return { kind: 'failure', reason: 'server', message, requestId };
    }
    if (status >= 400) return { kind: 'invalid', message, requestId };
    return { kind: 'failure', reason: 'unknown', message, requestId };
  }
  // `fetch` rejects with a TypeError when there is no answer at all (offline,
  // DNS, CORS); the Oxy SDK's own transport errors carry no HTTP status.
  if (error instanceof TypeError) {
    return { kind: 'failure', reason: 'network', message: null, requestId: null };
  }
  const message = error instanceof Error && error.message ? error.message : null;
  return { kind: 'failure', reason: 'unknown', message, requestId: null };
}

/** Whether the state is a real failure (banner + Retry) rather than an explanation. */
export function isFailure(state: ErrorState): boolean {
  return state.kind === 'failure';
}
