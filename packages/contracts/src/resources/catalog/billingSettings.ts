import { z } from 'zod';
import { defineObject, type Expand } from '../../common/objects';
import { expandOnlyQuery } from '../../common/params';
import { livemode, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  BILLING_SETTINGS_LIMITS,
  DUNNING_FINAL_ACTIONS,
  DUNNING_INVOICE_ACTIONS,
} from '../../vocabulary/catalog';

/**
 * The merchant's billing settings (ADR 0018 §5; one per merchant and mode).
 * Every field has a default, so a merchant that never opens the screen bills
 * correctly:
 *
 *  - `invoice_prefix`: derived from the merchant id; numbers are
 *    `PREFIX-0001`, gapless per merchant.
 *  - `dunning.retry_schedule_days`: `[1, 3, 5, 7]` — each retry so many days
 *    after the previous attempt (16 days, four retries, Stripe's default
 *    window).
 *  - `dunning.final_action`: `cancel` — the subscription ends when the last
 *    retry fails; `dunning.invoice_action`: `mark_uncollectible`.
 *  - emails on: the payer is told when an invoice is finalized for them
 *    (`send_invoice`) and when a payment fails.
 */
export const billingSettingsSchema = defineObject(
  'billing_settings',
  'BillingSettings',
  z
    .object({
      object: z.literal('billing_settings'),
      livemode,
      invoice_prefix: z.string().describe('Invoice numbers are `PREFIX-0001`, gapless.'),
      next_invoice_sequence: z
        .number()
        .int()
        .describe('The next invoice number that will be assigned.'),
      default_days_until_due: z.number().int(),
      dunning: z
        .object({
          retry_schedule_days: z
            .array(z.number().int())
            .describe('Each retry so many days after the previous attempt.'),
          final_action: z
            .enum(DUNNING_FINAL_ACTIONS)
            .describe('What happens to the subscription once the last retry fails.'),
          invoice_action: z
            .enum(DUNNING_INVOICE_ACTIONS)
            .describe('What happens to the invoice once the last retry fails.'),
        })
        .strict(),
      emails: z
        .object({
          invoice_finalized: z.boolean(),
          payment_failed: z.boolean(),
        })
        .strict(),
      updated: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        object: 'billing_settings',
        livemode: false,
        invoice_prefix: 'MENTION',
        next_invoice_sequence: 1,
        default_days_until_due: 30,
        dunning: {
          retry_schedule_days: [1, 3, 5, 7],
          final_action: 'cancel',
          invoice_action: 'mark_uncollectible',
        },
        emails: { invoice_finalized: true, payment_failed: true },
        updated: 1793750400,
      },
    ],
  },
);
export type BillingSettings = Expand<z.output<typeof billingSettingsSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    billing_settings: BillingSettings;
  }
}

export const updateBillingSettingsParams = z
  .object({
    invoice_prefix: z
      .string()
      .regex(new RegExp(BILLING_SETTINGS_LIMITS.invoicePrefixPattern))
      .optional()
      .describe('3–12 uppercase letters and digits.'),
    default_days_until_due: z
      .number()
      .int()
      .min(0)
      .max(BILLING_SETTINGS_LIMITS.daysUntilDueMax)
      .optional(),
    dunning: z
      .object({
        retry_schedule_days: z
          .array(z.number().int().min(1).max(BILLING_SETTINGS_LIMITS.retryDaysMax))
          .max(BILLING_SETTINGS_LIMITS.retriesMax)
          .optional(),
        final_action: z.enum(DUNNING_FINAL_ACTIONS).optional(),
        invoice_action: z.enum(DUNNING_INVOICE_ACTIONS).optional(),
      })
      .strict()
      .optional(),
    emails: z
      .object({ invoice_finalized: z.boolean().optional(), payment_failed: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict();
export type UpdateBillingSettingsParams = z.input<typeof updateBillingSettingsParams>;

export const billingSettingsRoutes = [
  defineRoute({
    operationId: 'retrieveBillingSettings',
    method: 'get',
    path: '/v1/billing_settings',
    tag: 'Billing settings',
    summary: 'Retrieve the billing settings',
    auth: 'service',
    scope: 'payments:read',
    query: expandOnlyQuery,
    response: billingSettingsSchema,
    sdk: 'billingSettings.retrieve',
  }),
  defineRoute({
    operationId: 'updateBillingSettings',
    method: 'post',
    path: '/v1/billing_settings',
    tag: 'Billing settings',
    summary: 'Update the billing settings',
    description: 'Invoice numbering, the default payment term, dunning and the payer emails.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: updateBillingSettingsParams,
    response: billingSettingsSchema,
    sdk: 'billingSettings.update',
  }),
] as const;
