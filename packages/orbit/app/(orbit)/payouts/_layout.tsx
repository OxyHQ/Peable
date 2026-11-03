import { Stack } from 'expo-router';
import { useTheme } from '@oxy.so/bloom/theme';

/** Payouts is a list and a detail, stacked inside the one Payouts tab. */
export default function PayoutsLayout() {
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
