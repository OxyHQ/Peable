/**
 * The Orbit shell: one tab navigator for every platform, gated on Oxy sign-in.
 *
 * - auth unresolved   -> nothing but the page colour (a reload on /payments
 *                        must not flash sign-in before the session restores)
 * - signed out        -> sign-in, rendered IN PLACE. Never a `<Redirect>`
 *                        to `/`: inside this group `/` is `(orbit)/index`,
 *                        the gate would run again, and React aborts (#185).
 * - signed in         -> Bloom `Rail` beside the screens on a wide window,
 *                        Bloom's floating `TabBar` below them otherwise.
 */

import { View } from 'react-native';
import { Tabs } from 'expo-router/tabs';
import { useAuth } from '@oxy.so/services/ui/client';
import { TabBarMinimizeProvider } from '@oxy.so/bloom/tab-bar';
import { useTheme } from '@oxy.so/bloom/theme';
import { OrbitRail, OrbitTabBar, useOrbitNavLayout } from '@/ui/navigation';
import { SignInScreen } from '@/ui/SignInScreen';

export default function OrbitLayout() {
  const theme = useTheme();
  const layout = useOrbitNavLayout();
  const { isAuthResolved, isAuthenticated } = useAuth();

  if (!isAuthResolved) {
    return <View style={{ flex: 1, backgroundColor: theme.colors.background }} />;
  }
  if (!isAuthenticated) return <SignInScreen />;

  return (
    <TabBarMinimizeProvider>
      <Tabs
        tabBar={(props) =>
          layout === 'rail' ? <OrbitRail {...props} /> : <OrbitTabBar {...props} />
        }
        screenOptions={{
          headerShown: false,
          tabBarPosition: layout === 'rail' ? 'left' : 'bottom',
          sceneStyle: { backgroundColor: theme.colors.background },
        }}
      >
        <Tabs.Screen name="index" options={{ title: 'Home' }} />
        <Tabs.Screen name="payments" options={{ title: 'Payments' }} />
        <Tabs.Screen name="products" options={{ title: 'Products' }} />
        <Tabs.Screen name="disputes" options={{ title: 'Disputes' }} />
        <Tabs.Screen name="balances" options={{ title: 'Balances' }} />
        <Tabs.Screen name="payouts" options={{ title: 'Payouts' }} />
        <Tabs.Screen name="reports" options={{ title: 'Reports' }} />
        <Tabs.Screen name="account" options={{ title: 'Account' }} />
        <Tabs.Screen name="links" options={{ title: 'Payment Links' }} />
        <Tabs.Screen name="customers" options={{ title: 'Customers' }} />
        <Tabs.Screen name="subscriptions" options={{ title: 'Subscriptions' }} />
        <Tabs.Screen name="invoices" options={{ title: 'Invoices' }} />
        <Tabs.Screen name="billing" options={{ title: 'Billing' }} />
        <Tabs.Screen name="developers" options={{ title: 'Developers' }} />
        <Tabs.Screen name="tax" options={{ title: 'Tax' }} />
        <Tabs.Screen name="contributions" options={{ title: 'Contributions' }} />
        <Tabs.Screen name="branding" options={{ title: 'Branding' }} />
        <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
      </Tabs>
    </TabBarMinimizeProvider>
  );
}
