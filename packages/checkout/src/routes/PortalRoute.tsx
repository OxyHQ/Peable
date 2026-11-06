import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { PortalCustomerUpdate, PublicPortalSession } from '@peable.to/shared-types';
import { PortalPaymentMethod } from '../components/PortalPaymentMethod';
import { GatewayError, getPortal, portalAction, type PortalAction } from '../lib/billingClient';
import {
  browserLanguages,
  I18nProvider,
  type MessageKey,
  queryLocale,
  resolveLocale,
  type Translate,
  useI18n,
} from '../i18n';
import { INVOICE_STATUS_LABEL, intervalLabel } from '../lib/billingLabels';
import type { LoadState } from '../lib/loadState';
import { formatBillingAmount, formatDate } from '../lib/money';

// `/portal/:token` — the customer portal (ADR 0018 §9). The merchant's server
// minted this URL for ONE customer and it works for an hour; every action is
// answered by the gateway with the session as it now stands, so the page
// never shows a state it inferred. What it offers is the merchant's portal
// configuration (`features`), nothing more.

const FIELD_LABEL: Record<PortalCustomerUpdate, MessageKey> = {
  email: 'email',
  name: 'name',
  phone: 'phone',
  address: 'address',
};

/** ` / month` after a price, in the page's language; nothing for no interval. */
function perInterval(t: Translate, interval: string | null): string {
  if (!interval) return '';
  const key = intervalLabel(interval);
  return ` / ${key ? t(key) : interval}`;
}

/**
 * The portal speaks the customer's language: `?locale=` when the merchant's
 * link names one, else the browser's.
 */
export function PortalRoute() {
  const locale = resolveLocale({ override: queryLocale(), browser: browserLanguages() });
  return (
    <I18nProvider locale={locale}>
      <PortalPage />
    </I18nProvider>
  );
}

function PortalPage() {
  const { t } = useI18n();
  const expired = t('billingExpired');
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<LoadState<PublicPortalSession>>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingCard, setEditingCard] = useState(false);
  const [editingDetails, setEditingDetails] = useState(false);

  useEffect(() => {
    if (!token) {
      setState({ status: 'error', message: expired });
      return;
    }
    let cancelled = false;
    getPortal(token)
      .then((session) => {
        if (!cancelled) setState({ status: 'ready', data: session });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          message:
            cause instanceof GatewayError && cause.status === 404
              ? expired
              : t('billingLoadFailed'),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [token, expired, t]);

  async function act(action: PortalAction, body: Record<string, unknown>): Promise<void> {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const session = await portalAction(token, action, body);
      setState({ status: 'ready', data: session });
      setEditingDetails(false);
    } catch (cause) {
      if (cause instanceof GatewayError && cause.status === 404) {
        setState({ status: 'error', message: expired });
      } else {
        setError(cause instanceof Error ? cause.message : t('billingActionFailed'));
      }
    } finally {
      setBusy(false);
    }
  }

  if (state.status === 'loading') {
    return (
      <main className="checkout-page">
        <p className="checkout-page__pending">{t('loadingBilling')}</p>
      </main>
    );
  }
  if (state.status === 'error' || !token) {
    return (
      <main className="checkout-page">
        <p className="checkout-page__pending">
          {state.status === 'error' ? state.message : expired}
        </p>
      </main>
    );
  }

  const session = state.data;
  const { features } = session;
  const method = session.customer.default_payment_method;

  return (
    <main className="checkout-page portal">
      <header className="portal__header">
        <h1>{session.merchant.name ?? t('billingTitle')}</h1>
        {session.business_profile.headline ? <p>{session.business_profile.headline}</p> : null}
        {session.return_url ? <a href={session.return_url}>{t('returnToSite')}</a> : null}
      </header>

      {error ? (
        <p className="card-payment__error" role="alert">
          {error}
        </p>
      ) : null}

      <section className="portal__section">
        <h2>{t('subscriptions')}</h2>
        {session.subscriptions.length === 0 ? <p>{t('noSubscriptions')}</p> : null}
        {session.subscriptions.map((subscription) => (
          <article
            key={subscription.id}
            className="portal__subscription"
            data-testid={`subscription-${subscription.id}`}
          >
            {subscription.items.map((item) => (
              <p key={item.id}>
                <strong>{item.product_name}</strong>
                {item.quantity > 1 ? ` × ${item.quantity}` : ''}
                {item.unit_amount !== null
                  ? ` · ${formatBillingAmount(item.unit_amount, subscription.currency)}${perInterval(t, item.interval)}`
                  : ''}
              </p>
            ))}
            <p>
              {subscription.status === 'trialing' && subscription.trial_end
                ? t('trialEnds', { date: formatDate(subscription.trial_end) })
                : subscription.cancel_at_period_end
                  ? t('cancelsOn', { date: formatDate(subscription.current_period_end) })
                  : subscription.cancel_at
                    ? t('cancelsOn', { date: formatDate(subscription.cancel_at) })
                    : t('renewsOn', { date: formatDate(subscription.current_period_end) })}
            </p>
            {features.subscription_cancel.enabled && !subscription.cancel_at_period_end ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act('cancel', { subscription: subscription.id })}
              >
                {features.subscription_cancel.mode === 'immediately'
                  ? t('cancelNow')
                  : t('cancelSubscription')}
              </button>
            ) : null}
            {features.subscription_cancel.enabled && subscription.cancel_at_period_end ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act('renew', { subscription: subscription.id })}
              >
                {t('keepSubscription')}
              </button>
            ) : null}
            {features.subscription_update.enabled &&
            subscription.items.length === 1 &&
            session.plans.length > 0 ? (
              <div className="portal__plans">
                {session.plans.flatMap((plan) =>
                  plan.prices
                    .filter(
                      (price) =>
                        price.id !== subscription.items[0]?.price &&
                        price.currency === subscription.currency,
                    )
                    .map((price) => (
                      <button
                        key={price.id}
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void act('change_plan', {
                            subscription: subscription.id,
                            price: price.id,
                          })
                        }
                      >
                        {t('switchTo', { plan: plan.product_name })}
                        {price.unit_amount !== null
                          ? ` · ${formatBillingAmount(price.unit_amount, price.currency)}`
                          : ''}
                        {perInterval(t, price.interval)}
                      </button>
                    )),
                )}
              </div>
            ) : null}
          </article>
        ))}
      </section>

      {features.payment_method_update.enabled ? (
        <section className="portal__section">
          <h2>{t('paymentMethod')}</h2>
          <p data-testid="payment-method">
            {method?.card
              ? t('cardOnFile', {
                  brand: method.card.brand,
                  last4: method.card.last4,
                  month: method.card.exp_month,
                  year: method.card.exp_year,
                })
              : t('noCardOnFile')}
          </p>
          {editingCard ? (
            <PortalPaymentMethod
              token={token}
              onUpdated={(updated) => {
                setState({ status: 'ready', data: updated });
                setEditingCard(false);
              }}
              onCancel={() => setEditingCard(false)}
            />
          ) : (
            <button type="button" onClick={() => setEditingCard(true)}>
              {method ? t('updateCard') : t('addCard')}
            </button>
          )}
        </section>
      ) : null}

      {features.customer_update.enabled ? (
        <section className="portal__section">
          <h2>{t('billingDetails')}</h2>
          {editingDetails ? (
            <DetailsForm
              session={session}
              allowed={features.customer_update.allowed_updates}
              busy={busy}
              onSave={(body) => void act('customer', body)}
              onCancel={() => setEditingDetails(false)}
            />
          ) : (
            <>
              <p>{session.customer.name ?? ''}</p>
              <p>{session.customer.email ?? ''}</p>
              {session.customer.address ? (
                <p>
                  {[
                    session.customer.address.line1,
                    session.customer.address.city,
                    session.customer.address.postal_code,
                    session.customer.address.country,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </p>
              ) : null}
              <button type="button" onClick={() => setEditingDetails(true)}>
                {t('editBillingDetails')}
              </button>
            </>
          )}
        </section>
      ) : null}

      {features.invoice_history.enabled ? (
        <section className="portal__section">
          <h2>{t('invoices')}</h2>
          {session.invoices.length === 0 ? <p>{t('noInvoices')}</p> : null}
          <ul className="portal__invoices">
            {session.invoices.map((invoice) => (
              <li key={invoice.id}>
                {formatDate(invoice.created)} · {invoice.number ?? ''} ·{' '}
                {formatBillingAmount(invoice.total, invoice.currency)} ·{' '}
                {t(INVOICE_STATUS_LABEL[invoice.status])}
                {invoice.hosted_invoice_url ? (
                  <>
                    {' · '}
                    <a href={invoice.hosted_invoice_url}>{t('viewInvoice')}</a>
                  </>
                ) : null}
                {invoice.invoice_pdf ? (
                  <>
                    {' · '}
                    <a href={invoice.invoice_pdf} target="_blank" rel="noreferrer">
                      PDF
                    </a>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="portal__footer">
        {session.business_profile.privacy_policy_url ? (
          <a href={session.business_profile.privacy_policy_url}>{t('privacy')}</a>
        ) : null}
        {session.business_profile.terms_of_service_url ? (
          <a href={session.business_profile.terms_of_service_url}>{t('terms')}</a>
        ) : null}
      </footer>
    </main>
  );
}

function DetailsForm({
  session,
  allowed,
  busy,
  onSave,
  onCancel,
}: {
  session: PublicPortalSession;
  allowed: PortalCustomerUpdate[];
  busy: boolean;
  onSave: (body: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState(session.customer.email ?? '');
  const [name, setName] = useState(session.customer.name ?? '');
  const [phone, setPhone] = useState(session.customer.phone ?? '');
  const [line1, setLine1] = useState(session.customer.address?.line1 ?? '');
  const [city, setCity] = useState(session.customer.address?.city ?? '');
  const [postalCode, setPostalCode] = useState(session.customer.address?.postal_code ?? '');
  const [country, setCountry] = useState(session.customer.address?.country ?? '');

  function submit(): void {
    const body: Record<string, unknown> = {};
    if (allowed.includes('email') && email) body.email = email;
    if (allowed.includes('name') && name) body.name = name;
    if (allowed.includes('phone') && phone) body.phone = phone;
    if (allowed.includes('address') && country) {
      body.address = {
        country: country.toUpperCase(),
        ...(line1 ? { line1 } : {}),
        ...(city ? { city } : {}),
        ...(postalCode ? { postal_code: postalCode } : {}),
      };
    }
    onSave(body);
  }

  const field = (label: string, value: string, set: (value: string) => void) => (
    <label className="portal__field">
      {label}
      <input value={value} onChange={(event) => set(event.target.value)} />
    </label>
  );

  return (
    <form
      className="portal__form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {allowed.includes('name') ? field(t(FIELD_LABEL.name), name, setName) : null}
      {allowed.includes('email') ? field(t(FIELD_LABEL.email), email, setEmail) : null}
      {allowed.includes('phone') ? field(t(FIELD_LABEL.phone), phone, setPhone) : null}
      {allowed.includes('address') ? (
        <>
          {field(t(FIELD_LABEL.address), line1, setLine1)}
          {field(t('city'), city, setCity)}
          {field(t('postalCode'), postalCode, setPostalCode)}
          {field(t('country'), country, setCountry)}
        </>
      ) : null}
      <button type="submit" disabled={busy}>
        {t('save')}
      </button>
      <button type="button" onClick={onCancel}>
        {t('cancel')}
      </button>
    </form>
  );
}
