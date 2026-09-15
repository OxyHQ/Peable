/**
 * HomeOverview — content for the home screen's "Overview" tab: a clean,
 * card-less market + staking + network view (Uniswap/Apple style — big numbers,
 * generous spacing, hairline dividers, no boxes).
 *
 * The headline balance and the Activity feed live elsewhere on the home screen,
 * so this view deliberately doesn't repeat them. Market data (price history +
 * network stats) comes from TanStack Query hooks over the Explorer API; the
 * network stats section additionally ticks live off the realtime WebSocket. It
 * degrades gracefully — a failed request leaves the section in its last-known
 * or "unavailable" state, never crashing.
 */

import { useMemo, useState } from "react";
import { View, Text } from "react-native";
import { AmountText } from "./AmountText";
import { PriceSparkline } from "./PriceSparkline";
import { useWalletStore } from "../../wallet/wallet-store";
import { usePriceHistory, useNetworkStats } from "../../hooks/useMarketData";
import { COIN_SYMBOL } from "@fairco.in/core";
import { FONT_PHUDU_BLACK } from "../../utils/fonts";
import { formatNumber, t } from "../../i18n";

const DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

const SECTION_HEADER =
  "text-muted-foreground text-xs font-semibold uppercase tracking-wider";

/** A labelled key/value row (label left, value right). */
function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between py-3">
      <Text className="text-muted-foreground text-[15px]">{label}</Text>
      <Text className="text-foreground text-[15px] font-semibold">{value}</Text>
    </View>
  );
}

export function HomeOverview(): React.JSX.Element {
  const network = useWalletStore((s) => s.network);
  const transactions = useWalletStore((s) => s.transactions);

  // Server state via TanStack Query: cached per network, revalidated on focus /
  // interval, and (for stats) pushed live by the Explorer realtime socket.
  // React Query keeps the last successful value while a refetch is failing, so
  // a dropped request never blanks the section.
  const { data: history } = usePriceHistory(network);
  const { data: stats } = useNetworkStats(network);

  const latestPriceUsd = useMemo(() => {
    if (!history || history.length === 0) return null;
    return history[history.length - 1].priceUsd;
  }, [history]);

  const changePct = useMemo(() => {
    if (!history || history.length < 2) return null;
    const last = history[history.length - 1];
    const cutoff = last.timestamp - DAY_MS;
    // Oldest→newest: walk forward to the last point at/before the 24h cutoff;
    // if all points are newer than a day, fall back to the oldest.
    let reference = history[0];
    for (const point of history) {
      if (point.timestamp <= cutoff) reference = point;
      else break;
    }
    if (reference.priceUsd === 0) return null;
    return ((last.priceUsd - reference.priceUsd) / reference.priceUsd) * 100;
  }, [history]);

  // The 30-day window is anchored once per mount instead of being read inside
  // the memo: an impure `Date.now()` there is both a purity violation and a lie
  // — the memo only recomputes when `transactions` changes, so the "window"
  // silently froze at whatever time the last transaction arrived.
  const [nowSeconds] = useState(() => Math.floor(Date.now() / 1000));

  const rewards = useMemo(() => {
    const cutoff = nowSeconds - THIRTY_DAYS_SECONDS;
    let total = 0n;
    let last30 = 0n;
    let count = 0;
    for (const tx of transactions) {
      if (tx.type !== "stake" && tx.type !== "masternode_reward") continue;
      const abs = tx.amount < 0n ? -tx.amount : tx.amount;
      total += abs;
      count += 1;
      if (tx.timestamp >= cutoff) last30 += abs;
    }
    return { total, last30, count };
  }, [transactions, nowSeconds]);

  return (
    <View className="pt-3 pb-2">
      {/* ---- Price hero + chart ---- */}
      <PriceSparkline
        points={history ?? []}
        changePct={changePct}
        currentPriceUsd={latestPriceUsd}
      />

      <View className="h-px bg-border mx-5 my-7" />

      {/* ---- Staking / rewards ---- */}
      <View className="px-5">
        <Text className={SECTION_HEADER}>{t("overview.staking.title")}</Text>
        {rewards.count === 0 ? (
          <Text className="text-muted-foreground text-[15px] mt-2 leading-5">
            {t("overview.staking.empty.subtitle")}
          </Text>
        ) : (
          <View className="mt-2">
            <AmountText
              value={rewards.total}
              symbol
              symbolSize={20}
              className="text-foreground"
              style={{ fontFamily: FONT_PHUDU_BLACK, fontSize: 32 }}
            />
            <Text className="text-muted-foreground text-[13px] mt-1">
              {t("overview.staking.totalEarned")}
            </Text>

            <View className="flex-row mt-5">
              <View className="flex-1">
                <Text className="text-muted-foreground text-[13px]">
                  {t("overview.staking.last30Days")}
                </Text>
                <AmountText
                  value={rewards.last30}
                  symbol
                  symbolSize={12}
                  className="text-foreground text-[17px] font-semibold mt-1"
                />
              </View>
              <View className="flex-1">
                <Text className="text-muted-foreground text-[13px]">
                  {t("overview.staking.rewardsReceived")}
                </Text>
                <Text className="text-foreground text-[17px] font-semibold mt-1">
                  {formatNumber(rewards.count, 0)}
                </Text>
              </View>
            </View>
          </View>
        )}
      </View>

      <View className="h-px bg-border mx-5 my-7" />

      {/* ---- Network ---- */}
      <View className="px-5">
        <Text className={SECTION_HEADER}>{t("overview.network.title")}</Text>
        {stats ? (
          <View className="mt-1.5">
            <StatRow
              label={t("overview.network.blockHeight")}
              value={formatNumber(stats.blockHeight, 0)}
            />
            <StatRow
              label={t("overview.network.masternodes")}
              value={formatNumber(stats.masternodeCount, 0)}
            />
            <StatRow
              label={t("overview.network.circulatingSupply")}
              value={`${formatNumber(stats.circulatingSupply, 0)} ${COIN_SYMBOL}`}
            />
          </View>
        ) : (
          <Text className="text-muted-foreground text-[15px] mt-2">
            {t("overview.network.unavailable")}
          </Text>
        )}
      </View>
    </View>
  );
}
