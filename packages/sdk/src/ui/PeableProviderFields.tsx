import { providerAcceptedConfirmation } from './providerConfirmation';
import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import { Text, fontFamilies, TYPE_SCALE } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';
import { RADIUS } from '@oxy.so/bloom/design-tokens';
import { Button } from '@oxy.so/bloom/button';
import { checkoutMessage } from './messages';
import type { PeableClientAction } from '../browser/payerClient';
import {
  loadProviderSdk,
  type ProviderElements,
  type ProviderElement,
} from '../browser/providerJs';

export type ProviderConfirmation = { accepted: true } | { accepted: false; error: string };
export interface PeableProviderFieldsProps {
  action: PeableClientAction;
  locale?: string;
  returnUrl: string;
  /** A confirmation is acceptance by the provider, NEVER settlement or fulfillment. */
  onReady(confirm: (() => Promise<ProviderConfirmation>) | null): void;
  onError?(message: string): void;
  loadingLabel?: string;
  unavailableLabel?: string;
}
/** Provider-origin fields. The host never receives card numbers, expiry or security codes. */
export function PeableProviderFields({
  action,
  locale = 'en',
  returnUrl,
  onReady,
  onError,
  loadingLabel = checkoutMessage(locale, 'provider.loading'),
  unavailableLabel = checkoutMessage(locale, 'provider.unavailable'),
}: PeableProviderFieldsProps) {
  const { colors, isDark } = useTheme();
  const appearance = useMemo(
    () => ({
      theme: isDark ? 'night' : 'stripe',
      variables: {
        colorPrimary: colors.primary,
        colorBackground: colors.backgroundSecondary,
        colorText: colors.text,
        colorDanger: colors.error,
        fontFamily: fontFamilies.sans,
        fontSizeBase: `${Math.max(16, TYPE_SCALE['body-regular'].fontSize)}px`,
        borderRadius: `${RADIUS['radius-12']}px`,
      },
      rules: { '.Input': { borderColor: colors.border } },
    }),
    [isDark, colors.primary, colors.backgroundSecondary, colors.text, colors.error, colors.border],
  );
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  const elementsRef = useRef<ProviderElements | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    elementsRef.current?.update?.({ appearance });
  }, [appearance]);
  const node = useRef<HTMLDivElement | null>(null);
  const callbacks = useRef({ onReady, onError });
  callbacks.current = { onReady, onError };
  const [phase, setPhase] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const browser = typeof document !== 'undefined';
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly recreates fields for the same payment.
  useEffect(() => {
    let active = true;
    let busy = false;
    let element: ProviderElement | undefined;
    const fail = () => {
      if (!active) return;
      active = false;
      clearTimeout(readyTimeout);
      callbacks.current.onReady(null);
      element?.destroy();
      element = undefined;
      elementsRef.current = null;
      setPhase('unavailable');
      callbacks.current.onError?.(unavailableLabel);
    };
    const readyTimeout = setTimeout(fail, 20000);
    callbacks.current.onReady(null);
    setPhase('loading');
    if (!browser || action.kind !== 'client_secret' || !action.publishableKey) {
      setPhase('unavailable');
      clearTimeout(readyTimeout);
      return;
    }
    const key = action.publishableKey;
    void loadProviderSdk()
      .then((factory) => {
        if (!active || !node.current) return;
        const provider = factory(key, {
          locale: locale.startsWith('es') ? 'es' : locale.startsWith('en') ? 'en' : 'auto',
        });
        const elements = provider.elements({
          clientSecret: action.value,
          appearance: appearanceRef.current,
        });
        elementsRef.current = elements;
        element = elements.create('payment');
        const ready = () => {
          if (!active) return;
          clearTimeout(readyTimeout);
          setPhase('ready');
          callbacks.current.onReady(async () => {
            if (!active || busy)
              return { accepted: false, error: checkoutMessage(locale, 'provider.busy') };
            busy = true;
            try {
              const result = await provider.confirmPayment({
                elements,
                redirect: 'if_required',
                confirmParams: { return_url: returnUrl },
              });
              if (!active)
                return { accepted: false, error: checkoutMessage(locale, 'provider.closed') };
              if (result.error)
                return {
                  accepted: false,
                  error: result.error.message ?? checkoutMessage(locale, 'provider.failed'),
                };
              return providerAcceptedConfirmation(result)
                ? { accepted: true }
                : { accepted: false, error: checkoutMessage(locale, 'provider.incomplete') };
            } catch {
              return { accepted: false, error: checkoutMessage(locale, 'provider.failed') };
            } finally {
              busy = false;
            }
          });
        };
        if (element.on) {
          element.on('ready', ready);
          element.on('loaderror', fail);
        }
        element.mount(node.current);
        if (!element.on) ready();
      })
      .catch(fail);
    return () => {
      active = false;
      callbacks.current.onReady(null);
      clearTimeout(readyTimeout);
      elementsRef.current = null;
      element?.destroy();
    };
  }, [
    action.kind,
    action.value,
    action.publishableKey,
    returnUrl,
    browser,
    unavailableLabel,
    locale,
    retry,
  ]);
  if (!browser) return <Text accessibilityRole="alert">{unavailableLabel}</Text>;
  return (
    <>
      {phase === 'unavailable' ? (
        <>
          <Text accessibilityRole="alert">{unavailableLabel}</Text>
          <Button onPress={() => setRetry((value) => value + 1)}>
            {checkoutMessage(locale, 'provider.retry')}
          </Button>
        </>
      ) : phase === 'loading' ? (
        <Text>{loadingLabel}</Text>
      ) : null}
      {createElement('div', {
        key: 'provider-fields',
        ref: node,
        'data-testid': 'peable-provider-fields',
        style: { width: '100%', display: phase === 'unavailable' ? 'none' : undefined },
      })}
    </>
  );
}
