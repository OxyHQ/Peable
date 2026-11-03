import '../global.css';
import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient } from '@tanstack/react-query';
import { OxyProvider } from '@oxy.so/services/ui/client';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';
import { PortalProvider, PortalOutlet, OverlayInertBoundary } from '@oxy.so/bloom/portal';
import { ToastOutlet } from '@oxy.so/bloom/toast';
import { oxyServices, OXY_CLIENT_ID, OXY_AUTH_REDIRECT_URI } from '../src/services';
import { ScopeProvider } from '../src/scope';
const queryClient = new QueryClient();
export default function Layout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <BloomThemeProvider colorPreset="blue">
          <OxyProvider
            oxyServices={oxyServices}
            clientId={OXY_CLIENT_ID}
            authRedirectUri={OXY_AUTH_REDIRECT_URI}
            storageKeyPrefix="peable-orbit"
            queryClient={queryClient}
          >
            <PortalProvider>
              <OverlayInertBoundary style={{ flex: 1 }}>
                <ScopeProvider>
                  <Stack screenOptions={{ headerShown: false }} />
                </ScopeProvider>
              </OverlayInertBoundary>
              <PortalOutlet />
            </PortalProvider>
            <ToastOutlet />
          </OxyProvider>
        </BloomThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
