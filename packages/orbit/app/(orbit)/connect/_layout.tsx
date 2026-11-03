import { Stack } from 'expo-router';
import { useTheme } from '@oxy.so/bloom/theme';

/** Connect is the sellers list and a seller, stacked inside the one Connect tab. */
export default function ConnectLayout() {
  const theme = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.background },
      }}
    />
  );
}
