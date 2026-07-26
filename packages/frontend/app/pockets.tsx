/**
 * Pockets home — Revolut-style cards screen. Header, a total-across-pockets
 * hero, the Pocket card list (image avatar + optional goal bar), and a
 * dashed "New pocket" row. Tapping a card opens that Pocket's detail sheet
 * (`PocketDetailSheet`), which owns its own Move/Add/Switch/Manage flows.
 * Presented as a modal from the home pill's "Manage pockets" row.
 */

import { useCallback, useState } from "react";
import { View, Text, ScrollView, Pressable, ActivityIndicator } from "react-native";
import { SafeAreaView } from "../src/ui/safe-area-view";
import { useRouter, useFocusEffect } from "expo-router";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useWalletStore } from "../src/wallet/wallet-store";
import { useTheme } from "@oxyhq/bloom/theme";
import { Dialog, useDialogControl } from "@oxyhq/bloom/dialog";
import { AmountText, EmptyState, PocketCard, ScreenHeader } from "../src/ui/components";
import { MovePocketSheet } from "../src/ui/sheets/MovePocketSheet";
import { PocketFormSheet } from "../src/ui/sheets/PocketFormSheet";
import { PocketDetailSheet } from "../src/ui/sheets/PocketDetailSheet";
import { t } from "../src/i18n";

const SECTION_LABEL =
  "text-muted-foreground text-xs font-semibold uppercase tracking-wider";

export default function PocketsScreen() {
  const router = useRouter();
  const theme = useTheme();
  const pockets = useWalletStore((s) => s.pockets);
  const pocketBalances = useWalletStore((s) => s.pocketBalances);
  const isWatchOnly = useWalletStore((s) => s.isWatchOnly);
  const loading = useWalletStore((s) => s.loading);
  const loadPockets = useWalletStore((s) => s.loadPockets);

  const [detailAccount, setDetailAccount] = useState<number | null>(null);
  const createControl = useDialogControl();
  const moveControl = useDialogControl();
  const detailControl = useDialogControl();

  const openDetail = useCallback(
    (account: number) => {
      setDetailAccount(account);
      detailControl.open();
    },
    [detailControl],
  );

  useFocusEffect(
    useCallback(() => {
      loadPockets();
    }, [loadPockets]),
  );

  if (isWatchOnly) {
    return (
      <SafeAreaView
        className="flex-1 bg-background"
        edges={["top", "bottom", "left", "right"]}
      >
        <ScreenHeader title={t("pockets.title")} onBack={() => router.back()} />
        <View className="flex-1 items-center justify-center px-6">
          <EmptyState
            icon="lock"
            title={t("pockets.watchOnly.title")}
            subtitle={t("pockets.watchOnly.subtitle")}
          />
        </View>
      </SafeAreaView>
    );
  }

  if (loading) {
    return (
      <SafeAreaView
        className="flex-1 bg-background items-center justify-center"
        edges={["top", "bottom", "left", "right"]}
      >
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </SafeAreaView>
    );
  }

  const total = Object.values(pocketBalances).reduce((sum, v) => sum + v, 0n);
  const countLabel =
    pockets.length === 1
      ? t("pockets.subtitle.one", { count: pockets.length })
      : t("pockets.subtitle.other", { count: pockets.length });

  return (
    <SafeAreaView
      className="flex-1 bg-background"
      edges={["top", "bottom", "left", "right"]}
    >
      <ScreenHeader
        title={t("pockets.title")}
        onBack={() => router.back()}
        rightAction={
          <Pressable
            onPress={() => createControl.open()}
            className="w-9 h-9 rounded-full bg-surface items-center justify-center active:opacity-70"
            accessibilityRole="button"
            accessibilityLabel={t("pockets.createCta")}
          >
            <MaterialCommunityIcons name="plus" size={20} color={theme.colors.text} />
          </Pressable>
        }
      />
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-5 pt-2 pb-8"
        showsVerticalScrollIndicator={false}
      >
        {/* Total across pockets */}
        <View className="mb-6">
          <Text className={SECTION_LABEL}>{t("pockets.total.label")}</Text>
          <AmountText
            value={total}
            suffix=" FAIR"
            className="text-foreground text-4xl font-bold mt-1"
          />
          <Text className="text-muted-foreground text-sm mt-1.5">{countLabel}</Text>
        </View>

        {/* Section header + quick move link */}
        <View className="flex-row items-center justify-between mb-3">
          <Text className={SECTION_LABEL}>{t("pockets.yourPockets")}</Text>
          <Pressable onPress={() => moveControl.open()}>
            <Text className="text-primary text-[13px] font-semibold">
              {t("pockets.moveLink")}
            </Text>
          </Pressable>
        </View>

        {/* Pocket cards */}
        <View>
          {pockets.map((pocket) => (
            <PocketCard
              key={pocket.account}
              pocket={pocket}
              balance={pocketBalances[pocket.account] ?? 0n}
              onPress={() => openDetail(pocket.account)}
            />
          ))}
        </View>

        {/* New pocket — dashed CTA */}
        <Pressable
          onPress={() => createControl.open()}
          className="flex-row items-center gap-3.5 rounded-2xl px-4 py-3.5 mt-1 border-[1.5px] border-dashed border-border active:opacity-70"
        >
          <View className="w-12 h-12 rounded-2xl items-center justify-center bg-primary/10">
            <MaterialCommunityIcons name="plus" size={22} color={theme.colors.primary} />
          </View>
          <View>
            <Text className="text-foreground text-[15px] font-semibold">
              {t("pockets.createCta")}
            </Text>
            <Text className="text-muted-foreground text-xs mt-0.5">
              {t("pockets.create.subtitle")}
            </Text>
          </View>
        </Pressable>
      </ScrollView>

      {/* Create pocket */}
      <Dialog control={createControl} placement="bottom" title={t("pockets.create.title")}>
        <PocketFormSheet target={null} onDone={() => createControl.close()} />
      </Dialog>

      {/* Quick move */}
      <Dialog control={moveControl} placement="bottom" title={t("pockets.move.title")}>
        <MovePocketSheet onDone={() => moveControl.close()} />
      </Dialog>

      {/* Pocket detail — keyed by account so switching which Pocket is being
          viewed forces a full remount: its own nested Move/Edit sheets seed
          `useState` from props once at mount (see their file docs), so
          without this key they'd keep showing the FIRST-viewed Pocket's
          context after tapping a different card. */}
      <Dialog
        control={detailControl}
        placement="bottom"
        title=""
      >
        {detailAccount !== null ? (
          <PocketDetailSheet
            key={detailAccount}
            account={detailAccount}
            onDone={() => detailControl.close()}
          />
        ) : null}
      </Dialog>
    </SafeAreaView>
  );
}
