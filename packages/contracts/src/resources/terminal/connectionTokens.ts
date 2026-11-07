import { z } from 'zod';
import { defineComponent } from '../../common/objects';
import { idParam } from '../../common/params';
import { defineRoute } from '../../route';

/**
 * Terminal connection tokens (ADR 0024) — the short-lived secret a Terminal
 * SDK (JavaScript, iOS, Android, React Native) needs to talk to readers. Minted
 * by the provider for each request and handed through: Orbit never stores one,
 * and the generic idempotency layer never replays one.
 */
export const terminalConnectionTokenSchema = defineComponent(
  'TerminalConnectionToken',
  z
    .object({
      object: z.literal('terminal.connection_token'),
      secret: z
        .string()
        .describe("The provider's short-lived secret for its Terminal SDK. Never stored by Orbit."),
      location: z.string().describe('The location (`tml_…`) the token is limited to.'),
    })
    .strict(),
);
export type TerminalConnectionToken = z.output<typeof terminalConnectionTokenSchema>;

export const createTerminalConnectionTokenParams = z
  .object({
    location: idParam.describe(
      'The location (`tml_…`) whose readers the token may reach. Required: readers live on one provider account shared by every merchant, and a token without a location would reach all of them.',
    ),
  })
  .strict();
export type CreateTerminalConnectionTokenParams = z.input<
  typeof createTerminalConnectionTokenParams
>;

export const terminalConnectionTokenRoutes = [
  defineRoute({
    operationId: 'createTerminalConnectionToken',
    method: 'post',
    path: '/v1/terminal/connection_tokens',
    tag: 'Terminal',
    summary: 'Create a connection token',
    description:
      'A fresh token on every call, limited to one of your locations (unlike Stripe, `location` is required), answered with `Cache-Control: no-store` and never stored or replayed (no `Idempotency-Key` replay: a token is a credential, and minting two moves nothing). 503 `terminal_unavailable` when Terminal is not enabled in this mode.',
    auth: 'service',
    scope: 'payments:write',
    body: createTerminalConnectionTokenParams,
    response: terminalConnectionTokenSchema,
    status: 201,
    sdk: 'terminal.connectionTokens.create',
  }),
] as const;
