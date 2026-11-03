import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineComponent } from '../../common/objects';
import { listQuery } from '../../common/params';
import { defineRoute } from '../../route';
import { MERCHANT_ENVIRONMENTS } from '../../vocabulary/merchants';

/**
 * Organization contributions — an Oxy organization's FairCoin collection,
 * managed by its members with their Oxy USER session (never a merchant service
 * token). A contribution is a payment link whose one line is the contribution
 * itself: a fixed amount, or one the payer chooses.
 *
 * Zod-light on purpose: `@peable.to/contracts/contributions` re-exports this
 * module for the hosted checkout and Orbit, which must not construct every
 * schema of the API.
 */

const FAIR_UNITS_PER_COIN = 100000000n;

/** A FairCoin base-unit amount a contribution can carry: positive, within a JS-safe integer. */
export const contributionAmountSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .refine(
    (v) => /^[1-9][0-9]{0,15}$/.test(v) && BigInt(v) <= 9007199254740991n,
    'Enter a positive FairCoin base-unit amount within the supported range',
  );

/** Every instant on the wire is integer Unix seconds (ADR 0014 D1). */
const unixSecondsSchema = z.number().int().nonnegative();

export const contributionDetailsSchema = defineComponent(
  'ContributionDetails',
  z
    .object({
      organization_id: z.string().min(1).max(200).describe('The Oxy organization collecting.'),
      purpose: z.string().trim().min(1).max(500),
      amount_mode: z
        .enum(['fixed', 'free'])
        .describe('`fixed`: the link names the amount; `free`: the payer chooses it.'),
      expires_at: unixSecondsSchema.nullable(),
    })
    .strict(),
);
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

/** A contribution link, as its members manage it. */
export const contributionLinkSchema = defineComponent(
  'ContributionLink',
  z
    .object({
      id: z.string(),
      object: z.literal('payment_link'),
      amount: z.string().describe('FAIR base units; `"0"` when the payer chooses.'),
      currency: z.literal('FAIR'),
      network: z.enum(['mainnet', 'testnet']),
      active: z.boolean(),
      url: z.url().describe('The hosted link to share.'),
      contribution: contributionDetailsSchema,
      created: unixSecondsSchema,
    })
    .strict(),
);
export type ContributionLink = z.infer<typeof contributionLinkSchema>;

export const contributionListSchema = listOf(contributionLinkSchema);
export type ContributionList = z.infer<typeof contributionListSchema>;

/** A payment made through a contribution link. Non-custodial: Peable cannot refund it. */
export const contributionCollectionSchema = defineComponent(
  'ContributionCollection',
  z
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
    .strict(),
);
export type ContributionCollection = z.infer<typeof contributionCollectionSchema>;

export const contributionCollectionListSchema = listOf(contributionCollectionSchema);
export type ContributionCollectionList = z.infer<typeof contributionCollectionListSchema>;

/** The environment the Test/Live toggle selects: the application's merchant in it is the scope. */
const environmentParam = z
  .enum(MERCHANT_ENVIRONMENTS)
  .describe("Which of the application's merchants: its Test/Live toggle.");

/** The query of every contribution write: the environment and nothing else. */
export const contributionScopeQuerySchema = z.object({ environment: environmentParam }).strict();

/**
 * Paging a contribution list: the list parameters every list accepts
 * (`link_…` cursors for links, `pi_…` for collections) plus the environment.
 */
export const contributionPageQuerySchema = listQuery({ environment: environmentParam });

/** What a payer may say when starting a free contribution's checkout. */
export const contributionMintSchema = z
  .object({ amount: contributionAmountSchema.optional() })
  .strict();

/** A contribution start's `Idempotency-Key`: a UUID the page writes before the request. */
export const contributionOperationKeySchema = z.uuid();

export const contributionPatchSchema = z.object({ active: z.boolean() }).strict();

/** `"1.25"` FAIR → `"125000000"` base units, with exact integer arithmetic. */
export function decimalContributionAmount(value: string): string {
  if (!/^(0|[1-9][0-9]{0,7})(\.[0-9]{1,8})?$/.test(value))
    throw new Error('Enter a FAIR amount with at most eight decimals');
  const [whole = '0', fraction = ''] = value.split('.');
  return contributionAmountSchema.parse(
    (BigInt(whole) * FAIR_UNITS_PER_COIN + BigInt(fraction.padEnd(8, '0'))).toString(),
  );
}

/** Base units → the shortest exact FAIR decimal. */
export function formatContributionAmount(value: string): string {
  const units = BigInt(value);
  const fraction = (units % FAIR_UNITS_PER_COIN).toString().padStart(8, '0').replace(/0+$/, '');
  return (units / FAIR_UNITS_PER_COIN).toString() + (fraction ? `.${fraction}` : '');
}

const scopeParams = {
  organizationId: 'The Oxy organization.',
  applicationId: "The organization's Oxy application whose merchant collects.",
} as const;

const root = '/v1/organizations/{organizationId}/applications/{applicationId}/contributions';

export const contributionRoutes = [
  defineRoute({
    operationId: 'createContribution',
    method: 'post',
    path: root,
    tag: 'Contributions',
    summary: 'Create a contribution link',
    description:
      'Requires a UUID `Idempotency-Key` header: the operation key, so a retry after a lost answer returns the same link.',
    auth: 'user',
    params: scopeParams,
    query: contributionScopeQuerySchema,
    body: createContributionSchema,
    response: contributionLinkSchema,
    status: 201,
  }),
  defineRoute({
    operationId: 'listContributions',
    method: 'get',
    path: root,
    tag: 'Contributions',
    summary: "List an organization's contribution links",
    auth: 'user',
    params: scopeParams,
    query: contributionPageQuerySchema,
    response: contributionListSchema,
  }),
  defineRoute({
    operationId: 'updateContribution',
    method: 'post',
    path: `${root}/{id}`,
    tag: 'Contributions',
    summary: 'Enable or disable a contribution link',
    auth: 'user',
    params: { ...scopeParams, id: 'The contribution link (`link_…`).' },
    query: contributionScopeQuerySchema,
    body: contributionPatchSchema,
    response: contributionLinkSchema,
  }),
  defineRoute({
    operationId: 'listContributionCollections',
    method: 'get',
    path: `${root}/{id}/collections`,
    tag: 'Contributions',
    summary: 'List the payments made through a contribution link',
    auth: 'user',
    params: { ...scopeParams, id: 'The contribution link (`link_…`).' },
    query: contributionPageQuerySchema,
    response: contributionCollectionListSchema,
  }),
] as const;
