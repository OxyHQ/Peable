/**
 * Transaction detail route — a thin wrapper around {@link TransactionDetailSheet}.
 *
 * The detail UI + logic live in the content-only sheet so the SAME body renders
 * inside a bottom-sheet `<Dialog>` (tapping a transaction row) AND as this
 * standalone route. This wrapper owns only the screen chrome the sheet omits:
 * the safe area, the header (title + back), horizontal padding and the scroll.
 */

import { ScrollView } from "react-native";
import { SafeAreaView } from "../../src/ui/safe-area-view";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ScreenHeader } from "../../src/ui/components";
import { TransactionDetailSheet } from "../../src/ui/sheets/TransactionDetailSheet";
import { t } from "../../src/i18n";

export default function TransactionDetailScreen() {
  const router = useRouter();
  const { txid } = useLocalSearchParams<{ txid: string }>();

  return (
    <SafeAreaView
      className="flex-1 bg-background"
      edges={["top", "bottom", "left", "right"]}
    >
      <ScreenHeader
        title={t("transaction.title")}
        onBack={() => router.back()}
      />
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-5 pt-4 pb-8"
        showsVerticalScrollIndicator={false}
      >
        <TransactionDetailSheet txid={txid} />
      </ScrollView>
    </SafeAreaView>
  );
}
