/**
 * PinPad — Revolut-style circular number pad for PIN entry.
 * Renders a 4×3 grid: digits 1-9, biometric/empty, 0, backspace.
 *
 * On web/electron, also listens for physical keyboard input:
 *   - digits 0-9 → onDigit
 *   - Backspace/Delete → onBackspace
 */

import { useCallback, useEffect } from "react";
import { View, Text, Pressable, Platform } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useTheme } from "@oxy.so/bloom/theme";
import { hapticSelection, hapticImpact } from "../../utils/haptics";

interface PinPadProps {
  onDigit: (digit: string) => void;
  onBackspace: () => void;
  disabled?: boolean;
  biometricButton?: React.ReactNode;
  tintColor?: string;
  disabledColor?: string;
}

const ROWS: readonly (readonly string[])[] = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  ["bio", "0", "back"],
];

export function PinPad({
  onDigit,
  onBackspace,
  disabled = false,
  biometricButton,
  tintColor,
  disabledColor,
}: PinPadProps) {
  const theme = useTheme();
  const activeColor = tintColor ?? theme.colors.text;
  const inactiveColor = disabledColor ?? theme.colors.card;

  const handleDigit = useCallback(
    (digit: string) => {
      if (!disabled) {
        hapticSelection();
        onDigit(digit);
      }
    },
    [disabled, onDigit],
  );

  const handleBack = useCallback(() => {
    if (!disabled) {
      hapticImpact();
      onBackspace();
    }
  }, [disabled, onBackspace]);

  // Keyboard support (web/electron only). RN native doesn't expose global
  // keyboard events; native screens already use on-screen PinPad touches.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (disabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key >= "0" && event.key <= "9") {
        event.preventDefault();
        handleDigit(event.key);
      } else if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        handleBack();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [disabled, handleDigit, handleBack]);

  return (
    <View className="w-full items-center">
      {ROWS.map((row, rowIdx) => (
        <View key={`pad-row-${rowIdx}`} className="flex-row justify-center gap-6 mb-4">
          {row.map((key) => {
            if (key === "bio") {
              if (biometricButton) {
                return (
                  <View key="biometric" className="w-18 h-18 items-center justify-center">
                    {biometricButton}
                  </View>
                );
              }
              return <View key="empty" className="w-18 h-18" />;
            }

            if (key === "back") {
              return (
                <Pressable
                  key="backspace"
                  className="w-18 h-18 rounded-full items-center justify-center active:bg-surface"
                  onPress={handleBack}
                  disabled={disabled}
                >
                  <MaterialCommunityIcons
                    name="backspace-outline"
                    size={26}
                    color={disabled ? inactiveColor : theme.colors.textSecondary}
                  />
                </Pressable>
              );
            }

            return (
              <Pressable
                key={`key-${key}`}
                className={`w-18 h-18 rounded-full items-center justify-center ${
                  disabled ? "opacity-30" : "active:bg-primary/10"
                }`}
                onPress={() => handleDigit(key)}
                disabled={disabled}
              >
                <Text
                  style={{ color: disabled ? theme.colors.textSecondary : activeColor }}
                  className="text-3xl font-light"
                >
                  {key}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}
