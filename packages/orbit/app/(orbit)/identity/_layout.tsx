import { Stack } from 'expo-router';
import { useTheme } from '@oxy.so/bloom/theme';

/** Identity is a list and a detail, stacked inside the one Identity tab. */
export default function IdentityLayout() {
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
