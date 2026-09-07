/**
 * Send sheet content.
 *
 * Content-only send UI (hero amount, recipient card, recent recipients, fee
 * pills, confirm/sent/save-contact dialogs, QR scanner + contact picker) so the
 * SAME body can be rendered inside a Bloom bottom-sheet `<Dialog placement="bottom">`
 * on the home screen AND as the standalone `app/(tabs)/send.tsx` route. It renders
 * NO full-screen wrapper, NO safe-area padding, and NO absolutely positioned
 * bottom bar — the sheet chrome / scroll (or the route wrapper) owns those. The
 * total summary + Send button are normal inline elements at the end of the column.
 *
 * `address` / `amount` prefill the form (the route wrapper passes the
 * `faircoin:` deep-link params in; the home pill opens it empty). The QR scanner
 * and contact picker still open as their own full-screen overlays on top.
 *
 * `recipient` arrives from the `/@username` profile page (`app/[username].tsx`),
 * which resolved the Oxy identity AND reserved the address before navigating —
 * so it comes in ALREADY resolved, alongside that address in `address`. It only
 * seeds the initial pick; from then on the picker and the clear button own the
 * selection exactly as they do for a manual pick. Nothing async happens here for
 * it, so it opens no window in which a stale reservation could overwrite
 * `toAddress` (compare `handleSelectRecipient`'s generation guard). Reserving on
 * the profile page rather than on arrival here also keeps a mere link click from
 * spending one of the six-per-ten-minutes (sender, recipient) reservations the
 * gateway allows — a reservation advances the recipient's cursor whether or not
 * it is ever paid.
 */

import type React from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { View, Text, TextInput, ScrollView, Pressable, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import * as Clipboard from "expo-clipboard";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";
import {
  useWalletStore,
  getDatabase,
  FEE_RATES,
  type FeeLevel,
} from "../../wallet/wallet-store";
import { useContactsStore } from "../../wallet/contacts-store";
import {
  AmountInput,
  AmountText,
  Button,
  ContactAvatar,
  ListItem,
  EmptyState,
} from "../components";
import { FairCoinSymbol } from "../components/FairCoinSymbol";
import { QRScanner } from "../components/QRScanner";
import type { ScannedCode } from "../../pay/scanned-code";
import { ContactPicker } from "../components/ContactPicker";
import { SocialRecipientPicker, type SocialRecipient } from "../components/SocialRecipientPicker";
import { UserAvatar } from "../components/UserAvatar";
import { reserveNextSocialAddress, KeylessRecipientError } from "../../services/gateway-client";
import { getCachedPrice } from "../../services/price";
import type { RecentRecipientRow, ContactRow } from "../../storage/database";
import { useTheme } from "@oxyhq/bloom/theme";
import { Divider } from "@oxyhq/bloom/divider";
import { Dialog, useDialogControl } from "@oxyhq/bloom/dialog";
import { hapticSuccess, hapticError } from "../../utils/haptics";
import { playSent } from "../../services/sounds";
import { FONT_PHUDU_BLACK } from "../../utils/fonts";
import {
  formatFair,
  parseFairToUnits,
  validateAddress,
  getNetwork,
  COIN_TICKER,
  UNITS_PER_COIN,
  explorerTxUrl,
} from "@fairco.in/core";
import { t } from "../../i18n";

const FEE_LEVELS: FeeLevel[] = ["low", "medium", "high"];

/** Uppercase section label — matches the home screen's section headers. */
const SECTION_LABEL =
  "text-muted-foreground text-xs font-semibold uppercase tracking-wider";

function getFeeLabel(level: FeeLevel): string {
  switch (level) {
    case "low":
      return t("send.fee.low");
    case "medium":
      return t("send.fee.medium");
    case "high":
      return t("send.fee.high");
  }
}

const CONTENT_MAX_WIDTH = 600;
const AMOUNT_FONT_SIZE_MAX = 44;
const AMOUNT_FONT_SIZE_MIN = 22;
// Length at which the amount font starts shrinking from its max size.
const AMOUNT_SHRINK_THRESHOLD = 9;
// Length at which the amount font reaches its minimum size.
const AMOUNT_SHRINK_FLOOR = 18;

/**
 * Compute a responsive font size for the hero amount based on how
 * many characters the user has typed. This is the cross-platform
 * alternative to `adjustsFontSizeToFit`, which React Native's
 * TextInput typings do not officially expose.
 */
function getAmountFontSize(length: number): number {
  if (length <= AMOUNT_SHRINK_THRESHOLD) return AMOUNT_FONT_SIZE_MAX;
  if (length >= AMOUNT_SHRINK_FLOOR) return AMOUNT_FONT_SIZE_MIN;
  const range = AMOUNT_SHRINK_FLOOR - AMOUNT_SHRINK_THRESHOLD;
  const progress = (length - AMOUNT_SHRINK_THRESHOLD) / range;
  const span = AMOUNT_FONT_SIZE_MAX - AMOUNT_FONT_SIZE_MIN;
  return Math.round(AMOUNT_FONT_SIZE_MAX - span * progress);
}

function truncateAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

export function SendSheet({
  address: initialAddress = "",
  amount: initialAmount = "",
  recipient: initialRecipient = null,
}: {
  address?: string;
  amount?: string;
  recipient?: SocialRecipient | null;
}): React.JSX.Element {
  const router = useRouter();
  const confirmedBalance = useWalletStore((s) => s.confirmedBalance);
  const sendTransaction = useWalletStore((s) => s.sendTransaction);
  const estimateFee = useWalletStore((s) => s.estimateFee);
  const estimateSend = useWalletStore((s) => s.estimateSend);
  const loading = useWalletStore((s) => s.loading);
  const isWatchOnly = useWalletStore((s) => s.isWatchOnly);
  const selectedUTXOs = useWalletStore((s) => s.selectedUTXOs);
  const network = useWalletStore((s) => s.network);
  const contacts = useContactsStore((s) => s.contacts);
  const loadContacts = useContactsStore((s) => s.loadContacts);
  const getContactByAddress = useContactsStore((s) => s.getContactByAddress);
  const theme = useTheme();

  const [toAddress, setToAddress] = useState(initialAddress);
  // `amount` is the user-facing decimal string with optional dot (no
  // thousands separators). e.g. "1.5". `<AmountInput>` adds the
  // separators visually while typing and `parseFairToUnits` converts to
  // the bigint smallest-unit count when needed.
  const [amount, setAmount] = useState(initialAmount);
  const [feeLevel, setFeeLevel] = useState<FeeLevel>("medium");
  const [showQRScanner, setShowQRScanner] = useState(false);
  const [showContactPicker, setShowContactPicker] = useState(false);
  // Person mode unless the caller prefilled a bare address with no identity
  // behind it (a `faircoin:` URI or a QR scan) — that recipient IS the address,
  // and only Address mode renders it, so opening in Person mode would arm the
  // Send button against an address the screen never showed.
  const [recipientMode, setRecipientMode] = useState<"person" | "address">(
    initialAddress && !initialRecipient ? "address" : "person",
  );
  const [selectedRecipient, setSelectedRecipient] = useState<SocialRecipient | null>(
    initialRecipient,
  );
  const [showRecipientPicker, setShowRecipientPicker] = useState(false);
  const [reservingAddress, setReservingAddress] = useState(false);
  const [keylessRecipientUsername, setKeylessRecipientUsername] = useState<string | null>(null);
  // Generation counter guarding the `reserveNextSocialAddress` continuation
  // below against staleness: bumped on every new reservation attempt AND on
  // every mode switch, so a reservation that resolves after the user has
  // moved on (switched to Address mode, or back) is detected and discarded
  // instead of silently overwriting whatever `toAddress` now holds.
  const reservationRequestIdRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [recentRecipients, setRecentRecipients] = useState<
    RecentRecipientRow[]
  >([]);
  const [pendingSaveAddress, setPendingSaveAddress] = useState<string | null>(
    null,
  );
  const [sentTxid, setSentTxid] = useState<string | null>(null);
  const confirmControl = useDialogControl();
  const saveContactControl = useDialogControl();
  const sentControl = useDialogControl();

  const explorerUrl = sentTxid ? explorerTxUrl(sentTxid) : "";

  const handleCopyExplorerLink = useCallback(async () => {
    if (!explorerUrl) return;
    await Clipboard.setStringAsync(explorerUrl);
  }, [explorerUrl]);

  const handleShareExplorerLink = useCallback(async () => {
    if (!explorerUrl) return;
    if (!(await Sharing.isAvailableAsync())) {
      await Clipboard.setStringAsync(explorerUrl);
      return;
    }
    // Sharing.shareAsync requires a file URI on native, so write the link to
    // a temporary text file in the cache directory and share that.
    const file = new File(Paths.cache, "peable-tx-link.txt");
    if (file.exists) file.delete();
    file.create();
    file.write(explorerUrl);
    await Sharing.shareAsync(file.uri, {
      mimeType: "text/plain",
      dialogTitle: t("send.sent.share"),
      UTI: "public.plain-text",
    });
  }, [explorerUrl]);

  const handleSentDismiss = useCallback(() => {
    setSentTxid(null);
  }, []);

  // Numeric fee rate (base units per byte) from the canonical FEE_RATES map
  // so the displayed fee is always the real one (no inline magic numbers that
  // could diverge from what sendTransaction actually uses).
  const feeRate = FEE_RATES[feeLevel];

  const amountSats = useMemo<bigint | null>(
    () => parseFairToUnits(amount),
    [amount],
  );

  // Real, pre-broadcast estimate computed from the actual coins that would be
  // selected (largest-first, or the coin-control set). `selectedUTXOs` is in the
  // dependency list so the estimate updates when coin control changes.
  const sendEstimate = useMemo(
    () => estimateSend(amountSats ?? 0n, feeRate),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [estimateSend, amountSats, feeRate, selectedUTXOs],
  );

  // Fee actually charged for this send (recipient + change over the selected
  // inputs). Falls back to the flat per-level estimate only when no concrete
  // selection exists yet (e.g. amount not entered), purely for display.
  const fee = sendEstimate.fee ?? estimateFee(feeLevel);

  const totalSats = useMemo<bigint>(() => {
    if (amountSats === null || amountSats === 0n) return 0n;
    return sendEstimate.total ?? amountSats + fee;
  }, [amountSats, sendEstimate.total, fee]);

  // Full base58check + network-version validation (review finding M3). A
  // prefix/length check let malformed or wrong-network addresses pass and the
  // Send button enable; an invalid address would burn funds. We still show the
  // gentler "too short" hint for clearly-partial input.
  const addressValid = useMemo(
    () => validateAddress(toAddress, getNetwork(network)),
    [toAddress, network],
  );

  const validationError = useMemo(() => {
    if (toAddress.length > 0 && toAddress.length < 25) {
      return t("send.error.addressTooShort");
    }
    if (toAddress.length >= 25 && !addressValid) {
      return t("send.error.invalidAddress");
    }
    if (amount.length > 0 && (amountSats === null || amountSats <= 0n)) {
      return t("send.error.invalidAmount");
    }
    // Gate against the REAL fee over confirmed/selected coins, not a flat
    // estimate against the (possibly unconfirmed-inflated) total balance.
    if (
      amountSats !== null &&
      amountSats > 0n &&
      sendEstimate.insufficientFunds
    ) {
      return t("send.error.insufficientBalance");
    }
    return null;
  }, [toAddress, addressValid, amount, amountSats, sendEstimate.insufficientFunds]);

  const canSend =
    addressValid &&
    amountSats !== null &&
    amountSats > 0n &&
    validationError === null &&
    !reservingAddress;

  // Computed inline (not memoised): `getCachedPrice()` is module state, not a
  // reactive dependency, so a useMemo keyed only on amountSats would freeze
  // the first price it saw. Reading it every render keeps the fiat estimate
  // in sync with the latest poll, and the arithmetic is trivially cheap.
  const cachedPrice = getCachedPrice();
  const usdEquivalent =
    cachedPrice && amountSats !== null && amountSats > 0n
      ? ((Number(amountSats) / Number(UNITS_PER_COIN)) * cachedPrice.usd).toFixed(2)
      : null;

  const matchedContact = useMemo<ContactRow | null>(() => {
    if (toAddress.length < 25) return null;
    const found = contacts.find((c) => c.address === toAddress);
    return found ?? null;
  }, [contacts, toAddress]);

  const recentRecipientLookup = useMemo(() => {
    const map = new Map<string, ContactRow>();
    for (const c of contacts) {
      map.set(c.address, c);
    }
    return map;
  }, [contacts]);

  const handlePaste = useCallback(async () => {
    try {
      const text = await Clipboard.getStringAsync();
      if (text) {
        setToAddress(text.trim());
      }
    } catch {
      setError(t("send.error.clipboard"));
    }
  }, []);

  const handleQRScan = useCallback(
    (code: ScannedCode) => {
      if (code.kind === "payment-request") {
        // A Peable checkout QR is not an address to send to — it is a whole
        // payment request. Hand it to the approve screen, which is the only
        // place that can report the txid back to the Gateway. Mirrors the
        // deep-link path in app/_layout.tsx.
        const { request } = code;
        router.push({
          pathname: "/pay/[intent]",
          params: {
            intent: request.intentId,
            secret: request.clientSecret,
            address: request.address,
            amount: request.amount.toString(),
            network: request.network,
          },
        });
        return;
      }

      setToAddress(code.address);
      if (code.amount !== undefined) setAmount(code.amount);
    },
    [router],
  );

  const handleOpenScanner = useCallback(() => {
    setShowQRScanner(true);
  }, []);

  const handleCloseScanner = useCallback(() => {
    setShowQRScanner(false);
  }, []);

  const handleOpenContactPicker = useCallback(() => {
    setShowContactPicker(true);
  }, []);

  const handleCloseContactPicker = useCallback(() => {
    setShowContactPicker(false);
  }, []);

  const handleOpenRecipientPicker = useCallback(() => {
    setKeylessRecipientUsername(null);
    setShowRecipientPicker(true);
  }, []);

  const handleCloseRecipientPicker = useCallback(() => {
    setShowRecipientPicker(false);
  }, []);

  const handleSelectRecipient = useCallback(
    async (recipient: SocialRecipient) => {
      const requestId = ++reservationRequestIdRef.current;
      setSelectedRecipient(recipient);
      setToAddress("");
      setKeylessRecipientUsername(null);
      setReservingAddress(true);
      try {
        const reservation = await reserveNextSocialAddress(recipient.username, network);
        // The user may have switched modes (or triggered another pick) while
        // this reservation was in flight — a stale resolution must never
        // apply its address, or it would silently arm the Send button with
        // an address the current UI never showed as chosen.
        if (reservationRequestIdRef.current !== requestId) return;
        setToAddress(reservation.address);
      } catch (e: unknown) {
        if (reservationRequestIdRef.current !== requestId) return;
        if (e instanceof KeylessRecipientError) {
          setKeylessRecipientUsername(recipient.username);
          setSelectedRecipient(null);
        } else {
          setError(e instanceof Error ? e.message : t("send.error.failedSend"));
          setSelectedRecipient(null);
        }
      } finally {
        // Only the request that's still current may clear the spinner — an
        // earlier, superseded request's `finally` must not stop a newer
        // reservation's loading state from displaying.
        if (reservationRequestIdRef.current === requestId) setReservingAddress(false);
      }
    },
    [network],
  );

  const handleClearSelectedRecipient = useCallback(() => {
    reservationRequestIdRef.current += 1;
    setSelectedRecipient(null);
    setToAddress("");
    setKeylessRecipientUsername(null);
  }, []);

  const handleRecipientModeChange = useCallback((mode: "person" | "address") => {
    // Invalidate any in-flight reservation so its continuation discards its
    // result instead of applying it after the user has moved to a different
    // mode (see `handleSelectRecipient`'s staleness guard).
    reservationRequestIdRef.current += 1;
    setRecipientMode(mode);
    setSelectedRecipient(null);
    setKeylessRecipientUsername(null);
    setReservingAddress(false);
    setToAddress("");
  }, []);

  const handleContactSelect = useCallback((address: string) => {
    setToAddress(address);
  }, []);

  const handleClearRecipient = useCallback(() => {
    setToAddress("");
  }, []);

  const loadInitialData = useCallback(() => {
    const db = getDatabase();
    if (db) {
      db.getRecentRecipients(5).then(setRecentRecipients);
      loadContacts(db);
    }
  }, [loadContacts]);

  const refreshRecentRecipients = useCallback(() => {
    const db = getDatabase();
    if (db) {
      db.getRecentRecipients(5).then(setRecentRecipients);
    }
  }, []);

  const handleRecentRecipientPress = useCallback((address: string) => {
    setToAddress(address);
  }, []);

  const handleMax = useCallback(() => {
    // Max is the largest amount actually sendable: confirmed (or coin-control)
    // coins minus the fee to spend them, never the unconfirmed-inflated balance.
    const maxSats = sendEstimate.maxSendable;
    setAmount(maxSats > 0n ? formatFair(maxSats) : "");
  }, [sendEstimate.maxSendable]);

  const handleSendPress = useCallback(() => {
    setError(null);
    setSuccess(null);
    confirmControl.open();
  }, [confirmControl]);

  const handleConfirmSend = useCallback(async () => {
    setError(null);
    try {
      if (amountSats === null || amountSats <= 0n) {
        setError(t("send.error.invalidAmount"));
        return;
      }
      const sentAddress = toAddress;
      const txid = await sendTransaction(sentAddress, amountSats, feeRate);
      hapticSuccess();
      playSent();
      setSuccess(null);
      setToAddress("");
      setAmount("");
      setSelectedRecipient(null);
      setKeylessRecipientUsername(null);
      setSentTxid(txid);
      sentControl.open();

      // Recent-recipients / save-as-contact only apply to raw-address sends —
      // a social-receive address is single-use, so saving it as a reusable
      // contact would be misleading (spec §4.3, addr(i>=1) is fresh per payment).
      if (recipientMode === "address") {
        const db = getDatabase();
        if (db) {
          db.addRecentRecipient(sentAddress);
          refreshRecentRecipients();

          const existingContact = await getContactByAddress(db, sentAddress);
          if (!existingContact) {
            setPendingSaveAddress(sentAddress);
            saveContactControl.open();
          }
        }
      }
    } catch (e: unknown) {
      hapticError();
      const msg =
        e instanceof Error ? e.message : t("send.error.failedSend");
      setError(msg);
    }
  }, [
    toAddress,
    amountSats,
    feeRate,
    sendTransaction,
    recipientMode,
    getContactByAddress,
    refreshRecentRecipients,
    saveContactControl,
    sentControl,
  ]);

  const hasAmount = amount.length > 0;

  const amountLengthForSizing = amount.length > 0 ? amount.length : 1;
  const amountFontSize = getAmountFontSize(amountLengthForSizing);

  // Watch-only wallets cannot send transactions. This branch must run AFTER
  // every hook above so that toggling watch-only at runtime (wallet switch)
  // does not change the hook count between renders (Rules of Hooks).
  if (isWatchOnly) {
    return (
      <View className="items-center justify-center py-16">
        <EmptyState
          icon="lock"
          title={t("send.watchOnly.title")}
          subtitle={t("send.watchOnly.subtitle")}
        />
      </View>
    );
  }

  return (
    <>
      <View
        className="w-full self-center gap-6"
        style={{ maxWidth: CONTENT_MAX_WIDTH }}
        onLayout={loadInitialData}
      >
        {/* Hero amount — mirrors the home balance: FairCoin glyph + Phudu number */}
        <View className="items-center pt-2 pb-1">
          <View className="flex-row items-end justify-center w-full px-4">
            <View
              className="mr-1.5"
              style={{ marginBottom: amountFontSize * 0.16 }}
            >
              <FairCoinSymbol size={Math.round(amountFontSize * 0.6)} />
            </View>
            <AmountInput
              className="text-foreground flex-shrink"
              style={{
                fontFamily: FONT_PHUDU_BLACK,
                fontSize: amountFontSize,
                paddingVertical: 0,
                includeFontPadding: false,
              }}
              placeholder={t("send.amountPlaceholder")}
              placeholderTextColor={theme.colors.textSecondary}
              value={amount}
              onValueChange={setAmount}
              maxLength={20}
              numberOfLines={1}
            />
          </View>
          <Pressable
            onPress={handleMax}
            className="bg-surface rounded-full px-4 py-1.5 mt-3 active:opacity-70"
            accessibilityLabel={t("send.maxAccessibility")}
          >
            <Text className="text-primary text-xs font-bold tracking-wide">
              {t("send.max")}
            </Text>
          </Pressable>
          <Text className="text-muted-foreground text-sm mt-3">
            {t("send.usdApprox", { amount: usdEquivalent ?? "0.00" })}
          </Text>
          <Text className="text-muted-foreground text-xs mt-1">
            {t("send.available", { amount: formatFair(confirmedBalance) })}
          </Text>
        </View>

        {/* Recipient — Person (primary) / Address (secondary) toggle, spec §4.4 */}
        <View>
          <View className="flex-row items-center justify-between">
            <Text className={SECTION_LABEL}>{t("send.sendTo")}</Text>
            <View className="flex-row bg-surface rounded-full p-0.5">
              <Pressable
                onPress={() => handleRecipientModeChange("person")}
                className={`px-3 py-1.5 rounded-full ${recipientMode === "person" ? "bg-primary/15" : ""}`}
              >
                <Text
                  className={`text-xs font-semibold ${recipientMode === "person" ? "text-primary" : "text-muted-foreground"}`}
                >
                  {t("send.recipientMode.person")}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => handleRecipientModeChange("address")}
                className={`px-3 py-1.5 rounded-full ${recipientMode === "address" ? "bg-primary/15" : ""}`}
              >
                <Text
                  className={`text-xs font-semibold ${recipientMode === "address" ? "text-primary" : "text-muted-foreground"}`}
                >
                  {t("send.recipientMode.address")}
                </Text>
              </Pressable>
            </View>
          </View>

          {recipientMode === "person" ? (
            <View className="mt-2">
              <View className="bg-surface rounded-2xl px-4 py-3.5">
                {reservingAddress ? (
                  <View className="flex-row items-center py-1">
                    <ActivityIndicator size="small" color={theme.colors.primary} />
                    <Text className="text-muted-foreground text-sm ml-2">
                      {t("send.recipientMode.reserving")}
                    </Text>
                  </View>
                ) : selectedRecipient ? (
                  <View className="flex-row items-center justify-between">
                    <View className="flex-row items-center flex-1">
                      <View className="mr-3">
                        <UserAvatar
                          avatarFileId={selectedRecipient.avatarFileId}
                          displayName={selectedRecipient.displayName}
                          username={selectedRecipient.username}
                          size={40}
                        />
                      </View>
                      <View className="flex-1">
                        <Text className="text-foreground text-base font-semibold">
                          {selectedRecipient.displayName ?? selectedRecipient.username}
                        </Text>
                        <Text className="text-muted-foreground text-xs mt-0.5">
                          @{selectedRecipient.username}
                        </Text>
                      </View>
                    </View>
                    <Pressable
                      className="p-1.5 rounded-full active:opacity-60"
                      onPress={handleClearSelectedRecipient}
                      accessibilityLabel={t("send.clearRecipient")}
                    >
                      <MaterialCommunityIcons
                        name="close-circle"
                        size={20}
                        color={theme.colors.textSecondary}
                      />
                    </Pressable>
                  </View>
                ) : (
                  <Pressable
                    className="flex-row items-center justify-between active:opacity-70"
                    onPress={handleOpenRecipientPicker}
                  >
                    <Text className="text-muted-foreground text-base">
                      {t("send.recipientMode.choosePlaceholder")}
                    </Text>
                    <MaterialCommunityIcons
                      name="account-search"
                      size={20}
                      color={theme.colors.primary}
                    />
                  </Pressable>
                )}
              </View>

              {keylessRecipientUsername ? (
                <View className="bg-primary/10 rounded-2xl p-3.5 mt-2.5">
                  <Text className="text-foreground text-sm text-center">
                    {t("send.recipientMode.keyless", { username: keylessRecipientUsername })}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : (
            <>
              <View className="bg-surface rounded-2xl px-4 py-3.5 mt-2">
                {matchedContact ? (
                  <View className="flex-row items-center justify-between">
                    <View className="flex-row items-center flex-1">
                      <View className="mr-3">
                        <ContactAvatar name={matchedContact.name} size={40} />
                      </View>
                      <View className="flex-1">
                        <Text className="text-foreground text-base font-semibold">
                          {matchedContact.name}
                        </Text>
                        <Text className="text-muted-foreground text-xs mt-0.5">
                          {truncateAddress(matchedContact.address)}
                        </Text>
                      </View>
                    </View>
                    <Pressable
                      className="p-1.5 rounded-full active:opacity-60"
                      onPress={handleClearRecipient}
                      accessibilityLabel={t("send.clearRecipient")}
                    >
                      <MaterialCommunityIcons
                        name="close-circle"
                        size={20}
                        color={theme.colors.textSecondary}
                      />
                    </Pressable>
                  </View>
                ) : (
                  <TextInput
                    className="text-foreground text-base"
                    style={{ paddingVertical: 2 }}
                    placeholder={t("send.addressPlaceholder")}
                    placeholderTextColor={theme.colors.textSecondary}
                    value={toAddress}
                    onChangeText={setToAddress}
                    autoCapitalize="none"
                    autoCorrect={false}
                    multiline={false}
                  />
                )}
              </View>

              <View className="flex-row gap-2 mt-2.5">
                <Pressable
                  className="flex-1 flex-row items-center justify-center bg-surface rounded-full px-3 py-2.5 active:opacity-70"
                  onPress={handlePaste}
                >
                  <MaterialCommunityIcons
                    name="content-paste"
                    size={14}
                    color={theme.colors.primary}
                  />
                  <Text className="text-primary text-xs ml-1.5 font-semibold">
                    {t("send.paste")}
                  </Text>
                </Pressable>
                <Pressable
                  className="flex-1 flex-row items-center justify-center bg-surface rounded-full px-3 py-2.5 active:opacity-70"
                  onPress={handleOpenScanner}
                >
                  <MaterialCommunityIcons
                    name="qrcode-scan"
                    size={14}
                    color={theme.colors.primary}
                  />
                  <Text className="text-primary text-xs ml-1.5 font-semibold">
                    {t("send.scanQR")}
                  </Text>
                </Pressable>
                <Pressable
                  className="flex-1 flex-row items-center justify-center bg-surface rounded-full px-3 py-2.5 active:opacity-70"
                  onPress={handleOpenContactPicker}
                >
                  <MaterialCommunityIcons
                    name="account-box"
                    size={14}
                    color={theme.colors.primary}
                  />
                  <Text className="text-primary text-xs ml-1.5 font-semibold">
                    {t("send.contacts")}
                  </Text>
                </Pressable>
              </View>
            </>
          )}
        </View>

        {validationError && toAddress.length > 0 ? (
          <Text className="text-destructive text-xs -mt-3 px-1">
            {validationError}
          </Text>
        ) : null}

        {/* Recent recipients — borderless pills */}
        {recentRecipients.length > 0 ? (
          <View>
            <Text className={SECTION_LABEL}>{t("send.recent")}</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerClassName="gap-2 pr-4 mt-2"
            >
              {recentRecipients.map((r) => {
                const contact = recentRecipientLookup.get(r.address);
                const isSelected = toAddress === r.address;
                return (
                  <Pressable
                    key={r.address}
                    onPress={() => handleRecentRecipientPress(r.address)}
                    className={`flex-row items-center rounded-full px-3 py-2 ${
                      isSelected ? "bg-primary/15" : "bg-surface"
                    }`}
                  >
                    <View className="mr-2">
                      <ContactAvatar
                        name={contact?.name ?? r.address}
                        size={28}
                      />
                    </View>
                    <Text
                      className={`text-xs font-medium ${
                        isSelected ? "text-primary" : "text-foreground"
                      }`}
                    >
                      {contact?.name ?? truncateAddress(r.address)}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        ) : null}

        {/* Fee selector — borderless segmented pills */}
        <View>
          <Text className={SECTION_LABEL}>{t("send.networkFee")}</Text>
          <View className="flex-row gap-2 mt-2">
            {FEE_LEVELS.map((level) => {
              const isSelected = feeLevel === level;
              return (
                <Pressable
                  key={level}
                  className={`flex-1 py-3 items-center ${
                    isSelected
                      ? "bg-primary/15 rounded-full"
                      : "bg-surface rounded-2xl"
                  }`}
                  onPress={() => setFeeLevel(level)}
                >
                  <Text
                    className={`text-sm font-semibold ${
                      isSelected ? "text-primary" : "text-foreground"
                    }`}
                  >
                    {getFeeLabel(level)}
                  </Text>
                  <Text className="text-muted-foreground text-[10px] mt-0.5">
                    {t("send.feeUnit", { units: estimateFee(level).toString() })}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Error / success — borderless tinted strips */}
        {error ? (
          <View className="bg-destructive/10 rounded-2xl p-3.5">
            <Text className="text-destructive text-sm text-center">{error}</Text>
          </View>
        ) : null}
        {success ? (
          <View className="bg-primary/10 rounded-2xl p-3.5">
            <Text className="text-primary text-sm text-center">{success}</Text>
          </View>
        ) : null}

        {/* Total summary + Send button (inline at the end — the sheet chrome /
            route wrapper owns the surrounding padding, so these are normal
            elements, not an absolutely positioned bottom bar). */}
        <View className="gap-3">
          {hasAmount ? (
            <View className="flex-row justify-between items-center px-1">
              <Text className="text-muted-foreground text-xs">
                {t("send.total")}
              </Text>
              <AmountText
                value={totalSats}
                suffix={` ${COIN_TICKER}`}
                className="text-foreground text-sm font-semibold"
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
              />
            </View>
          ) : null}
          <Button
            title={t("send.sendCta")}
            onPress={handleSendPress}
            variant="primary"
            size="lg"
            disabled={!canSend}
            loading={loading}
          />
        </View>
      </View>

      {/* Confirmation prompt */}
      <Dialog
        control={confirmControl}
        placement="bottom"
        title={t("send.confirm.title")}
        actions={[
          { label: t("send.confirm.cta"), onPress: handleConfirmSend },
          { label: t("common.cancel"), color: "cancel" },
        ]}
      >
        <View className="mt-2">
          <ListItem
            title={t("send.confirm.to")}
            subtitle={
              recipientMode === "person" && selectedRecipient
                ? `${selectedRecipient.displayName ?? selectedRecipient.username} (@${selectedRecipient.username})`
                : matchedContact
                  ? matchedContact.name
                  : toAddress
            }
            showChevron={false}
          />
          <ListItem
            title={t("send.confirm.amount")}
            value={
              <AmountText
                value={amountSats ?? 0n}
                fixedDecimalScale
                suffix={` ${COIN_TICKER}`}
                className="text-muted-foreground text-sm"
              />
            }
            showChevron={false}
          />
          <ListItem
            title={t("send.confirm.fee")}
            value={
              <AmountText
                value={fee}
                fixedDecimalScale
                suffix={` ${COIN_TICKER}`}
                className="text-muted-foreground text-sm"
              />
            }
            showChevron={false}
          />
          <Divider style={{ marginHorizontal: 16 }} />
          <ListItem
            title={t("send.confirm.total")}
            value={
              <AmountText
                value={totalSats}
                fixedDecimalScale
                suffix={` ${COIN_TICKER}`}
                className="text-muted-foreground text-sm"
              />
            }
            showChevron={false}
            isLast
          />
        </View>
      </Dialog>

      {/* Transaction sent prompt */}
      <Dialog
        control={sentControl}
        onClose={handleSentDismiss}
        placement="bottom"
        title={t("send.sent.title")}
        actions={[
          {
            label: t("send.sent.copy"),
            onPress: handleCopyExplorerLink,
            shouldCloseOnPress: false,
          },
          {
            label: t("send.sent.share"),
            onPress: handleShareExplorerLink,
            shouldCloseOnPress: false,
          },
          { label: t("common.done"), color: "cancel" },
        ]}
      >
        <Text
          selectable
          className="text-muted-foreground text-sm text-center"
        >
          {explorerUrl}
        </Text>
      </Dialog>

      {/* Save contact prompt */}
      <Dialog
        control={saveContactControl}
        placement="bottom"
        title={t("send.saveContact.title")}
        description={
          pendingSaveAddress
            ? t("send.saveContact.description", {
                address:
                  pendingSaveAddress.length > 16
                    ? `${pendingSaveAddress.slice(0, 8)}...${pendingSaveAddress.slice(-8)}`
                    : pendingSaveAddress,
              })
            : ""
        }
        actions={[
          {
            label: t("send.saveContact.cta"),
            onPress: () => {
              router.push("/contacts");
              setPendingSaveAddress(null);
            },
          },
          { label: t("common.no"), color: "cancel" },
        ]}
      />

      {/* QR Scanner */}
      <QRScanner
        visible={showQRScanner}
        onScan={handleQRScan}
        onClose={handleCloseScanner}
      />

      {/* Contact Picker */}
      <ContactPicker
        visible={showContactPicker}
        onSelect={handleContactSelect}
        onClose={handleCloseContactPicker}
      />

      {/* Social recipient picker (spec §4.4 step 1) */}
      <SocialRecipientPicker
        visible={showRecipientPicker}
        onSelect={handleSelectRecipient}
        onClose={handleCloseRecipientPicker}
      />
    </>
  );
}
