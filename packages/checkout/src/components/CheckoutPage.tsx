import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CheckoutSessionPublic } from '@peable.to/shared-types';
import { type Translate, useI18n } from '../i18n';
import { type FieldError, fieldErrorOf } from '../lib/apiError';
import { type Appearance, brandingStyle, providerAppearance } from '../lib/branding';
import { formatAmount } from '../lib/money';
import { redirectTo } from '../lib/redirect';
import {
  confirmCheckoutSession,
  getCheckoutSession,
  updateCheckoutSession,
} from '../lib/sessionClient';
import { BrandHeader } from './BrandHeader';
import { CheckoutView } from './CheckoutView';
import {
  DetailsForm,
  type DetailsDraft,
  detailsFieldNames,
  draftFromSession,
  paramsFromDraft,
} from './DetailsForm';
import { OrderSummary } from './OrderSummary';
import { SetupPayment } from './SetupPayment';

/** How often a locked, open session is re-read while the payer pays. */
export const SESSION_POLL_MS = 15_000;
/** …and after a setup confirmation was accepted (no socket covers a SetupIntent). */
export const SETUP_POLL_MS = 3_000;

export interface CheckoutPageProps {
  /** The session as first loaded; every change after it is the gateway's answer. */
  initialSession: CheckoutSessionPublic;
  /** The secret that opened it — the session's, or its payment's. */
  clientSecret: string;
  /** The embedded frame: no redirect of its own, the host is told instead. */
  embedded?: boolean;
  /** An integrator's appearance (embedded mode), over the merchant's branding. */
  appearanceOverride?: Appearance | undefined;
  /** Called once the GATEWAY reports the session complete. */
  onComplete?: (session: CheckoutSessionPublic) => void;
  onExpired?: (session: CheckoutSessionPublic) => void;
}

type Step = 'details' | 'payment' | 'complete' | 'expired';

function submitLabel(session: CheckoutSessionPublic, t: Translate, locale: string): string {
  if (session.mode === 'setup') return t('submitSetup');
  const amount = formatAmount(session.amount_total, session.currency, locale);
  switch (session.submit_type) {
    case 'book':
      return t('submitBook');
    case 'donate':
      return t('submitDonate', { amount });
    default:
      return t('submitPay', { amount });
  }
}

/**
 * One checkout session, from the order to its end.
 *
 * Steps: `details` (the payer edits quantities, codes and what the session
 * collects) → `payment` (the order is LOCKED — the gateway created its payment
 * or setup on confirm) → `complete` or `expired`. Every step change is the
 * gateway's answer: `complete` is reached only when a re-read of the session
 * says so, never because a provider callback resolved, and only then does the
 * payer leave for the merchant's `success_url`.
 */
export function CheckoutPage({
  initialSession,
  clientSecret,
  embedded = false,
  appearanceOverride,
  onComplete,
  onExpired,
}: CheckoutPageProps) {
  const { t, locale } = useI18n();
  const [session, setSession] = useState(initialSession);
  const [draft, setDraft] = useState<DetailsDraft>(() => draftFromSession(initialSession));
  const [fieldError, setFieldError] = useState<FieldError | null>(null);
  const [busy, setBusy] = useState(false);
  const [setupAccepted, setSetupAccepted] = useState(false);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    setSession(initialSession);
    setDraft(draftFromSession(initialSession));
    setFieldError(null);
  }, [initialSession]);

  const locked = session.payment_intent !== null || session.setup_intent !== null;
  const step: Step =
    session.status === 'complete'
      ? 'complete'
      : session.status === 'expired' || session.expires_at * 1000 <= now
        ? 'expired'
        : locked
          ? 'payment'
          : 'details';

  const refresh = useCallback(async () => {
    try {
      setSession(await getCheckoutSession(session.id, clientSecret));
    } catch {
      // A failed re-read changes nothing; the next one retries.
    }
  }, [session.id, clientSecret]);

  // Expiry: wake at `expires_at`, and let the gateway confirm it.
  useEffect(() => {
    if (session.status !== 'open') return;
    const delay = session.expires_at * 1000 - Date.now();
    if (delay <= 0) return;
    const timer = setTimeout(
      () => {
        setNow(Date.now());
        void refresh();
      },
      Math.min(delay + 250, 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [session.status, session.expires_at, refresh]);

  // While paying, keep asking the gateway how the SESSION stands.
  useEffect(() => {
    if (step !== 'payment') return;
    const interval = session.setup_intent && setupAccepted ? SETUP_POLL_MS : SESSION_POLL_MS;
    const timer = setInterval(() => {
      void refresh();
    }, interval);
    return () => clearInterval(timer);
  }, [step, session.setup_intent, setupAccepted, refresh]);

  // The end, once — and only as the gateway reported it.
  const ended = useRef<Step | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  useEffect(() => {
    if (step !== 'complete' && step !== 'expired') return;
    if (ended.current === step) return;
    ended.current = step;
    if (step === 'expired') {
      onExpired?.(session);
      return;
    }
    if (embedded) {
      onComplete?.(session);
      return;
    }
    onComplete?.(session);
    if (session.success_url) {
      setRedirecting(true);
      redirectTo(session.success_url);
    }
  }, [step, session, embedded, onComplete, onExpired]);

  // Focus follows the step, so a keyboard or screen-reader payer is told.
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const previousStep = useRef(step);
  useEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    headingRef.current?.focus();
  }, [step]);

  const knownFields = useMemo(() => new Set(detailsFieldNames(session)), [session]);
  const errorFor = (param: string): string | null =>
    fieldError?.param === param ? fieldError.message : null;
  const generalError =
    fieldError &&
    (fieldError.param === null ||
      (!knownFields.has(fieldError.param) &&
        fieldError.param !== 'promotion_code' &&
        !fieldError.param.startsWith('line:')))
      ? fieldError.message
      : null;

  async function changeQuantity(lineId: string, quantity: number) {
    try {
      setSession(
        await updateCheckoutSession(session.id, clientSecret, {
          line_items: [{ id: lineId, quantity }],
        }),
      );
      setFieldError(null);
    } catch (error) {
      const refused = fieldErrorOf(error, t('loadFailed'));
      setFieldError({ param: `line:${lineId}`, message: refused.message });
    }
  }

  async function applyPromotionCode(code: string) {
    try {
      setSession(await updateCheckoutSession(session.id, clientSecret, { promotion_code: code }));
      setFieldError(null);
    } catch (error) {
      const refused = fieldErrorOf(error, t('loadFailed'));
      setFieldError({
        param: refused.param?.startsWith('promotion_code') ? 'promotion_code' : refused.param,
        message: refused.message,
      });
    }
  }

  async function submit() {
    setBusy(true);
    setFieldError(null);
    const { params, customKeys } = paramsFromDraft(draft, session);
    try {
      if (Object.keys(params).length > 0) {
        setSession(await updateCheckoutSession(session.id, clientSecret, params));
      }
      setSession(await confirmCheckoutSession(session.id, clientSecret));
    } catch (error) {
      const refused = fieldErrorOf(error, t('confirmFailed'));
      // A custom field refused by its position in the request is shown at its key.
      const indexed = refused.param ? /^custom_fields\.(\d+)/.exec(refused.param) : null;
      const key = indexed?.[1] !== undefined ? customKeys[Number(indexed[1])] : undefined;
      setFieldError(key ? { param: `custom_fields.${key}`, message: refused.message } : refused);
    } finally {
      setBusy(false);
    }
  }

  const label = submitLabel(session, t, locale);
  const appearance = providerAppearance(session.branding, appearanceOverride);
  const taxFailed = session.automatic_tax.enabled && session.automatic_tax.status === 'failed';
  const cancelLink = session.cancel_url ? (
    <a className="back-link" href={session.cancel_url} target={embedded ? '_top' : undefined}>
      ← {t('backTo', { merchant: session.merchant.name })}
    </a>
  ) : null;

  return (
    <div
      className={`checkout-shell${embedded ? ' checkout-shell--embedded' : ''}`}
      style={brandingStyle(session.branding, appearanceOverride)}
      data-font={session.branding.font}
      data-border-style={session.branding.border_style}
    >
      {!embedded && (step === 'details' || step === 'expired') && cancelLink}
      <BrandHeader
        merchant={session.merchant}
        branding={session.branding}
        livemode={session.livemode}
      />

      {step === 'complete' ? (
        <section className="checkout-result" aria-live="polite">
          <h1 ref={headingRef} tabIndex={-1} className="checkout-result__title">
            {redirecting ? t('redirecting') : t('sessionCompleteTitle')}
          </h1>
          {!redirecting && (
            <>
              <p>
                {session.mode === 'setup'
                  ? t('sessionCompleteSetup')
                  : session.payment_status === 'unpaid'
                    ? t('sessionCompleteUnpaid')
                    : t('sessionCompletePaid')}
              </p>
              {session.confirmation_message && (
                <p className="checkout-result__message">{session.confirmation_message}</p>
              )}
            </>
          )}
        </section>
      ) : step === 'expired' ? (
        <section className="checkout-result" role="status">
          <h1 ref={headingRef} tabIndex={-1} className="checkout-result__title">
            {t('sessionExpiredTitle')}
          </h1>
          <p>{t('sessionExpiredBody')}</p>
          {embedded && cancelLink}
        </section>
      ) : (
        <div className="checkout-columns">
          <div className="checkout-columns__summary">
            <OrderSummary
              session={session}
              editable={step === 'details' && !busy}
              errors={
                fieldError?.param
                  ? { [fieldError.param]: fieldError.message }
                  : ({} as Record<string, string>)
              }
              onQuantity={(lineId, quantity) => {
                void changeQuantity(lineId, quantity);
              }}
              onPromotionCode={applyPromotionCode}
            />
          </div>
          <div className="checkout-columns__main">
            {step === 'details' ? (
              <form
                className="checkout-form"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!taxFailed) void submit();
                }}
              >
                <DetailsForm
                  session={session}
                  draft={draft}
                  onChange={setDraft}
                  errorFor={errorFor}
                  disabled={busy}
                />
                {session.automatic_tax.enabled &&
                  session.automatic_tax.status === 'requires_location_inputs' && (
                    <p className="checkout-hint">{t('taxNeedsAddress')}</p>
                  )}
                {taxFailed && (
                  <p className="checkout-error" role="alert">
                    {t('taxFailed')}
                  </p>
                )}
                {generalError && (
                  <p className="checkout-error" role="alert">
                    {generalError}
                  </p>
                )}
                <button type="submit" className="checkout-button" disabled={busy || taxFailed}>
                  {busy ? t('submitting') : label}
                </button>
              </form>
            ) : (
              <section className="checkout-payment" aria-labelledby="payment-heading">
                <h2 id="payment-heading" ref={headingRef} tabIndex={-1} className="section-heading">
                  {t('paymentHeading')}
                </h2>
                {session.setup_intent ? (
                  <SetupPayment
                    setupIntent={session.setup_intent}
                    providerAppearance={appearance}
                    submitLabel={label}
                    onAccepted={() => {
                      setSetupAccepted(true);
                      void refresh();
                    }}
                  />
                ) : session.payment_intent ? (
                  <CheckoutView
                    intent={session.payment_intent}
                    billingQuote={session.billing_quote}
                    providerAppearance={appearance}
                    submitLabel={label}
                    onIntentChange={() => {
                      void refresh();
                    }}
                  />
                ) : null}
              </section>
            )}
          </div>
        </div>
      )}
      <footer className="checkout-footer">{t('poweredBy')}</footer>
    </div>
  );
}
