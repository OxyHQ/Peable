import type { PaymentIntent } from '@peable.to/shared-types';

interface StatusVisual {
  title: string;
  subtitle: string;
  tone: 'primary' | 'warning' | 'danger';
  showSpinner: boolean;
}

// Mirrors the wallet's `describePaymentStatus` (packages/frontend/app/pay/
// [intent].tsx) — same statuses spin, same statuses are terminal, same tone
// (succeeded reuses the primary/brand color there, not a separate "success"
// green, so this does too) — so the checkout page and the wallet's approve
// screen read identically for the same intent. Icon GLYPHS differ (plain
// text/SVG here, not MaterialCommunityIcons — this is a web app with no icon
// library dependency), only the semantic mapping is shared.
//
// The vocabulary is Stripe's (ADR 0019). A cancelled payment says WHY:
// `abandoned` is the expiry clock, `underpaid` is coins that were not enough,
// anything else is the merchant calling it off.
function describeStatus(intent: PaymentIntent): StatusVisual {
  switch (intent.status) {
    case 'processing': {
      const chain = intent.faircoin;
      if (chain === null) {
        return {
          title: 'Processing',
          subtitle: 'Your payment is being processed...',
          tone: 'primary',
          showSpinner: true,
        };
      }
      return chain.confirmations > 0
        ? {
            title: 'Confirming',
            subtitle: `${chain.confirmations} of ${chain.required_confirmations} confirmation(s) so far...`,
            tone: 'primary',
            showSpinner: true,
          }
        : {
            title: 'Payment sent',
            subtitle: 'Waiting to be seen on-chain...',
            tone: 'primary',
            showSpinner: true,
          };
    }
    case 'requires_capture':
      return {
        title: 'Payment authorized',
        subtitle: 'The merchant will complete your payment.',
        tone: 'primary',
        showSpinner: false,
      };
    case 'succeeded':
      return {
        title: 'Payment complete',
        subtitle: 'The merchant has received your payment.',
        tone: 'primary',
        showSpinner: false,
      };
    case 'canceled':
      if (intent.cancellation_reason === 'abandoned') {
        return {
          title: 'Payment request expired',
          subtitle: 'This request is no longer valid.',
          tone: 'warning',
          showSpinner: false,
        };
      }
      if (intent.cancellation_reason === 'underpaid') {
        return {
          title: 'Payment failed',
          subtitle:
            intent.last_payment_error?.message ?? 'The transaction paid less than the amount due.',
          tone: 'danger',
          showSpinner: false,
        };
      }
      return {
        title: 'Payment canceled',
        subtitle: 'The merchant canceled this payment.',
        tone: 'danger',
        showSpinner: false,
      };
    // Waiting on the payer (`requires_payment_method`, `requires_confirmation`,
    // `requires_action`) on a surface that cannot take the payment here.
    default:
      return {
        title: 'Waiting for payment',
        subtitle: 'This payment has not been made yet.',
        tone: 'primary',
        showSpinner: true,
      };
  }
}

export function StatusPanel({
  intent,
  successUrl,
}: {
  intent: PaymentIntent;
  successUrl?: string;
}) {
  const visual = describeStatus(intent);
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
      {intent.status === 'succeeded' && successUrl && (
        <a className="status-panel__cta" href={successUrl}>
          Continue
        </a>
      )}
    </div>
  );
}
