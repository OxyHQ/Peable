import { afterEach, describe, expect, test } from 'bun:test';
import { ecosystemActivityMiddleware, startEcosystemActivity, stopEcosystemActivity } from '../ecosystemActivity';

const keys = ['OXY_ECOSYSTEM_ACTIVITY_ENABLED', 'OXY_SERVICE_API_KEY', 'OXY_SERVICE_API_SECRET', 'AWS_REGION'] as const;
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
  test('disabled collection allows the anonymous checkout request to continue', () => {
    process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED = 'false';
    startEcosystemActivity(() => false);
    let continued = false;
    ecosystemActivityMiddleware({} as never, {} as never, () => { continued = true; });
    expect(continued).toBe(true);
  });
  test('a misspelled activation fails instead of silently losing coverage', () => {
    process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED = 'tru';
    expect(() => startEcosystemActivity(() => true)).toThrow('must be true or false');
  });
  test('enabled collection refuses to boot without a publishing credential', () => {
    process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED = 'true';
    delete process.env.OXY_SERVICE_API_KEY;
    delete process.env.OXY_SERVICE_API_SECRET;
    expect(() => startEcosystemActivity(() => true)).toThrow('OXY_SERVICE_API_KEY');
  });
});
