import { Stack } from 'expo-router';
import { useTheme } from '@oxy.so/bloom/theme';

/** Settings is the merchant, Business details and Team, stacked inside the one Settings tab. */
export default function SettingsLayout() {
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
