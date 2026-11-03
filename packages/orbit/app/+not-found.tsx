import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { t } from '@/i18n';

export default function NotFound() {
  const router = useRouter();
  return (
    <View className="flex-1 bg-background items-center justify-center p-6">
      <EmptyState
        title={t('notFound.title')}
        description={t('notFound.body')}
        action={{ label: t('notFound.action'), onPress: () => router.replace('/') }}
      />
    </View>
  );
}
