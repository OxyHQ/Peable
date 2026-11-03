import type { PaymentIntent } from '@peable.to/shared-types';
import { delayedProcessingNotice } from '@peable.to/sdk/checkout';
import { type Translate, useI18n } from '../i18n';

interface StatusVisual {
  title: string;
  subtitle: string;
  tone: 'primary' | 'warning' | 'danger';
  showSpinner: boolean;
}

// Mirrors the wallet's `describePaymentStatus` — same statuses spin, same are
// terminal, same tone — so the checkout page and the wallet read identically
// for the same intent. The vocabulary is Stripe's (ADR 0019); a cancelled
// payment says WHY.
function describeStatus(intent: PaymentIntent, t: Translate): StatusVisual {
  switch (intent.status) {
    case 'processing': {
      const chain = intent.faircoin;
      if (chain === null) {
        // A SEPA Debit is `processing` for days, and a payer told "being
        // processed..." with a spinner would assume it is stuck.
        return {
          title: t('processingTitle'),
          // A delayed method (SEPA Debit) says how long it takes; else the generic line.
          subtitle: delayedProcessingNotice(intent) ?? t('processingSubtitle'),
          tone: 'primary',
          showSpinner: true,
        };
      }
      return chain.confirmations > 0
        ? {
            title: t('confirmingTitle'),
            subtitle: t('confirmingSubtitle', {
              count: chain.confirmations,
              required: chain.required_confirmations,
            }),
            tone: 'primary',
            showSpinner: true,
          }
        : {
            title: t('sentTitle'),
            subtitle: t('sentSubtitle'),
            tone: 'primary',
            showSpinner: true,
          };
    }
    case 'requires_capture':
      return {
        title: t('authorizedTitle'),
        subtitle: t('authorizedSubtitle'),
        tone: 'primary',
        showSpinner: false,
      };
    case 'succeeded':
      return {
        title: t('completeTitle'),
        subtitle: t('completeSubtitle'),
        tone: 'primary',
        showSpinner: false,
      };
    case 'canceled':
      if (intent.cancellation_reason === 'abandoned') {
        return {
          title: t('requestExpiredTitle'),
          subtitle: t('requestExpiredSubtitle'),
          tone: 'warning',
          showSpinner: false,
        };
      }
      if (intent.cancellation_reason === 'underpaid') {
        return {
          title: t('failedTitle'),
          subtitle: intent.last_payment_error?.message ?? t('underpaidSubtitle'),
          tone: 'danger',
          showSpinner: false,
        };
      }
      return {
        title: t('canceledTitle'),
        subtitle: t('canceledSubtitle'),
        tone: 'danger',
        showSpinner: false,
      };
    default:
      return {
        title: t('waitingTitle'),
        subtitle: t('waitingSubtitle'),
        tone: 'primary',
        showSpinner: true,
      };
  }
}

/**
 * The payment's status. It deliberately offers no "continue" link: leaving
 * for the merchant's success URL is the SESSION's decision, made only once the
 * gateway reports the session complete.
 */
export function StatusPanel({ intent }: { intent: PaymentIntent }) {
  const { t } = useI18n();
  const visual = describeStatus(intent, t);
  return (
    <div className={`status-panel status-panel--${visual.tone}`} aria-live="polite">
      {visual.showSpinner ? (
        <span className="status-panel__spinner" aria-hidden="true" />
      ) : (
        <span className="status-panel__icon" aria-hidden="true">
          {intent.status === 'succeeded' || intent.status === 'requires_capture'
            ? '✓'
            : intent.cancellation_reason === 'abandoned'
              ? '!'
              : '✕'}
        </span>
      )}
      <p className="status-panel__title">{visual.title}</p>
      <p className="status-panel__subtitle">{visual.subtitle}</p>
    </div>
  );
}
