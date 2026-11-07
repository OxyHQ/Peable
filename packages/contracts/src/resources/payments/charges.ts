import { z } from 'zod';
import { listOf, searchResultOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand, expandable } from '../../common/objects';
import { expandOnlyQuery, idParam, listQuery, searchQuery } from '../../common/params';
import {
  amount,
  currency,
  livemode,
  metadata,
  nullableString,
  unixSeconds,
} from '../../common/primitives';
import { defineRoute } from '../../route';
import { billingDetailsSchema, cardDetailsSchema } from '../core/paymentMethods';
import { radarRuleReferenceSchema } from './radar';

/**
 * Charges (`ch_…`) — the read-only record of the money a CARD PaymentIntent
 * moved (ADR 0019). Peable's object over the provider's charge, which stays an
 * internal binding (ADR 0016). A FairCoin payment has no charge: its chain side
 * is `PaymentIntent.faircoin`.
 */

export const chargeOutcomeSchema = defineComponent(
  'ChargeOutcome',
  z
    .object({
      network_status: nullableString.describe(
        '`approved_by_network`, `declined_by_network`, `not_sent_to_network`, `reversed_after_approval`.',
      ),
      risk_level: nullableString.describe('`normal`, `elevated`, `highest`, or `not_assessed`.'),
      type: nullableString.describe(
        '`authorized`, `manual_review`, `issuer_declined`, `blocked`, `invalid`.',
      ),
      seller_message: nullableString.describe(
        "Peable's own one-line explanation for the merchant — never the provider's prose.",
      ),
      risk_score: z
        .number()
        .int()
        .nullable()
        .describe("The provider's risk score, 0–100, when it scored the payment."),
      reason: nullableString.describe(
        "`rule` when one of your risk rules decided (`rule`), otherwise the provider's reason code.",
      ),
      rule: radarRuleReferenceSchema
        .nullable()
        .describe(
          'Your risk rule that reviewed or blocked this charge after authorization (ADR 0022).',
        ),
    })
    .strict(),
);
export type ChargeOutcome = z.output<typeof chargeOutcomeSchema>;

export const chargeSchema = defineObject(
  'charge',
  'Charge',
  z
    .object({
      id: z.string(),
      object: z.literal('charge'),
      livemode,
      payment_intent: expandable(
        'payment_intent',
        '`pi_…`, or the PaymentIntent with `expand[]=payment_intent`.',
      ),
      customer: expandable(
        'customer',
        '`cus_…`, or the Customer with `expand[]=customer`.',
      ).nullable(),
      payment_method: expandable(
        'payment_method',
        '`pm_…`, or the PaymentMethod with `expand[]=payment_method`.',
      ).nullable(),
      amount,
      amount_captured: amount,
      amount_refunded: amount,
      currency,
      status: z
        .literal('succeeded')
        .describe('Always `succeeded`: Peable records the authorization that succeeded.'),
      paid: z.boolean(),
      captured: z.boolean(),
      refunded: z
        .boolean()
        .describe('All of it came back — by refunds, or by releasing an uncaptured authorization.'),
      disputed: z.boolean(),
      review: expandable('review', '`prv_…` while a review exists, or the Review.').nullable(),
      outcome: chargeOutcomeSchema.nullable(),
      billing_details: billingDetailsSchema
        .nullable()
        .describe(
          "Who the card's billing details name, as the provider reported them; `null` until the provider snapshot is read.",
        ),
      payment_method_details: z
        .object({ type: z.literal('card'), card: cardDetailsSchema })
        .strict()
        .nullable(),
      receipt_url: nullableString.describe("The provider's own URL never reaches the wire."),
      balance_transaction: nullableString.describe(
        "The ledger's `txn_…` once the provider's balance transaction was ingested (ADR 0015 §4); never a guess.",
      ),
      application_fee: nullableString.describe(
        "Orbit's `fee_…` taken on this charge, once the provider created it.",
      ),
      application_fee_amount: amount
        .nullable()
        .describe('The fee instructed on the payment (`application_fee_amount`).'),
      description: nullableString,
      receipt_email: nullableString,
      metadata,
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'ch_0193b8f2c1a87d3e9f4a',
        object: 'charge',
        livemode: false,
        payment_intent: 'pi_0193b8f2c1a87d3e9f4a',
        customer: 'cus_0193b8f2c1a87d3e9f4a',
        payment_method: 'pm_0193b8f2c1a87d3e9f4a',
        amount: '2500',
        amount_captured: '2500',
        amount_refunded: '0',
        currency: 'EUR',
        status: 'succeeded',
        paid: true,
        captured: true,
        refunded: false,
        disputed: false,
        review: null,
        outcome: {
          network_status: 'approved_by_network',
          risk_level: 'normal',
          type: 'authorized',
          seller_message: 'Payment complete.',
          risk_score: 12,
          reason: null,
          rule: null,
        },
        billing_details: null,
        payment_method_details: {
          type: 'card',
          card: {
            brand: 'visa',
            last4: '4242',
            exp_month: 12,
            exp_year: 2030,
            country: 'US',
            funding: 'credit',
          },
        },
        receipt_url: null,
        balance_transaction: null,
        application_fee: null,
        application_fee_amount: null,
        description: null,
        receipt_email: null,
        metadata: {},
        created: 1793750400,
      },
    ],
  },
);
export type Charge = Expand<z.output<typeof chargeSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    charge: Charge;
  }
}

export const listChargesQuery = listQuery({
  payment_intent: idParam.optional().describe("Only this payment's charges (`pi_…`)."),
});
export type ListChargesParams = z.input<typeof listChargesQuery>;

export const chargeRoutes = [
  defineRoute({
    operationId: 'listCharges',
    method: 'get',
    path: '/v1/charges',
    tag: 'Charges',
    summary: 'List charges',
    auth: 'service',
    scope: 'payments:read',
    query: listChargesQuery,
    response: listOf(chargeSchema),
    sdk: 'charges.list',
    expandable: 'charge',
  }),
  defineRoute({
    operationId: 'retrieveCharge',
    method: 'get',
    path: '/v1/charges/{id}',
    tag: 'Charges',
    summary: 'Retrieve a charge',
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The charge (`ch_…`).' },
    query: expandOnlyQuery,
    response: chargeSchema,
    sdk: 'charges.retrieve',
    expandable: 'charge',
  }),
  defineRoute({
    operationId: 'searchCharges',
    method: 'get',
    path: '/v1/charges/search',
    tag: 'Charges',
    summary: 'Search charges',
    description:
      "Stripe's query language over `amount`, `currency`, `customer`, `payment_intent`, `status`, `captured`, `refunded`, `disputed`, `created` and `metadata['key']`.",
    auth: 'service',
    scope: 'payments:read',
    query: searchQuery,
    response: searchResultOf(chargeSchema),
    sdk: 'charges.search',
    expandable: 'charge',
  }),
] as const;
