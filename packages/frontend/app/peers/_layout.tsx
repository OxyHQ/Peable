/**
 * Peers group layout — Stack navigator for peers list + add peer subscreen.
 */

import { Stack } from "expo-router";
import { useTheme } from "@oxy.so/bloom/theme";
import { t } from "../../src/i18n";

export default function PeersLayout() {
  const theme = useTheme();

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.card },
        headerTintColor: theme.colors.tint,
        headerTitleStyle: { color: theme.colors.text },
        contentStyle: { backgroundColor: theme.colors.background },
      }}
    >
      <Stack.Screen
        name="index"
        options={{ title: t("peers.title") }}
      />
      <Stack.Screen
        name="add"
        options={{ title: t("peers.add.title") }}
      />
    </Stack>
  );
}
