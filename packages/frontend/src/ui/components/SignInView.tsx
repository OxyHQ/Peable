/**
 * "Sign in with Oxy", as a view rather than a route.
 *
 * Rendered by `app/index.tsx` for a signed-out visitor, and by the web
 * `(tabs)` layout when a signed-out visitor lands inside the shell (a deep
 * link, a reload on `/settings`). The layout renders it IN PLACE because it
 * cannot redirect to `/`: inside the group `/` resolves to `(tabs)/index`, the
 * gate runs again, and React aborts with "Maximum update depth exceeded"
 * (error #185) — which is what `peable.to/settings` did signed out.
 */

import { View, Text } from "react-native";
import { useAuth } from "@oxy.so/services";
import { Button } from "./Button";
import { t } from "../../i18n";

export function SignInView() {
  const { signIn } = useAuth();
  return (
    <View className="flex-1 bg-background items-center justify-center px-8">
      <Text className="text-foreground text-2xl text-center mb-3">{t("onboarding.signInTitle")}</Text>
      <Text className="text-muted-foreground text-base text-center mb-8">{t("onboarding.signInSubtitle")}</Text>
      <View className="w-full">
        <Button title={t("pay.signIn")} onPress={() => void signIn()} variant="primary" size="lg" />
      </View>
    </View>
  );
}
