import { Stack } from 'expo-router';
import { useTheme } from '@oxy.so/bloom/theme';

/** Risk rules is a list, a new rule and a rule, stacked inside the one Risk rules tab. */
export default function RiskRulesLayout() {
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
