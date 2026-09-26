/**
 * Keyless "Set up your Oxy ID" screen. Probes the server for an existing
 * identity, then deep-links into Commons — the ecosystem identity vault — to
 * either create a new Oxy ID or import an existing one onto this device.
 * Neutral in-place branch of `app/index.tsx` — it never navigates across the
 * entry boundary itself.
 */

import { useCallback, useState } from "react";
import { View, Text, Linking } from "react-native";
import { Button } from "./Button";
import { oxyServices } from "../../services/oxy-services";
import { hasIdentityAuthMethod, resolveKeylessAction } from "../../wallet/keyless";
import { t } from "../../i18n";

export function CreateOxyIdView() {
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const handleSetup = useCallback(async () => {
    setOpening(true);
    setNotice(null);
    try {
      // The server is the single source of truth for whether this account
      // already has an identity anywhere — a probe failure must NOT be
      // treated as "no identity". `POST /auth/link` overwrites
      // `user.publicKey` with whatever key it is given, so silently routing
      // to "create" on a network hiccup could generate a fresh key on this
      // device and orphan the real identity that already lives on another
      // device. Fail closed: surface a retry instead of guessing.
      const { methods } = await oxyServices.identity.authMethods();
      const action = resolveKeylessAction(hasIdentityAuthMethod(methods));
      const canOpen = await Linking.canOpenURL(action.url);
      if (!canOpen) {
        setNotice(t("onboarding.commonsNotInstalled"));
        return;
      }
      await Linking.openURL(action.url);
    } catch {
      setNotice(t("onboarding.createIdentityError"));
    } finally {
      setOpening(false);
    }
  }, []);

  return (
    <View className="flex-1 bg-background items-center justify-center px-8">
      <Text className="text-foreground text-2xl text-center mb-3">
        {t("onboarding.createIdentityTitle")}
      </Text>
      <Text className="text-muted-foreground text-base text-center mb-8">
        {t("onboarding.createIdentitySubtitle")}
      </Text>
      <View className="w-full">
        <Button
          title={t("onboarding.createIdentityCta")}
          onPress={() => void handleSetup()}
          variant="primary"
          size="lg"
          loading={opening}
          disabled={opening}
        />
      </View>
      {notice ? (
        <Text className="text-muted-foreground text-sm text-center mt-4">{notice}</Text>
      ) : null}
    </View>
  );
}
