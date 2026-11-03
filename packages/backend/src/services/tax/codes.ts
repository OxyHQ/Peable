import type { TaxCode } from '@peable.to/shared-types';
import { TAX_CODES as CONTRACT_TAX_CODES } from '@peable.to/contracts';

/**
 * The product tax codes Peable accepts. The list is contract vocabulary
 * (`@peable.to/contracts` `TAX_CODES`): a product's `tax_code` is validated
 * against it in the request schema, and `GET /v1/tax/codes` lists it.
 */
export const TAX_CODES: readonly TaxCode[] = CONTRACT_TAX_CODES;

export { isKnownTaxCode, NONTAXABLE_TAX_CODE } from '@peable.to/contracts';
