import { z } from 'zod';
import { contractRegistry } from './objects';

/**
 * Stripe's address and shipping shapes — as returned (every field present,
 * `null` when not given) and as a request carries them (every field optional).
 * Shared by every object that holds one: intents, customers, payment methods,
 * checkout sessions.
 */

export const addressSchema = z
  .object({
    line1: z.string().nullable(),
    line2: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    postal_code: z.string().nullable(),
    country: z.string().nullable().describe('ISO 3166-1 alpha-2.'),
  })
  .strict();
contractRegistry.add(addressSchema, { id: 'Address' });
export type Address = z.output<typeof addressSchema>;

export const shippingSchema = z
  .object({
    name: z.string(),
    phone: z.string().nullable(),
    address: addressSchema,
    carrier: z.string().nullable(),
    tracking_number: z.string().nullable(),
  })
  .strict();
contractRegistry.add(shippingSchema, { id: 'Shipping' });
export type Shipping = z.output<typeof shippingSchema>;

const line = z.string().max(500);

/** An address as a request carries it: every field optional. */
export const addressParams = z
  .object({
    line1: line.optional(),
    line2: line.optional(),
    city: line.optional(),
    state: line.optional(),
    postal_code: z.string().max(40).optional(),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/, 'country must be an ISO 3166-1 alpha-2 code')
      .optional(),
  })
  .strict();
export type AddressParams = z.input<typeof addressParams>;

/** Shipping as a request carries it: only `name` and `address` are required. */
export const shippingParams = z
  .object({
    name: z.string().min(1).max(500),
    phone: z.string().max(40).optional(),
    address: addressParams,
    carrier: z.string().max(200).optional(),
    tracking_number: z.string().max(200).optional(),
  })
  .strict();
export type ShippingParams = z.input<typeof shippingParams>;

export const emailParam = z.email().max(512);

/** A request address in the stored (and wire) shape: every field present. */
export function toAddress(input: z.output<typeof addressParams>): Address {
  return {
    line1: input.line1 ?? null,
    line2: input.line2 ?? null,
    city: input.city ?? null,
    state: input.state ?? null,
    postal_code: input.postal_code ?? null,
    country: input.country ?? null,
  };
}

/** Request shipping in the stored (and wire) shape. */
export function toShipping(input: z.output<typeof shippingParams>): Shipping {
  return {
    name: input.name,
    phone: input.phone ?? null,
    address: toAddress(input.address),
    carrier: input.carrier ?? null,
    tracking_number: input.tracking_number ?? null,
  };
}
