import type { Peable, BillingTaxQuote } from '@peable.to/sdk';
import type { CreateBillingCheckoutParams } from '@peable.to/shared-types';
declare const sdk: Peable;
declare const base: CreateBillingCheckoutParams;
declare const quote: BillingTaxQuote;
const exact: CreateBillingCheckoutParams = { ...base, taxQuote: quote };
void sdk.billing.createCheckoutSession(exact, { idempotencyKey: 'personal-checkout:fixture' });
