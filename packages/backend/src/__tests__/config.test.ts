import { test, expect } from 'bun:test';
import { loadConfig } from '../config';

/**
 * `DATABASE_URL` is REQUIRED, so every fixture below carries it — these tests
 * are about other variables, and an env without it would fail on a refusal
 * that has nothing to do with what they assert. The value is never connected
 * to; `loadConfig` is pure over its argument.
 */
const DB = { DATABASE_URL: 'postgres://peable:peable@localhost:5432/peable' };

test('oxyApiUrl reads OXY_API_URL', () => {
  expect(loadConfig({ ...DB, OXY_API_URL: 'https://oxy-api.internal' }).oxyApiUrl).toBe(
    'https://oxy-api.internal',
  );
});

test("oxyApiUrl defaults to https://api.oxy.so when unset — Oxy's production API", () => {
  expect(loadConfig({ ...DB }).oxyApiUrl).toBe('https://api.oxy.so');
});

test('Oxy Files: the reconciliation applies by default, and a typo is refused rather than guessed', () => {
  expect(loadConfig({ ...DB }).oxyFiles).toEqual({
    webhookSecret: undefined,
    webhookSecretPrevious: undefined,
    reconciliationMode: 'apply',
  });
  expect(
    loadConfig({ ...DB, OXY_FILE_RECONCILIATION_MODE: 'dry-run' }).oxyFiles.reconciliationMode,
  ).toBe('dry-run');
  expect(() => loadConfig({ ...DB, OXY_FILE_RECONCILIATION_MODE: 'dryrun' })).toThrow(
    'OXY_FILE_RECONCILIATION_MODE',
  );
  expect(loadConfig({ ...DB, OXY_FILES_WEBHOOK_SECRET: ' whsec_x ' }).oxyFiles.webhookSecret).toBe(
    'whsec_x',
  );
});
