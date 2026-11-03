import { View } from 'react-native';
import { useAuth } from '@oxy.so/services/ui/client';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import { t } from '../i18n';

/**
 * "Sign in with Oxy", as a view rather than a route — the shell renders it in
 * place (see `app/(orbit)/_layout.tsx` for why it cannot redirect). Orbit has
 * no account of its own: the person's Oxy identity and their membership of the
 * organization are the whole of their authority.
 */
export function SignInScreen() {
  const { signIn } = useAuth();
  return (
    <View className="flex-1 bg-background items-center justify-center px-6">
      <View className="w-full max-w-md gap-4 items-center">
        <Text variant="display-3-bold" accessibilityRole="header" className="text-center">
          {t('signin.title')}
        </Text>
        <Text variant="body-regular" className="text-muted-foreground text-center">
          {t('signin.subtitle')}
        </Text>
        <Button appearance="solid" tone="accent" size="lg" onPress={() => void signIn()}>
          {t('signin.button')}
        </Button>
      </View>
    </View>
  );
}
