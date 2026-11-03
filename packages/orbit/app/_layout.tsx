/**
 * Orbit's root: providers only. The auth gate and the navigation live in
 * `(orbit)/_layout.tsx`, the ONE place that decides what a signed-out visitor
 * sees, so no screen makes that decision a second time.
 *
 * `BloomThemeProvider` sits above everything that could call `useTheme`
 * (including the sign-in screen), as Bloom requires. No `ToastOutlet` here:
 * `OxyProvider` already renders one, and a second makes every toast render
 * twice, one over the other.
 */

import '../global.css';

import { Slot } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { OxyProvider } from '@oxy.so/services/ui/client';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';
import { OverlayInertBoundary, PortalOutlet, PortalProvider } from '@oxy.so/bloom/portal';
import { ImageResolverProvider } from '@oxy.so/bloom/image-resolver';
import { oxyServices } from '@/api/client';
import { OXY_AUTH_REDIRECT_URI, OXY_CLIENT_ID } from '@/config';
import { FALLBACK_LOCALE, setLocale, SUPPORTED_LOCALES, useLocale } from '@/i18n';
import { queryClient } from '@/query';
import { OrbitScopeProvider } from '@/scope/ScopeProvider';

/** Oxy tells Orbit which language to render (`OxyProvider`'s `language.onChange`, Oxy ADR 0022). */
const followOxyLanguage = (locale: string) => {
  setLocale(locale);
};

/**
 * The screens, keyed by the active language: `t` is a plain function, so a
 * language change re-renders the whole tree under its new catalog — memoised
 * screens and navigators included — instead of leaving stale words behind.
 */
function LocalizedSlot() {
  const locale = useLocale();
  return <Slot key={locale} />;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <BloomThemeProvider defaultMode="system" defaultColorPreset="blue">
          <StatusBar style="auto" />
          <OxyProvider
            oxyServices={oxyServices}
            clientId={OXY_CLIENT_ID}
            authRedirectUri={OXY_AUTH_REDIRECT_URI}
            storageKeyPrefix="peable-orbit"
            queryClient={queryClient}
            language={{
              supportedLocales: SUPPORTED_LOCALES,
              fallbackLocale: FALLBACK_LOCALE,
              onChange: followOxyLanguage,
            }}
          >
            <ImageResolverProvider
              value={(id, variant) => oxyServices.assets.publicUrl(id, variant)}
            >
              <PortalProvider>
                <OverlayInertBoundary>
                  <OrbitScopeProvider>
                    <LocalizedSlot />
                  </OrbitScopeProvider>
                </OverlayInertBoundary>
                <PortalOutlet />
              </PortalProvider>
            </ImageResolverProvider>
          </OxyProvider>
        </BloomThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
