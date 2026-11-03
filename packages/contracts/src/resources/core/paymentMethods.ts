import { z } from 'zod';
import { addressParams, addressSchema, emailParam } from '../../common/address';
import { listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand, expandable } from '../../common/objects';
import {
  expandOnlyQuery,
  expandParam,
  idParam,
  listQuery,
  metadataUpdateParam,
} from '../../common/params';
import { livemode, metadata, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';

/**
 * PaymentMethods (`pm_…`) — Peable's wrapper over a provider payment method
 * (ADR 0016). Card details are collected by the provider's own Elements in the
 * browser; the card number never reaches Peable. A FairCoin customer has no
 * payment method: signing stays on the payer's device.
 */

/** Card details safe to show: never the number, never the CVC. */
export const cardDetailsSchema = defineComponent(
  'CardDetails',
  z
    .object({
      brand: z.string().nullable(),
      last4: z.string().nullable(),
      exp_month: z.number().int().nullable(),
      exp_year: z.number().int().nullable(),
      country: z.string().nullable().describe('ISO 3166-1 alpha-2 of the issuer.'),
      funding: z.string().nullable().describe('`credit`, `debit`, `prepaid` or `unknown`.'),
    })
    .strict(),
);
export type CardDetails = z.output<typeof cardDetailsSchema>;

export const billingDetailsSchema = defineComponent(
  'BillingDetails',
  z
    .object({
      address: addressSchema.nullable(),
      email: z.string().nullable(),
      name: z.string().nullable(),
      phone: z.string().nullable(),
    })
    .strict(),
);
export type BillingDetails = z.output<typeof billingDetailsSchema>;

export const paymentMethodSchema = defineObject(
  'payment_method',
  'PaymentMethod',
  z
    .object({
      id: z.string(),
      object: z.literal('payment_method'),
      livemode,
      type: z.literal('card'),
      card: cardDetailsSchema,
      billing_details: billingDetailsSchema,
      customer: expandable(
        'customer',
        '`cus_…`, or the Customer with `expand[]=customer`; `null` once detached.',
      ).nullable(),
      metadata,
      created: unixSeconds,
    })
    .strict(),
);
export type PaymentMethod = Expand<z.output<typeof paymentMethodSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    payment_method: PaymentMethod;
  }
}

/**
 * Billing details (each named field replaces that field) and metadata (a
 * patch). Orbit's record of the card holder; the provider's copy is not
 * rewritten — the card was verified against what the payer entered there.
 */
export const updatePaymentMethodParams = z
  .object({
    billing_details: z
      .object({
        address: addressParams.optional(),
        email: emailParam.optional(),
        name: z.string().max(500).optional(),
        phone: z.string().max(40).optional(),
      })
      .strict()
      .optional(),
    metadata: metadataUpdateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type UpdatePaymentMethodParams = z.input<typeof updatePaymentMethodParams>;

export const detachPaymentMethodParams = z.object({ expand: expandParam.optional() }).strict();
export type DetachPaymentMethodParams = z.input<typeof detachPaymentMethodParams>;

/** `customer` is REQUIRED: Stripe lists a customer's methods, never a merchant's whole wallet. */
export const listPaymentMethodsQuery = listQuery({
  customer: idParam.describe('The customer (`cus_…`) whose methods to list.'),
  type: z.literal('card').optional(),
});
export type ListPaymentMethodsParams = z.input<typeof listPaymentMethodsQuery>;

export const paymentMethodRoutes = [
  defineRoute({
    operationId: 'listPaymentMethods',
    method: 'get',
    path: '/v1/payment_methods',
    tag: 'Payment methods',
    summary: "List a customer's payment methods",
    auth: 'service',
    scope: 'payments:read',
    query: listPaymentMethodsQuery,
    response: listOf(paymentMethodSchema),
    sdk: 'paymentMethods.list',
    expandable: 'payment_method',
  }),
  defineRoute({
    operationId: 'retrievePaymentMethod',
    method: 'get',
    path: '/v1/payment_methods/{id}',
    tag: 'Payment methods',
    summary: 'Retrieve a payment method',
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The payment method (`pm_…`).' },
    query: expandOnlyQuery,
    response: paymentMethodSchema,
    sdk: 'paymentMethods.retrieve',
    expandable: 'payment_method',
  }),
  defineRoute({
    operationId: 'updatePaymentMethod',
    method: 'post',
    path: '/v1/payment_methods/{id}',
    tag: 'Payment methods',
    summary: 'Update a payment method',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: { id: 'The payment method (`pm_…`).' },
    body: updatePaymentMethodParams,
    response: paymentMethodSchema,
    sdk: 'paymentMethods.update',
    expandable: 'payment_method',
  }),
  defineRoute({
    operationId: 'detachPaymentMethod',
    method: 'post',
    path: '/v1/payment_methods/{id}/detach',
    tag: 'Payment methods',
    summary: 'Detach a payment method',
    description: 'Permanently. A second detach answers the detached method.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: { id: 'The payment method (`pm_…`).' },
    body: detachPaymentMethodParams,
    response: paymentMethodSchema,
    sdk: 'paymentMethods.detach',
    expandable: 'payment_method',
  }),
] as const;
