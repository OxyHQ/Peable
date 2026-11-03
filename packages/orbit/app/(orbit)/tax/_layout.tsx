import { Stack } from 'expo-router';
import { useTheme } from '@oxy.so/bloom/theme';

/** The Tax workspace (ADR 0020): one page per section, stacked inside the one Tax destination. */
export default function TaxLayout() {
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
