import type {
  BillingSubscription,
  CreateBillingCheckoutParams,
  CreateBillingPortalParams,
  EnsureBillingCustomerParams,
} from '@peable.to/shared-types';
import type { BillingDeployment } from './contracts';
export type ProviderBillingSubscription = Omit<BillingSubscription, 'storeId' | 'planId'>;
export interface ProviderHostedSession {
  providerObjectRef: string;
  providerCustomerId: string;
  livemode: boolean;
  url: string;
  expiresAt: string;
}
/** Platform scope only. No Connect option or merchant-supplied credential. */
export interface BillingProvider {
  readonly deployment: BillingDeployment;
  /** Must establish the configured platform account and key mode before any effect. */
  verifyDeployment(): Promise<void>;
  verifyPortalConfiguration(): Promise<void>;
  ensureCustomer(
    input: EnsureBillingCustomerParams,
    idempotencyKey: string,
  ): Promise<{ providerCustomerId: string; livemode: boolean }>;
  createCheckoutSession(
    input: CreateBillingCheckoutParams,
    idempotencyKey: string,
  ): Promise<ProviderHostedSession>;
  createPortalSession(
    input: CreateBillingPortalParams,
    idempotencyKey: string,
  ): Promise<ProviderHostedSession>;
  retrieveSubscription(providerSubscriptionId: string): Promise<ProviderBillingSubscription>;
  cancelAtPeriodEnd(
    providerSubscriptionId: string,
    idempotencyKey: string,
  ): Promise<ProviderBillingSubscription>;
}
