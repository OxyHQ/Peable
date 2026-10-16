import { config } from '../../config';
import type { Database } from '../../db/postgres';
import { getStripeClient } from '../providers/stripe/client';
import type { TaxProvider } from './provider';
import { createStripeTaxProvider } from './stripeTaxProvider';
import { createTaxService, type TaxService } from './taxService';

/**
 * The deployment's tax provider. Stripe Tax whenever the deployment holds a
 * classifiable Stripe key — the Tax Calculation API needs no card rail, so this
 * does not depend on `STRIPE_ENABLED`. Without one there is no provider, and
 * every sale a registration covers fails closed.
 */
export function configuredTaxProvider(): TaxProvider | undefined {
  if (!config.stripe.secretKey || config.stripe.keyMode === 'unknown') return undefined;
  return createStripeTaxProvider(getStripeClient().tax, config.stripe.keyMode === 'live');
}

export function createConfiguredTaxService(
  db: Database,
  provider = configuredTaxProvider(),
): TaxService {
  return createTaxService({
    db,
    ...(provider ? { provider } : {}),
    ...(config.ipHashSalt ? { ipHashSalt: config.ipHashSalt } : {}),
  });
}

/** One boot line: whether the provider account can calculate. Never fails the boot. */
export async function reportTaxProvider(provider: TaxProvider | undefined): Promise<void> {
  if (!provider) {
    console.info('[tax] no tax provider configured; registered sales fail closed');
    return;
  }
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
