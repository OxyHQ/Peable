/**
 * ConfirmationRing — an Instagram-story-style progress ring drawn AROUND a
 * transaction row's leading icon to show its confirmation progress. The ring
 * sweeps clockwise from 12 o'clock as blocks confirm (0 → settled); once the tx
 * is fully confirmed the caller stops passing it, so no ring is drawn. The
 * wrapped icon is centred inside a fixed `size` box so confirming and settled
 * rows keep the same avatar footprint (no horizontal jitter between rows).
 *
 * Drawn with react-native-svg so the ring inherits the theme colour.
 */

import type { ReactNode } from 'react';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

interface ConfirmationRingProps {
  /** Fill fraction; clamped to 0..1. */
  progress: number;
  color: string;
  /** Outer diameter of the ring box (the icon is centred within it). */
  size: number;
  strokeWidth?: number;
  children: ReactNode;
}

export function ConfirmationRing({
  progress,
  color,
  size,
  strokeWidth = 2.5,
  children,
}: ConfirmationRingProps) {
  const p = Math.max(0, Math.min(1, progress));
  const center = size / 2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <View style={{ width: size, height: size }} className="items-center justify-center">
      {/* Settled (p >= 1): no ring at all — just the centred icon. */}
      {p < 1 ? (
        <Svg width={size} height={size} style={{ position: 'absolute', top: 0, left: 0 }}>
          {/* Track */}
          <Circle
            cx={center}
            cy={center}
            r={radius}
            stroke={color}
            strokeOpacity={0.2}
            strokeWidth={strokeWidth}
            fill="none"
          />
          {/* Progress sweep — start at 12 o'clock, clockwise. */}
          <Circle
            cx={center}
            cy={center}
            r={radius}
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - p)}
            transform={`rotate(-90 ${center} ${center})`}
          />
        </Svg>
      ) : null}
      {children}
    </View>
  );
}
