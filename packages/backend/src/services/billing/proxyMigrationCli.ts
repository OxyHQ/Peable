/**
 * Migrate the Stripe-Billing proxy's subscriptions onto native ones (ADR 0018
 * §7), one mode at a time:
 *
 *     bun run billing:migrate-proxy -- --mode=test                    # dry run (the default)
 *     bun run billing:migrate-proxy -- --mode=test --execute --plan=plan.json
 *     bun run billing:migrate-proxy -- --mode=live --execute --plan=plan.json \
 *       --cohort=merch_… --confirm-live=merch_…
 *
 * A dry run plans every proxied subscription of the mode inside a READ-ONLY
 * database transaction, over a provider that holds only Stripe reads, and
 * prints the report: per cohort (merchant), what would happen to each
 * subscription and why anything is blocked. It needs a Stripe key only when
 * the mode has proxied subscriptions; without one they are reported blocked.
 *
 * `--execute` resumes unfinished migrations first, then migrates what the plan
 * allows. In live mode it moves ONE named cohort and only with
 * `--confirm-live` naming that same merchant.
 *
 * The plan (`--plan=<file>` or `PEABLE_PROXY_MIGRATION_PLAN`) maps each bound
 * Stripe price to the Orbit price of the same offer, per merchant:
 * `{"cohorts":{"merch_…":{"prices":{"price_<stripe>":"price_<orbit>"}}}}`.
 *
 * Other options: `--limit=N` (new adoptions per run), `--lead-hours=48` (a
 * subscription renewing sooner is left for after Stripe's renewal).
 *
 * Run it as a one-shot ECS task of the release image, like a migration. The
 * report holds public ids and Stripe subscription ids, no personal data.
 */
import { readFileSync } from 'node:fs';
import { config } from '../../config';
import { connectPostgres, disconnectPostgres, getDb } from '../../db/postgres';
import { selectStoredProvider } from '../providers/environmentGuard';
import { isSetupHoldingProvider, type ProviderMode } from '../providers/provider';
import { stripeBillingClient } from '../providers/stripe/client';
import {
  DEFAULT_PROXY_MIGRATION_LEAD_MS,
  proxyMigrationPlanSchema,
  runProxyMigration,
  type ProxyMigrationProvider,
} from './proxyMigration';

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function fail(message: string): never {
  throw new Error(message);
}

/** The mode's Stripe reads and its one write, or `undefined` when the mode has no key. */
function providerFor(mode: ProviderMode): ProxyMigrationProvider | undefined {
  if (!config.stripe[mode]) return undefined;
  const client = stripeBillingClient(mode);
  const list = client.listSubscriptionInvoices;
  return {
    livemode: mode === 'live',
    account: () => client.account(),
    retrieveSubscription: (ref) => client.retrieveSubscription(ref),
    retrieveCustomer: (ref) => client.retrieveCustomer(ref),
    retrievePrice: (ref) => client.retrievePrice(ref),
    listSubscriptionInvoices: (ref, after) => list(ref, after),
    readPaymentMethod: async (ref) => {
      // The card rail that will charge the renewals reads the card: no card
      // rail in this mode, nothing to charge them with.
      const card = selectStoredProvider('stripe', mode === 'live');
      if (!card || !isSetupHoldingProvider(card)) fail('card rail unavailable');
      return card.getPaymentMethod(ref);
    },
    updateSubscription: (ref, params, key) => client.updateSubscription(ref, params, key),
  };
}

async function main(): Promise<void> {
  console.info('billing-proxy-migration: start');
  const mode = option('mode');
  if (mode !== 'test' && mode !== 'live') fail('--mode=test or --mode=live is required');
  const execute = process.argv.includes('--execute');
  const cohort = option('cohort');
  if (execute && mode === 'live') {
    const confirmed = option('confirm-live');
    if (!cohort || confirmed !== cohort)
      fail('a live --execute moves one --cohort=merch_… and needs --confirm-live naming it');
  }
  const rawPlan = option('plan')
    ? readFileSync(option('plan') as string, 'utf8')
    : process.env.PEABLE_PROXY_MIGRATION_PLAN;
  const plan = proxyMigrationPlanSchema.parse(rawPlan ? JSON.parse(rawPlan) : { cohorts: {} });
  const limit = option('limit') === undefined ? undefined : Number(option('limit'));
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) fail('--limit is a count');
  const leadHours = option('lead-hours') === undefined ? undefined : Number(option('lead-hours'));
  if (leadHours !== undefined && !(leadHours >= 24)) fail('--lead-hours is at least 24');
  const provider = providerFor(mode);
  await connectPostgres();
  try {
    const common = {
      db: getDb(),
      livemode: mode === 'live',
      plan,
      cohort,
      leadMs: leadHours === undefined ? DEFAULT_PROXY_MIGRATION_LEAD_MS : leadHours * 3600_000,
      ...(limit === undefined ? {} : { limit }),
    };
    if (execute && !provider) fail(`no Stripe key for ${mode} mode`);
    const report =
      execute && provider
        ? await runProxyMigration({ ...common, dryRun: false, provider })
        : await runProxyMigration({ ...common, dryRun: true, provider });
    console.info(JSON.stringify(report, null, 2));
    const failed = report.cohorts.some((c) =>
      c.subscriptions.some(
        (s) => s.outcome?.startsWith('failed') || s.outcome?.startsWith('anomaly'),
      ),
    );
    if (failed) process.exitCode = 1;
  } finally {
    await disconnectPostgres();
  }
  console.info('billing-proxy-migration: end');
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      `billing-proxy-migration: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
