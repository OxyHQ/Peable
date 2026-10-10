/**
 * Badge — pill-shaped status/label indicator.
 * Supports success, warning, error, info, and neutral variants.
 */

import { useMemo } from 'react';
import { Text, View } from 'react-native';

type BadgeVariant = 'success' | 'warning' | 'error' | 'info' | 'neutral';
type BadgeSize = 'sm' | 'md';

interface BadgeProps {
  text: string;
  variant?: BadgeVariant;
  size?: BadgeSize;
}

interface VariantStyle {
  bg: string;
  text: string;
}

const VARIANT_STYLES: Record<BadgeVariant, VariantStyle> = {
  success: { bg: 'bg-green-500/15', text: 'text-green-400' },
  warning: { bg: 'bg-yellow-500/15', text: 'text-yellow-400' },
  error: { bg: 'bg-red-500/15', text: 'text-red-400' },
  info: { bg: 'bg-blue-500/15', text: 'text-blue-400' },
  neutral: { bg: 'bg-muted-foreground/15', text: 'text-muted-foreground' },
};

const SIZE_CLASSES: Record<BadgeSize, string> = {
  sm: 'px-1.5 py-0.5',
  md: 'px-2 py-0.5',
};

const TEXT_SIZE_CLASSES: Record<BadgeSize, string> = {
  sm: 'text-[9px]',
  md: 'text-xs',
};

export function Badge({ text, variant = 'neutral', size = 'md' }: BadgeProps) {
  const style = useMemo(() => VARIANT_STYLES[variant], [variant]);
  const sizeClass = SIZE_CLASSES[size];
  const textSizeClass = TEXT_SIZE_CLASSES[size];

  return (
    <View className={`rounded-full ${style.bg} ${sizeClass}`}>
      <Text className={`${style.text} ${textSizeClass} font-bold`}>{text}</Text>
    </View>
  );
}
