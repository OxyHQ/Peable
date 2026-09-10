/**
 * Receive sheet content.
 *
 * Content-only receive UI (QR, copyable address, quick actions, all-addresses
 * list, share) so the SAME body can be rendered inside a Bloom bottom-sheet
 * `<Dialog placement="bottom">` on the home screen AND as the standalone
 * `app/(tabs)/receive.tsx` route. It renders NO full-screen wrapper, NO safe-area
 * padding, and NO absolutely positioned button — the sheet chrome / scroll (or
 * the route wrapper) owns those. The "Share" action is a normal inline element
 * at the end of the column.
 */

import type React from "react";
import { useCallback, useMemo, useState } from "react";
import { View, Text, Pressable, ActivityIndicator } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import QRCode from "react-native-qrcode-svg";
import { Dialog, useDialogControl } from "@oxy.so/bloom/dialog";
import { useTheme } from "@oxy.so/bloom/theme";
import { useOxy } from "@oxy.so/services";
import { useWalletStore } from "../../wallet/wallet-store";
import { Button, ListItem } from "../components";
import { t } from "../../i18n";
import { FONT_PHUDU_BLACK } from "../../utils/fonts";

const CONTENT_MAX_WIDTH = 500;
const QR_SIZE = 220;

/** Uppercase section label — matches the home screen's section headers. */
const SECTION_LABEL =
  "text-muted-foreground text-xs font-semibold uppercase tracking-wider";

function truncateAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 10)}...${address.slice(-8)}`;
}

/**
 * @param heading  When true (default) render the sheet's own "Receive" title
 *   block. Pass false when the host `<Dialog>` already supplies a title, to
 *   avoid a duplicated heading.
 */
export function ReceiveSheet({
  heading = true,
}: {
  heading?: boolean;
}): React.JSX.Element {
  const receiveAddress = useWalletStore((s) => s.currentReceiveAddress);
  const addresses = useWalletStore((s) => s.addresses);
  const getNewAddress = useWalletStore((s) => s.getNewAddress);
  const socialReceiveDefaultAddress = useWalletStore((s) => s.socialReceiveDefaultAddress);
  const { user } = useOxy();
  const theme = useTheme();

  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [showAllAddresses, setShowAllAddresses] = useState(false);
  const displayAddress = selectedAddress ?? socialReceiveDefaultAddress ?? receiveAddress;

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

  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(displayAddress);
    showMessage(
      t("receive.addressCopied.title"),
      t("receive.addressCopied.description"),
    );
  }, [displayAddress, showMessage]);

  const handleNewAddress = useCallback(() => {
    const addr = getNewAddress();
    setSelectedAddress(addr);
  }, [getNewAddress]);

  const handleShare = useCallback(async () => {
    const uri = `faircoin:${displayAddress}`;
    const payload = t("receive.shareMessage", { uri });

    // On platforms without a native share sheet (web, electron) fall back to
    // copying the payment request to the clipboard.
    if (!(await Sharing.isAvailableAsync())) {
      await Clipboard.setStringAsync(payload);
      showMessage(
        t("receive.addressCopied.title"),
        t("receive.addressCopied.description"),
      );
      return;
    }

    // expo-sharing requires a file URI, so write the payment request to a
    // temporary text file in the cache directory and share that.
    const file = new File(Paths.cache, "peable-payment-request.txt");
    if (file.exists) file.delete();
    file.create();
    file.write(payload);
    await Sharing.shareAsync(file.uri, {
      mimeType: "text/plain",
      dialogTitle: t("receive.paymentRequestTitle"),
      UTI: "public.plain-text",
    });
  }, [displayAddress, showMessage]);

  const handleSelectAddress = useCallback((address: string) => {
    setSelectedAddress(address);
    setShowAllAddresses(false);
  }, []);

  const handleCopyAddress = useCallback(
    async (address: string) => {
      await Clipboard.setStringAsync(address);
      showMessage(
        t("receive.addressCopied.title"),
        t("receive.addressCopied.description"),
      );
    },
    [showMessage],
  );

  const handleToggleAllAddresses = useCallback(() => {
    setShowAllAddresses((prev) => !prev);
  }, []);

  const addressListItems = useMemo(
    () =>
      addresses.map((address, idx) => ({
        address,
        index: idx,
        isActive: address === displayAddress,
        isLast: idx === addresses.length - 1,
        label: truncateAddress(address),
      })),
    [addresses, displayAddress],
  );

  if (!receiveAddress) {
    return (
      <View className="items-center justify-center py-16">
        <ActivityIndicator size="large" color={theme.colors.primary} />
        <Text className="text-muted-foreground text-sm mt-4">
          {t("receive.generating")}
        </Text>
      </View>
    );
  }

  return (
    <>
      <View
        className="w-full self-center gap-5"
        style={{ maxWidth: CONTENT_MAX_WIDTH }}
      >
        {/* Title (suppressed when a host Dialog already shows one) */}
        {heading ? (
          <View className="items-center pt-2">
            <Text
              className="text-foreground"
              style={{ fontFamily: FONT_PHUDU_BLACK, fontSize: 28 }}
            >
              {t("receive.title")}
            </Text>
            <Text className="text-muted-foreground text-sm mt-1 text-center">
              {t("receive.subtitle")}
            </Text>
          </View>
        ) : null}

        {user?.username ? (
          <View className="items-center">
            <Text className="text-muted-foreground text-sm">{t("receive.payMeAt")}</Text>
            <Text className="text-foreground text-lg font-bold mt-0.5">@{user.username}</Text>
          </View>
        ) : null}

        {/* Big centered QR — a clean white panel (crisp + scannable), no card */}
        <View className="items-center">
          <View className="bg-white rounded-3xl p-5 items-center justify-center">
            <QRCode
              value={`faircoin:${displayAddress}`}
              size={QR_SIZE}
              color="#1b1e09"
              backgroundColor="transparent"
            />
          </View>
        </View>

        {/* Address — card-less filled surface field */}
        <View>
          <Text className={SECTION_LABEL}>{t("receive.yourAddress")}</Text>
          <View className="flex-row items-center bg-surface rounded-2xl px-4 py-3.5 mt-2">
            <Pressable onPress={handleCopy} className="flex-1 active:opacity-70">
              <Text className="text-foreground text-sm font-mono" selectable>
                {displayAddress}
              </Text>
            </Pressable>
            <Pressable
              onPress={handleCopy}
              className="ml-3 w-9 h-9 rounded-full bg-primary/10 items-center justify-center active:opacity-70"
              accessibilityLabel={t("receive.copy")}
            >
              <MaterialCommunityIcons
                name="content-copy"
                size={16}
                color={theme.colors.primary}
              />
            </Pressable>
          </View>
        </View>

        {/* Quick actions */}
        <View className="flex-row gap-2">
          <Pressable
            onPress={handleNewAddress}
            className="flex-1 flex-row items-center justify-center bg-surface rounded-full py-3 active:opacity-70"
          >
            <MaterialCommunityIcons
              name="plus-circle-outline"
              size={16}
              color={theme.colors.primary}
            />
            <Text className="text-foreground text-sm font-semibold ml-2">
              {t("receive.new_address")}
            </Text>
          </Pressable>
          {addresses.length > 1 ? (
            <Pressable
              onPress={handleToggleAllAddresses}
              className="flex-1 flex-row items-center justify-center bg-surface rounded-full py-3 active:opacity-70"
            >
              <MaterialCommunityIcons
                name={showAllAddresses ? "chevron-up" : "format-list-bulleted"}
                size={16}
                color={theme.colors.primary}
              />
              <Text className="text-foreground text-sm font-semibold ml-2">
                {showAllAddresses
                  ? t("receive.hideList")
                  : t("receive.allAddresses", { count: addresses.length })}
              </Text>
            </Pressable>
          ) : null}
        </View>

        {/* All addresses (collapsible) — borderless surface container */}
        {showAllAddresses && addresses.length > 0 ? (
          <View className="bg-surface rounded-2xl overflow-hidden">
            {addressListItems.map((item) => (
              <ListItem
                key={`${item.index}-${item.address}`}
                title={item.label}
                subtitle={`#${item.index + 1}`}
                icon={item.isActive ? "radiobox-marked" : "radiobox-blank"}
                iconColor={
                  item.isActive
                    ? theme.colors.primary
                    : theme.colors.textSecondary
                }
                iconBg={item.isActive ? "bg-primary/10" : "bg-background"}
                onPress={() => handleSelectAddress(item.address)}
                trailing={
                  <Pressable
                    className="p-1.5"
                    onPress={() => handleCopyAddress(item.address)}
                  >
                    <MaterialCommunityIcons
                      name="content-copy"
                      size={16}
                      color={theme.colors.primary}
                    />
                  </Pressable>
                }
                showChevron={false}
                isLast={item.isLast}
              />
            ))}
          </View>
        ) : null}

        {/* Share (inline at the end — the standalone route / sheet chrome owns
            the surrounding padding, so this is a normal element, not an
            absolutely positioned bottom bar). */}
        <Button
          title={t("receive.share")}
          onPress={handleShare}
          variant="primary"
          size="lg"
        />
      </View>

      <Dialog
        control={messageControl}
        placement="bottom"
        title={message?.title ?? ""}
        description={message?.description ?? ""}
        actions={[{ label: t("common.ok"), onPress: () => setMessage(null) }]}
      />
    </>
  );
}
