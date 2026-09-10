/**
 * Transaction detail sheet content.
 *
 * Content-only transaction detail (type badge, amount, details list, editable
 * note, "view on explorer" / copy / add-to-contacts actions) so the SAME body
 * renders inside a Bloom bottom-sheet `<Dialog placement="bottom">` when a
 * transaction row is tapped AND inside the standalone `app/transaction/[txid]`
 * route. It renders NO full-screen wrapper, NO safe-area padding and NO scroll
 * container — the host `<Dialog>` (which the caller opens with a `title`) or the
 * route wrapper owns the sheet chrome, horizontal padding and scroll. The
 * standalone screen's back/close affordance lives in the route wrapper, not
 * here; a sheet is dismissed by its backdrop.
 */

import type React from "react";
import { useCallback, useMemo, useState } from "react";
import { View, Text, TextInput, Pressable } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useTheme } from "@oxy.so/bloom/theme";
import { Dialog, useDialogControl } from "@oxy.so/bloom/dialog";
import { formatUnits, COIN_TICKER, explorerTxUrl } from "@fairco.in/core";
import {
  useWalletStore,
  getDatabase,
  type WalletTransaction,
} from "../../wallet/wallet-store";
import { AmountText, EmptyState } from "../components";
import { Button as BloomButton } from "@oxy.so/bloom/button";
import { FairCoinSymbol } from "../components/FairCoinSymbol";
import type { ContactRow } from "../../storage/database";
import { FONT_PHUDU_BLACK } from "../../utils/fonts";
import { useTransactionEnrichment } from "../../hooks/useTransactionEnrichment";
import { t } from "../../i18n";

const CONTENT_MAX_WIDTH = 500;

/** Uppercase section label — matches the home screen's section headers. */
const SECTION_LABEL =
  "text-muted-foreground text-xs font-semibold uppercase tracking-wider";

/**
 * A single card-less detail row: muted label on the left, value on the right,
 * a hairline underline between rows. Optionally pressable (with a copy glyph)
 * for the copyable txid / address rows.
 */
function DetailRow({
  label,
  value,
  valueClassName = "text-foreground",
  onPress,
  copyable = false,
  isLast = false,
}: {
  label: string;
  value: string;
  valueClassName?: string;
  onPress?: () => void;
  copyable?: boolean;
  isLast?: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const row = (
    <View
      className={`flex-row items-center justify-between py-3.5 ${
        isLast ? "" : "border-b border-border/40"
      }`}
    >
      <Text className="text-muted-foreground text-[15px]">{label}</Text>
      <View className="flex-row items-center flex-1 justify-end ml-4">
        <Text
          className={`text-[15px] font-medium text-right ${valueClassName}`}
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {value}
        </Text>
        {copyable ? (
          <MaterialCommunityIcons
            name="content-copy"
            size={14}
            color={theme.colors.primary}
            style={{ marginLeft: 8 }}
          />
        ) : null}
      </View>
    </View>
  );
  if (onPress) {
    return (
      <Pressable onPress={onPress} className="active:opacity-60">
        {row}
      </Pressable>
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function truncateAddress(address: string): string {
  if (address.length <= 20) return address;
  return `${address.slice(0, 10)}...${address.slice(-10)}`;
}

// ---------------------------------------------------------------------------
// Sheet content
// ---------------------------------------------------------------------------

export function TransactionDetailSheet({
  txid,
}: {
  txid: string;
}): React.JSX.Element {
  const router = useRouter();
  const transactions = useWalletStore((s) => s.transactions);
  const theme = useTheme();

  const [note, setNote] = useState("");
  const [noteLoaded, setNoteLoaded] = useState(false);
  const [contact, setContact] = useState<ContactRow | null>(null);
  const [contactChecked, setContactChecked] = useState(false);

  const messageControl = useDialogControl();
  const [message, setMessage] = useState<{
    title: string;
    description: string;
  } | null>(null);

  const showMessage = useCallback(
    (title: string, description: string) => {
      setMessage({ title, description });
      messageControl.open();
    },
    [messageControl],
  );

  const transaction = useMemo<WalletTransaction | undefined>(
    () => transactions.find((tx) => tx.txid === txid),
    [transactions, txid],
  );

  const enrichment = useTransactionEnrichment(transaction ? [transaction.address] : []);
  const identity = transaction ? enrichment[transaction.address] : undefined;

  // Load note and contact info on layout (avoids an effect for a one-shot read).
  const handleLayout = useCallback(() => {
    if (!txid) return;

    const db = getDatabase();
    if (db && !noteLoaded) {
      db.getTxNote(txid).then((savedNote) => {
        if (savedNote) {
          setNote(savedNote);
        }
        setNoteLoaded(true);
      });
    }

    if (db && transaction && !contactChecked) {
      db.getContactByAddress(transaction.address).then((c) => {
        setContact(c);
        setContactChecked(true);
      });
    }
  }, [txid, noteLoaded, transaction, contactChecked]);

  const handleSaveNote = useCallback(() => {
    if (!txid) return;
    const db = getDatabase();
    if (db) {
      db.setTxNote(txid, note.trim());
      showMessage(
        t("transaction.savedNote.title"),
        t("transaction.savedNote.description"),
      );
    }
  }, [txid, note, showMessage]);

  const handleViewExplorer = useCallback(() => {
    if (!txid) return;
    Linking.openURL(explorerTxUrl(txid));
  }, [txid]);

  const handleCopyTxid = useCallback(() => {
    if (!txid) return;
    Clipboard.setStringAsync(txid);
    showMessage(
      t("transaction.txidCopied.title"),
      t("transaction.txidCopied.description"),
    );
  }, [txid, showMessage]);

  const handleCopyAddress = useCallback(() => {
    if (!transaction) return;
    Clipboard.setStringAsync(transaction.address);
    showMessage(
      t("transaction.addressCopied.title"),
      t("transaction.addressCopied.description"),
    );
  }, [transaction, showMessage]);

  const handleAddToContacts = useCallback(() => {
    router.push("/contacts");
  }, [router]);

  if (!transaction) {
    return (
      <View className="items-center justify-center py-12">
        <EmptyState
          icon="file-find"
          title={t("transaction.notFound.title")}
          subtitle={t("transaction.notFound.subtitle")}
        />
      </View>
    );
  }

  const isPositive = transaction.amount >= 0n;
  const amountSign = isPositive ? "+" : "-";
  const absAmount =
    transaction.amount < 0n ? -transaction.amount : transaction.amount;
  const amountExact = formatUnits(absAmount);
  const amountColor = isPositive ? "text-primary" : "text-red-400";
  const isConfirmed = transaction.confirmations >= 6;

  return (
    <View
      className="w-full self-center"
      style={{ maxWidth: CONTENT_MAX_WIDTH }}
      onLayout={handleLayout}
    >
      {/* Amount hero — sign, then FairCoin glyph, then Phudu number (coloured
          by direction). The +/- leads, before the glyph. */}
      <View className="items-center mb-6 pt-1">
        <View className="flex-row items-end justify-center px-4">
          <Text
            className={amountColor}
            style={{
              fontFamily: FONT_PHUDU_BLACK,
              fontSize: 40,
              includeFontPadding: false,
              marginRight: 3,
            }}
          >
            {amountSign}
          </Text>
          <View className="mr-1.5" style={{ marginBottom: 40 * 0.16 }}>
            <FairCoinSymbol
              size={Math.round(40 * 0.6)}
              color={isPositive ? undefined : "#f87171"}
            />
          </View>
          <AmountText
            value={absAmount}
            className={amountColor}
            style={{
              fontFamily: FONT_PHUDU_BLACK,
              fontSize: 40,
              includeFontPadding: false,
            }}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.5}
          />
        </View>
        <Text className="text-muted-foreground text-sm mt-2">{COIN_TICKER}</Text>
      </View>

      {/* Details — card-less label/value rows with hairline dividers */}
      <View className="mb-7">
        <Text className={SECTION_LABEL}>{t("transaction.details")}</Text>
        <View className="mt-1">
          <DetailRow
            label={t("transaction.status")}
            value={t("transaction.statusValue", {
              status: isConfirmed
                ? t("transaction.status.confirmed")
                : t("transaction.status.pending"),
              count: transaction.confirmations,
            })}
            valueClassName={isConfirmed ? "text-primary" : "text-yellow-400"}
          />
          <DetailRow
            label={t("transaction.amount")}
            value={`${amountSign}${amountExact} ${COIN_TICKER}`}
          />
          <DetailRow
            label={t("transaction.txid")}
            value={truncateAddress(txid)}
            onPress={handleCopyTxid}
            copyable
          />
          <DetailRow
            label={t("transaction.date")}
            value={formatTimestamp(transaction.timestamp)}
          />
          {transaction.type === "send" ? (
            <DetailRow
              label={t("transaction.fee")}
              value={t("transaction.feeIncluded")}
            />
          ) : null}
          {identity && identity.kind !== "unknown" ? (
            <DetailRow
              label={t("transaction.with")}
              value={
                identity.kind === "merchant"
                  ? (identity.displayName ?? t("transaction.item.merchant"))
                  : `${identity.displayName ?? identity.username ?? ""}${
                      identity.username ? ` (@${identity.username})` : ""
                    }`
              }
            />
          ) : null}
          <DetailRow
            label={t("transaction.address")}
            value={
              contact
                ? `${contact.name} (${truncateAddress(transaction.address)})`
                : truncateAddress(transaction.address)
            }
            onPress={handleCopyAddress}
            copyable
            isLast
          />
        </View>
      </View>

      {/* Transaction note — card-less surface field. Bloom's Button directly. */}
      <View className="mb-6">
        <Text className={SECTION_LABEL}>{t("transaction.note")}</Text>
        <View className="bg-surface rounded-2xl px-4 py-3 mt-2">
          <TextInput
            className="text-foreground text-sm"
            placeholder={t("transaction.notePlaceholder")}
            placeholderTextColor={theme.colors.textSecondary}
            value={note}
            onChangeText={setNote}
            multiline
            numberOfLines={3}
          />
        </View>
        <View className="mt-2.5">
          <BloomButton
            variant="secondary"
            size="sm"
            onPress={handleSaveNote}
            style={{ width: "100%" }}
          >
            {t("transaction.saveNote")}
          </BloomButton>
        </View>
      </View>

      {/* Actions — Bloom's Button directly. Copy is handled by tapping the txid
          row above, so no separate copy button here. */}
      <View className="gap-3">
        <BloomButton
          variant="secondary"
          onPress={handleViewExplorer}
          style={{ width: "100%" }}
          icon={
            <MaterialCommunityIcons
              name="open-in-new"
              size={18}
              color={theme.colors.text}
            />
          }
        >
          {t("transaction.viewExplorer")}
        </BloomButton>
        {!contact && contactChecked ? (
          <BloomButton
            variant="outline"
            onPress={handleAddToContacts}
            style={{ width: "100%" }}
            icon={
              <MaterialCommunityIcons
                name="account-plus"
                size={18}
                color={theme.colors.primary}
              />
            }
          >
            {t("transaction.addToContacts")}
          </BloomButton>
        ) : null}
      </View>

      <Dialog
        control={messageControl}
        placement="bottom"
        title={message?.title ?? ""}
        description={message?.description ?? ""}
        actions={[{ label: t("common.ok"), onPress: () => setMessage(null) }]}
      />
    </View>
  );
}
