/**
 * Receive screen.
 *
 * Thin route wrapper: the entire receive UI + logic lives in {@link ReceiveSheet}
 * so the same body can be shown inside a Bloom bottom-sheet on the home screen.
 * Here it renders as a full screen — safe-area top, horizontal padding, and its
 * own scroll — while the standalone route still owns that chrome.
 */

import { View, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ReceiveSheet } from "../../src/ui/sheets/ReceiveSheet";

export default function ReceiveScreen() {
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingBottom: insets.bottom + 24,
          paddingHorizontal: 16,
        }}
        showsVerticalScrollIndicator={false}
      >
        <ReceiveSheet />
      </ScrollView>
    </View>
  );
}
