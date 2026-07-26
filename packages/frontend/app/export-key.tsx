/**
 * BIP38 encrypted private key export screen.
 * Allows users to export an encrypted version of their private key
 * for a specific address, protected by a passphrase.
 * Presented as a modal from settings.
 */

import { useCallback, useMemo, useState } from "react";
import { View, Text, TextInput, ScrollView, Pressable } from "react-native";
import { SafeAreaView } from "../src/ui/safe-area-view";
import { useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useWalletStore } from "../src/wallet/wallet-store";
import { verifyPin } from "../src/storage/secure-store";
import { encryptBIP38, getNetwork } from "@fairco.in/core";
import { KeyManager } from "../src/wallet/key-manager";
import {
  Button,
  ListItem,
  EmptyState,
  ScreenHeader,
} from "../src/ui/components";
import { PinDots } from "../src/ui/components/PinDots";
import { PinPad } from "../src/ui/components/PinPad";
import { useTheme } from "@oxyhq/bloom/theme";
import { toast } from "@oxyhq/bloom/toast";
import { t } from "../src/i18n";

const PIN_LENGTH = 6;

/** Uppercase section label — matches the home screen's section headers. */
const SECTION_LABEL =
  "text-muted-foreground text-xs font-semibold uppercase tracking-wider";

// ---------------------------------------------------------------------------
// Step type for the export flow
// ---------------------------------------------------------------------------

type ExportStep = "pin" | "select" | "passphrase" | "result";

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function ExportKeyScreen() {
  const router = useRouter();
  const addresses = useWalletStore((s) => s.addresses);
  const network = useWalletStore((s) => s.network);
  const theme = useTheme();

  const [step, setStep] = useState<ExportStep>("pin");
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinVerifying, setPinVerifying] = useState(false);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [encryptedKey, setEncryptedKey] = useState<string | null>(null);
  const [encrypting, setEncrypting] = useState(false);

  // ---------------------------------------------------------------------------
  // PIN verification step
  // ---------------------------------------------------------------------------

  const handlePinDigit = useCallback(
    (digit: string) => {
      if (pinVerifying) return;
      setPinError(null);

      setPin((prev) => {
        if (prev.length >= PIN_LENGTH) return prev;
        const next = prev + digit;

        if (next.length === PIN_LENGTH) {
          setPinVerifying(true);
          verifyPin(next)
            .then((correct) => {
              if (correct) {
                setPin("");
                setStep("select");
              } else {
                setPinError(t("exportKey.verifyPin.wrong"));
                setPin("");
              }
              setPinVerifying(false);
            })
            .catch(() => {
              setPinError(t("exportKey.verifyPin.failed"));
              setPin("");
              setPinVerifying(false);
            });
        }

        return next;
      });
    },
    [pinVerifying],
  );

  const handlePinBackspace = useCallback(() => {
    if (pinVerifying) return;
    setPin((prev) => prev.slice(0, -1));
    setPinError(null);
  }, [pinVerifying]);

  // ---------------------------------------------------------------------------
  // Address selection step
  // ---------------------------------------------------------------------------

  const handleSelectAddress = useCallback((address: string) => {
    setSelectedAddress(address);
    setStep("passphrase");
  }, []);

  // ---------------------------------------------------------------------------
  // Passphrase step
  // ---------------------------------------------------------------------------

  const passphraseError = useMemo(() => {
    if (passphrase.length > 0 && passphrase.length < 8) {
      return t("exportKey.passphrase.error.tooShort");
    }
    if (confirmPassphrase.length > 0 && passphrase !== confirmPassphrase) {
      return t("exportKey.passphrase.error.mismatch");
    }
    return null;
  }, [passphrase, confirmPassphrase]);

  const canEncrypt =
    passphrase.length >= 8 &&
    passphrase === confirmPassphrase &&
    selectedAddress !== null;

  const handleEncrypt = useCallback(async () => {
    if (!canEncrypt || !selectedAddress) return;

    setEncrypting(true);
    // Hold references so we can ALWAYS zeroize them in `finally` (S-1):
    // BIP38 export expanded the key material across heap; without wipe the
    // master/private key would survive the export screen indefinitely.
    let km: KeyManager | null = null;
    let privateKey: Uint8Array | null = null;
    try {
      const networkConfig = getNetwork(network);
      const { getMnemonic } = await import("../src/storage/secure-store");
      const mnemonic = await getMnemonic();
      if (!mnemonic) {
        toast.error(t("exportKey.error.noMnemonic"));
        return;
      }

      // Watch-only wallets store an `xpub:` marker instead of a mnemonic and
      // hold no private keys. Never feed that into mnemonicToSeedSync (it would
      // derive a random, unrelated keypair — review finding C2); there is simply
      // nothing to export.
      if (mnemonic.startsWith("xpub:")) {
        toast.error(t("exportKey.error.noPrivateKey"));
        return;
      }

      km = KeyManager.fromMnemonic(mnemonic, networkConfig);

      try {
        privateKey = km.getPrivateKeyForAddress(selectedAddress);
      } catch {
        toast.error(t("exportKey.error.noPrivateKey"));
        return;
      }

      const encrypted = await encryptBIP38(
        privateKey,
        passphrase,
        true, // compressed
        networkConfig,
      );

      setEncryptedKey(encrypted);
      setStep("result");
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error ? err.message : t("exportKey.error.encryptionFailed");
      toast.error(errorMessage);
    } finally {
      if (privateKey) {
        try {
          privateKey.fill(0);
        } catch {
          // best-effort; ignore if buffer is not writable
        }
      }
      if (km) {
        try {
          km.wipe();
        } catch {
          // best-effort
        }
      }
      setEncrypting(false);
    }
  }, [canEncrypt, selectedAddress, passphrase, network]);

  // ---------------------------------------------------------------------------
  // Result step
  // ---------------------------------------------------------------------------

  const handleCopyEncrypted = useCallback(async () => {
    if (encryptedKey) {
      await Clipboard.setStringAsync(encryptedKey);
      toast.success(t("exportKey.result.copied.description"));
    }
  }, [encryptedKey]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (step === "pin") {
    return (
      <SafeAreaView
        className="flex-1 bg-background"
        edges={["top", "bottom", "left", "right"]}
      >
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-foreground text-xl font-bold mb-2">
            {t("exportKey.verifyPin.title")}
          </Text>
          <Text className="text-muted-foreground text-sm mb-6 text-center">
            {t("exportKey.verifyPin.subtitle")}
          </Text>

          <View className="mb-4">
            <PinDots
              length={PIN_LENGTH}
              filled={pin.length}
              error={pinError !== null}
            />
          </View>

          {pinError ? (
            <Text className="text-destructive text-xs text-center mb-3">
              {pinError}
            </Text>
          ) : null}

          <PinPad
            onDigit={handlePinDigit}
            onBackspace={handlePinBackspace}
            disabled={pinVerifying}
            tintColor={theme.colors.text}
            disabledColor={theme.colors.card}
          />
        </View>
      </SafeAreaView>
    );
  }

  if (step === "select") {
    return (
      <SafeAreaView
        className="flex-1 bg-background"
        edges={["top", "bottom", "left", "right"]}
      >
        <ScreenHeader
          title={t("exportKey.select.title")}
          subtitle={t("exportKey.select.subtitle")}
          onBack={() => router.back()}
        />
        <ScrollView
          className="flex-1"
          contentContainerClassName="pt-4 pb-8"
          showsVerticalScrollIndicator={false}
        >
          {addresses.length === 0 ? (
            <View className="px-4">
              <EmptyState
                icon="key-remove"
                title={t("exportKey.select.empty.title")}
                subtitle={t("exportKey.select.empty.subtitle")}
              />
            </View>
          ) : (
            <View>
              {addresses.map((address, idx) => (
                <ListItem
                  key={`addr-${idx}-${address}`}
                  icon="key"
                  title={address}
                  subtitle={`#${idx + 1}`}
                  isLast={idx === addresses.length - 1}
                  onPress={() => handleSelectAddress(address)}
                />
              ))}
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (step === "passphrase") {
    return (
      <SafeAreaView
        className="flex-1 bg-background"
        edges={["top", "bottom", "left", "right"]}
      >
        <ScreenHeader
          title={t("exportKey.passphrase.title")}
          subtitle={t("exportKey.passphrase.subtitle")}
          onBack={() => setStep("select")}
        />
        <ScrollView
          className="flex-1"
          contentContainerClassName="px-4 pt-4 pb-8"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View className="gap-5 mt-4 mb-4">
            <View>
              <Text className={SECTION_LABEL}>
                {t("exportKey.passphrase.label")}
              </Text>
              <TextInput
                className="bg-surface rounded-2xl px-4 py-3.5 text-foreground text-base mt-2"
                placeholder={t("exportKey.passphrase.placeholder")}
                placeholderTextColor={theme.colors.textSecondary}
                value={passphrase}
                onChangeText={setPassphrase}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <View>
              <Text className={SECTION_LABEL}>
                {t("exportKey.passphrase.confirmLabel")}
              </Text>
              <TextInput
                className="bg-surface rounded-2xl px-4 py-3.5 text-foreground text-base mt-2"
                placeholder={t("exportKey.passphrase.confirmPlaceholder")}
                placeholderTextColor={theme.colors.textSecondary}
                value={confirmPassphrase}
                onChangeText={setConfirmPassphrase}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            {passphraseError ? (
              <View className="bg-destructive/10 rounded-2xl p-3.5">
                <Text className="text-destructive text-sm text-center">
                  {passphraseError}
                </Text>
              </View>
            ) : null}
          </View>

          <Button
            title={
              encrypting
                ? t("exportKey.passphrase.encrypting")
                : t("exportKey.passphrase.encryptCta")
            }
            onPress={handleEncrypt}
            variant="primary"
            disabled={!canEncrypt}
            loading={encrypting}
          />
        </ScrollView>
      </SafeAreaView>
    );
  }

  // Result step
  return (
    <SafeAreaView
      className="flex-1 bg-background"
      edges={["top", "bottom", "left", "right"]}
    >
      <ScreenHeader
        title={t("exportKey.result.title")}
        subtitle={t("exportKey.result.subtitle")}
        onBack={() => router.back()}
      />
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-5 pt-4 pb-8"
        showsVerticalScrollIndicator={false}
      >
        {/* Encrypted key display — card-less bordered surface, tap to copy */}
        <Pressable onPress={handleCopyEncrypted}>
          <View className="bg-surface rounded-2xl p-4 mt-4 mb-4">
            <Text
              className="text-primary text-sm text-center font-mono"
              selectable
            >
              {encryptedKey}
            </Text>
          </View>
        </Pressable>

        <Button
          title={t("exportKey.result.copyCta")}
          onPress={handleCopyEncrypted}
          variant="primary"
          icon={
            <MaterialCommunityIcons
              name="content-copy"
              size={18}
              color={theme.colors.background}
            />
          }
        />

        {/* Warning — borderless tinted strip */}
        <View className="bg-yellow-400/10 rounded-2xl p-4 mt-6">
          <Text className="text-yellow-400 text-sm font-semibold mb-1">
            {t("exportKey.warning.title")}
          </Text>
          <Text className="text-yellow-400/80 text-xs leading-5">
            {t("exportKey.warning.description")}
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
