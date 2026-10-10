/**
 * Card — surface container with rounded corners and dark-light background.
 * Use for grouping related content (settings sections, list groups, etc.).
 */

import { View } from 'react-native';

interface CardProps {
  children: React.ReactNode;
  className?: string;
}

export function Card({ children, className = '' }: CardProps) {
  return (
    <View className={`bg-surface rounded-2xl overflow-hidden ${className}`.trim()}>{children}</View>
  );
}
