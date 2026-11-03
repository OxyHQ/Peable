import type { PaymentIntentStatus, WebhookDeliveryStatus } from '@peable.to/shared-types';

/**
 * Every payment status, in lifecycle order. Restated from `shared-types`
 * (whose root barrel a browser bundle must not load, see `format/money.ts`);
 * `status.test.ts` pins it to `PAYMENT_INTENT_STATUSES`.
 */
export const ORBIT_PAYMENT_STATUSES: readonly PaymentIntentStatus[] = [
  'created',
  'awaiting_approval',
  'approved',
  'broadcast',
  'confirming',
  'requires_action',
  'processing',
  'settled',
  'partially_refunded',
  'refunded',
  'failed',
  'rejected',
  'expired',
];

/** Bloom's semantic tones, the subset Orbit paints statuses with. */
export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const PAYMENT_TONES: Record<PaymentIntentStatus, StatusTone> = {
  created: 'neutral',
  awaiting_approval: 'warning',
  approved: 'info',
  broadcast: 'info',
  confirming: 'info',
  requires_action: 'warning',
  processing: 'info',
  settled: 'success',
  partially_refunded: 'neutral',
  refunded: 'neutral',
  failed: 'danger',
  rejected: 'danger',
  expired: 'neutral',
};

export function paymentStatusTone(status: PaymentIntentStatus): StatusTone {
  return PAYMENT_TONES[status] ?? 'neutral';
}

const PAYMENT_LABELS: Record<PaymentIntentStatus, string> = {
  created: 'Created',
  awaiting_approval: 'Awaiting approval',
  approved: 'Approved',
  broadcast: 'Broadcast',
  confirming: 'Confirming',
  requires_action: 'Requires action',
  processing: 'Processing',
  settled: 'Succeeded',
  partially_refunded: 'Partially refunded',
  refunded: 'Refunded',
  failed: 'Failed',
  rejected: 'Rejected',
  expired: 'Expired',
};

export function paymentStatusLabel(status: PaymentIntentStatus): string {
  return PAYMENT_LABELS[status] ?? status;
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
