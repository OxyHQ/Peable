import { useMemo } from 'react';
import { useRouter } from 'expo-router';
import { useAuth } from '@oxy.so/services/ui/client';
import { RiLogoutBoxRLine } from '@oxy.so/bloom/icons/RiLogoutBoxRLine';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { RiUserLine } from '@oxy.so/bloom/icons/RiUserLine';
import type { SidebarAccount, SidebarMenuGroup, SidebarTeam } from '@oxy.so/bloom/sidebar';
import { t } from '../i18n';
import { organizationLabel } from '../scope/scope';
import { useOrbitScope } from '../scope/ScopeProvider';

function initial(name: string | undefined): string {
  return (name?.trim()[0] ?? '?').toUpperCase();
}

/**
 * The organization + application switcher at the head of the sidebar
 * (`teamPlacement="header"`, Nilo's workspace switcher): the application in
 * view, its organization under it, and every organization and application to
 * switch to. Test / Live is the top bar's, where it is never out of sight.
 */
export function useScopeTeam(): SidebarTeam {
  const scope = useOrbitScope();
  const {
    organizations,
    applications,
    organizationId,
    applicationId,
    setOrganizationId,
    setApplicationId,
    organizationsLoading,
  } = scope;
  return useMemo<SidebarTeam>(() => {
    const organization = organizations.find((node) => node.accountId === organizationId);
    const application = applications.find((app) => app._id === applicationId);
    const name =
      application?.name ?? t(organizationsLoading ? 'shell.scope.loading' : 'shell.scope.choose');
    const groups: SidebarMenuGroup[] = [];
    if (organizations.length) {
      groups.push({
        id: 'organizations',
        label: t('shell.scope.organizations'),
        selection: 'single',
        items: organizations.map((node) => {
          const label = organizationLabel(node);
          return {
            key: node.accountId,
            label,
            avatar: { initials: initial(label), shape: 'squircle' },
            selected: node.accountId === organizationId,
            onPress: () => setOrganizationId(node.accountId),
          };
        }),
      });
    }
    if (applications.length) {
      groups.push({
        id: 'applications',
        label: t('shell.scope.applications'),
        selection: 'single',
        items: applications.map((app) => ({
          key: app._id,
          label: app.name,
          avatar: { initials: initial(app.name), shape: 'squircle', color: 'blue' },
          selected: app._id === applicationId,
          onPress: () => setApplicationId(app._id),
        })),
      });
    }
    return {
      name,
      ...(organization ? { email: organizationLabel(organization) } : {}),
      avatar: { initials: initial(application?.name), shape: 'squircle', color: 'blue' },
      menuLabel: t('shell.scope.menu'),
      groups,
    };
  }, [
    organizations,
    applications,
    organizationId,
    applicationId,
    setOrganizationId,
    setApplicationId,
    organizationsLoading,
  ]);
}

/** The signed-in person, as the card at the sidebar's foot. */
export function useAccountIdentity(): SidebarAccount | undefined {
  const router = useRouter();
  const { user, signOut, showBottomSheet } = useAuth();
  return useMemo<SidebarAccount | undefined>(() => {
    if (!user) return undefined;
    const name = user.name?.displayName?.trim() || user.username;
    return {
      name,
      email: user.email ?? (user.username ? `@${user.username}` : undefined),
      // A bare Oxy file id: the root layout's image resolver turns it into a URL.
      avatar: { source: user.avatar ?? undefined, initials: initial(name) },
      menuLabel: t('shell.account.menu'),
      groups: [
        {
          id: 'account',
          items: [
            {
              key: 'manage',
              label: t('shell.account.manage'),
              icon: RiUserLine,
              onPress: () => showBottomSheet?.('ManageAccount'),
            },
            {
              key: 'settings',
              label: t('nav.settings'),
              icon: RiSettings3Line,
              onPress: () => router.navigate('/settings'),
            },
          ],
        },
        {
          id: 'session',
          items: [
            {
              key: 'sign-out',
              label: t('shell.account.signOut'),
              icon: RiLogoutBoxRLine,
              tone: 'destructive',
              onPress: () => void signOut(),
            },
          ],
        },
      ],
    };
  }, [user, signOut, showBottomSheet, router]);
}
