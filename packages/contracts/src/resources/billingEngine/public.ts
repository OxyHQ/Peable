import { z } from 'zod';
import { addressParams, addressSchema, emailParam } from '../../common/address';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import { idParam } from '../../common/params';
import { amount, currency, livemode, signedAmount, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { PORTAL_PAYMENT_METHOD_UPDATE_STATUSES } from '../../vocabulary/billingPortal';
import { FAIRCOIN_UNAVAILABLE_REASONS } from '../../vocabulary/checkout';
import { INVOICE_STATUSES, PUBLIC_INVOICE_PAYMENT_METHOD_TYPES } from '../../vocabulary/invoices';
import { COLLECTION_METHODS, SUBSCRIPTION_STATUSES } from '../../vocabulary/subscriptions';
import { billingPortalBusinessProfileSchema, billingPortalFeaturesSchema } from './billingPortal';
import { emptyBody, quantityParam, shortText } from './params';

/**
 * The payer-facing billing routes (ADR 0018) — anonymous, authorized by an
 * unguessable bearer token in the path, like a payment link: a finalized
 * invoice as its payer sees it, and the customer portal. Nothing here reveals
 * anything but the one invoice or the one customer the token names. Called by
 * the hosted checkout (`checkout.peable.to`), never by the server SDK.
 */

/** The merchant as a payer sees it. */
const publicMerchantSchema = z
  .object({ name: z.string().nullable(), avatar_url: z.string().nullable() })
  .strict();

/** A finalized invoice as its payer sees it. */
export const publicInvoiceSchema = defineObject(
  'public_invoice',
  'PublicInvoice',
  z
    .object({
      object: z.literal('public_invoice'),
      livemode,
      number: z.string().nullable(),
      status: z.enum(INVOICE_STATUSES),
      currency,
      merchant: publicMerchantSchema,
      customer_name: z.string().nullable(),
      customer_email: z.string().nullable(),
      description: z.string().nullable(),
      lines: z.array(
        z
          .object({
            description: z.string().nullable(),
            quantity: z.number().int().nullable(),
            amount: signedAmount,
            period: z.object({ start: unixSeconds, end: unixSeconds }).strict(),
            proration: z.boolean(),
          })
          .strict(),
      ),
      subtotal: signedAmount,
      total_discount: signedAmount,
      tax: signedAmount.nullable(),
      total: signedAmount,
      amount_due: amount,
      amount_paid: amount,
      amount_remaining: amount,
      due_date: unixSeconds.nullable(),
      created: unixSeconds,
      finalized_at: unixSeconds.nullable(),
      paid_at: unixSeconds.nullable(),
      payment_method_types: z
        .array(z.enum(PUBLIC_INVOICE_PAYMENT_METHOD_TYPES))
        .describe(
          "What the payer may choose: `['card', 'faircoin']` on a fiat invoice, `['faircoin']` on a FAIR one. FairCoin is always offered (ADR 0021); on a fiat invoice it is quoted when chosen.",
        ),
      faircoin: z
        .object({
          available: z.boolean(),
          unavailable_reason: z
            .enum(FAIRCOIN_UNAVAILABLE_REASONS)
            .nullable()
            .describe(
              'Why FairCoin cannot be paid with right now; it is still shown, never hidden.',
            ),
        })
        .strict()
        .describe('Whether the payer can choose FairCoin now (ADR 0021).'),
      invoice_pdf: z.string(),
    })
    .strict(),
);
export type PublicInvoice = Expand<z.output<typeof publicInvoiceSchema>>;

/**
 * The PaymentIntent the payer completes on the hosted checkout
 * (`/i/:id#client_secret=…`). The same invoice always answers the same intent
 * while it can still be paid.
 */
export const publicInvoicePaymentSchema = defineObject(
  'public_invoice_payment',
  'PublicInvoicePayment',
  z
    .object({
      object: z.literal('public_invoice_payment'),
      payment_intent: z.string().describe('The PaymentIntent (`pi_…`) that pays the invoice.'),
      client_secret: z
        .string()
        .describe("The intent's payer credential (`pi_…_secret_…`), as a payment link hands out."),
    })
    .strict(),
);
export type PublicInvoicePayment = Expand<z.output<typeof publicInvoicePaymentSchema>>;

/** One subscription as the hosted portal shows it. */
export const publicPortalSubscriptionSchema = defineComponent(
  'PublicPortalSubscription',
  z
    .object({
      id: z.string(),
      status: z.enum(SUBSCRIPTION_STATUSES),
      currency,
      current_period_end: unixSeconds,
      cancel_at_period_end: z.boolean(),
      cancel_at: unixSeconds.nullable(),
      trial_end: unixSeconds.nullable(),
      collection_method: z.enum(COLLECTION_METHODS),
      items: z.array(
        z
          .object({
            id: z.string(),
            price: z.string(),
            product: z.string(),
            product_name: z.string(),
            quantity: z.number().int().nonnegative(),
            unit_amount: amount.nullable(),
            interval: z.string().nullable(),
          })
          .strict(),
      ),
    })
    .strict(),
);
export type PublicPortalSubscription = z.output<typeof publicPortalSubscriptionSchema>;

/** The hosted portal's view of its customer. */
export const publicPortalSessionSchema = defineObject(
  'billing_portal.public_session',
  'PublicPortalSession',
  z
    .object({
      object: z.literal('billing_portal.public_session'),
      livemode,
      merchant: publicMerchantSchema,
      business_profile: billingPortalBusinessProfileSchema,
      features: billingPortalFeaturesSchema,
      return_url: z.string().nullable(),
      expires_at: unixSeconds,
      customer: z
        .object({
          id: z.string(),
          email: z.string().nullable(),
          name: z.string().nullable(),
          phone: z.string().nullable(),
          address: addressSchema.nullable(),
          default_payment_method: z
            .object({
              id: z.string(),
              card: z
                .object({
                  brand: z.string(),
                  last4: z.string(),
                  exp_month: z.number().int(),
                  exp_year: z.number().int(),
                })
                .strict()
                .nullable(),
            })
            .strict()
            .nullable(),
        })
        .strict(),
      subscriptions: z.array(publicPortalSubscriptionSchema),
      invoices: z.array(
        z
          .object({
            id: z.string(),
            number: z.string().nullable(),
            status: z.enum(INVOICE_STATUSES),
            currency,
            total: signedAmount,
            amount_due: amount,
            created: unixSeconds,
            hosted_invoice_url: z.string().nullable(),
            invoice_pdf: z.string().nullable(),
          })
          .strict(),
      ),
      plans: z
        .array(
          z
            .object({
              product: z.string(),
              product_name: z.string(),
              prices: z.array(
                z
                  .object({
                    id: z.string(),
                    unit_amount: amount.nullable(),
                    currency,
                    interval: z.string().nullable(),
                    interval_count: z.number().int().nullable(),
                  })
                  .strict(),
              ),
            })
            .strict(),
        )
        .describe('The plans `subscription_update` allows, priced.'),
    })
    .strict(),
);
export type PublicPortalSession = Expand<z.output<typeof publicPortalSessionSchema>>;

/** A card update begun: the SetupIntent the portal page confirms with the provider's own fields. */
export const portalPaymentMethodUpdateSchema = defineComponent(
  'PortalPaymentMethodUpdate',
  z
    .object({
      setup_intent: z.string().describe('The SetupIntent (`seti_…`) to confirm.'),
      client_secret: z.string().describe('Its payer credential.'),
    })
    .strict(),
);
export type PortalPaymentMethodUpdate = z.output<typeof portalPaymentMethodUpdateSchema>;

/** A card update finished: `pending` until the SetupIntent succeeded. */
export const portalPaymentMethodUpdateResultSchema = defineComponent(
  'PortalPaymentMethodUpdateResult',
  z
    .object({
      status: z.enum(PORTAL_PAYMENT_METHOD_UPDATE_STATUSES),
      session: publicPortalSessionSchema,
    })
    .strict(),
);
export type PortalPaymentMethodUpdateResult = Expand<
  z.output<typeof portalPaymentMethodUpdateResultSchema>
>;

declare module '../../common/objects' {
  interface ObjectMap {
    public_invoice: PublicInvoice;
    public_invoice_payment: PublicInvoicePayment;
    'billing_portal.public_session': PublicPortalSession;
  }
}

// ---- Requests ------------------------------------------------------------------------

/** How the payer pays the invoice (ADR 0021 D3). */
export const payPublicInvoiceParams = z
  .object({
    payment_method_type: z
      .enum(PUBLIC_INVOICE_PAYMENT_METHOD_TYPES)
      .optional()
      .describe(
        "One of the invoice's `payment_method_types`. Default: the rail of its currency (`card` on a fiat invoice). `faircoin` on a fiat invoice quotes the amount due in FAIR for 10 minutes; paying again with the other method replaces a payment that has not started moving money.",
      ),
  })
  .strict();

/** A portal action on one of the customer's subscriptions. */
export const portalSubscriptionParams = z.object({ subscription: idParam }).strict();
export type PortalSubscriptionParams = z.input<typeof portalSubscriptionParams>;

/** Switch a (single-item) subscription to one of the configuration's plans, or change its quantity. */
export const portalChangePlanParams = z
  .object({
    subscription: idParam,
    price: idParam.optional(),
    quantity: quantityParam.optional(),
  })
  .strict();
export type PortalChangePlanParams = z.input<typeof portalChangePlanParams>;

/** The fields the configuration's `customer_update.allowed_updates` names. */
export const portalCustomerParams = z
  .object({
    email: emailParam.optional(),
    name: shortText(500).optional(),
    phone: shortText(40).optional(),
    address: addressParams.optional(),
  })
  .strict();
export type PortalCustomerParams = z.input<typeof portalCustomerParams>;

export const startPortalPaymentMethodUpdateParams = emptyBody;

export const completePortalPaymentMethodUpdateParams = z.object({ setup_intent: idParam }).strict();
export type CompletePortalPaymentMethodUpdateParams = z.input<
  typeof completePortalPaymentMethodUpdateParams
>;

// ---- Routes --------------------------------------------------------------------------

const invoiceToken = { token: 'The hosted invoice token (from `hosted_invoice_url`).' } as const;
const portalToken = { token: 'The portal session token (from the session `url`).' } as const;

export const publicBillingRoutes = [
  defineRoute({
    operationId: 'retrievePublicInvoice',
    method: 'get',
    path: '/v1/invoices/public/{token}',
    tag: 'Hosted invoices',
    summary: 'Retrieve a hosted invoice',
    description: 'A finalized invoice as its payer sees it.',
    auth: 'public',
    params: invoiceToken,
    response: publicInvoiceSchema,
  }),
  defineRoute({
    operationId: 'payPublicInvoice',
    method: 'post',
    path: '/v1/invoices/public/{token}/pay',
    tag: 'Hosted invoices',
    summary: 'Pay a hosted invoice',
    description:
      'The PaymentIntent the payer completes in the method they chose — a card through the provider’s own fields, or FairCoin from the payer’s wallet (quoted on a fiat invoice, ADR 0021). The same invoice answers the same intent while it can still be paid in that method.',
    auth: 'public',
    params: invoiceToken,
    body: payPublicInvoiceParams,
    response: publicInvoicePaymentSchema,
  }),
  defineRoute({
    operationId: 'retrievePublicInvoicePdf',
    method: 'get',
    path: '/v1/invoices/public/{token}/pdf',
    tag: 'Hosted invoices',
    summary: "Download a hosted invoice's PDF",
    auth: 'public',
    params: invoiceToken,
    response: { kind: 'binary', contentType: 'application/pdf' },
  }),
  defineRoute({
    operationId: 'retrievePublicPortalSession',
    method: 'get',
    path: '/v1/billing_portal/public/{token}',
    tag: 'Hosted portal',
    summary: 'Retrieve the hosted portal',
    description: 'The customer, their subscriptions, invoices and the plans they may switch to.',
    auth: 'public',
    params: portalToken,
    response: publicPortalSessionSchema,
  }),
  defineRoute({
    operationId: 'cancelPortalSubscription',
    method: 'post',
    path: '/v1/billing_portal/public/{token}/cancel',
    tag: 'Hosted portal',
    summary: 'Cancel a subscription from the portal',
    description:
      'At period end or now, as the configuration says. Answers the portal as it now is.',
    auth: 'public',
    params: portalToken,
    body: portalSubscriptionParams,
    response: publicPortalSessionSchema,
  }),
  defineRoute({
    operationId: 'renewPortalSubscription',
    method: 'post',
    path: '/v1/billing_portal/public/{token}/renew',
    tag: 'Hosted portal',
    summary: 'Undo a cancellation at period end',
    description: 'Answers the portal as it now is.',
    auth: 'public',
    params: portalToken,
    body: portalSubscriptionParams,
    response: publicPortalSessionSchema,
  }),
  defineRoute({
    operationId: 'changePortalSubscriptionPlan',
    method: 'post',
    path: '/v1/billing_portal/public/{token}/change_plan',
    tag: 'Hosted portal',
    summary: 'Change plan from the portal',
    description: 'Answers the portal as it now is.',
    auth: 'public',
    params: portalToken,
    body: portalChangePlanParams,
    response: publicPortalSessionSchema,
  }),
  defineRoute({
    operationId: 'updatePortalCustomer',
    method: 'post',
    path: '/v1/billing_portal/public/{token}/customer',
    tag: 'Hosted portal',
    summary: 'Update billing details from the portal',
    description: 'Answers the portal as it now is.',
    auth: 'public',
    params: portalToken,
    body: portalCustomerParams,
    response: publicPortalSessionSchema,
  }),
  defineRoute({
    operationId: 'startPortalPaymentMethodUpdate',
    method: 'post',
    path: '/v1/billing_portal/public/{token}/payment_method_update',
    tag: 'Hosted portal',
    summary: 'Begin a card update from the portal',
    description: 'A SetupIntent for the customer; card customers only.',
    auth: 'public',
    params: portalToken,
    body: startPortalPaymentMethodUpdateParams,
    response: portalPaymentMethodUpdateSchema,
  }),
  defineRoute({
    operationId: 'completePortalPaymentMethodUpdate',
    method: 'post',
    path: '/v1/billing_portal/public/{token}/payment_method_update/complete',
    tag: 'Hosted portal',
    summary: 'Finish a card update from the portal',
    description:
      "Once the SetupIntent succeeded, its method becomes the customer's default and every live subscription's.",
    auth: 'public',
    params: portalToken,
    body: completePortalPaymentMethodUpdateParams,
    response: portalPaymentMethodUpdateResultSchema,
  }),
] as const;
