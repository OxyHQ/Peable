/**
 * Settings screen.
 * Account, wallets, security, appearance, network, backup, advanced, about, and
 * danger zone.
 *
 * Rows are grouped into Bloom's iOS-style `SettingsListGroup` cards: an
 * uppercase section header above a rounded surface whose rows are separated by
 * the group's own inset hairlines. Each row leads with the home screen's green
 * icon-circle so the palette stays consistent across tabs.
 *
 * Kept in step with FAIRWallet's screen (this file is its fork). Peable's own
 * deltas: an Oxy account group, no multi-wallet manager (Peable has the single
 * identity wallet), the language sheet Oxy owns, and a READ-ONLY host (a
 * browser: no keystore, so no wallet — see `src/wallet/capability.ts`) that
 * renders only the groups that need no wallet: account, appearance and about.
 */

import { useCallback, useMemo, useState } from "react";
import { View, Text, ScrollView, Pressable } from "react-native";
import { Switch } from "@oxy.so/bloom/switch";
import { useRouter, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTabScreenBottomInset } from "../../src/ui/navigation/tabs";
import * as LocalAuthentication from "expo-local-authentication";
import * as DocumentPicker from "expo-document-picker";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";
import * as Clipboard from "expo-clipboard";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useWalletStore } from "../../src/wallet/wallet-store";
import { useLockStore } from "../../src/wallet/lock-store";
import {
  verifyPin,
  isBiometricsEnabled,
  setBiometricsEnabled as storeBiometricsEnabled,
  getMnemonic,
  getAutoLockTimeout,
  setAutoLockTimeout,
  getCurrency,
  setCurrency,
} from "../../src/storage/secure-store";
import { PinDots, PinPad } from "../../src/ui/components";
import type { NetworkType } from "@fairco.in/core";
import { useBloomTheme } from "@oxy.so/bloom/theme";
import type { ThemeMode } from "@oxy.so/bloom/theme";
import { Dialog, useDialogControl } from "@oxy.so/bloom/dialog";
import type { DialogControlProps } from "@oxy.so/bloom/dialog";
import { SettingsListGroup, SettingsListItem } from "@oxy.so/bloom/settings-list";
import { toast } from "@oxy.so/bloom/toast";
import { useAuth } from "@oxy.so/services";
import { useWalletCapability } from "../../src/wallet/use-wallet-capability";
import { UserAvatar } from "../../src/ui/components/UserAvatar";
import { findLanguageOption, t } from "../../src/i18n";
import { useLanguageStore } from "../../src/i18n/store";
import Constants from "expo-constants";

const APP_VERSION: string =
  Constants.expoConfig?.version ?? Constants.manifest2?.extra?.expoClient?.version ?? "1.0.0";
const PIN_LENGTH = 6;

/** Middle-truncate an address for the identity header (10 head / 8 tail). */
function truncateAddress(address: string): string {
  if (address.length <= 20) return address;
  return `${address.slice(0, 10)}…${address.slice(-8)}`;
}

// ---------------------------------------------------------------------------
// Row icon — the home screen's green icon-circle, used as the leading element
// of every settings row.
// ---------------------------------------------------------------------------

function RowIcon({
  name,
}: {
  name: React.ComponentProps<typeof MaterialCommunityIcons>["name"];
}) {
  const { theme: { colors } } = useBloomTheme();

  return (
    <View className="w-8 h-8 rounded-full bg-primary/10 items-center justify-center">
      <MaterialCommunityIcons name={name} size={18} color={colors.primary} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// PIN entry modal (for verifying current PIN before sensitive actions)
// ---------------------------------------------------------------------------

interface PinModalProps {
  visible: boolean;
  title: string;
  onCancel: () => void;
  onSuccess: () => void;
}

function PinModal({ visible, title, onCancel, onSuccess }: PinModalProps) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const handleCancel = useCallback(() => {
    setPin("");
    setError(null);
    onCancel();
  }, [onCancel]);

  const handleDigitPress = useCallback(
    (digit: string) => {
      if (verifying) return;

      setError(null);
      setPin((prev) => {
        if (prev.length >= PIN_LENGTH) return prev;
        const next = prev + digit;

        if (next.length === PIN_LENGTH) {
          setVerifying(true);
          verifyPin(next)
            .then((correct) => {
              if (correct) {
                setPin("");
                setError(null);
                onSuccess();
              } else {
                setError(t("settings.pin.wrong"));
                setPin("");
              }
              setVerifying(false);
            })
            .catch(() => {
              setError(t("settings.pin.verificationFailed"));
              setPin("");
              setVerifying(false);
            });
        }

        return next;
      });
    },
    [verifying, onSuccess],
  );

  const handleBackspace = useCallback(() => {
    if (verifying) return;
    setPin((prev) => prev.slice(0, -1));
    setError(null);
  }, [verifying]);

  return (
    <Dialog
      open={visible}
      onClose={handleCancel}
      placement="bottom"
      title={title}
      description={t("settings.pin.enterDescription")}
    >
      <View className="items-center gap-4 pt-1">
        <PinDots length={PIN_LENGTH} filled={pin.length} error={error !== null} />
        {error ? (
          <Text className="text-red-400 text-xs text-center">{error}</Text>
        ) : null}
        <PinPad
          onDigit={handleDigitPress}
          onBackspace={handleBackspace}
          disabled={verifying}
        />
      </View>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Recovery phrase display modal
// ---------------------------------------------------------------------------

interface RecoveryModalProps {
  control: DialogControlProps;
  mnemonic: string;
  onDismiss: () => void;
}

function RecoveryModal({ control, mnemonic, onDismiss }: RecoveryModalProps) {
  const words = useMemo(() => mnemonic.split(" "), [mnemonic]);

  return (
    <Dialog
      control={control}
      onClose={onDismiss}
      placement="bottom"
      title={t("settings.recovery.title")}
      description={t("settings.recovery.description")}
      actions={[{ label: t("common.done"), onPress: onDismiss }]}
    >
      <View className="flex-row flex-wrap justify-center gap-2 mt-2">
        {words.map((word, idx) => (
          <View
            key={`recovery-word-${idx}`}
            className="bg-background rounded-lg px-3 py-1.5"
          >
            <Text className="text-foreground text-sm">
              <Text className="text-muted-foreground">{idx + 1}. </Text>
              {word}
            </Text>
          </View>
        ))}
      </View>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Theme mode picker — a borderless segmented control that sits as the last
// row of the Appearance section.
// ---------------------------------------------------------------------------

function AppearancePicker() {
  const { theme, mode, setMode } = useBloomTheme();

  const modes: { value: ThemeMode; label: string; icon: React.ComponentProps<typeof MaterialCommunityIcons>["name"] }[] = [
    { value: "light", label: t("settings.appearance.light"), icon: "white-balance-sunny" },
    { value: "dark", label: t("settings.appearance.dark"), icon: "moon-waning-crescent" },
    { value: "system", label: t("settings.appearance.system"), icon: "cellphone" },
  ];

  return (
    <View className="flex-row gap-2 px-3 py-3">
      {modes.map((m) => {
        const isActive = mode === m.value;
        return (
          <Pressable
            key={m.value}
            onPress={() => setMode(m.value)}
            className={`flex-1 flex-row items-center justify-center py-2.5 rounded-xl ${
              isActive
                ? "bg-primary/15 border border-primary/30"
                : "bg-background border border-border"
            }`}
          >
            <MaterialCommunityIcons
              name={m.icon}
              size={16}
              color={isActive ? theme.colors.tint : theme.colors.textSecondary}
            />
            <Text
              className={`text-xs ml-1.5 font-medium ${
                isActive ? "text-primary" : "text-muted-foreground"
              }`}
            >
              {m.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main settings screen
// ---------------------------------------------------------------------------

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const bottomInset = useTabScreenBottomInset();
  const router = useRouter();
  const { showBottomSheet, user } = useAuth();
  const readOnly = useWalletCapability() === "read-only";
  const { theme: { colors: themeColors } } = useBloomTheme();
  const network = useWalletStore((s) => s.network);
  const connectedPeers = useWalletStore((s) => s.connectedPeers);
  const wipeWallet = useWalletStore((s) => s.wipeWallet);
  const markNoPinUnlocked = useLockStore((s) => s.markNoPinUnlocked);
  const refreshBalance = useWalletStore((s) => s.refreshBalance);
  const rescanWallet = useWalletStore((s) => s.rescanWallet);
  const markBackedUp = useWalletStore((s) => s.markBackedUp);
  const activeWalletName = useWalletStore((s) => s.activeWalletName);
  const receiveAddress = useWalletStore((s) => s.currentReceiveAddress);
  const switchNetwork = useWalletStore((s) => s.switchNetwork);
  const exportBackup = useWalletStore((s) => s.exportBackup);
  const importBackup = useWalletStore((s) => s.importBackup);
  const language = useLanguageStore((s) => s.language);
  const currentLanguageOption = useMemo(
    () => findLanguageOption(language),
    [language],
  );

  const wipeControl = useDialogControl();
  const switchNetworkControl = useDialogControl();
  const resyncControl = useDialogControl();
  const recoveryControl = useDialogControl();
  const [biometricsEnabled, setBiometricsEnabled] = useState(false);
  const [biometricsAvailable, setBiometricsAvailable] = useState(false);
  const [showPinModal, setShowPinModal] = useState(false);
  const [pinAction, setPinAction] = useState<"recovery" | "change_pin" | null>(
    null,
  );
  const [recoveryMnemonic, setRecoveryMnemonic] = useState("");
  const [autoLockMinutes, setAutoLockMinutes] = useState(5);
  const [displayCurrency, setDisplayCurrency] = useState("USD");

  const isMainnet = network === "mainnet";

  // Load biometrics state and preferences on focus
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      const loadSettings = async () => {
        try {
          const [hardwareAvailable, enrolled, enabled, lockTimeout, currency] =
            await Promise.all([
              LocalAuthentication.hasHardwareAsync(),
              LocalAuthentication.isEnrolledAsync(),
              isBiometricsEnabled(),
              getAutoLockTimeout(),
              getCurrency(),
            ]);

          if (cancelled) return;

          setBiometricsAvailable(hardwareAvailable && enrolled);
          setBiometricsEnabled(enabled && hardwareAvailable && enrolled);
          setAutoLockMinutes(lockTimeout);
          setDisplayCurrency(currency);
        } catch (_settingsError: unknown) {
          // Settings load failed — defaults from useState initializers are safe.
        }
      };
      loadSettings();
      return () => {
        cancelled = true;
      };
    }, []),
  );


  const handleManageAccount = useCallback(() => {
    showBottomSheet?.("ManageAccount");
  }, [showBottomSheet]);

  const handleContacts = useCallback(() => {
    router.push("/contacts");
  }, [router]);

  const handleCopyAddress = useCallback(async () => {
    if (!receiveAddress) return;
    await Clipboard.setStringAsync(receiveAddress);
    toast.success(t("receive.addressCopied.description"));
  }, [receiveAddress]);

  const handleToggleNetwork = useCallback(() => {
    switchNetworkControl.open();
  }, [switchNetworkControl]);

  const handleConfirmSwitchNetwork = useCallback(() => {
    const targetNetwork: NetworkType = isMainnet ? "testnet" : "mainnet";
    switchNetwork(targetNetwork);
  }, [isMainnet, switchNetwork]);

  const handleShowRecovery = useCallback(() => {
    setPinAction("recovery");
    setShowPinModal(true);
  }, []);

  const handleChangePIN = useCallback(() => {
    setPinAction("change_pin");
    setShowPinModal(true);
  }, []);

  const handlePinCancel = useCallback(() => {
    setShowPinModal(false);
    setPinAction(null);
  }, []);

  const handlePinSuccess = useCallback(async () => {
    setShowPinModal(false);
    const action = pinAction;
    setPinAction(null);

    if (action === "recovery") {
      try {
        const mnemonic = await getMnemonic();
        if (mnemonic) {
          setRecoveryMnemonic(mnemonic);
          recoveryControl.open();
          // Viewing the phrase clears the home "back up your wallet" reminder.
          void markBackedUp();
        } else {
          toast.error(t("settings.recovery.error.retrieve"));
        }
      } catch {
        toast.error(t("settings.recovery.error.load"));
      }
    } else if (action === "change_pin") {
      router.push("/onboarding/pin-setup");
    }
  }, [pinAction, router, recoveryControl, markBackedUp]);

  const handleRecoveryDismiss = useCallback(() => {
    setRecoveryMnemonic("");
  }, []);

  const handleToggleBiometrics = useCallback(
    async (enabled: boolean) => {
      if (enabled && !biometricsAvailable) {
        toast.error(t("settings.biometrics.unavailable.title"));
        return;
      }

      try {
        if (enabled) {
          const result = await LocalAuthentication.authenticateAsync({
            promptMessage: t("settings.biometrics.verifyPrompt"),
            disableDeviceFallback: false,
          });

          if (!result.success) {
            return;
          }
        }

        await storeBiometricsEnabled(enabled);
        setBiometricsEnabled(enabled);
      } catch {
        toast.error(t("settings.biometrics.updateError"));
      }
    },
    [biometricsAvailable],
  );

  const handleMasternode = useCallback(() => {
    router.push("/masternode");
  }, [router]);

  const handleExportKey = useCallback(() => {
    router.push("/export-key");
  }, [router]);

  const handleNotifications = useCallback(() => {
    router.push("/notifications-settings");
  }, [router]);

  const handleCoinControl = useCallback(() => {
    router.push("/coin-control");
  }, [router]);

  const handleLanguage = useCallback(() => {
    // Oxy resolves the app's language from the account, so the picker is Oxy's.
    showBottomSheet?.("LanguageSelector");
  }, [showBottomSheet]);

  const handleCycleCurrency = useCallback(async () => {
    const currencies = ["USD", "EUR", "BTC"];
    const currentIdx = currencies.indexOf(displayCurrency);
    const nextIdx = (currentIdx + 1) % currencies.length;
    const nextCurrency = currencies[nextIdx];
    setDisplayCurrency(nextCurrency);
    await setCurrency(nextCurrency);
  }, [displayCurrency]);

  const handleCycleAutoLock = useCallback(async () => {
    const options = [1, 5, 15, 30];
    const currentIdx = options.indexOf(autoLockMinutes);
    const nextIdx = (currentIdx + 1) % options.length;
    const nextMinutes = options[nextIdx];
    setAutoLockMinutes(nextMinutes);
    await setAutoLockTimeout(nextMinutes);
  }, [autoLockMinutes]);

  const handleExportBackup = useCallback(async () => {
    try {
      const json = await exportBackup();

      const timestamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:T]/g, "-");
      const filename = `peable-backup-${timestamp}.json`;

      const file = new File(Paths.cache, filename);
      if (file.exists) file.delete();
      file.create();
      file.write(json);

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, {
          mimeType: "application/json",
          dialogTitle: t("settings.backup.exportDialogTitle"),
          UTI: "public.json",
        });
      } else {
        // No native share sheet (web / desktop): the description also explains
        // why no sheet appeared, so it — not the bare title — is the toast.
        toast.success(t("settings.backup.saved.description", { path: file.uri }));
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : t("settings.backup.exportFailed");
      toast.error(message);
    }
  }, [exportBackup]);

  const handleImportBackup = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["application/json", "text/plain", "*/*"],
        copyToCacheDirectory: true,
        multiple: false,
      });

      if (result.canceled || result.assets.length === 0) return;

      const asset = result.assets[0];
      if (!asset) return;

      const json = await new File(asset.uri).text();

      if (!json.trim()) {
        toast.error(t("settings.backup.importEmpty"));
        return;
      }

      await importBackup(json);
      toast.success(t("settings.backup.imported.description"));
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : t("settings.backup.importFailed");
      toast.error(message);
    }
  }, [importBackup]);

  const handleResync = useCallback(() => {
    resyncControl.open();
  }, [resyncControl]);

  // N-4: trigger a real historical rescan (re-request matched merkle blocks
  // from genesis up to the current tip via the SPV client). The old
  // `refreshBalance()` only re-read the in-memory UTXO set and did no
  // networking — the user's "Resync wallet" tap had zero effect. Failures
  // are surfaced to the user since they pressed an explicit action.
  const handleConfirmResync = useCallback(async () => {
    try {
      await rescanWallet();
      refreshBalance();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : t("settings.resync.failed");
      toast.error(message);
    }
  }, [rescanWallet, refreshBalance]);

  const handleConfirmWipe = useCallback(async () => {
    await wipeWallet();
    // A wiped device has no PIN; clear any lock state so the entry screen
    // isn't shown behind the lock overlay. The user is still signed in to
    // Oxy, so "/" re-derives the identity wallet and routes to PIN setup
    // instead of a deleted seed-phrase onboarding screen.
    markNoPinUnlocked();
    router.replace("/");
  }, [wipeWallet, markNoPinUnlocked, router]);

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      {readOnly ? (
        // No wallet to name or address to copy here: the identity IS the
        // account, so the header shows who is signed in.
        <View className="flex-row items-center gap-3 px-4 pt-2 pb-3">
          <UserAvatar
            avatarFileId={user?.avatar ?? undefined}
            displayName={user?.name?.displayName ?? undefined}
            username={user?.username}
            size={48}
          />
          <View className="flex-1">
            <Text className="text-foreground text-lg font-semibold" numberOfLines={1}>
              {user?.name?.displayName ?? user?.username ?? t("wallet.defaultName")}
            </Text>
            {user?.username ? (
              <Text className="text-muted-foreground text-xs mt-0.5" numberOfLines={1}>
                @{user.username}
              </Text>
            ) : null}
          </View>
        </View>
      ) : (
        // Fixed wallet-identity header — mirrors the home's fixed header (no
        // separate "Settings" title bar; the sections scroll under it).
        <View className="flex-row items-center gap-3 px-4 pt-2 pb-3">
            <View className="w-12 h-12 rounded-2xl bg-primary items-center justify-center">
              <MaterialCommunityIcons
                name="wallet"
                size={24}
                color={themeColors.background}
              />
            </View>
            <View className="flex-1">
              <Text
                className="text-foreground text-lg font-semibold"
                numberOfLines={1}
              >
                {activeWalletName || t("wallet.defaultName")}
              </Text>
              {receiveAddress ? (
                <Text
                  className="text-muted-foreground text-xs mt-0.5"
                  numberOfLines={1}
                >
                  {truncateAddress(receiveAddress)}
                </Text>
              ) : null}
            </View>
            {receiveAddress ? (
              <Pressable
                onPress={handleCopyAddress}
                hitSlop={10}
                className="w-9 h-9 rounded-full bg-primary/10 items-center justify-center active:opacity-70"
                accessibilityRole="button"
                accessibilityLabel={t("receive.copy")}
              >
                <MaterialCommunityIcons
                  name="content-copy"
                  size={16}
                  color={themeColors.primary}
                />
              </Pressable>
            ) : null}
        </View>
      )}
      <View className="h-px bg-border" />
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-4 pt-5"
        contentContainerStyle={{ paddingBottom: bottomInset + 40 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Account — the Oxy identity this wallet derives from. */}
        <SettingsListGroup title={t("settings.account")}>
          <SettingsListItem
            title={t("settings.oxyAccount")}
            icon={<RowIcon name="account-circle" />}
            onPress={handleManageAccount}
          />
        </SettingsListGroup>

        {readOnly ? null : (
          <>
            {/* Wallets */}
            <SettingsListGroup title={t("settings.walletsGroup")}>
              <SettingsListItem
                title={t("settings.contacts")}
                icon={<RowIcon name="account-group" />}
                onPress={handleContacts}
              />
            </SettingsListGroup>

            {/* Security */}
            <SettingsListGroup title={t("settings.security")}>
              <SettingsListItem
                title={t("settings.change_pin")}
                icon={<RowIcon name="lock" />}
                onPress={handleChangePIN}
              />
              <SettingsListItem
                title={t("settings.biometrics")}
                icon={<RowIcon name="fingerprint" />}
                showChevron={false}
                rightElement={
                  <Switch
                    value={biometricsEnabled}
                    onValueChange={handleToggleBiometrics}
                  />
                }
              />
              <SettingsListItem
                title={t("settings.auto_lock")}
                value={t("settings.autoLockValue", { minutes: autoLockMinutes })}
                icon={<RowIcon name="clock-outline" />}
                onPress={handleCycleAutoLock}
              />
              <SettingsListItem
                title={t("settings.exportKey")}
                icon={<RowIcon name="shield-key" />}
                onPress={handleExportKey}
              />
              <SettingsListItem
                title={t("settings.notifications")}
                icon={<RowIcon name="bell-ring" />}
                onPress={handleNotifications}
              />
            </SettingsListGroup>

          </>
        )}

        {/* Appearance — the theme segmented control sits as the group's last
            row, below the language and currency rows. */}
        <SettingsListGroup title={t("settings.appearance")}>
          <SettingsListItem
            title={t("settings.language.title")}
            value={
              currentLanguageOption
                ? currentLanguageOption.nativeName
                : language
            }
            icon={<RowIcon name="translate" />}
            onPress={handleLanguage}
          />
          <SettingsListItem
            title={t("settings.currency")}
            value={displayCurrency}
            icon={<RowIcon name="currency-usd" />}
            onPress={handleCycleCurrency}
          />
          <AppearancePicker />
        </SettingsListGroup>

        {readOnly ? null : (
          <>

            {/* Network */}
            <SettingsListGroup title={t("settings.network")}>
              <SettingsListItem
                title={t("settings.network")}
                value={isMainnet ? t("settings.mainnet") : t("settings.testnet")}
                icon={<RowIcon name="earth" />}
                onPress={handleToggleNetwork}
              />
              <SettingsListItem
                title={t("settings.networkStatus")}
                icon={<RowIcon name="pulse" />}
                onPress={() => router.push("/chain")}
              />
              <SettingsListItem
                title={t("settings.connectedPeers")}
                value={String(connectedPeers)}
                icon={<RowIcon name="server-network" />}
                onPress={() => router.push("/peers")}
              />
              <SettingsListItem
                title={t("settings.resync")}
                icon={<RowIcon name="sync" />}
                onPress={handleResync}
              />
            </SettingsListGroup>

            {/* Backup */}
            <SettingsListGroup title={t("settings.backup")}>
              <SettingsListItem
                title={t("settings.show_phrase")}
                icon={<RowIcon name="eye" />}
                onPress={handleShowRecovery}
              />
              <SettingsListItem
                title={t("settings.exportBackup")}
                icon={<RowIcon name="download" />}
                onPress={handleExportBackup}
              />
              <SettingsListItem
                title={t("settings.importBackup")}
                icon={<RowIcon name="upload" />}
                onPress={handleImportBackup}
              />
            </SettingsListGroup>

            {/* Advanced */}
            <SettingsListGroup title={t("settings.advanced")}>
              <SettingsListItem
                title={t("settings.coinControl")}
                icon={<RowIcon name="tune" />}
                onPress={handleCoinControl}
              />
              <SettingsListItem
                title={t("settings.masternode")}
                icon={<RowIcon name="server" />}
                onPress={handleMasternode}
              />
            </SettingsListGroup>

          </>
        )}

        {/* About */}
        <SettingsListGroup title={t("settings.about")}>
          <SettingsListItem
            title={t("settings.aboutApp")}
            value={t("settings.version", { version: APP_VERSION })}
            icon={<RowIcon name="information" />}
            showChevron={false}
          />
        </SettingsListGroup>

        {/* Danger Zone */}
        {readOnly ? null : (
          <SettingsListGroup title={t("settings.dangerZone")}>
            <SettingsListItem
              title={t("settings.wipe")}
              icon={<RowIcon name="delete" />}
              destructive
              onPress={() => wipeControl.open()}
            />
          </SettingsListGroup>
        )}
      </ScrollView>

      {/* PIN verification modal */}
      <PinModal
        visible={showPinModal}
        title={
          pinAction === "recovery"
            ? t("settings.pin.verify")
            : t("settings.pin.enterCurrent")
        }
        onCancel={handlePinCancel}
        onSuccess={handlePinSuccess}
      />

      {/* Wipe confirmation prompt */}
      <Dialog
        control={wipeControl}
        placement="bottom"
        title={t("settings.wipe.title")}
        description={t("settings.wipe.description")}
        actions={[
          {
            label: t("settings.wipe.cta"),
            onPress: handleConfirmWipe,
            color: "destructive",
          },
          { label: t("common.cancel"), color: "cancel" },
        ]}
      />

      {/* Switch network prompt */}
      <Dialog
        control={switchNetworkControl}
        placement="bottom"
        title={t("settings.switchNetwork.title")}
        description={t("settings.switchNetwork.description", {
          target: isMainnet ? t("settings.testnet") : t("settings.mainnet"),
        })}
        actions={[
          { label: t("settings.switchNetwork.cta"), onPress: handleConfirmSwitchNetwork },
          { label: t("common.cancel"), color: "cancel" },
        ]}
      />

      {/* Resync wallet prompt */}
      <Dialog
        control={resyncControl}
        placement="bottom"
        title={t("settings.resync.title")}
        description={t("settings.resync.description")}
        actions={[
          { label: t("settings.resync.cta"), onPress: handleConfirmResync },
          { label: t("common.cancel"), color: "cancel" },
        ]}
      />

      {/* Recovery phrase display prompt */}
      <RecoveryModal
        control={recoveryControl}
        mnemonic={recoveryMnemonic}
        onDismiss={handleRecoveryDismiss}
      />
    </View>
  );
}
