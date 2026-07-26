/**
 * Chain / Network Status screen.
 *
 * Surfaces blockchain-level information that is otherwise hidden inside the
 * SPV client: sync state, network (mainnet/testnet), block height, peer
 * count, sync progress, and the timestamp of the last known block header.
 *
 * Presented as a modal from the Settings screen. The "Connected peers" row
 * navigates to the existing peers screen for full peer details.
 */

import { useCallback, useMemo, useState } from "react";
import Animated from "react-native-reanimated";
import { View, Text, Pressable } from "react-native";
import { SafeAreaView } from "../src/ui/safe-area-view";
import { useFocusEffect, useRouter } from "expo-router";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useBloomTheme } from "@oxyhq/bloom/theme";
import { useWalletStore, getDatabase } from "../src/wallet/wallet-store";
import { ListItem, ScreenHeader } from "../src/ui/components";
import { RefreshRainbowBar } from "../src/ui/components/RefreshRainbowBar";
import { usePullToRefreshBand } from "../src/hooks/usePullToRefreshBand";
import { GestureDetector } from "react-native-gesture-handler";
import { t } from "../src/i18n";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SyncVariant = "success" | "warning" | "error";

interface SyncState {
  label: string;
  variant: SyncVariant;
  /** Tailwind background class for the state dot. */
  dot: string;
  /** Tailwind text colour class for the state label. */
  text: string;
}

/** Uppercase section header — matches the redesigned Settings screen. */
const SECTION_LABEL =
  "text-muted-foreground text-xs font-semibold uppercase tracking-wider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format an integer with locale thousands separators. Returns an em-dash
 * when the value is zero, to match the existing peers screen convention. */
function formatHeight(height: number): string {
  if (height <= 0) return "\u2014";
  return height.toLocaleString();
}

/** Format a unix timestamp (seconds) as a human-readable relative time. */
function formatRelativeTime(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 0) return t("chain.time.justNow");
  if (diff < 60) return t("chain.time.justNow");
  if (diff < 3600) {
    return t("chain.time.minutesAgo", { count: Math.floor(diff / 60) });
  }
  if (diff < 86400) {
    return t("chain.time.hoursAgo", { count: Math.floor(diff / 3600) });
  }
  return t("chain.time.daysAgo", { count: Math.floor(diff / 86400) });
}

// ---------------------------------------------------------------------------
// Settings section — an uppercase label above a card-less group of rows on a
// subtle bordered surface with hairline dividers (matches the Settings screen).
// ---------------------------------------------------------------------------

function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View className="mb-6">
      {/* Full-bleed rows: the label carries px-4 so it aligns with the row
          content, which Bloom's Item pads 16px internally. */}
      <Text className={`${SECTION_LABEL} mb-1 px-4`}>{title}</Text>
      <View>
        {children}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function ChainScreen() {
  const router = useRouter();
  const { theme: { colors: themeColors } } = useBloomTheme();

  const network = useWalletStore((s) => s.network);
  const chainHeight = useWalletStore((s) => s.chainHeight);
  const isSyncing = useWalletStore((s) => s.isSyncing);
  const syncProgress = useWalletStore((s) => s.syncProgress);
  const connectedPeers = useWalletStore((s) => s.connectedPeers);
  const networkStatusKey = useWalletStore((s) => s.networkStatusKey);
  const networkStatusData = useWalletStore((s) => s.networkStatusData);
  const refreshBalance = useWalletStore((s) => s.refreshBalance);
  const rescanWallet = useWalletStore((s) => s.rescanWallet);
  // Translate at render-time so a language switch updates the line without
  // requiring the store to re-emit the status (U-2).
  const networkStatusLabel = t(networkStatusKey, networkStatusData);



  const [lastBlockTimestamp, setLastBlockTimestamp] = useState<number | null>(
    null,
  );

  // Load the latest known block header timestamp whenever the screen gains
  // focus. The SPV client writes headers to the database as they arrive, so
  // this reflects the most recent block the wallet has seen.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      const db = getDatabase();
      if (!db) {
        setLastBlockTimestamp(null);
        return;
      }
      db.getLatestHeader()
        .then((header) => {
          if (cancelled) return;
          setLastBlockTimestamp(header ? header.timestamp : null);
        })
        .catch(() => {
          // Reading the latest header is a best-effort UI decoration; if the
          // query fails (e.g. DB temporarily locked), render the "unknown"
          // placeholder instead of propagating an error.
          if (cancelled) return;
          setLastBlockTimestamp(null);
        });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  // ---- Derived sync state (color + label) ----
  const syncState = useMemo<SyncState>(() => {
    if (connectedPeers === 0) {
      return {
        label: t("chain.sync.offline"),
        variant: "error",
        dot: "bg-red-400",
        text: "text-red-400",
      };
    }
    if (isSyncing) {
      return {
        label: t("chain.sync.syncing", { progress: Math.round(syncProgress) }),
        variant: "warning",
        dot: "bg-yellow-400",
        text: "text-yellow-400",
      };
    }
    return {
      label: t("chain.sync.synced"),
      variant: "success",
      dot: "bg-primary",
      text: "text-primary",
    };
  }, [connectedPeers, isSyncing, syncProgress]);

  // ---- Display values ----
  const networkLabel =
    network === "testnet" ? t("chain.testnet") : t("chain.mainnet");
  const blockHeightLabel = formatHeight(chainHeight);
  const peersLabel =
    connectedPeers === 1
      ? t("chain.peers.one", { count: connectedPeers })
      : t("chain.peers.other", { count: connectedPeers });
  const syncProgressLabel = isSyncing
    ? t("chain.syncProgress.value", { progress: Math.round(syncProgress) })
    : t("chain.syncProgress.idle");
  const lastBlockLabel =
    lastBlockTimestamp !== null
      ? formatRelativeTime(lastBlockTimestamp)
      : t("chain.lastBlock.unknown");

  const handleGoToPeers = useCallback(() => {
    router.push("/peers");
  }, [router]);

  // N-4: refreshing this screen triggers a real historical rescan via the SPV
  // client, not just an in-memory balance re-read. A user who reports "I'm
  // missing a tx" needs something that actually re-asks peers for matched
  // merkle blocks; that's `rescanWallet`. Best-effort: a failed rescan does not
  // crash the screen — the next tip advance retries.
  const handleRefresh = useCallback(async () => {
    try {
      await rescanWallet();
    } catch {
      // best-effort
    } finally {
      refreshBalance();
    }
  }, [rescanWallet, refreshBalance]);

  // Both entry points — the header icon and a pull at the top of the list —
  // share one implementation with the Home screen.
  const { gesture, scrollHandler, bandStyle, trigger, refreshing } =
    usePullToRefreshBand(handleRefresh);

  return (
    <SafeAreaView
      className="flex-1 bg-background"
      edges={["top", "bottom", "left", "right"]}
    >
      <ScreenHeader
        title={t("chain.title")}
        onBack={() => router.back()}
        rightAction={
          <Pressable
            onPress={trigger}
            disabled={refreshing}
            accessibilityLabel={t("chain.refresh")}
            accessibilityRole="button"
            accessibilityState={{ disabled: refreshing }}
            className="w-11 h-11 items-center justify-center rounded-full active:bg-surface"
          >
            <MaterialCommunityIcons
              name="refresh"
              size={22}
              color={refreshing ? themeColors.primary : themeColors.text}
            />
          </Pressable>
        }
      />

      {/* Refresh rainbow band — clipped to the animated height, exactly as the
          Home screen reveals it on pull. */}
      <Animated.View style={[bandStyle, { overflow: "hidden" }]}>
        <RefreshRainbowBar />
      </Animated.View>

      <GestureDetector gesture={gesture}>
        <Animated.ScrollView
          className="flex-1"
          onScroll={scrollHandler}
          scrollEventThrottle={16}
          contentContainerClassName="pt-3 pb-10"
          showsVerticalScrollIndicator={false}
        >
        {/* ---- Status line ---- A dot + label in the screen's own type scale,
             not a coloured card: the rest of this screen is flat rows on the
             background, and a filled, bordered block read as a foreign element
             pasted on top. Colour is carried by the dot and the label alone. */}
        <View className="px-4 pb-4">
          <View className="flex-row items-center">
            <View className={`w-2 h-2 rounded-full ${syncState.dot} mr-2.5`} />
            <Text
              className={`text-[15px] font-semibold ${syncState.text}`}
              numberOfLines={1}
            >
              {syncState.label}
            </Text>
          </View>
          <Text className="text-muted-foreground text-[13px] mt-1" numberOfLines={2}>
            {networkStatusLabel}
          </Text>

          {/* Hairline progress, only while actively syncing. */}
          {isSyncing ? (
            <View className="h-0.5 bg-border rounded-full overflow-hidden mt-3">
              <View
                className="h-full bg-primary rounded-full"
                style={{ width: `${Math.min(100, Math.max(0, syncProgress))}%` }}
              />
            </View>
          ) : null}
        </View>

        <View className="h-px bg-border mb-5" />

        {/* ---- Network info group ---- */}
        <SettingsSection title={t("chain.group.network")}>
          <ListItem
            title={t("chain.row.network")}
            value={networkLabel}
            icon="earth"
            iconColor={themeColors.primary}
            iconBg="bg-primary/10"
            showChevron={false}
          />
          <ListItem
            title={t("chain.row.blockHeight")}
            value={blockHeightLabel}
            icon="cube-outline"
            iconColor={themeColors.primary}
            iconBg="bg-primary/10"
            showChevron={false}
          />
          <ListItem
            title={t("chain.row.connectedPeers")}
            value={peersLabel}
            icon="server-network"
            iconColor={themeColors.primary}
            iconBg="bg-primary/10"
            onPress={handleGoToPeers}
          />
          <ListItem
            title={t("chain.row.syncProgress")}
            value={syncProgressLabel}
            icon="progress-download"
            iconColor={themeColors.primary}
            iconBg="bg-primary/10"
            showChevron={false}
          />
          <ListItem
            title={t("chain.row.lastBlock")}
            value={lastBlockLabel}
            icon="clock-outline"
            iconColor={themeColors.primary}
            iconBg="bg-primary/10"
            showChevron={false}
            isLast
          />
        </SettingsSection>

        </Animated.ScrollView>
      </GestureDetector>
    </SafeAreaView>
  );
}
