import { Stack } from 'expo-router';
import { useTheme } from '@oxy.so/bloom/theme';

/** Subscriptions is a list and a detail, stacked inside the one Subscriptions tab. */
export default function SubscriptionsLayout() {
  const theme = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.background },
      }}
    />
  );
}
