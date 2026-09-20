import { canAttestWorkloadIdentity, createEcosystemTraffic } from '@oxy.so/core/server';
import type { RequestHandler } from 'express';

let activity: ReturnType<typeof createEcosystemTraffic> | undefined;

/**
 * Start only at process bootstrap; constructing a test app starts no publisher.
 *
 * ## Why the key pair is no longer what decides this
 *
 * The gate asks one question — can this process authenticate to Oxy at all? A
 * key pair used to be the only answer, so the pair was the gate. Since oxy
 * ADR 0026 it is not: a deployed task signs an STS `GetCallerIdentity` request
 * with its own ECS task role, Oxy replays it, and the same service token comes
 * back with no secret anywhere. The whole fleet is moving to that, which means
 * `OXY_SERVICE_API_KEY` and `OXY_SERVICE_API_SECRET` are being DELETED from the
 * task definitions.
 *
 * Gating on the pair would have made that deletion a silent failure: the
 * gateway boots, the rollout goes green, and peable quietly vanishes from the
 * ecosystem dashboard with one warning line to explain it. The container
 * credentials endpoint ECS exposes to every task — what
 * `canAttestWorkloadIdentity()` reads — is the honest test of "am I a deployed
 * process that can prove what it is".
 *
 * The pair is still accepted while it is still injected: `createEcosystemTraffic`
 * prefers it and falls back to attestation, so this boots identically before and
 * after the secret goes. A laptop has neither and still starts no publisher —
 * which is what keeps `bun test` from publishing anything.
 *
 * The decision is {@link canStartEcosystemActivity}, separated from the start so
 * a test can assert it without constructing a publisher that installs timers, a
 * global `fetch` wrapper and a heartbeat.
 */
export function canStartEcosystemActivity(): boolean {
  const pair =
    Boolean(process.env.OXY_SERVICE_API_KEY?.trim()) && Boolean(process.env.OXY_SERVICE_API_SECRET?.trim());
  return pair || canAttestWorkloadIdentity();
}

export function startEcosystemActivity(ready: () => boolean): void {
  if (!canStartEcosystemActivity()) {
    console.warn(
      'Ecosystem activity is disabled for peable: no OXY_SERVICE_API_KEY/OXY_SERVICE_API_SECRET and no workload identity to attest',
    );
    return;
  }
  if (activity) return;
  activity = createEcosystemTraffic({
    service: 'peable',
    ready,
  });
  activity.installFetch();
}

export const ecosystemActivityMiddleware: RequestHandler = (request, response, next) => {
  if (activity) activity.observeHttp(request, response, next);
  else next();
};

export function observeEcosystemSocket(socket: Parameters<ReturnType<typeof createEcosystemTraffic>['observeSocket']>[0]): void {
  activity?.observeSocket(socket);
}

export async function stopEcosystemActivity(): Promise<void> {
  const current = activity;
  activity = undefined;
  await current?.stop();
}
