import { OxyServices } from '@oxy.so/core';
import { config } from '../config';
/** A fresh request-local SDK: no cached roles and no caller token on a singleton. */
export async function authorizeContributionOrganization(
  token: string,
  organizationId: string,
  applicationId: string,
): Promise<boolean> {
  const client = new OxyServices({ baseURL: config.oxyApiUrl });
  client.session.setAccessToken(token);
  const [account, app] = await Promise.all([
    client.accounts.get(organizationId),
    client.apps.get(applicationId),
  ]);
  return (
    account.kind === 'organization' &&
    account.accountId === organizationId &&
    app.ownerAccountId === organizationId &&
    ['owner', 'admin', 'editor'].includes(account.callerMembership?.role ?? '') &&
    app.status === 'active'
  );
}
