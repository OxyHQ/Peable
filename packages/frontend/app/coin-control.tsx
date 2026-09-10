/**
 * Coin control screen.
 * Shows all UTXOs and lets users select specific ones for the next transaction.
 * Presented as a modal from settings or the send screen.
 */

import { useCallback, useMemo, useState } from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { SafeAreaView } from "../src/ui/safe-area-view";
import { useRouter } from "expo-router";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { Dialog, useDialogControl } from "@oxy.so/bloom/dialog";
import { useWalletStore, getDatabase } from "../src/wallet/wallet-store";
import {
  AmountText,
  Button,
  EmptyState,
  ScreenHeader,
} from "../src/ui/components";
import { useTheme } from "@oxy.so/bloom/theme";
import { t } from "../src/i18n";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UTXOItem {
  txid: string;
  vout: number;
  address: string;
  value: bigint;
  blockHeight: number;
  confirmations: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateTxid(txid: string): string {
  if (txid.length <= 16) return txid;
  return `${txid.slice(0, 8)}...${txid.slice(-8)}`;
}

/** Uppercase section label — matches the home screen's section headers. */
const SECTION_LABEL =
  "text-muted-foreground text-xs font-semibold uppercase tracking-wider";

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function CoinControlScreen() {
  const router = useRouter();
  const chainHeight = useWalletStore((s) => s.chainHeight);
  const existingSelection = useWalletStore((s) => s.selectedUTXOs);
  const setSelectedUTXOs = useWalletStore((s) => s.setSelectedUTXOs);
  const clearSelectedUTXOs = useWalletStore((s) => s.clearSelectedUTXOs);
  const theme = useTheme();

  const [utxos, setUtxos] = useState<UTXOItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<Map<string, boolean>>(() => {
    const map = new Map<string, boolean>();
    for (const utxo of existingSelection) {
      map.set(`${utxo.txid}:${utxo.vout}`, true);
    }
    return map;
  });

  const [message, setMessage] = useState<{
    title: string;
    description: string;
  } | null>(null);
  const messageControl = useDialogControl();

  const showMessage = useCallback(
    (title: string, description: string) => {
      setMessage({ title, description });
      messageControl.open();
    },
    [messageControl],
  );

  // Load UTXOs on layout (similar to useFocusEffect without useEffect)
  const handleLayout = useCallback(() => {
    if (loaded) return;
    const db = getDatabase();
    if (!db) return;

    db.getUnspentUTXOs().then((rows) => {
      const items: UTXOItem[] = rows.map((row) => ({
        txid: row.txid,
        vout: row.vout,
        address: row.address,
        value: BigInt(row.value),
        blockHeight: row.block_height,
        confirmations:
          chainHeight > 0 && row.block_height > 0
            ? chainHeight - row.block_height + 1
            : 0,
      }));
      setUtxos(items);
      setLoaded(true);
    });
  }, [loaded, chainHeight]);

  const handleToggle = useCallback((txid: string, vout: number) => {
    const key = `${txid}:${vout}`;
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.set(key, true);
      }
      return next;
    });
  }, []);

  const selectedCount = selected.size;

  const selectedTotal = useMemo(() => {
    let total = 0n;
    for (const utxo of utxos) {
      const key = `${utxo.txid}:${utxo.vout}`;
      if (selected.has(key)) {
        total += utxo.value;
      }
    }
    return total;
  }, [utxos, selected]);

  const handleApply = useCallback(() => {
    const selectedUtxos: { txid: string; vout: number }[] = [];
    for (const utxo of utxos) {
      const key = `${utxo.txid}:${utxo.vout}`;
      if (selected.has(key)) {
        selectedUtxos.push({ txid: utxo.txid, vout: utxo.vout });
      }
    }
    setSelectedUTXOs(selectedUtxos);
    const count = selectedUtxos.length;
    showMessage(
      t("coinControl.applied.title"),
      count === 1
        ? t("coinControl.applied.description.one", { count })
        : t("coinControl.applied.description.other", { count }),
    );
  }, [utxos, selected, setSelectedUTXOs, showMessage]);

  const handleClear = useCallback(() => {
    setSelected(new Map());
    clearSelectedUTXOs();
  }, [clearSelectedUTXOs]);

  const handleSelectAll = useCallback(() => {
    const next = new Map<string, boolean>();
    for (const utxo of utxos) {
      next.set(`${utxo.txid}:${utxo.vout}`, true);
    }
    setSelected(next);
  }, [utxos]);

  return (
    <SafeAreaView
      className="flex-1 bg-background"
      edges={["top", "bottom", "left", "right"]}
      onLayout={handleLayout}
    >
      <ScreenHeader
        title={t("coinControl.title")}
        subtitle={
          utxos.length === 1
            ? t("coinControl.subtitle.one", { count: utxos.length })
            : t("coinControl.subtitle.other", { count: utxos.length })
        }
        onBack={() => router.back()}
      />
      <ScrollView className="flex-1" contentContainerClassName="px-5 pb-4">
        {/* Selection actions — borderless pills */}
        <View className="flex-row gap-2 mt-2 mb-5">
          <Pressable
            className="bg-surface rounded-full px-4 py-2 active:opacity-70"
            onPress={handleSelectAll}
          >
            <Text className="text-primary text-xs font-semibold">
              {t("coinControl.selectAll")}
            </Text>
          </Pressable>
          <Pressable
            className="bg-surface rounded-full px-4 py-2 active:opacity-70"
            onPress={handleClear}
          >
            <Text className="text-muted-foreground text-xs font-semibold">
              {t("coinControl.clear")}
            </Text>
          </Pressable>
        </View>

        {/* UTXO list — borderless selectable rows */}
        <Text className={SECTION_LABEL}>{t("coinControl.unspentOutputs")}</Text>
        {utxos.length === 0 ? (
          <EmptyState
            icon="database-off"
            title={t("coinControl.empty.title")}
            subtitle={t("coinControl.empty.subtitle")}
          />
        ) : (
          <View className="gap-2 mt-2">
            {utxos.map((utxo, idx) => {
              const key = `${utxo.txid}:${utxo.vout}`;
              const isSelected = selected.has(key);
              return (
                <Pressable
                  key={`utxo-${idx}-${key}`}
                  onPress={() => handleToggle(utxo.txid, utxo.vout)}
                  className={`flex-row items-center rounded-2xl px-4 py-3.5 active:opacity-80 ${
                    isSelected ? "bg-primary/15" : "bg-surface"
                  }`}
                >
                  <View className="flex-1 mr-3">
                    <Text
                      className={`text-sm font-semibold ${
                        isSelected ? "text-primary" : "text-foreground"
                      }`}
                      numberOfLines={1}
                    >
                      {`${truncateTxid(utxo.txid)}:${utxo.vout}`}
                    </Text>
                    <Text
                      className="text-muted-foreground text-xs mt-0.5"
                      numberOfLines={1}
                    >
                      {`${utxo.address.slice(0, 12)}...`}
                    </Text>
                  </View>
                  <View className="mr-3">
                    <AmountText
                      value={utxo.value}
                      symbol
                      symbolSize={12}
                      className={`text-sm font-semibold ${
                        isSelected ? "text-primary" : "text-foreground"
                      }`}
                      numberOfLines={1}
                    />
                  </View>
                  <MaterialCommunityIcons
                    name={
                      isSelected ? "check-circle" : "checkbox-blank-circle-outline"
                    }
                    size={22}
                    color={
                      isSelected ? theme.colors.primary : theme.colors.textSecondary
                    }
                  />
                </Pressable>
              );
            })}
          </View>
        )}

        {/* Selection summary — card-less bordered surface */}
        {selectedCount > 0 ? (
          <View className="bg-surface rounded-2xl px-4 py-3.5 mt-5 flex-row items-center justify-between">
            <Text className="text-muted-foreground text-sm">
              {selectedCount === 1
                ? t("coinControl.selected.one", { count: selectedCount })
                : t("coinControl.selected.other", { count: selectedCount })}
            </Text>
            <AmountText
              value={selectedTotal}
              fixedDecimalScale
              symbol
              symbolSize={14}
              className="text-primary text-sm font-semibold"
            />
          </View>
        ) : null}
      </ScrollView>

      {/* Bottom action bar */}
      <View className="px-5 py-4 border-t border-border">
        <Button
          title={
            selectedCount > 0
              ? selectedCount === 1
                ? t("coinControl.useCta.one", { count: selectedCount })
                : t("coinControl.useCta.other", { count: selectedCount })
              : t("coinControl.selectCta")
          }
          onPress={handleApply}
          variant="primary"
          disabled={selectedCount === 0}
        />
      </View>

      <Dialog
        control={messageControl}
        placement="bottom"
        title={message?.title ?? ""}
        description={message?.description ?? ""}
        actions={[
          {
            label: t("common.ok"),
            onPress: () => {
              setMessage(null);
              router.back();
            },
          },
        ]}
      />
    </SafeAreaView>
  );
}
