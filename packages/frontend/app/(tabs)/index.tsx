/**
 * Home screen — a Coinbase-style wallet home, themed with Bloom and wired to
 * real wallet data.
 *
 * Header (wallet identity + a sync-status icon), a left-aligned balance, a row
 * of bordered action pills, an Overview / Activity tab switch, an animated
 * rainbow refresh band below the tabs, then the selected tab's content:
 * Overview shows the FairCoin holding, Activity shows the day-grouped feed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useFocusEffect, useRouter } from "expo-router";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import * as WebBrowser from "expo-web-browser";
import * as Localization from "expo-localization";
import { useWalletStore } from "../../src/wallet/wallet-store";
import {
  BalanceDisplay,
  ActionButton,
  EmptyState,
  Badge,
} from "../../src/ui/components";
import { TransactionItem } from "../../src/ui/components/TransactionItem";
import {
  SuggestionStack,
  type Suggestion,
} from "../../src/ui/components/SuggestionStack";
import { HomeOverview } from "../../src/ui/components/HomeOverview";
import { ArrowCircleDownIcon } from "../../src/ui/components/ArrowCircleDownIcon";
import { HubIcon } from "../../src/ui/components/HubIcon";
import { SendIcon } from "../../src/ui/components/SendIcon";
import { PocketSwitcherSheet } from "../../src/ui/sheets/PocketSwitcherSheet";
import { findPocket, MAIN_POCKET_ACCOUNT } from "../../src/wallet/pockets";
import { TransactionDetailSheet } from "../../src/ui/sheets/TransactionDetailSheet";
import {
  RefreshRainbowBar,
  RAINBOW_BAND_HEIGHT,
} from "../../src/ui/components/RefreshRainbowBar";
import { SendReceiveSheet } from "../../src/ui/sheets/SendReceiveSheet";
import { hapticSelection, hapticSuccess } from "../../src/utils/haptics";
import { SafeAreaView } from "../../src/ui/safe-area-view";
import { Dialog, useDialogControl } from "@oxy.so/bloom/dialog";
import {
  startPricePolling,
  stopPricePolling,
  getCachedPrice,
  fetchPrice,
  type PriceData,
} from "../../src/services/price";
import { queryClient } from "../../src/services/query-client";
import { useTheme } from "@oxy.so/bloom/theme";
import { Tabs, TabsTrigger } from "@oxy.so/bloom/tabs";
import { BUY_BASE_URL } from "@fairco.in/core";
import { useTransactionEnrichment } from "../../src/hooks/useTransactionEnrichment";
import { t } from "../../src/i18n";

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>["name"];
type HomeTab = "overview" | "activity";

// ---------------------------------------------------------------------------
// Activity date grouping
// ---------------------------------------------------------------------------

type StoreTransaction = ReturnType<
  typeof useWalletStore.getState
>["transactions"][number];

interface ActivityGroup {
  key: string;
  label: string;
  items: StoreTransaction[];
}

const DAY_MS = 86_400_000;
const SYNCING_COLOR = "#fbbf24";
/** Reveal (px) the pull must reach on release to trigger a refresh. */
const REFRESH_TRIGGER = 42;
/** Damping applied to the finger travel so the band trails the drag. */
const PULL_DAMPING = 0.6;

/** Human day label for a unix-seconds timestamp: Today / Yesterday / a date. */
function dayLabel(timestampSec: number): string {
  const date = new Date(timestampSec * 1000);
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfDate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const diffDays = Math.round((startOfToday - startOfDate) / DAY_MS);
  if (diffDays <= 0) return t("wallet.date.today");
  if (diffDays === 1) return t("wallet.date.yesterday");
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Group transactions (already newest-first) into ordered day buckets. */
function groupByDay(transactions: StoreTransaction[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  const byKey = new Map<string, ActivityGroup>();
  for (const tx of transactions) {
    const date = new Date(tx.timestamp * 1000);
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.items.push(tx);
    } else {
      const group: ActivityGroup = {
        key,
        label: dayLabel(tx.timestamp),
        items: [tx],
      };
      byKey.set(key, group);
      groups.push(group);
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function HomeScreen() {
  const router = useRouter();
  const theme = useTheme();

  const balance = useWalletStore((s) => s.balance);
  const isSyncing = useWalletStore((s) => s.isSyncing);
  const syncProgress = useWalletStore((s) => s.syncProgress);
  const connectedPeers = useWalletStore((s) => s.connectedPeers);
  const transactions = useWalletStore((s) => s.transactions);
  const network = useWalletStore((s) => s.network);
  const activeWalletName = useWalletStore((s) => s.activeWalletName);
  const receiveAddress = useWalletStore((s) => s.currentReceiveAddress);
  const refreshBalance = useWalletStore((s) => s.refreshBalance);
  const hasBackedUp = useWalletStore((s) => s.hasBackedUp);
  const pockets = useWalletStore((s) => s.pockets);
  const activeAccount = useWalletStore((s) => s.activeAccount);
  const isWatchOnly = useWalletStore((s) => s.isWatchOnly);
  const loadPockets = useWalletStore((s) => s.loadPockets);

  const [price, setPrice] = useState<PriceData | null>(getCachedPrice);
  const [tab, setTab] = useState<HomeTab>("activity");

  // Send / Receive share ONE bottom-sheet with a Send|Receive toggle; the pills
  // just open it on the right side.
  const sheetControl = useDialogControl();
  const [sheetMode, setSheetMode] = useState<"send" | "receive">("send");
  // Tapping the active-Pocket pill opens a quick Pocket-switcher sheet.
  const pocketSwitcherControl = useDialogControl();
  const activePocket = useMemo(
    () => findPocket(pockets, activeAccount),
    [pockets, activeAccount],
  );
  const activePocketName =
    !activePocket || activePocket.account === MAIN_POCKET_ACCOUNT
      ? t("pockets.mainName")
      : activePocket.name;
  // Tapping an activity row opens the transaction detail in a bottom sheet.
  const txDetailControl = useDialogControl();
  const [detailTxid, setDetailTxid] = useState<string | null>(null);
  const openTxDetail = useCallback(
    (txid: string) => {
      setDetailTxid(txid);
      txDetailControl.open();
    },
    [txDetailControl],
  );

  useFocusEffect(
    useCallback(() => {
      startPricePolling((updated) => setPrice(updated));
      loadPockets();
      return () => stopPricePolling();
    }, [loadPockets]),
  );

  // Home suggestion deck (swipe a card to dismiss it and reveal the next).
  // Dismissals are per-session; unsatisfied reminders (e.g. backup) return on
  // the next launch until resolved.
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(
    () => new Set(),
  );
  const dismissSuggestion = useCallback((id: string) => {
    setDismissedSuggestions((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);
  const suggestions = useMemo<Suggestion[]>(() => {
    const list: Suggestion[] = [];
    if (!hasBackedUp) {
      list.push({
        id: "backup",
        icon: "shield-key-outline",
        title: t("backup.banner.title"),
        badge: t("backup.banner.required"),
        subtitle: t("backup.banner.subtitle"),
        onPress: () => router.push("/settings"),
      });
    }
    list.push({
      id: "notifications",
      icon: "bell-ring-outline",
      title: t("suggest.notifications.title"),
      subtitle: t("suggest.notifications.subtitle"),
      onPress: () => router.push("/notifications-settings"),
    });
    return list.filter((s) => !dismissedSuggestions.has(s.id));
  }, [hasBackedUp, dismissedSuggestions, router]);

  const handleBuy = useCallback(async () => {
    const locale = Localization.getLocales()[0];
    const language = locale?.languageCode ?? "en";
    const country = locale?.regionCode ?? "";
    const params = new URLSearchParams({
      in_app: "true",
      address: receiveAddress ?? "",
      language,
      country,
    });
    await WebBrowser.openBrowserAsync(`${BUY_BASE_URL}/?${params.toString()}`);
  }, [receiveAddress]);

  // Pull-to-refresh: the rainbow band IS the indicator. A Pan gesture (running
  // alongside the scroll) reveals the band by `pull` px as the user drags down
  // while at the top; releasing past REFRESH_TRIGGER runs the refresh and holds
  // the band briefly before it collapses. No native RefreshControl.
  // The scroll's own gesture, composed simultaneously with the pull so dragging
  // at the top reveals the band while normal scrolling still works.
  const nativeGesture = useMemo(() => Gesture.Native(), []);
  const scrollY = useSharedValue(0);
  const pull = useSharedValue(0);
  const refreshingSV = useSharedValue(false);
  /** True once this drag has passed the trigger threshold (for a one-shot haptic). */
  const passedTrigger = useSharedValue(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scrollHandler = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });

  const startRefresh = useCallback(() => {
    refreshBalance();
    // A pull should re-pull remote data, not only recompute the local balance:
    // refetch the FAIR price for the header and invalidate the Overview's
    // React Query data (price history + network stats) so both refresh too.
    void fetchPrice().then((updated) => {
      if (updated) setPrice(updated);
    });
    void queryClient.invalidateQueries();
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshingSV.value = false;
      pull.value = withTiming(0, { duration: 220 });
      // A distinct "done" haptic as the band collapses.
      hapticSuccess();
    }, 1500);
  }, [refreshBalance, pull, refreshingSV]);

  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );

  const pullGesture = useMemo(
    () =>
      Gesture.Pan()
        .onBegin(() => {
          "worklet";
          passedTrigger.value = false;
        })
        .onUpdate((event) => {
          "worklet";
          if (refreshingSV.value) return;
          const next =
            scrollY.value <= 0 && event.translationY > 0
              ? Math.min(event.translationY * PULL_DAMPING, RAINBOW_BAND_HEIGHT)
              : 0;
          // Light haptic tick the first time the pull passes the trigger; re-arm
          // if the user drags back below it so a second pull ticks again.
          if (!passedTrigger.value && next >= REFRESH_TRIGGER) {
            passedTrigger.value = true;
            runOnJS(hapticSelection)();
          } else if (passedTrigger.value && next < REFRESH_TRIGGER) {
            passedTrigger.value = false;
          }
          pull.value = next;
        })
        .onEnd(() => {
          "worklet";
          if (refreshingSV.value) return;
          if (pull.value >= REFRESH_TRIGGER) {
            refreshingSV.value = true;
            pull.value = withTiming(RAINBOW_BAND_HEIGHT, { duration: 140 });
            runOnJS(startRefresh)();
          } else {
            pull.value = withTiming(0, { duration: 140 });
          }
        }),
    [scrollY, pull, refreshingSV, passedTrigger, startRefresh],
  );

  const composedGesture = useMemo(
    () => Gesture.Simultaneous(pullGesture, nativeGesture),
    [pullGesture, nativeGesture],
  );

  const bandStyle = useAnimatedStyle(() => ({ height: pull.value }));

  const activityGroups = useMemo(
    () => groupByDay(transactions.slice(0, 10)),
    [transactions],
  );

  const enrichmentAddresses = useMemo(
    () => activityGroups.flatMap((group) => group.items.map((tx) => tx.address)),
    [activityGroups],
  );
  const enrichment = useTransactionEnrichment(enrichmentAddresses);

  const sync = useMemo((): { icon: IconName; color: string; label: string } => {
    if (connectedPeers === 0) {
      return {
        icon: "cloud-off-outline",
        color: theme.colors.error,
        label: t("wallet.sync.offline"),
      };
    }
    if (isSyncing) {
      return {
        icon: "cloud-sync-outline",
        color: SYNCING_COLOR,
        label: t("wallet.sync.syncing", { progress: Math.round(syncProgress) }),
      };
    }
    return {
      icon: "cloud-check-outline",
      color: theme.colors.primary,
      label: t("wallet.sync.synced"),
    };
  }, [connectedPeers, isSyncing, syncProgress, theme.colors.error, theme.colors.primary]);

  return (
    <View className="flex-1 bg-background">
      {/* ---- Header: wallet switcher + sync-status icon ---- */}
      <SafeAreaView edges={["top"]}>
        <View className="px-4 pt-3 pb-2 flex-row items-center justify-between">
        <View className="flex-row items-center">
          <View className="w-9 h-9 rounded-xl bg-primary items-center justify-center mr-2.5">
            <MaterialCommunityIcons
              name="wallet"
              size={18}
              color={theme.colors.background}
            />
          </View>
          <Text className="text-foreground text-xl font-semibold">
            {activeWalletName || t("wallet.defaultName")}
          </Text>
        </View>

        <View className="flex-row items-center gap-3">
          {network === "testnet" ? (
            <Badge text={t("wallet.badge.testnet")} variant="warning" size="sm" />
          ) : null}
          <Pressable
            onPress={() => router.push("/peers")}
            accessibilityRole="button"
            accessibilityLabel={t("wallet.syncAccessibility", { label: sync.label })}
            className="active:opacity-60"
            hitSlop={8}
          >
            <MaterialCommunityIcons name={sync.icon} size={24} color={sync.color} />
          </Pressable>
        </View>
        </View>
      </SafeAreaView>

      <GestureDetector gesture={composedGesture}>
        <Animated.ScrollView
          onScroll={scrollHandler}
          scrollEventThrottle={16}
          className="flex-1"
          contentContainerStyle={{ paddingBottom: 24 }}
          showsVerticalScrollIndicator={false}
        >
          {/* ---- Balance ---- */}
        <View className="px-4 pt-4 pb-5">
          <BalanceDisplay
            value={balance}
            priceUsd={price?.usd}
            change24h={price?.change24h}
            size="lg"
            align="start"
          />
          {/* Active-Pocket pill — opens the Pocket switcher. Watch-only
              wallets have no Pockets, so the pill (and the whole Pockets
              surface) is hidden for them. */}
          {!isWatchOnly ? (
            <Pressable
              className="self-start flex-row items-center bg-surface rounded-full pl-1.5 pr-3 py-1.5 mt-2 active:opacity-70"
              onPress={() => pocketSwitcherControl.open()}
              accessibilityRole="button"
              accessibilityLabel={t("pockets.switcherTitle")}
            >
              <View
                className="w-5 h-5 rounded-full items-center justify-center mr-1.5"
                style={{ backgroundColor: `${activePocket?.color ?? theme.colors.primary}29` }}
              >
                <Text style={{ fontSize: 11 }}>{activePocket?.emoji ?? "💧"}</Text>
              </View>
              <Text className="text-foreground text-sm font-medium">
                {activePocketName}
              </Text>
              <MaterialCommunityIcons
                name="chevron-down"
                size={16}
                color={theme.colors.textSecondary}
              />
            </Pressable>
          ) : null}
        </View>

        {/* ---- Quick actions ---- */}
        <View className="flex-row gap-2.5 px-4 pb-4">
          <ActionButton
            icon="arrow-up"
            label={t("wallet.send")}
            onPress={() => {
              setSheetMode("send");
              sheetControl.open();
            }}
            renderIcon={({ color, size }) => (
              <SendIcon color={color} size={size} />
            )}
          />
          <ActionButton
            icon="arrow-down"
            label={t("wallet.receive")}
            onPress={() => {
              setSheetMode("receive");
              sheetControl.open();
            }}
            renderIcon={({ color, size }) => (
              <ArrowCircleDownIcon color={color} size={size} />
            )}
          />
          <ActionButton
            icon="credit-card-plus"
            label={t("wallet.buy")}
            onPress={handleBuy}
          />
          <ActionButton
            icon="server-network"
            label={t("wallet.nodes")}
            onPress={() => router.push("/masternode")}
            renderIcon={({ color, size }) => (
              <HubIcon color={color} size={size} />
            )}
          />
        </View>

        {/* ---- Suggestion deck: swipable reminder cards (back up your wallet,
            enable alerts…). Hidden when there's nothing to suggest. ---- */}
        {suggestions.length > 0 ? (
          <View className="px-4 pb-4">
            <SuggestionStack items={suggestions} onDismiss={dismissSuggestion} />
          </View>
        ) : null}

        {/* ---- Tabs (Bloom): compact tabs, but the bottom border spans the full
            width (Bloom draws its underline border only under the tabs, so we
            move it to a full-width wrapper and zero out Bloom's). ---- */}
        <View className="border-b border-border px-4">
          <Tabs
            value={tab}
            onValueChange={(next) => {
              if (next === "overview" || next === "activity") setTab(next);
            }}
            variant="underline"
            style={{ borderBottomWidth: 0 }}
          >
            <TabsTrigger value="overview" label={t("wallet.overview")} />
            <TabsTrigger value="activity" label={t("wallet.activity")} />
          </Tabs>
        </View>

        {/* ---- Pull-to-refresh rainbow band: below the tabs, grows as you drag ---- */}
        <Animated.View style={[bandStyle, { overflow: "hidden" }]}>
          <RefreshRainbowBar />
        </Animated.View>

        {/* ---- Tab content ---- */}
        {tab === "overview" ? (
          <HomeOverview />
        ) : activityGroups.length === 0 ? (
          <View className="px-4 pt-6">
            <EmptyState
              icon="swap-vertical"
              title={t("wallet.activity.empty.title")}
              subtitle={t("wallet.activity.empty.subtitle")}
            />
          </View>
        ) : (
          <View className="pt-3">
            {activityGroups.map((group) => (
              <View key={group.key} className="mb-2">
                <Text className="text-muted-foreground text-xs font-semibold uppercase px-4 mb-1">
                  {group.label}
                </Text>
                {group.items.map((tx) => (
                  <TransactionItem
                    key={tx.txid}
                    txid={tx.txid}
                    type={tx.type}
                    value={tx.amount}
                    address={tx.address}
                    timestamp={tx.timestamp}
                    confirmations={tx.confirmations}
                    onPress={openTxDetail}
                    identity={
                      enrichment[tx.address]?.kind !== "unknown"
                        ? enrichment[tx.address]
                        : undefined
                    }
                  />
                ))}
              </View>
            ))}
          </View>
        )}
        </Animated.ScrollView>
      </GestureDetector>

      {/* Send / Receive: one bottom-sheet with a Send|Receive toggle. title=""
          turns ON the sheet's own scroll (for the tall Send form) without
          rendering a header row — the sheet's toggle is the header. */}
      {/* contentPadding={0}: the send/receive pager is full-bleed so pages
          slide edge-to-edge; the sheet's own toggle + each page own their
          horizontal insets. */}
      <Dialog
        control={sheetControl}
        placement="bottom"
        title=""
        contentPadding={0}
      >
        <SendReceiveSheet mode={sheetMode} onModeChange={setSheetMode} />
      </Dialog>
      <Dialog
        control={pocketSwitcherControl}
        placement="bottom"
        title={t("pockets.switcherTitle")}
      >
        <PocketSwitcherSheet onDone={() => pocketSwitcherControl.close()} />
      </Dialog>
      <Dialog
        control={txDetailControl}
        placement="bottom"
        title={t("transaction.title")}
      >
        {detailTxid ? <TransactionDetailSheet txid={detailTxid} /> : null}
      </Dialog>
    </View>
  );
}
