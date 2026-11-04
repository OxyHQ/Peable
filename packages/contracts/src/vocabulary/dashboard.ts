// What a signed-in person may do in Orbit — the ONE map from a dashboard
// action to the Oxy application permission it needs. Zod-free. The gateway
// gates every `/v1/dashboard/applications/:id/*` and contribution route on it
// (a refusal is `permission_required`, `param` naming the permission), and
// Orbit hides or disables what the person lacks with the SAME map, so the two
// can never disagree about who may do what.

import type { FileUploadPurpose } from './files';

/**
 * The permissions are oxy-api's own APPLICATION vocabulary
 * (`packages/api/src/utils/accountRoles.ts`, `APPLICATION_PERMISSIONS`): Oxy
 * resolves the person's role, grants and revokes on the account that owns the
 * application into `callerMembership.permissions`, and that list — from
 * `apps.get` on the gateway, from `apps.list` in Orbit — is the whole answer.
 * Peable never reads a role name and keeps no membership copy.
 */
export const DASHBOARD_PERMISSIONS = {
  /**
   * Every read, the searches and a report run (it materialises the same rows a
   * download streams). oxy-api answers an application only to a holder of
   * `app:read`, so this is membership itself.
   */
  read: 'app:read',
  /**
   * The integration's configuration: branding and customer emails, the
   * catalog, checkout sessions and payment links, contribution links, payment
   * methods and wallet domains, a business logo.
   */
  configure: 'app:update',
  /** Webhook endpoints and their signing secrets, test events, redelivery. */
  webhooks: 'webhooks:update',
  /**
   * Money and who receives it: the merchant registration (its watch-only key
   * and confirmations), the provider account and its onboarding and identity
   * documents, payouts, sellers and transfers, disputes and their evidence, the
   * billing engine, and every Peable Tax change or decision.
   */
  money: 'billing:manage',
  /** Peable Tax reads and previews (ADR 0011, ADR 0020). */
  taxRead: 'billing:read',
} as const;

export type DashboardAction = keyof typeof DASHBOARD_PERMISSIONS;
export type DashboardPermission = (typeof DASHBOARD_PERMISSIONS)[DashboardAction];

/**
 * A permission that CONTAINS another: whoever may manage billing may read it.
 * Stated once so the gateway and Orbit apply the same containment.
 */
const IMPLIED_BY: Readonly<Partial<Record<DashboardPermission, DashboardPermission>>> = {
  'billing:read': 'billing:manage',
};

/** Whether `held` (Oxy's `callerMembership.permissions`) allows `action`. */
export function allowsDashboardAction(held: readonly string[], action: DashboardAction): boolean {
  const required = DASHBOARD_PERMISSIONS[action];
  const container = IMPLIED_BY[required];
  return held.includes(required) || (container !== undefined && held.includes(container));
}

/**
 * Uploading a file is the first half of USING it, so it needs what the use
 * needs: a logo is configuration, everything else is evidence or identity for
 * money (a dispute, the provider account, Peable Tax).
 */
export const FILE_UPLOAD_ACTION: Readonly<Record<FileUploadPurpose, DashboardAction>> = {
  business_logo: 'configure',
  dispute_evidence: 'money',
  identity_document: 'money',
  additional_verification: 'money',
  tax_document: 'money',
};
