/**
 * Stack layout for the Buy-FAIR detail flow (post-quote screens).
 *
 * The Buy tab itself lives at `/(tabs)/buy` (URL `/buy`). This sibling
 * `/buy/*` directory hosts the screens the tab pushes onto the navigation
 * tree (currently just `quote.tsx` at `/buy/quote`, with room for a CARD
 * webview wrapper in a follow-up). Expo-router resolves the tab and the
 * `/buy/*` children as distinct URLs.
 */

import { useMemo } from "react";
import { Stack } from "expo-router";
import { useTheme } from "@oxy.so/bloom/theme";

export default function BuyLayout() {
  const theme = useTheme();

  const screenOptions = useMemo(
    () => ({
      headerShown: false,
      contentStyle: { backgroundColor: theme.colors.background },
    }),
    [theme],
  );

  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name="quote" />
    </Stack>
  );
}
