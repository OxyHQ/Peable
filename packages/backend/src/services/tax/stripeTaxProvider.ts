import type Stripe from 'stripe';
import type { TaxAddress, TaxBreakdownEntry } from '@peable.to/shared-types';
import { stripeRegistrationOptions } from './jurisdictions';
import {
  TaxProviderUnavailableError,
  type TaxProvider,
  type TaxProviderCalculation,
  type TaxProviderStatus,
} from './provider';

/** The Stripe Tax surface this provider uses; the SDK's `stripe.tax`. */
export type StripeTaxApi = Pick<Stripe['tax'], 'calculations' | 'registrations' | 'settings'>;

/** A request Stripe refused because the customer's address cannot be placed. */
export class TaxCustomerLocationInvalidError extends Error {
  constructor() {
    super('customer location cannot be placed by the tax provider');
    this.name = 'TaxCustomerLocationInvalidError';
  }
}

const seconds = (date: Date) => Math.floor(+date / 1000);
const address = (value: TaxAddress) => ({
  country: value.country,
  ...(value.state ? { state: value.state } : {}),
  ...(value.postalCode ? { postal_code: value.postalCode } : {}),
  ...(value.city ? { city: value.city } : {}),
  ...(value.line1 ? { line1: value.line1 } : {}),
  ...(value.line2 ? { line2: value.line2 } : {}),
});

function behavior(value: string): 'inclusive' | 'exclusive' {
  if (value === 'inclusive' || value === 'exclusive') return value;
  throw new TaxProviderUnavailableError('unknown_tax_behavior');
}

function unavailable(error: unknown): never {
  const code = (error as { code?: unknown })?.code;
  if (code === 'customer_tax_location_invalid') throw new TaxCustomerLocationInvalidError();
  // No provider text crosses this boundary: it can quote back the address.
  throw new TaxProviderUnavailableError(typeof code === 'string' ? code : 'request_failed');
}

/**
 * Stripe Tax as a Peable tax provider, through the Tax Calculation API — which
 * prices a sale without a Stripe payment, so it serves the FairCoin rail as
 * well as cards. Stripe Tax collects only where the Stripe ACCOUNT is
 * registered, so Peable mirrors its approved registrations here
 * (`syncRegistration`) and treats a `not_collecting` answer for a sale Peable
 * says is registered as a mismatch, never as zero tax.
 */
export function createStripeTaxProvider(api: StripeTaxApi, livemode: boolean): TaxProvider {
  return {
    id: 'stripe_tax',
    livemode,
    async calculate(input): Promise<TaxProviderCalculation> {
      let result: Stripe.Tax.Calculation;
      try {
        result = await api.calculations.create(
          {
            currency: input.currency.toLowerCase(),
            customer_details: { address: address(input.customer), address_source: 'billing' },
            line_items: input.lineItems.map((line) => ({
              amount: line.amount,
              quantity: line.quantity,
              reference: line.reference,
              tax_code: line.taxCode,
              tax_behavior: line.taxBehavior,
            })),
            ...(input.shipFrom ? { ship_from_details: { address: address(input.shipFrom) } } : {}),
            expand: ['line_items.data.tax_breakdown'],
          },
          { idempotencyKey: input.idempotencyKey },
        );
      } catch (error) {
        unavailable(error);
      }
      const lines = result.line_items?.data;
      if (!lines || result.line_items?.has_more || lines.length !== input.lineItems.length)
        throw new TaxProviderUnavailableError('incomplete_line_items');
      if (result.currency.toUpperCase() !== input.currency.toUpperCase())
        throw new TaxProviderUnavailableError('currency_mismatch');
      return {
        providerRef: result.id,
        livemode: result.livemode,
        expiresAt: result.expires_at ? new Date(result.expires_at * 1000) : null,
        lineItems: lines.map((line) => ({
          reference: line.reference,
          amount: line.amount,
          amountTax: line.amount_tax,
          taxBehavior: behavior(line.tax_behavior),
          breakdown: (line.tax_breakdown ?? []).map(
            (entry): TaxBreakdownEntry => ({
              country: entry.jurisdiction.country,
              state: entry.jurisdiction.state ?? null,
              level: entry.jurisdiction.level ?? null,
              displayName: entry.jurisdiction.display_name ?? null,
              taxType: entry.tax_rate_details?.tax_type ?? null,
              ratePercentage: entry.tax_rate_details?.percentage_decimal ?? null,
              taxableAmount: entry.taxable_amount,
              amount: entry.amount,
              inclusive: line.tax_behavior === 'inclusive',
              taxabilityReason: entry.taxability_reason,
            }),
          ),
        })),
      };
    },
    async status(): Promise<TaxProviderStatus> {
      let settings: Stripe.Tax.Settings;
      try {
        settings = await api.settings.retrieve();
      } catch (error) {
        unavailable(error);
      }
      const head = settings.head_office?.address;
      return {
        active: settings.status === 'active',
        headOffice: head?.country
          ? {
              country: head.country,
              state: head.state ?? null,
              postalCode: head.postal_code ?? null,
              city: head.city ?? null,
            }
          : null,
        missing: settings.status_details?.pending?.missing_fields ?? [],
      };
    },
    async ensureHeadOffice(target) {
      const current = await this.status();
      if (current.headOffice) {
        if (
          current.headOffice.country !== target.country ||
          (current.headOffice.state ?? null) !== (target.state ?? null)
        )
          throw new TaxProviderUnavailableError('head_office_differs');
        return;
      }
      try {
        await api.settings.update({ head_office: { address: address(target) } });
      } catch (error) {
        unavailable(error);
      }
    },
    async syncRegistration(registration) {
      const options = stripeRegistrationOptions(registration);
      if (!options) throw new TaxProviderUnavailableError('registration_type_unsupported');
      const [key] = Object.keys(options);
      const wanted = key ? options[key] : undefined;
      try {
        // Idempotent by content: an existing live or scheduled registration of
        // the same kind is the one Peable's registration mirrors.
        for (const status of ['active', 'scheduled'] as const) {
          const existing = await api.registrations.list({ status, limit: 100 });
          const match = existing.data.find((row) => {
            if (row.country !== registration.country || !key) return false;
            const option = (row.country_options as unknown as Record<string, unknown>)[key] as
              | { type?: string; state?: string; province_standard?: { province?: string } }
              | undefined;
            return (
              option?.type === wanted?.type &&
              (option?.state ?? null) === ((wanted?.state as string | undefined) ?? null) &&
              (option?.province_standard?.province ?? null) ===
                ((wanted?.province_standard as { province?: string } | undefined)?.province ?? null)
            );
          });
          if (match) return { providerRef: match.id };
        }
        const created = await api.registrations.create({
          country: registration.country,
          country_options: options as Stripe.Tax.RegistrationCreateParams.CountryOptions,
          active_from:
            +registration.activeFrom <= Date.now() ? 'now' : seconds(registration.activeFrom),
          ...(registration.expiresAt ? { expires_at: seconds(registration.expiresAt) } : {}),
        });
        return { providerRef: created.id };
      } catch (error) {
        if (error instanceof TaxProviderUnavailableError) throw error;
        unavailable(error);
      }
    },
    async endRegistration(providerRef, expiresAt) {
      try {
        await api.registrations.update(providerRef, {
          expires_at: +expiresAt <= Date.now() ? 'now' : seconds(expiresAt),
        });
      } catch (error) {
        unavailable(error);
      }
    },
  };
}
