import { z } from 'zod';
export const contributionAmountSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .refine(
    (v) => /^[1-9][0-9]{0,15}$/.test(v) && BigInt(v) <= 9007199254740991n,
    'Enter a positive FairCoin base-unit amount within the supported range',
  );
export const contributionDetailsSchema = z
  .object({
    organizationId: z.string().min(1).max(200),
    purpose: z.string().trim().min(1).max(500),
    amountMode: z.enum(['fixed', 'free']),
    expiresAt: z.iso.datetime().nullable(),
  })
  .strict();
export type ContributionDetails = z.infer<typeof contributionDetailsSchema>;
export const createContributionSchema = z
  .object({
    purpose: contributionDetailsSchema.shape.purpose,
    amountMode: contributionDetailsSchema.shape.amountMode,
    amount: contributionAmountSchema.optional(),
    currency: z.literal('FAIR'),
    expiresAt: z.iso.datetime().nullable().optional(),
  })
  .strict()
  .refine(
    (v) => (v.amountMode === 'free' ? v.amount === undefined : v.amount !== undefined),
    'Fixed contributions require an amount; free contributions omit it',
  );
export type CreateContribution = z.infer<typeof createContributionSchema>;
export const contributionLinkSchema = z
  .object({
    id: z.string(),
    amount: z.string(),
    currency: z.literal('FAIR'),
    network: z.enum(['mainnet', 'testnet']),
    active: z.boolean(),
    url: z.url(),
    contribution: contributionDetailsSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();
export type ContributionLink = z.infer<typeof contributionLinkSchema>;
export const contributionListSchema = z
  .object({ items: z.array(contributionLinkSchema), nextCursor: z.string().nullable() })
  .strict();
export const contributionCollectionSchema = z
  .object({
    id: z.string(),
    amount: z.string(),
    currency: z.literal('FAIR'),
    status: z.string(),
    createdAt: z.iso.datetime(),
    refundCapability: z.literal('unsupported_non_custodial'),
    refunds: z.array(
      z
        .object({
          id: z.string(),
          amount: z.string(),
          status: z.string(),
          createdAt: z.iso.datetime(),
        })
        .strict(),
    ),
  })
  .strict();
export const contributionCollectionListSchema = z
  .object({ items: z.array(contributionCollectionSchema), nextCursor: z.string().nullable() })
  .strict();
export const contributionPageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(1000).optional(),
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
