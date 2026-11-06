/**
 * Approve-pay screen.
 *
 * The payer lands here from an `peable://pay?...` deep link (parsed + validated
 * by {@link parsePaymentRequest} in the root layout, which forwards the fields
 * as route params). It shows the amount, payee address, and network, then:
 *
 *   Decline → navigate away (the Gateway has no payer-facing reject endpoint).
 *   Approve → pay every output (one, or one per payee of a multi-seller
 *             order, Peable ADR 0021 D6) in ONE transaction through the wallet's normal
 *             build/sign/broadcast flow ({@link useWalletStore.sendToRecipients},
 *             which returns the txid) → report the txid to the Gateway
 *             ({@link submitTx}) → subscribe to live status
 *             ({@link subscribeToIntent}) and render `processing` (sent, then
 *             confirming) → `succeeded` — ADR 0019's vocabulary.
 *
 * Once the transaction is broadcast we hold a txid, so no downstream failure
 * (Gateway unreachable, realtime channel unavailable, signed out) is ever
 * surfaced as "payment failed" — the coins are already on-chain and the
 * Gateway's settlement watcher verifies them regardless. Live status needs an
 * authenticated Oxy session (the socket handshake carries the access token); a
 * signed-out payer still pays and is shown a sign-in nudge.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTheme } from '@oxy.so/bloom/theme';
import { formatFair, explorerTxUrl, UNITS_PER_COIN, type NetworkType } from '@fairco.in/core';
import type { PaymentIntent, PaymentIntentStatus } from '@peable.to/shared-types';
import { SafeAreaView } from '../../src/ui/safe-area-view';
import { ScreenHeader, Button } from '../../src/ui/components';
import { FairCoinSymbol } from '../../src/ui/components/FairCoinSymbol';
import { useWalletStore, FEE_RATES } from '../../src/wallet/wallet-store';
import { submitTx } from '../../src/services/gateway-client';
import { paymentRequestFromParams } from '../../src/pay/payment-request';
import { oxyServices } from '../../src/services/oxy-services';
import { subscribeToIntent, type IntentSubscription } from '../../src/services/gateway-socket';
import { getCachedPrice } from '../../src/services/price';
import { hapticSuccess, hapticError } from '../../src/utils/haptics';
import { FONT_PHUDU_BLACK } from '../../src/utils/fonts';
import { t } from '../../src/i18n';

/** Uppercase section label — matches the send/home screens. */
const SECTION_LABEL = 'text-muted-foreground text-xs font-semibold uppercase tracking-wider';

/**
 * Screen phase:
 * - `review`        awaiting the payer's Approve / Decline.
 * - `processing`    wallet is building / signing / broadcasting the tx.
 * - `tracking`      tx broadcast + reported; live status is streaming in.
 * - `sent_no_status` tx broadcast, but no live channel (signed out / socket down).
 * - `error`         the payment failed BEFORE broadcast (no coins left).
 */
type PayPhase = 'review' | 'processing' | 'tracking' | 'sent_no_status' | 'error';

interface StatusVisual {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  iconColor: string;
  title: string;
  subtitle: string;
  showSpinner: boolean;
}

/** Terminal statuses stop the live spinner and reveal the Done affordance. */
function isTerminalStatus(status: PaymentIntentStatus): boolean {
  return status === 'succeeded' || status === 'canceled';
}

function describePaymentStatus(
  intent: PaymentIntent | null,
  primary: string,
  warning: string,
  destructive: string,
): StatusVisual {
  const status = intent?.status ?? null;
  const chain = intent?.faircoin ?? null;
  switch (status) {
    case 'processing':
      // Sent and not seen yet, or confirming — the watcher's count says which.
      return chain !== null && chain.confirmations > 0
        ? {
            icon: 'progress-clock',
            iconColor: primary,
            title: t('pay.status.processing.confirming.title'),
            subtitle: t('pay.status.processing.confirming.subtitle', {
              count: chain.confirmations,
              required: chain.required_confirmations,
            }),
            showSpinner: true,
          }
        : {
            icon: 'send-circle',
            iconColor: primary,
            title: t('pay.status.processing.sent.title'),
            subtitle: t('pay.status.processing.sent.subtitle'),
            showSpinner: true,
          };
    case 'succeeded':
      return {
        icon: 'check-circle',
        iconColor: primary,
        title: t('pay.status.succeeded.title'),
        subtitle: t('pay.status.succeeded.subtitle'),
        showSpinner: false,
      };
    case 'canceled':
      // Why it ended: coins that were not enough, the clock, or the merchant.
      if (intent?.cancellation_reason === 'underpaid') {
        return {
          icon: 'alert-circle',
          iconColor: destructive,
          title: t('pay.status.canceled.underpaid.title'),
          subtitle: t('pay.status.canceled.underpaid.subtitle'),
          showSpinner: false,
        };
      }
      if (intent?.cancellation_reason === 'abandoned') {
        return {
          icon: 'clock-alert',
          iconColor: warning,
          title: t('pay.status.canceled.abandoned.title'),
          subtitle: t('pay.status.canceled.abandoned.subtitle'),
          showSpinner: false,
        };
      }
      return {
        icon: 'close-circle',
        iconColor: destructive,
        title: t('pay.status.canceled.merchant.title'),
        subtitle: t('pay.status.canceled.merchant.subtitle'),
        showSpinner: false,
      };
    // `requires_action` (the frame before our own broadcast is reflected) and
    // anything else: the tx is on its way to the network.
    default:
      return {
        icon: 'send-circle',
        iconColor: primary,
        title: t('pay.status.processing.sent.title'),
        subtitle: t('pay.status.processing.sent.subtitle'),
        showSpinner: true,
      };
  }
}

export default function ApprovePayScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { isAuthenticated, signIn } = useAuth();

  const params = useLocalSearchParams<{
    intent?: string;
    secret?: string;
    address?: string;
    outputs?: string;
    amount?: string;
    network?: string;
  }>();

  const sendToRecipients = useWalletStore((s) => s.sendToRecipients);
  const walletNetwork = useWalletStore((s) => s.network);
  const isWatchOnly = useWalletStore((s) => s.isWatchOnly);
  const initialized = useWalletStore((s) => s.initialized);

  const [phase, setPhase] = useState<PayPhase>('review');
  const [txid, setTxid] = useState<string | null>(null);
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const subscriptionRef = useRef<IntentSubscription | null>(null);
  const subscriptionAbort = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  // Tear down the realtime subscription when leaving the screen.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      subscriptionAbort.current?.abort();
      subscriptionRef.current?.unsubscribe();
      subscriptionRef.current = null;
    };
  }, []);

  // Re-derive + revalidate the request from the route params, with the SAME
  // validation the deep link went through. The router only pushes a well-formed
  // request, but a direct navigation could arrive incomplete — treat anything
  // malformed as an invalid request.
  // Keyed by the fields: the params object itself is new on every render.
  const { intent: pIntent, secret, address, outputs: pOutputs, amount: pAmount } = params;
  const pNetwork = params.network;
  const request = useMemo(
    () =>
      paymentRequestFromParams({
        intent: pIntent,
        secret,
        address,
        outputs: pOutputs,
        amount: pAmount,
        network: pNetwork,
      }),
    [pIntent, secret, address, pOutputs, pAmount, pNetwork],
  );
  const requestValid = request !== null;
  const intentId = request?.intentId ?? '';
  const clientSecret = request?.clientSecret ?? '';
  const amount = request?.amount ?? null;
  const network: NetworkType | null = request?.network ?? null;
  // One output per payee: a marketplace order pays every seller its share in
  // ONE transaction (Peable ADR 0021 D6).
  const outputs = request?.outputs ?? [];

  // The wallet builds against its OWN active network — paying a request for a
  // different chain would sign against the wrong parameters, so block it.
  const networkMismatch = network !== null && network !== walletNetwork;

  // Fiat estimate. Read `getCachedPrice()` every render (it is module state, not
  // a reactive dep) so the estimate tracks the latest poll; the math is cheap.
  const cachedPrice = getCachedPrice();
  const usdEquivalent =
    cachedPrice && amount !== null && amount > 0n
      ? ((Number(amount) / Number(UNITS_PER_COIN)) * cachedPrice.usd).toFixed(2)
      : null;

  const handleDecline = useCallback(() => {
    router.back();
  }, [router]);

  const handleSignIn = useCallback(() => {
    // Opens the in-app Oxy account dialog; the payment is already recorded, so
    // this only unlocks live status for a future visit.
    void signIn();
  }, [signIn]);

  const explorerUrl = txid ? explorerTxUrl(txid) : '';
  const handleViewTransaction = useCallback(() => {
    if (!explorerUrl) return;
    Linking.openURL(explorerUrl).catch(() => {
      setNotice(t('pay.notice.openLinkFailed'));
    });
  }, [explorerUrl]);

  const handleRetry = useCallback(() => {
    setErrorMessage(null);
    setNotice(null);
    setPhase('review');
  }, []);

  const handleApprove = useCallback(async () => {
    if (amount === null) return;
    const ownerEpoch = oxyServices.http.getSessionEpoch();
    const ownsView = () => mounted.current && oxyServices.http.getSessionEpoch() === ownerEpoch;
    setNotice(null);
    setErrorMessage(null);
    setPhase('processing');

    // 1. Pay via the wallet's normal build/sign/broadcast flow. A failure HERE
    //    means nothing was broadcast — the only genuinely failed-payment path.
    let broadcastTxid: string;
    try {
      broadcastTxid = await sendToRecipients(outputs, FEE_RATES.medium);
    } catch (err: unknown) {
      if (!ownsView()) return;
      hapticError();
      setErrorMessage(err instanceof Error ? err.message : t('pay.error.sendFailed'));
      setPhase('error');
      return;
    }

    // The coins are on-chain now. From here every failure is non-fatal to the
    // payment: never route back to the `error` phase once we hold a txid.
    if (ownsView()) {
      setTxid(broadcastTxid);
      hapticSuccess();
    }

    // 2. Report the txid to the Gateway. Possession of `clientSecret` authorizes
    //    it; the Gateway's watcher verifies the txid on-chain.
    try {
      const submitted = await submitTx(intentId, clientSecret, broadcastTxid);
      if (ownsView()) setIntent(submitted);
    } catch {
      // Gateway didn't record it, but the settlement watcher still catches the
      // tx on-chain. Surface a soft notice rather than failing the payment.
      if (ownsView()) setNotice(t('pay.notice.reportFailed'));
    }

    if (!ownsView()) return;

    // 3. Live status needs an authenticated Oxy session for the socket handshake.
    if (!isAuthenticated) {
      setPhase('sent_no_status');
      return;
    }

    try {
      if (!ownsView()) return;
      subscriptionAbort.current?.abort();
      const controller = new AbortController();
      subscriptionAbort.current = controller;
      setPhase('tracking');
      const subscription = await subscribeToIntent(
        intentId,
        clientSecret,
        (updated) => {
          if (!ownsView()) return;
          setIntent(updated);
          if (updated.status === 'succeeded') {
            hapticSuccess();
          } else if (updated.status === 'canceled') {
            hapticError();
          }
        },
        controller.signal,
      );
      if (!ownsView()) {
        subscription.unsubscribe();
        return;
      }
      subscriptionRef.current = subscription;
    } catch {
      if (!ownsView()) return;
      // Couldn't open the realtime channel; the payment still went through.
      setNotice(t('pay.notice.liveStatusUnavailable'));
      setPhase('sent_no_status');
    }
  }, [amount, outputs, intentId, clientSecret, isAuthenticated, sendToRecipients]);

  const visual = describePaymentStatus(
    intent,
    theme.colors.primary,
    theme.colors.warning ?? theme.colors.textSecondary,
    theme.colors.error ?? theme.colors.text,
  );
  const terminal = intent !== null && isTerminalStatus(intent.status);

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom', 'left', 'right']}>
      <ScreenHeader title={t('pay.title')} onBack={handleDecline} />
      <ScrollView className="flex-1" contentContainerClassName="px-5 pt-4 pb-8">
        {!requestValid ? (
          <View className="items-center justify-center py-16 gap-3">
            <MaterialCommunityIcons
              name="link-variant-off"
              size={48}
              color={theme.colors.textSecondary}
            />
            <Text className="text-foreground text-base font-semibold text-center">
              {t('pay.invalid.title')}
            </Text>
            <Text className="text-muted-foreground text-sm text-center">
              {t('pay.invalid.subtitle')}
            </Text>
            <View className="w-full mt-2">
              <Button title={t('common.close')} onPress={handleDecline} variant="secondary" />
            </View>
          </View>
        ) : (
          <View className="gap-6">
            {/* Amount hero */}
            <View className="items-center pt-2 pb-1">
              <View className="flex-row items-end justify-center">
                <View className="mr-1.5" style={{ marginBottom: 7 }}>
                  <FairCoinSymbol size={26} />
                </View>
                <Text
                  className="text-foreground"
                  style={{ fontFamily: FONT_PHUDU_BLACK, fontSize: 44 }}
                  numberOfLines={1}
                >
                  {amount !== null ? formatFair(amount) : ''}
                </Text>
              </View>
              <Text className="text-muted-foreground text-sm mt-2">
                {t('pay.usdApprox', { amount: usdEquivalent ?? '0.00' })}
              </Text>
            </View>

            {/* Payee address — one row per output of a multi-recipient payment */}
            <View>
              <Text className={SECTION_LABEL}>{t('pay.payTo')}</Text>
              {outputs.map((output) => (
                <View key={output.address} className="bg-surface rounded-2xl px-4 py-3.5 mt-2">
                  <Text
                    selectable
                    className="text-foreground text-sm"
                    style={{ fontFamily: 'monospace' }}
                  >
                    {output.address}
                  </Text>
                  {outputs.length > 1 ? (
                    <Text className="text-muted-foreground text-sm mt-1">
                      {formatFair(output.amount)}
                    </Text>
                  ) : null}
                </View>
              ))}
            </View>

            {/* Network */}
            <View>
              <Text className={SECTION_LABEL}>{t('pay.network')}</Text>
              <View className="flex-row mt-2">
                <View className="bg-surface rounded-full px-3.5 py-1.5">
                  <Text className="text-foreground text-xs font-semibold">
                    {network !== null ? t(`pay.network.${network}`) : ''}
                  </Text>
                </View>
              </View>
            </View>

            {/* Soft notice (non-fatal issues after broadcast) */}
            {notice ? (
              <View className="bg-primary/10 rounded-2xl p-3.5">
                <Text className="text-foreground text-sm text-center">{notice}</Text>
              </View>
            ) : null}

            {/* Phase-specific body */}
            {phase === 'review' ? (
              <View className="gap-3">
                {networkMismatch ? (
                  <View className="bg-destructive/10 rounded-2xl p-3.5">
                    <Text className="text-destructive text-sm text-center">
                      {t('pay.error.networkMismatch', {
                        requested: network !== null ? t(`pay.network.${network}`) : '',
                        active: t(`pay.network.${walletNetwork}`),
                      })}
                    </Text>
                  </View>
                ) : null}
                {isWatchOnly ? (
                  <View className="bg-destructive/10 rounded-2xl p-3.5">
                    <Text className="text-destructive text-sm text-center">
                      {t('pay.error.watchOnly')}
                    </Text>
                  </View>
                ) : null}
                {!initialized ? (
                  <View className="bg-surface rounded-2xl p-3.5">
                    <Text className="text-muted-foreground text-sm text-center">
                      {t('pay.error.notInitialized')}
                    </Text>
                  </View>
                ) : null}
                <Button
                  title={t('pay.approve')}
                  onPress={handleApprove}
                  variant="primary"
                  size="lg"
                  disabled={isWatchOnly || networkMismatch || !initialized}
                />
                <Button
                  title={t('pay.decline')}
                  onPress={handleDecline}
                  variant="ghost"
                  size="lg"
                />
              </View>
            ) : null}

            {phase === 'processing' ? (
              <View className="bg-surface rounded-2xl p-6 items-center gap-3">
                <ActivityIndicator color={theme.colors.primary} />
                <Text className="text-foreground text-sm font-semibold">{t('pay.processing')}</Text>
              </View>
            ) : null}

            {phase === 'tracking' || phase === 'sent_no_status' ? (
              <View className="gap-3">
                {/* Live / static status card */}
                <View className="bg-surface rounded-2xl p-6 items-center gap-3">
                  {visual.showSpinner ? (
                    <ActivityIndicator color={visual.iconColor} />
                  ) : (
                    <MaterialCommunityIcons name={visual.icon} size={40} color={visual.iconColor} />
                  )}
                  <Text className="text-foreground text-base font-semibold text-center">
                    {visual.title}
                  </Text>
                  <Text className="text-muted-foreground text-sm text-center">
                    {visual.subtitle}
                  </Text>
                </View>

                {/* Signed-out payers: nudge for live status (never blocks pay) */}
                {phase === 'sent_no_status' && !isAuthenticated ? (
                  <View className="bg-surface rounded-2xl p-4 gap-3">
                    <Text className="text-muted-foreground text-sm text-center">
                      {t('pay.sent.signedOut')}
                    </Text>
                    <Button title={t('pay.signIn')} onPress={handleSignIn} variant="secondary" />
                  </View>
                ) : null}

                {txid ? (
                  <Pressable
                    onPress={handleViewTransaction}
                    className="flex-row items-center justify-center gap-1.5 py-2 active:opacity-60"
                  >
                    <MaterialCommunityIcons
                      name="open-in-new"
                      size={14}
                      color={theme.colors.primary}
                    />
                    <Text className="text-primary text-sm font-semibold">
                      {t('pay.viewTransaction')}
                    </Text>
                  </Pressable>
                ) : null}

                {phase === 'sent_no_status' || terminal ? (
                  <Button
                    title={t('common.done')}
                    onPress={handleDecline}
                    variant="primary"
                    size="lg"
                  />
                ) : null}
              </View>
            ) : null}

            {phase === 'error' ? (
              <View className="gap-3">
                <View className="bg-destructive/10 rounded-2xl p-3.5">
                  <Text className="text-destructive text-sm text-center">
                    {errorMessage ?? t('pay.error.sendFailed')}
                  </Text>
                </View>
                <Button
                  title={t('common.retry')}
                  onPress={handleRetry}
                  variant="primary"
                  size="lg"
                />
                <Button
                  title={t('pay.decline')}
                  onPress={handleDecline}
                  variant="ghost"
                  size="lg"
                />
              </View>
            ) : null}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
