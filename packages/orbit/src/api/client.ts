import { OxyServices } from '@oxy.so/core';
import { GATEWAY_API_URL, OXY_BASE_URL } from '../config';
import { createContributionsApi } from './contributions';
import { createDashboardApi } from './dashboard';
import { createOrbitTransport } from './transport';
import { createTaxComplianceApi } from '../tax/complianceApi';

/**
 * The ONE `OxyServices` instance, handed to `OxyProvider` in `app/_layout.tsx`,
 * so every module reads the one canonical Oxy session. Only `baseURL` is
 * configured: session restore, token minting and refresh are the SDK's.
 */
export const oxyServices = new OxyServices({ baseURL: OXY_BASE_URL });

/**
 * The gateway, addressed by a linked client: its own base URL, its bearer kept
 * in lockstep with the Oxy session. Orbit calls the `/v1/dashboard/*` routes as
 * the signed-in USER; there is no merchant credential in a browser.
 */
const gateway = oxyServices.createLinkedClient({ baseURL: GATEWAY_API_URL });
const transport = createOrbitTransport(gateway.client);

export const dashboardApi = createDashboardApi(transport);
export const contributionsApi = createContributionsApi(transport);
export const taxComplianceApi = createTaxComplianceApi(transport);
