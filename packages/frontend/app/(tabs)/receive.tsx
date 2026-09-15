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
import { useTabScreenBottomInset } from "../../src/ui/navigation/tabs";
import { ReceiveSheet } from "../../src/ui/sheets/ReceiveSheet";
import { ReadOnlyReceiveView } from "../../src/ui/components/ReadOnlyWalletView";
import { useWalletCapability } from "../../src/wallet/use-wallet-capability";

export default function ReceiveScreen() {
  const insets = useSafeAreaInsets();
  // Without a wallet there are no derived addresses to show; the profile code
  // needs only the handle, and is what a read-only host can offer.
  const readOnly = useWalletCapability() === "read-only";
  const bottomInset = useTabScreenBottomInset();

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingBottom: bottomInset + 24,
          paddingHorizontal: 16,
        }}
        showsVerticalScrollIndicator={false}
      >
        {readOnly ? <ReadOnlyReceiveView /> : <ReceiveSheet />}
      </ScrollView>
    </View>
  );
}
