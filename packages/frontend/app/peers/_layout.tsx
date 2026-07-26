/**
 * Peers group layout — Stack navigator for peers list + add peer subscreen.
 */

import { Stack } from "expo-router";
import { useTheme } from "@oxyhq/bloom/theme";

export default function PeersLayout() {
  const theme = useTheme();

  return (
    <Stack
      screenOptions={{
        // No native header — each screen renders its own SafeAreaView +
        // ScreenHeader, matching every other stack screen (chain, masternode,
        // …) so the scroll/inset behavior is identical across the app.
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.background },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="add" />
    </Stack>
  );
}
