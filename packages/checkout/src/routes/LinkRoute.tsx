import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  decimalContributionAmount,
  formatContributionAmount,
} from '@peable.to/contracts/contributions';
import type { PublicPaymentLink } from '@peable.to/shared-types';
import { BrandHeader } from '../components/BrandHeader';
import { DisplayCurrency } from '../components/DisplayCurrency';
import { browserLanguages, I18nProvider, queryLocale, resolveLocale, useI18n } from '../i18n';
import { brandingStyle } from '../lib/branding';
import { beginContribution, getContributionOperation } from '../lib/contributionSession';
import { reusableSessionForLink, rememberSession } from '../lib/linkSession';
import type { LoadState } from '../lib/loadState';
import { formatAmount } from '../lib/money';
import { getPaymentLink, startPaymentLinkSession } from '../lib/sessionClient';

type StartState =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'error'; message: string };

/**
 * `/l/:linkId` — a payment link. Visiting one starts a CHECKOUT SESSION
 * (Stripe's model): the session holds the link's line items and options, and
 * its payment is created only when the payer confirms it — so starting a
 * session reserves no FairCoin address and a crawler's visit mints nothing.
 *
 * A price link starts its session straight away (reusing the one this tab
 * already has open). A contribution link waits for the payer: a free one needs
 * their amount, and every contribution carries an operation key written BEFORE
 * the request, so a retry after a lost answer is the same contribution, never
 * a second one.
 */
function LinkPage({ link, linkId }: { link: PublicPaymentLink; linkId: string }) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const [start, setStart] = useState<StartState>({ status: 'idle' });
  const stored = link.contribution ? getContributionOperation(linkId) : null;
  const [amount, setAmount] = useState(stored ? formatContributionAmount(stored.amount) : '5.00');
  const [locked, setLocked] = useState(stored !== null);
  const autoStarted = useRef(false);

  async function begin() {
    setStart({ status: 'starting' });
    try {
      if (link.contribution) {
        const requested =
          link.contribution.amount_mode === 'fixed'
            ? (link.contribution_amount ?? '')
            : decimalContributionAmount(amount);
        const operation = beginContribution(linkId, requested);
        setLocked(true);
        const started = await startPaymentLinkSession(
          linkId,
          link.contribution.amount_mode === 'free' ? { amount: operation.amount } : {},
          operation.key,
        );
        navigate(`/c/${started.id}#cs=${encodeURIComponent(started.client_secret)}`, {
          replace: true,
        });
        return;
      }
      let session = await reusableSessionForLink(linkId);
      if (!session) {
        const started = await startPaymentLinkSession(linkId, {});
        session = { id: started.id, clientSecret: started.client_secret };
        rememberSession(linkId, session);
      }
      navigate(`/c/${session.id}#cs=${encodeURIComponent(session.clientSecret)}`, {
        replace: true,
      });
    } catch (error) {
      setStart({
        status: 'error',
        message: error instanceof Error && error.message ? error.message : t('startFailed'),
      });
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: a price link starts its session once per page view
  useEffect(() => {
    if (link.contribution || !link.active || autoStarted.current) return;
    autoStarted.current = true;
    void begin();
  }, [link]);

  if (!link.active && !locked) {
    return (
      <div className="checkout-shell" style={brandingStyle(link.branding)}>
        <BrandHeader merchant={link.merchant} branding={link.branding} livemode={link.livemode} />
        <p className="checkout-page__pending" role="status">
          {t('linkInactive')}
        </p>
      </div>
    );
  }

  if (!link.contribution) {
    return (
      <div className="checkout-shell" style={brandingStyle(link.branding)}>
        <BrandHeader merchant={link.merchant} branding={link.branding} livemode={link.livemode} />
        {start.status === 'error' ? (
          <>
            <p className="checkout-error" role="alert">
              {start.message}
            </p>
            <button type="button" className="checkout-button" onClick={() => void begin()}>
              {t('continue')}
            </button>
          </>
        ) : (
          <p className="checkout-page__pending" role="status">
            {t('starting')}
          </p>
        )}
      </div>
    );
  }

  const free = link.contribution.amount_mode === 'free';
  return (
    <div className="checkout-shell" style={brandingStyle(link.branding)}>
      <BrandHeader merchant={link.merchant} branding={link.branding} livemode={link.livemode} />
      <form
        className="checkout-form"
        onSubmit={(event) => {
          event.preventDefault();
          void begin();
        }}
      >
        <p className="contribution__purpose">{link.contribution.purpose}</p>
        {free ? (
          <div className="field">
            <label htmlFor="contribution-amount">
              {t('contributionAmount', { currency: link.currency })}
            </label>
            <input
              id="contribution-amount"
              inputMode="decimal"
              value={amount}
              disabled={locked || start.status === 'starting'}
              aria-describedby="contribution-hint"
              onChange={(event) => setAmount(event.target.value)}
            />
            <small id="contribution-hint">{t('contributionHint')}</small>
          </div>
        ) : (
          link.contribution_amount !== null && (
            <>
              <p className="contribution__amount">
                {formatAmount(link.contribution_amount, link.currency, locale)}
              </p>
              {link.currency === 'FAIR' && <DisplayCurrency amount={link.contribution_amount} />}
            </>
          )
        )}
        {locked && <p>{t('contributionContinuing')}</p>}
        {start.status === 'error' && (
          <p className="checkout-error" role="alert">
            {start.message}
          </p>
        )}
        <button type="submit" className="checkout-button" disabled={start.status === 'starting'}>
          {start.status === 'starting' ? t('starting') : t('contribute')}
        </button>
      </form>
    </div>
  );
}

function Status({ messageKey, text }: { messageKey: 'loadingLink' | 'loadFailed'; text?: string }) {
  const { t } = useI18n();
  return (
    <p className="checkout-page__pending" role={messageKey === 'loadFailed' ? 'alert' : 'status'}>
      {text || t(messageKey)}
    </p>
  );
}

export function LinkRoute() {
  const { linkId } = useParams<{ linkId: string }>();
  const [state, setState] = useState<LoadState<PublicPaymentLink>>({ status: 'loading' });
  const [loadedFor, setLoadedFor] = useState<string>();

  useEffect(() => {
    setState({ status: 'loading' });
    if (!linkId) {
      setState({ status: 'error', message: '' });
      return;
    }
    let cancelled = false;
    getPaymentLink(linkId)
      .then((link) => {
        if (cancelled) return;
        setLoadedFor(linkId);
        setState({ status: 'ready', data: link });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', message: error instanceof Error ? error.message : '' });
      });
    return () => {
      cancelled = true;
    };
  }, [linkId]);

  const locale = resolveLocale({
    override: queryLocale(),
    merchant: state.status === 'ready' ? state.data.locale : null,
    browser: browserLanguages(),
  });

  return (
    <I18nProvider locale={locale}>
      <main className="checkout-page">
        {state.status === 'ready' && linkId && loadedFor === linkId ? (
          <LinkPage key={linkId} link={state.data} linkId={linkId} />
        ) : state.status === 'error' ? (
          <Status messageKey="loadFailed" text={state.message} />
        ) : (
          <Status messageKey="loadingLink" />
        )}
      </main>
    </I18nProvider>
  );
}
