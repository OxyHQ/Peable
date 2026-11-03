import { Stack } from 'expo-router';
import { useTheme } from '@oxy.so/bloom/theme';

/** Payment Links is a list, a builder and a detail, stacked inside the one tab. */
export default function LinksLayout() {
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
