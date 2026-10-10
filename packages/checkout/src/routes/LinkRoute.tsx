import { useEffect, useState } from 'react';
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
  const [payState, setPayState] = useState<PayState>({ status: 'idle' });

  useEffect(() => {
    if (!linkId) {
      setLinkState({ status: 'error', message: 'Missing payment link id.' });
      return;
    }
    let cancelled = false;
    gatewayGet<PublicPaymentLink>(`/v1/payment_links/${linkId}/public`)
      .then((link) => {
        if (!cancelled) setLinkState({ status: 'ready', data: link });
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
    if (!linkId) return;
    setPayState({ status: 'loading' });
    try {
      const reused = await getReusableIntentForLink(linkId);
      if (reused) {
        setPayState({ status: 'ready', data: reused });
        return;
      }
      const minted = await gatewayPost<PaymentIntent>(`/v1/payment_links/${linkId}/payment_intent`);
      rememberIntentForLink(linkId, { id: minted.id, clientSecret: minted.clientSecret });
      setPayState({ status: 'ready', data: minted });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start payment.';
      setPayState({ status: 'error', message });
    }
  }

  if (linkState.status === 'loading') {
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
  if (!link.active) {
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
      <p className="checkout-page__pending">{formatFair(BigInt(link.amount))} FAIR</p>
      {payState.status === 'error' && <p className="checkout-page__pending">{payState.message}</p>}
      <button
        type="button"
        onClick={() => void handlePay()}
        disabled={payState.status === 'loading'}
      >
        {payState.status === 'loading' ? 'Starting…' : 'Pay'}
      </button>
    </main>
  );
}
