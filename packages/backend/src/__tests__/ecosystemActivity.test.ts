import { afterEach, describe, expect, test } from 'bun:test';
import { ecosystemActivityMiddleware, startEcosystemActivity, stopEcosystemActivity } from '../ecosystemActivity';

const keys = ['OXY_SERVICE_API_KEY', 'OXY_SERVICE_API_SECRET', 'AWS_REGION'] as const;
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
});
