import { Stack } from 'expo-router';
import { useTheme } from '@oxy.so/bloom/theme';

/** Payments is a list and a detail, stacked inside the one Payments tab. */
export default function PaymentsLayout() {
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
