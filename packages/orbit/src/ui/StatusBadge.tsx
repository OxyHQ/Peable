import type { PaymentIntentStatus, WebhookDeliveryStatus } from '@peable.to/shared-types';
import { Badge } from '@oxy.so/bloom/badge';
import {
  deliveryStatusLabel,
  deliveryStatusTone,
  paymentStatusLabel,
  paymentStatusTone,
} from '../payments/status';

export function PaymentStatusBadge({ status }: { status: PaymentIntentStatus }) {
  return (
    <Badge
      appearance="subtle"
      tone={paymentStatusTone(status)}
      size="label-small"
      content={paymentStatusLabel(status)}
    />
  );
}

export function DeliveryStatusBadge({ status }: { status: WebhookDeliveryStatus }) {
  return (
    <Badge
      appearance="subtle"
      tone={deliveryStatusTone(status)}
      size="label-small"
      content={deliveryStatusLabel(status)}
    />
  );
}
