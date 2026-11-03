import type {
  ProviderCheckoutActions,
  ProviderCheckoutSession,
  ProviderSdk,
  ProviderElement,
} from '../browser/providerJs';
import type { ProviderCardPreparation } from './preparedCard';

import type { BillingEmbeddedCheckoutAction } from '@peable.to/shared-types';
export type CheckoutSessionAction = BillingEmbeddedCheckoutAction;

export function matchingCheckoutSessionAction(
  action: CheckoutSessionAction | undefined,
  publishableKey: string | undefined,
): CheckoutSessionAction | undefined {
  return action?.kind === 'checkout_session' &&
    action.provider === 'stripe' &&
    /^cs_(test|live)_[A-Za-z0-9]+$/.test(action.session_id) &&
    action.client_secret &&
    action.publishable_key === publishableKey &&
    /^pk_(test|live)_[A-Za-z0-9]+$/.test(action.publishable_key) &&
    action.session_id.startsWith(
      action.publishable_key.startsWith('pk_live_') ? 'cs_live_' : 'cs_test_',
    ) &&
    Number.isSafeInteger(action.amount_minor_units) &&
    action.amount_minor_units > 0 &&
    /^[A-Z]{3}$/.test(action.currency)
    ? action
    : undefined;
}
/** Read every provider amount field required by Checkout before accepting the exact server quote. */
export function checkoutSessionMatchesQuote(
  session: ProviderCheckoutSession,
  action: CheckoutSessionAction,
): boolean {
  const amount = session.total.total.minorUnitsAmount;
  const currency = session.currency;
  const divisor = session.minorUnitsAmountDivisor;
  const digits = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: action.currency,
  }).resolvedOptions().maximumFractionDigits;
  return (
    session.id === action.session_id &&
    session.livemode === action.publishable_key.startsWith('pk_live_') &&
    currency.toUpperCase() === action.currency &&
    amount === action.amount_minor_units &&
    digits !== undefined &&
    divisor === 10 ** digits
  );
}

/** Tokenize only; the explicit confirm call performs the provider operation, never grants access. */
export async function prepareCheckoutSessionCard({
  provider,
  card,
  billing,
  action,
  messages,
  isCurrent,
}: {
  provider: ProviderSdk;
  card: ProviderElement;
  billing: { country: string; postcode: string; email?: string };
  action: CheckoutSessionAction;
  returnUrl: string;
  messages: { failed: string; incomplete: string; busy: string; closed: string };
  isCurrent(): boolean;
}): Promise<ProviderCardPreparation> {
  if (
    !provider.initCheckoutElementsSdk ||
    !provider.createPaymentMethod ||
    !isCurrent() ||
    !matchingCheckoutSessionAction(action, action.publishable_key)
  )
    return { prepared: false, error: messages.failed };
  const authority = { ...action };
  const receiptEmail = billing.email?.trim();
  const loaded = await provider
    .initCheckoutElementsSdk({ clientSecret: authority.client_secret })
    .loadActions();
  if (!isCurrent()) return { prepared: false, error: messages.closed };
  if (loaded.type !== 'success')
    return { prepared: false, error: loaded.error.message ?? messages.failed };
  let actions: ProviderCheckoutActions | undefined = loaded.actions;
  const initial = actions.getSession();
  // canConfirm describes collected checkout data; the external PaymentMethod is
  // supplied only in confirm. It cannot gate this separate tokenization step.
  // The provider validates its required collection data in that explicit call.
  if (!checkoutSessionMatchesQuote(initial, authority) || initial.status.type !== 'open')
    return { prepared: false, error: messages.failed };
  const result = await provider.createPaymentMethod({
    type: 'card',
    card,
    billing_details: {
      address: { country: billing.country, postal_code: billing.postcode },
      ...(receiptEmail ? { email: receiptEmail } : {}),
    },
  });
  if (!isCurrent()) return { prepared: false, error: messages.closed };
  const method = result.paymentMethod;
  if (
    result.error ||
    !method ||
    !/^pm_[A-Za-z0-9]+$/.test(method.id) ||
    !/^\d{4}$/.test(method.card?.last4 ?? '')
  )
    return { prepared: false, error: result.error?.message ?? messages.failed };
  let token = method.id;
  let disposed = false;
  let busy = false;
  let accepted = false;
  return {
    prepared: true,
    authorization: {
      card: { brand: method.card?.brand ?? 'Card', last4: method.card?.last4 ?? '' },
      dispose() {
        disposed = true;
        token = '';
        actions = undefined;
        authority.client_secret = '';
      },
      async confirm() {
        if (disposed || !isCurrent() || !actions)
          return { accepted: false, error: messages.closed };
        if (busy) return { accepted: false, error: messages.busy };
        if (accepted) return { accepted: true };
        busy = true;
        try {
          const current = actions.getSession();
          if (!checkoutSessionMatchesQuote(current, authority) || current.status.type !== 'open')
            return { accepted: false, error: messages.failed };
          const outcome = await actions.confirm({
            paymentMethod: token,
            redirect: 'if_required',
            ...(receiptEmail ? { email: receiptEmail } : {}),
          });
          if (disposed || !isCurrent()) return { accepted: false, error: messages.closed };
          if (outcome.type === 'error')
            return { accepted: false, error: outcome.error.message ?? messages.failed };
          accepted =
            checkoutSessionMatchesQuote(outcome.session, authority) &&
            outcome.session.status.type === 'complete';
          return accepted ? { accepted: true } : { accepted: false, error: messages.incomplete };
        } catch {
          return { accepted: false, error: messages.failed };
        } finally {
          busy = false;
        }
      },
    },
  };
}
