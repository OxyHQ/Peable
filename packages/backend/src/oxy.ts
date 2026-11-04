import { OxyServer } from '@oxy.so/core/server';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';
import {
  PEABLE_OXY_APPLICATION_ID,
  PEABLE_SERVICE_AUDIENCE,
} from '@peable.to/contracts/vocabulary';
import { config } from './config';

/**
 * One shared workload client for verification, user lookups, Oxy Files and
 * what a signed-in person may do (`services/oxyAccess.ts`).
 *
 * - `serviceIdentity: 'when-anonymous'`: a call with no user session (a
 *   profile lookup by username, `users.getMany` for enrichment) carries
 *   Peable's own service token, so oxy-api charges it to Peable instead of to
 *   the fleet's one NAT address.
 * - `expectedAudience`: the audience every `middleware.auth()` / `service()`
 *   mount — and so `createOxyAuthMiddleware` and `createOxyRateLimit` —
 *   accepts, named once here instead of at each mount. It and the
 *   `applicationId` are `@peable.to/contracts`' one definition, the one the
 *   SDK addresses. Merchant authority still comes from the verified
 *   application and environment, never from the audience.
 */
export const workloadCredentials = createAwsWorkloadCredentialProvider();
export const oxy = new OxyServer({
  baseURL: config.oxyApiUrl,
  workloadCredentials,
  applicationId: PEABLE_OXY_APPLICATION_ID,
  serviceIdentity: 'when-anonymous',
  expectedAudience: PEABLE_SERVICE_AUDIENCE,
});
