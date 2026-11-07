import { Stack } from 'expo-router';
import { useTheme } from '@oxy.so/bloom/theme';

/** Reviews is the queue and one review, stacked inside the one Reviews tab. */
export default function ReviewsLayout() {
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
