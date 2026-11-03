import { Image, View } from 'react-native';
import { StatusRing, type StatusRingProps } from '@oxy.so/bloom/loading';
import peableLogo from './assets/peable.png';

/** One brand footer for payment and post-payment sheets; shared compositor owns its placement. */
export function PeableBrandStatus({
  state = 'idle',
  label = 'Peable',
}: {
  state?: StatusRingProps['state'];
  label?: string;
}) {
  return (
    <View pointerEvents="none" style={{ alignItems: 'center', padding: 12 }}>
      <StatusRing testID="peable-brand-status" state={state} accessibilityLabel={label}>
        <Image
          source={typeof peableLogo === 'string' ? { uri: peableLogo } : peableLogo}
          style={{ width: 32, height: 32 }}
          resizeMode="contain"
          accessibilityLabel="Peable"
        />
      </StatusRing>
    </View>
  );
}
