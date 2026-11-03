import { View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { t } from '@/i18n';

/** The link's URL, a Copy button and — when asked — a QR code of the same URL. */
export function LinkShare({ url, qr = false }: { url: string; qr?: boolean }) {
  return (
    <View className="gap-3">
      <View className="flex-row flex-wrap items-center gap-2">
        <Text variant="body-2-regular" selectable className="font-mono flex-1 min-w-48">
          {url}
        </Text>
        <Button
          appearance="outline"
          size="sm"
          onPress={() =>
            void Clipboard.setStringAsync(url).then(
              () => toast.success(t('links.copied')),
              () => toast.error(t('error.generic')),
            )
          }
        >
          {t('action.copy')}
        </Button>
      </View>
      {qr ? (
        <View
          className="self-start rounded-xl bg-white p-3"
          accessible
          accessibilityRole="image"
          accessibilityLabel={t('links.qr')}
        >
          {/* Dark on white whatever the theme: a scanner needs the contrast. */}
          <QRCode value={url} size={160} color="#000000" backgroundColor="#ffffff" />
        </View>
      ) : null}
    </View>
  );
}
