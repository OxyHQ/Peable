import { z } from 'zod';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import { network, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { merchantDisplaySchema } from '../checkout/shared';

/**
 * The SELLER-facing half of FairCoin connected accounts (ADR 0012 D3).
 *
 * A platform mints an onboarding link for a seller's account; the SELLER opens
 * it signed in with Oxy and confirms that their FairCoin is paid into the
 * Peable wallet of that account (ADR 0021 D5). These routes are `auth: 'user'`
 * — the seller's own session, never a service token — because who receives a
 * seller's money is the seller's consent. A platform cannot reach them at all, and the
 * link token alone is not enough without the session it names.
 */

export const connectOnboardingSchema = defineObject(
  'connect_onboarding',
  'ConnectOnboarding',
  z
    .object({
      object: z.literal('connect_onboarding'),
      account_id: z.string().describe('The `ca_…` being onboarded.'),
      // The platform's public display, as a payer would see it: never a
      // webhook secret, never a key.
      platform: merchantDisplaySchema.describe(
        "Who is asking: the PLATFORM's public display, as a payer would see it.",
      ),
      network: network.describe('The chain the seller will be paid on. Their key must be for it.'),
      expires_at: unixSeconds.describe('When this link stops working.'),
      return_url: z.string().describe('Where to send the seller once the key is registered.'),
    })
    .strict(),
);
export type ConnectOnboarding = Expand<z.output<typeof connectOnboardingSchema>>;

/** The answer to a successful registration. */
export const connectOnboardingCompleteSchema = defineComponent(
  'ConnectOnboardingComplete',
  z
    .object({
      object: z.literal('connect_onboarding'),
      account_id: z.string(),
      status: z.literal('active'),
      return_url: z.string(),
    })
    .strict(),
);
export type ConnectOnboardingComplete = z.output<typeof connectOnboardingCompleteSchema>;

declare module '../../common/objects' {
  interface ObjectMap {
    connect_onboarding: ConnectOnboarding;
  }
}

/**
 * `POST /v1/connect/onboarding/{token}/faircoin` takes nothing: the seller
 * confirms, in their own Oxy session, that their FairCoin is paid into the
 * Peable wallet of that account (ADR 0021 D5). No key travels.
 */
export const confirmFaircoinOnboardingParams = z.object({}).strict();
export type ConfirmFaircoinOnboardingParams = z.input<typeof confirmFaircoinOnboardingParams>;

const tokenParam = { token: 'The onboarding link token (the last segment of its `url`).' } as const;

export const connectOnboardingRoutes = [
  defineRoute({
    operationId: 'retrieveConnectOnboarding',
    method: 'get',
    path: '/v1/connect/onboarding/{token}',
    tag: 'Connect onboarding',
    summary: 'Retrieve an onboarding link',
    description:
      'What the seller is being asked to do. Looking consumes nothing. An expired link answers 410 `link_expired` with the platform’s `refresh_url`.',
    auth: 'user',
    params: tokenParam,
    response: connectOnboardingSchema,
  }),
  defineRoute({
    operationId: 'confirmConnectOnboardingFaircoin',
    method: 'post',
    path: '/v1/connect/onboarding/{token}/faircoin',
    tag: 'Connect onboarding',
    summary: 'Confirm FairCoin payments into the seller’s Peable wallet',
    description:
      'The seller, signed in as the account the link names, confirms that FairCoin paid to them goes to that account’s Peable wallet (ADR 0021 D5) — the only way a FairCoin half becomes payable. No key is sent: addresses derive from the account’s public identity key. 409 `faircoin_wallet_missing` while the account has no Peable wallet yet. Consumes the link and tells the platform (`connected_account.updated`) in one transaction.',
    auth: 'user',
    params: tokenParam,
    body: confirmFaircoinOnboardingParams,
    response: connectOnboardingCompleteSchema,
  }),
] as const;
