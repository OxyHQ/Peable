/**
 * Orbit's root: providers only. The auth gate and the navigation live in
 * `(orbit)/_layout.tsx`, the ONE place that decides what a signed-out visitor
 * sees, so no screen makes that decision a second time.
 *
 * `BloomThemeProvider` sits above everything that could call `useTheme`
 * (including the sign-in screen), as Bloom requires.
 */

import '../global.css';

import { Slot } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { OxyProvider } from '@oxy.so/services/ui/client';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';
import { OverlayInertBoundary, PortalOutlet, PortalProvider } from '@oxy.so/bloom/portal';
import { ToastOutlet } from '@oxy.so/bloom/toast';
import { ImageResolverProvider } from '@oxy.so/bloom/image-resolver';
import { oxyServices } from '@/api/client';
import { OXY_AUTH_REDIRECT_URI, OXY_CLIENT_ID } from '@/config';
import { FALLBACK_LOCALE, SUPPORTED_LOCALES } from '@/i18n';
import { queryClient } from '@/query';
import { OrbitScopeProvider } from '@/scope/ScopeProvider';

// English is the only catalog Orbit ships, so there is nothing to switch to.
const ignoreLanguage = () => undefined;

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
              onChange: ignoreLanguage,
            }}
          >
            <ImageResolverProvider
              value={(id, variant) => oxyServices.assets.publicUrl(id, variant)}
            >
              <PortalProvider>
                <OverlayInertBoundary>
                  <OrbitScopeProvider>
                    <Slot />
                  </OrbitScopeProvider>
                </OverlayInertBoundary>
                <PortalOutlet />
              </PortalProvider>
              <ToastOutlet />
            </ImageResolverProvider>
          </OxyProvider>
        </BloomThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
