// A SetupIntent (`seti_…`) — saving a card for later without charging it
// (ADR 0016, ADR 0019). The provider SetupIntent is an internal binding; its
// success is what creates the Peable `pm_…`, attached to the customer.
import type { Customer } from './customer';
import type { PaymentIntentLastPaymentError } from './paymentIntent';
import type { PaymentMethod } from './paymentMethod';

export type SetupIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'canceled'
  | 'succeeded';

export const SETUP_INTENT_STATUSES: readonly SetupIntentStatus[] = [
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'canceled',
  'succeeded',
];

export type SetupIntentUsage = 'on_session' | 'off_session';

export type SetupIntentCancellationReason = 'abandoned' | 'duplicate' | 'requested_by_customer';

export interface SetupIntent {
  id: string;
  object: 'setup_intent';
  livemode: boolean;
  status: SetupIntentStatus;
  usage: SetupIntentUsage;
  payment_method_types: ['card'];
  /** `cus_…`, or the {@link Customer} with `expand[]=customer`. */
  customer: string | Customer | null;
  /** The `pm_…` it saved, once `succeeded`. */
  payment_method: string | PaymentMethod | null;
  /** Possession of it lets the payer's browser confirm this SetupIntent. */
  client_secret: string;
  next_action: { type: 'use_peable_sdk' } | null;
  last_setup_error: PaymentIntentLastPaymentError | null;
  cancellation_reason: SetupIntentCancellationReason | null;
  description: string | null;
  metadata: Record<string, string>;
  created: number;
}

export interface CreateSetupIntentParams {
  customer?: string;
  usage?: SetupIntentUsage;
  payment_method_types?: ['card'];
  description?: string;
  metadata?: Record<string, string>;
}

export interface CancelSetupIntentParams {
  cancellation_reason?: SetupIntentCancellationReason;
}
