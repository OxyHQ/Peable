import { Stack } from 'expo-router';
import { useTheme } from '@oxy.so/bloom/theme';

/** Terminal is its readers and locations, and a reader's page, stacked inside the one Terminal tab. */
export default function TerminalLayout() {
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
