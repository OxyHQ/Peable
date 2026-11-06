import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { CardFormCountry, CardFormPostcode } from '@oxy.so/bloom/card-form';
import { Loading } from '@oxy.so/bloom/loading';
import {
  emptyCheckoutDraft,
  type CheckoutCard,
  type CheckoutDraft,
  type CheckoutPaymentMethod,
  type CheckoutStep,
} from '@oxy.so/bloom/checkout-sheet/model';
import { Text } from '@oxy.so/bloom/typography';
import type { CheckoutSessionPublic, PaymentIntent } from '@peable.to/shared-types';
import { PeableError } from '../core/errors';
import { createPeableCheckout, type PeableClientAction } from '../browser/payerClient';
import { isMobileUserAgent, payDeepLinkFor } from '../browser/payDeepLink';
import { DEFAULT_CHECKOUT_URL } from '../browser/embedProtocol';
import { PeableCheckoutSheet, type PeableCheckoutSheetProps } from './PeableCheckoutSheet';
import { CheckoutPreparationFields } from './CheckoutPreparationFields';
import { useCheckoutPreparation } from './useCheckoutPreparation';
import type { SheetCheckoutPreparation } from './checkoutPreparation';
import type { PeableMethodDetails } from './PeableMethodContent';
import { PeableProviderFields } from './PeableProviderFields';
import { PeableWalletButtons } from './PeableWalletButtons';
import type { PreparedCardAuthorization, ProviderCardPreparation } from './preparedCard';
import {
  type CheckoutLocale,
  checkoutMessage,
  intlLocale,
  resolveCheckoutLocale,
} from './messages';
import { formatCheckoutAmount, formatFairAmount } from './amount';
import { billingCountries } from './countries';
import {
  baseUnits,
  billingAddressParams,
  faircoinRefusal,
  faircoinTransferState,
  hostedUrlFor,
  intentRequest,
  intentSettlement,
  isFaircoinPayment,
  matchesExpectation,
  needsBillingLocation,
  paymentInFlight,
  sessionCollection,
  sessionFaircoin,
  sessionRequest,
  sessionSettlement,
  shippingDetailsParams,
  type BillingLocation,
  type FaircoinPaymentIntent,
  type SheetCheckoutSource,
  type SheetExpectation,
  type SheetFaircoinAvailability,
  type SheetOrder,
  type SheetOutcome,
  type SheetPresentation,
  type SheetSettlement,
} from './sheetCheckout';

/** How often the sheet re-reads the order while it is open. */
export const SHEET_POLL_MS = 3000;
/** How long the confirmed success is shown before the sheet closes itself. */
const SUCCESS_DISMISS_MS = 1800;

interface SheetCheckoutCommonProps {
  /** Gateway base URL. Default `https://api.peable.to`. */
  gatewayUrl?: string;
  /** Peable's hosted checkout, for the card where secure fields cannot mount. */
  checkoutUrl?: string;
  /**
   * The sheet's language, like Stripe's `locale`: a BCP 47 tag (the host's
   * resolved preference — `pt-BR`, `zh-Hans`, `de`) or `'auto'`, the payer's
   * browser or device. Default `'auto'`. Every string is the SDK's own
   * catalog (`CHECKOUT_UI_LOCALES`); a language it lacks reads English.
   */
  locale?: CheckoutLocale;
  /** Product copy overrides, by `checkoutMessage` key — never a translation of the sheet. */
  messages?: Readonly<Record<string, string>>;
  /**
   * What the payer reviewed — a session's subtotal (before tax and discount), a
   * single payment's amount. An order that is not it is refused with
   * `onUnavailable('mismatch')`.
   */
  expected?: SheetExpectation;
  /** A session's presentation the gateway does not carry (a subscription's cadence). */
  presentation?: SheetPresentation;
  /** A single payment's lines and payee; required for a `payment_intent` source. */
  order?: SheetOrder;
  /** Signed-in payer identity; the SDK never fetches account data itself. */
  accountSummary?: PeableCheckoutSheetProps['accountSummary'];
  /** Where a bank's 3-D Secure redirect returns. Default: this page. */
  returnUrl?: string;
  /**
   * Opens a URL the payer pressed for: the Peable wallet's `peable://pay`
   * request (`wallet`) or Peable's secure page (`hosted`). Default
   * `Linking.openURL`, and on the web the same tab for the wallet request.
   */
  openUrl?(url: string, kind: 'wallet' | 'hosted'): Promise<void> | void;
  /**
   * The GATEWAY ended the order (`complete`: paid, or a FairCoin payment
   * confirming; `expired`). Called once. The host asks its own backend for the
   * outcome and answers with `outcome`; nothing is granted here.
   */
  onSettled(settlement: SheetSettlement): void;
  /** The host backend's answer after settlement. `succeeded` shows success and then closes. */
  outcome?: SheetOutcome;
  /** The order cannot be paid here: unreadable at first read, or not the one reviewed. */
  onUnavailable(reason: 'unreadable' | 'mismatch'): void;
  /** Keep the same controller mounted across dismissal and reopening. Defaults to true. */
  open?: boolean;
  onClose(): void;
}

export type PeableSheetCheckoutProps = SheetCheckoutCommonProps &
  (
    | { source: SheetCheckoutSource; preparation?: never }
    | { preparation: SheetCheckoutPreparation; source?: never }
  );

/** A changed account/cart or payment capability discards every previous private field and callback. */
export function PeableSheetCheckout(props: PeableSheetCheckoutProps) {
  const key = props.preparation
    ? `preparation:${props.preparation.key}`
    : `${props.source.type}:${props.source.id}:${props.source.clientSecret}`;
  return <SheetCheckout key={key} {...props} />;
}

type Order =
  | { readonly type: 'checkout_session'; readonly session: CheckoutSessionPublic }
  | { readonly type: 'payment_intent'; readonly intent: PaymentIntent };

type MethodView = 'faircoin' | 'billing' | 'hosted_card' | 'hosted';

/** A card payment's client action, valid only while that payment is the order's. */
interface CardAction {
  readonly paymentId: string;
  readonly action: PeableClientAction;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Secure card fields mount where there is a DOM; elsewhere the card is paid on Peable's page. */
const canMountCardFields = () => typeof document !== 'undefined';

/** Only a phone can plausibly hold the Peable app that answers a `peable://` request. */
function canOpenPeableHere(): boolean {
  if (Platform.OS !== 'web') return true;
  return typeof navigator !== 'undefined' && isMobileUserAgent(navigator.userAgent ?? '');
}

function defaultOpenUrl(url: string, kind: 'wallet' | 'hosted'): Promise<void> {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    if (kind === 'wallet') window.location.href = url;
    else window.open(url, '_blank', 'noopener');
    return Promise.resolve();
  }
  return Linking.openURL(url).then(() => undefined);
}

/**
 * The Peable payment sheet, driving a real order end to end: the Bloom
 * detached bottom sheet (`PeableCheckoutSheet`) over a Checkout Session or a
 * single PaymentIntent, with the card in Peable's secure fields (or Peable's
 * secure page where those cannot mount) and FairCoin, which an order always
 * lists (ADR 0021) — disabled with its reason in words when it cannot be paid.
 *
 * It asks only for what the order needs: an email when the session has none,
 * a shipping address only when the session collects one, a billing country
 * only when tax or the merchant needs it.
 *
 * Every state is the gateway's answer, re-read every few seconds. Completion
 * is the gateway's (`onSettled`), and the success the payer is shown is the
 * HOST's (`outcome`), which it reads from its own backend — never a closed
 * sheet, a provider callback or a browser returning.
 */
function SheetCheckout({
  source: sourceProp,
  preparation,
  gatewayUrl,
  checkoutUrl = DEFAULT_CHECKOUT_URL,
  locale = 'auto',
  messages,
  expected,
  presentation,
  order: intentOrder,
  accountSummary,
  returnUrl,
  openUrl = defaultOpenUrl,
  onSettled,
  outcome = null,
  onUnavailable,
  onClose,
  open = true,
}: PeableSheetCheckoutProps) {
  const t = useCallback(
    (key: string, values?: Record<string, string | number>) =>
      checkoutMessage(locale, key, values, messages),
    [locale, messages],
  );
  const preparationState = useCheckoutPreparation(preparation, t('error.connection'));
  const resolvedSource = sourceProp ?? preparationState.prepared?.source;
  const resolvedExpected = preparationState.prepared?.expected ?? expected;
  // The FairCoin request is the Peable wallet's, so the external view says Peable.
  const sheetMessages = useMemo(
    () => ({
      'faircoin.externalHint': checkoutMessage(locale, 'faircoin.peableHint', undefined, messages),
      ...messages,
    }),
    [locale, messages],
  );
  // The capability is the source's identity: a re-rendered object is the same order.
  const sourceType = resolvedSource?.type;
  const sourceId = resolvedSource?.id;
  const sourceSecret = resolvedSource?.clientSecret;
  const source = useMemo<SheetCheckoutSource | null>(
    () =>
      sourceType && sourceId && sourceSecret
        ? { type: sourceType, id: sourceId, clientSecret: sourceSecret }
        : null,
    [sourceType, sourceId, sourceSecret],
  );
  const client = useMemo(
    () => createPeableCheckout(gatewayUrl ? { gatewayUrl } : {}),
    [gatewayUrl],
  );
  const [order, setOrder] = useState<Order | null>(null);
  const [cardAction, setCardAction] = useState<CardAction | null>(null);
  // Where the billing view continues: the FairCoin quote, or the card step.
  const [billingNext, setBillingNext] = useState<'faircoin' | 'card'>('faircoin');
  const [step, setStep] = useState<CheckoutStep>('review');
  const [direction, setDirection] = useState<'forward' | 'backward'>('forward');
  const [methodView, setMethodView] = useState<MethodView | null>(null);
  const [draft, setDraft] = useState<CheckoutDraft>(emptyCheckoutDraft);
  const [billing, setBilling] = useState<BillingLocation>({ country: '', postcode: '' });
  const billingPrefilled = useRef(false);
  useEffect(() => {
    if (billingPrefilled.current || !preparationState.prepared) return;
    billingPrefilled.current = true;
    if (preparation?.request.requiresShipping && preparationState.details.useShippingForBilling) {
      setBilling({
        country: preparationState.details.shipping.country,
        postcode: preparationState.details.shipping.postalCode,
      });
    }
  }, [preparationState.prepared, preparationState.details, preparation?.request.requiresShipping]);
  const [preparedCard, setPreparedCard] = useState<CheckoutCard | null>(null);
  const [cardReady, setCardReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tracked, setTracked] = useState<FaircoinPaymentIntent | null>(null);
  const [now, setNow] = useState(nowSeconds);
  const active = useRef(true);
  const hasReadOrder = useRef(false);
  const inFlight = useRef(false);
  const settled = useRef(false);
  const refused = useRef(false);
  const accepted = useRef(false);
  const declineSeen = useRef<string | null>(null);
  const prepareRef = useRef<(() => Promise<ProviderCardPreparation>) | null>(null);
  const authorizationRef = useRef<PreparedCardAuthorization | null>(null);
  const callbacks = useRef({ onSettled, onUnavailable, onClose });
  callbacks.current = { onSettled, onUnavailable, onClose };
  const latest = useRef({ expected: resolvedExpected, locale, messages });
  latest.current = { expected: resolvedExpected, locale, messages };
  const cardFields = canMountCardFields();

  const go = useCallback((next: CheckoutStep, way: 'forward' | 'backward' = 'forward') => {
    setDirection(way);
    setStep(next);
  }, []);

  const disposeCard = useCallback(() => {
    authorizationRef.current?.dispose();
    authorizationRef.current = null;
    setPreparedCard(null);
  }, []);

  const payment: PaymentIntent | null =
    order?.type === 'checkout_session' ? order.session.payment_intent : (order?.intent ?? null);
  // A replaced payment (the payer chose FairCoin) takes its card authority with it.
  const action =
    cardAction && payment?.rail === 'card' && payment.id === cardAction.paymentId
      ? cardAction.action
      : null;

  /** Take the gateway's answer: refuse a different order, follow the payment, report the end once. */
  const accept = useCallback((next: Order) => {
    if (!active.current || refused.current) return;
    const priced =
      next.type === 'checkout_session'
        ? {
            // The reviewed price: before tax (priced once the payer says where
            // they pay from) and before a promotion code.
            amount: next.session.amount_subtotal,
            currency: next.session.currency,
            livemode: next.session.livemode,
          }
        : {
            amount: next.intent.faircoin?.quote?.amount ?? next.intent.amount,
            currency: next.intent.faircoin?.quote?.currency ?? next.intent.currency,
            livemode: next.intent.livemode,
          };
    if (!matchesExpectation(priced, latest.current.expected)) {
      refused.current = true;
      callbacks.current.onUnavailable('mismatch');
      return;
    }
    setOrder(next);
    if (!hasReadOrder.current) {
      hasReadOrder.current = true;
      setDirection('forward');
      setStep('review');
    }
    setNow(nowSeconds());
    const current = next.type === 'checkout_session' ? next.session.payment_intent : next.intent;
    if (isFaircoinPayment(current)) setTracked(current);
    // A card the provider accepted and the bank then declined returns the
    // payment to `requires_payment_method`: back to the card, once per decline.
    const decline = current?.last_payment_error ? `${current.id}:${current.status}` : null;
    if (
      accepted.current &&
      current?.rail === 'card' &&
      current.status === 'requires_payment_method' &&
      decline &&
      declineSeen.current !== decline &&
      !inFlight.current
    ) {
      declineSeen.current = decline;
      accepted.current = false;
      authorizationRef.current?.dispose();
      authorizationRef.current = null;
      setPreparedCard(null);
      setDirection('backward');
      setStep('card');
      setError(
        checkoutMessage(
          latest.current.locale,
          'error.declined',
          undefined,
          latest.current.messages,
        ),
      );
    }
    const settlement =
      next.type === 'checkout_session'
        ? sessionSettlement(next.session)
        : intentSettlement(next.intent);
    if (settlement && !settled.current) {
      settled.current = true;
      // A FairCoin payment keeps showing its transfer; anything else waits on the host.
      if (!isFaircoinPayment(current) || current.status === 'succeeded') {
        setDirection('forward');
        setStep('processing');
      }
      callbacks.current.onSettled(settlement);
    }
  }, []);

  const read = useCallback(async (): Promise<Order> => {
    if (!source) throw new Error('Checkout session not created');
    if (source.type === 'checkout_session') {
      return {
        type: 'checkout_session',
        session: await client.getCheckoutSession(source.id, source.clientSecret),
      };
    }
    return {
      type: 'payment_intent',
      intent: await client.getPaymentIntent(source.id, source.clientSecret),
    };
  }, [client, source]);

  const refresh = useCallback(async () => {
    accept(await read());
  }, [accept, read]);

  useEffect(() => {
    active.current = true;
    if (!source) return;
    let disposed = false;
    let loaded = false;
    let gaveUp = false;
    const tick = () => {
      read()
        .then((value) => {
          if (disposed) return;
          loaded = true;
          accept(value);
        })
        .catch(() => {
          // The first read decides whether this order can be paid here at all;
          // a later failure keeps the last answer and the next tick retries.
          if (disposed || loaded || gaveUp || refused.current || !active.current) return;
          gaveUp = true;
          refused.current = true;
          callbacks.current.onUnavailable('unreadable');
        });
    };
    tick();
    const poll = setInterval(tick, SHEET_POLL_MS);
    return () => {
      disposed = true;
      active.current = false;
      clearInterval(poll);
      authorizationRef.current?.dispose();
      authorizationRef.current = null;
    };
  }, [source, read, accept]);

  // A single card payment pays with its own client action, fetched once it is known.
  const intentId = order?.type === 'payment_intent' ? order.intent.id : null;
  const intentRail = order?.type === 'payment_intent' ? order.intent.rail : null;
  useEffect(() => {
    if (source?.type !== 'payment_intent' || !intentId || intentRail !== 'card' || !cardFields)
      return;
    let disposed = false;
    client
      .getClientAction(source.id, source.clientSecret)
      .then((next) => {
        if (!disposed && active.current) setCardAction({ paymentId: intentId, action: next });
      })
      .catch(() => {
        // A finished payment has no next step; the poll reports how it ended.
      });
    return () => {
      disposed = true;
    };
  }, [client, source, intentId, intentRail, cardFields]);

  // The success the host confirmed is shown, then the sheet closes itself.
  useEffect(() => {
    if (outcome === 'failed') {
      go('failure');
      return;
    }
    if (outcome !== 'succeeded') return;
    go('success');
    const dismiss = setTimeout(() => {
      if (active.current) callbacks.current.onClose();
    }, SUCCESS_DISMISS_MS);
    return () => clearTimeout(dismiss);
  }, [outcome, go]);

  /** Run one gateway write; its refusal is shown in words, never as a generic state. */
  async function write(task: () => Promise<void>): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await task();
      return true;
    } catch (failure) {
      if (active.current) setError(describe(failure));
      return false;
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  function describe(failure: unknown): string {
    if (failure instanceof PeableError) {
      const reason = faircoinRefusal(failure.code);
      if (reason) return t(`faircoin.unavailable.${reason}`, { merchant: merchantName });
      if (failure.type === 'api_connection_error') return t('error.connection');
      if ((failure.statusCode ?? 0) >= 500) return t('error.unavailable');
      // The gateway's refusal names the field and what it needs.
      if (failure.message) return failure.message;
    }
    return t('error.connection');
  }

  const session = order?.type === 'checkout_session' ? order.session : null;
  const merchantName =
    presentation?.merchant ?? session?.merchant.name ?? intentOrder?.merchant ?? '';

  /** Confirm the session in a method: creates its payment, or replaces an unpaid one. */
  async function confirmSession(method: 'card' | 'faircoin'): Promise<CheckoutSessionPublic> {
    if (source?.type !== 'checkout_session' || !session) throw new Error(t('error.connection'));
    // The language the payer reads the sheet in: a customer checkout creates
    // keeps it, and the order's emails are written in it.
    const next = await client.confirmCheckoutSession(source.id, source.clientSecret, {
      ...(session.payment_method_types.length > 1 ? { payment_method_type: method } : {}),
      locale: resolveCheckoutLocale(locale),
    });
    accept({ type: 'checkout_session', session: next });
    return next;
  }

  /** Record the billing location the order needs, while it can still change (no payment yet). */
  async function recordBilling(location: BillingLocation): Promise<void> {
    if (source?.type !== 'checkout_session' || !session || session.payment_intent) return;
    if (!sessionCollection(session).billingAddress) return;
    const address = billingAddressParams(location);
    const known = session.customer_details.address;
    if (
      known?.country === address.country &&
      (known.postal_code ?? undefined) === address.postal_code
    )
      return;
    const next = await client.updateCheckoutSession(source.id, source.clientSecret, {
      customer_details: { address },
    });
    accept({ type: 'checkout_session', session: next });
  }

  /** The card's authority for a session: billing recorded, the card payment created, its action. */
  async function authorizeSessionCard(location: BillingLocation): Promise<PeableClientAction> {
    if (!session) throw new Error(t('error.connection'));
    if (paymentInFlight(session.payment_intent)) throw new Error(t('faircoin.confirming'));
    await recordBilling(location);
    const current = session.payment_intent?.rail === 'card' ? session.payment_intent : null;
    const card = current ?? (await confirmSession('card')).payment_intent;
    if (card?.rail !== 'card') throw new Error(t('error.connection'));
    const next = await client.getClientAction(card.id, card.client_secret);
    if (active.current) setCardAction({ paymentId: card.id, action: next });
    return next;
  }

  /**
   * The session's card payment, made when the payer opens the card step so the
   * wallets can mount on it (their offer and amount are the payment's). Only
   * over no payment or a card one: an open FairCoin request is replaced when
   * the payer pays by card, never because they looked. A failure is silent —
   * the card's own Continue makes the same call and says why.
   */
  async function prepareSessionCard(location: BillingLocation) {
    if (!session || !cardFields || inFlight.current) return;
    const current = session.payment_intent;
    if (current && current.rail !== 'card') return;
    if (paymentInFlight(current)) return;
    await authorizeSessionCard(location).catch(() => undefined);
  }

  /** The billing location the session holds, for the card fields it binds. */
  function recordedBilling(): BillingLocation | null {
    const address = session?.customer_details.address;
    return address?.country
      ? { country: address.country, postcode: address.postal_code ?? '' }
      : null;
  }

  /** Open the card step: the billing location first when the order prices from it. */
  function openCard() {
    if (!session) {
      go('card');
      return;
    }
    if (sessionCollection(session).billingAddress && !session.payment_intent) {
      const known = recordedBilling();
      if (known) setBilling(known);
      setBillingNext('card');
      setMethodView('billing');
      go('method');
      return;
    }
    go('card');
    void prepareSessionCard(recordedBilling() ?? { country: '', postcode: '' });
  }

  async function continueToCard() {
    const location = billing;
    const done = await write(async () => {
      await recordBilling(location);
    });
    if (!done || !active.current) return;
    setMethodView(null);
    go('card');
    void prepareSessionCard(location);
  }

  async function prepareCard() {
    const prepare = prepareRef.current;
    if (!prepare || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await prepare();
      if (!active.current) {
        if (result.prepared) result.authorization.dispose();
        return;
      }
      if (!result.prepared) {
        setError(result.error);
        return;
      }
      authorizationRef.current?.dispose();
      authorizationRef.current = result.authorization;
      const { brand, last4 } = result.authorization.card;
      setPreparedCard({
        id: 'prepared-card',
        brand: brand.charAt(0).toUpperCase() + brand.slice(1),
        last4,
        saveForLater: false,
      });
      go('confirmation');
    } catch (failure) {
      if (active.current) setError(describe(failure));
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  async function authorizeCard() {
    const authorization = authorizationRef.current;
    if (!authorization || inFlight.current || accepted.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await authorization.confirm();
      if (!active.current) return;
      if (result.accepted) {
        // Accepted is not paid: the gateway's settlement and the host's outcome decide.
        accepted.current = true;
        go('processing');
        void refresh().catch(() => undefined);
      } else setError(result.error);
    } catch (failure) {
      if (active.current) setError(describe(failure));
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  async function chooseFaircoin() {
    setMethodView('faircoin');
    go('method');
    if (order?.type !== 'checkout_session') return;
    const current = order.session.payment_intent;
    if (isFaircoinPayment(current) && faircoinTransferState(current, nowSeconds()) !== 'expired')
      return;
    if (paymentInFlight(current)) {
      setError(t('faircoin.confirming'));
      return;
    }
    if (needsBillingLocation(order.session)) {
      setBillingNext('faircoin');
      setMethodView('billing');
      return;
    }
    setTracked(null);
    await write(async () => {
      await confirmSession('faircoin');
    });
  }

  async function quoteWithBilling() {
    setTracked(null);
    const done = await write(async () => {
      await recordBilling(billing);
      await confirmSession('faircoin');
    });
    if (done) setMethodView('faircoin');
  }

  async function payOnHostedPage(kind: 'hosted_card' | 'hosted') {
    await write(async () => {
      // The hosted page resumes the order's own payment: an unpaid FairCoin
      // one is replaced by a card payment first, so the page opens on the card.
      if (
        kind === 'hosted_card' &&
        session &&
        session.payment_intent?.rail === 'faircoin' &&
        session.payment_intent.status === 'requires_action'
      )
        await confirmSession('card');
      if (!source) return;
      await openUrl(hostedUrlFor(source, checkoutUrl), 'hosted');
    });
    void refresh().catch(() => undefined);
  }

  function openWallet(deepLink: string) {
    Promise.resolve(openUrl(deepLink, 'wallet')).catch(() => {
      if (active.current) setError(t('faircoin.noPeable'));
    });
  }

  if (preparation && !order) {
    const preparing = preparationState.busy || !!preparationState.prepared;
    return (
      <PeableCheckoutSheet
        open={open}
        locale={locale}
        messages={sheetMessages}
        request={preparation.request}
        accountSummary={preparation.accountSummary}
        draft={{
          ...draft,
          email: preparationState.details.email,
          shipping: {
            name: preparationState.details.shipping.name,
            address: preparationState.details.shipping.line1,
            city: preparationState.details.shipping.city,
            postalCode: preparationState.details.shipping.postalCode,
            country: preparationState.details.shipping.country,
          },
        }}
        step={step === 'review' ? 'review' : 'method'}
        direction={direction}
        frameKey="preparation"
        nextStep="method"
        methodTitle={t('preparation.title')}
        interactionBlocked={preparing}
        continueDisabled={preparing}
        brandState={preparing ? 'loading' : undefined}
        methodContent={
          <CheckoutPreparationFields
            preparation={preparation}
            details={preparationState.details}
            disabled={preparationState.locked}
            busy={preparing}
            canContinue={preparationState.canContinue}
            error={preparationState.error}
            locale={locale}
            label={t}
            onChange={preparationState.change}
            onContinue={() => {
              void preparationState.submit();
            }}
          />
        }
        onDraft={() => {}}
        onStep={() => go('method')}
        onBack={() => {
          if (!preparing) go('review', 'backward');
        }}
        onClose={() => {
          if (!preparing) onClose();
        }}
        onAuthorize={() => {}}
        savedCards={[]}
        onCard={() => {}}
      />
    );
  }
  if (!order || !source) return null;

  const collection = session ? sessionCollection(session) : null;
  const unsupported = collection?.unsupported ?? null;
  const cardOffered =
    session !== null
      ? session.payment_method_types.includes('card') && !!session.publishable_key
      : order.type === 'payment_intent' && order.intent.rail === 'card';
  const faircoin: SheetFaircoinAvailability =
    session !== null
      ? sessionFaircoin(session)
      : order.type === 'payment_intent' && order.intent.rail === 'faircoin'
        ? { available: true }
        : { available: false, reason: 'not_offered' };
  const selectable: string[] = unsupported
    ? ['hosted']
    : [
        ...(cardOffered && cardFields ? ['card'] : []),
        ...(cardOffered && !cardFields ? ['card_hosted'] : []),
        ...(faircoin.available ? ['faircoin'] : []),
      ];
  const methods: CheckoutPaymentMethod[] = unsupported
    ? [{ id: 'hosted', label: t('hosted.label'), kind: 'card', detail: t('hosted.detail') }]
    : [
        // Peable's secure page takes the card and the device's wallet.
        ...(cardOffered && !cardFields
          ? [
              {
                id: 'card_hosted',
                label: t('method.card'),
                kind: 'card' as const,
                detail: t('card.hosted.detail'),
              },
            ]
          : []),
        // FairCoin is always listed (ADR 0021); unavailable, it says why.
        {
          id: 'faircoin',
          label: t('method.faircoin'),
          kind: 'wallet' as const,
          detail: faircoin.available
            ? t('faircoin.available')
            : t(`faircoin.unavailable.${faircoin.reason}`, { merchant: merchantName }),
          disabled: !faircoin.available,
        },
      ];
  const request =
    session !== null
      ? sessionRequest(session, selectable, presentation)
      : intentRequest(
          (order as Extract<Order, { type: 'payment_intent' }>).intent,
          intentOrder ?? { merchant: '', items: [] },
          selectable,
        );

  const faircoinPayment = (() => {
    if (!tracked) return null;
    const live = payment?.id === tracked.id && isFaircoinPayment(payment) ? payment : null;
    return { intent: live ?? tracked, state: live ? faircoinTransferState(live, now) : 'expired' };
  })();

  const methodDetails: PeableMethodDetails | undefined =
    step === 'method' &&
    methodView === 'faircoin' &&
    faircoinPayment &&
    faircoinPayment.state !== 'expired' &&
    !error
      ? (() => {
          const { intent, state } = faircoinPayment;
          const quote = intent.faircoin.quote;
          const deepLink = payDeepLinkFor(intent);
          return {
            kind: 'faircoin',
            amountLabel: formatFairAmount(intent.amount, locale),
            quoteDescription: quote
              ? `${t('faircoin.quote', {
                  amount: formatCheckoutAmount(
                    baseUnits(quote.amount) ?? 0,
                    quote.currency,
                    locale,
                  ),
                  rate: quote.rate,
                  currency: quote.currency,
                })} ${t('faircoin.holdsUntil', {
                  time: new Intl.DateTimeFormat(intlLocale(locale), {
                    timeStyle: 'short',
                  }).format(new Date(quote.expires_at * 1000)),
                })}`
              : '',
            view: 'external',
            external: {
              // On a phone Continue opens Peable; elsewhere the QR carries the
              // same request to Peable on the payer's phone.
              state: state === 'awaiting' && canOpenPeableHere() ? undefined : state,
              payload: deepLink,
              addressLabel: t('faircoin.peableOnly'),
              onOpen: () => openWallet(deepLink),
              onSelect: () => openWallet(deepLink),
            },
          } satisfies PeableMethodDetails;
        })()
      : undefined;

  const otherMethod = (
    <Button
      size="lg"
      appearance="outline"
      onPress={() => {
        setError(null);
        setMethodView(null);
        go('payment', 'backward');
      }}
    >
      {t('faircoin.otherMethod')}
    </Button>
  );

  const methodContent = (() => {
    if (step !== 'method' || methodDetails) return undefined;
    if (methodView === 'billing')
      return (
        <View style={{ gap: 12 }}>
          <Text>{t('billing.hint')}</Text>
          <CardFormCountry
            label={t('provider.card.country')}
            value={billing.country}
            onValueChange={(country) => setBilling((value) => ({ ...value, country }))}
            countries={billingCountries(locale)}
            disabled={busy}
            required
          />
          <CardFormPostcode
            label={t('provider.card.postcode')}
            value={billing.postcode}
            onValueChange={(postcode) => setBilling((value) => ({ ...value, postcode }))}
            disabled={busy}
          />
          {error && <Text accessibilityRole="alert">{error}</Text>}
          <Button
            size="lg"
            disabled={
              busy || !billing.country || (billingNext === 'card' && !billing.postcode.trim())
            }
            onPress={() => {
              void (billingNext === 'card' ? continueToCard() : quoteWithBilling());
            }}
          >
            {t('continue')}
          </Button>
        </View>
      );
    if (methodView === 'hosted_card' || methodView === 'hosted')
      return (
        <View style={{ gap: 12 }}>
          <Text>
            {t(methodView === 'hosted' ? 'hosted.description' : 'card.hosted.description')}
          </Text>
          {error && <Text accessibilityRole="alert">{error}</Text>}
          <Button
            size="lg"
            disabled={busy}
            onPress={() => {
              void payOnHostedPage(methodView);
            }}
          >
            {t('card.hosted.action')}
          </Button>
        </View>
      );
    if (methodView === 'faircoin' && faircoinPayment?.state === 'expired' && !error)
      return (
        <View style={{ gap: 12 }}>
          <Text accessibilityLiveRegion="polite">{t('faircoin.transfer.expired')}</Text>
          <Button
            size="lg"
            disabled={busy || !faircoin.available}
            onPress={() => {
              void chooseFaircoin();
            }}
          >
            {t('faircoin.newPrice')}
          </Button>
          {otherMethod}
        </View>
      );
    if (error)
      return (
        <View style={{ gap: 12 }}>
          <Text accessibilityRole="alert">{error}</Text>
          {otherMethod}
        </View>
      );
    return <Loading accessibilityLabel={t('provider.loading')} />;
  })();

  const sheetReturnUrl =
    returnUrl ?? (typeof window === 'undefined' ? '' : (window.location?.href ?? ''));
  // A session that prices from the billing location took it before the card step.
  const boundBilling = collection?.billingAddress ? recordedBilling() : null;
  const cardEntry =
    cardOffered && cardFields ? (
      <>
        {action && (
          <PeableWalletButtons
            action={action}
            locale={locale}
            messages={messages}
            returnUrl={sheetReturnUrl}
            onAccepted={() => {
              // Accepted is not paid: the gateway's settlement and the host's outcome decide.
              accepted.current = true;
              disposeCard();
              setError(null);
              go('processing');
              void refresh().catch(() => undefined);
            }}
            onError={setError}
          />
        )}
        <PeableProviderFields
          action={action ?? undefined}
          cardConfiguration={
            session?.publishable_key ? { publishableKey: session.publishable_key } : undefined
          }
          authorize={session ? authorizeSessionCard : undefined}
          {...(boundBilling ? { billingDetails: boundBilling } : {})}
          requirePostalCode={collection?.billingAddress ?? false}
          disabled={busy}
          locale={locale}
          returnUrl={sheetReturnUrl}
          onReady={(callback) => {
            prepareRef.current = callback;
            setCardReady(!!callback);
          }}
          onError={setError}
        />
        {error && <Text accessibilityRole="alert">{error}</Text>}
        <Button
          size="lg"
          disabled={!cardReady || busy}
          onPress={() => {
            void prepareCard();
          }}
        >
          {busy ? t('provider.loading') : t('continue')}
        </Button>
      </>
    ) : undefined;

  return (
    <PeableCheckoutSheet
      open={open}
      locale={locale}
      messages={sheetMessages}
      accountSummary={accountSummary ?? preparation?.accountSummary}
      interactionBlocked={busy}
      brandState={busy ? 'loading' : undefined}
      request={request}
      paymentMethods={methods}
      draft={{ ...draft, card: preparedCard }}
      step={step}
      direction={direction}
      nextStep={preparedCard ? 'confirmation' : undefined}
      frameKey={
        methodDetails?.kind === 'faircoin'
          ? (methodDetails.external?.state ?? 'awaiting')
          : `${methodView ?? ''}:${error ? 'error' : ''}`
      }
      methodTitle={
        methodView === 'faircoin'
          ? t('faircoin.title')
          : methodView === 'billing'
            ? t('billing.title')
            : methodView === 'hosted'
              ? t('hosted.label')
              : t('card.hosted.title')
      }
      methodContent={methodContent}
      methodDetails={methodDetails}
      notice={step === 'confirmation' && error ? error : undefined}
      onMethod={(id) => {
        if (inFlight.current) return;
        setError(null);
        if (id === 'faircoin') void chooseFaircoin();
        else if (id === 'card_hosted' || id === 'hosted') {
          setMethodView(id === 'hosted' ? 'hosted' : 'hosted_card');
          go('method');
        }
      }}
      onDraft={setDraft}
      onContinue={(next) => {
        setDraft(next);
        if (source?.type !== 'checkout_session') {
          go('review', 'backward');
          return;
        }
        void write(async () => {
          const shipping = step === 'shipping' ? shippingDetailsParams(next.shipping) : null;
          const updated = await client.updateCheckoutSession(source.id, source.clientSecret, {
            ...(step === 'contact' ? { customer_details: { email: next.email.trim() } } : {}),
            ...(shipping ? { shipping_details: shipping } : {}),
          });
          accept({ type: 'checkout_session', session: updated });
          // The order has no delivery choice of its own; the gateway priced it.
          if (step === 'shipping') setDraft({ ...next, delivery: 'standard' });
          go('review', 'backward');
        });
      }}
      onStep={(next) => {
        if (inFlight.current || accepted.current) return;
        if (next === 'card' || next === 'payment') disposeCard();
        setError(null);
        if (next === 'card') openCard();
        else go(next);
      }}
      onBack={() => {
        if (inFlight.current || accepted.current) return;
        setError(null);
        if (step === 'confirmation') {
          disposeCard();
          go('card', 'backward');
        } else if (step === 'method' || step === 'card') {
          setMethodView(null);
          go('payment', 'backward');
        } else go('review', 'backward');
      }}
      onClose={() => {
        if (inFlight.current || step === 'processing') return;
        disposeCard();
        onClose();
      }}
      onAuthorize={() => {
        void authorizeCard();
      }}
      onCard={() => {}}
      savedCards={[]}
      cardEntry={cardEntry}
    />
  );
}
