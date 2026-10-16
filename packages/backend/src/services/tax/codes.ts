import type { TaxCode } from '@peable.to/shared-types';

/**
 * The product tax codes Peable accepts, starting with digital services and
 * SaaS — what every Oxy application sells. Ids are Stripe Tax's tax codes, so
 * a code means the same thing to Peable and to the provider calculating it.
 * Adding a category is adding a row here; classifying a product is the
 * seller's decision.
 */
export const TAX_CODES: readonly TaxCode[] = Object.freeze([
  {
    id: 'txcd_00000000',
    name: 'Nontaxable',
    description: 'A product that is not subject to tax anywhere. No tax is calculated.',
  },
  {
    id: 'txcd_10000000',
    name: 'General - Electronically Supplied Services',
    description:
      'A service delivered electronically over the internet with minimal human involvement.',
  },
  {
    id: 'txcd_10103000',
    name: 'Software as a service (SaaS) - personal use',
    description: 'Hosted software accessed online, sold to consumers for personal use.',
  },
  {
    id: 'txcd_10103001',
    name: 'Software as a service (SaaS) - business use',
    description: 'Hosted software accessed online, sold to businesses for business use.',
  },
  {
    id: 'txcd_10202000',
    name: 'Downloadable Software - personal use',
    description: 'Software downloaded to the customer’s device, for personal use.',
  },
  {
    id: 'txcd_10202003',
    name: 'Downloadable Software - business use',
    description: 'Software downloaded to the customer’s device, for business use.',
  },
  {
    id: 'txcd_10701100',
    name: 'Website Hosting',
    description: 'Hosting of a website or web application on the seller’s servers.',
  },
]);

export const NONTAXABLE_TAX_CODE = 'txcd_00000000';
const KNOWN = new Set(TAX_CODES.map((code) => code.id));
export const isKnownTaxCode = (id: string) => KNOWN.has(id);
