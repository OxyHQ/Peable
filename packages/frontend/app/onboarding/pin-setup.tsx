/**
 * PIN setup screen — Revolut-style passcode creation during onboarding.
 * Prompts user to set and confirm a 6-digit PIN.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Image } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from '../../src/ui/safe-area-view';
import { savePin } from '../../src/storage/secure-store';
import { useLockStore } from '../../src/wallet/lock-store';
import { PinPad } from '../../src/ui/components/PinPad';
import { PinDots } from '../../src/ui/components/PinDots';
import { hapticSuccess } from '../../src/utils/haptics';
import { t } from '../../src/i18n';

const PIN_LENGTH = 6;
// Short delay so the last filled dot is visible before phase transition.
const PHASE_TRANSITION_DELAY_MS = 200;

type PinPhase = 'create' | 'confirm';

export default function PinSetupScreen() {
  const router = useRouter();
  const unlock = useLockStore((s) => s.unlock);
  const [phase, setPhase] = useState<PinPhase>('create');
  const [pin, setPin] = useState('');
  const [firstPin, setFirstPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // N-13: hold the in-flight transition timer so we can clear it on unmount
  // and on every new digit press. Without it, a user who backs out within
  // 200 ms of entering the 6th digit would still trigger `setFirstPin` /
  // `savePin` on an unmounted component — at best a React warning, at
  // worst (in the "confirm" phase) a PIN persisted for a wallet whose
  // onboarding the user abandoned mid-flow (compounds N-7).
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track mount state so the async savePin().then() handler doesn't call
  // setState (or worse, navigate) on an unmounted component.
  const mounted = useRef(true);

  useEffect(() => {
    return () => {
      mounted.current = false;
      if (transitionTimer.current !== null) {
        clearTimeout(transitionTimer.current);
        transitionTimer.current = null;
      }
    };
  }, []);

  const title =
    phase === 'create' ? t('onboarding.pin.create.title') : t('onboarding.pin.confirm.title');
  const subtitle =
    phase === 'create' ? t('onboarding.pin.create.subtitle') : t('onboarding.pin.confirm.subtitle');

  const handleDigitPress = useCallback(
    (digit: string) => {
      if (saving) return;

      setError(null);
      setPin((prev) => {
        if (prev.length >= PIN_LENGTH) return prev;
        const next = prev + digit;

        if (next.length === PIN_LENGTH) {
          // Drop any in-flight transition so we don't queue two callbacks
          // for the same dot-fill moment.
          if (transitionTimer.current !== null) {
            clearTimeout(transitionTimer.current);
          }
          if (phase === 'create') {
            transitionTimer.current = setTimeout(() => {
              transitionTimer.current = null;
              if (!mounted.current) return;
              setFirstPin(next);
              setPin('');
              setPhase('confirm');
            }, PHASE_TRANSITION_DELAY_MS);
          } else {
            transitionTimer.current = setTimeout(() => {
              transitionTimer.current = null;
              if (!mounted.current) return;
              if (next === firstPin) {
                hapticSuccess();
                setSaving(true);
                savePin(next)
                  .then(() => {
                    if (!mounted.current) return;
                    // The wallet was just created and is already initialized;
                    // the user explicitly set this PIN, so unlock immediately
                    // instead of letting the lock overlay shut them out.
                    unlock();
                    router.replace('/(tabs)');
                  })
                  .catch((err: unknown) => {
                    if (!mounted.current) return;
                    const msg = err instanceof Error ? err.message : t('onboarding.pin.saveError');
                    setError(msg);
                    setSaving(false);
                    setPin('');
                  });
              } else {
                setError(t('onboarding.pin.mismatch'));
                setPin('');
                setFirstPin('');
                setPhase('create');
              }
            }, PHASE_TRANSITION_DELAY_MS);
          }
        }

        return next;
      });
    },
    [phase, firstPin, saving, router, unlock],
  );

  const handleBackspace = useCallback(() => {
    if (saving) return;
    setPin((prev) => prev.slice(0, -1));
    setError(null);
  }, [saving]);

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 items-center justify-between px-6 pt-16 pb-8">
        {/* Header + dots */}
        <View className="items-center flex-1 justify-center">
          <Image
            source={require('../../assets/icon.png')}
            style={{ width: 88, height: 88, marginBottom: 24, borderRadius: 20 }}
            resizeMode="contain"
            accessibilityIgnoresInvertColors
            accessibilityRole="image"
            accessibilityLabel={t('onboarding.logoAccessibility')}
          />

          <Text className="text-foreground text-xl font-semibold mb-2">{title}</Text>
          <Text className="text-muted-foreground text-sm text-center mb-10">{subtitle}</Text>

          <PinDots length={PIN_LENGTH} filled={pin.length} error={error !== null} />

          {/* Error feedback */}
          <View className="h-12 justify-center mt-4">
            {error ? <Text className="text-red-400 text-sm text-center px-4">{error}</Text> : null}
          </View>
        </View>

        {/* Number pad */}
        <View className="w-full pb-4">
          <PinPad onDigit={handleDigitPress} onBackspace={handleBackspace} disabled={saving} />
        </View>
      </View>
    </SafeAreaView>
  );
}
