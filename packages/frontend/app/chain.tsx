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
import { View, Text, ScrollView } from "react-native";
import { SafeAreaView } from "../src/ui/safe-area-view";
import { useFocusEffect, useRouter } from "expo-router";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useBloomTheme } from "@oxy.so/bloom/theme";
import { useWalletStore, getDatabase } from "../src/wallet/wallet-store";
import { Button, ListItem, ScreenHeader } from "../src/ui/components";
import { t } from "../src/i18n";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SyncVariant = "success" | "warning" | "error";

interface SyncState {
  label: string;
  variant: SyncVariant;
  dot: string;
  bg: string;
  border: string;
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

  const [refreshing, setRefreshing] = useState(false);

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
        bg: "bg-red-500/10",
        border: "border-red-500/30",
        text: "text-red-400",
      };
    }
    if (isSyncing) {
      return {
        label: t("chain.sync.syncing", { progress: Math.round(syncProgress) }),
        variant: "warning",
        dot: "bg-yellow-400",
        bg: "bg-yellow-500/10",
        border: "border-yellow-500/30",
        text: "text-yellow-400",
      };
    }
    return {
      label: t("chain.sync.synced"),
      variant: "success",
      dot: "bg-primary",
      bg: "bg-primary/10",
      border: "border-primary/30",
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

  // N-4: the "Refresh" button on the Chain screen now triggers a real
  // historical rescan via the SPV client, not just an in-memory balance
  // re-read. A user who reports "I'm missing a tx" needs SOMETHING that
  // actually re-asks peers for matched merkle blocks; that's `rescanWallet`.
  // Best-effort: a failed rescan does not crash the screen — the SPV client
  // logs the cause and the next tip advance retries.
  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await rescanWallet();
    } catch {
      // best-effort
    } finally {
      refreshBalance();
      setRefreshing(false);
    }
  }, [refreshing, rescanWallet, refreshBalance]);

  return (
    <SafeAreaView
      className="flex-1 bg-background"
      edges={["top", "bottom", "left", "right"]}
    >
      <ScreenHeader title={t("chain.title")} onBack={() => router.back()} />

      <ScrollView
        className="flex-1"
        contentContainerClassName="pt-3 pb-10"
        showsVerticalScrollIndicator={false}
      >
        {/* ---- Status pill card ---- (non-row block: keeps its own side inset) */}
        <View
          className={`rounded-2xl p-5 border mb-6 mx-4 ${syncState.border} ${syncState.bg}`}
        >
          <View className="flex-row items-center">
            <View className={`w-3 h-3 rounded-full ${syncState.dot} mr-3`} />
            <View className="flex-1">
              <Text
                className={`text-base font-semibold ${syncState.text}`}
                numberOfLines={1}
              >
                {syncState.label}
              </Text>
              <Text
                className="text-muted-foreground text-xs mt-1"
                numberOfLines={2}
              >
                {networkStatusLabel}
              </Text>
            </View>
          </View>

          {/* Progress bar shown while actively syncing */}
          {isSyncing ? (
            <View className="mt-4">
              <View className="h-1 bg-border rounded-full overflow-hidden">
                <View
                  className="h-full bg-primary rounded-full"
                  style={{
                    width: `${Math.min(100, Math.max(0, syncProgress))}%`,
                  }}
                />
              </View>
            </View>
          ) : null}
        </View>

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

        {/* ---- Refresh button ---- (non-row block: keeps its own side inset) */}
        <View className="px-4">
          <Button
            title={t("chain.refresh")}
            onPress={handleRefresh}
            variant="outline"
            icon={
              <MaterialCommunityIcons
                name="refresh"
                size={18}
                color={themeColors.primary}
              />
            }
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
