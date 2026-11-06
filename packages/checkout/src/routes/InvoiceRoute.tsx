import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { PublicInvoice } from '@peable.to/shared-types';
import { GatewayError, getPublicInvoice, payPublicInvoice } from '../lib/billingClient';
import { browserLanguages, I18nProvider, queryLocale, resolveLocale, useI18n } from '../i18n';
import { INVOICE_STATUS_LABEL } from '../lib/billingLabels';
import type { LoadState } from '../lib/loadState';
import { formatBillingAmount, formatDate } from '../lib/money';

// `/invoice/:token` — the hosted invoice page (ADR 0018). The token is the
// payer's bearer credential, in the PATH like a payment link id. Paying hands
// off to the existing payment page for the invoice's PaymentIntent
// (`/i/:id#client_secret=…`): a card through the provider's own fields,
// FairCoin from the payer's wallet. Whether the invoice is PAID is never this
// page's decision — it re-reads the gateway, which hears it from the payment.

const PAYABLE = new Set(['open', 'uncollectible']);

/**
 * The page speaks the payer's language: `?locale=` when the link names one,
 * else the browser's. An invoice names no locale of its own.
 */
export function InvoiceRoute() {
  const locale = resolveLocale({ override: queryLocale(), browser: browserLanguages() });
  return (
    <I18nProvider locale={locale}>
      <InvoicePage />
    </I18nProvider>
  );
}

function InvoicePage() {
  const { t } = useI18n();
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState<PublicInvoice>>({ status: 'loading' });
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setState({ status: 'error', message: t('invoiceLinkIncomplete') });
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
              ? t('invoiceNotFound')
              : t('invoiceLoadFailed'),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [token, t]);

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
      setPayError(error instanceof Error ? error.message : t('invoicePayFailed'));
    }
  }

  if (state.status === 'loading') {
    return (
      <main className="checkout-page">
        <p className="checkout-page__pending">{t('loadingInvoice')}</p>
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
        <h1>{invoice.merchant.name ?? t('invoiceTitle')}</h1>
        <p>
          {t('invoiceNumber', { number: invoice.number ?? '' })} ·{' '}
          <span data-testid="invoice-status">{t(INVOICE_STATUS_LABEL[invoice.status])}</span>
        </p>
        {invoice.livemode ? null : <p className="invoice-page__test">{t('testMode')}</p>}
      </header>

      <section className="invoice-page__summary">
        <p className="invoice-page__amount">{money(invoice.amount_remaining)}</p>
        <p>
          {invoice.status === 'paid'
            ? t('invoicePaidOn', { date: formatDate(invoice.paid_at) })
            : invoice.due_date
              ? t('invoiceDueOn', { date: formatDate(invoice.due_date) })
              : t('invoiceIssuedOn', {
                  date: formatDate(invoice.finalized_at ?? invoice.created),
                })}
        </p>
        {invoice.customer_name || invoice.customer_email ? (
          <p>{t('billedTo', { name: invoice.customer_name ?? invoice.customer_email ?? '' })}</p>
        ) : null}
        {invoice.description ? <p>{invoice.description}</p> : null}
      </section>

      <table className="invoice-page__lines">
        <thead>
          <tr>
            <th scope="col">{t('columnDescription')}</th>
            <th scope="col">{t('columnQuantity')}</th>
            <th scope="col">{t('columnAmount')}</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line, index) => (
            // Lines are a fixed, ordered snapshot of a finalized invoice.
            // biome-ignore lint/suspicious/noArrayIndexKey: a frozen invoice's lines never reorder
            <tr key={index}>
              <td>
                {line.description ?? ''}
                {line.proration ? ` ${t('prorated')}` : ''}
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
        <dt>{t('subtotal')}</dt>
        <dd>{money(invoice.subtotal)}</dd>
        {invoice.total_discount !== '0' ? (
          <>
            <dt>{t('discount')}</dt>
            <dd>-{money(invoice.total_discount)}</dd>
          </>
        ) : null}
        <dt>{t('tax')}</dt>
        <dd>{invoice.tax === null ? '—' : money(invoice.tax)}</dd>
        <dt>{t('invoiceTotal')}</dt>
        <dd>{money(invoice.total)}</dd>
        <dt>{t('amountPaid')}</dt>
        <dd>{money(invoice.amount_paid)}</dd>
        <dt>{t('amountRemaining')}</dt>
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
              {paying
                ? t('preparingPayment')
                : t('payByCardAmount', { amount: money(invoice.amount_remaining) })}
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
            {paying ? t('preparingPayment') : t('payWithFaircoin')}
          </button>
          {invoice.faircoin.available ? null : (
            <p className="checkout-hint">
              {invoice.faircoin.unavailable_reason === 'faircoin_wallet_missing'
                ? t('faircoinUnavailableWallet')
                : invoice.faircoin.unavailable_reason === 'faircoin_network_closed'
                  ? t('faircoinUnavailableNetwork')
                  : invoice.faircoin.unavailable_reason === 'temporarily_unavailable'
                    ? t('faircoinUnavailableTemporary')
                    : t('faircoinUnavailablePriceRetry')}
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
          {t('downloadPdf')}
        </a>
      </p>
    </main>
  );
}
