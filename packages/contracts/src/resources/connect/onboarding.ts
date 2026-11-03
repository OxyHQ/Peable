import { z } from 'zod';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import { network, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { merchantDisplaySchema } from '../checkout/shared';

/**
 * The SELLER-facing half of FairCoin connected accounts (ADR 0012 D3).
 *
 * A platform mints an onboarding link for a seller's account; the SELLER opens
 * it signed in with Oxy and registers the watch-only key their FairCoin will be
 * paid to. These routes are `auth: 'user'` — the seller's own session, never a
 * service token — because the key that decides who receives a seller's money is
 * accepted only from the seller. A platform cannot reach them at all, and the
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
 * An extended public key is 111 characters in base58check; the bound is a
 * request-size guard with headroom, not a format check — the non-custody
 * firewall (`assertWatchOnly`) is.
 */
const XPUB_MAX_LENGTH = 200;

/** `POST /v1/connect/onboarding/{token}/faircoin` — the seller's watch-only ACCOUNT xpub. */
export const registerFaircoinKeyParams = z
  .object({
    xpub: z
      .string()
      .trim()
      .min(1)
      .max(XPUB_MAX_LENGTH)
      .describe(
        'A watch-only extended PUBLIC key. A private extended key is refused (`watch_only_violation`) and never stored.',
      ),
  })
  .strict();
export type RegisterFaircoinKeyParams = z.input<typeof registerFaircoinKeyParams>;

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
    operationId: 'registerConnectOnboardingFaircoinKey',
    method: 'post',
    path: '/v1/connect/onboarding/{token}/faircoin',
    tag: 'Connect onboarding',
    summary: "Register the seller's FairCoin key",
    description:
      'The ONLY way a key reaches a connected account: runs the non-custody firewall, consumes the link and tells the platform (`connected_account.updated`), in one transaction. The key is immutable once registered and never appears on any response.',
    auth: 'user',
    params: tokenParam,
    body: registerFaircoinKeyParams,
    response: connectOnboardingCompleteSchema,
  }),
] as const;
