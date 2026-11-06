/**
 * The account the person acts as has no wallet to open on this host (oxy
 * ADRs 0001 and 0061) — rendered in place by `app/index.tsx`, like
 * `CreateOxyIdView`.
 *
 * For an organization it says exactly what is missing and who can fix it:
 * the organization has no key yet ("Set up the organization's Peable wallet"),
 * the key is not on this phone ("Add the organization's wallet to this
 * phone"), or the person is not an owner or admin, who alone can hold it.
 * Commons is where the owners create, add or replace the key (Settings →
 * Organizations → Organization wallets); Peable never derives an organization
 * address from the person's own key.
 */

import { useCallback, useState } from 'react';
import { View, Text, Linking } from 'react-native';
import { useOxy } from '@oxy.so/services/ui/client';
import { Button } from './Button';
import { commonsOrganizationWalletUrl } from '../../wallet/organization-wallet';
import type { WalletBlock } from '../../wallet/entry-route';
import { t } from '../../i18n';

type BlockReason =
  | Extract<WalletBlock, { kind: 'organization' }>['status']
  | 'unsupported'
  | 'unverified';

/** Translation keys per reason; `cta` only where Commons is the fix. */
const COPY: Record<BlockReason, { title: string; body: string; cta?: string }> = {
  keyless: {
    title: 'organizationWallet.keyless.title',
    body: 'organizationWallet.keyless.body',
    cta: 'organizationWallet.keyless.cta',
  },
  'not-on-device': {
    title: 'organizationWallet.notOnDevice.title',
    body: 'organizationWallet.notOnDevice.body',
    cta: 'organizationWallet.notOnDevice.cta',
  },
  forbidden: {
    title: 'organizationWallet.forbidden.title',
    body: 'organizationWallet.forbidden.body',
  },
  unavailable: {
    title: 'organizationWallet.unavailable.title',
    body: 'organizationWallet.unavailable.body',
  },
  unsupported: {
    title: 'organizationWallet.unsupported.title',
    body: 'organizationWallet.unsupported.body',
  },
  unverified: {
    title: 'organizationWallet.unverified.title',
    body: 'organizationWallet.unverified.body',
  },
};

export function WalletBlockedView({
  block,
  onRetry,
}: {
  block: WalletBlock;
  /** Ask again — after the owner set the wallet up in Commons, say. */
  onRetry: () => void;
}) {
  const { user, openAccountDialog } = useOxy();
  const [notice, setNotice] = useState<string | null>(null);
  const copy = COPY[block.kind === 'organization' ? block.status : block.kind];
  const name =
    user?.name?.displayName ??
    (user?.username ? `@${user.username}` : t('organizationWallet.thisOrganization'));
  const commonsUrl =
    block.kind === 'organization' ? commonsOrganizationWalletUrl(block.accountId) : null;

  const openCommons = useCallback(async () => {
    if (!commonsUrl) return;
    setNotice(null);
    try {
      if (!(await Linking.canOpenURL(commonsUrl))) {
        setNotice(t('organizationWallet.commonsNotInstalled'));
        return;
      }
      await Linking.openURL(commonsUrl);
    } catch {
      setNotice(t('organizationWallet.commonsNotInstalled'));
    }
  }, [commonsUrl]);

  return (
    <View className="flex-1 bg-background items-center justify-center px-8">
      <Text className="text-foreground text-2xl text-center mb-3">{t(copy.title)}</Text>
      <Text className="text-muted-foreground text-base text-center mb-8">
        {t(copy.body, { name })}
      </Text>
      <View className="w-full gap-3">
        {copy.cta && commonsUrl ? (
          <Button
            title={t(copy.cta)}
            onPress={() => void openCommons()}
            variant="primary"
            size="lg"
          />
        ) : null}
        <Button
          title={t('organizationWallet.checkAgain')}
          onPress={onRetry}
          variant={copy.cta ? 'outline' : 'primary'}
          size="lg"
        />
        <Button
          title={t('organizationWallet.switchAccount')}
          onPress={() => openAccountDialog()}
          variant="ghost"
          size="lg"
        />
      </View>
      {notice ? (
        <Text className="text-muted-foreground text-sm text-center mt-4">{notice}</Text>
      ) : null}
    </View>
  );
}
