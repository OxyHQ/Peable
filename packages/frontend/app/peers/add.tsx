/**
 * Add Peer screen — form to manually add a P2P peer by IP and port.
 */

import { useCallback, useState } from "react";
import { View, Text, ScrollView, TextInput } from "react-native";
import { useRouter } from "expo-router";
import { useTheme } from "@oxyhq/bloom/theme";
import { toast } from "@oxyhq/bloom/toast";
import { getDatabase } from "../../src/wallet/wallet-store";
import { ScreenHeader } from "../../src/ui/components";
import { SafeAreaView } from "../../src/ui/safe-area-view";
import { Button } from "../../src/ui/components/Button";
import { COIN_NAME } from "@fairco.in/core";
import { t } from "../../src/i18n";

const DEFAULT_PORT = "46372";

/** Uppercase section label — matches the home screen's section headers. */
const SECTION_LABEL =
  "text-muted-foreground text-xs font-semibold uppercase tracking-wider";

function isValidIPv4(ip: string): boolean {
  const octets = ip.split(".");
  if (octets.length !== 4) return false;
  for (const octet of octets) {
    const num = Number(octet);
    if (
      !Number.isFinite(num) ||
      num < 0 ||
      num > 255 ||
      Math.floor(num) !== num ||
      octet !== num.toString()
    ) {
      return false;
    }
  }
  return true;
}

function isValidPort(portStr: string): boolean {
  const port = Number(portStr);
  return (
    Number.isFinite(port) &&
    port >= 1 &&
    port <= 65535 &&
    Math.floor(port) === port
  );
}

export default function AddPeerScreen() {
  const router = useRouter();
  const theme = useTheme();

  const [ip, setIp] = useState("");
  const [port, setPort] = useState(DEFAULT_PORT);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleAdd = useCallback(async () => {
    const trimmedIp = ip.trim();
    const trimmedPort = port.trim() || DEFAULT_PORT;

    if (!trimmedIp) {
      setError(t("peers.add.error.ipRequired"));
      return;
    }
    if (!isValidIPv4(trimmedIp)) {
      setError(t("peers.add.error.ipInvalid"));
      return;
    }
    if (!isValidPort(trimmedPort)) {
      setError(t("peers.add.error.portInvalid"));
      return;
    }

    setError(null);
    setLoading(true);

    const db = getDatabase();
    if (db) {
      await db.insertPeer(trimmedIp, Number(trimmedPort), 1);
    }

    setLoading(false);
    toast.success(t("peers.add.success.title"));
    router.back();
  }, [ip, port, router]);

  return (
    <SafeAreaView
      className="flex-1 bg-background"
      edges={["top", "bottom", "left", "right"]}
    >
      <ScreenHeader title={t("peers.add.title")} onBack={() => router.back()} />
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-5 pt-6 pb-10"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text className="text-muted-foreground text-sm mb-6 leading-5">
          {t("peers.add.description", { coin: COIN_NAME, port: DEFAULT_PORT })}
        </Text>

        {/* Card-less: filled surface fields, no borders (matches the send sheet) */}
        <View className="gap-5">
          <View>
            <Text className={SECTION_LABEL}>{t("peers.add.ipLabel")}</Text>
            <View className="bg-surface rounded-2xl px-4 py-3.5 mt-2">
              <TextInput
                className="text-foreground text-base"
                style={{ paddingVertical: 2 }}
                placeholder={t("peers.add.ipPlaceholder")}
                placeholderTextColor={theme.colors.textSecondary}
                value={ip}
                onChangeText={(text) => {
                  setIp(text);
                  setError(null);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="numbers-and-punctuation"
                returnKeyType="next"
              />
            </View>
          </View>

          <View>
            <Text className={SECTION_LABEL}>{t("peers.add.portLabel")}</Text>
            <View className="bg-surface rounded-2xl px-4 py-3.5 mt-2">
              <TextInput
                className="text-foreground text-base"
                style={{ paddingVertical: 2 }}
                placeholder={DEFAULT_PORT}
                placeholderTextColor={theme.colors.textSecondary}
                value={port}
                onChangeText={(text) => {
                  setPort(text);
                  setError(null);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="number-pad"
                returnKeyType="done"
              />
            </View>
          </View>
        </View>

        {error ? (
          <View className="bg-destructive/10 rounded-2xl p-3.5 mt-5">
            <Text className="text-destructive text-sm text-center">{error}</Text>
          </View>
        ) : null}

        <View className="mt-6">
          <Button
            title={t("peers.add.cta")}
            onPress={handleAdd}
            variant="primary"
            loading={loading}
            disabled={loading}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
