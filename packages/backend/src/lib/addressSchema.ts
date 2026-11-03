import { z } from 'zod';
import type { Address, Shipping } from '@peable.to/shared-types';

/**
 * Stripe's address and shipping shapes as request schemas, and their one
 * normalization into the stored (and wire) shape: every address field present,
 * `null` when not given. Shared by every body that takes one — intents,
 * customers, payment methods — so the shape is decided once.
 */
const line = z.string().max(500);

export const addressSchema = z
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

export const shippingSchema = z
  .object({
    name: z.string().min(1).max(500),
    phone: z.string().max(40).optional(),
    address: addressSchema,
    carrier: z.string().max(200).optional(),
    tracking_number: z.string().max(200).optional(),
  })
  .strict();

export const emailSchema = z.string().email().max(512);

export function toAddress(input: z.infer<typeof addressSchema>): Address {
  return {
    line1: input.line1 ?? null,
    line2: input.line2 ?? null,
    city: input.city ?? null,
    state: input.state ?? null,
    postal_code: input.postal_code ?? null,
    country: input.country ?? null,
  };
}

export function toShipping(input: z.infer<typeof shippingSchema>): Shipping {
  return {
    name: input.name,
    phone: input.phone ?? null,
    address: toAddress(input.address),
    carrier: input.carrier ?? null,
    tracking_number: input.tracking_number ?? null,
  };
}
