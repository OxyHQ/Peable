/**
 * Pocket switcher sheet content.
 *
 * Content-only body for a quick Pocket switch, rendered inside a Bloom
 * bottom-sheet `<Dialog placement="bottom">` opened from the home header.
 * It renders NO full-screen wrapper, NO safe-area padding, and NO scroll
 * container of its own — the host `<Dialog>` supplies its own internal
 * scroll.
 *
 * Tapping a non-active Pocket switches to it and closes the sheet; the active
 * one just closes. A bottom "Manage pockets" row closes the sheet and opens
 * the full `app/pockets.tsx` management screen.
 */

import type React from "react";
import { useCallback, useState } from "react";
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useTheme } from "@oxy.so/bloom/theme";
import { useWalletStore } from "../../wallet/wallet-store";
import { MAIN_POCKET_ACCOUNT } from "../../wallet/pockets";
import { ListItem, AmountText } from "../components";
import { t } from "../../i18n";

/** ~16% alpha, matching PocketCard's chip tint. */
const CHIP_TINT_ALPHA = "29";

const CONTENT_MAX_WIDTH = 500;

export function PocketSwitcherSheet({
  onDone,
}: {
  onDone: () => void;
}): React.JSX.Element {
  const pockets = useWalletStore((s) => s.pockets);
  const activeAccount = useWalletStore((s) => s.activeAccount);
  const pocketBalances = useWalletStore((s) => s.pocketBalances);
  const switchPocket = useWalletStore((s) => s.switchPocket);
  const loadPockets = useWalletStore((s) => s.loadPockets);
  const theme = useTheme();
  const router = useRouter();

  // Account of the Pocket currently being switched to. Drives the per-row
  // spinner and gates concurrent taps so a double-press can't kick off two
  // switches (the store serialises internally, but blocking here keeps the
  // UI honest).
  const [switchingAccount, setSwitchingAccount] = useState<number | null>(
    null,
  );

  const handleSelect = useCallback(
    async (account: number) => {
      if (switchingAccount !== null) return;
      if (account === activeAccount) {
        onDone();
        return;
      }
      setSwitchingAccount(account);
      await switchPocket(account);
      onDone();
    },
    [switchingAccount, activeAccount, switchPocket, onDone],
  );

  const handleManage = useCallback(() => {
    onDone();
    router.push("/pockets");
  }, [onDone, router]);

  return (
    <View
      className="w-full self-center gap-4"
      style={{ maxWidth: CONTENT_MAX_WIDTH }}
      // Refresh balances every time the sheet mounts (a Move since the last
      // open would otherwise show stale numbers). Piggybacks on layout rather
      // than a mount `useEffect`, matching SendSheet's `onLayout={loadInitialData}`
      // convention for content-only sheet bodies.
      onLayout={() => loadPockets()}
    >
      {/* Pocket list — card-less surface container, one row per Pocket with
          its own emoji chip in its accent color (matches PocketCard). */}
      <View className="bg-surface rounded-2xl overflow-hidden">
        {pockets.map((pocket, idx) => {
          const isActive = pocket.account === activeAccount;
          const isSwitching = pocket.account === switchingAccount;
          const label =
            pocket.account === MAIN_POCKET_ACCOUNT
              ? t("pockets.mainName")
              : pocket.name;
          return (
            <Pressable
              key={pocket.account}
              onPress={() => handleSelect(pocket.account)}
              className="flex-row items-center px-4 py-3 active:opacity-70"
              style={
                idx === pockets.length - 1
                  ? undefined
                  : { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border }
              }
            >
              <View
                className="w-9 h-9 rounded-full items-center justify-center mr-3"
                style={{ backgroundColor: `${pocket.color}${CHIP_TINT_ALPHA}` }}
              >
                <Text style={{ fontSize: 16 }}>{pocket.emoji}</Text>
              </View>
              <Text className="text-foreground text-base font-medium flex-1" numberOfLines={1}>
                {label}
              </Text>
              {isSwitching ? (
                <ActivityIndicator size="small" color={theme.colors.primary} />
              ) : (
                <View className="flex-row items-center gap-2">
                  <AmountText
                    value={pocketBalances[pocket.account] ?? 0n}
                    className="text-muted-foreground text-sm"
                  />
                  {isActive ? (
                    <MaterialCommunityIcons
                      name="check-circle"
                      size={22}
                      color={theme.colors.success}
                    />
                  ) : null}
                </View>
              )}
            </Pressable>
          );
        })}
      </View>

      {/* Manage pockets — jumps to the full management screen */}
      <View className="bg-surface rounded-2xl overflow-hidden">
        <ListItem
          icon="cog-outline"
          title={t("pockets.manage")}
          onPress={handleManage}
          isLast
        />
      </View>
    </View>
  );
}
