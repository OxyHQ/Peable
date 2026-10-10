/**
 * Web / Electron fallback for the Places map tab.
 *
 * Metro picks this file over the sibling `map.tsx` on web because
 * `@maplibre/maplibre-react-native` is a native-only module — importing it on
 * web throws at module-eval time. As a top-level tab there is no back
 * affordance; we simply center an EmptyState explaining the map is mobile-only.
 */

import { View } from 'react-native';
import { SafeAreaView } from '../../src/ui/safe-area-view';
import { EmptyState } from '../../src/ui/components';
import { t } from '../../src/i18n';

export default function MapWebScreen() {
  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom', 'left', 'right']}>
      <View className="flex-1 items-center justify-center px-6">
        <EmptyState
          icon="map-marker-off"
          title={t('map.webOnly.title')}
          subtitle={t('map.webOnly.subtitle')}
        />
      </View>
    </SafeAreaView>
  );
}
