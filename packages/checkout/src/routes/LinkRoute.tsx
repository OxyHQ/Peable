import { DisplayCurrency } from '../components/DisplayCurrency';
import { decimalContributionAmount, formatContributionAmount } from '@peable.to/contracts';
import { beginContribution, getContributionOperation } from '../lib/contributionSession';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { PaymentIntent, PublicPaymentLink } from '@peable.to/shared-types';
import { formatFair } from '@fairco.in/core';
import { gatewayGet, gatewayPost } from '../lib/gatewayFetch';
import { getReusableIntentForLink, rememberIntentForLink } from '../lib/linkSession';
import type { LoadState } from '../lib/loadState';
import { CheckoutView } from '../components/CheckoutView';
import { MerchantIdentity } from '../components/MerchantIdentity';

type PayState = { status: 'idle' } | LoadState<PaymentIntent>;

// `/l/:linkId` — a reusable, merchant-shared payment page (spec §6). Shows
// the link's amount/merchant first; minting (or reusing an open) a
// PaymentIntent only happens once the payer confirms, so a page view/bot
// crawl never mints one on its own.
export function LinkRoute() {
  const { linkId } = useParams<{ linkId: string }>();
  const [linkState, setLinkState] = useState<LoadState<PublicPaymentLink>>({ status: 'loading' });
  const requestGeneration = useRef(0);
  const [resolvedLinkId, setResolvedLinkId] = useState<string>();
  const [amount, setAmount] = useState('5.00');
  const [locked, setLocked] = useState(false);
  const [payState, setPayState] = useState<PayState>({ status: 'idle' });

  useEffect(() => {
    requestGeneration.current++;
    setPayState({ status: 'idle' });
    setLocked(false);
    setAmount('5.00');
    setLinkState({ status: 'loading' });
    if (!linkId) {
      setLinkState({ status: 'error', message: 'Missing payment link id.' });
      return;
    }
    let cancelled = false;
    gatewayGet<PublicPaymentLink>(`/v1/payment_links/${linkId}/public`)
      .then((link) => {
        if (!cancelled) {
          setResolvedLinkId(linkId);
          setLinkState({ status: 'ready', data: link });
          if (link.contribution) {
            const operation = getContributionOperation(linkId);
            if (operation) {
              setAmount(formatContributionAmount(operation.amount));
              setLocked(true);
            }
          }
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'Failed to load payment link.';
        setLinkState({ status: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [linkId]);

  async function handlePay() {
    if (!linkId || linkState.status !== 'ready') return;
    const generation = requestGeneration.current;
    setPayState({ status: 'loading' });
    try {
      if (linkState.data.contribution) {
        const requested =
          linkState.data.contribution.amountMode === 'fixed'
            ? linkState.data.amount
            : decimalContributionAmount(amount);
        const operation = beginContribution(linkId, requested);
        setLocked(true);
        const minted = await gatewayPost<PaymentIntent>(
          `/v1/payment_links/${linkId}/payment_intent`,
          { amount: operation.amount },
          operation.key,
        );
        if (generation === requestGeneration.current)
          setPayState({ status: 'ready', data: minted });
        return;
      }
      const reused = await getReusableIntentForLink(linkId);
      if (reused) {
        if (generation === requestGeneration.current)
          setPayState({ status: 'ready', data: reused });
        return;
      }
      const minted = await gatewayPost<PaymentIntent>(`/v1/payment_links/${linkId}/payment_intent`);
      rememberIntentForLink(linkId, { id: minted.id, clientSecret: minted.clientSecret });
      if (generation === requestGeneration.current) setPayState({ status: 'ready', data: minted });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start payment.';
      if (generation === requestGeneration.current) setPayState({ status: 'error', message });
    }
  }

  if (
    linkState.status === 'loading' ||
    (linkState.status === 'ready' && resolvedLinkId !== linkId)
  ) {
    return (
      <main className="checkout-page">
        <p className="checkout-page__pending">Loading payment link {linkId}…</p>
      </main>
    );
  }
  if (linkState.status === 'error') {
    return (
      <main className="checkout-page">
        <p className="checkout-page__pending">{linkState.message}</p>
      </main>
    );
  }

  const link = linkState.data;
  if (!link.active && !locked) {
    return (
      <main className="checkout-page">
        <p className="checkout-page__pending">This payment link is no longer active.</p>
      </main>
    );
  }
  if (payState.status === 'ready') {
    return (
      <main className="checkout-page">
        <CheckoutView intent={payState.data} merchant={link.merchant} />
      </main>
    );
  }

  return (
    <main className="checkout-page">
      <MerchantIdentity merchant={link.merchant} />
      {link.contribution && <p>{link.contribution.purpose}</p>}
      {link.contribution?.amountMode === 'free' ? (
        <label>
          Contribution amount ({link.currency})
          <input
            aria-label="Contribution amount"
            inputMode="decimal"
            value={amount}
            disabled={locked || payState.status === 'loading'}
            onChange={(event) => setAmount(event.target.value)}
          />
          <small>Up to eight decimals. One-time contribution.</small>
        </label>
      ) : (
        <p className="checkout-page__pending">
          {link.currency === 'FAIR'
            ? formatFair(BigInt(link.amount))
            : (Number(link.amount) / 100).toFixed(2)}{' '}
          {link.currency}
        </p>
      )}
      {link.currency === 'FAIR' && link.contribution?.amountMode !== 'free' && (
        <DisplayCurrency amount={link.amount} />
      )}
      {locked && (
        <p>Continuing the same contribution. Retrying does not create a second payment.</p>
      )}
      {payState.status === 'error' && <p className="checkout-page__pending">{payState.message}</p>}
      <button
        type="button"
        onClick={() => void handlePay()}
        disabled={payState.status === 'loading'}
      >
        {payState.status === 'loading'
          ? 'Starting…'
          : link.contribution
            ? 'Contribute once'
            : 'Pay'}
      </button>
    </main>
  );
}
