import { describe, expect, it } from 'bun:test';
import { OrbitApiError } from '../api/transport';
import { errorState, isFailure, permissionCopy, permissionStateFor } from './errorState';

const api = (init: ConstructorParameters<typeof OrbitApiError>[0]) => new OrbitApiError(init);

describe('errorState — what a screen shows for a thrown value', () => {
  it('an application with no merchant in this mode is the first-run state', () => {
    expect(
      errorState(
        api({
          status: 404,
          type: 'invalid_request_error',
          code: 'merchant_missing',
          message: 'no merchant registered for this application in this environment',
          requestId: 'req_1',
        }),
      ),
    ).toEqual({ kind: 'merchant_missing' });
  });

  it('a 404 for one object is "not found", never the first-run state', () => {
    expect(
      errorState(
        api({
          status: 404,
          type: 'invalid_request_error',
          message: 'payment intent not found',
          requestId: 'req_2',
        }),
      ),
    ).toEqual({ kind: 'not_found', message: 'payment intent not found', requestId: 'req_2' });
  });

  it('no fiat account and Tax switched off are explanations, not failures', () => {
    expect(
      errorState(
        api({ status: 404, type: 'invalid_request_error', code: 'account_missing', message: 'x' }),
      ),
    ).toEqual({ kind: 'account_missing' });
    expect(
      errorState(
        api({ status: 404, type: 'invalid_request_error', code: 'tax_not_enabled', message: 'x' }),
      ),
    ).toEqual({ kind: 'feature_unavailable', feature: 'tax' });
  });

  it('a live merchant without its FairCoin key is told to register it, not shown a failure', () => {
    expect(
      errorState(
        api({
          status: 409,
          type: 'invalid_request_error',
          code: 'faircoin_account_required',
          message: 'x',
          requestId: 'req_1',
        }),
      ),
    ).toEqual({ kind: 'faircoin_account_required', requestId: 'req_1' });
  });

  it('a 403 names the missing permission from the code and param', () => {
    expect(
      errorState(
        api({
          status: 403,
          type: 'permission_error',
          code: 'permission_required',
          param: 'billing:manage',
          message: 'billing:manage is required for tax settings',
          requestId: 'req_3',
        }),
      ),
    ).toEqual({
      kind: 'permission',
      permission: 'billing:manage',
      membership: false,
      readOnly: false,
      requestId: 'req_3',
    });
  });

  it('the permission comes only from the structured fields, never from the sentence', () => {
    const state = errorState(
      api({
        status: 403,
        type: 'permission_error',
        message: 'billing:read is required for tax compliance',
      }),
    );
    expect(state).toMatchObject({ kind: 'permission', permission: null, membership: false });
  });

  it('not being a member of the application or account is its own permission state', () => {
    for (const code of ['application_membership_required', 'account_membership_required']) {
      const error = api({
        status: 403,
        type: 'permission_error',
        code,
        message: 'you are not a member of this application',
      });
      expect(errorState(error)).toMatchObject({
        kind: 'permission',
        membership: true,
        permission: null,
      });
    }
  });

  it('a 401 is the session state', () => {
    expect(errorState(api({ status: 401, type: 'authentication_error', message: 'x' }))).toEqual({
      kind: 'session',
      requestId: null,
    });
  });

  it('a 5xx, a 503 outage, a 429 and a 0 are failures with their request id', () => {
    expect(
      errorState(
        api({
          status: 503,
          type: 'api_error',
          code: 'membership_unavailable',
          message: 'could not verify your membership of this application with Oxy; try again',
          requestId: 'req_5',
        }),
      ),
    ).toEqual({
      kind: 'failure',
      reason: 'server',
      message: 'could not verify your membership of this application with Oxy; try again',
      requestId: 'req_5',
    });
    expect(errorState(api({ status: 500, type: 'api_error', message: 'boom' }))).toMatchObject({
      kind: 'failure',
      reason: 'server',
    });
    expect(
      errorState(api({ status: 429, type: 'rate_limit_error', message: 'slow down' })),
    ).toMatchObject({ kind: 'failure', reason: 'rate_limited' });
    expect(errorState(api({ status: 0, type: 'api_error', message: 'not JSON' }))).toMatchObject({
      kind: 'failure',
      reason: 'server',
    });
  });

  it('a refused request body (400/409) is "invalid", a banner too', () => {
    expect(
      errorState(
        api({ status: 400, type: 'invalid_request_error', message: 'bad', requestId: 'r' }),
      ),
    ).toEqual({ kind: 'invalid', message: 'bad', requestId: 'r' });
  });

  it('no answer at all is a network failure; anything else thrown is unknown', () => {
    expect(errorState(new TypeError('Failed to fetch'))).toEqual({
      kind: 'failure',
      reason: 'network',
      message: null,
      requestId: null,
    });
    expect(errorState(new Error('An active Oxy session is required'))).toEqual({
      kind: 'failure',
      reason: 'unknown',
      message: 'An active Oxy session is required',
      requestId: null,
    });
    expect(errorState('weird')).toMatchObject({ kind: 'failure', reason: 'unknown' });
  });

  it('only failures are failures', () => {
    expect(isFailure(errorState(new TypeError('x')))).toBe(true);
    expect(isFailure({ kind: 'merchant_missing' })).toBe(false);
    expect(isFailure({ kind: 'invalid', message: '', requestId: null })).toBe(false);
  });
});

describe('one permission state, refused or known up front', () => {
  it('an action the person lacks is the same state a refusal is, naming the same permission', () => {
    const refused = errorState(
      api({
        status: 403,
        type: 'permission_error',
        code: 'permission_required',
        param: 'billing:manage',
        message: 'this action needs the billing:manage permission on the application',
      }),
    );
    expect(permissionStateFor('money')).toEqual({
      kind: 'permission',
      permission: 'billing:manage',
      membership: false,
      readOnly: true,
      requestId: null,
    });
    expect(refused).toMatchObject({ kind: 'permission', permission: 'billing:manage' });
  });

  it('a write on a readable page is "view, not change"; a read is "cannot see"', () => {
    expect(permissionCopy(permissionStateFor('configure'))).toEqual({
      title: 'state.permission.readOnlyTitle',
      body: 'state.permission.body',
    });
    expect(permissionCopy(permissionStateFor('taxRead'))).toEqual({
      title: 'state.permission.title',
      body: 'state.permission.body',
    });
  });

  it('a non-member and an unnamed permission keep their own wording', () => {
    const base = permissionStateFor('read');
    expect(permissionCopy({ ...base, membership: true, permission: null })).toEqual({
      title: 'state.permission.membershipTitle',
      body: 'state.permission.bodyMembership',
    });
    expect(permissionCopy({ ...base, permission: null }).body).toBe('state.permission.bodyGeneric');
  });
});
