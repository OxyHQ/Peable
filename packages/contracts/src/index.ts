import { z } from 'zod';
export const contributionAmountSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .refine(
    (v) => /^[1-9][0-9]{0,15}$/.test(v) && BigInt(v) <= 9007199254740991n,
    'Enter a positive FairCoin base-unit amount within the supported range',
  );
/** Every instant on the wire is integer Unix seconds (ADR 0014 D1). */
const unixSecondsSchema = z.number().int().nonnegative();
export const contributionDetailsSchema = z
  .object({
    organization_id: z.string().min(1).max(200),
    purpose: z.string().trim().min(1).max(500),
    amount_mode: z.enum(['fixed', 'free']),
    expires_at: unixSecondsSchema.nullable(),
  })
  .strict();
export type ContributionDetails = z.infer<typeof contributionDetailsSchema>;
export const createContributionSchema = z
  .object({
    purpose: contributionDetailsSchema.shape.purpose,
    amount_mode: contributionDetailsSchema.shape.amount_mode,
    amount: contributionAmountSchema.optional(),
    currency: z.literal('FAIR'),
    expires_at: unixSecondsSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (v) => (v.amount_mode === 'free' ? v.amount === undefined : v.amount !== undefined),
    'Fixed contributions require an amount; free contributions omit it',
  );
export type CreateContribution = z.infer<typeof createContributionSchema>;
export const contributionLinkSchema = z
  .object({
    id: z.string(),
    object: z.literal('payment_link'),
    amount: z.string(),
    currency: z.literal('FAIR'),
    network: z.enum(['mainnet', 'testnet']),
    active: z.boolean(),
    url: z.url(),
    contribution: contributionDetailsSchema,
    created: unixSecondsSchema,
  })
  .strict();
export type ContributionLink = z.infer<typeof contributionLinkSchema>;
/** The one list envelope (ADR 0014 D1). */
function listSchema<T extends z.ZodType>(item: T) {
  return z
    .object({ object: z.literal('list'), data: z.array(item), has_more: z.boolean() })
    .strict();
}
export const contributionListSchema = listSchema(contributionLinkSchema);
export type ContributionList = z.infer<typeof contributionListSchema>;
export const contributionCollectionSchema = z
  .object({
    id: z.string(),
    object: z.literal('payment_intent'),
    amount: z.string(),
    currency: z.literal('FAIR'),
    status: z.string(),
    created: unixSecondsSchema,
    refund_capability: z.literal('unsupported_non_custodial'),
    refunds: z.array(
      z
        .object({
          id: z.string(),
          object: z.literal('refund'),
          amount: z.string(),
          status: z.string(),
          created: unixSecondsSchema,
        })
        .strict(),
    ),
  })
  .strict();
export type ContributionCollection = z.infer<typeof contributionCollectionSchema>;
export const contributionCollectionListSchema = listSchema(contributionCollectionSchema);
/**
 * Paging: `starting_after` is the public id of the last object of the previous
 * page (`link_…` for links, `pi_…` for collections), resolved by the gateway
 * inside the caller's organization, application and environment.
 */
export const contributionPageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(10),
    starting_after: z.string().min(1).max(200).optional(),
    environment: z.enum(['development', 'staging', 'production']),
  })
  .strict();
export const contributionMintSchema = z
  .object({ amount: contributionAmountSchema.optional() })
  .strict();
export const contributionOperationKeySchema = z.string().uuid();
export const contributionPatchSchema = z.object({ active: z.boolean() }).strict();
export function decimalContributionAmount(value: string): string {
  if (!/^(0|[1-9][0-9]{0,7})(\.[0-9]{1,8})?$/.test(value))
    throw new Error('Enter a FAIR amount with at most eight decimals');
  const [whole = '0', fraction = ''] = value.split('.');
  return contributionAmountSchema.parse(
    (BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'))).toString(),
  );
}
export function formatContributionAmount(value: string): string {
  const units = BigInt(value);
  const fraction = (units % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
  return (units / 100000000n).toString() + (fraction ? `.${fraction}` : '');
}

export type ContributionCollectionList = z.infer<typeof contributionCollectionListSchema>;
