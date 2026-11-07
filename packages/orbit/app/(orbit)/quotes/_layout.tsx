import { Stack } from 'expo-router';
import { useTheme } from '@oxy.so/bloom/theme';

/** Quotes is a list, a builder and a detail, stacked inside the one Quotes tab. */
export default function QuotesLayout() {
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
