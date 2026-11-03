import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** AWS SSM owns runtime credentials. Deployment must never copy them from GitHub.
 * Every config variable still requires an explicit infrastructure classification;
 * actual task references and parameter existence are verified by oxy-infra rollout.
 */
/** The repo root: `packages/backend/src/db/__tests__` is five deep. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const WORKFLOW = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'deploy-aws.yml'), 'utf8');
const CONFIG = readFileSync(join(REPO_ROOT, 'packages', 'backend', 'src', 'config.ts'), 'utf8');

const INFRA_CONFIGURATION: Readonly<Record<string, string>> = {
  STRIPE_ENABLED: 'explicit infrastructure activation flag; never a secret',
  STRIPE_ACCOUNT_ID_TEST: 'explicit expected test provider business account identity',
  STRIPE_ACCOUNT_ID_LIVE: 'explicit expected live provider business account identity',
  STRIPE_ACCOUNT_ID: 'reviewed public provider account identity pinned at startup',
  PEABLE_BILLING_COHORT:
    'reviewed merchant/app/environment/platform-account cohort and Portal configuration; no credentials; absent by default and set only for the coordinated cohort activation',
  // PATHS, not secrets. The signing key itself is the SSM SecureString
  // /oxy/peable/BILLING_INVOICE_PRIVATE_KEY, written once by the operator and
  // never by this workflow; oxy-infra's app-service `secret_files` mounts it
  // read-only into the container and sets this variable to where it landed.
  PEABLE_BILLING_INVOICE_PRIVATE_KEY_FILE:
    'the path of the mounted signing-key file; the key is an operator-owned SSM secret mounted by the task definition',
  // Public chain infrastructure. `@fairco.in/core` supplies the default and an
  // override is an operational choice, not a credential.
  EXPLORER_BASE_URL: 'a public Explorer URL, defaulted from @fairco.in/core',
  // ADR 0015: the release gate and Orbit's default fee. Reviewed deployment
  // decisions, never credentials; all three default closed (false / zero).
  ORBIT_THIRD_PARTY_LIVE_PAYMENTS:
    'the ADR 0015 legal release gate for third-party live destination charges and payouts; false unless explicitly opened',
  ORBIT_FEE_PERCENT_BPS: "Orbit's default application fee rate in basis points; 0 when unset",
  ORBIT_FEE_FIXED: "Orbit's default fixed application fee per currency; none when unset",
  // Plain configuration, and both have safe defaults in `config.ts`.
  PEABLE_NETWORK: 'mainnet|testnet, a deployment shape rather than a credential',
  PEABLE_SOCIAL_PAY_NETWORK:
    'which network pay-by-@username is enabled on; a deployment decision, and ' +
    'it defaults to testnet, so a deployment that never sets it stays closed',
  PEABLE_ALLOWED_ORIGINS: 'a CORS allow-list; public by definition',
  PEABLE_CHECKOUT_BASE_URL: 'the public checkout origin',
  PEABLE_API_BASE_URL: 'the gateway public origin, for object URLs such as a report file contents',
  PEABLE_CONNECT_ONBOARDING_BASE_URL:
    'the public seller-onboarding page (ADR 0012), defaulted to the Peable wallet',
  OXY_API_URL: 'the public Oxy API origin',
  PORT: 'the listen port, set by the task definition',
  OXY_FILE_RECONCILIATION_MODE:
    'apply|dry-run|off for the Oxy file-reference reconciliation; a deployment decision with a safe default',
};

/**
 * Source with comments removed.
 *
 * Not fussiness: `config.ts`'s own docblock contains the sentence "no
 * `process.env.X!`", and scanning the raw file reports a variable named `X` that
 * nothing reads. A gate whose first run fails on its own prose is a gate people
 * learn to widen rather than trust.
 *
 * Block comments go wholesale; for line comments only WHOLE-LINE ones are
 * dropped (`//` or a leading `*`), because a trailing `//` rule would cut a line
 * at the first `https://` and take real code with it.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    })
    .join('\n');
}

/** Every `env.NAME` the config reads. */
function configVariables(): string[] {
  const found = new Set<string>();
  for (const match of withoutComments(CONFIG).matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) {
    const name = match[1];
    if (name) found.add(name);
  }
  return [...found].sort();
}

const AWS_RUNTIME_SECRETS = [
  'DATABASE_URL',
  'IP_HASH_SALT',
  'OXY_FILES_WEBHOOK_SECRET',
  'OXY_FILES_WEBHOOK_SECRET_PREVIOUS',
  'STRIPE_SECRET_KEY_TEST',
  'STRIPE_PUBLISHABLE_KEY_TEST',
  'STRIPE_WEBHOOK_SECRET_TEST',
  'STRIPE_CONNECT_WEBHOOK_SECRET_TEST',
  'STRIPE_WEBHOOK_SECRET_PREVIOUS_TEST',
  'STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS_TEST',
  'STRIPE_SECRET_KEY_LIVE',
  'STRIPE_PUBLISHABLE_KEY_LIVE',
  'STRIPE_WEBHOOK_SECRET_LIVE',
  'STRIPE_CONNECT_WEBHOOK_SECRET_LIVE',
  'STRIPE_WEBHOOK_SECRET_PREVIOUS_LIVE',
  'STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS_LIVE',
] as const;

describe('AWS owns backend runtime credentials', () => {
  it('forbids GitHub credential copying and SSM mutation in deployment', () => {
    expect(WORKFLOW).not.toMatch(/secrets\.[A-Z_]+/);
    expect(WORKFLOW).not.toContain('sync_secret');
    expect(WORKFLOW).not.toContain('put-parameter');
  });
  it('classifies every config read without silently losing a credential', () => {
    const configured = new Set([...Object.keys(INFRA_CONFIGURATION), ...AWS_RUNTIME_SECRETS]);
    expect(configVariables().filter((name) => !configured.has(name))).toEqual([]);
    expect(configVariables().length).toBeGreaterThanOrEqual(20);
    const read = new Set(configVariables());
    for (const name of configured) expect([name, read.has(name)]).toEqual([name, true]);
    for (const reason of Object.values(INFRA_CONFIGURATION))
      expect(reason.length).toBeGreaterThan(10);
  });
});
