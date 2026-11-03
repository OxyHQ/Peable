import { View, Linking } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';
import { Button } from '@oxy.so/bloom/button';
const orbitOrigin = process.env.EXPO_PUBLIC_ORBIT_ORIGIN;
export default function OrbitMoved() {
  return (
    <View style={{ padding: 24, gap: 16 }}>
      <Text variant="title-1-bold">Orbit by Peable</Text>
      <Text>Merchant operations now have their own application, separate from your wallet.</Text>
      {orbitOrigin ? (
        <Button onPress={() => void Linking.openURL(orbitOrigin)}>Open Orbit</Button>
      ) : (
        <Text>The Orbit application URL has not been configured for this build.</Text>
      )}
    </View>
  );
}
