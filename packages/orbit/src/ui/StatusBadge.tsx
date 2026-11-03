import type {
  AccountCapabilityStatus,
  BalanceTransactionStatus,
  DisputeStatus,
  PaymentIntentStatus,
  PayoutStatus,
  WebhookDeliveryStatus,
} from '@peable.to/shared-types';
import { Badge } from '@oxy.so/bloom/badge';
import { disputeStatusLabel, disputeStatusTone } from '../disputes/evidence';
import { t } from '../i18n';
import {
  balanceTransactionStatusLabel,
  balanceTransactionStatusTone,
  capabilityLabel,
  capabilityTone,
  payoutStatusLabel,
  payoutStatusTone,
} from '../money/vocabulary';
import {
  deliveryStatusLabel,
  deliveryStatusTone,
  paymentStatusLabel,
  paymentStatusTone,
} from '../payments/status';

export function PayoutStatusBadge({ status }: { status: PayoutStatus }) {
  return (
    <Badge
      appearance="subtle"
      tone={payoutStatusTone(status)}
      size="label-small"
      content={payoutStatusLabel(status)}
    />
  );
}

export function BalanceTransactionStatusBadge({ status }: { status: BalanceTransactionStatus }) {
  return (
    <Badge
      appearance="subtle"
      tone={balanceTransactionStatusTone(status)}
      size="label-small"
      content={balanceTransactionStatusLabel(status)}
    />
  );
}

export function CapabilityBadge({ status }: { status: AccountCapabilityStatus | null }) {
  return (
    <Badge
      appearance="subtle"
      tone={capabilityTone(status)}
      size="label-small"
      content={capabilityLabel(status)}
    />
  );
}

/** `charges_enabled` / `payouts_enabled`, as the provider reports them. */
export function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <Badge
      appearance="subtle"
      tone={enabled ? 'success' : 'danger'}
      size="label-small"
      content={enabled ? t('account.enabled') : t('account.disabled')}
    />
  );
}

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

export function DisputeStatusBadge({ status }: { status: DisputeStatus }) {
  return (
    <Badge
      appearance="subtle"
      tone={disputeStatusTone(status)}
      size="label-small"
      content={disputeStatusLabel(status)}
    />
  );
}
