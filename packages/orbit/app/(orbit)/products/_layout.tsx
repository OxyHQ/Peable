import { Stack } from 'expo-router';
import { useTheme } from '@oxy.so/bloom/theme';

/** Products is a list and a detail, stacked inside the one Products tab. */
export default function ProductsLayout() {
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
