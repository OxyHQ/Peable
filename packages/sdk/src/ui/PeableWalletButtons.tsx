import { createElement, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';
import type { PeableClientAction } from '../browser/payerClient';
import {
  type CardConfirmOutcome,
  type ExpressWallet,
  mountCardElements,
} from '../browser/cardElements';
import { loadProviderSdk } from '../browser/providerJs';
import { checkoutMessage, providerLocale } from './messages';

export interface PeableWalletButtonsProps {
  /**
   * The card payment's client action. The wallets mount on the REAL payment,
   * so the provider offers exactly the wallets the merchant's payment method
   * configuration (pushed with the payment) and this device allow, at the
   * payment's own amount.
   */
  action: PeableClientAction;
  locale?: string;
  messages?: Readonly<Record<string, string>>;
  /** Where a bank's 3-D Secure redirect returns. */
  returnUrl: string;
  /** The provider accepted the wallet's confirmation. Not paid: the gateway decides. */
  onAccepted(): void;
  /** The wallet confirmation was declined or failed, in words. */
  onError(message: string): void;
  /** The wallets this device shows for this payment; `[]` when none. */
  onWalletsChange?(wallets: readonly ExpressWallet[]): void;
}

/**
 * Apple Pay and Google Pay in the sheet, on the web: the provider's Express
 * Checkout element (the same `mountCardElements` the hosted checkout and
 * `PeableCheckout.mount` use) over the card payment. Its buttons are the
 * provider's, in its frame; nothing of the wallet passes through Peable's
 * code. The slot is empty — and says nothing — when the device or the
 * merchant offers no wallet.
 */
export function PeableWalletButtons({
  action,
  locale,
  messages,
  returnUrl,
  onAccepted,
  onError,
  onWalletsChange,
}: PeableWalletButtonsProps) {
  const node = useRef<HTMLDivElement | null>(null);
  const [wallets, setWallets] = useState<readonly ExpressWallet[]>([]);
  const callbacks = useRef({ onAccepted, onError, onWalletsChange });
  callbacks.current = { onAccepted, onError, onWalletsChange };
  const secret = action.kind === 'client_secret' ? action.value : null;
  const publishableKey = action.publishable_key;

  useEffect(() => {
    const target = node.current;
    if (!secret || !publishableKey || !target || typeof document === 'undefined') return;
    let active = true;
    let destroy: (() => void) | null = null;
    const report = (next: readonly ExpressWallet[]) => {
      if (!active) return;
      setWallets(next);
      callbacks.current.onWalletsChange?.(next);
    };
    void loadProviderSdk()
      .then((factory) => {
        if (!active) return;
        const handle = mountCardElements({
          sdk: factory(publishableKey, { locale: providerLocale(locale) }),
          clientSecret: secret,
          paymentTarget: null,
          walletTarget: target,
          returnUrl,
          onWalletsChange: report,
          onWalletOutcome: (outcome: CardConfirmOutcome) => {
            if (!active) return;
            if (outcome.kind === 'accepted') callbacks.current.onAccepted();
            else callbacks.current.onError(outcome.message);
          },
        });
        destroy = () => handle.destroy();
      })
      // No provider script: the card fields say so; the wallet slot stays empty.
      .catch(() => report([]));
    return () => {
      active = false;
      destroy?.();
      setWallets([]);
    };
  }, [secret, publishableKey, locale, returnUrl]);

  if (typeof document === 'undefined') return null;
  return (
    <View style={{ gap: 12 }}>
      {createElement('div', {
        ref: (element: HTMLDivElement | null) => {
          node.current = element;
        },
        'data-testid': 'peable-wallets',
        style: { width: '100%' },
      })}
      {wallets.length > 0 && (
        <Text style={{ textAlign: 'center' }}>
          {checkoutMessage(locale, 'wallet.or', undefined, messages)}
        </Text>
      )}
    </View>
  );
}
