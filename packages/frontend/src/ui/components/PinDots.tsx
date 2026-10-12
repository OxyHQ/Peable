/**
 * PinDots — row of indicator dots for PIN entry.
 * Shows filled (green) and empty (muted border) dots.
 * Turns red on error state.
 */

import { View } from 'react-native';

interface PinDotsProps {
  length: number;
  filled: number;
  error?: boolean;
}

export function PinDots({ length, filled, error = false }: PinDotsProps) {
  const filledColor = error ? 'bg-red-400' : 'bg-primary';

  return (
    <View className="flex-row gap-5">
      {Array.from({ length }, (_, i) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed row of identical dots; the position is the only identity
          key={`pin-dot-${i}`}
          className={`w-3.5 h-3.5 rounded-full ${
            i < filled ? filledColor : 'border-2 border-border'
          }`}
        />
      ))}
    </View>
  );
}
