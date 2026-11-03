/**
 * The Orbit shell, gated on Oxy sign-in.
 *
 * - auth unresolved   -> nothing but the page colour (a reload on /payments
 *                        must not flash sign-in before the session restores)
 * - signed out        -> sign-in, rendered IN PLACE. Never a `<Redirect>`
 *                        to `/`: inside this group `/` is `(orbit)/index`,
 *                        the gate would run again, and React aborts (#185).
 * - signed in         -> `OrbitShell` (Bloom `AppShell` + `Sidebar`, the top
 *                        bar and the command palette) around the routes.
 *                        What it lists is `src/shell/destinations.ts`.
 */

import { View } from 'react-native';
import { Slot } from 'expo-router';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTheme } from '@oxy.so/bloom/theme';
import { OrbitShell } from '@/shell/OrbitShell';
import { SignInScreen } from '@/ui/SignInScreen';

export default function OrbitLayout() {
  const theme = useTheme();
  const { isAuthResolved, isAuthenticated } = useAuth();

  if (!isAuthResolved) {
    return <View style={{ flex: 1, backgroundColor: theme.colors.background }} />;
  }
  if (!isAuthenticated) return <SignInScreen />;

  return (
    <OrbitShell>
      <Slot />
    </OrbitShell>
  );
}
