import { config } from '../../config';
import type { Database } from '../../db/postgres';
import { PROVIDER_MODES } from '../providers/provider';
import { getStripeClient } from '../providers/stripe/client';
import type { TaxProvider } from './provider';
import { createStripeTaxProvider } from './stripeTaxProvider';
import { createTaxService, type TaxService } from './taxService';

/**
 * The deployment's tax providers: Stripe Tax once for each mode whose key the
 * deployment holds (ADR 0017) — the Tax Calculation API needs no card rail, so
 * this does not depend on `STRIPE_ENABLED`. A merchant is calculated only by
 * the one in its own mode; with none for that mode, every sale a registration
 * covers fails closed.
 */
export function configuredTaxProviders(): TaxProvider[] {
  return PROVIDER_MODES.filter((mode) => config.stripe[mode] !== undefined).map((mode) =>
    createStripeTaxProvider(getStripeClient(mode).tax, mode === 'live'),
  );
}

export function createConfiguredTaxService(
  db: Database,
  providers = configuredTaxProviders(),
): TaxService {
  return createTaxService({
    db,
    providers,
    ...(config.ipHashSalt ? { ipHashSalt: config.ipHashSalt } : {}),
  });
}

/** One boot line per mode: whether its provider account can calculate. Never fails the boot. */
export async function reportTaxProviders(providers: readonly TaxProvider[]): Promise<void> {
  if (providers.length === 0) {
    console.info('[tax] no tax provider configured; registered sales fail closed');
    return;
  }
  await Promise.all(providers.map(reportTaxProvider));
}

async function reportTaxProvider(provider: TaxProvider): Promise<void> {
  try {
    const status = await provider.status();
    console.info(
      `[tax] ${provider.id} (${provider.livemode ? 'live' : 'test'}) ` +
        `${status.active ? 'active' : 'not active'}; head office ${status.headOffice ? `${status.headOffice.country}${status.headOffice.state ? `-${status.headOffice.state}` : ''}` : 'unset'}` +
        (status.missing.length ? `; missing ${status.missing.join(',')}` : ''),
    );
  } catch (error) {
    console.error(`[tax] ${provider.id} status unavailable: ${(error as Error).message}`);
  }
}
