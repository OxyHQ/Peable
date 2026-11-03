import { Peable } from '@peable.to/sdk';

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: copy .env.example to .env and fill it in`);
  return value;
}

// An Oxy application credential of a TEST environment: its environment, not
// anything sent here, is what makes every call below test mode.
export const peable = new Peable({
  publicKey: required('PEABLE_PUBLIC_KEY'),
  secret: required('PEABLE_SECRET'),
  baseURL: process.env.PEABLE_API_URL,
});

/** The plan's price and the feature it grants, found by key rather than by id. */
export const PRICE_LOOKUP_KEY = 'example_pro_monthly';
export const FEATURE_LOOKUP_KEY = 'example_pro';
