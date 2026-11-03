/**
 * Orbit's destinations and the one decision about how to show them.
 *
 * `app/(orbit)/_layout.tsx` is a single tab navigator on every platform. Its
 * `tabBar` slot renders Bloom's `Rail` beside the screens in a window wide
 * enough for one, and Bloom's floating `TabBar` everywhere else — the
 * arrangement the wallet uses (`packages/frontend/src/ui/navigation`), so the
 * two Peable apps behave alike. Both read the list below, so they cannot drift.
 */

import { useCallback } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from 'expo-router/tabs';
import { Rail } from '@oxy.so/bloom/rail';
import { TabBar, TabBarButton, useTabBarFootprint } from '@oxy.so/bloom/tab-bar';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiAlarmWarningLine } from '@oxy.so/bloom/icons/RiAlarmWarningLine';
import { RiBankCardLine } from '@oxy.so/bloom/icons/RiBankCardLine';
import { RiBankLine } from '@oxy.so/bloom/icons/RiBankLine';
import { RiBarChartBoxLine } from '@oxy.so/bloom/icons/RiBarChartBoxLine';
import { RiHandHeartLine } from '@oxy.so/bloom/icons/RiHandHeartLine';
import { RiHome5Fill } from '@oxy.so/bloom/icons/RiHome5Fill';
import { RiHome5Line } from '@oxy.so/bloom/icons/RiHome5Line';
import { RiLinksLine } from '@oxy.so/bloom/icons/RiLinksLine';
import { RiPaletteLine } from '@oxy.so/bloom/icons/RiPaletteLine';
import { RiPriceTag3Line } from '@oxy.so/bloom/icons/RiPriceTag3Line';
import { RiReceiptLine } from '@oxy.so/bloom/icons/RiReceiptLine';
import { RiSettings3Fill } from '@oxy.so/bloom/icons/RiSettings3Fill';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { RiStore2Line } from '@oxy.so/bloom/icons/RiStore2Line';
import { RiTerminalBoxLine } from '@oxy.so/bloom/icons/RiTerminalBoxLine';
import { RiWallet3Line } from '@oxy.so/bloom/icons/RiWallet3Line';
import { RiUserLine } from '@oxy.so/bloom/icons/RiUserLine';
import { RiRepeatLine } from '@oxy.so/bloom/icons/RiRepeatLine';
import { RiFileList3Line } from '@oxy.so/bloom/icons/RiFileList3Line';
import { RiCalendarScheduleLine } from '@oxy.so/bloom/icons/RiCalendarScheduleLine';
import { t } from '../i18n';

export type OrbitTab =
  | 'index'
  | 'payments'
  | 'products'
  | 'disputes'
  | 'balances'
  | 'payouts'
  | 'reports'
  | 'account'
  | 'links'
  | 'customers'
  | 'subscriptions'
  | 'invoices'
  | 'billing'
  | 'developers'
  | 'tax'
  | 'contributions'
  | 'branding'
  | 'settings';

type Glyph = typeof RiHome5Line;

const TAB_DEFS: Record<OrbitTab, { labelKey: string; icon: Glyph; activeIcon: Glyph }> = {
  index: { labelKey: 'nav.home', icon: RiHome5Line, activeIcon: RiHome5Fill },
  payments: { labelKey: 'nav.payments', icon: RiBankCardLine, activeIcon: RiBankCardLine },
  products: { labelKey: 'nav.products', icon: RiPriceTag3Line, activeIcon: RiPriceTag3Line },
  disputes: {
    labelKey: 'nav.disputes',
    icon: RiAlarmWarningLine,
    activeIcon: RiAlarmWarningLine,
  },
  balances: { labelKey: 'nav.balances', icon: RiWallet3Line, activeIcon: RiWallet3Line },
  payouts: { labelKey: 'nav.payouts', icon: RiBankLine, activeIcon: RiBankLine },
  reports: { labelKey: 'nav.reports', icon: RiBarChartBoxLine, activeIcon: RiBarChartBoxLine },
  account: { labelKey: 'nav.account', icon: RiStore2Line, activeIcon: RiStore2Line },
  links: { labelKey: 'nav.links', icon: RiLinksLine, activeIcon: RiLinksLine },
  customers: { labelKey: 'nav.customers', icon: RiUserLine, activeIcon: RiUserLine },
  subscriptions: { labelKey: 'nav.subscriptions', icon: RiRepeatLine, activeIcon: RiRepeatLine },
  invoices: { labelKey: 'nav.invoices', icon: RiFileList3Line, activeIcon: RiFileList3Line },
  billing: {
    labelKey: 'nav.billing',
    icon: RiCalendarScheduleLine,
    activeIcon: RiCalendarScheduleLine,
  },
  developers: {
    labelKey: 'nav.developers',
    icon: RiTerminalBoxLine,
    activeIcon: RiTerminalBoxLine,
  },
  tax: { labelKey: 'nav.tax', icon: RiReceiptLine, activeIcon: RiReceiptLine },
  contributions: {
    labelKey: 'nav.contributions',
    icon: RiHandHeartLine,
    activeIcon: RiHandHeartLine,
  },
  branding: { labelKey: 'nav.branding', icon: RiPaletteLine, activeIcon: RiPaletteLine },
  settings: { labelKey: 'nav.settings', icon: RiSettings3Line, activeIcon: RiSettings3Fill },
};

/** Rail and bar entries, in order. Every route in `app/(orbit)` is one of these. */
export const ORBIT_TABS: readonly OrbitTab[] = [
  'index',
  'payments',
  'products',
  'disputes',
  'balances',
  'payouts',
  'reports',
  'account',
  'links',
  'customers',
  'subscriptions',
  'invoices',
  'billing',
  'developers',
  'tax',
  'contributions',
  'branding',
  'settings',
];

export function orbitTabLabel(tab: OrbitTab): string {
  return t(TAB_DEFS[tab].labelKey);
}

function TabGlyph({ tab, active, color }: { tab: OrbitTab; active: boolean; color: string }) {
  const Icon = active ? TAB_DEFS[tab].activeIcon : TAB_DEFS[tab].icon;
  return <Icon size="lg" fill={color} />;
}

/** Below this width the rail gives way to the bottom bar. */
export const RAIL_MIN_WIDTH = 768;

export type OrbitNavLayout = 'rail' | 'bar';

/** Orbit is a desktop console first: the rail whenever the window has room for it. */
export function useOrbitNavLayout(): OrbitNavLayout {
  const { width } = useWindowDimensions();
  return width >= RAIL_MIN_WIDTH ? 'rail' : 'bar';
}

/**
 * Bottom padding a screen's scroll content needs: Bloom's `TabBar` floats over
 * the screen, so without it the last row sits under the pill.
 */
export function useScreenBottomInset(): number {
  const layout = useOrbitNavLayout();
  const footprint = useTabBarFootprint();
  const insets = useSafeAreaInsets();
  return layout === 'bar' ? footprint : insets.bottom;
}

/** The focused route's TAB, so a nested payment detail still lights up Payments. */
function focusedTab(state: BottomTabBarProps['state']): string | undefined {
  return state.routes[state.index]?.name.split('/')[0];
}

function useSelectTab({ state, navigateToTab }: BottomTabBarProps) {
  // The navigator switches tabs by route KEY, not by name (expo-router 58).
  return useCallback(
    (name: string) => {
      const key = state.routes.find((route) => route.name.split('/')[0] === name)?.key;
      if (key !== undefined) navigateToTab(key);
    },
    [navigateToTab, state.routes],
  );
}

export function OrbitRail(props: BottomTabBarProps) {
  const theme = useTheme();
  const select = useSelectTab(props);
  return (
    <Rail
      activeId={focusedTab(props.state)}
      onSelect={select}
      width={88}
      style={{
        backgroundColor: theme.colors.background,
        borderRightWidth: 1,
        borderRightColor: theme.colors.border,
      }}
      items={ORBIT_TABS.map((tab) => ({
        id: tab,
        label: orbitTabLabel(tab),
        icon: <TabGlyph tab={tab} active={false} color={theme.colors.textSecondary} />,
        // The rail draws the active pill in `primary-subtle`; the glyph takes its foreground.
        activeIcon: <TabGlyph tab={tab} active color={theme.colors.primarySubtleForeground} />,
      }))}
    />
  );
}

/** Ceiling on the pill: on a tablet the bar would otherwise stretch to the window. */
const TAB_BAR_MAX_WIDTH = 520;

export function OrbitTabBar(props: BottomTabBarProps) {
  const theme = useTheme();
  const select = useSelectTab(props);
  const focused = focusedTab(props.state);
  const activeIndex = ORBIT_TABS.indexOf(focused as OrbitTab);
  return (
    <View style={styles.host}>
      <TabBar
        activeIndex={activeIndex}
        onIndexChange={(index) => {
          const tab = ORBIT_TABS[index];
          if (tab) select(tab);
        }}
        maxWidth={TAB_BAR_MAX_WIDTH}
      >
        {ORBIT_TABS.map((tab, index) => (
          <TabBarButton
            key={tab}
            index={index}
            item={{
              name: tab,
              label: orbitTabLabel(tab),
              icon: <TabGlyph tab={tab} active={false} color={theme.colors.textSecondary} />,
              activeIcon: <TabGlyph tab={tab} active color={theme.colors.text} />,
            }}
          />
        ))}
      </TabBar>
    </View>
  );
}

const styles = StyleSheet.create({
  // Pulled out of flow and pinned to the bottom edge: left in flow it would
  // shrink every screen by the bar's height. `pointerEvents` in the style
  // object, as react-native-web warns on the prop.
  host: { position: 'absolute', left: 0, right: 0, bottom: 0, pointerEvents: 'box-none' },
});
