import type {
  PaymentIntentCancellationReason,
  PaymentIntentStatus,
  WebhookDeliveryStatus,
} from '@peable.to/shared-types';

/**
 * Every payment status, in lifecycle order — Stripe's seven (ADR 0019).
 * Restated from `shared-types` (whose root barrel a browser bundle must not
 * load, see `format/money.ts`); `status.test.ts` pins it to
 * `PAYMENT_INTENT_STATUSES`.
 */
export const ORBIT_PAYMENT_STATUSES: readonly PaymentIntentStatus[] = [
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'requires_capture',
  'succeeded',
  'canceled',
];

/** Bloom's semantic tones, the subset Orbit paints statuses with. */
export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const PAYMENT_TONES: Record<PaymentIntentStatus, StatusTone> = {
  requires_payment_method: 'neutral',
  requires_confirmation: 'neutral',
  requires_action: 'warning',
  processing: 'info',
  requires_capture: 'warning',
  succeeded: 'success',
  canceled: 'danger',
};

export function paymentStatusTone(status: PaymentIntentStatus): StatusTone {
  return PAYMENT_TONES[status] ?? 'neutral';
}

const PAYMENT_LABELS: Record<PaymentIntentStatus, string> = {
  requires_payment_method: 'Awaiting payment method',
  requires_confirmation: 'Awaiting confirmation',
  requires_action: 'Awaiting payer',
  processing: 'Processing',
  requires_capture: 'Authorized',
  succeeded: 'Succeeded',
  canceled: 'Canceled',
};

export function paymentStatusLabel(status: PaymentIntentStatus): string {
  return PAYMENT_LABELS[status] ?? status;
}

const CANCELLATION_LABELS: Record<PaymentIntentCancellationReason, string> = {
  abandoned: 'Expired unpaid',
  automatic: 'Canceled by the provider',
  duplicate: 'Duplicate',
  fraudulent: 'Fraudulent',
  requested_by_customer: 'Requested by the customer',
  underpaid: 'Underpaid',
};

/** Why a canceled payment ended, in the merchant's words; `null` when nobody said. */
export function cancellationReasonLabel(reason: PaymentIntentCancellationReason | null): string {
  return reason === null ? 'No reason given' : (CANCELLATION_LABELS[reason] ?? reason);
}

const DELIVERY_TONES: Record<WebhookDeliveryStatus, StatusTone> = {
  pending: 'info',
  delivered: 'success',
  failed: 'danger',
  dead: 'danger',
};

export function deliveryStatusTone(status: WebhookDeliveryStatus): StatusTone {
  return DELIVERY_TONES[status] ?? 'neutral';
}

const DELIVERY_LABELS: Record<WebhookDeliveryStatus, string> = {
  pending: 'Pending',
  delivered: 'Delivered',
  failed: 'Refused',
  dead: 'Gave up',
};

export function deliveryStatusLabel(status: WebhookDeliveryStatus): string {
  return DELIVERY_LABELS[status] ?? status;
}
