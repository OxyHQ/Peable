import { OxyServer } from '@oxy.so/core/server';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';
import { config } from './config';

/** Peable's own Oxy application. */
export const PEABLE_APPLICATION_ID = '6a2f851751b784a86fd0e958';

/** Registered recipient identity; merchant authority still comes from verified app/environment. */
export const PEABLE_SERVICE_AUDIENCE = `oxy-service:${PEABLE_APPLICATION_ID}`;

/**
 * One shared workload client for verification, user lookups and Oxy Files.
 * `serviceIdentity: 'when-anonymous'`: a call with no user session (a profile
 * lookup by username, `users.getMany` for enrichment) carries Peable's own
 * service token, so oxy-api charges it to Peable instead of to the fleet's one
 * NAT address.
 */
export const workloadCredentials = createAwsWorkloadCredentialProvider();
export const oxy = new OxyServer({
  baseURL: config.oxyApiUrl,
  workloadCredentials,
  applicationId: PEABLE_APPLICATION_ID,
  serviceIdentity: 'when-anonymous',
});
