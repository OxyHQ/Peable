import { createEcosystemTraffic } from '@oxy.so/core/server';
import type { RequestHandler } from 'express';
import { workloadCredentials } from './oxy';

let activity: ReturnType<typeof createEcosystemTraffic> | undefined;

/** Region config enables telemetry; credentials are resolved by the shared provider on demand. */
export function startEcosystemActivity(
  ready: () => boolean,
  create: typeof createEcosystemTraffic = createEcosystemTraffic,
  region = process.env.AWS_REGION,
): void {
  if (activity || !region) return;
  activity = create({ service: 'peable', ready, region, workloadCredentials });
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
