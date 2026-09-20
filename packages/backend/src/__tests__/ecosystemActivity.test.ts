import { afterEach, describe, expect, test } from 'bun:test';
import { canStartEcosystemActivity, ecosystemActivityMiddleware, startEcosystemActivity, stopEcosystemActivity } from '../ecosystemActivity';

const keys = [
  'OXY_SERVICE_API_KEY',
  'OXY_SERVICE_API_SECRET',
  'AWS_REGION',
  'OXY_API_URL',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
] as const;
const initial = Object.fromEntries(keys.map(key => [key, process.env[key]]));
afterEach(async () => {
  await stopEcosystemActivity();
  for (const key of keys) {
    const value = initial[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('ecosystem activity configuration', () => {
  test('missing credentials allow the anonymous checkout request to continue', () => {
    delete process.env.OXY_SERVICE_API_KEY;
    delete process.env.OXY_SERVICE_API_SECRET;
    startEcosystemActivity(() => false);
    let continued = false;
    ecosystemActivityMiddleware({} as never, {} as never, () => { continued = true; });
    expect(continued).toBe(true);
  });
  test('a credential missing only its pair is a no-op, not a crash', () => {
    process.env.OXY_SERVICE_API_KEY = 'key';
    delete process.env.OXY_SERVICE_API_SECRET;
    expect(() => startEcosystemActivity(() => true)).not.toThrow();
    let continued = false;
    ecosystemActivityMiddleware({} as never, {} as never, () => { continued = true; });
    expect(continued).toBe(true);
  });
  test('blank credentials are treated as absent', () => {
    process.env.OXY_SERVICE_API_KEY = '   ';
    process.env.OXY_SERVICE_API_SECRET = '   ';
    expect(() => startEcosystemActivity(() => true)).not.toThrow();
    let continued = false;
    ecosystemActivityMiddleware({} as never, {} as never, () => { continued = true; });
    expect(continued).toBe(true);
  });
  /**
   * The case the migration off the key pair makes NORMAL: a task carrying no
   * credential at all, which can still prove what it is. Gating on the pair
   * would have taken peable off the ecosystem dashboard the moment the secret
   * left its task definition, without failing anything.
   *
   * The DECISION is asserted rather than the publisher, deliberately: starting
   * one installs interval timers, a global `fetch` wrapper and a heartbeat that
   * would reach for the credentials endpoint, none of which belongs in a unit
   * test of a gate.
   */
  test('an attestable workload with no key pair at all may publish', () => {
    delete process.env.OXY_SERVICE_API_KEY;
    delete process.env.OXY_SERVICE_API_SECRET;
    expect(canStartEcosystemActivity()).toBe(false);
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = 'http://169.254.170.2/v2/credentials/example';
    expect(canStartEcosystemActivity()).toBe(true);
  });

  test('a key pair still admits a process that cannot attest anything', () => {
    delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
    delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    process.env.OXY_SERVICE_API_KEY = 'key';
    process.env.OXY_SERVICE_API_SECRET = 'secret';
    expect(canStartEcosystemActivity()).toBe(true);
  });
});
