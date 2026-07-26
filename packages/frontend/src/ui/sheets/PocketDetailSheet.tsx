/**
 * Pocket detail sheet content: a colored hero (avatar + name + balance),
 * the actions that are actually possible for this Pocket, a Manage row
 * (edit / delete), and — for the active Pocket only — its recent activity.
 * Content-only body for a Bloom `<Dialog placement="bottom">`, matching the
 * approved Pockets design's detail sheet.
 *
 * `moveBetweenPockets` always sources funds from the ACTIVE Pocket, so this
 * sheet shows exactly what's possible for the viewed Pocket: "Move" (source =
 * this Pocket) when it IS active, or "Add funds" (destination = this Pocket)
 * plus "Switch to this pocket" when it is NOT. `transactions` in the wallet
 * store is scoped to whichever Pocket is currently active, so activity is
 * only shown for that one — a non-active Pocket's history isn't loaded into
 * memory (see `readPocketUnspentTotal` for the balance-only equivalent).
 */

import type React from "react";
import { useCallback, useMemo, useState } from "react";
import { View, Text } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useTheme } from "@oxyhq/bloom/theme";
import { Dialog, useDialogControl } from "@oxyhq/bloom/dialog";
import { toast } from "@oxyhq/bloom/toast";
import { useWalletStore } from "../../wallet/wallet-store";
import { MAIN_POCKET_ACCOUNT, canDeletePocket, findPocket } from "../../wallet/pockets";
import { AmountText, Button, EmptyState, PocketAvatar } from "../components";
import { TransactionItem } from "../components/TransactionItem";
import { MovePocketSheet } from "./MovePocketSheet";
import { PocketFormSheet } from "./PocketFormSheet";
import { t } from "../../i18n";

const CONTENT_MAX_WIDTH = 500;
/** Most recent activity rows shown before the caller navigates to the full list. */
const ACTIVITY_LIMIT = 8;
/**
 * Accent handed to the hero's avatar. The hero surface already IS the Pocket's
 * color, so the initial fallback is drawn in white (matching the hero's other
 * text) instead of a color that would vanish into its own background.
 */
const HERO_AVATAR_ACCENT = "#ffffff";

function DetailAction({
  icon,
  label,
  onPress,
  disabled,
  loading,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>["name"];
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Button
      title={label}
      onPress={onPress}
      variant="secondary"
      size="sm"
      disabled={disabled}
      loading={loading}
      fullWidth={false}
      style={{ flex: 1 }}
      icon={
        loading ? undefined : (
          <MaterialCommunityIcons name={icon} size={16} color={theme.colors.primary} />
        )
      }
    />
  );
}

export function PocketDetailSheet({
  account,
  onDone,
}: {
  account: number;
  onDone: () => void;
}): React.JSX.Element {
  const pockets = useWalletStore((s) => s.pockets);
  const activeAccount = useWalletStore((s) => s.activeAccount);
  const pocketBalances = useWalletStore((s) => s.pocketBalances);
  const transactions = useWalletStore((s) => s.transactions);
  const switchPocket = useWalletStore((s) => s.switchPocket);
  const deletePocket = useWalletStore((s) => s.deletePocket);

  const [switching, setSwitching] = useState(false);

  const moveControl = useDialogControl();
  const editControl = useDialogControl();
  const manageControl = useDialogControl();
  const deleteControl = useDialogControl();

  const pocket = findPocket(pockets, account);
  const isActive = account === activeAccount;
  const isMain = account === MAIN_POCKET_ACCOUNT;
  const balance = pocketBalances[account] ?? 0n;

  const activity = useMemo(
    () => (isActive ? transactions.slice(0, ACTIVITY_LIMIT) : []),
    [isActive, transactions],
  );

  const handleSwitch = useCallback(async () => {
    setSwitching(true);
    try {
      await switchPocket(account);
      onDone();
    } finally {
      setSwitching(false);
    }
  }, [account, switchPocket, onDone]);

  // `deleteControl` closes before this runs (default `shouldCloseOnPress`),
  // so a failure surfaces via a toast rather than needing to keep the confirm
  // dialog open.
  const handleDeleteConfirm = useCallback(async () => {
    try {
      await deletePocket(account);
      onDone();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("pockets.delete.notEmpty"));
    }
  }, [account, deletePocket, onDone]);

  if (!pocket) {
    return (
      <View className="items-center justify-center py-12">
        <EmptyState icon="wallet-outline" title={t("pockets.move.noDestinations.title")} />
      </View>
    );
  }

  const label = isMain ? t("pockets.mainName") : pocket.name;

  return (
    <View className="w-full self-center" style={{ maxWidth: CONTENT_MAX_WIDTH }}>
      {/* Color hero */}
      <View
        className="rounded-3xl p-5 mb-5"
        style={{ backgroundColor: pocket.color }}
      >
        <PocketAvatar
          pocket={{ ...pocket, color: HERO_AVATAR_ACCENT }}
          size={56}
        />
        <Text className="text-white/85 text-xs font-semibold uppercase tracking-wide mt-3.5">
          {label}
        </Text>
        <AmountText
          value={balance}
          suffix=" FAIR"
          className="text-white text-[28px] font-bold mt-0.5"
        />
      </View>

      {/* Actions — what's actually possible for THIS Pocket given move-out is
          only ever sourced from the active Pocket. */}
      <View className="flex-row gap-2.5 mb-5">
        {isActive ? (
          <DetailAction
            icon="swap-horizontal"
            label={t("pockets.detail.move")}
            onPress={() => moveControl.open()}
          />
        ) : (
          <>
            <DetailAction
              icon="plus"
              label={t("pockets.detail.add")}
              onPress={() => moveControl.open()}
            />
            <DetailAction
              icon="swap-horizontal-bold"
              label={t("pockets.detail.switch")}
              onPress={handleSwitch}
              loading={switching}
            />
          </>
        )}
        <DetailAction
          icon="cog-outline"
          label={t("pockets.detail.manageAction")}
          onPress={() => manageControl.open()}
        />
      </View>

      {/* Activity — only meaningful for the active Pocket (see file doc). */}
      <View>
        <Text className="text-muted-foreground text-xs font-semibold uppercase tracking-wider mb-1">
          {t("wallet.activity")}
        </Text>
        {isActive ? (
          activity.length > 0 ? (
            <View className="bg-surface rounded-2xl overflow-hidden mt-1">
              {activity.map((tx) => (
                <TransactionItem
                  key={tx.txid}
                  txid={tx.txid}
                  type={tx.type}
                  value={tx.amount}
                  address={tx.address}
                  timestamp={tx.timestamp}
                  confirmations={tx.confirmations}
                />
              ))}
            </View>
          ) : (
            <EmptyState
              icon="swap-vertical"
              title={t("wallet.activity.empty.title")}
              subtitle={t("wallet.activity.empty.subtitle")}
            />
          )
        ) : (
          <EmptyState
            icon="wallet-outline"
            title={t("pockets.detail.activityUnavailable.title")}
            subtitle={t("pockets.detail.activityUnavailable.subtitle")}
          />
        )}
      </View>

      {/* Move / add funds */}
      <Dialog control={moveControl} placement="bottom" title={t("pockets.move.title")}>
        <MovePocketSheet
          initialToAccount={isActive ? undefined : account}
          onDone={() => moveControl.close()}
        />
      </Dialog>

      {/* Edit pocket */}
      <Dialog control={editControl} placement="bottom" title={t("pockets.edit.title")}>
        <PocketFormSheet target={pocket} onDone={() => editControl.close()} />
      </Dialog>

      {/* Manage actions */}
      <Dialog
        control={manageControl}
        placement="bottom"
        title={label}
        actions={[
          { label: t("pockets.edit.action"), onPress: () => editControl.open() },
          ...(canDeletePocket(pockets, account)
            ? [
                {
                  label: t("common.delete"),
                  color: "destructive" as const,
                  onPress: () => deleteControl.open(),
                },
              ]
            : []),
          { label: t("common.cancel"), color: "cancel" as const },
        ]}
      />

      {/* Delete confirm */}
      <Dialog
        control={deleteControl}
        placement="bottom"
        title={t("pockets.delete.title")}
        description={t("pockets.delete.description", { name: label })}
        actions={[
          { label: t("common.delete"), color: "destructive", onPress: handleDeleteConfirm },
          { label: t("common.cancel"), color: "cancel" },
        ]}
      />
    </View>
  );
}
