import { Stack } from 'expo-router';
import { useTheme } from '@oxy.so/bloom/theme';

/** Developers is its lists and an event or a request, stacked inside the one Developers tab. */
export default function DevelopersLayout() {
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
