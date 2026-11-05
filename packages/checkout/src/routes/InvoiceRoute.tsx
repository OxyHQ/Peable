import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { PublicInvoice } from '@peable.to/shared-types';
import { GatewayError, getPublicInvoice, payPublicInvoice } from '../lib/billingClient';
import type { LoadState } from '../lib/loadState';
import { formatBillingAmount, formatDate } from '../lib/money';

// `/invoice/:token` — the hosted invoice page (ADR 0018). The token is the
// payer's bearer credential, in the PATH like a payment link id. Paying hands
// off to the existing payment page for the invoice's PaymentIntent
// (`/i/:id#client_secret=…`): a card through the provider's own fields,
// FairCoin from the payer's wallet. Whether the invoice is PAID is never this
// page's decision — it re-reads the gateway, which hears it from the payment.

const PAYABLE = new Set(['open', 'uncollectible']);

const STATUS_LABEL: Record<PublicInvoice['status'], string> = {
  draft: 'Draft',
  open: 'Due',
  paid: 'Paid',
  void: 'Void',
  uncollectible: 'Past due',
};

export function InvoiceRoute() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState<PublicInvoice>>({ status: 'loading' });
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setState({ status: 'error', message: 'This invoice link is incomplete.' });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    getPublicInvoice(token)
      .then((invoice) => {
        if (!cancelled) setState({ status: 'ready', data: invoice });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          message:
            error instanceof GatewayError && error.status === 404
              ? 'This invoice could not be found. Check the link you were sent.'
              : 'This invoice could not be loaded. Please try again.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function pay(method?: 'card' | 'faircoin'): Promise<void> {
    if (!token) return;
    setPaying(true);
    setPayError(null);
    try {
      const payment = await payPublicInvoice(token, method);
      navigate({
        pathname: `/i/${payment.payment_intent}`,
        hash: `client_secret=${encodeURIComponent(payment.client_secret)}`,
      });
    } catch (error) {
      setPaying(false);
      setPayError(
        error instanceof Error ? error.message : 'This invoice could not be paid right now.',
      );
    }
  }

  if (state.status === 'loading') {
    return (
      <main className="checkout-page">
        <p className="checkout-page__pending">Loading invoice…</p>
      </main>
    );
  }
  if (state.status === 'error') {
    return (
      <main className="checkout-page">
        <p className="checkout-page__pending">{state.message}</p>
      </main>
    );
  }

  const invoice = state.data;
  const money = (amount: string) => formatBillingAmount(amount, invoice.currency);
  return (
    <main className="checkout-page invoice-page">
      <header className="invoice-page__header">
        <h1>{invoice.merchant.name ?? 'Invoice'}</h1>
        <p>
          Invoice {invoice.number ?? ''} ·{' '}
          <span data-testid="invoice-status">{STATUS_LABEL[invoice.status]}</span>
        </p>
        {invoice.livemode ? null : <p className="invoice-page__test">Test mode</p>}
      </header>

      <section className="invoice-page__summary">
        <p className="invoice-page__amount">{money(invoice.amount_remaining)}</p>
        <p>
          {invoice.status === 'paid'
            ? `Paid on ${formatDate(invoice.paid_at)}`
            : invoice.due_date
              ? `Due ${formatDate(invoice.due_date)}`
              : `Issued ${formatDate(invoice.finalized_at ?? invoice.created)}`}
        </p>
        {invoice.customer_name || invoice.customer_email ? (
          <p>Billed to {invoice.customer_name ?? invoice.customer_email}</p>
        ) : null}
        {invoice.description ? <p>{invoice.description}</p> : null}
      </section>

      <table className="invoice-page__lines">
        <thead>
          <tr>
            <th scope="col">Description</th>
            <th scope="col">Qty</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line, index) => (
            // Lines are a fixed, ordered snapshot of a finalized invoice.
            // biome-ignore lint/suspicious/noArrayIndexKey: a frozen invoice's lines never reorder
            <tr key={index}>
              <td>
                {line.description ?? ''}
                {line.proration ? ' (prorated)' : ''}
                <br />
                <small>
                  {formatDate(line.period.start)} – {formatDate(line.period.end)}
                </small>
              </td>
              <td>{line.quantity ?? ''}</td>
              <td>{money(line.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="invoice-page__totals">
        <dt>Subtotal</dt>
        <dd>{money(invoice.subtotal)}</dd>
        {invoice.total_discount !== '0' ? (
          <>
            <dt>Discount</dt>
            <dd>-{money(invoice.total_discount)}</dd>
          </>
        ) : null}
        <dt>Tax</dt>
        <dd>{invoice.tax === null ? '—' : money(invoice.tax)}</dd>
        <dt>Total</dt>
        <dd>{money(invoice.total)}</dd>
        <dt>Amount paid</dt>
        <dd>{money(invoice.amount_paid)}</dd>
        <dt>Amount remaining</dt>
        <dd data-testid="invoice-remaining">{money(invoice.amount_remaining)}</dd>
      </dl>

      {PAYABLE.has(invoice.status) && invoice.amount_remaining !== '0' ? (
        <div className="invoice-page__pay">
          {invoice.payment_method_types.includes('card') ? (
            <button
              type="button"
              className="card-payment__button"
              disabled={paying}
              onClick={() => {
                void pay('card');
              }}
            >
              {paying ? 'Preparing payment…' : `Pay ${money(invoice.amount_remaining)} by card`}
            </button>
          ) : null}
          {/* FairCoin is always offered (ADR 0021): shown with its reason when it cannot be paid. */}
          <button
            type="button"
            className="card-payment__button"
            disabled={paying || !invoice.faircoin.available}
            onClick={() => {
              void pay('faircoin');
            }}
          >
            {paying ? 'Preparing payment…' : 'Pay with FairCoin'}
          </button>
          {invoice.faircoin.available ? null : (
            <p className="checkout-hint">
              {invoice.faircoin.unavailable_reason === 'faircoin_account_missing'
                ? 'This merchant cannot receive FairCoin yet.'
                : 'FairCoin cannot be priced right now. Try again in a moment.'}
            </p>
          )}
        </div>
      ) : null}
      {payError ? (
        <p className="card-payment__error" role="alert">
          {payError}
        </p>
      ) : null}

      <p>
        <a href={invoice.invoice_pdf} target="_blank" rel="noreferrer">
          Download PDF
        </a>
      </p>
    </main>
  );
}
