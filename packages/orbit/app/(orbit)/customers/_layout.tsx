import { Stack } from 'expo-router';
import { useTheme } from '@oxy.so/bloom/theme';

/** Customers is a list and a detail, stacked inside the one Customers tab. */
export default function CustomersLayout() {
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
