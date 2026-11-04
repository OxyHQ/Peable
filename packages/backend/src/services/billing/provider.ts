import type {
  BillingSubscription,
  BillingEmbeddedCheckoutAction,
  CreateBillingCheckoutParams,
  CreateBillingPortalParams,
  EnsureBillingCustomerParams,
} from '@peable.to/shared-types';
import type { BillingDeployment } from './contracts';
export type ProviderBillingSubscription = Omit<BillingSubscription, 'store_id' | 'plan_id'>;
export interface ProviderHostedSession {
  providerObjectRef: string;
  providerCustomerId: string;
  livemode: boolean;
  url: string;
  /** Unix seconds, the unit the wire carries it in. */
  expiresAt: number;
}
/** Platform scope only. No Connect option or merchant-supplied credential. */
export interface BillingProvider {
  readonly deployment: BillingDeployment;
  /** Must establish the configured platform account and key mode before any effect. */
  verifyDeployment(): Promise<void>;
  embeddedConfiguration?(): Promise<{ publishableKey: string }>;
  retrieveEmbeddedAction?(ref: string): Promise<ProviderEmbeddedAction>;
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

export interface ProviderEmbeddedSession {
  providerObjectRef: string;
  providerCustomerId: string;
  livemode: boolean;
  presentation: 'embedded';
  expiresAt: number;
}
export interface ProviderEmbeddedAction {
  status: 'open' | 'complete' | 'expired';
  /** Base units of `currency`. */
  amountMinorUnits: string;
  currency: string;
  action: BillingEmbeddedCheckoutAction | null;
  providerCustomerId: string;
  providerPriceId: string;
  livemode: boolean;
  expiresAt: number;
  taxMinorUnits: string;
}
