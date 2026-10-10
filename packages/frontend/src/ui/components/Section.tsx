/**
 * Section — labeled content group with optional uppercase title.
 * Renders a muted header followed by children wrapped in a Card.
 */

import { View, Text } from 'react-native';
import { Card } from './Card';

interface SectionProps {
  title?: string;
  children: React.ReactNode;
  className?: string;
}

export function Section({ title, children, className = '' }: SectionProps) {
  return (
    <View className={className}>
      {title ? (
        <Text className="text-muted-foreground text-xs font-semibold uppercase tracking-wider mb-2 px-1">
          {title}
        </Text>
      ) : null}
      <Card>{children}</Card>
    </View>
  );
}
