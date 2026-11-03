import { Stack } from 'expo-router';
import { useTheme } from '@oxy.so/bloom/theme';

/** Invoices is a list and a detail, stacked inside the one Invoices tab. */
export default function InvoicesLayout() {
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
