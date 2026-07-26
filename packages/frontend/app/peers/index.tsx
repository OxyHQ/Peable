/**
 * Network Peers screen — shows connection status, network stats, known peers,
 * and DNS seeds.
 *
 * Card-less / borderless aesthetic matching the home screen: a status hero
 * (colored dot + big status word), label/value stat rows, hairline dividers,
 * and borderless `bg-surface` list containers. "Add Peer" navigates to a
 * dedicated subscreen.
 */

import { useCallback, useMemo, useState } from "react";
import { View, Text } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import Animated from "react-native-reanimated";
import { useFocusEffect, useRouter } from "expo-router";
import { useWalletStore, getDatabase } from "../../src/wallet/wallet-store";
import type { PeerRow } from "../../src/storage/database";
import { EmptyState, ScreenHeader } from "../../src/ui/components";
import { SafeAreaView } from "../../src/ui/safe-area-view";
import { Button } from "../../src/ui/components/Button";
import { RefreshRainbowBar } from "../../src/ui/components/RefreshRainbowBar";
import { usePullToRefreshBand } from "../../src/hooks/usePullToRefreshBand";
import { t } from "../../src/i18n";

const DNS_SEEDS = [
  { host: "seed1.fairco.in", port: 46372 },
  { host: "seed2.fairco.in", port: 46372 },
] as const;

/** Uppercase section label — matches the home screen's section headers. */
const SECTION_LABEL =
  "text-muted-foreground text-xs font-semibold uppercase tracking-wider";

function getServiceLabels(services: number): string[] {
  const labels: string[] = [];
  if (services & 1) labels.push("NODE_NETWORK");
  if (services & 2) labels.push("NODE_GETUTXO");
  if (services & 4) labels.push("NODE_BLOOM");
  if (services & 8) labels.push("NODE_WITNESS");
  if (labels.length === 0) labels.push("NONE");
  return labels;
}

function formatLastSeen(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;
  if (diff < 60) return t("peers.lastSeen.justNow");
  if (diff < 3600) return t("peers.lastSeen.minutes", { count: Math.floor(diff / 60) });
  if (diff < 86400) return t("peers.lastSeen.hours", { count: Math.floor(diff / 3600) });
  return t("peers.lastSeen.days", { count: Math.floor(diff / 86400) });
}

/** A labelled key/value row (label left, value right) — no box, no border. */
function StatRow({
  label,
  value,
  valueClassName = "text-foreground text-[15px] font-semibold",
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <View className="flex-row items-center justify-between py-3">
      <Text className="text-muted-foreground text-[15px]">{label}</Text>
      <Text className={valueClassName}>{value}</Text>
    </View>
  );
}

export default function PeersScreen() {
  const router = useRouter();
  const connectedPeers = useWalletStore((s) => s.connectedPeers);
  const chainHeight = useWalletStore((s) => s.chainHeight);
  const isSyncing = useWalletStore((s) => s.isSyncing);
  const syncProgress = useWalletStore((s) => s.syncProgress);
  const network = useWalletStore((s) => s.network);

  const [peers, setPeers] = useState<PeerRow[]>([]);

  const loadPeers = useCallback(() => {
    const db = getDatabase();
    if (!db) return;
    db.getKnownPeers(100).then(setPeers);
  }, []);

  useFocusEffect(loadPeers);

  // Pull down to re-read the known-peer cache, which the SPV client writes to
  // as nodes complete their handshake.
  const { gesture, scrollHandler, bandStyle } =
    usePullToRefreshBand(loadPeers);

  // Qualitative connection state: a colored dot + big status word carry the
  // signal (no bordered chip). Offline = destructive, syncing = warning,
  // synced = success.
  const status = useMemo(() => {
    if (connectedPeers === 0) {
      return { text: t("peers.offline"), dot: "bg-destructive" };
    }
    if (isSyncing) {
      return {
        text: t("peers.syncing", { progress: Math.round(syncProgress) }),
        dot: "bg-warning",
      };
    }
    return { text: t("peers.synced"), dot: "bg-success" };
  }, [connectedPeers, isSyncing, syncProgress]);

  const connectedLabel =
    connectedPeers === 1
      ? t("peers.peerCountLabel.one", { count: connectedPeers })
      : t("peers.peerCountLabel.other", { count: connectedPeers });

  const isTestnet = network === "testnet";

  return (
    <SafeAreaView
      className="flex-1 bg-background"
      edges={["top", "bottom", "left", "right"]}
    >
      <ScreenHeader title={t("peers.title")} onBack={() => router.back()} />
      <GestureDetector gesture={gesture}>
        <Animated.ScrollView
          className="flex-1"
          onScroll={scrollHandler}
          scrollEventThrottle={16}
          contentContainerStyle={{ paddingBottom: 24 }}
          showsVerticalScrollIndicator={false}
        >
      {/* Pull-to-refresh rainbow band — same as Home: inside the scroll view,
          revealed on pull, never pinned. */}
      <Animated.View style={[bandStyle, { overflow: "hidden" }]}>
        <RefreshRainbowBar />
      </Animated.View>
      {/* ---- Status hero: colored dot + status word + connected count ---- */}
      <View className="px-5 pt-4">
        <View className="flex-row items-center gap-2.5">
          <View className={`w-2.5 h-2.5 rounded-full ${status.dot}`} />
          <Text className="text-foreground text-2xl font-semibold">
            {status.text}
          </Text>
        </View>
        <Text className="text-muted-foreground text-sm mt-1.5">
          {connectedLabel}
        </Text>
      </View>

      <View className="h-px bg-border mx-5 my-6" />

      {/* ---- Network details: card-less stat rows ---- */}
      <View className="px-5">
        <StatRow
          label={t("peers.blockHeight")}
          value={chainHeight > 0 ? chainHeight.toLocaleString() : "—"}
        />
        <StatRow
          label={t("peers.network")}
          value={isTestnet ? t("peers.testnet") : t("peers.mainnet")}
          valueClassName={
            isTestnet
              ? "text-warning text-[15px] font-semibold"
              : "text-foreground text-[15px] font-semibold"
          }
        />
      </View>

      {/* ---- Known peers: borderless surface list with hairline dividers ---- */}
      <View className="px-5 mt-8">
        <Text className={SECTION_LABEL}>{t("peers.knownPeers")}</Text>
        {peers.length === 0 ? (
          <View className="mt-2">
            <EmptyState
              icon="server-network-off"
              title={t("peers.empty.title")}
              subtitle={t("peers.empty.subtitle")}
            />
          </View>
        ) : (
          <View className="bg-surface rounded-2xl overflow-hidden mt-2">
            {peers.map((peer, idx) => (
              <View key={`${peer.host}:${peer.port}`}>
                {idx > 0 ? <View className="h-px bg-border ml-4" /> : null}
                <View className="flex-row items-center justify-between px-4 py-3.5">
                  <View className="flex-1 pr-3">
                    <Text
                      className="text-foreground text-[15px] font-medium"
                      numberOfLines={1}
                    >
                      {peer.host}:{peer.port}
                    </Text>
                    <Text
                      className="text-muted-foreground text-xs mt-0.5"
                      numberOfLines={1}
                    >
                      {getServiceLabels(peer.services).join(", ")}
                    </Text>
                  </View>
                  <Text className="text-muted-foreground text-xs">
                    {formatLastSeen(peer.last_seen)}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </View>

      {/* ---- Add peer: borderless (ghost) action ---- */}
      <View className="px-5 mt-4">
        <Button
          title={t("peers.addManually")}
          onPress={() => router.push("/peers/add")}
          variant="ghost"
        />
      </View>

      {/* ---- DNS seeds: borderless surface list with hairline dividers ---- */}
      <View className="px-5 mt-6">
        <Text className={SECTION_LABEL}>{t("peers.dnsSeeds")}</Text>
        <View className="bg-surface rounded-2xl overflow-hidden mt-2">
          {DNS_SEEDS.map((seed, idx) => (
            <View key={seed.host}>
              {idx > 0 ? <View className="h-px bg-border ml-4" /> : null}
              <View className="px-4 py-3.5">
                <Text className="text-foreground text-[15px] font-medium">
                  {seed.host}
                </Text>
                <Text className="text-muted-foreground text-xs mt-0.5">
                  {t("peers.portLabel", { port: seed.port })}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </View>
        </Animated.ScrollView>
      </GestureDetector>
    </SafeAreaView>
  );
}
