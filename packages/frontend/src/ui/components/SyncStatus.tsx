/**
 * Sync status indicator component.
 */

import { useMemo } from 'react';
import { View, Text } from 'react-native';
import { t } from '../../i18n';

interface SyncStatusProps {
  progress: number;
  isSyncing: boolean;
  connectedPeers: number;
  chainHeight: number;
  networkStatus: string;
}

type SyncState = 'synced' | 'syncing' | 'disconnected';

function getSyncState(isSyncing: boolean, connectedPeers: number): SyncState {
  if (connectedPeers === 0) return 'disconnected';
  if (isSyncing) return 'syncing';
  return 'synced';
}

const DOT_COLORS: Record<SyncState, string> = {
  synced: 'bg-primary',
  syncing: 'bg-yellow-400',
  disconnected: 'bg-red-400',
};

export function SyncStatus({
  progress,
  isSyncing,
  connectedPeers,
  chainHeight,
  networkStatus,
}: SyncStatusProps) {
  const syncState = useMemo(
    () => getSyncState(isSyncing, connectedPeers),
    [isSyncing, connectedPeers],
  );

  const dotColor = DOT_COLORS[syncState];

  const statusLabel = useMemo(() => {
    if (syncState === 'syncing') {
      return t('syncStatus.syncing', { progress: Math.round(progress) });
    }
    if (syncState === 'synced') {
      return t('syncStatus.synced');
    }
    return networkStatus;
  }, [syncState, progress, networkStatus]);

  return (
    <View className="bg-surface rounded-xl px-4 py-3">
      <View className="flex-row items-center justify-between">
        {/* Status dot + text */}
        <View className="flex-row items-center flex-1 mr-2">
          <View className={`w-2.5 h-2.5 rounded-full ${dotColor} mr-2`} />
          <Text className="text-foreground text-sm flex-shrink" numberOfLines={2}>
            {statusLabel}
          </Text>
        </View>

        {/* Peers */}
        <Text className="text-muted-foreground text-xs">
          {connectedPeers === 1
            ? t('peers.peerCountLabel.one', { count: connectedPeers })
            : t('peers.peerCountLabel.other', { count: connectedPeers })}
        </Text>
      </View>

      {/* Progress bar */}
      {isSyncing ? (
        <View className="mt-2 h-1.5 bg-background rounded-full overflow-hidden">
          <View
            className="h-full bg-primary rounded-full"
            style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
          />
        </View>
      ) : null}

      {/* Chain height */}
      {chainHeight > 0 ? (
        <Text className="text-muted-foreground text-xs mt-1">
          {t('syncStatus.blockHeight', { height: chainHeight.toLocaleString() })}
        </Text>
      ) : null}
    </View>
  );
}
