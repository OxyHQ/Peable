import { PeableMethodContent, type PeableMethodDetails } from './PeableMethodContent';
import type { StatusRingProps } from '@oxy.so/bloom/loading';
import { PeableBrandStatus } from './PeableBrandStatus';
import { CheckoutSheet, type CheckoutSheetProps } from '@oxy.so/bloom/checkout-sheet';
import { formatCheckoutAmount } from './amount';
import { checkoutMessage } from './messages';

export type PeableCheckoutSheetProps = Omit<
  CheckoutSheetProps,
  'label' | 'formatAmount' | 'footer'
> & {
  /** Host-resolved language, e.g. the Oxy Services language preference. */
  locale?: string;
  /** Optional rail-specific presentation. The host supplies quote data and action capabilities. */
  methodDetails?: PeableMethodDetails;
  /** Controlled completion presentation; never changes payment state. */
  brandState?: StatusRingProps['state'];
  /** Optional product copy overrides. Preview disclosures remain the local host's responsibility. */
  messages?: Readonly<Record<string, string>>;
};

/** Controlled payment presentation. Only host-supplied callbacks can start or observe a payment.
 * No credentials, payment requests, persistence or entitlement updates are owned by this component. */
export function PeableCheckoutSheet({
  locale = 'en',
  messages,
  brandState,
  methodDetails,
  ...props
}: PeableCheckoutSheetProps) {
  return (
    <CheckoutSheet
      {...props}
      methodContent={
        methodDetails ? (
          <PeableMethodContent
            details={methodDetails}
            label={(key) => checkoutMessage(locale, key, undefined, messages)}
          />
        ) : (
          props.methodContent
        )
      }
      label={(key, values) => checkoutMessage(locale, key, values, messages)}
      formatAmount={(amount, currency) => formatCheckoutAmount(amount, currency, locale)}
      footer={
        <PeableBrandStatus
          state={
            brandState ??
            (props.step === 'processing'
              ? 'loading'
              : props.step === 'success'
                ? 'success'
                : props.step === 'failure'
                  ? 'error'
                  : 'idle')
          }
          label={
            props.step === 'processing' || props.step === 'success' || props.step === 'failure'
              ? checkoutMessage(locale, `result.${props.step}`, undefined, messages)
              : 'Peable'
          }
        />
      }
    />
  );
}
