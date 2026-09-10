/**
 * Button — FAIRWallet's button, styled by Bloom's design system.
 *
 * Keeps the app's call-site API (a `title` string + FairCoin variant names) and
 * delegates all rendering/theming to Bloom's `Button`, so every button matches
 * the shared Bloom/Oxy look while inheriting the active `faircoin` preset. The
 * two behaviors Bloom's Button doesn't provide — a haptic tick on the primary
 * action and full-width sizing on native — are layered on here.
 */

import { useCallback } from "react";
import type { ViewStyle } from "react-native";
import { Button as BloomButton } from "@oxy.so/bloom/button";
import type { ButtonVariant as BloomButtonVariant } from "@oxy.so/bloom/button";
import { hapticImpact } from "../../utils/haptics";

type ButtonVariant = "primary" | "secondary" | "danger" | "outline" | "ghost";
type ButtonSize = "sm" | "md" | "lg";

const VARIANT_MAP: Record<ButtonVariant, BloomButtonVariant> = {
  primary: "primary",
  secondary: "secondary",
  danger: "destructive",
  outline: "outline",
  ghost: "ghost",
};

interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  icon?: React.ReactNode;
  iconPosition?: "left" | "right";
  fullWidth?: boolean;
  style?: ViewStyle;
}

export function Button({
  title,
  onPress,
  variant = "primary",
  size = "md",
  disabled = false,
  loading = false,
  icon,
  iconPosition = "left",
  fullWidth = true,
  style,
}: ButtonProps) {
  const handlePress = useCallback(() => {
    if (variant === "primary") hapticImpact();
    onPress();
  }, [variant, onPress]);

  return (
    <BloomButton
      variant={VARIANT_MAP[variant]}
      size={size}
      onPress={handlePress}
      disabled={disabled}
      loading={loading}
      icon={icon}
      iconPosition={iconPosition}
      style={fullWidth ? [{ width: "100%" }, style] : style}
    >
      {title}
    </BloomButton>
  );
}
