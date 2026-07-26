/**
 * PocketCard — one row in the Pockets home list: the Pocket's circular avatar
 * (its own image, or its initial on its accent color), its name (+ a "Main"
 * badge for the implicit main Pocket), an optional goal progress bar, and the
 * balance right-aligned. Matches the approved Revolut-style Pockets design
 * (mockup: image avatar + goal bar per card).
 */

import { View, Text, Pressable } from "react-native";
import { UNITS_PER_COIN } from "@fairco.in/core";
import { AmountText } from "./AmountText";
import { Badge } from "./Badge";
import { PocketAvatar } from "./PocketAvatar";
import { MAIN_POCKET_ACCOUNT, type PocketInfo } from "../../wallet/pockets";
import { t } from "../../i18n";

function formatGoalAmount(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

interface PocketCardProps {
  pocket: PocketInfo;
  balance: bigint;
  onPress: () => void;
}

export function PocketCard({ pocket, balance, onPress }: PocketCardProps) {
  const isMain = pocket.account === MAIN_POCKET_ACCOUNT;
  const label = isMain ? t("pockets.mainName") : pocket.name;
  const balanceFair = Number(balance) / Number(UNITS_PER_COIN);
  const goalPercent =
    pocket.goal && pocket.goal > 0
      ? Math.min(100, Math.round((balanceFair / pocket.goal) * 100))
      : null;

  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center bg-surface rounded-2xl px-4 py-3.5 mb-3 active:opacity-80"
    >
      <View className="mr-3.5">
        <PocketAvatar pocket={pocket} size={48} />
      </View>

      <View className="flex-1 min-w-0 mr-3">
        <View className="flex-row items-center gap-2">
          <Text
            className="text-foreground text-[15.5px] font-semibold"
            numberOfLines={1}
          >
            {label}
          </Text>
          {isMain ? <Badge text={t("pockets.mainBadge")} size="sm" /> : null}
        </View>
        {isMain && goalPercent === null ? (
          <Text className="text-muted-foreground text-xs mt-0.5" numberOfLines={1}>
            {t("pockets.mainSubtitle")}
          </Text>
        ) : null}

        {goalPercent !== null ? (
          <View className="mt-2.5">
            <View className="h-1.5 rounded-full bg-background overflow-hidden">
              <View
                className="h-full rounded-full"
                style={{
                  width: `${goalPercent}%`,
                  backgroundColor: pocket.color,
                }}
              />
            </View>
            <View className="flex-row justify-between mt-1.5">
              <Text className="text-muted-foreground text-[11px]">
                {t("pockets.goal.progress", {
                  current: formatGoalAmount(balanceFair),
                  target: formatGoalAmount(pocket.goal ?? 0),
                })}
              </Text>
              <Text className="text-muted-foreground text-[11px] font-semibold">
                {goalPercent}%
              </Text>
            </View>
          </View>
        ) : null}
      </View>

      <View className="items-end">
        <AmountText value={balance} className="text-foreground text-base font-bold" />
        <Text className="text-muted-foreground text-[11px] font-semibold mt-0.5">
          FAIR
        </Text>
      </View>
    </Pressable>
  );
}
