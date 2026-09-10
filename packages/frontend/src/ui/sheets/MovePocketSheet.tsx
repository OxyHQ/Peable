/**
 * Move-between-Pockets sheet body. Big hero amount + quick-percent amounts +
 * a From→To pair (active Pocket → a chosen destination), then calls
 * `wallet-store.moveBetweenPockets` (an on-chain self-transfer out of the
 * active Pocket). Content-only body for a Bloom `<Dialog placement="bottom">`,
 * mirroring `SendSheet`'s amount/fee conventions and matching the approved
 * Pockets design's move flow.
 *
 * `moveBetweenPockets` always sources funds from the ACTIVE Pocket — there is
 * no `fromAccount` parameter — so the "From" leg is informational only (no
 * swap affordance; the mockup's swap icon doesn't correspond to a real
 * capability here). The destination list is deliberately sourced from the
 * Pockets registry (`pockets`, filtered to exclude the active account) —
 * `moveBetweenPockets` itself does not validate `toAccount`, so this list IS
 * the gate against moving to an unknown account.
 */

import type React from "react";
import { useCallback, useMemo, useState } from "react";
import { View, Text, Pressable } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { formatFair, parseFairToUnits } from "@fairco.in/core";
import { useTheme } from "@oxy.so/bloom/theme";
import { useWalletStore, FEE_RATES } from "../../wallet/wallet-store";
import { MAIN_POCKET_ACCOUNT, findPocket } from "../../wallet/pockets";
import { AmountInput, Button, EmptyState, ListItem } from "../components";
import { t } from "../../i18n";

/** Quick-amount buttons as a fraction of the max sendable balance. */
const QUICK_FRACTIONS = [0.25, 0.5] as const;

export function MovePocketSheet({
  initialToAccount,
  onDone,
}: {
  /** Preselect a destination (e.g. opened from that Pocket's detail sheet). */
  initialToAccount?: number;
  onDone: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const pockets = useWalletStore((s) => s.pockets);
  const activeAccount = useWalletStore((s) => s.activeAccount);
  const moveBetweenPockets = useWalletStore((s) => s.moveBetweenPockets);
  const estimateSend = useWalletStore((s) => s.estimateSend);
  // Tracked so `maxSendable` below recomputes when the active Pocket's
  // spendable balance changes — `estimateSend` itself reads the module-level
  // UTXO set (external mutable state), so without a reactive dependency here
  // a memoized read would freeze at whatever balance was on first render.
  const confirmedBalance = useWalletStore((s) => s.confirmedBalance);

  const fromPocket = findPocket(pockets, activeAccount);
  const destinations = useMemo(
    () => pockets.filter((p) => p.account !== activeAccount),
    [pockets, activeAccount],
  );
  const [toAccount, setToAccount] = useState<number | null>(() => {
    if (initialToAccount !== undefined && initialToAccount !== activeAccount) {
      return initialToAccount;
    }
    return destinations[0]?.account ?? null;
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  // `amount` is the user-facing FAIR decimal string (same contract as
  // SendSheet) — `parseFairToUnits` converts it to the bigint sats amount.
  const [amount, setAmount] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountSats = useMemo<bigint | null>(
    () => parseFairToUnits(amount),
    [amount],
  );
  const canMove = toAccount !== null && amountSats !== null && amountSats > 0n;

  // Max sendable out of the active Pocket at the fee rate `moveBetweenPockets`
  // actually uses (FEE_RATES.medium — see `handleMove`), so quick amounts and
  // "Max" never offer more than what can really be moved. `confirmedBalance`
  // is an explicit dep (see note above) so this re-derives when the balance
  // changes, not just when `estimateSend` itself is re-bound.
  const maxSendable = useMemo(
    () => estimateSend(0n, FEE_RATES.medium).maxSendable,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [estimateSend, confirmedBalance],
  );

  const toPocket = toAccount !== null ? findPocket(pockets, toAccount) : undefined;
  const toLabel = toPocket
    ? toPocket.account === MAIN_POCKET_ACCOUNT
      ? t("pockets.mainName")
      : toPocket.name
    : "";
  const fromLabel = fromPocket
    ? fromPocket.account === MAIN_POCKET_ACCOUNT
      ? t("pockets.mainName")
      : fromPocket.name
    : "";

  const handleQuickAmount = useCallback(
    (fraction: number) => {
      const target = (maxSendable * BigInt(Math.round(fraction * 1000))) / 1000n;
      setAmount(target > 0n ? formatFair(target) : "");
    },
    [maxSendable],
  );

  const handleMax = useCallback(() => {
    setAmount(maxSendable > 0n ? formatFair(maxSendable) : "");
  }, [maxSendable]);

  const handleSelectDestination = useCallback((account: number) => {
    setToAccount(account);
    setPickerOpen(false);
  }, []);

  const handleMove = useCallback(async () => {
    if (toAccount === null || amountSats === null || amountSats <= 0n) return;
    setBusy(true);
    setError(null);
    try {
      // Same medium fee-rate the send flow defaults to (FEE_RATES is the
      // single source of truth for fee-per-byte; moveBetweenPockets reuses
      // the ordinary send path under the hood).
      await moveBetweenPockets(toAccount, amountSats, FEE_RATES.medium);
      onDone();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("pockets.move.failed"));
    } finally {
      setBusy(false);
    }
  }, [toAccount, amountSats, moveBetweenPockets, onDone]);

  // No other Pockets to move to yet — this must run AFTER every hook above so
  // that Pockets appearing later (state update while the sheet is open) does
  // not change the hook count between renders (Rules of Hooks).
  if (destinations.length === 0) {
    return (
      <View className="w-full self-center" style={{ maxWidth: 500 }}>
        <EmptyState
          icon="wallet-outline"
          title={t("pockets.move.noDestinations.title")}
          subtitle={t("pockets.move.noDestinations.subtitle")}
        />
      </View>
    );
  }

  return (
    <View className="w-full self-center gap-5" style={{ maxWidth: 500 }}>
      {/* Hero amount */}
      <View className="items-center pt-1 pb-1">
        <View className="flex-row items-end justify-center">
          <AmountInput
            className="text-foreground"
            style={{ fontSize: 40, fontWeight: "700", paddingVertical: 0 }}
            placeholder="0.00"
            placeholderTextColor={theme.colors.textSecondary}
            value={amount}
            onValueChange={setAmount}
            maxLength={20}
          />
          <Text className="text-muted-foreground text-base font-semibold ml-2 mb-1.5">
            FAIR
          </Text>
        </View>
      </View>

      {/* Quick amounts */}
      <View className="flex-row justify-center gap-2">
        {QUICK_FRACTIONS.map((fraction) => (
          <Pressable
            key={fraction}
            onPress={() => handleQuickAmount(fraction)}
            className="bg-surface rounded-full px-4 py-2 active:opacity-70"
          >
            <Text className="text-foreground text-sm font-semibold">
              {Math.round(fraction * 100)}%
            </Text>
          </Pressable>
        ))}
        <Pressable
          onPress={handleMax}
          className="bg-surface rounded-full px-4 py-2 active:opacity-70"
        >
          <Text className="text-primary text-sm font-bold">{t("pockets.move.max")}</Text>
        </Pressable>
      </View>

      {/* From → To */}
      <View className="flex-row items-center gap-2.5">
        <View className="flex-1 bg-surface rounded-2xl px-3.5 py-3 flex-row items-center gap-2.5">
          <View
            className="w-9 h-9 rounded-xl items-center justify-center"
            style={{ backgroundColor: `${fromPocket?.color ?? theme.colors.primary}29` }}
          >
            <Text style={{ fontSize: 16 }}>{fromPocket?.emoji ?? "💧"}</Text>
          </View>
          <View className="flex-1 min-w-0">
            <Text className="text-muted-foreground text-[10.5px] font-semibold uppercase tracking-wide">
              {t("pockets.move.fromLabel")}
            </Text>
            <Text className="text-foreground text-sm font-semibold" numberOfLines={1}>
              {fromLabel}
            </Text>
          </View>
        </View>

        <MaterialCommunityIcons
          name="arrow-right"
          size={18}
          color={theme.colors.textSecondary}
        />

        <Pressable
          onPress={() => setPickerOpen((open) => !open)}
          className="flex-1 bg-surface rounded-2xl px-3.5 py-3 flex-row items-center gap-2.5 active:opacity-80"
        >
          <View
            className="w-9 h-9 rounded-xl items-center justify-center"
            style={{ backgroundColor: `${toPocket?.color ?? theme.colors.primary}29` }}
          >
            <Text style={{ fontSize: 16 }}>{toPocket?.emoji ?? "🌱"}</Text>
          </View>
          <View className="flex-1 min-w-0">
            <Text className="text-muted-foreground text-[10.5px] font-semibold uppercase tracking-wide">
              {t("pockets.move.toLabel")}
            </Text>
            <Text className="text-foreground text-sm font-semibold" numberOfLines={1}>
              {toLabel}
            </Text>
          </View>
          <MaterialCommunityIcons
            name={pickerOpen ? "chevron-up" : "chevron-down"}
            size={18}
            color={theme.colors.textSecondary}
          />
        </Pressable>
      </View>

      {/* Destination picker — expands under the "To" leg */}
      {pickerOpen ? (
        <View className="bg-surface rounded-2xl overflow-hidden -mt-2">
          {destinations.map((pocket, idx) => {
            const selected = pocket.account === toAccount;
            const label =
              pocket.account === MAIN_POCKET_ACCOUNT ? t("pockets.mainName") : pocket.name;
            return (
              <ListItem
                key={pocket.account}
                icon="wallet-outline"
                iconColor={selected ? theme.colors.success : theme.colors.tint}
                title={label}
                onPress={() => handleSelectDestination(pocket.account)}
                showChevron={false}
                isLast={idx === destinations.length - 1}
                trailing={
                  selected ? (
                    <MaterialCommunityIcons
                      name="check-circle"
                      size={20}
                      color={theme.colors.success}
                    />
                  ) : undefined
                }
              />
            );
          })}
        </View>
      ) : null}

      {error ? (
        <View className="bg-destructive/10 rounded-2xl p-3">
          <Text className="text-destructive text-sm text-center">{error}</Text>
        </View>
      ) : null}

      <Button
        title={
          amountSats !== null && amountSats > 0n
            ? t("pockets.move.ctaAmount", { amount: formatFair(amountSats) })
            : t("pockets.move.cta")
        }
        onPress={handleMove}
        variant="primary"
        disabled={busy || !canMove}
        loading={busy}
      />
    </View>
  );
}
