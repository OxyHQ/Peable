/**
 * Lock screen body — Revolut-style PIN entry with optional biometric unlock.
 *
 * Extracted from the old `app/lock.tsx` route so the SAME UI can be rendered as
 * a full-screen overlay (see {@link LockGate}) that covers every authenticated
 * screen while the app is locked (review finding C1). On a correct PIN or
 * biometric match it calls `onUnlock()` instead of navigating, leaving the
 * lock-state transition to the caller.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, Pressable, Image } from "react-native";
import { SafeAreaView } from "../safe-area-view";
import * as LocalAuthentication from "expo-local-authentication";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { verifyPin, isBiometricsEnabled } from "../../storage/secure-store";
import {
  loadPinAttempts,
  recordPinFailure,
  clearPinAttempts,
  PIN_MAX_ATTEMPTS,
  lockoutSecondsForAttempts,
} from "../../storage/pin-attempts";
import { PinPad } from "./PinPad";
import { PinDots } from "./PinDots";
import { useTheme } from "@oxy.so/bloom/theme";
import { hapticSuccess, hapticError } from "../../utils/haptics";
import { playUnlocked } from "../../services/sounds";
import { APP_DISPLAY_NAME } from "../../config";
import { t } from "../../i18n";

const PIN_LENGTH = 6;
const MAX_ATTEMPTS = PIN_MAX_ATTEMPTS;

interface LockScreenContentProps {
  /** Called exactly once when the user successfully unlocks. */
  onUnlock: () => void;
}

export function LockScreenContent({ onUnlock }: LockScreenContentProps) {
  const theme = useTheme();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [lockoutRemaining, setLockoutRemaining] = useState(0);
  const [verifying, setVerifying] = useState(false);
  const [biometricsAvailable, setBiometricsAvailable] = useState(false);
  const lockoutTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isLockedOut = lockedUntil !== null && lockoutRemaining > 0;

  const handleUnlocked = useCallback(() => {
    // N-3: a successful unlock clears the persisted attempts counter so the
    // user starts fresh next time. Best-effort — a clear failure must not
    // block the unlock (we already verified the PIN was correct).
    void clearPinAttempts();
    hapticSuccess();
    playUnlocked();
    onUnlock();
  }, [onUnlock]);

  const startLockoutTimer = useCallback((until: number) => {
    if (lockoutTimerRef.current) {
      clearInterval(lockoutTimerRef.current);
    }
    const updateRemaining = () => {
      const remaining = Math.ceil((until - Date.now()) / 1000);
      if (remaining <= 0) {
        setLockedUntil(null);
        setLockoutRemaining(0);
        setError(null);
        // N-3: deliberately do NOT zero the persisted attempts here. Resetting
        // would let an attacker run "N-1 attempts → wait base lockout → N-1
        // more" indefinitely. Keeping the counter means the next failure
        // triggers the next back-off step (60s, 120s, …) until a real
        // success calls `clearPinAttempts`. A legitimate user who mistyped
        // sees one painful retry, then they're fine.
        if (lockoutTimerRef.current) {
          clearInterval(lockoutTimerRef.current);
          lockoutTimerRef.current = null;
        }
      } else {
        setLockoutRemaining(remaining);
      }
    };
    updateRemaining();
    lockoutTimerRef.current = setInterval(updateRemaining, 1000);
  }, []);

  const tryBiometricAuth = useCallback(async () => {
    try {
      const [hardwareAvailable, enrolled, enabled] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
        isBiometricsEnabled(),
      ]);

      if (!hardwareAvailable || !enrolled || !enabled) {
        return;
      }

      setBiometricsAvailable(true);

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: t("lock.unlockPrompt", { app: APP_DISPLAY_NAME }),
        disableDeviceFallback: false,
      });

      if (result.success) {
        handleUnlocked();
      }
    } catch (error: unknown) {
      console.debug("Biometric unlock was unavailable", error);
    }
  }, [handleUnlocked]);

  // N-3: rehydrate the persisted attempts counter / lockout deadline on
  // every mount. Without this, killing the app between attempts would reset
  // the in-memory counter and let a brute-force loop bypass the policy.
  useEffect(() => {
    let cancelled = false;
    loadPinAttempts()
      .then((state) => {
        if (cancelled) return;
        setAttempts(state.failedAttempts);
        if (state.lockedUntil > Date.now()) {
          setLockedUntil(state.lockedUntil);
          startLockoutTimer(state.lockedUntil);
          setError(
            t("lock.tooManyAttempts", {
              seconds: Math.ceil((state.lockedUntil - Date.now()) / 1000),
            }),
          );
        }
      })
      .catch(() => {
        // Failing to read the persisted state is non-fatal; the lockout is
        // best-effort defence in depth. The PIN itself is still protected by
        // scrypt + secure storage.
      });
    return () => {
      cancelled = true;
    };
  }, [startLockoutTimer]);

  // Attempt biometric auth once when the lock screen is shown (the overlay
  // mounts whenever the app becomes locked). A plain effect avoids depending on
  // a navigation/focus context, since this renders as a root overlay, not a
  // routed screen.
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      const [hardwareAvailable, enrolled, enabled] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
        isBiometricsEnabled(),
      ]).catch(() => [false, false, false] as const);

      if (cancelled) return;

      if (hardwareAvailable && enrolled && enabled) {
        setBiometricsAvailable(true);

        try {
          const result = await LocalAuthentication.authenticateAsync({
            promptMessage: t("lock.unlockPrompt", { app: APP_DISPLAY_NAME }),
            disableDeviceFallback: false,
          });

          if (result.success && !cancelled) {
            handleUnlocked();
          }
        } catch (error: unknown) {
          console.debug("Biometric unlock did not complete", error);
        }
      }
    };

    init();

    return () => {
      cancelled = true;
      if (lockoutTimerRef.current) {
        clearInterval(lockoutTimerRef.current);
        lockoutTimerRef.current = null;
      }
    };
  }, [handleUnlocked]);

  const handleDigitPress = useCallback(
    (digit: string) => {
      if (verifying || isLockedOut) return;

      setError(null);
      setPin((prev) => {
        if (prev.length >= PIN_LENGTH) return prev;
        const next = prev + digit;

        if (next.length === PIN_LENGTH) {
          setVerifying(true);
          verifyPin(next)
            .then(async (correct) => {
              if (correct) {
                handleUnlocked();
                setVerifying(false);
                return;
              }
              hapticError();
              // N-3: persist the failure so a force-quit can NOT reset the
              // counter. `recordPinFailure` also returns the post-update
              // lockout deadline so the UI uses the same number we wrote to
              // disk (avoids a render that shows "0 attempts left" while
              // the store already says "locked").
              const persisted = await recordPinFailure().catch(() => null);
              const newAttempts = persisted?.failedAttempts ?? attempts + 1;
              setAttempts(newAttempts);

              if (newAttempts >= MAX_ATTEMPTS) {
                const until =
                  persisted?.lockedUntil ??
                  Date.now() + lockoutSecondsForAttempts(newAttempts) * 1000;
                setLockedUntil(until);
                setError(
                  t("lock.tooManyAttempts", {
                    seconds: Math.ceil((until - Date.now()) / 1000),
                  }),
                );
                startLockoutTimer(until);
              } else {
                const remaining = MAX_ATTEMPTS - newAttempts;
                setError(
                  remaining === 1
                    ? t("lock.wrongPasscode.one", { count: remaining })
                    : t("lock.wrongPasscode.other", { count: remaining }),
                );
              }
              setPin("");
              setVerifying(false);
            })
            .catch(() => {
              setError(t("lock.verificationFailed"));
              setPin("");
              setVerifying(false);
            });
        }

        return next;
      });
    },
    [verifying, isLockedOut, attempts, handleUnlocked, startLockoutTimer],
  );

  const handleBackspace = useCallback(() => {
    if (verifying || isLockedOut) return;
    setPin((prev) => prev.slice(0, -1));
    setError(null);
  }, [verifying, isLockedOut]);

  const biometricButton = biometricsAvailable ? (
    <Pressable
      className="w-18 h-18 rounded-full items-center justify-center active:bg-primary/10"
      onPress={tryBiometricAuth}
      disabled={isLockedOut}
    >
      <MaterialCommunityIcons
        name="fingerprint"
        size={28}
        color={isLockedOut ? theme.colors.card : theme.colors.primary}
      />
    </Pressable>
  ) : undefined;

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 items-center justify-between px-6 pt-16 pb-8">
        {/* Brand + prompt */}
        <View className="items-center flex-1 justify-center">
          <Image
            source={require("../../../assets/icon.png")}
            style={{ width: 88, height: 88, marginBottom: 24, borderRadius: 20 }}
            resizeMode="contain"
            accessibilityIgnoresInvertColors
            accessibilityRole="image"
            accessibilityLabel={t("onboarding.logoAccessibility")}
          />

          <Text className="text-foreground text-xl font-semibold mb-8">
            {t("lock.enterPasscode")}
          </Text>

          <PinDots
            length={PIN_LENGTH}
            filled={pin.length}
            error={error !== null}
          />

          {/* Error / lockout messages */}
          <View className="h-12 justify-center mt-4">
            {error ? (
              <Text className="text-red-400 text-sm text-center px-4">
                {error}
              </Text>
            ) : null}
            {isLockedOut && lockoutRemaining > 0 ? (
              <Text className="text-muted-foreground text-sm text-center">
                {t("lock.lockedFor", { seconds: lockoutRemaining })}
              </Text>
            ) : null}
          </View>
        </View>

        {/* Number pad */}
        <View className="w-full pb-4">
          <PinPad
            onDigit={handleDigitPress}
            onBackspace={handleBackspace}
            disabled={isLockedOut || verifying}
            biometricButton={biometricButton}
            tintColor={theme.colors.text}
            disabledColor={theme.colors.card}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}
