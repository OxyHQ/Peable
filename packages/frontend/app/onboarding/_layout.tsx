/**
 * Onboarding stack layout.
 * Dark theme with green back button, transparent headers.
 */

import { useMemo } from "react";
import { Stack } from "expo-router";
import { useTheme } from "@oxy.so/bloom/theme";

export default function OnboardingLayout() {
  const theme = useTheme();

  const screenOptions = useMemo(
    () => ({
      headerStyle: { backgroundColor: "transparent" },
      headerTintColor: theme.colors.primary,
      headerTitleStyle: { color: theme.colors.text },
      headerTransparent: true,
      contentStyle: { backgroundColor: theme.colors.background },
      headerShadowVisible: false,
    }),
    [theme],
  );

  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name="pin-setup" options={{ title: "", headerBackVisible: false }} />
    </Stack>
  );
}
