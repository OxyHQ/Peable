import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { PortalCustomerUpdate, PublicPortalSession } from '@peable.to/shared-types';
import { PortalPaymentMethod } from '../components/PortalPaymentMethod';
import { GatewayError, getPortal, portalAction, type PortalAction } from '../lib/billingClient';
import type { LoadState } from '../lib/loadState';
import { formatBillingAmount, formatDate } from '../lib/money';

// `/portal/:token` — the customer portal (ADR 0018 §9). The merchant's server
// minted this URL for ONE customer and it works for an hour; every action is
// answered by the gateway with the session as it now stands, so the page
// never shows a state it inferred. What it offers is the merchant's portal
// configuration (`features`), nothing more.

const EXPIRED =
  'This billing link has expired. Return to the site you came from to open a new one.';

const FIELD_LABEL: Record<PortalCustomerUpdate, string> = {
  email: 'Email',
  name: 'Name',
  phone: 'Phone',
  address: 'Address',
};

export function PortalRoute() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<LoadState<PublicPortalSession>>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingCard, setEditingCard] = useState(false);
  const [editingDetails, setEditingDetails] = useState(false);

  useEffect(() => {
    if (!token) {
      setState({ status: 'error', message: EXPIRED });
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
              ? EXPIRED
              : 'Your billing details could not be loaded. Please try again.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

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
        setState({ status: 'error', message: EXPIRED });
      } else {
        setError(cause instanceof Error ? cause.message : 'That could not be done right now.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (state.status === 'loading') {
    return (
      <main className="checkout-page">
        <p className="checkout-page__pending">Loading your billing…</p>
      </main>
    );
  }
  if (state.status === 'error' || !token) {
    return (
      <main className="checkout-page">
        <p className="checkout-page__pending">
          {state.status === 'error' ? state.message : EXPIRED}
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
        <h1>{session.merchant.name ?? 'Billing'}</h1>
        {session.business_profile.headline ? <p>{session.business_profile.headline}</p> : null}
        {session.return_url ? <a href={session.return_url}>← Return</a> : null}
      </header>

      {error ? (
        <p className="card-payment__error" role="alert">
          {error}
        </p>
      ) : null}

      <section className="portal__section">
        <h2>Subscriptions</h2>
        {session.subscriptions.length === 0 ? <p>No active subscriptions.</p> : null}
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
                  ? ` · ${formatBillingAmount(item.unit_amount, subscription.currency)}${item.interval ? ` / ${item.interval}` : ''}`
                  : ''}
              </p>
            ))}
            <p>
              {subscription.status === 'trialing' && subscription.trial_end
                ? `Trial ends ${formatDate(subscription.trial_end)}`
                : subscription.cancel_at_period_end
                  ? `Cancels on ${formatDate(subscription.current_period_end)}`
                  : subscription.cancel_at
                    ? `Cancels on ${formatDate(subscription.cancel_at)}`
                    : `Renews on ${formatDate(subscription.current_period_end)}`}
            </p>
            {features.subscription_cancel.enabled && !subscription.cancel_at_period_end ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act('cancel', { subscription: subscription.id })}
              >
                {features.subscription_cancel.mode === 'immediately'
                  ? 'Cancel now'
                  : 'Cancel subscription'}
              </button>
            ) : null}
            {features.subscription_cancel.enabled && subscription.cancel_at_period_end ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act('renew', { subscription: subscription.id })}
              >
                Keep subscription
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
                        Switch to {plan.product_name}
                        {price.unit_amount !== null
                          ? ` · ${formatBillingAmount(price.unit_amount, price.currency)}`
                          : ''}
                        {price.interval ? ` / ${price.interval}` : ''}
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
          <h2>Payment method</h2>
          <p data-testid="payment-method">
            {method?.card
              ? `${method.card.brand} •••• ${method.card.last4} (expires ${method.card.exp_month}/${method.card.exp_year})`
              : 'No card on file.'}
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
              {method ? 'Update card' : 'Add a card'}
            </button>
          )}
        </section>
      ) : null}

      {features.customer_update.enabled ? (
        <section className="portal__section">
          <h2>Billing details</h2>
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
                Edit billing details
              </button>
            </>
          )}
        </section>
      ) : null}

      {features.invoice_history.enabled ? (
        <section className="portal__section">
          <h2>Invoices</h2>
          {session.invoices.length === 0 ? <p>No invoices yet.</p> : null}
          <ul className="portal__invoices">
            {session.invoices.map((invoice) => (
              <li key={invoice.id}>
                {formatDate(invoice.created)} · {invoice.number ?? ''} ·{' '}
                {formatBillingAmount(invoice.total, invoice.currency)} · {invoice.status}
                {invoice.hosted_invoice_url ? (
                  <>
                    {' · '}
                    <a href={invoice.hosted_invoice_url}>View</a>
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
          <a href={session.business_profile.privacy_policy_url}>Privacy</a>
        ) : null}
        {session.business_profile.terms_of_service_url ? (
          <a href={session.business_profile.terms_of_service_url}>Terms</a>
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
      {allowed.includes('name') ? field(FIELD_LABEL.name, name, setName) : null}
      {allowed.includes('email') ? field(FIELD_LABEL.email, email, setEmail) : null}
      {allowed.includes('phone') ? field(FIELD_LABEL.phone, phone, setPhone) : null}
      {allowed.includes('address') ? (
        <>
          {field('Address', line1, setLine1)}
          {field('City', city, setCity)}
          {field('Postal code', postalCode, setPostalCode)}
          {field('Country (2 letters)', country, setCountry)}
        </>
      ) : null}
      <button type="submit" disabled={busy}>
        Save
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
