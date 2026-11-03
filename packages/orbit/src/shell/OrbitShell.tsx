import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useWindowDimensions } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { AppShell, type AppShellSidebarProps } from '@oxy.so/bloom/app-shell';
import {
  Sidebar,
  type SidebarNavItem,
  type SidebarProps,
  type SidebarTree,
  type SidebarTreeItem,
} from '@oxy.so/bloom/sidebar';
import { t } from '../i18n';
import { modeForEnvironment } from '../scope/scope';
import { useOrbitScope } from '../scope/ScopeProvider';
import { CommandPalette } from './CommandPalette';
import { activeDestination, groupOf, navModel, type NavModel, type NavRow } from './destinations';
import { orbitIcon } from './icons';
import { SIDEBAR_IN_FLOW_FROM, shellLayout } from './layout';
import { SearchDialog } from './SearchDialog';
import { TestModeStrip, TopBar } from './TopBar';
import { usePersistedCollapsed, useShellShortcuts } from './useShellState';
import { useAccountIdentity, useScopeTeam } from './useSidebarIdentities';

type BloomNav = Pick<SidebarProps, 'items' | 'secondaryItems' | 'tree'>;

function navItem(row: NavRow): SidebarNavItem {
  return {
    key: row.key,
    label: t(row.labelKey),
    icon: orbitIcon(row.key),
    ...(row.href ? { href: row.href } : {}),
  };
}

/** The registry's structural model as Bloom's `Sidebar` rows. */
function bloomNav(
  model: NavModel,
  groupOpen: Readonly<Record<string, boolean>>,
  setGroupOpen: (key: string, open: boolean) => void,
): BloomNav {
  const treeItem = (row: NavRow): SidebarTreeItem => ({
    key: row.key,
    label: t(row.labelKey),
    icon: orbitIcon(row.key),
    ...(row.href ? { href: row.href } : {}),
    ...(row.children
      ? {
          items: row.children.map(treeItem),
          open: groupOpen[row.key] ?? true,
          onOpenChange: (open: boolean) => setGroupOpen(row.key, open),
        }
      : {}),
  });
  const tree: SidebarTree[] = model.sections.map((section) => ({
    key: section.key,
    label: t(section.labelKey),
    collapsible: true,
    open: groupOpen[`section:${section.key}`] ?? true,
    onOpenChange: (open: boolean) => setGroupOpen(`section:${section.key}`, open),
    items: section.rows.map(treeItem),
  }));
  return {
    items: model.items.map(navItem),
    secondaryItems: model.footer.map(navItem),
    tree,
  };
}

/**
 * Orbit's frame, built as Nilo's is: Bloom's `AppShell` with its `Sidebar` as
 * a docked column — the organization + application switcher at its head, the
 * navigation from the registry (`destinations.ts`) in Stripe's sections, the
 * person at its foot — collapsible to icons, and a drawer below
 * `SIDEBAR_IN_FLOW_FROM`. Over the pages, the top bar (search, Test mode,
 * help); across the window in test mode, the test strip. The search over
 * the application's objects opens from the top bar and `/`; the command
 * palette (pages and actions) from ⌘K / Ctrl+K.
 *
 * Pages own their scrolling (`scroll="fixed"`): each `OrbitScreen` is its
 * own scroller under the pinned top bar.
 */
export function OrbitShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { width } = useWindowDimensions();
  const scope = useOrbitScope();
  const [userCollapsed, setUserCollapsed] = usePersistedCollapsed();
  const layout = shellLayout(width, userCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const [groupOpen, setGroupOpenState] = useState<Record<string, boolean>>({});
  const team = useScopeTeam();
  const account = useAccountIdentity();
  const active = activeDestination(pathname);
  const test = modeForEnvironment(scope.environment) === 'test';

  const go = useCallback(
    (href: string) => {
      // On a phone the sidebar is a drawer: choosing where to go puts it away.
      setDrawerOpen(false);
      router.navigate(href as never);
    },
    [router],
  );
  const setGroupOpen = useCallback((key: string, open: boolean) => {
    setGroupOpenState((all) => ({ ...all, [key]: open }));
  }, []);

  useShellShortcuts(
    useCallback(
      (shortcut) => {
        if (shortcut === 'palette') setPaletteOpen(true);
        else if (shortcut === 'search') setSearchOpen(true);
        else if (layout.presentation === 'panel') setUserCollapsed(!userCollapsed);
      },
      [layout.presentation, userCollapsed, setUserCollapsed],
    ),
  );

  const activeGroup = groupOf(active?.key);
  const sidebar = useMemo<AppShellSidebarProps>(() => {
    // A group holding the page in view is open, whatever was chosen before.
    const open = activeGroup ? { ...groupOpen, [activeGroup]: true } : groupOpen;
    const navFor = (collapsed: boolean) => bloomNav(navModel({ collapsed }), open, setGroupOpen);
    return {
      variant: 'panel',
      surface: 'docked',
      size: 'sm',
      showSearch: false,
      teamPlacement: 'header',
      team,
      account,
      collapsed: layout.collapsed,
      collapseDisabled: layout.collapseDisabled,
      onCollapsedChange: setUserCollapsed,
      selected: active?.key,
      selectedTreeItem: active?.key,
      accessibilityLabel: t('shell.sidebar.label'),
      collapseLabel: t('shell.sidebar.collapse'),
      expandLabel: t('shell.sidebar.expand'),
      closeLabel: t('shell.sidebar.close'),
      onNavigate: (item) => {
        if (item.href) go(item.href);
      },
      onTreeItemPress: (item) => {
        if (item.href) go(item.href);
        else if (item.items) setGroupOpen(item.key, !(open[item.key] ?? true));
      },
      ...navFor(layout.collapsed),
      // The shell knows best how the sidebar is drawn right now (in flow or a
      // drawer, collapsed or not): the rows follow what it actually is.
      render: (props: SidebarProps) => (
        <Sidebar {...props} {...navFor(!props.mobile && props.collapsed === true)} />
      ),
    };
  }, [
    activeGroup,
    groupOpen,
    setGroupOpen,
    team,
    account,
    layout.collapsed,
    layout.collapseDisabled,
    setUserCollapsed,
    active?.key,
    go,
  ]);

  return (
    <>
      <AppShell
        contentMaxWidth="none"
        scroll="fixed"
        safeArea
        navFrom={SIDEBAR_IN_FLOW_FROM}
        drawerSwipe
        drawerOpen={drawerOpen}
        onDrawerOpenChange={setDrawerOpen}
        drawerOpenLabel={t('shell.sidebar.open')}
        drawerCloseLabel={t('shell.sidebar.close')}
        sidebar={sidebar}
        header={<TopBar onSearch={openSearch} />}
        topBar={test ? <TestModeStrip /> : undefined}
        topBarVisibility="always"
      >
        {children}
      </AppShell>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onNavigate={go}
        onSearch={openSearch}
      />
      <SearchDialog open={searchOpen} onClose={closeSearch} />
    </>
  );
}
