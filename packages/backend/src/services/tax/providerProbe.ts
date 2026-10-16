/**
 * Read-only readiness probe for the deployment's tax provider, run as a
 * one-shot task with the service's own task definition:
 *
 *   bun packages/backend/src/services/tax/providerProbe.ts
 *
 * Reads the provider account's tax settings and active registrations and asks
 * for two calculations against fixed public addresses. A calculation creates
 * no payment, no transaction and no Peable row; nothing here writes anywhere.
 * Prints one JSON line and never a credential or a provider error's text.
 */
import { config } from '../../config';
import { getStripeClient } from '../providers/stripe/client';
import { configuredTaxProvider } from './configuredTax';
import { TaxProviderUnavailableError } from './provider';

const PROBES = [
  { name: 'us_de', customer: { country: 'US', state: 'DE', postalCode: '19901' } },
  { name: 'de', customer: { country: 'DE', postalCode: '10115' } },
] as const;

export async function probeTaxProvider() {
  const provider = configuredTaxProvider();
  if (!provider) return { provider: null, keyMode: config.stripe.keyMode };
  const reason = (error: unknown) =>
    error instanceof TaxProviderUnavailableError
      ? error.reason
      : ((error as { code?: string; type?: string })?.code ??
        (error as { type?: string })?.type ??
        'failed');
  let status: unknown;
  try {
    status = await provider.status();
  } catch (error) {
    status = { error: reason(error) };
  }
  let registrations: unknown;
  try {
    const list = await getStripeClient().tax.registrations.list({ status: 'active', limit: 100 });
    registrations = list.data.map((row) => ({
      country: row.country,
      type: Object.values(
        row.country_options as unknown as Record<string, { type?: string; state?: string }>,
      )
        .map((option) => `${option?.type ?? '?'}${option?.state ? `:${option.state}` : ''}`)
        .join(','),
    }));
  } catch (error) {
    registrations = { error: reason(error) };
  }
  const calculations: Record<string, unknown> = {};
  for (const probe of PROBES) {
    try {
      const result = await provider.calculate({
        currency: 'USD',
        customer: probe.customer,
        shipFrom: null,
        lineItems: [
          {
            reference: 'peable_tax_probe',
            amount: 1000,
            quantity: 1,
            taxCode: 'txcd_10103000',
            taxBehavior: 'exclusive',
          },
        ],
        idempotencyKey: `peable-tax-probe:${probe.name}:${Date.now()}`,
      });
      calculations[probe.name] = {
        livemode: result.livemode,
        amountTax: result.lineItems[0]?.amountTax,
        reasons: result.lineItems[0]?.breakdown.map((entry) => entry.taxabilityReason),
        rates: result.lineItems[0]?.breakdown.map((entry) => entry.ratePercentage),
      };
    } catch (error) {
      calculations[probe.name] = { error: reason(error) };
    }
  }
  return {
    provider: provider.id,
    livemode: provider.livemode,
    status,
    registrations,
    calculations,
  };
}

if (import.meta.main) {
  probeTaxProvider()
    .then((result) => console.log(`[tax-probe] ${JSON.stringify(result)}`))
    .catch(() => {
      console.log('[tax-probe] {"error":"probe_failed"}');
      process.exitCode = 1;
    });
}
