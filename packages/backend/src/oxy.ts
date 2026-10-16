import { canAttestWorkloadIdentity, OxyServer } from '@oxy.so/core/server';
import { config } from './config';

/**
 * The application credential pair, while a task definition still carries it.
 *
 * `ecosystemActivity.ts` says why it is optional: the fleet is moving to
 * workload identity (oxy ADR 0026), where the task proves what it is with its
 * own ECS role and no secret exists. `OxyServer` mints from the pair when it is
 * given one and attests otherwise, so this boots identically before and after
 * the pair is deleted.
 */
function serviceCredentialPair(): { apiKey: string; apiSecret: string } | undefined {
  const apiKey = process.env.OXY_SERVICE_API_KEY?.trim();
  const apiSecret = process.env.OXY_SERVICE_API_SECRET?.trim();
  return apiKey && apiSecret ? { apiKey, apiSecret } : undefined;
}

const servicePair = serviceCredentialPair();

/**
 * The gateway's one Oxy client: user lookups, the Express / Socket.IO
 * middleware that verifies Oxy user sessions and EdDSA service tokens against
 * Oxy's JWKS, and — with this process's own service token — Peable's calls to
 * Oxy Files (ownership lookups and file references, ADR 0043).
 */
export const oxy = new OxyServer({
  baseURL: config.oxyApiUrl,
  ...(servicePair ? { serviceAuth: servicePair } : {}),
});

/**
 * Whether this process can authenticate to Oxy as Peable at all — the pair, or
 * a deployed task's workload identity. A laptop has neither: Oxy Files calls
 * then cannot be made, so an avatar cannot be verified (and is refused), and
 * the reference loops are not started.
 */
export function canUseOxyServiceLane(): boolean {
  return servicePair !== undefined || canAttestWorkloadIdentity();
}
