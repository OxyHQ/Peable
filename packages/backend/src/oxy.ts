import { canAttestWorkloadIdentity, OxyServer } from '@oxy.so/core/server';
import { config } from './config';

/** Registered recipient identity; merchant authority still comes from verified app/environment. */
export const PEABLE_SERVICE_AUDIENCE = 'oxy-service:6a2f851751b784a86fd0e958';

/** One shared workload client for verification, user lookups and Oxy Files. */
export const oxy = new OxyServer({ baseURL: config.oxyApiUrl });

export function canUseOxyServiceLane(): boolean {
  return canAttestWorkloadIdentity();
}
