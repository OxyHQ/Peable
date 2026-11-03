import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { OrbitApiError } from '../api/transport';
import { errorState } from './errorState';
import { pageGate } from './pageGate';

/**
 * Every Orbit screen, and what it shows when the gateway answers 404
 * `merchant_missing` (a first run) or 500 (an outage). Screens cannot render
 * under `bun test` (React Native), so the decision is the template's —
 * `OrbitScreen`'s gate and `ErrorNotice`'s state — and this suite proves each
 * screen goes through them and through nothing that would draw a generic
 * failure headline instead.
 */
const ROUTES = join(import.meta.dir, '../../app/(orbit)');

function screens(dir = ROUTES): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return screens(path);
    if (!name.endsWith('.tsx') || name.startsWith('_') || name.startsWith('+')) return [];
    return [path];
  });
}

const merchantMissing = new OrbitApiError({
  status: 404,
  type: 'invalid_request_error',
  code: 'merchant_missing',
  message: 'no merchant registered for this application in this environment',
  requestId: 'req_missing',
});
const outage = new OrbitApiError({
  status: 500,
  type: 'api_error',
  message: 'internal error',
  requestId: 'req_outage',
});
const probe = (outcome: { error?: unknown; data?: unknown }) => ({
  isPending: false,
  isError: outcome.error !== undefined,
  error: outcome.error ?? null,
  data: outcome.data,
});

const ALL = screens();

describe('every screen', () => {
  it('is found', () => {
    expect(ALL.length).toBeGreaterThan(30);
  });

  for (const file of ALL) {
    const name = relative(ROUTES, file);
    const source = readFileSync(file, 'utf8');
    const optional = source.includes('merchant="optional"');

    describe(name, () => {
      it('renders in the page template, which owns the scope, first-run and failure states', () => {
        expect(/<OrbitScreen\b|<TaxPage\b/.test(source)).toBe(true);
      });

      it('never titles a state with the generic failure sentence', () => {
        expect(source).not.toMatch(/title=\{t\('error\.generic'\)\}/);
        expect(source).not.toMatch(/<EmptyState[^>]*describeError/s);
      });

      it('routes every failed query through ErrorNotice', () => {
        if (/\.isError\b/.test(source)) expect(source).toContain('ErrorNotice');
      });

      if (optional) {
        it('is usable without a merchant, and shows the first-run state where it needs one', () => {
          expect(pageGate('optional', probe({ error: merchantMissing }))).toEqual({ kind: 'page' });
          expect(errorState(merchantMissing)).toEqual({ kind: 'merchant_missing' });
        });
      } else {
        it('a 404 merchant_missing renders the "Set up payments" onboarding state', () => {
          expect(pageGate('required', probe({ data: null }))).toEqual({ kind: 'setup' });
          expect(pageGate('required', probe({ error: merchantMissing }))).toEqual({
            kind: 'setup',
          });
        });
      }

      it('a 500 renders the inline banner with its request id, over the page', () => {
        expect(pageGate(optional ? 'optional' : 'required', probe({ error: outage }))).toEqual(
          optional
            ? { kind: 'page' }
            : {
                kind: 'degraded',
                state: {
                  kind: 'failure',
                  reason: 'server',
                  message: 'internal error',
                  requestId: 'req_outage',
                },
              },
        );
        // And inside the page, a section whose own query fails says the same.
        expect(errorState(outage)).toMatchObject({ kind: 'failure', requestId: 'req_outage' });
      });
    });
  }
});

describe('the gate', () => {
  it('waits on the probe, then shows the page for a merchant', () => {
    expect(
      pageGate('required', { isPending: true, isError: false, error: null, data: undefined }),
    ).toEqual({
      kind: 'loading',
    });
    expect(pageGate('required', probe({ data: { id: 'merch_1' } }))).toEqual({ kind: 'page' });
  });

  it('a refusal is one explanation for the whole page', () => {
    const refused = new OrbitApiError({
      status: 403,
      type: 'permission_error',
      code: 'application_membership_required',
      message: 'you are not a member of this application',
      requestId: 'req_403',
    });
    expect(pageGate('required', probe({ error: refused }))).toEqual({
      kind: 'state',
      state: {
        kind: 'permission',
        permission: null,
        membership: true,
        readOnly: false,
        requestId: 'req_403',
      },
    });
  });
});
