import { canAttestWorkloadIdentity, createEcosystemTraffic } from '@oxy.so/core/server';
import type { RequestHandler } from 'express';

let activity: ReturnType<typeof createEcosystemTraffic> | undefined;

/** Own telemetry is authenticated by this deployment's workload identity. */
export function canStartEcosystemActivity(): boolean {
  return canAttestWorkloadIdentity();
}

export function startEcosystemActivity(ready: () => boolean): void {
  if (!canStartEcosystemActivity()) {
    console.warn('Ecosystem activity is disabled for peable: no workload identity to attest');
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

export function observeEcosystemSocket(
  socket: Parameters<ReturnType<typeof createEcosystemTraffic>['observeSocket']>[0],
): void {
  activity?.observeSocket(socket);
}

export async function stopEcosystemActivity(): Promise<void> {
  const current = activity;
  activity = undefined;
  await current?.stop();
}
