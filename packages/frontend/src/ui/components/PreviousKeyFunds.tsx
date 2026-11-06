/**
 * Coins under a previous identity key, on the home screen (Peable ADR 0002,
 * amended 2026-11-06 "previous keys stay spendable"; mainnet gate F1).
 *
 * Two notices, each only when it has something to say:
 *
 * - **Reachable** (`previousKeyBalance`): Commons kept the previous key, so
 *   the coins are in the balance and spendable. A prominent card says so,
 *   says that whoever else holds that key can spend them too, and offers ONE
 *   tap to move everything to a fresh address of the current key, after a
 *   confirmation that shows the amount and the network fee. Explicit, never
 *   automatic: a move spends a fee and should not surprise anyone; and it is
 *   shown for as long as such coins exist, because after a rotation forced
 *   by a compromise the move races whoever else holds the key.
 * - **Unreachable** (`strandedBalance`): not in the balance, never selected
 *   (F8), with the path to spend it here: add the previous phrase in Commons.
 *
 * Rendered only for an open wallet: the web build is read-only and has no
 * keys, so it never has either figure.
 */

import { useCallback, useState } from 'react';
import { View, Text, Linking } from 'react-native';
import { Dialog, useDialogControl } from '@oxy.so/bloom/dialog';
import { toast } from '@oxy.so/bloom/toast';
import { Button } from './Button';
import { FEE_RATES, PREVIOUS_KEY_MOVE_CHANGED, useWalletStore } from '../../wallet/wallet-store';
import { identitySubjectOfWalletId } from '../../wallet/identity-wallet';
import { commonsOrganizationWalletUrl } from '../../wallet/organization-wallet';
import { previousKeyCopy, type PreviousKeyMoveReady } from '../../wallet/previous-keys';
import { formatFairAmount, t } from '../../i18n';

export function PreviousKeyFunds() {
  const previousKeyBalance = useWalletStore((s) => s.previousKeyBalance);
  const strandedBalance = useWalletStore((s) => s.strandedBalance);
  const activeWalletId = useWalletStore((s) => s.activeWalletId);
  const planMove = useWalletStore((s) => s.planPreviousKeyMove);
  // Subscribed so the card re-plans when this phone's key stops (or starts
  // again) being the account's current one.
  const keyMismatch = useWalletStore((s) => s.socialReceiveKeyMismatch);
  const keyConfirmed = useWalletStore((s) => s.identityReceiveConfirmed);
  const moveFunds = useWalletStore((s) => s.movePreviousKeyFunds);
  const confirmControl = useDialogControl();
  const [moving, setMoving] = useState(false);
  // The plan the dialog SHOWS, captured when it opens: the move spends exactly
  // this one, or asks again (R4-13).
  const [confirmed, setConfirmed] = useState<PreviousKeyMoveReady | null>(null);

  const subject = activeWalletId ? identitySubjectOfWalletId(activeWalletId) : null;
  const subjectKind = subject?.kind ?? 'personal';
  const copy = previousKeyCopy(subjectKind);
  // Read at render: the store's balance figures re-render this as coins move.
  const plan =
    previousKeyBalance > 0n
      ? keyMismatch || !keyConfirmed
        ? ({ kind: 'blocked' } as const)
        : planMove(FEE_RATES.medium)
      : null;

  const handleMove = useCallback(async () => {
    if (!confirmed) return;
    setMoving(true);
    try {
      await moveFunds(confirmed);
      toast.success(t('wallet.previousKey.moved'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The coins or the fee moved since the dialog showed them: show the new
      // plan and ask again, never send a move nobody confirmed.
      if (message === PREVIOUS_KEY_MOVE_CHANGED) toast.error(t('wallet.previousKey.changed'));
      else toast.error(t('wallet.previousKey.failed', { message }));
    } finally {
      setMoving(false);
      setConfirmed(null);
    }
  }, [moveFunds, confirmed]);

  const openCommons = useCallback(async () => {
    if (subject?.kind !== 'organization') return;
    const url = commonsOrganizationWalletUrl(subject.accountId);
    try {
      if (await Linking.canOpenURL(url)) await Linking.openURL(url);
      else toast.error(t('organizationWallet.commonsNotInstalled'));
    } catch {
      toast.error(t('organizationWallet.commonsNotInstalled'));
    }
  }, [subject]);

  if (previousKeyBalance <= 0n && strandedBalance <= 0n) return null;

  return (
    <View className="px-4 pb-4 gap-3">
      {plan ? (
        <View className="bg-surface rounded-2xl p-4 gap-2">
          <Text className="text-foreground text-base font-semibold">
            {t('wallet.previousKey.title', { amount: formatFairAmount(previousKeyBalance) })}
          </Text>
          <Text className="text-muted-foreground text-sm leading-5">{t(copy.body)}</Text>
          {plan.kind === 'ready' ? (
            <Button
              title={t('wallet.previousKey.move')}
              onPress={() => {
                setConfirmed(plan);
                confirmControl.open();
              }}
              variant="primary"
              loading={moving}
              disabled={moving}
              fullWidth
            />
          ) : (
            <Text className="text-muted-foreground text-xs leading-4">
              {t(`wallet.previousKey.${plan.kind}`)}
            </Text>
          )}
        </View>
      ) : null}

      {strandedBalance > 0n ? (
        <View className="gap-2">
          <Text className="text-muted-foreground text-xs leading-4">
            {t(copy.stranded, { amount: formatFairAmount(strandedBalance) })}
          </Text>
          {subject?.kind === 'organization' ? (
            <Button
              title={t('wallet.previousKey.openCommons')}
              onPress={() => void openCommons()}
              variant="outline"
              size="sm"
            />
          ) : null}
        </View>
      ) : null}

      {confirmed ? (
        <Dialog
          control={confirmControl}
          placement="bottom"
          title={t('wallet.previousKey.confirmTitle', {
            amount: formatFairAmount(confirmed.amount),
          })}
          description={t('wallet.previousKey.confirmBody', {
            fee: formatFairAmount(confirmed.fee),
          })}
          actions={[
            { label: t('wallet.previousKey.confirm'), onPress: () => void handleMove() },
            { label: t('common.cancel'), color: 'cancel' },
          ]}
        />
      ) : null}
    </View>
  );
}
