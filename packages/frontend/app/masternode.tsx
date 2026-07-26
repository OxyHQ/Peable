/**
 * Masternode management screen.
 *
 * Lists eligible collateral UTXOs (5,000 FAIR) and masternode status so the
 * user can prepare collateral. Actually STARTING a masternode requires
 * broadcasting a signed masternode announcement (mnb) over the FairCoin P2P
 * network, which the SPV client does not yet implement. Rather than fake a
 * success dialog for something that never happened (review finding H3), the
 * start action is disabled and clearly labelled "coming soon", and tapping it
 * explains what remains.
 */

import { useCallback } from "react";
import { View, Text } from "react-native";
import { SafeAreaView } from "../src/ui/safe-area-view";
import { useFocusEffect, useRouter } from "expo-router";
import { GestureDetector } from "react-native-gesture-handler";
import Animated from "react-native-reanimated";
import { useWalletStore } from "../src/wallet/wallet-store";
import {
  ListItem,
  Button,
  Badge,
  EmptyState,
  ScreenHeader,
} from "../src/ui/components";
import { useTheme } from "@oxyhq/bloom/theme";
import { Dialog, useDialogControl } from "@oxyhq/bloom/dialog";
import { RefreshRainbowBar } from "../src/ui/components/RefreshRainbowBar";
import { usePullToRefreshBand } from "../src/hooks/usePullToRefreshBand";
import { t } from "../src/i18n";

/** Uppercase section label — matches the home screen's section headers. */
const SECTION_LABEL =
  "text-muted-foreground text-xs font-semibold uppercase tracking-wider";

function truncateTxid(txid: string): string {
  if (txid.length <= 20) return txid;
  return `${txid.slice(0, 10)}...${txid.slice(-10)}`;
}

export default function MasternodeScreen() {
  const router = useRouter();
  const masternodeUTXOs = useWalletStore((s) => s.masternodeUTXOs);
  const refreshMasternodeUTXOs = useWalletStore(
    (s) => s.refreshMasternodeUTXOs,
  );
  const theme = useTheme();

  // Masternode start is not yet implemented (no P2P mnb relay). Tapping the
  // action explains this instead of pretending the broadcast succeeded.
  const notAvailableControl = useDialogControl();

  useFocusEffect(
    useCallback(() => {
      refreshMasternodeUTXOs();
    }, [refreshMasternodeUTXOs]),
  );

  // Pull down to re-check which UTXOs still meet the collateral requirement.
  const { gesture, scrollHandler, bandStyle } = usePullToRefreshBand(
    refreshMasternodeUTXOs,
  );

  const eligibleUtxos = masternodeUTXOs;

  const handleStartMasternode = useCallback(() => {
    notAvailableControl.open();
  }, [notAvailableControl]);

  return (
    <SafeAreaView
      className="flex-1 bg-background"
      edges={["top", "bottom", "left", "right"]}
    >
      <ScreenHeader title={t("masternode.title")} onBack={() => router.back()} />
      <Animated.View style={[bandStyle, { overflow: "hidden" }]}>
        <RefreshRainbowBar />
      </Animated.View>

      <GestureDetector gesture={gesture}>
        <Animated.ScrollView
          className="flex-1"
          onScroll={scrollHandler}
          scrollEventThrottle={16}
          contentContainerClassName="px-5 pt-4 pb-10"
          showsVerticalScrollIndicator={false}
        >
        {/* Requirements — card-less: section label above a muted description */}
        <View>
          <Text className={SECTION_LABEL}>
            {t("masternode.requirements.title")}
          </Text>
          <Text className="text-muted-foreground text-sm leading-5 mt-2">
            {t("masternode.requirements.description")}
          </Text>
        </View>

        <View className="h-px bg-border my-7" />

        {/* Eligible UTXOs — grouped rows inside a raised surface, hairline
            dividers between rows (the ListItem handles those). */}
        <View>
          <Text className={SECTION_LABEL}>{t("masternode.candidates")}</Text>
          {eligibleUtxos.length === 0 ? (
            <View className="mt-2">
              <EmptyState
                icon="server"
                title={t("masternode.empty.title")}
                subtitle={t("masternode.empty.subtitle")}
              />
            </View>
          ) : (
            <View className="mt-2">
              {eligibleUtxos.map((utxo, idx) => {
                const confirmOk = utxo.confirmations >= 15;
                return (
                  <ListItem
                    key={`${utxo.txid}-${utxo.vout}`}
                    icon="server"
                    iconBg={confirmOk ? "bg-primary/10" : "bg-yellow-500/10"}
                    iconColor={
                      confirmOk ? theme.colors.success : theme.colors.warning
                    }
                    title={truncateTxid(utxo.txid)}
                    subtitle={`${utxo.address.slice(0, 8)}...${utxo.address.slice(-6)}`}
                    value="5,000 FAIR"
                    isLast={idx === eligibleUtxos.length - 1}
                    trailing={
                      <Badge
                        text={`${utxo.confirmations}/15`}
                        variant={confirmOk ? "success" : "warning"}
                        size="sm"
                      />
                    }
                  />
                );
              })}
            </View>
          )}
        </View>

        {/* Start masternode — performs no broadcast (P2P mnb relay is not yet
            implemented). Tapping explains this honestly; the badge marks it as
            unavailable. No fake "broadcast sent" success is shown. */}
        <View className="mt-8">
          <Button
            title={t("masternode.startCta")}
            onPress={handleStartMasternode}
            variant="secondary"
          />
          <View className="flex-row justify-center mt-3">
            <Badge
              text={t("masternode.notAvailableBadge")}
              variant="warning"
              size="sm"
            />
          </View>
        </View>
        </Animated.ScrollView>
      </GestureDetector>

      {/* Not-yet-available prompt: honest status instead of a fake success. */}
      <Dialog
        control={notAvailableControl}
        placement="bottom"
        title={t("masternode.notAvailable.title")}
        description={t("masternode.notAvailable.description")}
        actions={[{ label: t("common.ok") }]}
      />
    </SafeAreaView>
  );
}
