import { Stack } from 'expo-router';
import { useTheme } from '@oxy.so/bloom/theme';

/** Disputes is a list and a detail, stacked inside the one Disputes tab. */
export default function DisputesLayout() {
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
