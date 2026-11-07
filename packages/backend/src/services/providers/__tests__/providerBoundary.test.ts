/**
 * The card provider stays behind ONE boundary (`services/providers/provider.ts`).
 *
 * Stripe is the one contracted provider. Its SDK and its adapter live under
 * `services/providers/stripe/`; the rest of the gateway asks `registry.ts` for a
 * `PaymentProvider` and talks to the interface, so a payment, a refund or a
 * dispute is never written against Stripe's own types. Multi-provider routing is
 * out of scope until a second provider is contracted (a business decision,
 * `docs/orbit/stripe-parity.md`), and this boundary is what keeps that a
 * contained change rather than a rewrite: one adapter and one registry entry.
 *
 * This reads every source file and fails on an import of the `stripe` package
 * or of `providers/stripe/*` outside the places named below, each with its
 * reason. A new entry here is a decision, not a convenience: put a new provider
 * capability (Identity, Terminal, …) on the interface and its Stripe
 * implementation under `providers/stripe/`.
 */
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '..', '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** The code, without its comments: a doc may NAME a module without importing it. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** `from 'stripe'`, `import('stripe')`, `require('stripe')`, and any `…/providers/stripe/…` or `./stripe/…` adapter path. */
const STRIPE_IMPORT =
  /(?:from\s+|import\(\s*|require\(\s*)['"](?:stripe|[^'"]*\/providers\/stripe\/[^'"]*|\.\/stripe\/[^'"]*)['"]/;

/** Outside the adapter itself, the only files that may name Stripe's code, and why. */
const ALLOWED: Readonly<Record<string, string>> = {
  'services/providers/registry.ts': 'the one place an adapter is constructed per (provider, mode)',
  'services/providers/ingress.ts':
    "the inbound webhook's scope is Stripe's (platform vs connect endpoint secrets)",
  'routes/providerWebhooks.ts': "Stripe's own inbound webhook endpoints, verified on the raw bytes",
  'server.ts': 'boot: configures the per-mode adapters and probes the account identity',
  'services/tax/stripeTaxProvider.ts':
    "Peable Tax's tax-provider adapter (ADR 0011); a separate boundary from the card rail",
  'services/tax/providerProbe.ts': 'the tax adapter probing its own Stripe Tax account',
  'services/tax/configuredTax.ts': 'wires the tax adapter for each configured mode',
  'dev/startStripeTest.ts': 'the local TEST-mode harness (docs/local-stripe-test.md)',
  'dev/stripeTestCardPolicy.ts': 'the local TEST-mode harness',
  'dev/stripeTestCheckout.ts': 'the local TEST-mode harness',
};

const FILES = sources(SRC).map((path) => ({ file: relative(SRC, path), text: code(path) }));

test('only the provider adapter (and the named exceptions) import Stripe', () => {
  const offenders = FILES.filter(
    ({ file, text }) =>
      !file.startsWith('services/providers/stripe/') && !ALLOWED[file] && STRIPE_IMPORT.test(text),
  ).map(({ file }) => file);
  expect(offenders).toEqual([]);
});

test('every exception still exists and still needs to be one', () => {
  const stale = Object.keys(ALLOWED).filter((file) => {
    const found = FILES.find((candidate) => candidate.file === file);
    return !found || !STRIPE_IMPORT.test(found.text);
  });
  expect(stale).toEqual([]);
});

test('the pattern sees the forms an import takes', () => {
  for (const line of [
    "import Stripe from 'stripe';",
    "import type Stripe from 'stripe';",
    "const { getStripeClient } = await import('../providers/stripe/client');",
    "import { verify } from './stripe/verify';",
    "import type { StripeWebhookScope } from '../services/providers/stripe/stripeProvider';",
  ]) {
    expect(STRIPE_IMPORT.test(line)).toBe(true);
  }
  expect(STRIPE_IMPORT.test("import { resolveProvider } from './registry';")).toBe(false);
  expect(STRIPE_IMPORT.test("const provider: ProviderId = 'stripe';")).toBe(false);
});
